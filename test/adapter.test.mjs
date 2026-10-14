import test from 'node:test';
import assert from 'node:assert/strict';
import { ClinePassAdapter, parseCatalog, discoverCatalog } from '../lib/adapter.js';
import { resolveConfig } from '../lib/config.js';
import { buildRequest, tokenUsage, sse } from '../lib/wire.js';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as plugin from '../lib/index.js';

const options = { provider: 'cline-pass', model: 'cline-pass/test', sessionId: 'session-a', messages: [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] }] };
test('DSH 0.2 tool messages retain their call IDs on the next model request', () => {
  const calls = ['call_pwsh', 'call_glob'];
  const messages = [...options.messages,
    { role: 'assistant', source: { kind: 'model' }, content: calls.map(id => ({ type: 'tool-call', id, name: 'read', arguments: '{}' })) },
    ...calls.map((id, index) => ({ role: 'tool', toolCallId: id, source: { kind: 'tool', callId: id }, isError: index === 1, content: [{ type: 'text', text: `result ${index}` }] })),
  ];
  const body = buildRequest({ ...options, messages }, resolveConfig());
  assert.deepEqual(body.messages.slice(-2), calls.map((id, index) => ({ role: 'tool', tool_call_id: id, content: `result ${index}` })));
  assert.throws(() => buildRequest({ ...options, messages: [{ role: 'tool', content: [] }] }, resolveConfig()), /missing toolCallId/);
});
const frame = raw => `data: ${typeof raw === 'string' ? raw : JSON.stringify(raw)}\r\n\r\n`;
function response(events, fragment = 7) {
  const bytes = new TextEncoder().encode(events.map(frame).join(''));
  let position = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (position >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(position, position += fragment));
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
const choice = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
function adapter(events, config = {}, extra = {}) {
  return new ClinePassAdapter({ config: () => resolveConfig(config), apiKey: async () => 'secret-test-key', fetch: async () => response(events), ...extra });
}

test('subscription route and strict configuration validation', () => {
  assert.throws(() => buildRequest({ ...options, model: 'deepseek/test' }, resolveConfig()), /subscription/);
  assert.throws(() => resolveConfig({ routing: 'experimental-pin' }), /requires/);
  assert.throws(() => resolveConfig({ models: [{ id: 'cline-pass/test', contextWindow: 0 }] }), /positive/);
});
test('stable routing identity across requests; auxiliary calls isolated', () => {
  const config = resolveConfig({ routing: 'experimental-pin', upstream: 'example' });
  const a = buildRequest(options, config), b = buildRequest(options, config);
  assert.deepEqual(a, b);
  assert.deepEqual(a.provider, { only: ['example'], allow_fallbacks: false });
  assert.notEqual(a.session_id, buildRequest({ ...options, purpose: 'session-title' }, config).session_id);
  assert.equal(buildRequest(options, resolveConfig({ routing: 'default' })).session_id, undefined);
  assert.equal(buildRequest({ ...options, sessionId: undefined }, config).session_id, undefined);
});
test('cache counters are disjoint, absent cache remains unknown', () => {
  assert.deepEqual(tokenUsage({ prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 75 } }), { inputTokens: 25, outputTokens: 8, totalTokens: 108, cacheReadTokens: 75 });
  assert.equal(tokenUsage({ prompt_tokens: 100, completion_tokens: 8 }).cacheReadTokens, undefined);
  assert.equal(tokenUsage({ prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 999 } }).cacheReadTokens, undefined);
});
test('subscription catalog excludes other billing tiers and handles data envelope', () => {
  assert.deepEqual(parseCatalog({ data: { clinePass: [{ id: 'cline-pass/a', name: 'A' }, { id: 'other/b' }] } }), [{ id: 'cline-pass/a', name: 'A' }]);
  assert.throws(() => parseCatalog({ free: [] }), /catalog/);
});
test('SSE handles fragmented UTF-8, comments, multiline data and CRLF', async () => {
  const bytes = new TextEncoder().encode(': comment\r\ndata: 你\r\ndata: 好\r\n\r\n');
  const stream = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  assert.deepEqual(await collect(sse(stream)), ['你\n好']);
});
test('model discovery uses fixed public catalog with cancellation and no credential headers', async () => {
  const controller = new AbortController();
  const found = await discoverCatalog(async (url, init) => {
    assert.equal(url, 'https://api.cline.bot/api/v1/ai/cline/recommended-models');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, 'error');
    controller.abort();
    assert.equal(init.signal.aborted, true);
    return Response.json({ clinePass: [{ id: 'cline-pass/a' }] });
  }, controller.signal);
  assert.deepEqual(found, [{ id: 'cline-pass/a' }]);
});
test('stream emits text, reasoning, interleaved tool calls and final usage in order', async () => {
  const events = [choice({ reasoning_content: '思考' }), choice({ content: 'Working' }),
    choice({ tool_calls: [{ index: 0, id: 'call-a', function: { name: 'read', arguments: '{"path":' } }, { index: 1, id: 'call-b', function: { name: 'list', arguments: '{}' } }] }),
    choice({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, 'tool_calls'),
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 90 } }, '[DONE]'];
  const chunks = await collect(adapter(events).stream(options));
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  assert.equal(chunks.at(-2).usage.inputTokens, 10);
  assert.deepEqual(chunks.filter(c => c.type === 'block-end').map(c => c.block), [
    { type: 'reasoning', text: '思考' }, { type: 'text', text: 'Working' },
    { type: 'tool-call', id: 'call-a', name: 'read', arguments: '{"path":"a"}' },
    { type: 'tool-call', id: 'call-b', name: 'list', arguments: '{}' },
  ]);
});

