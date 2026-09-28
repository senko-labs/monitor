'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Captures one burst of activity to a single MPEG-TS clip.
 *
 * The clip is capped at the footage still needed to complete the current
 * 3-hour video, so a long uninterrupted stretch ends exactly on the boundary
 * and the next clip belongs to the next video. Emits 'ended' with the clip
 * path once ffmpeg has exited.
 */
class Recorder extends EventEmitter {
  constructor({ cfg, ffmpeg, logger }) {
    super();
    this.cfg = cfg;
    this.ffmpeg = ffmpeg;
    this.logger = logger;
    this.child = null;
    this.stopping = null;
    this.startedAt = null;
    this.file = null;
    this.consecutiveFailures = 0;
  }

  get running() {
    return this.child !== null;
  }

  buildArgs(file, limitSeconds) {
    const cfg = this.cfg;
    return [
      '-hide_banner',
      '-loglevel', 'warning',
      // Never prompt: an interactive overwrite question would hang forever
      // in a windowless background process.
      '-y',
      // --- input: whole virtual desktop (all monitors) ---
      '-f', 'gdigrab',
      '-framerate', String(cfg.fps),
      '-draw_mouse', cfg.drawMouse ? '1' : '0',
      '-i', cfg.captureTarget,
      '-an',
      // --- encode: H.264 in a widely compatible pixel format ---
      // gdigrab can report odd dimensions; libx264 + yuv420p needs even ones.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', cfg.encoder,
      '-preset', cfg.preset,
      '-crf', String(cfg.crf),
      '-pix_fmt', 'yuv420p',
      '-r', String(cfg.fps),            // constant 30 fps output
      '-g', String(cfg.fps * 2),        // keyframe every 2s
      // Stop on the 3-hour boundary rather than overshooting it.
      '-t', limitSeconds.toFixed(3),
      // --- output: a crash-proof intermediate clip ---
      '-f', 'mpegts',
      file,
    ];
  }

  start(file, limitSeconds) {
    if (this.child || this.stopping) return;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const args = this.buildArgs(file, limitSeconds);
    this.logger.debug(`ffmpeg ${args.join(' ')}`);

    this.child = spawn(this.ffmpeg, args, {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    this.startedAt = Date.now();
    this.file = file;

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.trim();
      if (!text) return;
      // Expected noise: gdigrab's startup rate probe, and CFR padding of a
      // static screen. Neither indicates a problem with the recording.
      if (text.includes('not enough frames to estimate rate') ||
          text.includes('frames duplicated')) {
        this.logger.debug(`ffmpeg: ${text}`);
        return;
      }
      this.logger.warn(`ffmpeg: ${text}`);
    });

    this.child.on('error', (err) => {
      this.logger.error(`ffmpeg failed to start: ${err.message}`);
      this.child = null;
    });

    this.child.on('exit', (code, signal) => {
      const seconds = Math.round((Date.now() - this.startedAt) / 1000);
      const file = this.file;
      this.child = null;
      this.file = null;

      if (this.stopping) {
        const drainMs = Date.now() - this.stopping.requestedAt;
        this.logger.info(`clip closed after ${seconds}s (finalised in ${drainMs}ms)`);
        if (drainMs > 5000) {
          this.logger.warn(
            `ffmpeg needed ${drainMs}ms to drain - the encoder is running behind ` +
            'real time; consider a higher crf, a faster preset, or a GPU encoder'
          );
        }
        const done = this.stopping.resolve;
        this.stopping = null;
        this.consecutiveFailures = 0;
        this.emit('ended', { file, reachedLimit: false });
        done();
        return;
      }

      if (code === 0) {
        // -t elapsed: this clip completed a video while the user kept working.
        this.logger.info(`clip closed after ${seconds}s (reached the video length limit)`);
        this.consecutiveFailures = 0;
        this.emit('ended', { file, reachedLimit: true });
        return;
      }

      // Unexpected exit: usually the session locked, the desktop switched, or
      // the display configuration changed. Whatever was captured is still a
      // valid TS clip, so it is kept.
      this.consecutiveFailures += 1;
      this.logger.warn(
        `ffmpeg exited unexpectedly after ${seconds}s (code ${code}, signal ${signal})`
      );
      this.emit('ended', { file, reachedLimit: false });
    });

    this.logger.info(
      `recording started (user active) -> ${path.basename(file)}, ` +
      `up to ${Math.round(limitSeconds)}s`
    );
  }

  /**
   * Sends 'q' so ffmpeg drains its encode queue and closes the clip.
   *
   * Draining is normally instant, but if the machine fell behind real time
   * (a CPU spike right after boot, for instance) ffmpeg can hold several
   * seconds of queued frames, and killing it early throws them away. So the
   * grace period is generous - nothing is being recorded while we wait.
   */
  stop() {
    if (!this.child) return Promise.resolve();
    if (this.stopping) return this.stopping.promise;

    const child = this.child;
    const graceMs = this.cfg.stopGraceMs;
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    this.stopping = { promise, resolve, requestedAt: Date.now() };

    const quit = () => {
      try {
        child.stdin.write('q');
      } catch {
        // Pipe already gone; the kill timer below is the fallback.
      }
    };
    quit();

    // One reminder halfway through, in case the first keypress was missed.
    const nudge = setTimeout(quit, Math.round(graceMs / 2));

    const kill = setTimeout(() => {
      if (!this.stopping) return;
      this.logger.warn(
        `ffmpeg did not finish writing within ${graceMs}ms - forcing termination`
      );
      try { child.kill(); } catch { /* already gone */ }
    }, graceMs);

    return promise.finally(() => {
      clearTimeout(nudge);
      clearTimeout(kill);
    });
  }
}

module.exports = { Recorder };
