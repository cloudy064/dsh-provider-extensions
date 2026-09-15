import { copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
execFileSync(process.execPath, ['--check', fileURLToPath(new URL('../src/client.js', import.meta.url))]);
await copyFile(new URL('../src/client.js', import.meta.url), new URL('../lib/client.js', import.meta.url));
