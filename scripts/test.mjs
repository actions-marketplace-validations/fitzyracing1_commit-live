// node --test takes no globs on Node 18/20, and npm runs scripts in cmd.exe on Windows, so list files here.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const files = readdirSync('test')
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join('test', f));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
