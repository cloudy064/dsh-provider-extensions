import { createHash } from 'node:crypto';
import { LlmError, type ContentBlock, type GenerateOptions, type TokenUsage } from '@deepseek-ai/dsh-llm';
import { subscriptionModel, type ResolvedConfig } from './config.js';

function text(blocks: ContentBlock[]): string {
  return blocks.map(block => {
    if (block.type === 'text') return block.text;
    throw new LlmError('Unsupported content block; this adapter currently accepts text and tool calls only.', 'UNSUPPORTED_CONTENT');
  }).join('');
}

export function buildRequest(options: GenerateOptions, config: ResolvedConfig): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system });
  for (const message of options.messages) {
    // DSH 0.2 stores tool results as messages with a top-level toolCallId.
    // Preserve the association when replaying them after an assistant tool call.
    const toolMessage = message as unknown as { role: string; toolCallId?: string };
    if (toolMessage.role === 'tool') {
      if (!toolMessage.toolCallId) throw new LlmError('Tool result is missing toolCallId.', 'UNSUPPORTED_CONTENT');
      messages.push({ role: 'tool', tool_call_id: toolMessage.toolCallId, content: text(message.content) });
      continue;
    }
    const results = message.content.filter(b => b.type === 'tool-result');
    if (results.length) {
      if (results.length !== message.content.length) throw new LlmError('Mixed tool-result and text message is unsupported.', 'UNSUPPORTED_CONTENT');
      for (const result of results) messages.push({ role: 'tool', tool_call_id: result.toolCallId, content: text(result.content) });
      continue;
    }
    if (message.role !== 'assistant') {
      messages.push({ role: message.role, content: text(message.content) });
      continue;
    }
    const calls = message.content.filter(b => b.type === 'tool-call');
    const reasoning = message.content.filter(b => b.type === 'reasoning').map(b => b.text).join('');
    const content = text(message.content.filter(b => b.type !== 'tool-call' && b.type !== 'reasoning'));
    const wire: Record<string, unknown> = { role: 'assistant', content: content || null };
    if (calls.length) wire.tool_calls = calls.map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }));
    if (reasoning) wire.reasoning_content = reasoning;
    const envelope = message.source.kind === 'model' && message.source.provider === options.provider
      && message.source.model === options.model ? message.source.replayState as any : undefined;
    const replay = envelope?.response;
    if (replay?.format === 'cline-pass-v1' && replay.reasoningDetails) wire.reasoning_details = replay.reasoningDetails;
    messages.push(wire);
  }
  // Only parameters the Cline API documents are sent. Undocumented extras are
  // relayed to the upstream provider, which answers with a mid-stream error
  // frame that reads as an opaque failure; `stream_options` is unnecessary
  // because the final chunk carries usage, and the API documents no
  // reasoning-effort parameter at all.
  const body: Record<string, unknown> = {
    model: subscriptionModel(options.model), messages, stream: true,
  };
  if (options.tools?.length) body.tools = options.tools.map(tool => ({ type: 'function', function: tool }));
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.stop !== undefined) body.stop = options.stop;
  if (config.routing !== 'default' && options.sessionId) {
    // Stable, bounded identity; auxiliary calls use a separate route from conversation turns.
    body.session_id = 'dsh-' + createHash('sha256').update(`${options.sessionId}:${options.purpose ?? 'conversation'}`).digest('hex');
  }
  if (config.routing === 'experimental-pin') body.provider = { only: [config.upstream], allow_fallbacks: false };
  return body;
}

function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
export function tokenUsage(raw: any): TokenUsage | undefined {
  if (!raw || !count(raw.prompt_tokens) || !count(raw.completion_tokens)) return;
  const cached = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens;
  const validCache = count(cached) && cached <= raw.prompt_tokens;
  return {
    inputTokens: raw.prompt_tokens - (validCache ? cached : 0), outputTokens: raw.completion_tokens,
    totalTokens: raw.prompt_tokens + raw.completion_tokens,
    ...(validCache ? { cacheReadTokens: cached } : {}),
    ...(count(raw.completion_tokens_details?.reasoning_tokens) ? { reasoningTokens: raw.completion_tokens_details.reasoning_tokens } : {}),
  };
}

/** Incremental SSE parser: handles fragmented UTF-8, CR/LF, comments and multiline data. */
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 8 * 1024 * 1024) throw new LlmError('SSE frame exceeds 8 MiB.', 'PROTOCOL');
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        if (!done && match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (!line) {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        if (data.reduce((n, v) => n + v.length, 0) > 8 * 1024 * 1024) throw new LlmError('SSE event exceeds 8 MiB.', 'PROTOCOL');
      }
      if (done) break;
    }
    // Incomplete event data is intentionally not accepted as a completed response.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
