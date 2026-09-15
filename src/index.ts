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
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: PROVIDER, settingsNs: name, settingsPath: ['profile'] }, { provider: 'commandcode', displayName: 'commandcode', settingsNs: name, settingsPath: ['commandcode'] }]);
  let registration: AdapterRegistrationHandle | undefined;
  let commandRegistration: AdapterRegistrationHandle | undefined;
  const syncRoute = () => {
    if (current().commandcode !== undefined) {
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
    settingsCtx.settings.installSection(ctx, name, Config, config, {
      setSource: source => { current = source; },
      onChange: syncRoute,
      validate: value => { resolveConfig(value); if (value.commandcode) validateCommandCode(value.commandcode); },
    });
  });
}
