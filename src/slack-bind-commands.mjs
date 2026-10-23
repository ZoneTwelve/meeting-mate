import { meetUrl } from './config.mjs';

export const HELP = '/meeting <Google Meet 連結> 可加入並錄影。後續在回報 thread 使用 meeting-mate status、pause、resume、stop、transcript、retry、approve、follow <Linear issue>、unfollow、close。也接受 @Yumi 幫我錄影 <Meet 連結>。紀要完成後先確認草稿，approve 才會建單。';

export function slashCommand(text = '') {
  text = text.trim();
  let thread;
  const selected = text.match(/\s+--thread\s+(\d+\.\d+)$/);
  if (selected) { thread = selected[1]; text = text.slice(0, selected.index); }
  if (/^<?https:\/\/meet\.google\.com\//.test(text)) text = `join ${text}`;
  return { ...command(`meeting-mate ${text || 'help'}`), thread };
}

export function command(text, { botId, direct = false, bound = false } = {}) {
  if (typeof text !== 'string' || text.length > 40_000 || /^\s*(?:>|\[Meeting Mate\])/.test(text)) return null;
  text = text.trim();
  const prefix = new RegExp(`^(?:<@${botId}>[\\s,:：]*|@?Yumi[\\s,:：]+|meeting-mate[\\s,:：]+)`, 'i');
  const addressed = prefix.test(text);
  if (addressed) text = text.replace(prefix, '').trim();
  else if (!direct && !bound) return null;
  if (/^(?:(?:請|请|幫我|帮我)\s*)?(?:不要|別|别|不用|不必|do not\b|don't\b)/i.test(text)) return null;
  const structured = text.match(/^(minutes|紀要|纪要)\s+(\{[\s\S]*\})$/i);
  if (structured) {
    try { return { action: 'minutes', minutes: validateMinutes(JSON.parse(structured[2])) }; }
    catch { return { action: 'invalid', reason: '紀要 JSON 格式不正確，請使用 decisions、openQuestions、actions，並為每項附 evidence。' }; }
  }
  const simple = new Map([
    ['help', 'help'], ['幫助', 'help'], ['帮助', 'help'], ['status', 'status'], ['狀態', 'status'], ['状态', 'status'],
    ['stop', 'stop'], ['停止', 'stop'], ['停止錄影', 'stop'], ['停止录影', 'stop'], ['結束會議', 'stop'],
    ['pause', 'pause'], ['暫停', 'pause'], ['暂停', 'pause'], ['暫停錄影', 'pause'],
    ['resume', 'resume'], ['恢復', 'resume'], ['恢复', 'resume'], ['繼續', 'resume'], ['继续', 'resume'],
    ['transcript', 'transcript'], ['逐字稿', 'transcript'], ['retry', 'retry'], ['重試', 'retry'], ['重试', 'retry'],
    ['approve', 'approve'], ['確認建單', 'approve'], ['确认建单', 'approve'], ['unfollow', 'unfollow'], ['停止跟進', 'unfollow'],
    ['close', 'close'], ['結案', 'close'], ['结案', 'close'],
  ]);
  const normalized = text.replace(/[。.!！]$/, '').trim().toLowerCase();
  if (simple.has(normalized)) return { action: simple.get(normalized) };
  const follow = text.match(/^(?:follow|追蹤|跟進)\s+(?:<?https:\/\/linear\.app\/[^/]+\/issue\/)?([A-Z][A-Z0-9]*-\d+)(?:[^\s]*)?$/i);
  if (follow) return { action: 'follow', identifier: follow[1].toUpperCase() };
  // A link in ordinary discussion is never itself a recording instruction.
  const wantsJoin = /^(?:join\b|record\b|加入|錄影|录影|開始錄影|开始录影)/i.test(text) ||
    (addressed && /(?:幫我|帮我|請|请).{0,12}(?:錄影|录影|記錄|记录|加入)/.test(text));
  if (!wantsJoin) return addressed ? { action: 'help' } : null;
  const links = [...text.matchAll(/https:\/\/meet\.google\.com\/[^\s<>|，。]+/g)].map(match => match[0]);
  if (links.length !== 1) return { action: 'invalid', reason: '請提供一個 Google Meet 連結。' };
  try { return { action: 'join', url: meetUrl(links[0]) }; }
  catch { return { action: 'invalid', reason: 'Google Meet 連結格式不正確。' }; }
}

export function validateMinutes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid minutes');
  const text = (v, max = 4000) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('Invalid text'); return v.trim(); };
  const evidence = (v) => {
    if (!Array.isArray(v) || !v.length || v.length > 20) throw new Error('Missing evidence');
    return v.map(item => ({ start: Number.isFinite(item.start) && item.start >= 0 ? item.start : (() => { throw new Error('Invalid timestamp'); })(), quote: text(item.quote) }));
  };
  const list = (items) => {
    if (!Array.isArray(items) || items.length > 50) throw new Error('Invalid list');
    return items.map(item => ({ text: text(item.text), evidence: evidence(item.evidence) }));
  };
  if (!Array.isArray(value.actions) || value.actions.length > 30) throw new Error('Invalid actions');
  return { decisions: list(value.decisions ?? []), openQuestions: list(value.openQuestions ?? []),
    actions: value.actions.map(item => ({ title: text(item.title, 200), description: text(item.description),
      owner: item.owner == null ? null : text(item.owner, 150),
      assigneeId: item.assigneeId == null ? null : /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(item.assigneeId) ? item.assigneeId : (() => { throw new Error('Invalid assignee'); })(),
      dueDate: item.dueDate == null ? null : /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate) && new Date(item.dueDate).toISOString().slice(0, 10) === item.dueDate ? item.dueDate : (() => { throw new Error('Invalid due date'); })(),
      evidence: evidence(item.evidence) })),
  };
}

export function validateEvidence(minutes, transcript) {
  const segments = transcript?.segments ?? [];
  for (const item of [...minutes.decisions, ...minutes.openQuestions, ...minutes.actions]) {
    for (const evidence of item.evidence) {
      if (!segments.some(s => Math.abs(s.start - evidence.start) < 1 && s.text.includes(evidence.quote))) {
        throw new Error('紀要依據與本場逐字稿不符，請使用原句與該句 start 時間。');
      }
    }
  }
  return minutes;
}
