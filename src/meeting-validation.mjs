import { meetUrl } from './config.mjs';
import { validateTranscript } from './transcript-format.mjs';

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const recordingId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,240}\.mp4$/;
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const compact = value => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
const activeStates = new Set(['checking', 'joining', 'waiting_approval', 'joined_empty', 'starting_recording', 'recording', 'paused', 'finalizing']);

export function validationManifest(value) {
  if (!value || value.version !== 1 || !uuid.test(value.sessionId) || !Number.isFinite(Date.parse(value.startedAt))) {
    throw new Error('Expected a version 1 manifest with a session UUID and startedAt');
  }
  let url;
  try { url = meetUrl(value.meetingUrl); } catch { throw new Error('Invalid controlled meeting URL'); }
  if (value.previousSessionId !== undefined && !uuid.test(value.previousSessionId)) throw new Error('Invalid previous session UUID');
  if (value.expectedRecordingCount !== undefined && (!Number.isInteger(value.expectedRecordingCount) || value.expectedRecordingCount < 1 || value.expectedRecordingCount > 1000)) {
    throw new Error('Invalid expected recording count');
  }
  const ids = (input = []) => {
    if (!Array.isArray(input) || input.length > 1000 || input.some(id => typeof id !== 'string' || !recordingId.test(id)) || new Set(input).size !== input.length) {
      throw new Error('Expected unique controlled recording IDs');
    }
    return input;
  };
  if (!Array.isArray(value.expectations) || !value.expectations.length || value.expectations.length > 50) throw new Error('At least one speech expectation is required');
  const names = new Set();
  const expectations = value.expectations.map(item => {
    if (!item || !/^[A-Za-z0-9_-]{1,60}$/.test(item.id) || names.has(item.id) || !Array.isArray(item.alternatives) ||
      !item.alternatives.length || item.alternatives.length > 8 || item.alternatives.some(phrase => !text(phrase) || !compact(phrase)) ||
      (item.recordingId !== undefined && !recordingId.test(item.recordingId))) throw new Error('Invalid speech expectation');
    names.add(item.id);
    return { id: item.id, alternatives: item.alternatives, recordingId: item.recordingId };
  });
  const forbiddenPhrases = value.forbiddenPhrases ?? [];
  if (!Array.isArray(forbiddenPhrases) || forbiddenPhrases.length > 50 || forbiddenPhrases.some(phrase => !text(phrase) || !compact(phrase))) {
    throw new Error('Invalid forbidden speech markers');
  }
  let pauseGap;
  if (value.pauseGap !== undefined) {
    const item = value.pauseGap;
    if (!item || !recordingId.test(item.beforeId) || !recordingId.test(item.afterId) || item.beforeId === item.afterId ||
      !Number.isFinite(item.minimumSeconds) || item.minimumSeconds <= 0) throw new Error('Invalid pause gap expectation');
    pauseGap = { beforeId: item.beforeId, afterId: item.afterId, minimumSeconds: item.minimumSeconds };
  }
  return { version: 1, meetingUrl: url, sessionId: value.sessionId, startedAt: value.startedAt,
    previousSessionId: value.previousSessionId, previousRecordingIds: ids(value.previousRecordingIds),
    expectedRecordingCount: value.expectedRecordingCount, setupRecordingIds: ids(value.setupRecordingIds),
    expectations, forbiddenPhrases, pauseGap };
}

export function sessionIsActive(health, manifest) {
  if (!health || !Array.isArray(health.meetings)) throw new Error('Meeting state is unavailable');
  return health.pendingJoinUrl === manifest.meetingUrl || health.meetings.some(job =>
    (job.sessionId === manifest.sessionId || job.url === manifest.meetingUrl) &&
    (job.joinedAt || job.recordingFile || job.joinRequestedAt || job.joinInFlight || activeStates.has(job.state)));
}