// DSH records every chunk through a lossless-JSON check: an object key holding
// `undefined`, a non-finite number, a sparse array, or a non-plain object is
// rejected and fails the whole run. Mirror those rules over a real stream.
function assertLosslessJson(value, path = 'chunk', open = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value) && !Object.is(value, -0), `${path}: ${String(value)} is not a JSON number`);
    return;
  }
  assert.notEqual(value, undefined, `${path} is undefined`);
  assert.equal(typeof value, 'object', `${path} is not a JSON value`);
  assert.ok(!open.has(value), `${path} is cyclic`);
  open.add(value);
  if (Array.isArray(value)) {
    assert.equal(Object.getPrototypeOf(value), Array.prototype, `${path} is not a plain array`);
    assert.equal(Reflect.ownKeys(value).length, value.length + 1, `${path} is a sparse or decorated array`);
    value.forEach((item, index) => assertLosslessJson(item, `${path}[${index}]`, open));
  } else {
    assert.equal(Object.getPrototypeOf(value), Object.prototype, `${path} is not a plain object`);
    for (const [key, item] of Object.entries(value)) assertLosslessJson(item, `${path}.${key}`, open);
  }
  open.delete(value);
}

test('every streamed chunk survives a lossless JSON round trip', async () => {
  const plain = [
    choice({ content: 'Done' }, 'stop'),
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    '[DONE]',
  ];
  const detailed = [
    choice({ reasoning_content: 'think', reasoning_details: [{ index: 0, type: 'reasoning.text', id: 'r1', text: 'think' }] }, 'stop'),
    '[DONE]',
  ];
  for (const [events, hasDetails] of [[plain, false], [detailed, true]]) {
    const chunks = await collect(adapter(events).stream(options));
    assert.ok(chunks.length > 0);
    for (const chunk of chunks) assertLosslessJson(chunk);
    const finish = chunks.at(-1);
    assert.equal(finish.type, 'finish');
    assert.equal(Object.hasOwn(finish.replayState.response, 'reasoningDetails'), hasDetails);
  }
});

