import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeEngine } from '../src/engine.mjs';
import { ClaudeAdapter } from '../src/claude.mjs';
import { CodexAdapter } from '../src/codex.mjs';
import { EventQueue } from '../src/common.mjs';
import { normalizeRequest } from '../src/request.mjs';
import { createBridgeServer } from '../src/server.mjs';

for (const backend of ['codex', 'claude']) test(`${backend} tracks native children, isolates their output, and forks saved context with durable lineage`, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-delegation-'));
  const priorDirectory = process.env.BYOK_TEST_SESSION_DIRECTORY, priorAgents = process.env.BYOK_TEST_SUBAGENTS;
  process.env.BYOK_TEST_SESSION_DIRECTORY = directory; process.env.BYOK_TEST_SUBAGENTS = '1';
  const Adapter = backend === 'codex' ? CodexAdapter : ClaudeAdapter;
  const engine = new BridgeEngine({ [backend]: new Adapter({ command: path.resolve(`test/fixtures/${backend}.mjs`) }) }, { sessionRecordsFile: path.join(directory, 'sessions.json') });
  const token = 'test-token-at-least-24-characters';
  const server = createBridgeServer(engine, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await engine.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
    if (priorDirectory === undefined) delete process.env.BYOK_TEST_SESSION_DIRECTORY; else process.env.BYOK_TEST_SESSION_DIRECTORY = priorDirectory;
    if (priorAgents === undefined) delete process.env.BYOK_TEST_SUBAGENTS; else process.env.BYOK_TEST_SUBAGENTS = priorAgents;
  });
  await engine.sessionSettings.update({ [backend]: { persistSessions: true, subagentsEnabled: true, sessionDirectory: directory } });
  const root = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const model = backend === 'claude' ? 'claude/haiku' : 'codex/fixture';
  const tools = [{ type: 'function', function: { name: 'external_echo', parameters: { type: 'object' } } }];
  const run = async (route = '/v1/chat/completions') => {
    const messages = [{ role: 'user', content: 'Delegate a test' }];
    const first = await fetch(root + route, { method: 'POST', headers, body: JSON.stringify({ model, tools, messages, stream: true }) });
    assert.equal(first.status, 200, await (first.ok ? Promise.resolve('') : first.text()));
    const id = first.headers.get('x-cli-bridge-session-id');
    const frames = (await first.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    const updates = frames.filter(frame => frame.bridge_subagent).map(frame => frame.bridge_subagent);
    assert.ok(updates.length > 0, 'native children are streamed before the tool handoff');
    assert.ok(updates.every(update => update.session_id === id && update.agent.id));
    const result = { message: { role: 'assistant', content: '', tool_calls: [] }, finish_reason: '' };
    for (const frame of frames) for (const choice of frame.choices || []) {
      result.message.content += choice.delta?.content || '';
      if (choice.delta?.tool_calls) result.message.tool_calls.push(...choice.delta.tool_calls.map(({ index, ...call }) => call));
      if (choice.finish_reason) result.finish_reason = choice.finish_reason;
    }

    assert.equal(result.finish_reason, 'tool_calls'); assert.doesNotMatch(result.message.content, /CHILD_NOISE/);
    const call = result.message.tool_calls[0];
    const final = await engine.complete(normalizeRequest({ model, tools, messages: [...messages, result.message, { role: 'tool', tool_call_id: call.id, content: 'PARENT_RESULT' }] }));
    assert.equal(final.message.content, 'PARENT_RESULT');
    assert.ok(engine.inspect(id)[0].subagents.some(agent => agent.status === 'completed'));
    return engine.inspect(id)[0];
  };
  const parent = await run();
  const fork = await run(`/v1/sessions/${parent.id}/fork`);
  assert.notEqual(parent.native_session_id, fork.native_session_id);
  assert.equal(fork.parent_id, parent.id);
  assert.ok(engine.inspect(parent.id)[0].child_ids.includes(fork.id));
  const before = await (await fetch(`${root}/v1/sessions/${parent.id}/subagents`, { headers })).json();
  assert.ok(before.data.some(item => item.kind === 'native_subagent'));
  assert.ok(before.data.some(item => item.kind === 'session_branch' && item.id === fork.id));
  const graph = await (await fetch(`${root}/v1/sessions/${parent.id}/graph`, { headers })).json();
  assert.deepEqual(graph.data.map(session => session.id), [parent.id, fork.id]);
  assert.equal(graph.truncated, false);
  assert.ok(graph.data.every(session => session.subagents.every(agent => !('summary' in agent))));
  engine.records.clear(); await engine.loadSessionRecords();
  assert.equal(engine.inspect(fork.id)[0].parent_id, parent.id);
  assert.ok(engine.inspect(parent.id)[0].child_ids.includes(fork.id));
});

test('configured task lifetime survives the former three-minute request and five-minute tool limits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = new EventQueue();
  let signal;
  const engine = new BridgeEngine({ codex: { start: async (_, s) => {
    signal = s; return { events, threadId: 'native-test', close: async () => events.end(), reply: async () => events.push({ type: 'done' }) };
  } } });
  t.after(() => engine.close());
  const tools = [{ type: 'function', function: { name: 'external_echo' } }];
  const messages = [{ role: 'user', content: 'long task' }];
  const pending = engine.complete(normalizeRequest({ model: 'codex/test', tools, messages }));
  while (!signal) await Promise.resolve();
  t.mock.timers.tick(181000);
  assert.equal(signal.aborted, false);
  events.push({ type: 'tool', key: 'pending', name: 'external_echo', arguments: {} });
  const first = await pending;
  t.mock.timers.tick(301000);
  assert.equal(engine.sessions.size, 1);
  const result = await engine.complete(normalizeRequest({ model: 'codex/test', tools, messages: [...messages, first.message,
    { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'finished' }] }));
  assert.equal(result.finish_reason, 'stop');
});


test('agent graph bounds entries, skips cycles, and omits unrelated sessions and child result payloads', async t => {
  const engine = new BridgeEngine({}); t.after(() => engine.close());
  const record = (id, parent_id, subagents = []) => ({ id, parent_id, backend: 'codex', model: 'codex/test', status: 'completed', started_at: Date.now(), subagents });
  engine.records.set('root', record('root', 'branch'));
  engine.records.set('branch', record('branch', 'root', [{ id: 'agent', status: 'completed', summary: 'private result' }]));
  engine.records.set('unrelated', record('unrelated', null));
  assert.deepEqual(engine.graph('root').data.map(node => node.id), ['root', 'branch']);
  assert.equal(engine.graph('root').truncated, false);
  assert.ok(!JSON.stringify(engine.graph('root')).includes('private result'));
  for (let i = 0; i < 300; i++) engine.records.set(`branch-${i}`, record(`branch-${i}`, 'root'));
  const graph = engine.graph('root');
  assert.equal(graph.truncated, true);
  assert.equal(graph.data.reduce((count, node) => count + 1 + node.subagents.length, 0), 200);
});
