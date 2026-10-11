// Mount test against the real DSH 0.2.0-rc.2 runtime.
//
// Boots one scratch headless profile from an extracted `host-runtime`
// installation with this plugin installed as a profile entry, then asserts the
// 0.2.0 contract: the plugin activates, registers both routes, declares its
// configurable-provider directory entries under its own settings namespace,
// keeps `commandcode` dormant until configured, publishes a live settings form
// that accepts writes, and withdraws everything on disposal.
//
//   npm run test:mount
//   DSH_MOUNT_HOST_RUNTIME=C:\path\to\host-runtime node --test test/mount-0.2.test.mjs
//
// The test skips itself when no 0.2.0 runtime is present, so `npm test` stays
// green on a machine that only has the development peer dependencies.
// `DSH_MOUNT_KEEP=1` keeps the scratch DSH home for inspection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { verifyHostRetries } from './host-retry.mjs';

const PLUGIN_NAME = 'llm-cline-pass';
const repoDir = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME = [
  process.env.DSH_MOUNT_HOST_RUNTIME,
  join(repoDir, '..', 'host-runtime'),
  join(repoDir, '..', '..', 'host-runtime'),
].find(candidate => candidate && existsSync(join(candidate, 'package.json')));
const reason = `no DSH 0.2.0 runtime found; set DSH_MOUNT_HOST_RUNTIME to the extracted installation to run this mount test`;

