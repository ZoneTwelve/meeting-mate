import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root } from '../src/config.mjs';

let count = 0;
for (const directory of ['bin', 'src', 'scripts', 'test']) {
  for (const name of await readdir(path.join(root, directory)).catch(() => [])) {
    if (!name.endsWith('.mjs')) continue;
    execFileSync(process.execPath, ['--check', path.join(root, directory, name)], { stdio: 'inherit' });
    count++;
  }
}
execFileSync('/bin/sh', ['-n', path.join(root, 'scripts', 'install-launchd.sh')], { stdio: 'inherit' });
console.log(`Syntax checked ${count} JavaScript files and the shell wrapper.`);
