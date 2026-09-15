import type { Context } from '@deepseek-ai/cordis';
import { LlmError, type AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import '@deepseek-ai/dsh-credentials';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import '@deepseek-ai/dsh-settings';
import { Config, PROVIDER, resolveConfig } from './config.js';
import { ClinePassAdapter, discoverCatalog } from './adapter.js';
import { CommandCodeAdapter, discoverCommandCode, validateCommandCode } from './commandcode.js';

export { Config, ClinePassAdapter };
export const name = 'llm-cline-pass';
export const inject = ['llm'];
export function apply(ctx: Context, config: Config = {}): void {
  resolveConfig(config);
  let current = () => config;
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
  const clineEntry = { provider: PROVIDER, displayName: PROVIDER, settingsNs: name, settingsPath: ['profile'] };
  const commandEntry = { provider: 'commandcode', displayName: 'commandcode', settingsNs: name, settingsPath: ['commandcode'] };
  const directory = ctx.llm.registerConfigurableProviders([clineEntry]);
  let commandDirectory = '';
  let nativeDirectoryOwned = false;
  let registration: AdapterRegistrationHandle | undefined;
  let commandRegistration: AdapterRegistrationHandle | undefined;
  const syncRoute = () => {
    const native = ctx.get('settings')?.get('llm-pi-ai') as { providers?: Record<string, { displayName?: string }> } | undefined;
    const custom = native?.providers?.commandcode;
    const foreign = ctx.llm.listConfigurableProviders().some(entry => entry.provider === 'commandcode' && entry.settingsNs !== name) && !nativeDirectoryOwned;
    const offerCommand = !custom && !foreign;
    // Older hosts do not put custom routes in the directory. Point their row
    // back to the native settings address instead of shadowing it with ours.
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
  ctx.llm.registerModelDiscovery(name, (request, signal) => request.provider === 'commandcode' ? discoverCommandCode(fetch, signal) : discoverCatalog(fetch, signal));
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.on('settings/updated', ns => { if (ns === 'llm-pi-ai') syncRoute(); });
    settingsCtx.settings.installSection(ctx, name, Config, config, {
      setSource: source => { current = source; },
      onChange: syncRoute,
      validate: value => { resolveConfig(value); if (value.commandcode) validateCommandCode(value.commandcode); },
    });
    syncRoute();
  });
}
