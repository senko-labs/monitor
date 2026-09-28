'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { load } = require('./config');
const { Logger } = require('./logger');
const { IdleMonitor } = require('./idle-monitor');
const { Recorder } = require('./recorder');
const { Accumulator, formatDuration } = require('./accumulator');
const { resolveFfmpeg, resolveFfprobe } = require('./ffmpeg-locator');
const singleInstance = require('./single-instance');

const DISK_CHECK_MS = 60 * 1000;
const RETENTION_CHECK_MS = 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 10 * 1000;

const cfg = load();
const logger = new Logger(cfg.logDir, cfg.logLevel);

const lock = singleInstance.acquire(cfg.root);
if (!lock.ok) {
  logger.warn(`another recorder is already running (pid ${lock.pid}); exiting`);
  process.exit(0);
}

const ffmpeg = resolveFfmpeg(cfg);
const ffprobe = resolveFfprobe(cfg);
if (!ffmpeg || !ffprobe) {
  logger.error(
    'ffmpeg/ffprobe were not found. Run "npm run setup-ffmpeg", or set ' +
    '"ffmpegPath" in config.json.'
  );
  lock.release();
  process.exit(1);
}

fs.mkdirSync(cfg.outputDir, { recursive: true });

logger.info('--------------------------------------------------');
logger.info(`screen-activity-recorder starting (pid ${process.pid})`);
logger.info(`ffmpeg:  ${ffmpeg}`);
logger.info(`output:  ${cfg.outputDir}`);
logger.info(
  `policy:  ${cfg.fps}fps H.264, ${formatDuration(cfg.segmentSeconds)} of recorded ` +
  `footage per file, stop after ${cfg.idleTimeoutMs}ms without input`
);

const accumulator = new Accumulator({ cfg, ffmpeg, ffprobe, logger });
accumulator.init();

const recorder = new Recorder({ cfg, ffmpeg, logger });
const idleMonitor = new IdleMonitor({
  pollIntervalMs: cfg.pollIntervalMs,
  root: cfg.root,
  logger,
});

const finaliseRequest = path.join(cfg.logDir, 'finalise.request');

let diskFull = false;
let blockedUntil = 0;
let shuttingDown = false;
let busy = false;          // a clip is being booked in; do not start another
let holdCapture = false;   // the working folder is being rotated; stay stopped
let lastActiveAt = 0;

const userIsActive = () => Date.now() - lastActiveAt < cfg.idleTimeoutMs;


function maybeStart() {
  if (shuttingDown || busy || holdCapture || diskFull || recorder.running) return;
  if (!userIsActive()) return;

  // After a crash loop, wait a little instead of respawning ffmpeg in a tight
  // loop (typical while the workstation is locked and gdigrab cannot attach).
  if (recorder.consecutiveFailures > 0) {
    const now = Date.now();
    if (blockedUntil === 0) {
      blockedUntil = now + FAILURE_BACKOFF_MS;
      return;
    }
    if (now < blockedUntil) return;
    blockedUntil = 0;
  }

  recorder.start(accumulator.nextPartPath(), accumulator.remainingSeconds());
}

recorder.on('ended', ({ file, reachedLimit }) => {
  busy = true;
  accumulator.addPart(file)
    .catch((err) => logger.error(`could not book the clip: ${err.message}`))
    .finally(() => {
      busy = false;
      // Keep going without waiting for the next poll, so the gap at a video
      // boundary is milliseconds rather than half a second.
      if (reachedLimit || userIsActive()) maybeStart();
    });
});

idleMonitor.on('idle', (idleMs) => {
  if (shuttingDown) return;

  // Work from the instant of the last input rather than the sample itself.
  // Samples can arrive in a batch after the event loop was busy booking a
  // clip, and a stale one must never look like fresh activity.
  const inputAt = Date.now() - idleMs;
  if (inputAt > lastActiveAt) lastActiveAt = inputAt;
  const idleFor = Date.now() - lastActiveAt;

  if (idleFor < cfg.idleTimeoutMs) {
    maybeStart();
    return;
  }

  if (!recorder.running || recorder.stopping) return;
  // Keep short bursts of typing from producing a spray of tiny clips.
  if (Date.now() - recorder.startedAt < cfg.minRecordingMs) return;
  logger.info(`no input for ${Math.round(idleFor / 1000)}s - pausing`);
  recorder.stop();
});

idleMonitor.start();

async function checkDisk() {
  if (!cfg.minFreeDiskMB) return;
  try {
    const stats = await fsp.statfs(cfg.outputDir);
    const freeMB = (stats.bavail * stats.bsize) / (1024 * 1024);
    const low = freeMB < cfg.minFreeDiskMB;

    if (low && !diskFull) {
      diskFull = true;
      logger.error(
        `only ${Math.round(freeMB)}MB free on the output drive - recording suspended`
      );
      await recorder.stop();
    } else if (!low && diskFull) {
      diskFull = false;
      logger.info(`disk space recovered (${Math.round(freeMB)}MB free) - recording resumed`);
      maybeStart();
    }
  } catch (err) {
    logger.warn(`disk check failed: ${err.message}`);
  }
}

async function applyRetention() {
  if (!cfg.retentionDays || cfg.retentionDays <= 0) return;
  const cutoff = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000;
  try {
    const entries = await fsp.readdir(cfg.outputDir);
    for (const entry of entries) {
      if (!entry.startsWith(`${cfg.filePrefix}-`) || !entry.endsWith('.mp4')) continue;
      const file = path.join(cfg.outputDir, entry);
      const stat = await fsp.stat(file);
      if (stat.mtimeMs < cutoff) {
        await fsp.unlink(file);
        logger.info(`retention: deleted ${entry}`);
      }
    }
  } catch (err) {
    logger.warn(`retention sweep failed: ${err.message}`);
  }
}

/** `npm run finalise` drops a file here to close the current video early. */
async function checkFinaliseRequest() {
  if (!fs.existsSync(finaliseRequest)) return;
  await fsp.unlink(finaliseRequest).catch(() => {});

  // Capture has to stay down until the folder has been rotated away -
  // otherwise a new clip is opened inside the folder being moved.
  holdCapture = true;
  try {
    if (recorder.running) await recorder.stop();
    while (busy) await new Promise((r) => setTimeout(r, 100));
    await accumulator.finaliseNow('requested manually');
  } finally {
    holdCapture = false;
  }
  maybeStart();
}

const diskTimer = setInterval(checkDisk, DISK_CHECK_MS);
const retentionTimer = setInterval(applyRetention, RETENTION_CHECK_MS);
const finaliseTimer = setInterval(() => {
  checkFinaliseRequest().catch((err) => logger.error(`finalise request failed: ${err.message}`));
}, 1000);
checkDisk();
applyRetention();

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`shutting down (${reason})`);

  clearInterval(diskTimer);
  clearInterval(retentionTimer);
  clearInterval(finaliseTimer);
  idleMonitor.stop();
  await recorder.stop();   // lets ffmpeg close the clip it is writing
  while (busy) await new Promise((r) => setTimeout(r, 100));
  lock.release();
  logger.info(
    `stopped - current video holds ${formatDuration(accumulator.recordedSeconds)} ` +
    `of footage and will continue on the next start`
  );
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => shutdown(signal));
}

process.on('uncaughtException', (err) => {
  logger.error(`uncaught exception: ${err.stack || err.message}`);
  shutdown('uncaughtException');
});
