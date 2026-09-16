import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import { BridgeEngine } from '../src/engine.mjs';
import { EventQueue, BridgeError } from '../src/common.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { normalizeRequest } from '../src/request.mjs';

const token = 'test-token-with-more-than-24-characters';
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file through the client.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
const base = { model: 'codex/test', messages: [{ role: 'user', content: 'Read example.txt' }], tools };

class FakeAdapter {
  started = []; closed = 0;
  async models() { return [{ id: 'codex/test', object: 'model' }]; }
  async start(request, signal) {
    const events = new EventQueue();
    const adapter = this;
    let closed = false;
    const session = {
      events,
      reply(key, content) { events.push({ type: 'text', text: `Result: ${content}` }); events.push({ type: 'done', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }); },
      close() { if (!closed) { closed = true; adapter.closed++; events.end(); } }
    };
    signal.addEventListener('abort', () => session.close(), { once: true });
    this.started.push(session);
    if (request.messages.at(-1).content === 'wait') return session;
    if (request.messages.at(-1).content === 'fail') { events.push({ type: 'error', error: new BridgeError('Synthetic failure') }); return session; }
    events.push({ type: 'text', text: 'Checking…' });
    if (request.activeTools.length) events.push({ type: 'tool', key: 'native-1', name: 'read_file', arguments: { path: 'example.txt' } });
    else events.push({ type: 'done', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
    return session;
  }
}

async function setup(t, options = {}) {
  const adapter = new FakeAdapter();
  const engine = new BridgeEngine({ codex: adapter }, options);
  const server = createBridgeServer(engine, { token, maxBodyBytes: 16384 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await engine.close(); });
  const post = (body, options = {}) => fetch(url + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers }, body: JSON.stringify(body), signal: options.signal });
  return { adapter, engine, server, url, post };
}

function continuation(first, content = 'file contents') {
  return { ...base, messages: [...base.messages, first.message, { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content }] };
}