if (RUNTIME === undefined) {
  test('plugin mounts, publishes its settings form and registers both providers on DSH 0.2.0', { skip: reason }, () => {});
} else {
  const require = createRequire(join(RUNTIME, 'package.json'));
  const [dshEntry, appBootEntry] = [
    require.resolve('@deepseek-ai/dsh/profile-boot'),
    require.resolve('@deepseek-ai/dsh-app-boot'),
  ];
  const { runProfile } = await import(pathToFileURL(dshEntry).href);
  const { PROFILE_TEMPLATES, initProfile, loadLayeredEnv } = await import(pathToFileURL(appBootEntry).href);
  const home = mkdtempSync(join(tmpdir(), 'dsh-provider-extensions-mount-'));
  // The `web` composition is the one the desktop application boots, so the
  // mount test exercises the same plugin set the user runs.
  const profile = 'web';
  const profileDir = join(home, 'profiles', profile);

  test('plugin mounts, publishes its settings form and registers both providers on DSH 0.2.0', { timeout: 180_000 }, async () => {
    const bootLog = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args) => bootLog.push(args.map(value => typeof value === 'string' ? value : String(value)).join(' '));
    let ctx;
    try {
      // The boot reads home-scoped paths from the environment; the scratch home
      // under the OS temp directory is the only thing this test touches.
      process.env.DSH_HOME = home;
      process.env.DSH_TELEMETRY_DISABLED = '1';
      // The real profile boot logs to the console; capture it so a failure can
      // report the loader's own diagnostic for the entry.
      console.log = console.warn = console.error = capture;
      initProfile(profileDir, PROFILE_TEMPLATES[profile].bundles);
      assert.ok(existsSync(join(profileDir, 'package.json')), 'the scratch profile was created');
      // Register the package as a bundle, just like the desktop installation.
      // An absolute-path insertion is not editable by the host config editor.
      mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
      symlinkSync(repoDir, join(profileDir, 'node_modules', 'dsh-provider-extensions'), 'junction');
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
      manifest.dependencies = { ...manifest.dependencies, 'dsh-provider-extensions': `file:${repoDir}` };
      manifest.dsh.profile.bundles.push('dsh-provider-extensions');
      await writeFile(join(profileDir, 'package.json'), JSON.stringify(manifest));
      // Keep auxiliary title calls from consuming the synthetic retry responses.
      await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: session-title-llm\n  disabled: true\n');
      ({ ctx } = await runProfile({
        environment: loadLayeredEnv('dsh'),
        profile,
        patchFiles: [],
        args: ['--no-open', '--port', '0'],
      }));
      console.log = original.log; console.warn = original.warn; console.error = original.error;

      assert.ok(ctx.get('llm') !== undefined, 'the real llm service is mounted');
      assert.ok(ctx.get('settings') !== undefined, 'the real settings service is mounted');
      assert.ok(ctx.get('configEditor') !== undefined, 'the real config editor is mounted');
      const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === PLUGIN_NAME);
      assert.ok(entry !== undefined, 'the profile patch installed the plugin row');
      // (i) the plugin activated with no exception. The peer gate reports a
      // refused row as `disabling profile plugin row`, not as an activation
      // error, so both spellings count as a failure.
      assert.deepEqual(bootLog.filter(line => /did not activate|not activate|disabling profile plugin row|incompatible with|TypeError|ReferenceError/.test(line)), [],
        `no entry failed to activate (log tail: ${bootLog.slice(-12).join(' | ')})`);
      assert.equal(entry.fiber?.state, 2, 'the plugin entry is active');

      // (ii) both routes start dormant until configured through the live form.
      const providers = ctx.llm.listProviders();
      assert.ok(!providers.some(provider => provider.id === 'cline-pass'), 'cline-pass dormant');
      // (iv) commandcode stays dormant while nothing configures it.
      assert.ok(!providers.some(provider => provider.id === 'commandcode'), 'commandcode dormant');

      // (iii) both directory entries address this plugin's own settings namespace.
      const directory = ctx.llm.listConfigurableProviders();
      assert.deepEqual(directory.find(row => row.provider === 'cline-pass'), {
        provider: 'cline-pass', displayName: 'cline-pass', settingsNs: PLUGIN_NAME, settingsPath: ['profile'],
      });
      assert.deepEqual(directory.find(row => row.provider === 'commandcode'), {
        provider: 'commandcode', displayName: 'commandcode', settingsNs: PLUGIN_NAME, settingsPath: ['commandcode'],
      });

      // The 0.2.0 settings contract the Models card depends on: the plugin's own
      // Config is published as a form and live writes are accepted.
      const forms = ctx.get('settings').describe();
      const form = forms.find(row => row.ns === PLUGIN_NAME);
      assert.ok(form !== undefined, `settings form published for ${PLUGIN_NAME} (got ${forms.map(row => row.ns).join(', ')})`);
      assert.equal(form.applies, 'live');
      const paths = (node, prefix = []) => Object.entries(node.dict ?? {}).flatMap(([key, child]) => [[...prefix, key], ...paths(form.schema.refs[child], [...prefix, key])]);
      assert.deepEqual(paths(form.schema.refs[form.schema.uid]).map(path => path.join('.')).sort(),
        ['apiKeyEnv', 'commandcode', 'commandcode.apiKeyEnv', 'commandcode.models', 'commandcode.timeoutMs', 'diagnostics', 'enabled', 'models', 'profile', 'profile.apiKeyEnv', 'profile.diagnostics', 'profile.enabled', 'profile.models', 'profile.routing', 'profile.timeoutMs', 'profile.upstream', 'routing', 'timeoutMs', 'upstream']);
      assert.equal(form.value.enabled, false, 'the plugin starts disabled');
      await ctx.get('settings').mutate(PLUGIN_NAME, [
        { op: 'set', path: ['profile', 'timeoutMs'], value: 45678 },
        { op: 'set', path: ['profile', 'apiKeyEnv'], value: 'CLINEPASS_API_KEY' },
      ], form.revision);
      const committed = ctx.get('settings').describe().find(row => row.ns === PLUGIN_NAME);
      assert.equal(committed.value.profile.timeoutMs, 45678, 'the live write reached the running config');
      assert.equal(entry.fiber.config.get().profile.timeoutMs, 45678, 'the loader committed the write into the running reference');
      assert.ok(ctx.llm.listProviders().some(provider => provider.id === 'cline-pass'), 'live addition registers cline-pass');
      await ctx.get('settings').mutate(PLUGIN_NAME, [
        { op: 'set', path: ['commandcode'], value: { models: [{ id: 'gpt-test' }] } },
      ], committed.revision);
      assert.ok(ctx.llm.listProviders().some(provider => provider.id === 'commandcode'), 'live addition registers commandcode');
      const added = ctx.get('settings').describe().find(row => row.ns === PLUGIN_NAME);
      await ctx.get('settings').mutate(PLUGIN_NAME, [
        { op: 'unset', path: ['profile'] }, { op: 'unset', path: ['commandcode'] },
      ], added.revision);
      assert.deepEqual(ctx.llm.listProviders().filter(provider => ['cline-pass', 'commandcode'].includes(provider.id)), [], 'live deletion withdraws both routes');

      await verifyHostRetries(ctx, require, home);

      // (v) disposal withdraws both providers and both directory entries.
      await entry.fiber.dispose();
      assert.deepEqual(ctx.llm.listProviders().filter(provider => ['cline-pass', 'commandcode'].includes(provider.id)), []);
      assert.deepEqual(ctx.llm.listConfigurableProviders().filter(row => ['cline-pass', 'commandcode'].includes(row.provider)), []);
    } catch (error) {
      process.exitCode = 1; // Host shutdown may exit before node:test reports the rejection.
      throw new Error(`${error.message}\nboot log tail:\n${bootLog.slice(-25).join('\n').replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]')}`, { cause: error });
    } finally {
      console.log = original.log; console.warn = original.warn; console.error = original.error;
      // Dispose directly: the host shutdown controller can exit the process
      // before node:test reports failed assertions. Bound lingering handles.
      await Promise.race([Promise.resolve().then(() => ctx?.fiber.dispose()), new Promise(resolve => setTimeout(resolve, 20_000))]);
      if (process.env.DSH_MOUNT_KEEP === '1') console.log(`scratch home kept at ${home}`);
      else rmSync(home, { recursive: true, force: true });
      setTimeout(() => process.exit(process.exitCode ?? 0), 5000).unref();
    }
  });
}
