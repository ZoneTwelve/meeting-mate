import test from 'node:test';
import assert from 'node:assert/strict';
import { validationManifest, sessionIsActive, evaluateMeetingValidation } from '../src/meeting-validation.mjs';

function fixture() {
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const id = 'synthetic-first.mp4';
  const manifest = { version: 1, meetingUrl: 'https://meet.google.com/abc-defg-hij', sessionId,
    startedAt: '2026-01-01T00:00:00Z', expectations: [{ id: 'blue', recordingId: id, alternatives: ['藍色火車', '蓝色火车'] }] };
  const source = { id, duration: 10, offsetSeconds: 0, bytes: 100, modifiedAt: 1 };
  const inspection = { ...source, status: 'verified', available: true, sessionId, startedAt: manifest.startedAt,
    containerVerified: true, frames: 150, audioFrames: 470, audioSignal: { status: 'signal', peakDB: -20 } };
  const job = { id: '00000000-0000-4000-8000-000000000002', sessionId, state: 'completed', createdAt: '2026-01-01T00:00:20Z', recordings: [source] };
  job.result = { jobId: job.id, duration: 10, speakers: [],
    segments: [{ recordingId: id, start: 1, end: 4, speakerId: null, text: '藍色火車準時到站。' }],
    engine: { asr: 'faster-whisper', model: 'small', offline: true } };
  const health = { meetings: [{ url: manifest.meetingUrl, sessionId, state: 'empty', joinedAt: null, recordingFile: null }] };
  return { manifest, job, health, inspections: [inspection] };
}
const evaluate = data => evaluateMeetingValidation(data.manifest, data);

test('real-evidence contract needs a finished meeting, decoded media, Whisper words and expected content', () => {
  const f = fixture();
  assert.equal(evaluate(f).passed, true);
  f.job.result.segments[0].text = '蓝 色 火车，準時到站。';
  assert.equal(evaluate(f).passed, true);
});
test('hallucinated expected words cannot make a digitally silent recording pass', () => {
  const f = fixture();
  f.inspections[0].audioSignal = { status: 'silent', peakDB: null };
  const result = evaluate(f);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('silent_or_quiet_recording'));
});
test('a loud join notification and completed empty job are not proof of recorded speech', () => {
  const f = fixture();
  f.job.result.segments = [];
  f.manifest.setupRecordingIds = [f.job.recordings[0].id];
  const result = evaluate(f);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('empty_whisper_result'));
});
test('paused calls and pending joins are still active even without a recorder', () => {
  const f = fixture();
  f.health.meetings[0].state = 'paused';
  assert.equal(sessionIsActive(f.health, f.manifest), true);
  assert.ok(evaluate(f).failures.includes('meeting_still_active'));
  f.health.meetings[0].state = 'empty';
  f.health.pendingJoinUrl = f.manifest.meetingUrl;
  assert.equal(sessionIsActive(f.health, f.manifest), true);
});
test('reopening a meeting must not reuse the preceding session or its files', () => {
  const f = fixture();
  f.manifest.previousSessionId = f.manifest.sessionId;
  assert.ok(evaluate(f).failures.includes('session_was_reused'));
  f.manifest.previousSessionId = '00000000-0000-4000-8000-000000000003';
  f.manifest.previousRecordingIds = [f.job.recordings[0].id];
  assert.ok(evaluate(f).failures.includes('previous_recording_reused'));
});
test('stale media and missing or extra inspections cannot borrow a successful transcript', () => {
  const f = fixture();
  f.inspections[0].modifiedAt++;
  assert.ok(evaluate(f).failures.includes('recording_changed_or_stale'));
  f.inspections = [];
  assert.ok(evaluate(f).failures.includes('source_set_mismatch'));
  const other = fixture();
  other.inspections.push({ ...other.inspections[0], id: 'unrelated.mp4' });
  assert.ok(evaluate(other).failures.includes('source_set_mismatch'));
});
test('Whisper provenance, source timestamps and worker terminal state are required', () => {
  const f = fixture();
  f.job.result.engine.offline = false;
  assert.ok(evaluate(f).failures.includes('whisper_provenance_missing'));
  f.job.result.engine.offline = true;
  f.job.result.segments[0].end = 99;
  assert.ok(evaluate(f).failures.includes('invalid_transcript'));
  f.job.result.segments[0].end = 4;
  f.job.state = 'running';
  assert.ok(evaluate(f).failures.includes('transcript_not_complete'));
});

function secondSource(f) {
  const source = { id: 'synthetic-second.mp4', duration: 10, offsetSeconds: 20, bytes: 200, modifiedAt: 2 };
  f.job.recordings.push(source);
  f.inspections.push({ ...f.inspections[0], ...source });
  f.job.result.duration = 30;
  f.job.result.segments.push({ recordingId: source.id, start: 21, end: 25, speakerId: null, text: '綠色火箭準時出發。' });
  return source;
}
test('expected phrases are checked in the specified recording, not another segment', () => {
  const f = fixture();
  secondSource(f);
  f.job.result.segments[0].text = '完全不同的句子。';
  f.job.result.segments[1].text = '藍色火車準時到站。';
  assert.ok(evaluate(f).failures.includes('expected_speech_missing'));
});
test('pause markers must be absent and the source wall-clock gap must be preserved', () => {
  const f = fixture();
  const second = secondSource(f);
  f.manifest.forbiddenPhrases = ['紫色香蕉'];
  f.manifest.pauseGap = { beforeId: f.job.recordings[0].id, afterId: second.id, minimumSeconds: 5 };
  assert.equal(evaluate(f).passed, true);
  f.job.result.segments[1].text += '紫色香蕉';
  assert.ok(evaluate(f).failures.includes('paused_speech_was_recorded'));
  f.job.result.segments[1].text = '綠色火箭準時出發。';
  f.manifest.pauseGap.minimumSeconds = 15;
  assert.ok(evaluate(f).failures.includes('pause_gap_not_preserved'));
});
test('every speech recording needs recognized words; only declared setup clips are exempt', () => {
  const f = fixture();
  secondSource(f);
  f.job.result.segments.pop();
  assert.ok(evaluate(f).failures.includes('recording_has_no_whisper_speech'));
  f.manifest.setupRecordingIds = ['synthetic-second.mp4'];
  assert.equal(evaluate(f).passed, true);
  f.inspections[1].status = 'failed';
  assert.ok(evaluate(f).failures.includes('recording_not_verified'));
});
test('empty expectations, paths instead of IDs and malformed manifests are refused', () => {
  const f = fixture();
  assert.throws(() => validationManifest({ ...f.manifest, expectations: [] }));
  assert.throws(() => validationManifest({ ...f.manifest, setupRecordingIds: ['../private.mp4'] }));
  assert.throws(() => validationManifest({ ...f.manifest, startedAt: 'invalid' }));
});
