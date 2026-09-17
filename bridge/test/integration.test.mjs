import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelDiscovery, identityKey } from '../src/discovery.mjs';
import { BridgeEngine } from '../src/engine.mjs';
import { CodexAdapter } from '../src/codex.mjs';
import { ClaudeAdapter } from '../src/claude.mjs';
import { normalizeRequest } from '../src/request.mjs';
import { createBridgeServer } from '../src/server.mjs';

const fixture = name => fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));

test('discovery shares concurrent work, caches results, and does not wait for a slow backend', async t => {
  let calls = 0; let release;
  const discovery = new ModelDiscovery({
    codex: { async models() { calls++; await delay(10); return [{ id: 'codex/test' }]; } },
    claude: { models() { return new Promise(resolve => { release = resolve; }); } }
  });
  t.after(() => { release?.([]); discovery.close(); });
  const results = await Promise.race([Promise.all([discovery.models(), discovery.models()]), delay(1000).then(() => { throw new Error('Fast backend was blocked'); })]);
  assert.equal(calls, 1); assert.equal(results[0][0].id, 'codex/test');
  assert.equal((await discovery.models('codex'))[0].id, 'codex/test'); assert.equal(calls, 1);
  release([{ id: 'claude/sonnet' }]); await discovery.pending.get('claude');
  assert.equal((await discovery.models()).length, 2);
});

test('diagnostics retain backend failures independently and time out stuck discovery', async () => {
  const discovery = new ModelDiscovery({ codex: { models: async () => [{ id: 'codex/test' }] }, claude: { models: () => new Promise(() => {}) } }, { timeoutMs: 30 });
  const results = await discovery.diagnose();
  assert.equal(results[0].status, 'ready'); assert.equal(results[1].code, 'discovery_timeout');
  discovery.close();
});

test('cache identity changes when credentials, CLI binary, or routing environment changes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-key-test-'));
  const old = process.env.CODEX_HOME; process.env.CODEX_HOME = directory;
  t.after(async () => { if (old == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; await rm(directory, { recursive: true, force: true }); });
  const command = path.join(directory, 'cli.mjs'); await writeFile(command, 'console.log("0.154.0")');
  const first = await identityKey('codex', command);
  await writeFile(path.join(directory, 'auth.json'), 'synthetic account one');
  const second = await identityKey('codex', command); assert.notEqual(first, second);
  await writeFile(command, 'console.log("0.155.0 updated")');
  assert.notEqual(second, await identityKey('codex', command));
});

for (const [name, Adapter] of [['codex', CodexAdapter], ['claude', ClaudeAdapter]]) {
  test(`${name} retains one native worker across explicitly correlated user turns`, async t => {
    const engine = new BridgeEngine({ [name]: new Adapter({ command: fixture(name) }) });
    t.after(() => engine.close());
    const model = name === 'codex' ? 'codex/fixture' : 'claude/sonnet';
    const body = { model, bridge_persist: true, messages: [{ role: 'user', content: 'hello' }] };
    let id;
    const first = await engine.complete(normalizeRequest(body), { onSession: value => { id = value; } });
    const state = [...engine.sessions][0]; const backend = state.backend;
    assert.equal(engine.inspect(id)[0].status, 'idle');
    const next = { ...body, bridge_session_id: id, messages: [...body.messages, first.message, { role: 'user', content: 'second turn' }] };
    const second = await engine.complete(normalizeRequest(next));
    assert.equal([...engine.sessions][0].backend, backend); assert.equal(second.finish_reason, 'stop');
    assert.ok(engine.inspect(id)[0].native_session_id);
    await assert.rejects(engine.complete(normalizeRequest(next)), e => e.code === 'continuation_mismatch');
    const fork = await engine.complete(normalizeRequest({ ...body, bridge_persist: false }));
    assert.equal(fork.finish_reason, 'stop'); assert.equal(engine.sessions.size, 1);
    assert.equal(engine.inspect().length, 2); // Identical prompts never select the prior chat.
  });
}

test('persistent sessions expire and cannot be resumed by guessing or replaying an ID', async t => {
  const engine = new BridgeEngine({ codex: new CodexAdapter({ command: fixture('codex') }) }, { idleMs: 20 });
  t.after(() => engine.close());
  const body = { model: 'codex/fixture', bridge_persist: true, messages: [{ role: 'user', content: 'hello' }] };
  let id; const first = await engine.complete(normalizeRequest(body), { onSession: value => { id = value; } });
  await delay(60);
  assert.equal(engine.sessions.size, 0); assert.equal(engine.inspect(id)[0].status, 'expired');
  await assert.rejects(engine.complete(normalizeRequest({ ...body, bridge_session_id: id, messages: [...body.messages, first.message, { role: 'user', content: 'next' }] })), e => e.code === 'continuation_expired');
});

