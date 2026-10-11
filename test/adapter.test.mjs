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
    assert.ok((await ctx.llm.listProviders()).some(p => p.id === 'cline-pass'));
    assert.equal((await ctx.llm.listModels('cline-pass'))[0].id, 'cline-pass/test');
    await fork.update({});
    assert.ok(!(await ctx.llm.listProviders()).some(p => p.id === 'cline-pass'));
  } finally { await ctx.fiber.dispose(); }
});
