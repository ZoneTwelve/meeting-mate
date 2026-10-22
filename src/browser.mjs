import fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { CdpConnection, cdpJson } from './cdp.mjs';
import { meetUrl } from './config.mjs';
import { MeetPage } from './meet-page.mjs';

const execute = promisify(execFile);

export class Browser {
  constructor(config) { this.config = config; this.pages = new Map(); }
  async connect() {
    const version = await cdpJson(this.config.cdpPort, '/json/version');
    const root = await new CdpConnection(version.webSocketDebuggerUrl).connect();
    try {
      const { processInfo } = await root.send('SystemInfo.getProcessInfo');
      const pid = processInfo.find((entry) => entry.type === 'browser')?.id;
      const { stdout } = await execute('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 });
      if (!stdout.includes(`--user-data-dir=${this.config.profileDir}`)) throw new Error('CDP port belongs to a different Chrome profile');
      this.pid = pid;
      this.command = stdout;
      this.cameraReady = this.config.cameraIndicator && stdout.includes('--use-fake-device-for-media-stream') &&
        stdout.includes(`--use-file-for-fake-video-capture=${this.config.cameraFile}`) &&
        stdout.includes(`--use-file-for-fake-audio-capture=${this.config.cameraAudioFile}`);
      this.root?.close();
      this.root = root;
      return root;
    } catch (error) { root.close(); throw error; }
  }
  async ensure({ restartForCamera = false } = {}) {
    let reachable = false;
    try { await cdpJson(this.config.cdpPort, '/json/version'); reachable = true; } catch {}
    if (reachable) {
      await this.connect();
      if (!this.config.cameraIndicator || this.cameraReady) return;
      // Preserve an existing call; never enable a physical camera as a fallback.
      if (!restartForCamera) return;
      for (const target of await cdpJson(this.config.cdpPort, '/json/list')) {
        if (target.type !== 'page' || !target.url.startsWith('https://meet.google.com/')) continue;
        const connection = await new CdpConnection(target.webSocketDebuggerUrl).connect();
        try {
          if ((await new MeetPage(connection).snapshot()).phase === 'in_call') throw new Error('Leave the current call before restarting Chrome for the recording camera');
        } finally { connection.close(); }
      }
      await this.root.send('Browser.close').catch(() => {});
      for (let n = 0; n < 40; n++) {
        try { await cdpJson(this.config.cdpPort, '/json/version'); }
        catch { break; }
        await delay(250);
      }
    }
    await fs.mkdir(this.config.profileDir, { recursive: true, mode: 0o700 });
    if (this.config.cameraIndicator) { await fs.access(this.config.cameraFile); await fs.access(this.config.cameraAudioFile); }
    const args = [
      `--remote-debugging-port=${this.config.cdpPort}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${this.config.profileDir}`, '--no-first-run', '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      ...(this.config.cameraIndicator ? ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${this.config.cameraFile}`, `--use-file-for-fake-audio-capture=${this.config.cameraAudioFile}`] : []),
      'about:blank',
    ];
    const chrome = spawn(this.config.chromePath, args, { detached: true, stdio: 'ignore' });
    let spawnError;
    chrome.on('error', (error) => { spawnError = error; });
    chrome.unref();
    for (let n = 0; n < 60; n++) {
      if (spawnError) throw spawnError;
      try { await this.connect(); return; } catch { await delay(500); }
    }
    throw new Error('Dedicated Chrome did not start within 30 seconds');
  }
  async page(url) {
    const existing = this.pages.get(url);
    if (existing) return existing;
    const targets = await cdpJson(this.config.cdpPort, '/json/list');
    let target = targets.find((item) => {
      if (item.type !== 'page') return false;
      try { return meetUrl(item.url) === url; } catch { return false; }
    });
    if (!target) {
      const { targetId } = await this.root.send('Target.createTarget', { url, newWindow: true, width: 1280, height: 800 });
      for (let attempt = 0; attempt < 20; attempt++) {
        target = (await cdpJson(this.config.cdpPort, '/json/list')).find((item) => item.id === targetId);
        if (target) break;
        await delay(100);
      }
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('Cannot find the managed Meet tab');
    const cdp = await new CdpConnection(target.webSocketDebuggerUrl).connect();
    const page = new MeetPage(cdp);
    page.targetId = target.id;
    this.pages.set(url, page);
    if (this.cameraReady) {
      // Chrome supports this grant once the default browser context has a page.
      await this.root.send('Browser.grantPermissions', { origin: 'https://meet.google.com', permissions: ['videoCapture', 'audioCapture'] });
    }
    return page;
  }
  async health() { await this.root.send('Browser.getVersion'); }
  async release(url) {
    const page = this.pages.get(url);
    this.pages.delete(url);
    if (!page) return;
    try { await this.root.send('Target.closeTarget', { targetId: page.targetId }); }
    finally { page.cdp.close(); }
  }
  disconnect() { for (const page of this.pages.values()) page.cdp.close(); this.pages.clear(); this.root?.close(); }
}
