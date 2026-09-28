'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function works(binary) {
  const res = spawnSync(binary, ['-version'], { windowsHide: true, encoding: 'utf8' });
  return !res.error && res.status === 0;
}

function candidates(cfg, exe) {
  return [
    cfg.ffmpegPath && path.resolve(cfg.root, path.dirname(cfg.ffmpegPath), exe),
    path.join(cfg.root, 'tools', 'ffmpeg', 'bin', exe),
    path.join(cfg.root, 'tools', 'ffmpeg', exe),
  ].filter(Boolean);
}

function resolve(cfg, exe) {
  for (const candidate of candidates(cfg, exe)) {
    if (fs.existsSync(candidate) && works(candidate)) return candidate;
  }
  const bare = exe.replace(/\.exe$/i, '');
  if (works(bare)) return bare;
  return null;
}

/** Finds ffmpeg from config, then the bundled tools folder, then PATH. */
const resolveFfmpeg = (cfg) => resolve(cfg, 'ffmpeg.exe');

/** ffprobe always ships beside ffmpeg, so the same search order applies. */
const resolveFfprobe = (cfg) => resolve(cfg, 'ffprobe.exe');

module.exports = { resolveFfmpeg, resolveFfprobe };
