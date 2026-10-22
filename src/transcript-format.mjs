const formats = new Set(['json', 'txt', 'srt', 'vtt']);
const clean = (text) => String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/-->/g, '→');
function timestamp(seconds, separator = '.') {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
}
export function formatTranscript(result, format) {
  if (!formats.has(format)) throw Object.assign(new Error('format must be json, txt, srt or vtt'), { statusCode: 400 });
  if (format === 'json') return `${JSON.stringify(result, null, 2)}\n`;
  const names = new Map(result.speakers.map((speaker) => [speaker.id, speaker.label]));
  const label = (segment) => clean(names.get(segment.speakerId) ?? 'Unknown speaker');
  if (format === 'txt') return result.segments.map((segment) => `[${timestamp(segment.start)} – ${timestamp(segment.end)}] ${label(segment)}: ${clean(segment.text)}`).join('\n') + '\n';
  const cues = result.segments.map((segment, index) => {
    const text = `${label(segment)}: ${clean(segment.text)}`;
    const escaped = format === 'vtt' ? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : text;
    const separator = format === 'srt' ? ',' : '.';
    return `${index + 1}\n${timestamp(segment.start, separator)} --> ${timestamp(segment.end, separator)}\n${escaped}\n`;
  }).join('\n');
  return `${format === 'vtt' ? 'WEBVTT\n\n' : ''}${cues}`;
}

export function validateTranscript(result, job) {
  if (!result || result.jobId !== job.id || !Array.isArray(result.speakers) || !Array.isArray(result.segments) ||
    !Number.isFinite(result.duration) || result.duration < 0 || result.speakers.length > 100 || result.segments.length > 100000) {
    throw new Error('Invalid transcript result or mismatched job ID');
  }
  const speakers = new Set();
  for (const speaker of result.speakers) {
    if (typeof speaker.id !== 'string' || !/^speaker_\d+$/.test(speaker.id) || speakers.has(speaker.id) ||
      typeof speaker.label !== 'string' || speaker.label.length > 100) throw new Error('Invalid transcript speaker');
    speakers.add(speaker.id);
  }
  const recordings = new Map(job.recordings.map((recording) => [recording.id, recording]));
  let previous = -1;
  for (const segment of result.segments) {
    const source = recordings.get(segment.recordingId);
    if (!source || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < previous ||
      segment.start < source.offsetSeconds - 0.1 || segment.end < segment.start || segment.end > source.offsetSeconds + source.duration + 1 ||
      (segment.speakerId !== null && !speakers.has(segment.speakerId)) || typeof segment.text !== 'string' || segment.text.length > 10000) {
      throw new Error('Invalid transcript segment or source timeline');
    }
    previous = segment.start;
  }
  return result;
}
