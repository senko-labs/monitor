'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 5 * 1024 * 1024;

class Logger {
  constructor(dir, level = 'info') {
    this.dir = dir;
    this.level = LEVELS[level] || LEVELS.info;
    this.file = path.join(dir, 'monitor.log');
    fs.mkdirSync(dir, { recursive: true });
  }

  rotateIfNeeded() {
    try {
      const { size } = fs.statSync(this.file);
      if (size < MAX_BYTES) return;
      fs.renameSync(this.file, path.join(this.dir, 'monitor.log.1'));
    } catch {
      // No log file yet, or it is locked by a viewer - nothing to rotate.
    }
  }

  write(level, msg) {
    if (LEVELS[level] < this.level) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}\n`;
    this.rotateIfNeeded();
    try {
      fs.appendFileSync(this.file, line);
    } catch {
      // Never let logging take the recorder down.
    }
    if (process.stdout.isTTY) process.stdout.write(line);
  }

  debug(m) { this.write('debug', m); }
  info(m) { this.write('info', m); }
  warn(m) { this.write('warn', m); }
  error(m) { this.write('error', m); }
}

module.exports = { Logger };