test('request diagnostics distinguish tool wait, completion, native usage and cancellation without transcript data', async t => {
  const engine = new BridgeEngine({ codex: new CodexAdapter({ command: fixture('codex') }) });
  t.after(() => engine.close());
  const body = { model: 'codex/fixture', messages: [{ role: 'user', content: 'private prompt' }], tools: [{ type: 'function', function: { name: 'echo' } }] };
  let id; const first = await engine.complete(normalizeRequest(body), { onSession: value => { id = value; } });
  assert.equal(engine.inspect(id)[0].status, 'tool_handoff');
  assert.ok(engine.inspect(id)[0].phases.some(p => p.phase === 'startup'));
  await engine.complete(normalizeRequest({ ...body, messages: [...body.messages, first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'private result' }] }));
  const record = engine.inspect(id)[0]; assert.equal(record.status, 'completed'); assert.equal(record.usage.total_tokens, 12);
  assert.doesNotMatch(JSON.stringify(record), /private prompt|private result/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(engine.complete(normalizeRequest({ ...body, tools: [] }), { signal: controller.signal }), e => e.code === 'cancelled');
  assert.equal(engine.inspect().at(-1).status, 'cancellation');
});

test('unsupported reasoning and text-only model image input fail before a native thread starts', async t => {
  const adapter = new CodexAdapter({ command: fixture('codex') });
  let starts = 0; adapter.start = async () => { starts++; throw new Error('must not start'); };
  const engine = new BridgeEngine({ codex: adapter }); t.after(() => engine.close());
  await assert.rejects(engine.complete(normalizeRequest({ model: 'codex/fixture', reasoning_effort: 'xhigh', messages: [{ role: 'user', content: 'hello' }] })), e => e.code === 'invalid_request_error');
  await assert.rejects(engine.complete(normalizeRequest({ model: 'codex/text-only', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }] })), e => e.code === 'invalid_request_error');
  assert.equal(starts, 0);
});

test('metadata routes require authentication, return explicit sessions, and expose the continuation header', async t => {
  const engine = new BridgeEngine({ codex: new CodexAdapter({ command: fixture('codex') }) });
  const token = 'a-test-token-longer-than-24-characters';
  const server = createBridgeServer(engine, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await engine.close(); });
  const url = `http://127.0.0.1:${server.address().port}`; const headers = { authorization: `Bearer ${token}` };
  for (const route of ['/v1/sessions', '/v1/diagnostics', '/v1/sessions/unknown/subagents']) assert.equal((await fetch(url + route)).status, 401);
  const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codex/fixture', bridge_persist: true, messages: [{ role: 'user', content: 'hello' }] }) });
  assert.equal(response.status, 200); await response.json(); const id = response.headers.get('x-cli-bridge-session-id'); assert.ok(id);
  const record = await (await fetch(url + '/v1/sessions/' + id, { headers })).json(); assert.equal(record.id, id); assert.equal(record.status, 'idle');
  const children = await (await fetch(url + '/v1/sessions/' + id + '/subagents', { headers })).json(); assert.deepEqual(children.data, []);
  const report = await (await fetch(url + '/v1/diagnostics', { headers })).json(); assert.equal(report.backends[0].status, 'ready');
  assert.equal((await fetch(url + '/v1/models?backend=disabled', { headers })).status, 404);
});

test('credential changes invalidate a retained worker before accepting another turn', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-account-change-'));
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = directory;
  const engine = new BridgeEngine({ codex: new CodexAdapter({ command: fixture('codex') }) });
  t.after(async () => { await engine.close(); if (previous == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; await rm(directory, { recursive: true, force: true }); });
  const messages = [{ role: 'user', content: 'hello' }]; let id;
  const first = await engine.complete(normalizeRequest({ model: 'codex/fixture', messages, bridge_persist: true }), { onSession: value => { id = value; } });
  await writeFile(path.join(directory, 'auth.json'), 'synthetic new account');
  await assert.rejects(engine.complete(normalizeRequest({ model: 'codex/fixture', bridge_session_id: id, messages: [...messages, first.message, { role: 'user', content: 'next' }] })), e => e.code === 'account_changed');
  assert.equal(engine.sessions.size, 0); assert.equal(engine.inspect(id)[0].error_code, 'account_changed');
});

test('a Claude worker exiting while idle fails the next turn promptly', async t => {
  const engine = new BridgeEngine({ claude: new ClaudeAdapter({ command: fixture('claude') }) });
  t.after(() => engine.close());
  const messages = [{ role: 'user', content: 'hello' }]; let id;
  const first = await engine.complete(normalizeRequest({ model: 'claude/sonnet', messages, bridge_persist: true }), { onSession: value => { id = value; } });
  const backend = [...engine.sessions][0].backend;
  // Terminate the owned process tree without marking the adapter closed, as if
  // the native worker crashed between HTTP requests.
  const { terminate } = await import('../src/common.mjs');
  await terminate(backend.child);
  const started = Date.now();
  await assert.rejects(engine.complete(normalizeRequest({ model: 'claude/sonnet', bridge_session_id: id, messages: [...messages, first.message, { role: 'user', content: 'next' }] })), /Claude CLI exited/);
  assert.ok(Date.now() - started < 2000); assert.equal(engine.sessions.size, 0);
});
