import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreSchedule } from '../src/schedule.mjs';

const url = 'https://meet.google.com/aaa-bbbb-ccc';
const makeMonitor = () => ({ config: { pollIntervalMs: 3600000 }, jobs: [{ url, nextCheckAt: 0 }] });

test('a graceful restart preserves the next check and last recording', () => {
  const monitor = makeMonitor();
  restoreSchedule(monitor, { state: 'stopped', meetings: [{ url, nextCheckAt: 4500000, lastRecording: { file: '/recordings/call.mp4' } }] }, 1000000);
  assert.equal(monitor.jobs[0].nextCheckAt, 4500000);
  assert.equal(monitor.jobs[0].lastRecording.file, '/recordings/call.mp4');
});

test('stale or ungraceful status does not suppress a meeting check', () => {
  const monitor = makeMonitor();
  restoreSchedule(monitor, { state: 'recording', meetings: [{ url, nextCheckAt: 4500000 }] }, 1000000);
  assert.equal(monitor.jobs[0].nextCheckAt, 0);
  restoreSchedule(monitor, { state: 'stopped', meetings: [{ url, nextCheckAt: 900000 }] }, 1000000);
  assert.equal(monitor.jobs[0].nextCheckAt, 0);
});

test('restored deadline is capped by the current polling interval', () => {
  const monitor = makeMonitor();
  restoreSchedule(monitor, { state: 'stopped', meetings: [{ url, nextCheckAt: 99999999 }] }, 1000000);
  assert.equal(monitor.jobs[0].nextCheckAt, 4600000);
});
