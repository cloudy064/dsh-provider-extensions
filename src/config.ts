import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type { CommandCodeConfig } from './commandcode.js';

export interface ModelConfig { id: string; name?: string; contextWindow?: number; maxTokens?: number }
export interface ProfileConfig {
  enabled?: boolean;
  apiKeyEnv?: string;
  models?: ModelConfig[];
  routing?: 'default' | 'sticky' | 'experimental-pin';
  upstream?: string;
  timeoutMs?: number;
  diagnostics?: boolean;
}
export interface Config extends ProfileConfig {
  commandcode?: CommandCodeConfig;
  profile?: ProfileConfig;
}
/**
 * A plugin configuration as the running loader hands it over. From DSH 0.2.0
 * a schema node marked `.volatile()` parses into a mutable reference rather
 * than a plain object, so every reader unwraps first.
 */
export type ConfigInput = Config | Volatile<Config>;

/** The mutable config reference `@deepseek-ai/schemastery` creates for a volatile schema node. */
export interface Volatile<T> { get(): T }

export function isVolatile(value: unknown): value is Volatile<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Volatile<unknown>).get === 'function';
}

/** Read the plain configuration object out of a possibly-volatile configuration. */
export function unwrapConfig(value: ConfigInput | undefined): Config {
  if (value === undefined) return {};
  return (isVolatile(value) ? value.get() : value) as Config;
}
const Profile = z.object({
  enabled: z.boolean().default(false),
  apiKeyEnv: z.string().role('credential-ref').default('CLINEPASS_API_KEY'),
  models: z.array(z.object({
    id: z.string().required(), name: z.string(),
    contextWindow: z.number().min(1), maxTokens: z.number().min(1),
  })).default([]).description('Optional subscription model overrides; IDs must begin with cline-pass/.'),
  routing: z.union(['default', 'sticky', 'experimental-pin']).default('sticky')
    .description('ClinePass routing hints are unverified. experimental-pin sends a single-provider allowlist.'),
  upstream: z.string().description('Exact upstream slug for experimental-pin; never a model ID.'),
  timeoutMs: z.number().min(1000).max(1800000).default(300000),
  diagnostics: z.boolean().default(false).description('Show redacted provider error text; structured request summaries are always logged locally.'),
});
// Object schemas default to {}, which would make a dormant provider configured.
delete Profile.meta.default;
const CommandProfile = z.object({ apiKeyEnv: z.string().role('credential-ref').default('COMMANDCODE_API_KEY'), models: Profile.dict!.models, timeoutMs: Profile.dict!.timeoutMs });
delete CommandProfile.meta.default;
// The volatile root is what puts this plugin's own schema on the 0.2.0 Models
// page: `SettingsForms` derives an editable form from the volatile nodes of a
// live entry's Config and refuses writes outside them, and the loader commits
// a volatile-only change into the running reference instead of remounting.
// `extra('volatile', true)` is the metadata used by `Schema#volatile()`.
export const Config = (z.object({ ...Profile.dict, profile: Profile, commandcode: CommandProfile }) as unknown as { extra(key: string, value: boolean): z<Config> }).extra('volatile', true);
export const PROVIDER = 'cline-pass';
export const BASE_URL = 'https://api.cline.bot/api/v1';
export function subscriptionModel(id: string): string {
  if (!/^cline-pass\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id)) {
    throw new Error('Only cline-pass/ subscription model IDs are accepted.');
  }
  return id;
}
export function resolveConfig(value: ConfigInput = {}) {
  let input = unwrapConfig(value);
  if (input.profile !== undefined) input = { ...input.profile, enabled: true };
  const config = {
    enabled: input.enabled ?? false,
    apiKeyEnv: credentialRef(input.apiKeyEnv ?? 'CLINEPASS_API_KEY'),
    models: structuredClone(input.models ?? []), routing: input.routing ?? 'sticky',
    upstream: input.upstream?.trim(), timeoutMs: input.timeoutMs ?? 300000,
    diagnostics: input.diagnostics ?? false,
  };
  if (!['default', 'sticky', 'experimental-pin'].includes(config.routing)) throw new Error('Invalid routing mode.');
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 1800000) throw new Error('Invalid timeoutMs.');
  if (config.routing === 'experimental-pin' && !config.upstream) throw new Error('experimental-pin requires an upstream slug.');
  for (const model of config.models) {
    subscriptionModel(model.id);
    for (const value of [model.contextWindow, model.maxTokens]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('Model limits must be positive integers.');
    }
  }
  return config;
}
export type ResolvedConfig = ReturnType<typeof resolveConfig>;