test('wire request includes attribution and tools; never rewrites input', async () => {
  const original = structuredClone(options); let captured;
  await collect(adapter([], {}, { fetch: async (url, init) => { captured = { url, ...init }; return response([choice({ content: 'OK' }, 'stop'), '[DONE]']); } }).stream(options));
  assert.deepEqual(options, original);
  assert.match(captured.headers['user-agent'], /deepseek|dsh/);
  assert.equal(captured.redirect, 'error');
  assert.equal(JSON.parse(captured.body).stream, true);
});
test('tool results and reasoning survive multi-turn serialization', () => {
  const next = { ...options, messages: [...options.messages,
    { role: 'assistant', source: { kind: 'model', provider: 'cline-pass', model: 'cline-pass/test' }, content: [{ type: 'reasoning', text: 'plan' }, { type: 'tool-call', id: 't', name: 'read', arguments: '{}' }] },
    { role: 'user', source: { kind: 'tool', callId: 't' }, content: [{ type: 'tool-result', toolCallId: 't', content: [{ type: 'text', text: 'result' }] }] }] };
  const messages = buildRequest(next, resolveConfig()).messages;
  assert.equal(messages[1].reasoning_content, 'plan');
  assert.equal(messages[1].tool_calls[0].id, 't');
  assert.deepEqual(messages[2], { role: 'tool', tool_call_id: 't', content: 'result' });
});
test('truncated streams never finish successfully, even after finish_reason', async () => {
  await assert.rejects(collect(adapter([choice({ content: 'partial' }, 'stop')]).stream(options)), e => e.code === 'INCOMPLETE_STREAM');
  await assert.rejects(collect(adapter(['[DONE]']).stream(options)), e => e.code === 'INCOMPLETE_STREAM');
});
test('stream errors and unknown finish reasons are explicit failures', async () => {
  await assert.rejects(collect(adapter([{ error: { message: 'secret-test-key' } }]).stream(options)), e => e.code === 'STREAM_ERROR' && !e.message.includes('secret-test-key'));
  await assert.rejects(collect(adapter([choice({}, 'content_filter'), '[DONE]']).stream(options)), e => e.code === 'STREAM_ERROR');
});
test('provider refusal names its cause while free text stays behind diagnostics', async () => {
  const refusal = { error: { code: 'invalid_request_error', type: 'invalid_request_error', message: 'model cline-pass/x is not available' } };
  await assert.rejects(collect(adapter([refusal]).stream(options)), e => e.code === 'STREAM_ERROR'
    && e.message.includes('code=invalid_request_error') && e.message.includes('type=invalid_request_error')
    && !e.message.includes('is not available'));
  await assert.rejects(collect(adapter([refusal], { diagnostics: true }).stream(options)), e => e.message.includes('is not available'));
  const secret = `sk-${'a'.repeat(40)}`;
  await assert.rejects(collect(adapter([{ error: { message: `rejected ${secret}` } }], { diagnostics: true }).stream(options)),
    e => e.message.includes('rejected') && e.message.includes('[redacted]') && !e.message.includes(secret));
  await assert.rejects(collect(adapter([], {}, {
    fetch: async () => new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'balance is empty' } }), { status: 402 }),
  }).stream(options)), e => e.code === 'BAD_REQUEST' && e.message.includes('code=insufficient_quota') && !e.message.includes('balance is empty'));
});
test('a documented mid-stream error names its code and unknown finish reasons name themselves', async () => {
  const nested = [{ choices: [{ index: 0, finish_reason: 'error', error: { code: 'context_length_exceeded', message: 'The input exceeds the model maximum context length.' } }] }];
  await assert.rejects(collect(adapter(nested).stream(options)), e => e.code === 'CONTEXT_WINDOW_EXCEEDED'
    && e.message.includes('code=context_length_exceeded') && !e.message.includes('exceeds'));
  await assert.rejects(collect(adapter(nested, { diagnostics: true }).stream(options)), e => e.message.includes('exceeds'));
  await assert.rejects(collect(adapter([choice({}, 'content_filter'), '[DONE]']).stream(options)), e => e.message.includes('content_filter'));
});
test('requests carry only parameters the Cline API documents', async () => {
  let captured;
  const events = [choice({ content: 'OK' }, 'stop'), '[DONE]'];
  const instance = adapter(events, {}, {
    fetch: async (url, init) => { captured = JSON.parse(init.body); return response(events); },
  });
  await collect(instance.stream({ ...options, reasoningEffort: 'high', maxTokens: 256, temperature: 0.2 }));
  // The routing keys are this plugin's own documented feature; everything else
  // must be a parameter the Cline API actually documents.
  const routingKeys = ['session_id', 'provider'];
  assert.deepEqual(Object.keys(captured).filter((key) => !routingKeys.includes(key)).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
  assert.ok(!('reasoning_effort' in captured) && !('stream_options' in captured));
});
test('HTTP rate limits preserve retry delay without exposing bodies', async () => {
  await assert.rejects(collect(adapter([], {}, { fetch: async () => new Response('secret-test-key', { status: 429, headers: { 'retry-after': '2' } }) }).stream(options)), e => e.code === 'RATE_LIMIT' && e.failure.providerRetryAfterMs === 2000 && !e.message.includes('secret-test-key'));
});
test('cancellation propagates to network and transport errors are sanitized', async () => {
  const abort = new AbortController();
  const instance = adapter([], {}, { fetch: async (_, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason)); abort.abort();
  }) });
  await assert.rejects(collect(instance.stream({ ...options, signal: abort.signal })), e => e.code === 'ABORTED');
  await assert.rejects(collect(adapter([], {}, { fetch: async () => { throw new Error('secret-test-key'); } }).stream(options)), e => e.code === 'TRANSPORT' && !e.message.includes('secret-test-key'));
});
test('prepared call retains its routing configuration through settings changes', async () => {
  let config = resolveConfig({ routing: 'experimental-pin', upstream: 'a' }); let body;
  const instance = new ClinePassAdapter({ config: () => config, apiKey: async () => 'key', fetch: async (_, init) => { body = JSON.parse(init.body); return response([choice({ content: 'OK' }, 'stop'), '[DONE]']); } });
  const prepared = await instance.prepareCall(options.provider, options.model);
  config = resolveConfig({ routing: 'experimental-pin', upstream: 'b' });
  await collect(prepared.stream(options));
  assert.deepEqual(body.provider.only, ['a']);
});
test('diagnostics contain no key or prompt and cannot interrupt completion', async () => {
  let diagnostic;
  const chunks = await collect(adapter([choice({ content: 'OK' }, 'stop'), '[DONE]'], {}, { diagnostic: e => { diagnostic = e; throw new Error('logger failed'); } }).stream(options));
  assert.equal(chunks.at(-1).type, 'finish');
  assert.equal(diagnostic.routingVerified, false);
  assert.equal(diagnostic.usage, undefined);
  assert.ok(!JSON.stringify(diagnostic).includes('Hello'));
  assert.ok(!JSON.stringify(diagnostic).includes('secret-test-key'));
});

