import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type { CommandCodeConfig } from './commandcode.js';

export interface ModelConfig { id: string; name?: string; contextWindow?: number; maxTokens?: number }
export interface Config {
  commandcode?: CommandCodeConfig;
  profile?: Omit<Config, 'profile'>;
  enabled?: boolean;
  apiKeyEnv?: string;
  models?: ModelConfig[];
  routing?: 'default' | 'sticky' | 'experimental-pin';
  upstream?: string;
  timeoutMs?: number;
  diagnostics?: boolean;
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
  diagnostics: z.boolean().default(false).description('Log token counts and timing; never prompts or keys.'),
});
// Object schemas default to {}, which would make a dormant provider configured.
delete Profile.meta.default;
const CommandProfile = z.object({ apiKeyEnv: z.string().role('credential-ref').default('COMMANDCODE_API_KEY'), models: Profile.dict!.models, timeoutMs: Profile.dict!.timeoutMs });
delete CommandProfile.meta.default;
export const Config: z<Config> = z.object({ ...Profile.dict, profile: Profile, commandcode: CommandProfile });
export const PROVIDER = 'cline-pass';
export const BASE_URL = 'https://api.cline.bot/api/v1';
export function subscriptionModel(id: string): string {
  if (!/^cline-pass\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id)) {
    throw new Error('Only cline-pass/ subscription model IDs are accepted.');
  }
  return id;
}
export function resolveConfig(input: Config = {}) {
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
