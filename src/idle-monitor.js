'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');

/**
 * Emits 'idle' with the number of milliseconds since the last keyboard or
 * mouse event, once per poll interval. Backed by a long-lived PowerShell
 * helper that calls GetLastInputInfo, so no native module is required.
 */
class IdleMonitor extends EventEmitter {
  constructor({ pollIntervalMs, root, logger }) {
    super();
    this.pollIntervalMs = pollIntervalMs;
    this.script = path.join(root, 'scripts', 'idle-monitor.ps1');
    this.logger = logger;
    this.child = null;
    this.stopped = false;
    this.buffer = '';
    this.restartTimer = null;
  }

  start() {
    this.stopped = false;
    this.spawnChild();
  }

  spawnChild() {
    if (this.stopped) return;

    this.child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', this.script,
        '-IntervalMs', String(this.pollIntervalMs),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.trim();
      if (text) this.logger.warn(`idle-monitor stderr: ${text}`);
    });

    this.child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      this.logger.warn(`idle-monitor exited (code ${code}), restarting in 2s`);
      this.restartTimer = setTimeout(() => this.spawnChild(), 2000);
    });

    this.child.on('error', (err) => {
      this.logger.error(`idle-monitor failed to start: ${err.message}`);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    for (const line of lines) {
      const value = Number(line.trim());
      if (Number.isFinite(value)) this.emit('idle', value);
    }
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}

module.exports = { IdleMonitor };