test('HTTP tool round trip returns before execution and resumes the same session', async t => {
  const { post, adapter, engine } = await setup(t);
  const response = await post(base); assert.equal(response.status, 200);
  const first = (await response.json()).choices[0];
  assert.equal(first.finish_reason, 'tool_calls');
  assert.deepEqual(JSON.parse(first.message.tool_calls[0].function.arguments), { path: 'example.txt' });
  assert.equal(adapter.closed, 0); assert.equal(engine.sessions.size, 1);
  const second = await (await post(continuation(first))).json();
  assert.equal(second.choices[0].message.content, 'Result: file contents');
  assert.equal(second.choices[0].finish_reason, 'stop');
  assert.deepEqual(second.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  assert.equal(adapter.started.length, 1); assert.equal(adapter.closed, 1); assert.equal(engine.calls.size, 0);
});

test('SSE includes text, indexed tool calls, finish reason, and DONE', async t => {
  const { post } = await setup(t);
  const response = await post({ ...base, stream: true });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const data = (await response.text()).split('\n\n').filter(s => s.startsWith('data: ')).map(s => s.slice(6));
  assert.equal(data.pop(), '[DONE]');
  const chunks = data.map(JSON.parse);
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks[1].choices[0].delta.content, 'Checking…');
  assert.equal(chunks[2].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('SSE usage is separate from choices', async t => {
  const { post } = await setup(t);
  const response = await post({ ...base, tools: [], stream: true, stream_options: { include_usage: true } });
  const chunks = (await response.text()).split('\n\n').filter(s => s.startsWith('data: {')).map(s => JSON.parse(s.slice(6)));
  assert.deepEqual(chunks.at(-1).choices, []); assert.equal(chunks.at(-1).usage.total_tokens, 8);
});

test('authentication, origin and host checks protect loopback endpoint', async t => {
  const { url } = await setup(t);
  assert.equal((await fetch(url + '/v1/models')).status, 401);
  assert.equal((await fetch(url + '/health', { headers: { authorization: `Bearer ${token}`, origin: 'https://example.com' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(url + '/health', { headers: { authorization: `Bearer ${token}`, host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(url + '/v1/models', { headers: { authorization: `Bearer ${token}` } })).status, 200);
});

test('changed history cannot hijack a pending continuation', async t => {
  const { post, engine } = await setup(t);
  const first = (await (await post(base)).json()).choices[0];
  const changed = continuation(first); changed.messages[0] = { role: 'user', content: 'Different chat' };
  const response = await post(changed);
  assert.equal(response.status, 409); assert.equal(engine.calls.size, 1);
  assert.equal((await post(continuation(first))).status, 200);
});

test('clients may reformat tool argument JSON without breaking correlation', async t => {
  const { post } = await setup(t);
  const first = (await (await post(base)).json()).choices[0];
  first.message.tool_calls[0].function.arguments = '{\n  "path": "example.txt"\n}';
  assert.equal((await post(continuation(first))).status, 200);
});

test('model and tool changes are rejected during a continuation', async t => {
  const { post } = await setup(t);
  const first = (await (await post(base)).json()).choices[0];
  assert.equal((await post({ ...continuation(first), model: 'codex/other' })).status, 409);
  assert.equal((await post({ ...continuation(first), tools: [] })).status, 409);
});

test('parallel chats retain separate native sessions and tool results', async t => {
  const { post, adapter } = await setup(t);
  const first = await Promise.all([post(base), post(base)]);
  const choices = await Promise.all(first.map(async r => (await r.json()).choices[0]));
  assert.notEqual(choices[0].message.tool_calls[0].id, choices[1].message.tool_calls[0].id);
  const results = await Promise.all(choices.map((c, i) => post(continuation(c, `chat${i}`)).then(r => r.json())));
  assert.equal(results[0].choices[0].message.content, 'Result: chat0');
  assert.equal(results[1].choices[0].message.content, 'Result: chat1');
  assert.equal(adapter.started.length, 2); assert.equal(adapter.closed, 2);
});

test('expired and consumed continuations fail explicitly', async t => {
  const { post, engine, adapter } = await setup(t, { idleMs: 30 });
  const first = (await (await post(base)).json()).choices[0];
  await delay(60);
  assert.equal(engine.sessions.size, 0); assert.equal(adapter.closed, 1);
  assert.equal((await post(continuation(first))).status, 409);
});

test('backpressure on active session count returns 429 without spawning', async t => {
  const { post, adapter } = await setup(t, { maxSessions: 1 });
  assert.equal((await post(base)).status, 200);
  assert.equal((await post(base)).status, 429); assert.equal(adapter.started.length, 1);
});

test('request deadline closes a stuck backend', async t => {
  const { post, engine, adapter } = await setup(t, { requestMs: 30 });
  const response = await post({ ...base, messages: [{ role: 'user', content: 'wait' }] });
  assert.equal(response.status, 504); assert.equal(engine.sessions.size, 0); assert.equal(adapter.closed, 1);
});

test('client disconnect closes the running backend', async t => {
  const { post, engine, adapter } = await setup(t);
  const controller = new AbortController();
  const pending = post({ ...base, messages: [{ role: 'user', content: 'wait' }] }, { signal: controller.signal }).catch(() => null);
  for (let i = 0; i < 50 && !adapter.started.length; i++) await delay(5);
  controller.abort(); await pending;
  for (let i = 0; i < 50 && engine.sessions.size; i++) await delay(5);
  assert.equal(engine.sessions.size, 0); assert.equal(adapter.closed, 1);
});

test('denied tool results pass to the model without bridge execution', async t => {
  const { post } = await setup(t);
  const first = (await (await post(base)).json()).choices[0];
  const second = await (await post(continuation(first, 'User denied this action.'))).json();
  assert.match(second.choices[0].message.content, /User denied/);
});

test('advisory sampling and token limits are disclosed in response headers', async t => {
  const { post } = await setup(t);
  const response = await post({ ...base, max_tokens: 100, temperature: 0 });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-cli-bridge-ignored-parameters'), 'max_tokens, temperature');
});

test('unsupported features and malformed tool histories fail before spawning', async t => {
  const { post, adapter } = await setup(t);
  for (const body of [
    { ...base, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] },
    { ...base, response_format: { type: 'json_object' } },
    { ...base, n: 2 },
    { ...base, messages: [{ role: 'tool', tool_call_id: 'missing', content: 'x' }] },
    { ...base, tools: [...tools, ...tools] }
  ]) assert.equal((await post(body)).status, 400);
  assert.equal(adapter.started.length, 0);
});

test('tool_choice=none suppresses tools and required fails if backend disobeys', async t => {
  const { engine } = await setup(t);
  const response = await engine.complete(normalizeRequest({ ...base, tool_choice: 'none' }));
  assert.equal(response.finish_reason, 'stop');
  const request = normalizeRequest({ ...base, tool_choice: 'required' });
  // A backend that ignores tool_choice must never return a false successful completion.
  engine.adapters.codex.start = async () => { const events = new EventQueue(); events.push({ type: 'done' }); return { events, close() {} }; };
  await assert.rejects(engine.complete(request), e => e.code === 'tool_choice_not_honored');
});

test('backend errors close workers and do not masquerade as assistant text', async t => {
  const { post, engine } = await setup(t);
  const response = await post({ ...base, messages: [{ role: 'user', content: 'fail' }] });
  assert.equal(response.status, 502); assert.equal((await response.json()).error.message, 'Synthetic failure');
  assert.equal(engine.sessions.size, 0);
});

test('oversized bodies return 413 without spawning a worker', async t => {
  const { post, adapter } = await setup(t);
  const response = await post({ ...base, messages: [{ role: 'user', content: 'x'.repeat(20000) }] });
  assert.equal(response.status, 413); assert.equal(adapter.started.length, 0);
});

test('multiple native calls are handed to the client serially without losing results', async t => {
  const { engine, adapter } = await setup(t);
  const received = [];
  adapter.start = async () => {
    const events = new EventQueue();
    events.push({ type: 'tool', key: 'first', name: 'read_file', arguments: { path: 'a' } });
    events.push({ type: 'tool', key: 'second', name: 'read_file', arguments: { path: 'b' } });
    return { events, close() { events.end(); }, reply(key, content) { received.push([key, content]); if (received.length === 2) { events.push({ type: 'text', text: 'Both received' }); events.push({ type: 'done' }); } } };
  };
  const first = await engine.complete(normalizeRequest(base));
  const secondRequest = continuation(first, 'A');
  const second = await engine.complete(normalizeRequest(secondRequest));
  const third = await engine.complete(normalizeRequest({ ...base, messages: [...secondRequest.messages, second.message, { role: 'tool', tool_call_id: second.message.tool_calls[0].id, content: 'B' }] }));
  assert.deepEqual(received, [['first', 'A'], ['second', 'B']]); assert.equal(third.message.content, 'Both received');
});

test('an error after SSE text becomes an error frame, never a success finish', async t => {
  const { post, adapter } = await setup(t);
  adapter.start = async () => {
    const events = new EventQueue(); events.push({ type: 'text', text: 'Partial' }); events.push({ type: 'error', error: new BridgeError('Backend disconnected') });
    return { events, close() { events.end(); } };
  };
  const text = await (await post({ ...base, stream: true })).text();
  assert.match(text, /Backend disconnected/); assert.doesNotMatch(text, /"finish_reason":"stop"/); assert.match(text, /data: \[DONE\]/);
});
