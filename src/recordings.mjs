import { constants } from 'node:fs';
import { open, readdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';

const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });
export class Recordings {
  constructor(config) { this.config = config; }
  async location(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,240}\.mp4$/.test(id)) throw failure('Invalid recording ID', 400);
    const root = await realpath(this.config.recordingsDir).catch((error) => { if (error.code === 'ENOENT') throw failure('Recording not found', 404); throw error; });
    return path.join(root, id);
  }
  async get(id) {
    const file = await this.location(id);
    let handle;
    let metadata;
    try {
      handle = await open(`${file}.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536) throw failure('Invalid recording metadata', 422);
      metadata = JSON.parse(await handle.readFile('utf8'));
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw failure('Invalid recording metadata', 422);
    } catch (error) {
      if (['ENOENT', 'ELOOP'].includes(error.code)) throw failure('Recording not found', 404);
      throw error;
    } finally { await handle?.close(); }
    const stat = await lstat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    const available = !!stat?.isFile() && !stat.isSymbolicLink();
    return {
      id, file: available ? file : null, available,
      meetingUrl: metadata.meetingUrl, username: metadata.username, sessionId: metadata.sessionId ?? null,
      segmentIndex: metadata.segmentIndex ?? null, startedAt: metadata.startedAt, endedAt: metadata.endedAt ?? null,
      status: metadata.status, error: metadata.error ?? null, bytes: available ? stat.size : 0,
      duration: metadata.media?.duration ?? null, video: metadata.media?.video ?? null, audio: metadata.media?.audio ?? null,
      frames: metadata.media?.frames ?? null, audioFrames: metadata.media?.audioFrames ?? null,
      downloadUrl: available && metadata.status === 'verified' ? `http://127.0.0.1:${this.config.healthPort}/v1/recordings/${encodeURIComponent(id)}/file` : null,
    };
  }
  async list(limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw failure('limit must be an integer from 1 to 100', 400);
    return (await this.all()).slice(0, limit);
  }
  async all() {
    const entries = await readdir(this.config.recordingsDir, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    const ids = entries.filter((item) => item.isFile() && item.name.endsWith('.mp4.json')).map((item) => item.name.slice(0, -5)).sort().reverse();
    const recordings = [];
    for (const id of ids) {
      try { recordings.push(await this.get(id)); } catch (error) { if (![400, 404, 422].includes(error.statusCode) && !(error instanceof SyntaxError)) throw error; }
    }
    return recordings.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }
  async openFile(id) {
    const recording = await this.get(id);
    if (!recording.available) throw failure('Recording file not found', 404);
    if (recording.status !== 'verified') throw failure('Recording has not finalized successfully', 409);
    let handle;
    try {
      handle = await open(recording.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) throw failure('Recording file not found', 404);
      if (stat.size === 0) throw failure('Recording file is empty', 409);
      return { handle, size: stat.size, recording };
    } catch (error) {
      await handle?.close();
      if (['ENOENT', 'ELOOP'].includes(error.code)) throw failure('Recording file not found', 404);
      throw error;
    }
  }
}
