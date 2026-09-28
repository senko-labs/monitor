'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/**
 * Builds one 3-hour video out of many activity bursts.
 *
 * Each burst is captured to its own MPEG-TS clip in a working folder. TS is
 * used because it needs no finalisation: it can be cut at any byte boundary,
 * so a crash or power cut costs at most the frames still in flight.
 *
 * Once the clips add up to `segmentSeconds` of recorded footage they are
 * concatenated with `-c copy` (no re-encode, so it is an I/O-bound copy rather
 * than a second encode) into one MP4, and a fresh accumulation begins.
 */
class Accumulator {
  constructor({ cfg, ffmpeg, ffprobe, logger }) {
    this.cfg = cfg;
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe;
    this.logger = logger;

    this.workDir = path.join(cfg.outputDir, '.parts');
    this.currentDir = path.join(this.workDir, 'current');
    this.statePath = path.join(this.currentDir, 'state.json');
    this.state = null;
    this.finalising = new Set();
  }

  /** Picks up an accumulation left behind by a previous run, or starts one. */
  init() {
    fs.mkdirSync(this.currentDir, { recursive: true });
    try {
      this.state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.logger.info(
        `resuming video started ${this.state.startedAt} (` +
        `${formatDuration(this.state.durationSec)} of ` +
        `${formatDuration(this.cfg.segmentSeconds)} already recorded)`
      );
    } catch {
      this.reset();
    }
    // Finish any accumulation that was interrupted mid-assembly.
    for (const dir of this.pendingDirs()) this.finalise(dir);
  }

  reset() {
    this.state = {
      startedAt: new Date().toISOString(),
      startedAtStamp: stamp(new Date()),
      durationSec: 0,
      width: null,
      height: null,
      partCount: 0,
    };
    this.save();
  }

