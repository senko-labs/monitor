'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { load } = require('./config');
const { Logger } = require('./logger');
const { resolveFfprobe } = require('./ffmpeg-locator');

const execFileAsync = promisify(execFile);

const cfg = load();
const logger = new Logger(cfg.logDir, cfg.logLevel);
const ffprobe = resolveFfprobe(cfg);

const PAGE = path.join(__dirname, 'viewer.html');

// Duration is looked up with ffprobe and cached; the key includes size+mtime so
// a still-growing file is re-probed and a replaced file is never stale.
const durationCache = new Map();

async function probeDuration(file, stat) {
  if (!ffprobe) return null;
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (durationCache.has(key)) return durationCache.get(key);
  let seconds = null;
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ], { windowsHide: true });
    const value = Number(String(stdout).trim());
    if (Number.isFinite(value)) seconds = value;
  } catch {
    // Unreadable or still being written - leave duration null.
  }
  durationCache.set(key, seconds);
  if (durationCache.size > 5000) durationCache.clear(); // keep it bounded
  return seconds;
}

// Recording file names are screen-YYYYMMDD-HHMMSS.mp4; the stamp is the local
// wall-clock time the session started, which is what the timeline is placed by.
function startTimeFromName(name) {
  const m = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.mp4$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/**
 * Loads TLS material for HTTPS. A user-supplied PEM cert/key pair (e.g. a real
 * certificate) wins; otherwise the self-signed PFX from `npm run setup-cert`.
 */
function loadTls() {
  const resolve = (p) => (p ? path.resolve(cfg.root, p) : null);
  const certPem = resolve(cfg.viewerCertFile);
  const keyPem = resolve(cfg.viewerKeyFile);

  if (certPem && keyPem && fs.existsSync(certPem) && fs.existsSync(keyPem)) {
    return { cert: fs.readFileSync(certPem), key: fs.readFileSync(keyPem) };
  }

  const pfx = path.join(cfg.root, 'certs', 'viewer.pfx');
  if (fs.existsSync(pfx)) {
    const passFile = `${pfx}.pass`;
    const passphrase = fs.existsSync(passFile)
      ? fs.readFileSync(passFile, 'utf8').trim()
      : '';
    return { pfx: fs.readFileSync(pfx), passphrase };
  }

  throw new Error(
    'HTTPS is enabled but no certificate was found. Run "npm run setup-cert", ' +
    'or point "viewerCertFile"/"viewerKeyFile" at a PEM cert and key in config.json.'
  );
}

function contentType(file) {
  if (file.endsWith('.mp4')) return 'video/mp4';
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

async function listVideos() {
  let entries;
  try {
    entries = await fsp.readdir(cfg.outputDir);
  } catch {
    return [];
  }
  const videos = [];
  for (const name of entries) {
    if (!name.startsWith(`${cfg.filePrefix}-`) || !name.endsWith('.mp4')) continue;
    const file = path.join(cfg.outputDir, name);
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) continue;
      const duration = await probeDuration(file, stat);
      // Prefer the timestamp in the name; fall back to the file's mtime.
      const start = startTimeFromName(name) ?? Math.round(stat.mtimeMs - (duration || 0) * 1000);
      videos.push({ name, size: stat.size, mtime: stat.mtimeMs, start, duration });
    } catch {
      // File vanished between readdir and stat (e.g. retention sweep) - skip.
    }
  }
  videos.sort((a, b) => b.start - a.start);
  return videos;
}

/**
 * Rejects anything that is not a single recording file name, so a request can
 * never escape the output folder via '..', an absolute path, or a subfolder.
 */
function safeVideoPath(name) {
  const decoded = decodeURIComponent(name);
  if (decoded !== path.basename(decoded)) return null;
  if (!decoded.startsWith(`${cfg.filePrefix}-`) || !decoded.endsWith('.mp4')) return null;
  return path.join(cfg.outputDir, decoded);
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function serveList(res) {
  sendJson(res, 200, {
    videos: await listVideos(),
    host: os.hostname(),
    canDelete: !!cfg.viewerAllowDelete,
  });
}

/** Permanently deletes one recording. */
async function deleteVideo(res, filePath) {
  if (!cfg.viewerAllowDelete) {
    sendJson(res, 403, { error: 'deleting is disabled (viewerAllowDelete is false)' });
    return;
  }
  try {
    await fsp.unlink(filePath);
    logger.info(`viewer: deleted ${path.basename(filePath)}`);
    sendJson(res, 200, { deleted: path.basename(filePath) });
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendJson(res, 404, { error: 'not found' });
    } else {
      logger.warn(`viewer: could not delete ${path.basename(filePath)}: ${err.message}`);
      sendJson(res, 500, { error: err.message });
    }
  }
}

async function servePage(res) {
  try {
    const html = await fsp.readFile(PAGE);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(500).end('viewer.html is missing');
  }
}

/** Streams a video, honouring a Range header so the browser can seek. */
async function serveVideo(req, res, filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }

  const type = contentType(filePath);
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
    return;
  }

  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);

  // Handle open-ended ranges from either side (bytes=500-, bytes=-500).
  if (start === null) {
    start = Math.max(0, stat.size - (end ?? 0));
    end = stat.size - 1;
  } else if (end === null) {
    end = stat.size - 1;
  }

  if (start > end || start >= stat.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
    return;
  }
  end = Math.min(end, stat.size - 1);

  res.writeHead(206, {
    'Content-Type': type,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
    res.writeHead(405).end('method not allowed');
    return;
  }

  const done = (p) => p.catch((err) => {
    logger.error(`viewer request failed: ${err.message}`);
    if (!res.headersSent) res.writeHead(500).end('server error');
  });

  if (url.pathname === '/' || url.pathname === '/index.html') return done(servePage(res));
  if (url.pathname === '/api/videos') return done(serveList(res));

  if (url.pathname.startsWith('/videos/')) {
    const filePath = safeVideoPath(url.pathname.slice('/videos/'.length));
    if (!filePath) {
      res.writeHead(400).end('bad request');
      return;
    }
    if (req.method === 'DELETE') return done(deleteVideo(res, filePath));
    return done(serveVideo(req, res, filePath));
  }

  res.writeHead(404).end('not found');
}

const scheme = cfg.viewerHttps ? 'https' : 'http';
let server;
try {
  server = cfg.viewerHttps
    ? https.createServer(loadTls(), handler)
    : http.createServer(handler);
} catch (err) {
  logger.error(err.message);
  process.exit(1);
}

const port = cfg.viewerPort;
const host = cfg.viewerBindAll ? '0.0.0.0' : '127.0.0.1';

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`viewer port ${port} is already in use - set "viewerPort" in config.json`);
  } else {
    logger.error(`viewer server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  logger.info(`viewer serving ${cfg.outputDir} on ${scheme}://${host}:${port}`);
  if (cfg.viewerBindAll) {
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs) {
        if (a.family === 'IPv4' && !a.internal) {
          logger.info(`  reachable from other PCs at ${scheme}://${a.address}:${port}  (${name})`);
        }
      }
    }
  } else {
    logger.info('  bound to localhost only; set "viewerBindAll": true to reach it from other PCs');
  }
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
