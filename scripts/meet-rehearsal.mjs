import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { root } from '../src/config.mjs';

const execute = promisify(execFile);
if (process.argv.includes('--help')) {
  console.log('Usage: pnpm exec node scripts/meet-rehearsal.mjs\nCreates local synthetic speech and a loopback test page. Open it in the host browser and explicitly share that tab with audio in a dedicated test Meet. It never joins, records, or changes the meeting service.');
  process.exit(0);
}
if (process.argv.length > 2) throw new Error('Only --help is supported; never pass a private meeting URL to this script.');
if (process.platform !== 'darwin') throw new Error('This fixture uses the installed macOS say voices.');

const { stdout: voices } = await execute('/usr/bin/say', ['-v', '?'], { timeout: 10000 });
const choose = (names) => names.find(name => voices.split('\n').some(line => line.startsWith(`${name} `)));
const chinese = choose(['Meijia', 'Mei-Jia', 'Eddy (Chinese (Taiwan))']);
const english = choose(['Samantha', 'Daniel']);
if (!chinese || !english) throw new Error('Installed Chinese and English voices are required; this script never downloads voices.');
await execute('ffmpeg', ['-version'], { timeout: 5000 });
const parent = path.join(root, '.meeting-mate', 'meet-rehearsal');
await mkdir(parent, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(path.join(parent, 'run-'));
const clips = {
  remote: { voice: chinese, text: '這是遠端收音測試。藍色火車準時到站。請確認錄影裡有清楚的聲音。一，二，三，四，五。遠端收音測試結束。' },
  english: { voice: english, text: 'This is a local synthetic test voice. The blue train arrives at nine thirty. Please check that both the recording and the transcript contain this sentence.' },
  before: { voice: chinese, text: '第一段開始。紅色蘋果出現在暫停之前。請保留這一句。第一段結束。' },
  pause: { voice: chinese, text: '排除標記。紫色香蕉只在暫停期間播放。這一句不應該出現在錄影或逐字稿。' },
  after: { voice: chinese, text: '續錄開始。綠色火箭出現在恢復之後。請保留這一句。續錄測試結束。' },
  silence: { text: '十秒數位靜音。' },
};
for (const [name, clip] of Object.entries(clips)) {
  const wav = path.join(directory, `${name}.wav`);
  if (clip.voice) {
    const aiff = path.join(directory, `${name}.aiff`);
    await execute('/usr/bin/say', ['-v', clip.voice, '-r', '145', '-o', aiff, clip.text], { timeout: 60000 });
    await execute('ffmpeg', ['-nostdin', '-v', 'error', '-i', aiff, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { timeout: 10000 });
  } else {
    await execute('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '10', '-c:a', 'pcm_s16le', wav], { timeout: 10000 });
  }
  clip.bytes = await readFile(wav);
}
const nonce = randomBytes(16).toString('hex');
const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meeting Mate 測試音源</title><style>
body{margin:0;background:#111c2d;color:#f1f5fc;font:18px/1.6 system-ui,sans-serif}main{max-width:960px;margin:auto;padding:32px}
h1{margin:0 0 8px;font-size:32px}p{margin:8px 0 20px}.notice{padding:12px 18px;background:#213b54;border-radius:12px}
.buttons{display:flex;flex-wrap:wrap;gap:12px}button{font:inherit;background:#b4f0dc;color:#102c2b;border:0;border-radius:8px;padding:12px 18px;cursor:pointer}button:disabled{opacity:.5}#stop{background:#ffd4c4}
#status{font-size:24px;font-weight:600;margin-top:20px}#marker{min-height:70px}.clock{font-variant-numeric:tabular-nums}audio{width:100%;margin:16px 0}
li{margin-bottom:8px}#motion{width:50px;height:12px;background:#77baff;animation:move 2s ease-in-out infinite alternate}@keyframes move{to{transform:translateX(500px)}}
</style><main><h1>Meeting Mate 測試音源</h1>
<p class="notice">這個分頁只有固定測試文字與本機合成語音。請在專用 Meet 分享此分頁並啟用分頁音訊，再開始播放。錄影機器人應在另一個瀏覽器中加入。</p>
<div id="motion"></div><p class="clock" id="clock"></p><div class="buttons">
<button data-sequence="remote">遠端中文收音</button><button data-sequence="remote,english,remote">中文 → 英文 → 中文</button>
<button data-sequence="before">暫停前標記</button><button data-sequence="pause">暫停中排除標記</button><button data-sequence="after">續錄後標記</button>
<button data-sequence="silence">十秒靜音</button><button id="stop">停止播放</button></div>
<div id="status" role="status" aria-live="polite">待命，尚未播放</div><p id="marker"></p><audio id="audio" controls preload="metadata" src="/audio/remote.wav"></audio>
<ol><li>遠端收音：錄影中應有「藍色火車」，播放完成後再停止錄影並檢查音訊。</li>
<li>暫停／續錄：先播放「紅色蘋果」，確認 API 已 paused 後播放「紫色香蕉」；恢復錄影後播放「綠色火箭」。只有紅色與綠色標記應保留。</li>
<li>中英混用：核對原句與時間；兩種合成聲音不代表兩位真人，Speaker 標籤不當作姓名。</li>
<li>靜音：應可保留可播放的影片並附警告；空白轉寫不可補出不存在的對話。</li></ol></main>
<script nonce="${nonce}">
const clips=${JSON.stringify(Object.fromEntries(Object.entries(clips).map(([name, clip]) => [name, clip.text])))};
const audio=document.getElementById('audio'),status=document.getElementById('status'),marker=document.getElementById('marker');
let run=0,complete=null;
function stop(){run++;audio.pause();complete?.();complete=null;status.textContent='已停止播放';document.querySelectorAll('[data-sequence]').forEach(button=>button.disabled=false);}
async function play(names){
 stop();const current=run;document.querySelectorAll('[data-sequence]').forEach(button=>button.disabled=true);
 try{for(const name of names){if(run!==current)return;audio.src='/audio/'+name+'.wav';marker.textContent=clips[name];
  status.textContent='播放中：'+name+'（'+new Date().toLocaleTimeString()+'）';
  const ended=new Promise(resolve=>{complete=resolve;audio.onended=resolve;audio.onerror=resolve;});
  await audio.play();await ended;if(run!==current)return;complete=null;
  if(audio.error)throw new Error('測試音訊讀取失敗');
 }if(run===current)status.textContent='播放完成（'+new Date().toLocaleTimeString()+'）';}
 catch(error){if(run===current)status.textContent='播放失敗：'+error.message;}
 finally{if(run===current){complete=null;audio.onended=null;audio.onerror=null;document.querySelectorAll('[data-sequence]').forEach(button=>button.disabled=false);}}
}
document.querySelectorAll('[data-sequence]').forEach(button=>button.onclick=()=>play(button.dataset.sequence.split(',')));
document.getElementById('stop').onclick=stop;function tick(){document.getElementById('clock').textContent=new Date().toLocaleString();}tick();setInterval(tick,1000);
</script></html>`;

const server = http.createServer((request, response) => {
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'none'; media-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'` };
  if (request.headers.host !== `127.0.0.1:${server.address().port}` || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(403, headers); response.end(); return;
  }
  const match = /^\/audio\/([a-z]+)\.wav$/.exec(request.url);
  const clip = match && Object.hasOwn(clips, match[1]) ? clips[match[1]] : null;
  const body = request.url === '/' ? Buffer.from(html) : clip?.bytes;
  if (!body) { response.writeHead(404, headers); response.end(); return; }
  response.writeHead(200, { ...headers, 'content-type': clip ? 'audio/wav' : 'text/html; charset=utf-8', 'content-length': body.length });
  response.end(request.method === 'HEAD' ? undefined : body);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
console.log(`Test page: http://127.0.0.1:${server.address().port}/`);
console.log('Share only this synthetic fixture tab with audio in your dedicated test Meet. Press Ctrl+C to stop the fixture server.');
const stop = () => { server.closeAllConnections(); server.close(); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
