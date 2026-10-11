import { createHash } from 'node:crypto';
import {
  LlmAdapter, LlmError, attributionHeaders, assertUsableApiKey, resolveRetryPolicy,
  type GenerateOptions, type StreamChunk, type ContentBlock, type FinishReason,
  type TokenUsage, type LlmResolvedModelInfo, ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { BASE_URL, PROVIDER, resolveConfig, subscriptionModel, type ResolvedConfig, type ModelConfig } from './config.js';
import { buildRequest, sse, tokenUsage } from './wire.js';

export interface Diagnostic {
  routing: string; routingVerified: false; model: string; requestedUpstream?: string;
  observedUpstream?: string; elapsedMs: number; firstTokenMs?: number;
  usage?: TokenUsage; outcome: string; promptHash: string; toolsHash: string;
}
export interface AdapterDependencies {
  config: () => ResolvedConfig;
  apiKey: (config: ResolvedConfig) => Promise<string>;
  fetch?: typeof fetch;
  diagnostic?: (event: Diagnostic) => void;
}

export function parseCatalog(raw: any): ModelConfig[] {
  const list = (raw?.data ?? raw)?.clinePass;
  if (!Array.isArray(list)) throw new LlmError('Unrecognized ClinePass catalog; configure models explicitly.', 'CATALOG');
  const result: ModelConfig[] = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string' || !id.startsWith('cline-pass/')) continue;
    subscriptionModel(id);
    if (result.some(m => m.id === id)) continue;
    result.push({ id, ...(typeof item?.name === 'string' ? { name: item.name } : {}) });
  }
  if (!result.length) throw new LlmError('No subscription models in ClinePass catalog; configure models explicitly.', 'CATALOG');
  return result;
}

export async function discoverCatalog(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<ModelConfig[]> {
  const response = await fetcher(`${BASE_URL}/ai/cline/recommended-models`, {
    headers: attributionHeaders(), redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) throw new LlmError(`ClinePass catalog HTTP ${response.status}.`, 'CATALOG');
  return parseCatalog(await response.json());
}

/**
 * Structural fields of a provider error. These name the failure without ever
 * carrying prompt text, so they are safe to report on every failure.
 */
function providerErrorFields(error: unknown): string {
  if (error === null || typeof error !== 'object') return '';
  const source = error as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of ['code', 'type', 'param', 'status']) {
    const value = source[key];
    if (typeof value === 'string' && value) fields.push(`${key}=${value}`);
    else if (typeof value === 'number' && Number.isFinite(value)) fields.push(`${key}=${value}`);
  }
  return fields.join(' ');
}

/** Provider-authored free text of an error frame, when the field is a string. */
function providerErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error === null || typeof error !== 'object') return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

/**
 * One line of provider text, for a report the operator opted into with
 * `diagnostics`: key-shaped tokens removed and the length capped so a body
 * cannot flood the transcript.
 */
