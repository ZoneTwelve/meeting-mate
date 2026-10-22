import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { permission } from '../src/recorder.mjs';

const config = await loadConfig();
const execute = promisify(execFile);
let failed = false;
async function check(name, test) {
  try { console.log(`OK ${name}: ${await test()}`); }
  catch (error) { failed = true; console.error(`FAIL ${name}: ${error.message}`); }
}
await check('macOS', async () => {
  const version = (await execute('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim();
  if (Number(version.split('.')[0]) < 15) throw new Error('macOS 15+ is required');
  return version;
});
await check('configuration', async () => `${config.username}; ${config.meetingUrls.length} meeting(s)`);
await check('Chrome', async () => { await access(config.chromePath); return config.chromePath; });
await check('ffprobe', async () => (await execute('ffprobe', ['-version'])).stdout.split('\n')[0]);
await check('recorder', async () => { await access(config.recorderPath); return config.recorderApp; });
await check('screen/audio permission', async () => {
  if (!await permission(config, { request: process.argv.includes('--request-permission') })) {
    throw new Error('Allow Meeting Mate Recorder in System Settings → Privacy & Security → Screen & System Audio Recording. After rebuilding, remove/re-add the app if macOS retains its old signature.');
  }
  return 'granted to the standalone recorder app';
});
if (config.cameraIndicator) await check('RECORDING camera card', async () => { await access(config.cameraFile); return 'prepared (Chrome must be launched with the card; run pnpm camera:prepare outside a call)'; });
process.exitCode = failed ? 1 : 0;
