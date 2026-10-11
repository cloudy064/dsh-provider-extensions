import { createHash, randomUUID } from 'node:crypto';
import {
  LlmAdapter, LlmError, attributionHeaders, assertUsableApiKey, resolveRetryPolicy,
  type GenerateOptions, type StreamChunk, type ContentBlock, type FinishReason,
  type TokenUsage, type LlmResolvedModelInfo, ToolCallId, ProviderRequestId,
} from '@deepseek-ai/dsh-llm';
import { BASE_URL, PROVIDER, resolveConfig, subscriptionModel, type ResolvedConfig, type ModelConfig } from './config.js';
import { buildRequest, sse, tokenUsage } from './wire.js';

export interface Diagnostic {
  attemptId: string; sessionHash?: string; timestamp: string;
  routing: string; routingVerified: false; model: string; requestedUpstream?: string;
  observedUpstream?: string; elapsedMs: number; firstTokenMs?: number;
  usage?: TokenUsage; outcome: string; promptHash: string; toolsHash: string;
  requestId?: string; httpStatus?: number;
  providerError?: { code?: string; reason: string; messageHash?: string; upstream?: { code?: string; reason: string; messageHash?: string } };
  failure?: { stage: string; errorType: string; causeCode?: string; receivedOutput: boolean; code?: string; retryable?: boolean };
}
const RETRYABLE_CODES = ['RATE_LIMIT', 'SERVER_ERROR', 'TIMEOUT', 'TRANSPORT', 'INCOMPLETE_STREAM'];

/** Only known status/error identifiers can affect retry decisions. */
function streamErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'STREAM_ERROR';
  const value = error as Record<string, unknown>;
  const code = String(value.code ?? value.status ?? '').toLowerCase();
  if (code === '429' || code === 'rate_limit' || code === 'rate_limit_exceeded') return 'RATE_LIMIT';
  if (/^5\d\d$/.test(code) || ['server_error', 'internal_server_error', 'service_unavailable', 'bad_gateway'].includes(code)) return 'SERVER_ERROR';
  return 'STREAM_ERROR';
}

/** Summarize provider free text without copying possible prompt/credential echoes. */
function providerDiagnostic(error: unknown, nested = false): NonNullable<Diagnostic['providerError']> {
  const raw = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = String(raw.code ?? raw.status ?? '');
  const known = /^(?:[45]\d\d|rate_limit|rate_limit_exceeded|server_error|internal_server_error|service_unavailable|bad_gateway|context_length_exceeded|content_filter|stream_initialization_failed)$/;
  const message = providerErrorText(error);
  const reasons: [RegExp, string][] = [
    [/context.{0,20}(length|limit)|too many tokens/i, 'context_limit'],
    [/rate.?limit|too many requests/i, 'rate_limit'],
    [/overload|capacity/i, 'overloaded'], [/timed? ?out|timeout/i, 'upstream_timeout'],
    [/unavailable|no available provider/i, 'unavailable'],
    [/invalid.*(key|token)|unauthoriz/i, 'authentication'],
    [/quota|credit|balance/i, 'quota'], [/tool_call_id/i, 'tool_call_id'],
    [/internal server|internal error/i, 'internal_server_error'],
    [/upstream|provider returned error/i, 'upstream_error'],
  ];
  let upstream: Diagnostic['providerError'];
  // Some gateways embed the upstream JSON error as metadata.raw. Never retain it verbatim.
  if (!nested && raw.metadata && typeof raw.metadata === 'object') {
    const source = (raw.metadata as Record<string, unknown>).raw;
    if (typeof source === 'string' && source.length <= 4096) {
      try { const parsed = JSON.parse(source); upstream = providerDiagnostic(parsed?.error ?? parsed, true); } catch { /* Not JSON. */ }
    }
  }
  return { ...(known.test(code) ? { code } : {}), reason: reasons.find(([pattern]) => pattern.test(message))?.[1] ?? 'unspecified',
    ...(upstream ? { upstream } : {}),
    ...(message ? { messageHash: createHash('sha256').update(message).digest('hex') } : {}) };
}

function safeRequestId(value: string | null, key: string): string | undefined {
  return value && value !== key && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}
