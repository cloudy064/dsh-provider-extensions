import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ClinePassAdapter } from '../lib/adapter.js';
import { resolveConfig } from '../lib/config.js';

const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const choice = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const tool = id => ({ tool_calls: [{ index: 0, id, function: { name: 'retry_probe', arguments: '{}' } }] });

/** Exercise the shipped host loop and retry plugin, with no network or real tools. */
export async function verifyHostRetries(ctx, require, cwd) {
  const { defineTool } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
  const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
  let calls = 0, executions = 0;
  const requests = [], diagnostics = [];
  const config = resolveConfig({ routing: 'experimental-pin', upstream: 'test-upstream' });
  const adapter = new ClinePassAdapter({ config: () => config, apiKey: async () => 'fake-key',
    diagnostic: event => { diagnostics.push(event); },
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      calls++;
      const events = calls === 1
        ? [choice({ reasoning: 'FAILED_PREFIX' }), choice(tool('failed-call')), { choices: [{ index: 0, error: { code: 500, message: 'Internal server error' }, finish_reason: 'error' }] }]
        : calls === 2 ? [choice(tool('successful-call'), 'tool_calls'), '[DONE]']
        : [choice({ content: 'RECOVERED' }, 'stop'), '[DONE]'];
      return new Response(events.map(frame).join(''), { headers: { 'x-request-id': `retry-test-${calls}` } });
    },
  });
  const registration = ctx.llm.registerAdapter(['retry-test'], adapter);
  let handle;
  try {
    handle = await ctx.agents.create({ sessionId: `retry-test-${randomUUID()}`, meta: { cwd },
      agentOptions: { provider: 'retry-test', model: 'cline-pass/test' },
      setup(agentCtx) {
        agentCtx.tools.register(defineTool({ name: 'retry_probe', description: 'In-memory test counter', parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() { executions++; return 'TEST_RESULT'; },
        }));
      },
    });
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic retry test' }] }));
    await handle.agent.whenIdle();
    const events = handle.agent.session.snapshotEvents();
    assert.equal(calls, 3, `expected failed attempt, successful tool attempt, final response; ${JSON.stringify(events.filter(e => e.type === 'turn/end'))}`);
    assert.equal(executions, 1, `only successful attempt tool executes: ${JSON.stringify(events.filter(e => e.type === 'tool/result'))}`);
    assert.deepEqual(requests[0], requests[1], 'retry retains exact history, model and routing');
    assert.equal(events.filter(e => e.type === 'llm/retry').length, 1);
    assert.equal(events.filter(e => e.type === 'assistant/attempt').length, 1);
    assert.equal(events.filter(e => e.type === 'tool/call').length, 1);
    assert.ok(!JSON.stringify(handle.agent.session.deriveMessages()).includes('FAILED_PREFIX'));
    assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
    assert.equal(diagnostics[0].failure.code, 'SERVER_ERROR');
  } finally { await handle?.dispose(); registration(); }

  // A permanently failing upstream stops after the configured two retries.
  calls = 0;
  const failing = new ClinePassAdapter({ config: () => config, apiKey: async () => 'fake-key',
    fetch: async () => { calls++; return new Response(frame({ error: { code: 500 } })); },
  });
  const failedRegistration = ctx.llm.registerAdapter(['retry-test'], failing);
  try {
    handle = await ctx.agents.create({ sessionId: `retry-limit-${randomUUID()}`, meta: { cwd }, agentOptions: { provider: 'retry-test', model: 'cline-pass/test' } });
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic retry limit test' }] }));
    await handle.agent.whenIdle();
    const events = handle.agent.session.snapshotEvents();
    assert.equal(calls, 3);
    assert.deepEqual(events.filter(e => e.type === 'llm/retry').map(e => e.data.retry), [1, 2]);
    assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'error');
  } finally { await handle?.dispose(); failedRegistration(); }

  calls = 0;
  const cancelRegistration = ctx.llm.registerAdapter(['retry-test'], failing);
  let cancelListener;
  try {
    handle = await ctx.agents.create({ sessionId: `retry-cancel-${randomUUID()}`, meta: { cwd }, agentOptions: { provider: 'retry-test', model: 'cline-pass/test' } });
    let scheduled = false;
    cancelListener = ctx.on('session/event', (session, event) => {
      if (session.id === handle.agent.session.id && event.type === 'llm/retry') {
        scheduled = true;
        queueMicrotask(() => handle.agent.cancel({ kind: 'user' }));
      }
    });
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic cancellation test' }] }));
    await handle.agent.whenIdle();
    assert.ok(scheduled, 'retry backoff started');
    assert.equal(calls, 1, `cancelled backoff must not send another request: ${JSON.stringify(handle.agent.session.snapshotEvents().filter(e => ['llm/retry', 'llm/retry-started', 'turn/end', 'session/title-llm-request'].includes(e.type)))}`);
    assert.equal(handle.agent.session.snapshotEvents().filter(e => e.type === 'llm/retry-started').length, 0);
  } finally { cancelListener?.(); await handle?.dispose(); cancelRegistration(); }
}
