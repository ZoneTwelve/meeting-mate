import { meetUrl } from './config.mjs';

export const HELP = '使用 /meeting <Google Meet 連結> 加入並錄影、/meeting-stop 停止目前會議、/meeting status 查詢本機狀態。只回覆本次 slash 指令，不監聽一般訊息或 thread，也不主動通知。';

export function slashCommand(text = '') {
  if (typeof text !== 'string' || text.length > 8000) return { action: 'invalid', reason: HELP };
  text = text.trim();
  if (!text || /^help$/i.test(text)) return { action: 'help' };
  if (/^status$/i.test(text)) return { action: 'status' };
  if (/^stop$/i.test(text)) return { action: 'stop' };
  text = text.replace(/^join\s+/i, '');
  const link = text.match(/^(?:<(https:\/\/meet\.google\.com\/[^<>|\s]+)(?:\|[^<>]*)?>|(https:\/\/meet\.google\.com\/[^<>|\s]+))$/);
  if (!link) return { action: 'invalid', reason: HELP };
  try { return { action: 'join', url: meetUrl(link[1] ?? link[2]) }; }
  catch { return { action: 'invalid', reason: 'Google Meet 連結格式不正確。' }; }
}
