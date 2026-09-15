// Run while DSH is stopped. Copies only this provider; credentials stay in place.
import { readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { COMMANDCODE_URL, validateCommandCode } from '../lib/commandcode.js';
const host = createRequire(join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/package.json'));
const yaml = host('js-yaml');
const file = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh'), 'settings.yaml');
const original = await readFile(file, 'utf8');
const doc = yaml.load(original);
const old = doc?.['llm-pi-ai']?.providers?.commandcode;
if (!old) { console.log('No legacy commandcode provider to migrate.'); process.exit(0); }
if (doc['llm-cline-pass']?.commandcode) throw new Error('Both provider configurations exist; refusing to overwrite.');
if (old.baseURL?.replace(/\/$/, '') !== COMMANDCODE_URL || old.api !== 'openai-completions' || Object.keys(old).some(k => !['api', 'baseURL', 'apiKeyEnv', 'models', 'displayName'].includes(k))) throw new Error('Legacy provider contains customized connection fields; no changes made.');
const profile = { apiKeyEnv: old.apiKeyEnv ?? 'COMMANDCODE_API_KEY', models: old.models ?? [] };
validateCommandCode(profile);
doc['llm-cline-pass'] ??= {};
doc['llm-cline-pass'].commandcode = profile;
delete doc['llm-pi-ai'].providers.commandcode;
const backup = file + '.before-commandcode-' + Date.now();
await copyFile(file, backup, 1);
const temporary = file + '.commandcode.tmp';
await writeFile(temporary, yaml.dump(doc, { lineWidth: -1, noRefs: true }));
if (await readFile(file, 'utf8') !== original) throw new Error('Settings changed concurrently; original left intact.');
await rename(temporary, file);
console.log(`Migrated commandcode with ${profile.models.length} models; credential reference preserved. Backup: ${backup}`);