// Never copy exception messages, URLs, headers, stacks, or arbitrary custom codes.
function safeException(error: unknown): { errorType: string; causeCode?: string } {
  const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError']);
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
    'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT']);
  let errorType = 'UnknownError', causeCode: string | undefined;
  try {
    let current = error as any;
    if (names.has(current?.name)) errorType = current.name;
    for (let depth = 0; current && depth < 4; depth++, current = current.cause) {
      if (codes.has(current.code)) { causeCode = current.code; break; }
    }
  } catch { /* An exception can contain unsafe getters. */ }
  return { errorType, ...(causeCode ? { causeCode } : {}) };
}
export interface AdapterDependencies {
  config: () => ResolvedConfig;
  apiKey: (config: ResolvedConfig) => Promise<string>;
  fetch?: typeof fetch;
  diagnostic?: (event: Diagnostic) => void | Promise<void>;
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
    if (typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(value)) fields.push(`${key}=${value}`);
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

/** One message for either documented in-stream refusal shape. */
function streamRefusal(error: unknown, diagnostics: boolean): string {
  const fields = providerErrorFields(error);
  const text = diagnostics ? redactProviderMessage(providerErrorText(error)) : '';
  return `ClinePass reported an error within the stream${fields ? ` (${fields})` : ''}${text ? `: ${text}` : '.'}`;
}

export class ClinePassAdapter extends LlmAdapter {
  private catalog?: { at: number; models: ModelConfig[] };
  constructor(private readonly deps: AdapterDependencies) { super(); }
  override providerInfo(provider: string) { return { id: provider, name: provider }; }
  override providerRetryPolicy() {
    // The host settles failed attempts separately and only executes successful tool calls.
    // Do not retry inside this generator: that would concatenate partial responses.
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 2, retryableCodes: RETRYABLE_CODES,
      backoff: { initialDelayMs: 1000, maxDelayMs: 10000, jitterRatio: 0.1 } }, 'cline-pass');
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
      attemptId: randomUUID(), timestamp: new Date().toISOString(),
      ...(options.sessionId ? { sessionHash: hash(options.sessionId) } : {}),
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
    let stage = 'request';
    try {
      const response = await (this.deps.fetch ?? fetch)(`${BASE_URL}/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { ...attributionHeaders(), Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'DSH Provider Extensions' },
        body: JSON.stringify(request),
      });
      diagnostic.httpStatus = response.status;
      const requestId = safeRequestId(response.headers.get('x-request-id') ?? response.headers.get('request-id'), key);
      if (requestId) diagnostic.requestId = requestId;
      if (!response.ok) {
        stage = 'http-error-body';
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
          diagnostic.providerError = providerDiagnostic(error);
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
      stage = 'stream-read';
      for await (const event of sse(response.body)) {
        stage = 'stream-decode';
        if (event === '[DONE]') { done = true; break; }
        let raw: any;
        try { raw = JSON.parse(event); } catch { throw new LlmError('Invalid JSON in ClinePass stream.', 'PROTOCOL'); }
        if (raw.error) {
          diagnostic.providerError = providerDiagnostic(raw.error);
          throw new LlmError(streamRefusal(raw.error, config.diagnostics), streamErrorCode(raw.error));
        }
        if (typeof raw.provider === 'string' && safeRequestId(raw.provider, key)) diagnostic.observedUpstream = raw.provider;
        const reported = tokenUsage(raw.usage);
        if (reported) usage = reported;
        const choice = raw.choices?.find((c: any) => c.index === 0) ?? raw.choices?.[0];
        if (!choice) { stage = 'stream-read'; continue; }
        // The API documents mid-stream failures as `choices[0].error` next to
        // `finish_reason: 'error'`, so name that refusal like the top-level one
        // instead of reporting an unknown finish reason.
        if (choice.error) {
          diagnostic.providerError = providerDiagnostic(choice.error);
          throw new LlmError(streamRefusal(choice.error, config.diagnostics), streamErrorCode(choice.error));
        }
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
          if (!reason) throw new LlmError(`ClinePass returned an unsuccessful or unknown finish reason (${String(choice.finish_reason)}).`, 'STREAM_ERROR');
        }
        stage = 'stream-read';
      }
      stage = 'stream-finalize';
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
      diagnostic.outcome = 'error';
      diagnostic.failure = { stage, ...safeException(error), receivedOutput: blocks.size > 0 };
      const context = `stage=${stage} type=${diagnostic.failure.errorType}${diagnostic.failure.causeCode ? ` cause=${diagnostic.failure.causeCode}` : ''} elapsedMs=${Date.now() - start} receivedOutput=${blocks.size > 0}`;
      const transport = stage === 'request' || stage === 'stream-read' || stage === 'http-error-body';
      const failure = signal.aborted
        ? new LlmError(`ClinePass request cancelled or timed out (${context}).`, options.signal?.aborted ? 'ABORTED' : 'TIMEOUT')
        : error instanceof LlmError ? error
        : new LlmError(`ClinePass ${transport ? 'transport' : 'stream processing'} failed (${context}); sensitive error details omitted.`, transport ? 'TRANSPORT' : 'ADAPTER_ERROR');
      diagnostic.failure.code = failure.code;
      diagnostic.failure.retryable = RETRYABLE_CODES.includes(failure.code);
      // This context survives in the host's durable llm/retry and turn/end records.
      const safeMessage = failure.message.split(key).join('[redacted]');
      throw new LlmError(`${safeMessage} [attempt=${diagnostic.attemptId}${diagnostic.requestId ? ` requestId=${diagnostic.requestId}` : ''} stage=${stage} receivedOutput=${blocks.size > 0}]`, failure.code,
        { ...failure.failure, ...(diagnostic.requestId ? { requestId: ProviderRequestId(diagnostic.requestId) } : {}) });
    } finally {
      abort.abort();
      diagnostic.elapsedMs = Date.now() - start; diagnostic.usage = usage;
      try { await this.deps.diagnostic?.(diagnostic); } catch { /* Diagnostics cannot fail a model call. */ }
    }
  }
}
