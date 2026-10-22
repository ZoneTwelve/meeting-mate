import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { Browser } from '../src/browser.mjs';

const config = await loadConfig();
await mkdir(path.dirname(config.cameraFile), { recursive: true });
const font = '/System/Library/Fonts/Supplemental/Arial.ttf';
const filters = [
  'drawbox=x=0:y=0:w=iw:h=8:color=0xe84747:t=fill',
  'drawbox=x=30:y=32:w=14:h=14:color=0xe84747:t=fill',
  `drawtext=fontfile=${font}:text=MEETING MATE:fontcolor=0xa7b3ce:fontsize=18:x=56:y=30`,
  `drawtext=fontfile=${font}:text=RECORDING:fontcolor=white:fontsize=66:x=(w-text_w)/2:y=125`,
  `drawtext=fontfile=${font}:text=This meeting is being recorded:fontcolor=0xa7b3ce:fontsize=22:x=(w-text_w)/2:y=222`,
  `drawtext=fontfile=${font}:text=Local audio and video recording:fontcolor=0x6c7990:fontsize=16:x=(w-text_w)/2:y=310`,
].join(',');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x111827:s=640x360:r=30',
  '-vf', filters, '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', config.cameraFile], { stdio: 'inherit', timeout: 15000 });
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
  '-t', '1', '-c:a', 'pcm_s16le', config.cameraAudioFile], { stdio: 'inherit', timeout: 15000 });
const browser = new Browser(config);
try { await browser.ensure({ restartForCamera: true }); console.log('Local RECORDING camera ready'); }
finally { browser.disconnect(); }
