import { loadConfig, meetUrl } from '../src/config.mjs';

const [input, ...extra] = process.argv.slice(2);
if (!input || extra.length) {
  console.error('用法：pnpm run join:now https://meet.google.com/abc-defg-hij');
  process.exitCode = 2;
} else {
  try {
    const url = meetUrl(input);
    const config = await loadConfig();
    const response = await fetch(`http://127.0.0.1:${config.healthPort}/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }), signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.activeUrl ? `另一場會議正在進行：${result.activeUrl}` : result.error ?? result.status);
    console.log(result.status === 'already_active' ? `此連結已在加入或錄影中：${url}` : `已觸發立即加入：${url}（${config.username}）；獲准進入後會自動錄影。`);
    console.log(`查看狀態：http://127.0.0.1:${config.healthPort}/healthz`);
  } catch (error) {
    console.error(error.cause?.code === 'ECONNREFUSED' ? 'Meeting Mate 尚未執行，請先執行 pnpm run install:launchd。' : error.message);
    process.exitCode = 1;
  }
}
