import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CommandCodeAdapter, discoverCommandCode, parseCommandCatalog } from '../lib/commandcode.js';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as plugin from '../lib/index.js';

test('commandcode discovery is public, deduplicated and preserves context sizes', async () => {
  const models = await discoverCommandCode(async (url, init) => {
    assert.equal(url, 'https://api.commandcode.ai/provider/v1/models');
    assert.equal(init.headers, undefined);
    assert.equal(init.redirect, 'error');
    return Response.json({ data: [{ id: 'claude-test', context_length: 12345 }, { id: 'claude-test' }, { id: 'gpt-test' }] });
  });
  assert.deepEqual(models, [{ id: 'claude-test', contextWindow: 12345 }, { id: 'gpt-test' }]);
  assert.throws(() => parseCommandCatalog({ data: [] }));
});

test('commandcode is dormant by default and can be added/deleted independently', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime).await();
    const fork = ctx.plugin(plugin, {}); await fork.await();
    assert.ok(ctx.llm.listConfigurableProviders().some(p => p.provider === 'commandcode'));
    assert.ok(!(await ctx.llm.listProviders()).some(p => p.id === 'commandcode'));
    await fork.update({ commandcode: { models: [{ id: 'gpt-test' }] } });
    assert.equal((await ctx.llm.listModels('commandcode'))[0].id, 'gpt-test');
    await fork.update({});
    assert.ok(!(await ctx.llm.listProviders()).some(p => p.id === 'commandcode'));
  } finally { await ctx.fiber.dispose(); }
});

test('commandcode streams OpenAI and Claude through their separate endpoints', async () => {
  const received = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    received.push({ url: req.url, body: JSON.parse(body), auth: req.headers.authorization ?? req.headers['x-api-key'] });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    if (req.url.split('?')[0].endsWith('/messages')) {
      const event = value => { res.write(`event: ${value.type}\n`); frame(value); };
      event({ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test', content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } });
      event({ type: 'content_block_stop', index: 0 });
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
      event({ type: 'message_stop' });
    } else {
      frame({ id: 'chat_test', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] });
      frame({ id: 'chat_test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const adapter = new CommandCodeAdapter(() => ({ models: [{ id: 'gpt-test' }, { id: 'claude-test' }] }), async () => 'offline-test-key', `http://127.0.0.1:${server.address().port}/v1`);
    for (const model of ['gpt-test', 'claude-test']) {
      const chunks = [];
      for await (const chunk of adapter.stream({ provider: 'commandcode', model, messages: [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] }] })) chunks.push(chunk);
      assert.equal(chunks.at(-1).type, 'finish');
      assert.notEqual(chunks.at(-1).reason?.kind, 'error', JSON.stringify(chunks.at(-1)));
      assert.ok(JSON.stringify(chunks).includes('hello'), JSON.stringify(chunks));
    }
    assert.deepEqual(received.map(r => r.url.split('?')[0]), ['/v1/chat/completions', '/v1/messages']);
    assert.ok(received.every(r => r.auth?.includes('offline-test-key')));
    assert.ok(received.every(r => !r.body.provider && !r.body.session_id));
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
