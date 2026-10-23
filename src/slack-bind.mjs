import { createHash } from 'node:crypto';
import { slashCommand, HELP } from './slack-bind-commands.mjs';

export function stableId(value) {
  const b = createHash('sha256').update(value).digest().subarray(0, 16);
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const s = b.toString('hex'); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export const safeFailure = error => `${/^[a-z_0-9]+$/i.test(error.code ?? '') ? error.code : 'operation_failed'}${Number.isInteger(error.httpStatus) ? ` (HTTP ${error.httpStatus})` : ''}`;
const mode = 'slash-only-v1';
const finished = item => ['done', 'failed'].includes(item.state);
const active = job => !!(job.joinedAt || job.joinRequestedAt || job.joinInFlight || job.pendingAttempt || job.recordingFile);
const label = value => /^[a-z_0-9.-]{1,80}$/i.test(value ?? '') ? value : 'unknown';

// The worker has no Slack messaging, search, upload, or Linear client. Its only
// reply channel is the return value of an authenticated slash HTTP request.
export class SlackBinding {
  constructor({ config, store, api, identity, now = Date.now, log = console.log, statusTimeoutMs = 1500 }) {
    Object.assign(this, { config, store, api, identity, now, log, statusTimeoutMs });
    this.state = store.state;
    this.ownerId = identity.user?.user_id;
    this.receipts = new Map();
  }
  async save() { await this.store.save(); }
  permitted(user) {
    if (this.config.meetingAccess === 'workspace') return /^[UW][A-Z0-9]+$/.test(user);
    return (this.config.allowedUsers.length ? this.config.allowedUsers : [this.ownerId]).includes(user);
  }
  async prepare() {
    // Preserve historical threads/outbox as private data, but never deliver or
    // resume their autonomous work. An interrupted mutation needs human review.
    let changed = false;
    for (const item of Object.values(this.state.inbox)) {
      if (finished(item)) continue;
      if (item.mode !== mode || item.state === 'executing') {
        item.action ??= item.cmd?.action;
        item.state = 'failed';
        item.result = item.mode !== mode ? '舊版待處理指令已停用；需要操作時請重新輸入 slash 指令。'
          : '上次執行中斷，操作結果尚未確認；請先查詢本機狀態，再決定是否重試。';
        delete item.cmd;
        changed = true;
      }
    }
    if (changed) await this.save();
  }
  async acceptSlash({ channel, user, text, trigger, slash }) {
    if (!['/meeting', '/meeting-stop'].includes(slash)) return HELP;
    if (this.config.channelIds.length && !this.config.channelIds.includes(channel)) return '這個頻道未啟用 Meeting Mate。';
    const cmd = slash === '/meeting-stop' ? { action: 'stop' } : slashCommand(text);
    if (cmd.action === 'invalid') return cmd.reason;
    if (cmd.action === 'help') return HELP;
    if (!this.permitted(user)) return '這台 Mac 尚未授權你的 Slack 帳號執行 Meeting Mate 指令。';
    if (cmd.action === 'status') return this.status(channel, user);

    const id = stableId(`slash:${this.state.teamId}:${trigger}`);
    if (this.state.inbox[id]) {
      await this.receipts.get(id);
      return '這個請求已受理，沒有重複執行。請用 /meeting status 查看結果。';
    }
    if (cmd.action !== 'stop' && Object.values(this.state.inbox).filter(i => i.mode === mode && !finished(i)).length >= 100) return '本機指令佇列已滿，請稍後再試。';
    this.state.inbox[id] = { id, mode, channel, user, cmd, action: cmd.action, createdAt: this.now(), state: 'queued' };
    const receipt = this.save(); this.receipts.set(id, receipt);
    try { await receipt; }
    catch (error) { delete this.state.inbox[id]; throw error; }
    finally { this.receipts.delete(id); }
    return cmd.action === 'stop'
      ? '已受理停止請求，會停止本機目前的會議／待加入請求並完成錄影檔。請用 /meeting status 確認結果；已排入本機的轉寫會繼續。'
      : '已受理加入請求，會自動開啟指定 Meet 並嘗試入會。這不代表已開始錄影；請用 /meeting status 查看結果。';
  }
  async status(channel, user) {
    const recent = Object.values(this.state.inbox).filter(i => i.mode === mode && i.channel === channel && i.user === user)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
    const lines = recent.map(i => `最近 ${i.action === 'stop' ? '/meeting-stop' : '/meeting'}：${label(i.state)}${i.result ? `；${i.result}` : ''}`);
    const controller = new AbortController();
    let timer;
    try {
      // Stay within Slack's ACK deadline even when the local API is stalled.
      const result = await Promise.race([
        Promise.allSettled([this.api.meetings({ signal: controller.signal }), this.api.transcriptsList(3, { signal: controller.signal })]),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, this.statusTimeoutMs); }),
      ]);
      if (!result) lines.push('本機查詢逾時；請稍後再次使用 /meeting status。');
      else {
        const [meetings, transcripts] = result;
        if (meetings.status === 'fulfilled') {
          const current = meetings.value.meetings.filter(active);
          lines.push(current.length ? `目前會議：${current.map(j => label(j.state)).join('、')}。` : '目前沒有進行中或待加入的會議。');
        } else lines.push(`無法確認會議狀態（${safeFailure(meetings.reason)}）。`);
        if (transcripts.status === 'fulfilled') {
          for (const job of transcripts.value.transcripts) {
            const progress = Number.isFinite(job.progress) ? ` ${Math.max(0, Math.min(100, job.progress)).toFixed(1)}%` : '';
            lines.push(`轉寫 ${label(job.id)}：${label(job.state)}${job.phase ? `；階段 ${label(job.phase)}${progress}` : ''}。`);
          }
          if (transcripts.value.transcripts.some(j => !['completed', 'failed'].includes(j.state))) lines.push('階段 100% 不代表整份逐字稿完成；completed 才是完成。');
        } else lines.push(`無法確認轉寫狀態（${safeFailure(transcripts.reason)}）。`);
      }
    } finally { clearTimeout(timer); }
    return lines.join('\n');
  }
  async drainSlash() {
    if (this.draining) return this.draining;
    this.draining = this.drain();
    try { await this.draining; } finally { this.draining = null; }
  }
  async drain() {
    const queue = Object.values(this.state.inbox).sort((a, b) => Number(b.action === 'stop') - Number(a.action === 'stop'));
    for (const item of queue) {
      if (item.mode !== mode || item.state !== 'queued' || this.receipts.has(item.id)) continue;
      if (item.action === 'stop') {
        for (const pending of Object.values(this.state.inbox)) {
          if (pending.mode === mode && pending.action === 'join' && pending.state === 'queued') {
            pending.state = 'failed'; pending.result = '加入請求已被後續停止指令取消。'; delete pending.cmd;
          }
        }
      }
      item.state = 'executing';
      await this.save();
      try {
        if (item.action === 'stop') {
          const receipt = await this.api.stop(undefined, { idempotencyKey: stableId(`slash-stop:${item.id}`) });
          item.result = `停止請求：${label(receipt.status)}。錄影檔完成收尾後，已啟用的自動轉寫仍在本機執行。`;
        } else {
          const { meetings } = await this.api.meetings();
          if (meetings.some(active)) {
            item.state = 'failed'; item.result = '本機已有會議進行中，這次沒有開始另一場錄影。';
          } else {
            const receipt = await this.api.join(item.cmd.url, { idempotencyKey: stableId(`slash-join:${item.id}`) });
            item.result = `加入請求：${label(receipt.status)}。是否開始錄影請以目前會議狀態為準。`;
          }
        }
        if (item.state !== 'failed') item.state = 'done';
      } catch (error) {
        item.state = 'failed';
        item.result = `操作結果未確認（${safeFailure(error)}）；請先查詢本機狀態，再決定是否重新下指令。`;
        this.log(`Slash command failed: ${safeFailure(error)}`);
      }
      delete item.cmd;
      await this.save();
    }
  }
  async cycle() { await this.drainSlash(); }
}