// A completed job, a nonempty MP4 or a loud notification alone cannot pass.
// The CLI supplies fresh local FFmpeg inspections and the actual worker result.
export function evaluateMeetingValidation(input, { health, job, inspections = [] }) {
  const manifest = validationManifest(input);
  const failures = [];
  const fail = code => { if (!failures.includes(code)) failures.push(code); };
  if (sessionIsActive(health, manifest)) fail('meeting_still_active');
  if (manifest.sessionId === manifest.previousSessionId) fail('session_was_reused');
  if (job?.state !== 'completed' || job.sessionId !== manifest.sessionId || !Array.isArray(job.recordings) || !job.recordings.length) fail('transcript_not_complete');
  if (!Number.isFinite(Date.parse(job?.createdAt)) || Date.parse(job.createdAt) < Date.parse(manifest.startedAt)) fail('stale_transcript');
  const engine = job?.result?.engine;
  if (!['faster-whisper', 'openai-whisper', 'openai-whisper-cli'].includes(engine?.asr) || !['small', 'large-v3-turbo'].includes(engine?.model) || engine?.offline !== true) {
    fail('whisper_provenance_missing');
  }
  try { validateTranscript(job?.result, job); } catch { fail('invalid_transcript'); }
  const sources = Array.isArray(job?.recordings) ? job.recordings : [];
  const segments = Array.isArray(job?.result?.segments) ? job.result.segments.filter(item => item && typeof item.text === 'string') : [];
  const sourceIds = new Set(sources.map(item => item.id));
  const inspected = new Map(inspections.map(item => [item.id, item]));
  if (sourceIds.size !== sources.length || inspected.size !== inspections.length || inspected.size !== sourceIds.size ||
    inspections.some(item => !sourceIds.has(item.id))) fail('source_set_mismatch');
  if (manifest.expectedRecordingCount !== undefined && sources.length !== manifest.expectedRecordingCount) fail('unexpected_recording_count');
  if (manifest.previousRecordingIds.some(id => sourceIds.has(id))) fail('previous_recording_reused');
  if (manifest.setupRecordingIds.some(id => !sourceIds.has(id))) fail('unknown_setup_recording');
  const recordingChecks = sources.map(source => {
    const current = inspected.get(source.id);
    const valid = current?.status === 'verified' && current.available === true && current.sessionId === manifest.sessionId &&
      current.containerVerified === true && current.frames > 0 && current.audioFrames > 0 && current.duration > 0;
    if (!valid) fail('recording_not_verified');
    const fresh = current && current.bytes === source.bytes && current.modifiedAt === source.modifiedAt &&
      Number.isFinite(Date.parse(current.startedAt)) && Date.parse(current.startedAt) >= Date.parse(manifest.startedAt) - 1000;
    if (!fresh) fail('recording_changed_or_stale');
    const audible = current?.audioSignal?.status === 'signal' && Number.isFinite(current.audioSignal.peakDB) && current.audioSignal.peakDB >= -60;
    if (!audible) fail('silent_or_quiet_recording');
    const speech = segments.some(segment => segment.recordingId === source.id && typeof segment.text === 'string' && compact(segment.text));
    const setup = manifest.setupRecordingIds.includes(source.id);
    if (!setup && !speech) fail('recording_has_no_whisper_speech');
    return { id: source.id, valid: !!valid, fresh: !!fresh, audible, speech, setup };
  });
  const fullText = compact(segments.map(item => typeof item.text === 'string' ? item.text : '').join(' '));
  if (!fullText) fail('empty_whisper_result');
  const phraseChecks = manifest.expectations.map(expectation => {
    if (expectation.recordingId && !sourceIds.has(expectation.recordingId)) fail('unknown_expected_recording');
    const content = expectation.recordingId
      ? compact(segments.filter(item => item.recordingId === expectation.recordingId).map(item => item.text ?? '').join(' ')) : fullText;
    const matched = expectation.alternatives.some(phrase => content.includes(compact(phrase)));
    if (!matched) fail('expected_speech_missing');
    return { id: expectation.id, matched };
  });
  if (manifest.forbiddenPhrases.some(phrase => fullText.includes(compact(phrase)))) fail('paused_speech_was_recorded');
  let pauseGapSeconds = null;
  if (manifest.pauseGap) {
    const before = sources.find(item => item.id === manifest.pauseGap.beforeId), after = sources.find(item => item.id === manifest.pauseGap.afterId);
    pauseGapSeconds = before && after ? after.offsetSeconds - before.offsetSeconds - before.duration : null;
    if (!Number.isFinite(pauseGapSeconds) || pauseGapSeconds < manifest.pauseGap.minimumSeconds) fail('pause_gap_not_preserved');
  }
  return { passed: failures.length === 0, failures, phraseChecks, recordingChecks,
    metrics: { recordings: sources.length, speechSegments: segments.length, pauseGapSeconds },
    engine: engine ?? null };
}
