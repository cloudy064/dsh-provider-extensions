import { LlmAdapter, LlmError, resolveRetryPolicy, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import type { ModelConfig } from './config.js';

export const COMMANDCODE_URL = 'https://api.commandcode.ai/provider/v1';
export interface CommandCodeConfig { apiKeyEnv?: string; models?: ModelConfig[]; timeoutMs?: number }
export function commandProtocol(id: string) { return /^(?:anthropic\/)?claude-/i.test(id) ? 'anthropic-messages' : 'openai-completions'; }
export function validateCommandCode(config: CommandCodeConfig) {
  credentialRef(config.apiKeyEnv ?? 'COMMANDCODE_API_KEY');
  if (!Number.isSafeInteger(config.timeoutMs ?? 300000) || (config.timeoutMs ?? 300000) < 1000 || (config.timeoutMs ?? 300000) > 1800000) throw new Error('Invalid commandcode timeout.');
  const ids = new Set<string>();
  for (const m of config.models ?? []) {
    if (!m.id?.trim() || ids.has(m.id)) throw new Error('Invalid or duplicate commandcode model ID.');
    ids.add(m.id);
    for (const v of [m.contextWindow, m.maxTokens]) if (v !== undefined && (!Number.isSafeInteger(v) || v <= 0)) throw new Error('Invalid commandcode model capacity.');
  }
}
export function parseCommandCatalog(raw: any): ModelConfig[] {
  if (!Array.isArray(raw?.data)) throw new LlmError('Invalid commandcode model catalog.', 'CATALOG');
  const models: ModelConfig[] = [];
  for (const row of raw.data) {
    if (typeof row?.id !== 'string' || !row.id.trim() || models.some(m => m.id === row.id)) continue;
    const contextWindow = row.context_length ?? row.contextWindow;
    models.push({ id: row.id, ...(typeof row.name === 'string' ? { name: row.name } : {}), ...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}) });
  }
  if (!models.length) throw new LlmError('Empty commandcode model catalog.', 'CATALOG');
  return models;
}
export async function discoverCommandCode(fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  const response = await fetcher(`${COMMANDCODE_URL}/models`, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) });
  if (!response.ok) throw new LlmError(`commandcode catalog HTTP ${response.status}.`, 'CATALOG');
  return parseCommandCatalog(await response.json());
}
export class CommandCodeAdapter extends LlmAdapter {
  private catalog?: { at: number; models: ModelConfig[] };
  constructor(private readonly config: () => CommandCodeConfig, private readonly key: (ref: string) => Promise<string>, private readonly endpoint = COMMANDCODE_URL) { super(); }
  override providerInfo() { return { id: 'commandcode', name: 'commandcode' }; }
  override providerRetryPolicy() { return resolveRetryPolicy({ maxRetries: 2, mode: 'normal', retryableCodes: ['RATE_LIMIT', 'SERVER_ERROR'] }, 'commandcode'); }
  private async resolved(signal?: AbortSignal) {
    const config = structuredClone(this.config());
    validateCommandCode(config);
    let models = config.models ?? [];
    if (!models.length) {
      if (!this.catalog || Date.now() - this.catalog.at > 300000) this.catalog = { at: Date.now(), models: await discoverCommandCode(fetch, signal) };
      models = this.catalog.models;
    }
    const piProvider = createProvider({ id: 'commandcode', name: 'commandcode', baseUrl: this.endpoint,
      auth: { apiKey: { name: 'commandcode', resolve: async ({ credential }) => ({ auth: credential?.key ? { apiKey: credential.key } : {}, source: 'DSH credentials' }) } },
      api: { 'openai-completions': openAICompletionsApi(), 'anthropic-messages': anthropicMessagesApi() },
      models: models.map(m => ({ id: m.id, name: m.name ?? m.id, provider: 'commandcode', api: commandProtocol(m.id), baseUrl: commandProtocol(m.id) === 'anthropic-messages' ? this.endpoint.replace(/\/v1\/?$/, '') : this.endpoint, input: ['text'], reasoning: false,
        contextWindow: m.contextWindow ?? 200000, maxTokens: m.maxTokens ?? 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    });
    const profile: ResolvedPiAiProviderProfile = { provider: 'commandcode', displayName: 'commandcode', apiKeyEnv: credentialRef(config.apiKeyEnv ?? 'COMMANDCODE_API_KEY'),
      streamIdleTimeoutMs: config.timeoutMs ?? 300000, maxRequestImageBytes: 20971520, requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576,
      retryPolicy: this.providerRetryPolicy(), piProvider, modelErrors: new Map(), configuredMaxTokens: new Map(models.filter(m => m.maxTokens).map(m => [m.id, m.maxTokens!])) };
    const profiles = new Map([['commandcode', profile]]);
    return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => this.key(profile.apiKeyEnv!),
      // No ambient/OAuth credentials: the explicit DSH reference is required.
      auth: { credentials: { list: async () => [], delete: async () => {}, read: async () => undefined, modify: async () => { throw new Error('Use DSH credentials.'); } }, authContext: { env: async () => undefined, fileExists: async () => false } } });
  }
  override async listModels(provider: string) { return (await this.resolved()).listModels(provider); }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) { return (await this.resolved(signal)).resolveModel(provider, model, signal); }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) { return (await this.resolved(signal)).prepareCall(provider, model, signal); }
  override async *stream(options: GenerateOptions) { yield* (await this.resolved(options.signal)).stream(options); }
}
