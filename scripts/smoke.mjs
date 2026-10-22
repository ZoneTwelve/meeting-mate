import http from 'node:http';
import { once } from 'node:events';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { loadConfig, root } from '../src/config.mjs';
import { Browser } from '../src/browser.mjs';
import { CdpConnection, cdpJson } from '../src/cdp.mjs';
import { MeetPage } from '../src/meet-page.mjs';
import { Recorder, permission } from '../src/recorder.mjs';

const config = await loadConfig();
config.recordingsDir = path.join(root, '.meeting-mate', 'smoke');
const browser = new Browser(config);
const recorder = new Recorder(config);
const execute = promisify(execFile);
const jobId = process.env.MEETING_MATE_SMOKE_JOB_ID || randomUUID();
if (!/^[a-f\d-]{36}$/i.test(jobId)) throw new Error('Invalid recording smoke test job ID');
const startedAt = new Date().toISOString();
const reportFile = path.join(config.recordingsDir, 'report.json');
const pendingReport = `${reportFile}.${jobId}.tmp`;
const controller = new AbortController();
const { signal } = controller;
const interrupt = (name) => {
  if (signal.aborted) return;
  process.exitCode = name === 'SIGINT' ? 130 : 143;
  controller.abort(new Error(`Recording smoke test interrupted by ${name}`));
  // Recorder.stop() finalizes only this script's native recording and is
  // idempotent with the finally block below.
  recorder.stop().catch((error) => console.error(error.message));
  closeTestPage();
};
const onTerminate = () => interrupt('SIGTERM');
const onInterrupt = () => interrupt('SIGINT');
process.on('SIGTERM', onTerminate);
process.on('SIGINT', onInterrupt);
async function interruptible(promise) {
  signal.throwIfAborted();
  let onAbort;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', onAbort); }
}
let targetId;
let page;
let closingPage;
function closeTestPage() {
  if (!targetId) return Promise.resolve();
  closingPage ??= browser.root.send('Target.closeTarget', { targetId }).catch(() => {});
  return closingPage;
}
const html = `<!doctype html><title>Meeting Mate AV Smoke</title>
<style>body{margin:40px;background:#11213a;color:white;font:24px system-ui}video{width:640px;height:360px}#motion{width:100px;height:50px;background:#fa6072;animation:move 1s linear infinite alternate}@keyframes move{to{transform:translateX(500px);background:#65dbc0}}</style>
<h1>Meeting Mate local A/V test</h1><video id="camera" muted autoplay playsinline></video><div id="motion"></div><p id="time"></p>
<script>
window.startTest=async()=>{
 const stream=await navigator.mediaDevices.getUserMedia({video:true,audio:false});
 document.querySelector('video').srcObject=stream;
 await document.querySelector('video').play();
 const audio=window.testAudio=new AudioContext();
 const oscillator=audio.createOscillator(), gain=audio.createGain();
 oscillator.frequency.value=660; gain.gain.value=0.025;
 oscillator.connect(gain).connect(audio.destination); oscillator.start();
 await audio.resume();
 setInterval(()=>document.querySelector('#time').textContent=new Date().toISOString(),100);
 return {audio:audio.state,camera:stream.getVideoTracks()[0].label,settings:stream.getVideoTracks()[0].getSettings()};
};
</script>`;
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
try {
  await browser.ensure();
  signal.throwIfAborted();
  if (!browser.cameraReady) throw new Error('Run pnpm camera:prepare outside a call first');
  for (const target of await cdpJson(config.cdpPort, '/json/list')) {
    if (target.type !== 'page' || !target.url.startsWith('https://meet.google.com/')) continue;
    const cdp = await new CdpConnection(target.webSocketDebuggerUrl).connect();
    try {
      if (['in_call', 'waiting_approval'].includes((await new MeetPage(cdp).snapshot()).phase)) {
        throw new Error('Leave the live call or cancel the pending join request before running the synthetic A/V test');
      }
    }
    finally { cdp.close(); }
  }
  signal.throwIfAborted();
  if (!await permission(config)) throw new Error('Run pnpm run doctor --request-permission first');
  signal.throwIfAborted();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  await browser.root.send('Browser.grantPermissions', { origin, permissions: ['videoCapture'] });
  ({ targetId } = await browser.root.send('Target.createTarget', { url: `${origin}/av-smoke`, newWindow: true, width: 1100, height: 850 }));
  signal.throwIfAborted();
  const target = (await cdpJson(config.cdpPort, '/json/list')).find((target) => target.id === targetId);
  page = await new CdpConnection(target.webSocketDebuggerUrl).connect();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await page.evaluate('typeof window.startTest === "function"')) break;
    await delay(100, undefined, { signal });
  }
  signal.throwIfAborted();
  const result = await page.send('Runtime.evaluate', { expression: 'window.startTest()', awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  if (result.result?.value?.audio !== 'running') throw new Error('Test audio did not start');
  console.log('Synthetic devices:', JSON.stringify(result.result.value));
  await page.send('Page.bringToFront');
  await delay(500, undefined, { signal });
  await mkdir(config.recordingsDir, { recursive: true, mode: 0o700 });
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(config.recordingsDir, 'camera-preview.png'), Buffer.from(shot.data, 'base64'));
  signal.throwIfAborted();
  await recorder.start({ pid: browser.pid, title: 'Meeting Mate AV Smoke', url: `${origin}/av-smoke`, durationSeconds: 10 });
  console.log('Started native recording:', recorder.file);
  await interruptible(recorder.exited);
  const media = await recorder.stop();
  signal.throwIfAborted();
  const { stderr } = await execute('ffmpeg', ['-hide_banner', '-i', media.file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 30000, signal });
  const maxVolumeDB = Number(stderr.match(/max_volume:\s+(-?[\d.]+) dB/)?.[1]);
  if (!Number.isFinite(maxVolumeDB) || maxVolumeDB < -60) throw new Error('Recorded audio is silent or missing the test tone');
  const { stdout } = await execute('ffmpeg', ['-v', 'error', '-i', media.file, '-an', '-vf', 'fps=2,scale=64:36', '-f', 'framemd5', '-'], { timeout: 30000, signal });
  const distinctFrames = new Set(stdout.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split(',').at(-1).trim())).size;
  if (distinctFrames < 2) throw new Error('Recorded video did not contain moving frames');
  signal.throwIfAborted();
  const report = { ...media, jobId, startedAt, maxVolumeDB, distinctFrames, verifiedAt: new Date().toISOString() };
  await writeFile(pendingReport, JSON.stringify(report, null, 2), { mode: 0o600 });
  signal.throwIfAborted();
  await rename(pendingReport, reportFile);
  console.log(JSON.stringify(report, null, 2));
} finally {
  const stopped = recorder.stop().catch((error) => console.error(error.message));
  // Stop the synthetic tone promptly, even when native finalization or its
  // ffprobe verification is still running. Only close the test's own target.
  await closeTestPage();
  page?.close();
  browser.disconnect();
  server.closeAllConnections();
  await Promise.all([stopped, new Promise((resolve) => server.close(resolve))]);
  await unlink(pendingReport).catch(() => {});
  process.off('SIGTERM', onTerminate);
  process.off('SIGINT', onInterrupt);
}
