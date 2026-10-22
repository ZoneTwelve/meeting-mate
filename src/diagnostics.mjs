import { access, mkdir, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { permission } from './recorder.mjs';

const execute = promisify(execFile);
export function diagnostics(config, browser) {
  let cached;
  let expires = 0;
  return async () => {
    if (cached && Date.now() < expires) return cached;
    expires = Date.now() + 30000;
    cached = (async () => {
      const tests = [
        ['platform', async () => { if (process.platform !== 'darwin') throw new Error('macOS is required'); return (await execute('/usr/bin/sw_vers', ['-productVersion'], { timeout: 5000 })).stdout.trim(); }],
        ['chrome', async () => { await access(config.chromePath); return { connected: !!browser.root, cameraReady: !!browser.cameraReady }; }],
        ['recorder', async () => { await access(config.recorderPath); return 'installed'; }],
        ['screenAudioPermission', async () => { if (!await permission(config)) throw new Error('Screen and system audio recording permission is missing'); return 'granted'; }],
        ...['ffmpeg', 'ffprobe'].map((binary) => [binary, async () => (await execute(binary, ['-version'], { timeout: 5000 })).stdout.split('\n')[0]]),
        ['storage', async () => { await mkdir(config.recordingsDir, { recursive: true, mode: 0o700 }); const disk = await statfs(config.recordingsDir); const freeBytes = disk.bavail * disk.bsize; if (freeBytes < config.minFreeBytes) throw new Error('Insufficient free disk space'); return { freeBytes, minimumFreeBytes: config.minFreeBytes }; }],
      ];
      const checks = await Promise.all(tests.map(async ([name, check]) => {
        try { return { name, ok: true, detail: await check() }; }
        catch (error) { return { name, ok: false, detail: error.message }; }
      }));
      return { ok: checks.every((check) => check.ok), checkedAt: new Date().toISOString(), checks };
    })();
    return cached;
  };
}
