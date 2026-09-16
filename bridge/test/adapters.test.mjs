import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexAdapter, historyItems } from '../src/codex.mjs';
import { ClaudeAdapter } from '../src/claude.mjs';
import { BridgeEngine } from '../src/engine.mjs';
import { normalizeRequest } from '../src/request.mjs';

const tool = { type: 'function', function: { name: 'external_echo', parameters: { type: 'object', properties: { value: { type: 'string' } } } } };
for (const [provider, Adapter] of [['codex', CodexAdapter], ['claude', ClaudeAdapter]]) {
  test(`${provider} CLI adapter preserves a real child-process tool round trip`, async t => {
    const command = fileURLToPath(new URL(`./fixtures/${provider}.mjs`, import.meta.url));
    const engine = new BridgeEngine({ [provider]: new Adapter({ command }) }, { requestMs: 10000 });
    t.after(() => engine.close());
    const models = await engine.models(); assert.ok(models.length);
    const messages = [{ role: 'system', content: 'Use the external echo tool.' }, { role: 'user', content: 'First' }, { role: 'assistant', content: 'Previous response' }, { role: 'user', content: 'Now call the tool' }];
    const body = { model: models[0].id, messages, tools: [tool] };
    const first = await engine.complete(normalizeRequest(body));
    assert.equal(first.finish_reason, 'tool_calls');
    assert.equal(first.message.tool_calls[0].function.name, 'external_echo');
    const second = await engine.complete(normalizeRequest({ ...body, messages: [...messages, first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'Only the client knows this result: 1234' }] }));
    assert.equal(second.message.content, 'Only the client knows this result: 1234');
    assert.equal(second.finish_reason, 'stop'); assert.equal(engine.sessions.size, 0);
  });
}

test('Codex rejects API-key accounts before starting inference', async () => {
  const old = process.env.BYOK_TEST_ACCOUNT; process.env.BYOK_TEST_ACCOUNT = 'apiKey';
  try {
    const adapter = new CodexAdapter({ command: fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url)) });
    await assert.rejects(adapter.models(), e => e.code === 'subscription_required');
  } finally { if (old == null) delete process.env.BYOK_TEST_ACCOUNT; else process.env.BYOK_TEST_ACCOUNT = old; }
});

test('Claude rejects API-key accounts before starting inference', async () => {
  const old = process.env.BYOK_TEST_CLAUDE_AUTH; process.env.BYOK_TEST_CLAUDE_AUTH = 'api_key';
  try {
    const adapter = new ClaudeAdapter({ command: fileURLToPath(new URL('./fixtures/claude.mjs', import.meta.url)) });
    await assert.rejects(adapter.models(), e => e.code === 'subscription_required');
  } finally { if (old == null) delete process.env.BYOK_TEST_CLAUDE_AUTH; else process.env.BYOK_TEST_CLAUDE_AUTH = old; }
});

test('unexpected Codex approvals fail closed', async t => {
  const engine = new BridgeEngine({ codex: new CodexAdapter({ command: fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url)) }) });
  t.after(() => engine.close());
  await assert.rejects(engine.complete(normalizeRequest({ model: 'codex/fixture', messages: [{ role: 'user', content: 'unexpected-tool' }] })), /unexpected tool or approval/);
});

test('a deadline during CLI initialization terminates the worker promptly', async t => {
  const old = process.env.BYOK_TEST_PAUSE_INIT; process.env.BYOK_TEST_PAUSE_INIT = '1';
  const engine = new BridgeEngine({ codex: new CodexAdapter({ command: fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url)) }) }, { requestMs: 100 });
  t.after(() => engine.close());
  try {
    const started = Date.now();
    await assert.rejects(engine.complete(normalizeRequest({ model: 'codex/fixture', messages: [{ role: 'user', content: 'hello' }] })), e => e.code === 'request_timeout');
    assert.ok(Date.now() - started < 2500); assert.equal(engine.sessions.size, 0);
  } finally { if (old == null) delete process.env.BYOK_TEST_PAUSE_INIT; else process.env.BYOK_TEST_PAUSE_INIT = old; }
});

test('Codex history conversion retains roles and function call/result IDs', () => {
  const items = historyItems([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'checking', tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'file contents' }
  ]);
  assert.equal(items[0].role, 'user'); assert.equal(items[1].role, 'assistant');
  assert.equal(items[2].call_id, 'call-1'); assert.equal(items[3].call_id, 'call-1'); assert.equal(items[3].output, 'file contents');
});