function redactProviderMessage(text: string): string {
  return text.replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export class ClinePassAdapter extends LlmAdapter {
  private catalog?: { at: number; models: ModelConfig[] };
  constructor(private readonly deps: AdapterDependencies) { super(); }
  override providerInfo(provider: string) { return { id: provider, name: provider }; }
  override providerRetryPolicy() {
    // No account/model switching. Partial output and malformed streams are never replayed automatically.
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT', 'SERVER_ERROR'] }, 'cline-pass');
  }
  override async listModels(provider: string) {
    const config = this.deps.config();
    let models = config.models;
    if (!models.length) {
      if (this.catalog && Date.now() - this.catalog.at < 300000) models = this.catalog.models;
      else {
        models = await discoverCatalog(this.deps.fetch ?? fetch);
        this.catalog = { at: Date.now(), models };
      }
    }
    return models.map(model => ({ provider, id: model.id, name: model.name ?? model.id, inputModalities: ['text'] as const }));
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return this.modelInfo(provider, model, this.deps.config());
  }
  private modelInfo(provider: string, model: string, config: ResolvedConfig): LlmResolvedModelInfo {
    subscriptionModel(model);
    const entry = config.models.find(m => m.id === model);
    return {
      provider, id: model, name: entry?.name ?? model, inputModalities: ['text'],
      ...(entry?.contextWindow ? { context: { contextWindow: entry.contextWindow } } : {}),
      ...(entry?.maxTokens ? { defaultMaxTokens: entry.maxTokens } : {}),
    };
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const config = resolveConfig(this.deps.config());
    return { model: this.modelInfo(provider, model, config), stream: (options: GenerateOptions) => this.run(options, config) };
  }
  override stream(options: GenerateOptions) { return this.run(options, this.deps.config()); }

  private async *run(options: GenerateOptions, config: ResolvedConfig): AsyncGenerator<StreamChunk> {
    const request = buildRequest(options, config);
    options.signal?.throwIfAborted();
    const key = assertUsableApiKey(await this.deps.apiKey(config), 'cline-pass', config.apiKeyEnv);
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(config.timeoutMs), ...(options.signal ? [options.signal] : [])]);
    const start = Date.now();
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const diagnostic: Diagnostic = {
      routing: config.routing, routingVerified: false, model: options.model,
      requestedUpstream: config.routing === 'experimental-pin' ? config.upstream : undefined,
      elapsedMs: 0, outcome: 'error', promptHash: hash(request.messages), toolsHash: hash(request.tools ?? []),
    };
    let usage: TokenUsage | undefined;
    let reason: FinishReason | undefined;
    const blocks = new Map<number, ContentBlock>();
    const toolIndexes = new Map<number, number>();
    const toolIds = new Map<number, string>();
    const details = new Map<string, Record<string, unknown>>();
    let textIndex: number | undefined, reasoningIndex: number | undefined;
    let done = false;
    try {
      const response = await (this.deps.fetch ?? fetch)(`${BASE_URL}/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { ...attributionHeaders(), Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'DSH Provider Extensions' },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        const status = response.status;
        const code = status === 401 ? 'AUTH' : status === 403 ? 'SUBSCRIPTION_REQUIRED' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST';
        const retry = response.headers.get('retry-after');
        const delay = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
        // Report the provider's structural error fields; its free text follows
        // only under `diagnostics`, redacted and capped, never the raw body.
        let report = '';
        try {
          const body = (await response.text()).slice(0, 4096);
          let parsed: unknown;
          try { parsed = JSON.parse(body); } catch { parsed = undefined; }
          const error = parsed !== null && typeof parsed === 'object' && 'error' in parsed ? (parsed as { error?: unknown }).error : parsed;
          const fields = providerErrorFields(error);
          const text = config.diagnostics ? redactProviderMessage(providerErrorText(error)) : '';
          report = [fields, text && `: ${text}`].filter(Boolean).join(' ');
        } catch {
          await response.body?.cancel().catch(() => {});
        }
        throw new LlmError(`ClinePass HTTP ${status} (${code})${report ? ` [${report}]` : ''}; response body omitted to protect credentials and prompts.`, code,
          { status, ...(Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}) });
      }
      if (!response.body) throw new LlmError('ClinePass returned no response body.', 'PROTOCOL');
      for await (const event of sse(response.body)) {
        if (event === '[DONE]') { done = true; break; }
        let raw: any;
        try { raw = JSON.parse(event); } catch { throw new LlmError('Invalid JSON in ClinePass stream.', 'PROTOCOL'); }
        if (raw.error) {
          // Name the refusal on every failure; add the provider's own words only
          // when the operator opted into diagnostics, still redacted and capped.
          const fields = providerErrorFields(raw.error);
          const text = config.diagnostics ? redactProviderMessage(providerErrorText(raw.error)) : '';
          throw new LlmError(`ClinePass reported an error within the stream${fields ? ` (${fields})` : ''}${text ? `: ${text}` : '.'}`, 'STREAM_ERROR');
        }
        if (typeof raw.provider === 'string') diagnostic.observedUpstream = raw.provider;
        const reported = tokenUsage(raw.usage);
        if (reported) usage = reported;
        const choice = raw.choices?.find((c: any) => c.index === 0) ?? raw.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (reason && (delta.content || delta.reasoning || delta.reasoning_content || delta.tool_calls?.length)) throw new LlmError('Content arrived after finish_reason.', 'PROTOCOL');
        for (const [type, value] of [['reasoning', delta.reasoning_content ?? delta.reasoning], ['text', delta.content]] as const) {
          if (value == null || value === '') continue;
          if (typeof value !== 'string') throw new LlmError('Unsupported stream content.', 'PROTOCOL');
          diagnostic.firstTokenMs ??= Date.now() - start;
          let index = type === 'text' ? textIndex : reasoningIndex;
          if (index === undefined) {
            index = blocks.size;
            if (type === 'text') textIndex = index; else reasoningIndex = index;
            blocks.set(index, { type, text: '' });
            yield { type: 'block-start', index, blockType: type };
          }
          const block = blocks.get(index) as { type: 'text' | 'reasoning'; text: string };
          block.text += value;
          yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: value };
        }
        if (Array.isArray(delta.reasoning_details)) {
          for (const detail of delta.reasoning_details) {
            if (!detail || typeof detail !== 'object') continue;
            const id = `${detail.index ?? 0}:${detail.type ?? ''}:${detail.id ?? ''}`;
            const previous = details.get(id);
            const next = { ...previous, ...detail };
            for (const field of ['text', 'data', 'summary']) {
              if (typeof previous?.[field] === 'string' && typeof detail[field] === 'string') next[field] = previous[field] + detail[field];
            }
            details.set(id, next);
          }
        }
        for (const tool of delta.tool_calls ?? []) {
          if (!Number.isSafeInteger(tool.index) || tool.index < 0) throw new LlmError('Tool call has no valid index.', 'PROTOCOL');
          let index = toolIndexes.get(tool.index);
          if (index === undefined) {
            if (typeof tool.id !== 'string' || !tool.id) throw new LlmError('First tool delta has no call ID.', 'PROTOCOL');
            if (Array.from(toolIds.values()).includes(tool.id)) throw new LlmError('Duplicate tool call ID.', 'PROTOCOL');
            index = blocks.size;
            toolIndexes.set(tool.index, index); toolIds.set(tool.index, tool.id);
            blocks.set(index, { type: 'tool-call', id: ToolCallId(tool.id), name: '', arguments: '' });
            yield { type: 'block-start', index, blockType: 'tool-call' };
          }
          const block = blocks.get(index) as Extract<ContentBlock, { type: 'tool-call' }>;
          if (tool.id && tool.id !== block.id) throw new LlmError('Tool call ID changed in stream.', 'PROTOCOL');
          const name = tool.function?.name ?? '';
          const args = tool.function?.arguments ?? '';
          if (typeof name !== 'string' || typeof args !== 'string') throw new LlmError('Invalid tool delta.', 'PROTOCOL');
          block.name += name; block.arguments += args;
          diagnostic.firstTokenMs ??= Date.now() - start;
          yield { type: 'tool-call-delta', index, id: block.id, ...(name ? { name: block.name } : {}), argumentsDelta: args };
        }
        if (choice.finish_reason != null) {
          const reasons: Record<string, FinishReason> = { stop: { kind: 'stop' }, tool_calls: { kind: 'tool-calls' }, length: { kind: 'max-tokens' } };
          reason = reasons[choice.finish_reason];
          if (!reason) throw new LlmError('ClinePass returned an unsuccessful or unknown finish reason.', 'STREAM_ERROR');
        }
      }
      if (!done || !reason) throw new LlmError('ClinePass stream ended before its terminal markers.', 'INCOMPLETE_STREAM');
      if (!blocks.size) throw new LlmError('ClinePass returned an empty response.', 'EMPTY_RESPONSE');
      for (const [index, block] of blocks) {
        if (block.type === 'tool-call' && !block.name) throw new LlmError('Tool call has no function name.', 'PROTOCOL');
        yield { type: 'block-end', index, block };
      }
      if (usage) yield { type: 'usage', usage };
      diagnostic.outcome = reason.kind;
      // DSH records every chunk through a lossless-JSON check: an object key
      // holding `undefined` fails it, so the replay envelope omits the key
      // instead of setting it when the response carried no reasoning details.
      yield {
        type: 'finish', reason,
        replayState: {
          response: {
            format: 'cline-pass-v1',
            ...(details.size ? { reasoningDetails: [...details.values()] } : {}),
          },
        },
      };
    } catch (error) {
      if (signal.aborted) throw new LlmError('ClinePass request cancelled or timed out.', options.signal?.aborted ? 'ABORTED' : 'TIMEOUT');
      if (error instanceof LlmError) throw error;
      throw new LlmError('ClinePass transport failed; sensitive error details omitted.', 'TRANSPORT');
    } finally {
      abort.abort();
      diagnostic.elapsedMs = Date.now() - start; diagnostic.usage = usage;
      try { this.deps.diagnostic?.(diagnostic); } catch { /* Diagnostics cannot fail a model call. */ }
    }
  }
}