test('transport failures retain only safe cause codes and request stage', async () => {
  let diagnostic;
  const error = new TypeError('secret-test-key https://private.invalid/Hello', {
    cause: Object.assign(new Error('private socket information'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
  });
  await assert.rejects(collect(adapter([], {}, {
    fetch: async () => { throw error; }, diagnostic: e => { diagnostic = e; },
  }).stream(options)), e => e.code === 'TRANSPORT' && /stage=request type=TypeError cause=UND_ERR_CONNECT_TIMEOUT/.test(e.message));
  assert.deepEqual(diagnostic.failure, { stage: 'request', errorType: 'TypeError', causeCode: 'UND_ERR_CONNECT_TIMEOUT', receivedOutput: false, code: 'TRANSPORT', retryable: true });
  assert.ok(!JSON.stringify(diagnostic).includes('private'));
  assert.ok(!JSON.stringify(diagnostic).includes('secret-test-key'));
  const custom = Object.assign(new Error('secret-test-key'), { name: 'secret-test-key', code: 'secret-test-key' });
  custom.cause = custom;
  await assert.rejects(collect(adapter([], {}, { fetch: async () => { throw custom; } }).stream(options)),
    e => /type=UnknownError/.test(e.message) && !e.message.includes('secret-test-key'));
});

test('transient SSE failures are retryable; permanent failures and cancellation are not', async () => {
  const policy = adapter([]).providerRetryPolicy();
  assert.equal(policy.maxRetries, 2);
  assert.equal(policy.initialDelayMs, 1000);
  for (const [providerCode, expected] of [[500, 'SERVER_ERROR'], ['503', 'SERVER_ERROR'], ['server_error', 'SERVER_ERROR'], [429, 'RATE_LIMIT'], ['context_length_exceeded', 'CONTEXT_WINDOW_EXCEEDED'], [401, 'STREAM_ERROR'], [402, 'STREAM_ERROR'], ['stream_initialization_failed', 'STREAM_ERROR']]) {
    for (const nested of [false, true]) {
      const error = { code: providerCode, message: 'Internal server error: secret-test-key Hello' };
      let diagnostic;
      const instance = adapter([choice({ reasoning: 'partial' }), nested ? { choices: [{ index: 0, error, finish_reason: 'error' }] } : { error }], {}, { diagnostic: e => { diagnostic = e; } });
      await assert.rejects(collect(instance.stream(options)), e => e.code === expected && e.message.includes('attempt=') && !e.message.includes('secret-test-key'));
      assert.equal(diagnostic.failure.retryable, policy.retryableCodes.includes(expected));
      assert.equal(diagnostic.failure.receivedOutput, true);
      assert.equal(diagnostic.providerError.reason, 'internal_server_error');
      assert.match(diagnostic.providerError.messageHash, /^[a-f0-9]{64}$/);
      assert.ok(!JSON.stringify(diagnostic).includes('secret-test-key'));
      assert.ok(!JSON.stringify(diagnostic).includes('Hello'));
    }
  }
  assert.ok(!policy.retryableCodes.includes('ABORTED'));
  assert.ok(!policy.retryableCodes.includes('ADAPTER_ERROR'));
});

test('request IDs and failure facts survive into session errors and asynchronous diagnostics', async () => {
  let recorded;
  const instance = adapter([], {}, {
    fetch: async () => new Response(frame({ error: { code: 500, message: 'upstream timed out' } }), { headers: { 'x-request-id': 'req-123' } }),
    diagnostic: async event => { await Promise.resolve(); recorded = event; },
  });
  await assert.rejects(collect(instance.stream(options)), e => e.code === 'SERVER_ERROR' && e.failure.message.includes('requestId=req-123'));
  assert.equal(recorded.requestId, 'req-123');
  assert.equal(recorded.httpStatus, 200);
  assert.equal(recorded.providerError.reason, 'upstream_timeout');
  assert.equal(recorded.failure.code, 'SERVER_ERROR');
  await assert.rejects(collect(adapter([{ error: { code: 500 } }], {}, { diagnostic: async () => { throw new Error('disk full'); } }).stream(options)), e => e.code === 'SERVER_ERROR');
});

test('stream read disconnect after output is distinguished from decoding failure', async () => {
  let pulls = 0;
  const chunks = [];
  const broken = adapter([], {}, { fetch: async () => new Response(new ReadableStream({ pull(controller) {
    if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(frame(choice({ content: 'OK' }))));
    else controller.error(Object.assign(new Error('secret-test-key'), { code: 'ECONNRESET' }));
  } })) });
  await assert.rejects(async () => { for await (const c of broken.stream(options)) chunks.push(c); },
    e => e.code === 'TRANSPORT' && /stage=stream-read/.test(e.message) && /cause=ECONNRESET/.test(e.message) && /receivedOutput=true/.test(e.message));
  assert.ok(chunks.some(c => c.type === 'text-delta'));
  await assert.rejects(collect(adapter([{ choices: {} }]).stream(options)),
    e => e.code === 'ADAPTER_ERROR' && /stage=stream-decode type=TypeError/.test(e.message));
});

test('DSH assembler replay envelope survives a reasoning-details tool round trip', async () => {
  const events = [choice({ reasoning_details: [{ index: 0, type: 'reasoning.encrypted', data: 'abc' }] }),
    choice({ reasoning_details: [{ index: 0, type: 'reasoning.encrypted', data: 'def' }], tool_calls: [{ index: 0, id: 't', function: { name: 'read', arguments: '{}' } }] }, 'tool_calls'), '[DONE]'];
  const assembler = new BlockAssembler();
  for (const chunk of await collect(adapter(events).stream(options))) assembler.push(chunk);
  const message = assembler.message({ kind: 'model', provider: options.provider, model: options.model, replayState: assembler.replayState });
  const body = buildRequest({ ...options, messages: [...options.messages, message] }, resolveConfig());
  assert.deepEqual(body.messages[1].reasoning_details, [{ index: 0, type: 'reasoning.encrypted', data: 'abcdef' }]);
});

test('native Cordis lifecycle registers provider and DSH normalizes missing credentials', async () => {
  const ctx = new Context();
  const llm = ctx.plugin(LlmRuntime);
  const fork = ctx.plugin(plugin, { enabled: true, apiKeyEnv: 'DSH_CLINEPASS_TEST_MISSING_KEY', models: [{ id: 'cline-pass/test' }] });
  await llm.await();
  await fork.await();
  try {
    assert.ok((await ctx.llm.listProviders()).some(p => p.id === 'cline-pass'));
    assert.equal((await ctx.llm.listModels('cline-pass'))[0].id, 'cline-pass/test');
    const chunks = await collect(ctx.llm.stream(options));
    assert.equal(chunks.at(-1).reason.failure.code, 'MISSING_CREDENTIAL');
    await fork.dispose();
    assert.ok(!(await ctx.llm.listProviders()).some(p => p.id === 'cline-pass'));
  } finally { await ctx.fiber.dispose(); }
});
test('provider is optional: add registers route and delete withdraws it', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime).await();
    const fork = ctx.plugin(plugin, {});
    await fork.await();
    assert.ok(!(await ctx.llm.listProviders()).some(p => p.id === 'cline-pass'));
    assert.deepEqual(ctx.llm.listConfigurableProviders().find(p => p.provider === 'cline-pass').settingsPath, ['profile']);
    await fork.update({ profile: { models: [{ id: 'cline-pass/test' }] } });
    await fork.await();
    assert.ok((await ctx.llm.listProviders()).some(p => p.id === 'cline-pass'));
    assert.equal((await ctx.llm.listModels('cline-pass'))[0].id, 'cline-pass/test');
    await fork.update({});
    await fork.await();
    assert.ok(!(await ctx.llm.listProviders()).some(p => p.id === 'cline-pass'));
  } finally { await ctx.fiber.dispose(); }
});


