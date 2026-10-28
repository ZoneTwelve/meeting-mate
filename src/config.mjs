import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function meetUrl(value) {
  const url = new URL(value);
  const code = url.pathname.match(/^\/(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/)?.[1];
  if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com' || url.port || url.username || url.password || !code) throw new Error(`Invalid Google Meet URL: ${value}`);
  return `https://meet.google.com/${code}`;
}

export function normalizeConfig(raw, env = process.env, base = root) {
  const positive = (name, fallback, minimum = 1) => {
    const n = raw[name] ?? fallback;
    if (!Number.isFinite(n) || n < minimum) throw new Error(`${name} must be a number >= ${minimum}`);
    return n;
  };
  const username = (env.MEET_USERNAME ?? '').trim();
  if (!username || username.length > 60) throw new Error('Set MEET_USERNAME in .env to a display name of 1–60 characters');
  const urls = raw.meetingUrls ?? [raw.meetingUrl];
  if (!Array.isArray(urls)) throw new Error('meetingUrls must be an array; use [] for manual-only operation');
  const absolute = (p) => path.resolve(base, p);
  const port = (name, fallback) => {
    const n = positive(name, fallback);
    if (!Number.isInteger(n) || n > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
    return n;
  };
  const transcriptLanguage = raw.transcriptLanguage ?? 'auto';
  if (typeof transcriptLanguage !== 'string' || !/^(auto|[a-z]{2,3})$/.test(transcriptLanguage)) throw new Error('transcriptLanguage must be auto or a language code');
  return {
    username, meetingUrls: [...new Set(urls.map(meetUrl))],
    profileDir: absolute(raw.profileDir ?? '.meeting-mate/chrome-profile'),
    recordingsDir: absolute(raw.recordingsDir ?? 'recordings'),
    statusFile: absolute(raw.statusFile ?? '.meeting-mate/status.json'),
    chromePath: raw.chromiumPath ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    cdpPort: port('cdpPort', 9222), healthPort: port('healthPort', 8787),
    pollIntervalMs: positive('pollIntervalSeconds', 3600) * 1000,
    joinWaitMs: positive('joinWaitSeconds', 900) * 1000,
    maxSessionMs: positive('maxSessionSeconds', 43200) * 1000,
    segmentMs: positive('segmentSeconds', 600, 10) * 1000,
    minFreeBytes: positive('minimumFreeGB', 2, 0) * 1024 ** 3,
    cameraIndicator: raw.cameraIndicator !== false,
    cameraFile: absolute('.meeting-mate/recording-camera.y4m'),
    cameraAudioFile: absolute('.meeting-mate/silent-microphone.wav'),
    recorderApp: absolute('.meeting-mate/Meeting Mate Recorder.app'),
    recorderPath: absolute('.meeting-mate/Meeting Mate Recorder.app/Contents/MacOS/meeting-mate-recorder'),
    transcriptEnabled: raw.transcriptEnabled !== false,
    transcriptLanguage,
    transcriptsDir: absolute(raw.transcriptsDir ?? 'transcripts'),
    transcriptPython: absolute('.meeting-mate/transcript-venv/bin/python'),
    transcriptModels: absolute('.meeting-mate/models'),
  };
}

export async function loadConfig() {
  try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const filename = path.resolve(root, process.env.MEETING_MATE_CONFIG ?? 'config.json');
  return normalizeConfig(JSON.parse(await fs.readFile(filename, 'utf8')));
}
