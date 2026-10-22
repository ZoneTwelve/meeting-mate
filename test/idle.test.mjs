import test from 'node:test';
import assert from 'node:assert/strict';
import { hasActiveMeeting } from '../src/idle.mjs';

test('a live call, admission request, or recording is not idle', () => {
  for (const meeting of [{ joinedAt: 123 }, { joinRequestedAt: 123 }, { recordingFile: '/recordings/call.mp4' }, { state: 'joining' }]) {
    assert.equal(hasActiveMeeting({ meetings: [meeting] }), true);
  }
});
test('scheduled, finished and capacity-waiting meetings are idle', () => {
  assert.equal(hasActiveMeeting({ meetings: [{ state: 'scheduled' }, { state: 'capacity_wait' }] }), false);
  assert.equal(hasActiveMeeting({ meetings: [{ state: 'empty' }] }), false);
});
test('queued commands, recording tests and finalizing calls prevent idle upgrades', () => {
  for (const status of [{ pendingJoinUrl: 'https://meet.google.com/abc-defg-hij' }, { recordingTestRunning: true }, { state: 'testing' }, { meetings: [{ state: 'paused' }] }, { meetings: [{ state: 'finalizing' }] }, { meetings: [{ stepping: true }] }]) {
    assert.equal(hasActiveMeeting(status), true);
  }
});