test('context overflow reaches host recovery for HTTP and both SSE shapes without leaking text', async () => {
  const errors = [
    { code: 'context_length_exceeded' },
    { code: 'stream_initialization_failed', message: 'Maximum context length exceeded: private-prompt' },
    { code: 'stream_initialization_failed', metadata: { raw: JSON.stringify({ error: { message: 'Input exceeds the model context window: private-prompt' } }) } },
  ];
  for (const error of errors) {
    for (const shape of ['http', 'top', 'choice']) {
      let diagnostic;
      const instance = adapter(shape === 'top' ? [{ error }] : [{ choices: [{ index: 0, error, finish_reason: 'error' }] }], {}, {
        ...(shape === 'http' ? { fetch: async () => Response.json({ error }, { status: 400 }) } : {}),
        diagnostic: value => { diagnostic = value; },
      });
      await assert.rejects(collect(instance.stream(options)), e => e.code === 'CONTEXT_WINDOW_EXCEEDED'
        && e.message.includes('Compact the conversation') && !e.message.includes('private-prompt'));
      assert.equal(diagnostic.failure.retryable, false, 'ordinary retries must not replay an oversized request');
      assert.ok(!JSON.stringify(diagnostic).includes('private-prompt'));
    }
  }
  for (const error of [
    { code: 'stream_initialization_failed', message: 'Provider unavailable' },
    { code: 400, message: 'Invalid context length parameter' },
    { metadata: { raw: '{invalid' } },
  ]) await assert.rejects(collect(adapter([{ error }]).stream(options)), e => e.code === 'STREAM_ERROR');
});

test('resolved and prepared models always supply a conservative compaction budget; explicit limits win', async () => {
  const fallback = adapter([]);
  assert.equal((await fallback.resolveModel(options.provider, options.model)).context.contextWindow, 262144);
  assert.equal((await fallback.prepareCall(options.provider, options.model)).model.context.contextWindow, 262144);
  const configured = adapter([], { models: [{ id: options.model, contextWindow: 1000000, maxTokens: 8192 }] });
  const info = await configured.resolveModel(options.provider, options.model);
  assert.equal(info.context.contextWindow, 1000000);
  assert.equal(info.defaultMaxTokens, 8192);
});