  save() {
    fs.mkdirSync(this.currentDir, { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  pendingDirs() {
    try {
      return fs.readdirSync(this.workDir)
        .filter((name) => name.startsWith('pending-'))
        .map((name) => path.join(this.workDir, name));
    } catch {
      return [];
    }
  }

  get recordedSeconds() {
    return this.state.durationSec;
  }

  /** Seconds of footage still needed to complete the current video. */
  remainingSeconds() {
    return Math.max(1, this.cfg.segmentSeconds - this.state.durationSec);
  }

  nextPartPath() {
    const index = String(this.state.partCount + 1).padStart(5, '0');
    return path.join(this.currentDir, `part-${index}.ts`);
  }

  /**
   * Books a finished burst into the current video. Resolves true when that
   * completed the video, so a new one is now in progress.
   */
  async addPart(file) {
    let info;
    try {
      info = await this.probe(file);
    } catch (err) {
      this.logger.warn(`discarding unreadable clip ${path.basename(file)}: ${err.message}`);
      await fsp.unlink(file).catch(() => {});
      return false;
    }

    if (info.duration < 0.5) {
      this.logger.debug(`discarding ${path.basename(file)} (${info.duration}s, too short)`);
      await fsp.unlink(file).catch(() => {});
      return false;
    }

    // Clips are stream-copied into one file, so they must share a geometry.
    // A resolution change (a monitor unplugged, display scaling changed)
    // closes the current video early instead of corrupting it.
    if (this.state.width && (info.width !== this.state.width || info.height !== this.state.height)) {
      this.logger.info(
        `screen geometry changed (${this.state.width}x${this.state.height} -> ` +
        `${info.width}x${info.height}) - closing the current video early`
      );
      const orphan = await this.rotate();
      await fsp.rename(file, path.join(this.currentDir, 'part-00001.ts'));
      this.state.width = info.width;
      this.state.height = info.height;
      this.state.durationSec = info.duration;
      this.state.partCount = 1;
      this.save();
      this.finalise(orphan);
      return true;
    }

    this.state.width = info.width;
    this.state.height = info.height;
    this.state.durationSec += info.duration;
    this.state.partCount += 1;
    this.save();

    this.logger.info(
      `video progress: ${formatDuration(this.state.durationSec)} / ` +
      `${formatDuration(this.cfg.segmentSeconds)} (${this.state.partCount} clips)`
    );

    if (this.state.durationSec >= this.cfg.segmentSeconds - 0.5) {
      const full = await this.rotate();
      this.finalise(full);
      return true;
    }
    return false;
  }

  /** Moves the completed accumulation aside so recording can continue at once. */
  async rotate() {
    const dir = path.join(this.workDir, `pending-${this.state.startedAtStamp}`);
    await fsp.rename(this.currentDir, dir);
    await fsp.writeFile(path.join(dir, 'state.json'), JSON.stringify(this.state, null, 2));
    this.reset();
    return dir;
  }

  /** Forces the current video out now, however short it is. */
  async finaliseNow(reason) {
    if (this.state.partCount === 0) {
      this.logger.info(`nothing to finalise (${reason})`);
      return false;
    }
    this.logger.info(
      `finalising ${formatDuration(this.state.durationSec)} of footage early (${reason})`
    );
    const dir = await this.rotate();
    this.finalise(dir);
    return true;
  }

  async probe(file) {
    const { stdout } = await execFileAsync(this.ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-show_entries', 'format=duration',
      '-of', 'json',
      file,
    ], { windowsHide: true });

    const data = JSON.parse(stdout);
    const stream = (data.streams || [])[0];
    const duration = Number((data.format || {}).duration);
    if (!stream || !Number.isFinite(duration)) throw new Error('no usable video stream');
    return { width: stream.width, height: stream.height, duration };
  }

  /** Assembles a pending folder into its MP4, in the background. */
  finalise(dir) {
    if (this.finalising.has(dir)) return;
    this.finalising.add(dir);
    this.concat(dir)
      .catch((err) => this.logger.error(`assembling ${path.basename(dir)} failed: ${err.message}`))
      .finally(() => this.finalising.delete(dir));
  }

  async concat(dir) {
    const state = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'));
    const parts = (await fsp.readdir(dir)).filter((n) => n.endsWith('.ts')).sort();
    if (parts.length === 0) {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    }

    // Paths in a concat list resolve relative to the list file, so bare
    // basenames sidestep every quoting problem Windows paths bring.
    const listPath = path.join(dir, 'parts.txt');
    const lines = parts.map((n) => "file '" + n + "'").join('\n');
    await fsp.writeFile(listPath, lines + '\n');

    const outName = `${this.cfg.filePrefix}-${state.startedAtStamp}.mp4`;
    const building = path.join(this.cfg.outputDir, `.${outName}.building`);
    const final = path.join(this.cfg.outputDir, outName);

    this.logger.info(
      `assembling ${outName} from ${parts.length} clips (${formatDuration(state.durationSec)})`
    );
    const startedAt = Date.now();

    await this.run([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0',
      '-fflags', '+genpts',
      '-i', listPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      // The temp name has no .mp4 extension, so the muxer must be named.
      '-f', 'mp4',
      building,
    ]);

    const info = await this.probe(building);
    const drift = Math.abs(info.duration - state.durationSec);
    if (drift > Math.max(5, state.durationSec * 0.02)) {
      throw new Error(
        `assembled duration ${info.duration.toFixed(1)}s does not match the expected ` +
        `${state.durationSec.toFixed(1)}s - leaving the clips in ${dir}`
      );
    }

    await fsp.rename(building, final);
    await fsp.rm(dir, { recursive: true, force: true });
    const sizeMB = Math.round((await fsp.stat(final)).size / (1024 * 1024));
    this.logger.info(
      `wrote ${outName} - ${formatDuration(info.duration)}, ${sizeMB}MB, ` +
      `assembled in ${Math.round((Date.now() - startedAt) / 1000)}s`
    );
  }

  run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 500)}`));
      });
    });
  }
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
         `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function formatDuration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

module.exports = { Accumulator, formatDuration };
