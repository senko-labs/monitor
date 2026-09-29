'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  outputDir: 'recordings',
  fps: 30,
  segmentSeconds: 10800,
  idleTimeoutMs: 5000,
  minRecordingMs: 15000,
  stopGraceMs: 30000,
  pollIntervalMs: 500,
  drawMouse: true,
  captureTarget: 'desktop',
  encoder: 'libx264',
  preset: 'veryfast',
  crf: 28,
  fragmentedMp4: true,
  filePrefix: 'screen',
  minFreeDiskMB: 2048,
  retentionDays: 0,
  ffmpegPath: '',
  logLevel: 'info',
  viewerPort: 8443,
  viewerBindAll: false,
  viewerHttps: true,
  viewerCertFile: '',
  viewerKeyFile: '',
  viewerAllowDelete: true,
};

function load() {
  const file = path.join(ROOT, 'config.json');
  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`config.json is not valid JSON: ${err.message}`);
    }
  }

  const cfg = { ...DEFAULTS, ...user };

  cfg.root = ROOT;
  cfg.outputDir = path.resolve(ROOT, cfg.outputDir);
  cfg.logDir = path.join(ROOT, 'logs');

  // The idle threshold must be larger than the poll interval, otherwise the
  // recorder flaps on and off between two consecutive polls.
  if (cfg.idleTimeoutMs <= cfg.pollIntervalMs) {
    cfg.idleTimeoutMs = cfg.pollIntervalMs * 4;
  }

  return cfg;
}

module.exports = { load, ROOT, DEFAULTS };
