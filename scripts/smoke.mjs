import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import * as plugin from '../lib/index.js';

// Load the user's actual npm-installed host without booting/modifying their profile.
const hostPath = process.argv[2] ?? (process.env.APPDATA ? join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh') : undefined);
if (!hostPath) throw new Error('Pass the installed @deepseek-ai/dsh directory as the first argument.');
const host = createRequire(join(resolve(hostPath), 'package.json'));
const { Context } = await import(pathToFileURL(host.resolve('@deepseek-ai/cordis')).href);
const { default: LlmRuntime } = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-llm')).href);
const { composeEntries } = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-app-boot')).href);
const { load } = host('js-yaml');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const patches = load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
const rows = composeEntries([patches], message => { throw new Error(message); });
if (rows.length !== 1 || rows[0].name !== manifest.name) throw new Error('Invalid plugin bundle patch.');
const ctx = new Context();
try {
  await ctx.plugin(LlmRuntime).await();
  const fiber = ctx.plugin(plugin, { enabled: true, models: [{ id: 'cline-pass/test' }], apiKeyEnv: 'DSH_CLINEPASS_SMOKE_MISSING_KEY', commandcode: { models: [{ id: 'claude-test' }, { id: 'gpt-test' }] } });
  await fiber.await();
  const providers = await ctx.llm.listProviders();
  if (!providers.some(p => p.id === 'cline-pass')) throw new Error('Provider not registered.');
  const models = await ctx.llm.listModels('cline-pass');
  if (models[0]?.id !== 'cline-pass/test') throw new Error('Model list not registered.');
  if ((await ctx.llm.listModels('commandcode')).length !== 2) throw new Error('commandcode models not registered.');
  await fiber.dispose();
  if ((await ctx.llm.listProviders()).some(p => p.id === 'cline-pass')) throw new Error('Provider not removed on unload.');
  if ((await ctx.llm.listProviders()).some(p => p.id === 'commandcode')) throw new Error('commandcode not removed on unload.');
  console.log('PASS: installed DSH host accepts bundle patch, mounts adapter, lists model and unloads cleanly. No network or profile writes.');
} finally { await ctx.fiber.dispose(); }
