import type { Context } from '@deepseek-ai/cordis';
import { LlmError, type AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import '@deepseek-ai/dsh-credentials';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import '@deepseek-ai/dsh-settings';
import { Config, PROVIDER, resolveConfig, unwrapConfig, type ConfigInput } from './config.js';
import { ClinePassAdapter, discoverCatalog } from './adapter.js';
import { CommandCodeAdapter, discoverCommandCode, validateCommandCode } from './commandcode.js';

export { Config, ClinePassAdapter };
export const name = 'llm-cline-pass';
export const inject = ['llm'];

/** DSH 0.2.0 settings service: `SettingsForms.configure(presentation, owner)`. */
interface SettingsFormsLike {
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void;
}

/**
 * Raw configuration of another plugin entry.
 *
 * DSH 0.2.0 removed the `settings.get(ns)` reader that older releases exposed;
 * per-plugin settings now live in the active profile patch, which
 * `configEditor` composes for every live entry. Reading a sibling entry stays
 * best-effort: without the editor this reports no native `llm-pi-ai` route.
 */
function nativeProfile(ctx: Context, entryId: string, key: string): unknown {
  const editor = ctx.get('configEditor') as { configuration?(): Array<{ entry: { options: { id: string } }; override: Record<string, unknown> }> } | undefined;
  if (!editor?.configuration) return undefined;
  let configuration: ReturnType<NonNullable<typeof editor.configuration>>;
  try { configuration = editor.configuration(); } catch { return undefined; }
  const row = configuration.find(candidate => candidate.entry?.options?.id === entryId);
  const section = unwrapConfig(row?.override) as Record<string, unknown> | undefined;
  return section?.[key];
}

export function apply(ctx: Context, config: ConfigInput = {}): void {
  // The plugin's own Config schema is the Models page form, and its profile
  // entry id is the settings namespace that page dispatches on.
  const settingsNs = (ctx.fiber as { entry?: { options?: { id?: string } } } | undefined)?.entry?.options?.id ?? name;
  const current = () => unwrapConfig(config);
  resolveConfig(current());
  const commandAdapter = new CommandCodeAdapter(() => current().commandcode ?? {}, async ref => {
    const key = (await ctx.get('credentials')?.resolve(credentialRef(ref)))?.value ?? launchEnvironmentOf(ctx).get(ref)?.value;
    if (!key) throw new LlmError('Configure the commandcode API key in Models.', 'MISSING_CREDENTIAL');
    return key;
  });
  const adapter = new ClinePassAdapter({
    config: () => resolveConfig(current()),
    apiKey: async resolved => {
      const credentials = ctx.get('credentials');
      const key = credentials ? (await credentials.resolve(resolved.apiKeyEnv))?.value
        : launchEnvironmentOf(ctx).get(resolved.apiKeyEnv)?.value;
      if (!key) throw new LlmError(`Configure ${resolved.apiKeyEnv} in DSH credentials or the launch environment.`, 'MISSING_CREDENTIAL');
      return key;
    },
    diagnostic: event => { if (resolveConfig(current()).diagnostics) ctx.logger.info(JSON.stringify(event)); },
  });
  // Keep a dormant directory entry for the native Provider dropdown. The
  // optional profile gives the native UI a concrete add/delete address.
  const clineEntry = { provider: PROVIDER, displayName: PROVIDER, settingsNs, settingsPath: ['profile'] };
  const commandEntry = { provider: 'commandcode', displayName: 'commandcode', settingsNs, settingsPath: ['commandcode'] };
  const directory = ctx.llm.registerConfigurableProviders([clineEntry]);
  let commandDirectory = '';
  let nativeDirectoryOwned = false;
  let registration: AdapterRegistrationHandle | undefined;
  let commandRegistration: AdapterRegistrationHandle | undefined;
  const syncRoute = () => {
    const custom = (nativeProfile(ctx, 'llm-pi-ai', 'providers') as { commandcode?: { displayName?: string } } | undefined)?.commandcode;
    const foreign = ctx.llm.listConfigurableProviders().some(entry => entry.provider === 'commandcode' && entry.settingsNs !== settingsNs) && !nativeDirectoryOwned;
    const offerCommand = !custom && !foreign;
    // A user's own `llm-pi-ai.providers.commandcode` route keeps ownership of
    // that provider; point the row at the native settings address rather than
    // shadowing it, and never register a second adapter for the route.
    const entries = custom && !foreign ? [clineEntry, { ...commandEntry, displayName: custom.displayName || 'commandcode', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'commandcode'], declared: true }]
      : offerCommand ? [clineEntry, commandEntry] : [clineEntry];
    const facts = JSON.stringify(entries);
    if (facts !== commandDirectory) {
      directory.replace(entries);
      nativeDirectoryOwned = !!custom && !foreign;
      commandDirectory = facts;
    }
    if (offerCommand && current().commandcode !== undefined) {
      validateCommandCode(current().commandcode!);
      if (commandRegistration) commandRegistration.replace(['commandcode']);
      else commandRegistration = ctx.llm.registerAdapter(['commandcode'], commandAdapter);
    } else { commandRegistration?.(); commandRegistration = undefined; }
    if (resolveConfig(current()).enabled) {
      if (registration) registration.replace([PROVIDER]);
      else registration = ctx.llm.registerAdapter([PROVIDER], adapter);
    } else {
      registration?.();
      registration = undefined;
    }
  };
  syncRoute();
  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => request.provider === 'commandcode' ? discoverCommandCode(fetch, signal) : discoverCatalog(fetch, signal));
  ctx.inject(['settings'], settingsCtx => {
    const settings = settingsCtx.settings as unknown as SettingsFormsLike;
    if (typeof settings.configure !== 'function') return;
    // `auto: false` declares that this plugin ships its own Models card instead
    // of relying on a generated page. The policy is registered as an effect so
    // a late or replaced settings service picks it up.
    settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber));
  });
}
