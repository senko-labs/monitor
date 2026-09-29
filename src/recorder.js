'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Captures the whole screen while the user is active, rolling the output into a
 * new MP4 every `segmentSeconds` (the split length). Recording keeps going
 * across short idle gaps and only stops once there has been no input for
 * `idleTimeoutMs`; the next burst of input starts a fresh file.
 */
class Recorder {
  constructor({ cfg, ffmpeg, logger }) {
    this.cfg = cfg;
    this.ffmpeg = ffmpeg;
    this.logger = logger;
    this.child = null;
    this.stopping = null;
    this.startedAt = null;
    this.consecutiveFailures = 0;
  }

  get running() {
    return this.child !== null;
  }

  buildArgs() {
    const cfg = this.cfg;
    const pattern = path.join(cfg.outputDir, `${cfg.filePrefix}-%Y%m%d-%H%M%S.mp4`);
    // Fragmented MP4 is crash-safe: a power cut costs only the frames in flight,
    // not the whole file (a plain MP4 needs its trailer written on close).
    const movflags = cfg.fragmentedMp4
      ? 'movflags=+frag_keyframe+empty_moov+default_base_moof'
      : 'movflags=+faststart';

    return [
      '-hide_banner',
      '-loglevel', 'warning',
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
      // --- output: rolling segments of segmentSeconds each ---
      '-f', 'segment',
      '-segment_time', String(cfg.segmentSeconds),
      '-segment_format', 'mp4',
      '-segment_format_options', movflags,
      '-reset_timestamps', '1',
      '-strftime', '1',
      pattern,
    ];
  }

  start() {
    if (this.child || this.stopping) return;

    fs.mkdirSync(this.cfg.outputDir, { recursive: true });
    const args = this.buildArgs();
    this.logger.debug(`ffmpeg ${args.join(' ')}`);

    this.child = spawn(this.ffmpeg, args, {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    this.startedAt = Date.now();

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
      this.child = null;

      if (this.stopping) {
        const drainMs = Date.now() - this.stopping.requestedAt;
        this.logger.info(`recording stopped after ${seconds}s (finalised in ${drainMs}ms)`);
        this.stopping.resolve();
        this.stopping = null;
        this.consecutiveFailures = 0;
        return;
      }

      // Unexpected exit: usually the session locked, the desktop switched, or
      // the display configuration changed. The main loop restarts us.
      this.consecutiveFailures += 1;
      this.logger.warn(
        `ffmpeg exited unexpectedly after ${seconds}s (code ${code}, signal ${signal})`
      );
    });

    this.logger.info('recording started (user active)');
  }

  /**
   * Sends 'q' so ffmpeg drains its encode queue and closes the current MP4,
   * force-killing only if it overruns the grace period.
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
    const nudge = setTimeout(quit, Math.round(graceMs / 2));

    const kill = setTimeout(() => {
      if (!this.stopping) return;
      this.logger.warn(`ffmpeg did not finish writing within ${graceMs}ms - forcing termination`);
      try { child.kill(); } catch { /* already gone */ }
    }, graceMs);

    return promise.finally(() => {
      clearTimeout(nudge);
      clearTimeout(kill);
    });
  }
}

module.exports = { Recorder };
