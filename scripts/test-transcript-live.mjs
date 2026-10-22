import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { loadConfig, root } from '../src/config.mjs';
import { API_ID_PATTERN } from '../src/api-client.mjs';

const args = process.argv.slice(2);
const numSpeakers = args[0] === '--speakers' ? Number(args[1]) : undefined;
const ids = numSpeakers === undefined ? args : args.slice(2);
if ((numSpeakers !== undefined && (!Number.isInteger(numSpeakers) || numSpeakers < 1 || numSpeakers > 20)) ||
  !ids.length || ids.length > 20 || ids.some((id) => !API_ID_PATTERN.test(id) || !id.endsWith('.mp4'))) {
  throw new Error('Usage: pnpm run test:transcript:live [--speakers 2] <recording-id.mp4> [another-recording-id.mp4]');
}
const config = await loadConfig();
const client = new Client({ name: 'meeting-mate-transcript-validation', version: '1.0.0' });
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const value = response.structuredContent ?? JSON.parse(response.content.find((item) => item.type === 'text').text);
  if (response.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return value;
}
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp.mjs')], stderr: 'inherit' }));
  const jobs = [];
  for (const recordingId of ids) {
    const job = await call('transcript_create', { recordingId, ...(numSpeakers === undefined ? {} : { numSpeakers }) });
    console.log(JSON.stringify({ phase: 'queued', recordingId, jobId: job.id }));
    jobs.push(job.id);
  }
  const deadline = Date.now() + 4 * 3600000;
  const last = new Map();
  const completed = new Set();
  while (completed.size < jobs.length && Date.now() < deadline) {
    for (const id of jobs) {
      if (completed.has(id)) continue;
      const job = await call('transcript_get', { id });
      const status = JSON.stringify({ jobId: id, state: job.state, phase: job.phase, progress: job.progress, suspended: job.suspended });
      if (last.get(id) !== status) { console.log(status); last.set(id, status); }
      if (job.state === 'failed') throw new Error(job.error);
      if (job.state !== 'completed') continue;
      const result = job.result;
      if (!result) throw new Error('Transcript is too large for inline validation; inspect the local JSON export');
      const speakerStats = result.speakers.map((speaker) => {
        const segments = result.segments.filter((segment) => segment.speakerId === speaker.id);
        return { ...speaker, segments: segments.length, seconds: Number(segments.reduce((sum, segment) => sum + segment.end - segment.start, 0).toFixed(3)),
          characters: segments.reduce((sum, segment) => sum + segment.text.length, 0) };
      });
      const formats = {};
      for (const format of ['json', 'txt', 'srt', 'vtt']) {
        const response = await fetch(`http://127.0.0.1:${config.healthPort}/v1/transcripts/${id}/file?format=${format}`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`Transcript export ${format}: HTTP ${response.status}`);
        const body = await response.text();
        if (format === 'json') JSON.parse(body);
        if (format === 'vtt' && !body.startsWith('WEBVTT')) throw new Error('Invalid VTT export');
        formats[format] = Buffer.byteLength(body);
      }
      const report = { checkedAt: new Date().toISOString(), jobId: id, recordings: job.recordings.map((recording) => recording.id),
        state: job.state, requestedSpeakerCount: job.numSpeakers, duration: result.duration, speakerStats, segmentCount: result.segments.length,
        speakerChanges: result.segments.slice(1).filter((segment, index) => segment.speakerId !== result.segments[index].speakerId).length,
        engine: result.engine, warnings: result.warnings, formats,
        qualityNote: 'Automatic checks only. Speaker count does not establish correct speaker attribution; review source audio and timestamps locally.' };
      const directory = path.join(root, '.meeting-mate/transcript-validation');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, `${id}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
      console.log(JSON.stringify(report, null, 2));
      completed.add(id);
    }
    if (completed.size < jobs.length) await delay(2000);
  }
  if (completed.size !== jobs.length) throw new Error('Timed out waiting for local transcript jobs');
} finally { await client.close(); }
