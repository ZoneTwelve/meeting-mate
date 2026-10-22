import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rmdir, statfs, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);

// LaunchServices makes the app the permission owner even through SSH/tmux/launchd.
export async function permission(config, { request = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'meeting-mate-permission-'));
  const events = path.join(directory, 'result.jsonl');
  try {
    // A preflight helper can exit before `open -W` registers its kevent watch.
    // Wait for the result file instead of treating that launch race as denial.
    await execute('/usr/bin/open', ['-n', config.recorderApp, '--args',
      request ? '--request-permission' : '--permission-check', '--events', events], { timeout: 5000 });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const data = await readFile(events, 'utf8');
        if (data.endsWith('\n')) return JSON.parse(data.trim()).permission === true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(50);
    }
    throw new Error('No permission result from the recorder app');
  } finally {
    await unlink(events).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}

export async function verifyRecording(file) {
  const { stdout } = await execute('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 60000, maxBuffer: 2 ** 20 });
  const probe = JSON.parse(stdout);
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
  if (!video || !audio || !(Number(probe.format.duration) > 0) || !(Number(video.nb_read_frames) > 0) || !(Number(audio.nb_read_frames) > 0)) {
    throw new Error('Recording did not contain decodable video and audio');
  }
  return { file, duration: Number(probe.format.duration), bytes: Number(probe.format.size), video: video.codec_name,
    audio: audio.codec_name, frames: Number(video.nb_read_frames), audioFrames: Number(audio.nb_read_frames) };
}

export class Recorder {
  constructor(config, { spawnProcess = spawn, validate = verifyRecording, startupTimeoutMs = 15000, stopTimeoutMs = 12000 } = {}) {
    Object.assign(this, { config, spawnProcess, validate, startupTimeoutMs, stopTimeoutMs });
  }
  async start({ pid, title, url, durationSeconds, sessionId, segmentIndex }) {
    if (this.child) throw new Error('A recording is already active');
    await mkdir(this.config.recordingsDir, { recursive: true, mode: 0o700 });
    const disk = await statfs(this.config.recordingsDir);
    if (disk.bavail * disk.bsize < this.config.minFreeBytes) throw new Error('Insufficient disk space for recording');
    const code = new URL(url).pathname.split('/').at(-1);
    this.file = path.join(this.config.recordingsDir, `${code}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.mp4`);
    this.eventsFile = `${this.file}.events.jsonl`;
    this.stopFile = `${this.file}.stop`;
    this.started = false;
    this.finished = false;
    this.failure = null;
    this.stopPromise = null;
    this.nativePid = null;
    this.consumed = 0;
    this.polling = Promise.resolve();
    this.lastProgressAt = Date.now();
    this.metadata = { meetingUrl: url, username: this.config.username, sessionId, segmentIndex, startedAt: new Date().toISOString(), status: 'starting' };
    await this.save();
    const startup = new Promise((resolve, reject) => { this.onStart = resolve; this.onFailure = reject; });
    startup.catch(() => {});
    const startupTimer = setTimeout(() => this.fail(new Error('Recorder produced no start event before the deadline')), this.startupTimeoutMs);
    try {
      const child = this.child = this.spawnProcess('/usr/bin/open', ['-W', '-n', this.config.recorderApp, '--args',
        '--pid', String(pid), '--title', title, '--output', this.file,
        '--seconds', String(durationSeconds ?? this.config.segmentMs / 1000),
        '--events', this.eventsFile, '--stop-file', this.stopFile, '--parent-pid', String(process.pid)],
      { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (buffer) => { stderr = (stderr + buffer).slice(-4000); });
      this.exited = new Promise((resolve) => {
        this.resolveExit = resolve;
        child.once('error', (error) => { this.fail(error); resolve({ code: null, error }); });
        child.once('close', (code, signal) => {
          clearInterval(this.pollTimer);
          this.pollEvents().catch((error) => this.fail(error)).finally(() => {
            if (!this.started) this.fail(new Error(`Recorder exited before starting (${code}): ${stderr}`));
            resolve({ code, signal });
          });
        });
      });
      this.pollTimer = setInterval(() => { this.pollEvents().catch((error) => this.fail(error)); }, 150);
      await startup;
      await chmod(this.file, 0o600).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      this.metadata.status = 'recording';
      await this.save();
      return this.file;
    } catch (error) {
      this.fail(error);
      if (this.child) await this.stop().catch(() => {});
      else { this.metadata.status = 'failed'; this.metadata.error = error.message; await this.save(); }
      throw error;
    } finally { clearTimeout(startupTimer); }
  }
  fail(error) { this.failure ??= error; this.onFailure?.(this.failure); }
  pollEvents() {
    this.polling = this.polling.then(async () => {
      let data;
      try { data = await readFile(this.eventsFile, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const end = data.lastIndexOf('\n') + 1;
      for (const line of data.slice(this.consumed, end).split('\n').filter(Boolean)) {
        const message = JSON.parse(line);
        if (message.event === 'process' && Number.isInteger(message.pid) && message.pid > 1) this.nativePid = message.pid;
        if (message.event === 'started') { this.started = true; this.lastProgressAt = Date.now(); this.onStart?.(); }
        if (message.event === 'progress') { this.lastProgressAt = Date.now(); this.bytes = message.bytes; }
        if (message.event === 'finished') this.finished = true;
        if (message.event === 'error') this.fail(new Error(message.message));
      }
      this.consumed = end;
    });
    return this.polling;
  }
  async save() { await writeFile(`${this.file}.json`, JSON.stringify(this.metadata, null, 2), { mode: 0o600 }); }
  stop() {
    if (!this.child) return Promise.resolve(null);
    this.stopPromise ??= this.finalize();
    return this.stopPromise;
  }
  async finalize() {
    const child = this.child;
    try { await writeFile(this.stopFile, '', { mode: 0o600 }); }
    catch (error) {
      this.fail(error);
      if (this.nativePid) { try { process.kill(this.nativePid, 'SIGTERM'); } catch {} }
    }
    const force = setTimeout(() => {
      this.fail(new Error('Timed out stopping recorder'));
      if (this.nativePid && !this.finished) { try { process.kill(this.nativePid, 'SIGKILL'); } catch {} }
      child.kill('SIGKILL');
      this.resolveExit({ code: null, signal: 'SIGKILL' });
    }, this.stopTimeoutMs);
    const result = await this.exited;
    clearTimeout(force);
    clearInterval(this.pollTimer);
    this.child = null;
    this.started = false;
    this.metadata.endedAt = new Date().toISOString();
    try {
      if (result.code !== 0 || this.failure || !this.finished) {
        throw this.failure ?? new Error(`Recorder did not finalize the file (exit ${result.code ?? result.signal})`);
      }
      this.metadata.media = await this.validate(this.file);
      this.metadata.status = 'verified'; await this.save(); return this.metadata.media;
    } catch (error) { this.metadata.status = 'failed'; this.metadata.error = error.message; await this.save(); throw error; }
    finally { if (this.finished) await unlink(this.stopFile).catch(() => {}); }
  }
  health() {
    if (this.failure) throw this.failure;
    if (this.child && this.child.exitCode !== null && !this.finished) throw new Error('Recorder exited without finalizing');
    if (this.started && !this.finished && Date.now() - this.lastProgressAt > 15000) throw new Error('Recorder stalled');
  }
}
