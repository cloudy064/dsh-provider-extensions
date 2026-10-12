import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { buildRequest } from '../lib/wire.js';
import { resolveConfig } from '../lib/config.js';
import { ClinePassAdapter } from '../lib/adapter.js';

const config = resolveConfig({ models: [{ id: 'cline-pass/test' }] });
const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'use tools' }] };
const result = (id, content = [], isError = false) => createToolResultMessage({
  callId: ToolCallId(id), content, isError,
});
const request = messages => JSON.parse(JSON.stringify(buildRequest({
  provider: 'cline-pass', model: 'cline-pass/test', messages,
}, config)));

test('empty result and multiple text blocks retain valid correlation', () => {
  const messages = [result('empty'), result('joined', [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])];
  assert.deepEqual(request(messages).messages, [
    { role: 'tool', tool_call_id: 'empty', content: '' },
    { role: 'tool', tool_call_id: 'joined', content: 'ab' },
  ]);
});

test('malformed current and legacy tool results fail before reaching the upstream', () => {
  for (const id of [undefined, null, '', ' ', 42, {}, []]) {
    for (const message of [
      { role: 'tool', toolCallId: id, source: { kind: 'tool' }, content: [] },
      { role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: id, content: [] }] },
    ]) {
      assert.throws(() => request([message]), error => error.code === 'UNSUPPORTED_CONTENT');
    }
  }
});

test('streamed tool call -> current Harness tool result -> assistant continuation', async () => {
  let calls = 0;
  const sse = events => new Response(
    events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
  const adapter = new ClinePassAdapter({
    config: () => config,
    apiKey: async () => 'test-key',
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls++;
      if (calls === 1) {
        return sse([{ choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'roundtrip-id', function: { name: 'echo', arguments: '{}' } }] },
          finish_reason: 'tool_calls',
        }] }]);
      }
      assert.equal(body.messages.at(-1).tool_call_id, 'roundtrip-id');
      assert.equal(body.messages.at(-2).tool_calls[0].id, 'roundtrip-id');
      return sse([{ choices: [{ index: 0, delta: { content: 'TOOL_OK' }, finish_reason: 'stop' }] }]);
    },
  });
  const options = { provider: 'cline-pass', model: 'cline-pass/test', messages: [user] };
  const blocks = [];
  let replayState;
  for await (const event of adapter.stream(options)) {
    if (event.type === 'block-end') blocks.push(event.block);
    if (event.type === 'finish') replayState = event.replayState;
  }
  assert.equal(blocks[0].type, 'tool-call');
  options.messages.push({
    role: 'assistant',
    source: { kind: 'model', provider: options.provider, model: options.model, replayState },
    content: blocks,
  }, result(blocks[0].id, [{ type: 'text', text: 'TOOL_OK' }]));
  const output = [];
  for await (const event of adapter.stream(options)) {
    if (event.type === 'block-end') output.push(event.block);
  }
  assert.equal(calls, 2);
  assert.equal(output[0].text, 'TOOL_OK');
});
