import { chmod, mkdir, open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export class BindStore {
  constructor(directory, { now = Date.now } = {}) {
    this.directory = path.join(directory, '.meeting-mate', 'slack-bind');
    this.filename = path.join(this.directory, 'state.json');
    this.lockfile = path.join(this.directory, 'process.lock');
    this.now = now;
    this.writing = Promise.resolve();
  }
  async acquire() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.lockfile, 'wx', 0o600);
        this.lock = { pid: process.pid, nonce: randomUUID() };
        await handle.writeFile(JSON.stringify(this.lock)); await handle.close(); return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = JSON.parse(await readFile(this.lockfile, 'utf8')); } catch { throw new Error('Unreadable Slack binding lock; inspect it before restarting.'); }
        if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid Slack binding lock.');
        try { process.kill(owner.pid, 0); throw new Error('Another Slack binding process is running.'); }
        catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
        // Remove only the stale owner we inspected, never a replacement lock.
        if ((await readFile(this.lockfile, 'utf8')) !== JSON.stringify(owner)) throw new Error('Slack binding lock changed; retry startup.');
        await unlink(this.lockfile);
      }
    }
    throw new Error('Cannot acquire Slack binding lock.');
  }
  async load(teamId, botId) {
    try {
      if ((await stat(this.filename)).size > 32 * 1024 ** 2) throw new Error('Binding state is too large.');
      this.state = JSON.parse(await readFile(this.filename, 'utf8'));
      if (this.state.version !== 1 || this.state.teamId !== teamId || this.state.botId !== botId ||
          !this.state.threads || !this.state.processed || !this.state.outbox || !this.state.channels || !Number.isFinite(this.state.startedAt)) {
        throw new Error('Binding state belongs to another installation or is invalid.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot load Slack binding state; existing state was preserved.');
      this.state = { version: 1, teamId, botId, startedAt: this.now() / 1000,
        channels: {}, threads: {}, processed: {}, outbox: {}, search: {} };
      await this.save();
    }
    this.state.inbox ??= {};
    return this.state;
  }
  save() {
    // HTTP receipt persistence must not race the background worker's rename.
    const bytes = JSON.stringify(this.state);
    const writing = this.writing.then(() => this.write(bytes));
    this.writing = writing.catch(() => {});
    return writing;
  }
  async write(bytes) {
    if (Buffer.byteLength(bytes) > 32 * 1024 ** 2) throw new Error('Binding state is too large; archive completed bindings before restarting.');
    const temporary = `${this.filename}.${process.pid}.tmp`;
    const handle = await open(temporary, 'w', 0o600);
    try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.filename);
  }
  async release() {
    if (!this.lock) return;
    try {
      const owner = JSON.parse(await readFile(this.lockfile, 'utf8'));
      if (owner.nonce === this.lock.nonce) await unlink(this.lockfile);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.lock = null;
  }
}
