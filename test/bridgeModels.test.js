const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const http = require('node:http');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const settings = new Map();
class Text { constructor(value) { this.value = value; } }
class Data { constructor(data, mimeType) { this.data = data; this.mimeType = mimeType; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Emitter { listeners = new Set(); event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }; fire() { for (const fn of this.listeners) fn(); } dispose() { this.listeners.clear(); } }
const vscode = {
  env: { uriScheme: 'vscode', asExternalUri: async uri => uri },
  Uri: { parse: value => ({ toString: () => value }) },
  workspace: { getConfiguration: section => ({ get: (key, fallback) => settings.get(`${section}.${key}`) ?? fallback }) },
  LanguageModelTextPart: Text, LanguageModelDataPart: Data, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 }, LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  EventEmitter: Emitter, CancellationError: class extends Error {}
};
const original = Module._load;
Module._load = function (id, ...args) { return id === 'vscode' ? vscode : original.call(this, id, ...args); };
const { BridgeModelProvider, bridgeMessages } = require('../out/bridgeModels');
const { BridgeRuntime } = require('../out/bridgeRuntime');
const { streamBridge } = require('../out/bridgeTransport');
Module._load = original;
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

for (const backend of ['claude', 'codex']) test(`${backend} shows one child link across tool handoff and provider restart without altering native history`, async t => {
  const { modelProvider, engine, directory } = await setup(t, backend);
  const previous = process.env.BYOK_TEST_SUBAGENTS, priorDirectory = process.env.BYOK_TEST_SESSION_DIRECTORY;
  process.env.BYOK_TEST_SUBAGENTS = '1'; process.env.BYOK_TEST_SESSION_DIRECTORY = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.BYOK_TEST_SUBAGENTS; else process.env.BYOK_TEST_SUBAGENTS = previous;
    if (priorDirectory === undefined) delete process.env.BYOK_TEST_SESSION_DIRECTORY; else process.env.BYOK_TEST_SESSION_DIRECTORY = priorDirectory;
  });
  settings.set(`aiUsage.bridge.${backend}.openInExtension`, true);
  await engine.sessionSettings.update({ [backend]: { persistSessions: true, subagentsEnabled: true, sessionDirectory: directory } });
  const [model] = await modelProvider.provideLanguageModelChatInformation({ silent: true }, token);
  const messages = [{ role: 1, content: [new Text('Delegate an echo')] }];
  const options = { toolMode: 1, tools: [{ name: 'external_echo', inputSchema: { type: 'object' } }] };
  const first = [];
  await modelProvider.provideLanguageModelChatResponse(model, messages, options, { report: part => first.push(part) }, token);
  const firstText = first.filter(part => part instanceof Text).map(part => part.value).join('');
  assert.equal((firstText.match(/\*\*CLI session\*\*/g) || []).length, 1);
  assert.equal((firstText.match(/\*\*Subagent:\*\*/g) || []).length, 1);
  assert.match(firstText, /Agent map/);
  const call = first.find(part => part instanceof Call);
  assert.ok(call);
  const restarted = new BridgeModelProvider({ ensure: async () => {} }, { appendLine() {} });
  t.after(() => restarted.dispose());
  const second = [];
  await restarted.provideLanguageModelChatResponse(model, [...messages, { role: 2, content: first },
    { role: 1, content: [new Result(call.callId, [new Text('DONE')])] }], options, { report: part => second.push(part) }, token);
  assert.equal(second.map(part => part.value).join(''), 'DONE');
  assert.ok(engine.inspect()[0].subagents.some(agent => agent.status === 'completed'));
});

async function setup(t, provider) {
  const { BridgeEngine } = await import('../bridge/src/engine.mjs');
  const { CodexAdapter } = await import('../bridge/src/codex.mjs');
  const { ClaudeAdapter } = await import('../bridge/src/claude.mjs');
  const { createBridgeServer } = await import('../bridge/src/server.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-model-test-'));
  const tokenFile = path.join(directory, 'token'); await writeFile(tokenFile, 'test-token-at-least-24-characters');
  const Adapter = provider === 'codex' ? CodexAdapter : ClaudeAdapter;
  const engine = new BridgeEngine({ [provider]: new Adapter({ command: path.resolve(`bridge/test/fixtures/${provider}.mjs`) }) });
  const server = createBridgeServer(engine, { token: 'test-token-at-least-24-characters' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  settings.set('aiUsage.bridge.url', `http://127.0.0.1:${server.address().port}`); settings.set('aiUsage.bridge.tokenFile', tokenFile);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await engine.close(); settings.clear(); await rm(directory, { recursive: true, force: true }); });
  const modelProvider = new BridgeModelProvider({ ensure: async () => {} }, { appendLine() {} });
  t.after(() => modelProvider.dispose());
  return { modelProvider, engine, server, directory };
}

for (const provider of ['codex', 'claude']) {
  test(`${provider} native model provider discovers models and completes a Copilot tool round trip`, async t => {
    const { modelProvider, engine } = await setup(t, provider);
    const models = await modelProvider.provideLanguageModelChatInformation({ silent: true }, token);
    assert.ok(models.length); assert.match(models[0].name, /CLI/);
    assert.equal(models[0].capabilities.toolCalling, true); assert.equal(models[0].capabilities.imageInput, true);
    const messages = [{ role: 1, content: [new Text('Call echo')] }];
    const options = { toolMode: 1, tools: [{ name: 'external_echo', description: 'Echo a value', inputSchema: { type: 'object' } }] };
    const first = [];
    await modelProvider.provideLanguageModelChatResponse(models[0], messages, options, { report: part => first.push(part) }, token);
    const call = first.find(part => part instanceof Call); assert.ok(call); assert.equal(engine.sessions.size, 1);
    const second = [];
    await modelProvider.provideLanguageModelChatResponse(models[0], [...messages,
      { role: 2, content: first }, { role: 1, content: [new Result(call.callId, [new Text('client-owned result')])] }
    ], options, { report: part => second.push(part) }, token);
    assert.equal(second.map(part => part.value).join(''), 'client-owned result');
    assert.equal(engine.sessions.size, 0);
    settings.set('aiUsage.bridge.modelsEnabled', false);
    assert.deepEqual(await modelProvider.provideLanguageModelChatInformation({ silent: true }, token), []);
    await assert.rejects(modelProvider.provideLanguageModelChatResponse(models[0], messages, options, { report() {} }, token), /disabled/);
  });
}

for (const backend of ['codex', 'claude']) {
  test(`${backend} keeps one native session and one header across user turns, image compaction, and restart`, async t => {
    const { modelProvider, engine, directory } = await setup(t, backend);
    const previous = process.env.BYOK_TEST_SESSION_DIRECTORY;
    process.env.BYOK_TEST_SESSION_DIRECTORY = directory;
    t.after(() => { if (previous === undefined) delete process.env.BYOK_TEST_SESSION_DIRECTORY; else process.env.BYOK_TEST_SESSION_DIRECTORY = previous; });
    engine.sessionRecords.file = path.join(directory, 'saved-links.json');
    for (const suffix of ['persistSessions', 'openInCli', 'openInExtension']) settings.set(`aiUsage.bridge.${backend}.${suffix}`, true);
    await engine.sessionSettings.update({ [backend]: { persistSessions: true, openInCli: true, openInExtension: true, sessionDirectory: directory } });
    const [model] = await modelProvider.provideLanguageModelChatInformation({ silent: true }, token);
    const options = { toolMode: 1, modelOptions: { _conversationId: 'chat-one' } };
    const run = async (provider, messages, opts = options) => {
      const parts = []; await provider.provideLanguageModelChatResponse(model, messages, opts, { report: part => parts.push(part) }, token); return parts;
    };
    const initial = [{ role: 1, content: [new Text('First user turn')] }];
    const first = await run(modelProvider, initial);
    assert.match(first[0].value, /^\*\*CLI session\*\*/);
    const original = { ...engine.inspect()[0] };
    const second = await run(modelProvider, [...initial, { role: 2, content: first }, { role: 1, content: [new Text('Follow up')] }]);
    assert.equal(second.map(part => part.value).join(''), 'fixture reply');
    assert.equal(engine.inspect().length, 1);
    assert.equal(engine.inspect()[0].native_session_id, original.native_session_id);
    assert.equal(engine.inspect()[0].released, true);
    // Recreate both provider and persisted bridge metadata. Compaction drops
    // the original header and prompt but keeps Copilot's conversation ID.
    await engine.close();
    engine.discovery = new engine.discovery.constructor(engine.adapters);
    engine.records.clear(); await engine.loadSessionRecords();
    const restarted = new BridgeModelProvider({ ensure: async () => {} }, { appendLine() {} });
    t.after(() => restarted.dispose());
    const { redImage } = await import('../bridge/test/fixtures/images.mjs');
    const compacted = [{ role: 0, content: [new Text('Compacted conversation and updated system context')] },
      { role: 1, content: [new Text('Follow-up image'), new Data(Buffer.from(redImage.split(',')[1], 'base64'), 'image/png')] }];
    const third = await run(restarted, compacted);
    assert.equal(third.map(part => part.value).join(''), 'fixture reply');
    assert.equal(engine.inspect().length, 1);
    assert.equal(engine.inspect()[0].id, original.id);
    assert.equal(engine.inspect()[0].native_session_id, original.native_session_id);
    const other = await run(restarted, initial, { ...options, modelOptions: { _conversationId: 'chat-two' } });
    assert.match(other[0].value, /^\*\*CLI session\*\*/);
    assert.equal(engine.inspect().length, 2);
    assert.notEqual(engine.inspect()[1].id, original.id);
    // Explicit links cannot bind a session already owned by another chat.
    await assert.rejects(run(restarted, [...initial, { role: 2, content: first }, { role: 1, content: [new Text('wrong chat')] }],
      { ...options, modelOptions: { _conversationId: 'chat-three' } }), /another chat/);
  });

  test(`${backend} chats start with their own controls and preserve native tool history without duplicate headers`, async t => {
    const { modelProvider, engine, directory } = await setup(t, backend);
    const previous = process.env.BYOK_TEST_SESSION_DIRECTORY;
    process.env.BYOK_TEST_SESSION_DIRECTORY = directory;
    t.after(() => {
      if (previous === undefined) delete process.env.BYOK_TEST_SESSION_DIRECTORY;
      else process.env.BYOK_TEST_SESSION_DIRECTORY = previous;
    });
    for (const suffix of ['persistSessions', 'openInCli', 'openInExtension']) settings.set(`aiUsage.bridge.${backend}.${suffix}`, true);
    await engine.sessionSettings.update({ [backend]: { persistSessions: true, openInCli: true, openInExtension: true, sessionDirectory: directory } });
    const [model] = await modelProvider.provideLanguageModelChatInformation({ silent: true }, token);
    const messages = [{ role: 1, content: [new Text('Call echo')] }];
    const options = { toolMode: 1, tools: [{ name: 'external_echo', description: 'Echo a value', inputSchema: { type: 'object' } }] };
    const first = [];
    await modelProvider.provideLanguageModelChatResponse(model, messages, options, { report: part => first.push(part) }, token);
    const call = first.find(part => part instanceof Call);
    assert.ok(call);
    const header = first[0].value;
    const record = engine.inspect()[0];
    assert.match(header, /^\*\*CLI session\*\*/);
    assert.ok(header.includes(`/sessions/${record.id}/extension`));
    assert.doesNotMatch(header, /<!--/);
    assert.equal(bridgeMessages([{ role: 2, content: first }])[0].content, '');
    const final = [];
    const restarted = new BridgeModelProvider({ ensure: async () => {} }, { appendLine() {} });
    t.after(() => restarted.dispose());
    await restarted.provideLanguageModelChatResponse(model, [...messages,
      { role: 2, content: first }, { role: 1, content: [new Result(call.callId, [new Text('client-owned result')])] }
    ], options, { report: part => final.push(part) }, token);
    const output = final.map(part => part.value).join('');
    assert.equal(output, 'client-owned result');
    assert.ok(header.includes(record.native_session_id));
    assert.match(header, /\[Open in CLI\]/);
    assert.match(header, backend === 'codex' ? /\[Open in Codex chat\]/ : /\[Open in Claude Code chat\]/);
    // The host may merge text parts when reconstructing history.
    for (const content of [[new Text(header), ...final], [new Text(header + output)]]) {
      assert.equal(bridgeMessages([{ role: 2, content }])[0].content, 'client-owned result');
    }
    const replies = await Promise.all(['chat A', 'chat B'].map(async prompt => {
      const parts = [];
      await modelProvider.provideLanguageModelChatResponse(model, [{ role: 1, content: [new Text(prompt)] }], { toolMode: 1 }, { report: part => parts.push(part) }, token);
      return parts.map(part => part.value).join('');
    }));
    assert.ok(replies.every(reply => reply.startsWith('**CLI session**')));
    const ids = replies.map(reply => reply.match(/\/sessions\/([a-f0-9-]{36})\/extension/)[1]);
    assert.notEqual(ids[0], ids[1]);
    assert.ok(ids.every(id => engine.records.has(id) && id !== record.id));
  });
}

test('message conversion preserves system instructions, image bytes and tool IDs and rejects unsupported parts', () => {
  const converted = bridgeMessages([
    { role: 0, content: [new Text('system')] },
    { role: 1, content: [new Text('image'), new Data(Buffer.from('image bytes'), 'image/png')] },
    { role: 2, content: [new Text('checking'), new Call('call-1', 'tool', { a: 1 })] },
    { role: 1, content: [new Result('call-1', [new Data(Buffer.from('ok'), 'text/plain')])] }
  ]);
  assert.equal(converted[0].role, 'system');
  assert.equal(converted[1].content[1].image_url.url, 'data:image/png;base64,aW1hZ2UgYnl0ZXM=');
  assert.equal(converted[2].tool_calls[0].id, 'call-1'); assert.equal(converted[3].tool_call_id, 'call-1');
  assert.throws(() => bridgeMessages([{ role: 1, content: [{}] }]), /unsupported/);
  assert.throws(() => bridgeMessages([{ role: 1, content: [new Text('extra'), new Result('call-1', [])] }]), /Mixed/);
});

test('provider transport follows the long-task timeout instead of the former 195-second cutoff', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-long-transport-'));
  const tokenFile = path.join(directory, 'token'); await writeFile(tokenFile, 'test-token');
  let response; let accepted;
  const connected = new Promise(resolve => { accepted = resolve; });
  const server = http.createServer((req, res) => {
    req.resume(); response = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'); accepted();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  settings.set('aiUsage.bridge.url', `http://127.0.0.1:${server.address().port}`);
  settings.set('aiUsage.bridge.tokenFile', tokenFile);
  settings.set('aiUsage.bridge.claude.requestTimeoutMinutes', 10);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); settings.clear(); await rm(directory, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const work = streamBridge({ model: 'claude/haiku', messages: [{ role: 'user', content: 'long task' }], stream: true }, () => {}, token);
  await connected;
  t.mock.timers.tick(196000);
  response.end('data: {"choices":[{"delta":{"content":"finished"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  assert.equal((await work).finishReason, 'stop');
});

test('session header is delivered while the answer is still pending, before any answer token', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-early-header-'));
  const tokenFile = path.join(directory, 'token'); await writeFile(tokenFile, 'test-token');
  const id = '11111111-1111-1111-1111-111111111111';
  let releaseAnswer; let reportHeader;
  const headerShown = new Promise(resolve => { reportHeader = resolve; });
  const session = { id, model: 'codex/test', backend: 'codex', persisted: true, released: false,
    native_session_id: 'native-test', cwd: directory, cli_executable: { file: 'codex', args: [] } };
  const server = http.createServer((req, res) => {
    req.resume();
    assert.equal(req.url, '/v1/chat/completions');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-cli-bridge-session-id': id });
    res.write(`data: ${JSON.stringify({ choices: [], bridge_session: session })}\n\n`);
    releaseAnswer = () => res.end('data: {"choices":[{"delta":{"content":"42"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  settings.set('aiUsage.bridge.url', `http://127.0.0.1:${server.address().port}`); settings.set('aiUsage.bridge.tokenFile', tokenFile);
  settings.set('aiUsage.bridge.codex.openInExtension', true);
  const provider = new BridgeModelProvider({ ensure: async () => {} }, { appendLine() {} });
  const parts = [];
  t.after(async () => { releaseAnswer?.(); provider.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); settings.clear(); await rm(directory, { recursive: true, force: true }); });
  const work = provider.provideLanguageModelChatResponse({ id: 'codex/test' }, [{ role: 1, content: [new Text('hello')] }], { toolMode: 1 }, { report: part => { parts.push(part.value); reportHeader(); } }, token);
  let timeout;
  try {
    await Promise.race([headerShown, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Header waited for the answer')), 2000); })]);
    assert.equal(parts.length, 1);
    assert.match(parts[0], /^\*\*CLI session\*\*/);
    assert.doesNotMatch(parts[0], /<!--|42/);
  } finally { clearTimeout(timeout); releaseAnswer?.(); await work; }
  assert.equal(parts[1], '42');
});

test('provider cancellation stops inference and releases the native worker', async t => {
  const { modelProvider, engine } = await setup(t, 'codex');
  const [model] = await modelProvider.provideLanguageModelChatInformation({ silent: true }, token);
  const emitter = new Emitter(); const cancellation = { isCancellationRequested: false, onCancellationRequested: emitter.event };
  const before = engine.records.size;
  cancellation.isCancellationRequested = true;
  await assert.rejects(modelProvider.provideLanguageModelChatResponse(model, [{ role: 1, content: [new Text('hi')] }], { toolMode: 1 }, { report() {} }, cancellation), vscode.CancellationError);
  assert.equal(engine.records.size, before);
});

test('SSE parser accepts split frames and refuses truncated success or error frames', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-stream-test-'));
  const tokenFile = path.join(directory, 'token'); await writeFile(tokenFile, 'test-token');
  let mode = 'complete';
  const server = http.createServer((req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream', 'x-cli-bridge-session-id': '11111111-1111-1111-1111-111111111111' });
    res.write('data: {"choices":[{"delta":{"cont');
    res.write('ent":"hello"},"finish_reason":null}]}\n\n');
    if (mode === 'error') res.end('data: {"error":{"message":"subscription exhausted"}}\n\ndata: [DONE]\n\n');
    else if (mode === 'truncated') res.end();
    else res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  settings.set('aiUsage.bridge.url', `http://127.0.0.1:${server.address().port}`); settings.set('aiUsage.bridge.tokenFile', tokenFile);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); settings.clear(); await rm(directory, { recursive: true, force: true }); });
  const frames = []; const completed = await streamBridge({}, frame => frames.push(frame), token);
  assert.equal(frames[0].choices[0].delta.content, 'hello');
  assert.deepEqual(completed, { sessionId: '11111111-1111-1111-1111-111111111111', finishReason: 'stop' });
  mode = 'truncated'; await assert.rejects(streamBridge({}, () => {}, token), /before completion/);
  mode = 'error'; await assert.rejects(streamBridge({}, () => {}, token), /subscription exhausted/);
});

test('missing or unavailable session metadata does not replace a completed chat answer', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-footer-error-'));
  const tokenFile = path.join(directory, 'token'); await writeFile(tokenFile, 'test-token');
  let mode = 'missing'; const routes = []; const logs = [];
  const server = http.createServer((req, res) => {
    req.resume(); routes.push(req.url);
    if (req.url.startsWith('/v1/sessions/')) { res.writeHead(404); res.end('{}'); return; }
    const headers = { 'content-type': 'text/event-stream' };
    if (mode !== 'missing') headers['x-cli-bridge-session-id'] = mode === 'invalid' ? '../wrong-session' : '11111111-1111-1111-1111-111111111111';
    res.writeHead(200, headers);
    res.end('data: {"choices":[{"delta":{"content":"42"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  settings.set('aiUsage.bridge.url', `http://127.0.0.1:${server.address().port}`); settings.set('aiUsage.bridge.tokenFile', tokenFile);
  settings.set('aiUsage.bridge.codex.openInCli', true);
  const provider = new BridgeModelProvider({ ensure: async () => {} }, { appendLine: line => logs.push(line) });
  t.after(async () => { provider.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); settings.clear(); await rm(directory, { recursive: true, force: true }); });
  for (mode of ['missing', 'invalid', 'unavailable']) {
    const parts = [];
    await provider.provideLanguageModelChatResponse({ id: 'codex/test' }, [{ role: 1, content: [new Text('hello')] }], { toolMode: 1 }, { report: part => parts.push(part) }, token);
    assert.equal(parts.map(part => part.value).join(''), '42');
  }
  assert.deepEqual(routes.filter(route => route.startsWith('/v1/sessions/')), ['/v1/sessions/11111111-1111-1111-1111-111111111111']);
  assert.equal(logs.length, 1); assert.match(logs[0], /Could not add CLI session links/);
});

test('bundled runtime starts both fixture backends and authenticates discovery without inference', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-runtime-test-'));
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  settings.set('aiUsage.bridge.url', `http://127.0.0.1:${port}`); settings.set('aiUsage.bridge.tokenFile', path.join(directory, 'token'));
  for (const provider of ['codex', 'claude']) settings.set(`aiUsage.bridge.${provider}.executable`, path.resolve(`bridge/test/fixtures/${provider}.mjs`));
  const runtime = new BridgeRuntime(path.resolve('.'));
  const provider = new BridgeModelProvider(runtime, { appendLine() {} });
  t.after(async () => { provider.dispose(); runtime.dispose(); settings.clear(); await rm(directory, { recursive: true, force: true }); });
  await Promise.all([runtime.ensure(), runtime.ensure()]);
  const models = await provider.provideLanguageModelChatInformation({ silent: false }, token);
  assert.ok(models.some(model => model.id.startsWith('codex/')));
  assert.ok(models.some(model => model.id.startsWith('claude/')));
  const manifest = require('../package.json');
  assert.ok(manifest.contributes.languageModelChatProviders.some(entry => entry.vendor === 'ai-usage-cli'));
});

test('picker uses a complete catalog on every refresh and retains the healthy backend on partial failure', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-catalog-test-'));
  const tokenFile = path.join(directory, 'token'); await writeFile(tokenFile, 'test-token');
  const routes = []; const logs = []; let failCodex = false;
  const codex = { id: 'codex/test', bridge: { tool_calling: true } };
  const claude = { id: 'claude/sonnet', bridge: { tool_calling: true } };
  const server = http.createServer((req, res) => {
    routes.push(req.url); res.setHeader('content-type', 'application/json');
    // Reproduce the live bug: the fast endpoint always omits Codex, even with
    // both catalogs cached. Complete discovery waits for the slower backend.
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [claude] })); return; }
    setTimeout(() => res.end(JSON.stringify({ backends: [
      failCodex ? { backend: 'codex', status: 'error', code: 'subscription_required', message: 'Sign in to Codex.' }
        : { backend: 'codex', status: 'ready', models: [codex] },
      { backend: 'claude', status: 'ready', models: [claude] }
    ] })), 25);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  settings.set('aiUsage.bridge.url', `http://127.0.0.1:${server.address().port}`); settings.set('aiUsage.bridge.tokenFile', tokenFile);
  const provider = new BridgeModelProvider({ ensure: async () => {} }, { appendLine: line => logs.push(line) });
  t.after(async () => { provider.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); settings.clear(); await rm(directory, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 3; attempt++) {
    await provider.refresh();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assert.deepEqual(models.map(model => model.id), ['codex/test', 'claude/sonnet']);
  }
  assert.ok(routes.every(route => route === '/v1/diagnostics'));
  failCodex = true;
  await provider.refresh();
  assert.deepEqual((await provider.provideLanguageModelChatInformation({ silent: true }, token)).map(model => model.id), ['claude/sonnet']);
  assert.ok(logs.some(line => line.includes('Sign in to Codex')));
  failCodex = false;
  await provider.refresh();
  assert.equal((await provider.provideLanguageModelChatInformation({ silent: true }, token)).length, 2);
});

test('all dynamic models survive provider restart and return before startup, then refresh and persist changes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-model-cache-test-'));
  const tokenFile = path.join(directory, 'token'); await writeFile(tokenFile, 'test-token');
  const cacheFile = path.join(directory, 'global-state.json');
  let catalogs = {
    codex: [{ id: 'codex/future-model', bridge: { display_name: 'Future', image_input: true } },
      { id: 'codex/hidden-model', bridge: { hidden: true } }],
    claude: [{ id: 'claude/future-model[1m]', bridge: { display_name: 'Future Claude', tool_calling: true } }]
  };
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/diagnostics');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ backends: Object.entries(catalogs).map(([backend, models]) => ({ backend, status: 'ready', models })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  settings.set('aiUsage.bridge.url', `http://127.0.0.1:${server.address().port}`);
  settings.set('aiUsage.bridge.tokenFile', tokenFile);
  const providers = []; let release;
  t.after(async () => {
    providers.forEach(provider => provider.dispose()); release?.();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    settings.clear(); await rm(directory, { recursive: true, force: true });
  });
  const storage = state => ({
    get: key => state[key],
    update: async (key, value) => { state[key] = value; await writeFile(cacheFile, JSON.stringify(state)); }
  });
  const first = new BridgeModelProvider({ ensure: async () => {} }, { appendLine() {} }, storage({}));
  providers.push(first);
  const originalModels = await first.provideLanguageModelChatInformation({ silent: false }, token);
  assert.deepEqual(originalModels.map(model => model.id), Object.values(catalogs).flat().map(model => model.id));
  first.dispose();

  // Recreate both provider and storage from serialized data, as on extension restart.
  const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
  let startups = 0; let offline = false;
  const startup = new Promise(resolve => { release = resolve; });
  const restarted = new BridgeModelProvider({ ensure: async () => {
    startups++; if (offline) throw new Error('Bridge unavailable'); await startup;
  } }, { appendLine() {} }, storage(saved));
  providers.push(restarted);
  let changes = 0; restarted.onDidChangeLanguageModelChatInformation(() => changes++);
  let timeout;
  const cached = await Promise.race([
    restarted.provideLanguageModelChatInformation({ silent: false }, token),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Cached picker blocked on startup')), 1000); })
  ]).finally(() => clearTimeout(timeout));
  assert.equal(startups, 1);
  assert.deepEqual(cached.map(model => model.id), originalModels.map(model => model.id));
  assert.ok(cached.every(model => model.detail.includes('cached')));
  assert.deepEqual(cached.map(model => model.capabilities), originalModels.map(model => model.capabilities));
  assert.equal(changes, 0);

  catalogs = { codex: [{ id: 'codex/newly-discovered' }], claude: catalogs.claude };
  release(); await restarted.refresh();
  assert.ok(changes > 0);
  const live = await restarted.provideLanguageModelChatInformation({ silent: false }, token);
  assert.deepEqual(live.map(model => model.id), ['codex/newly-discovered', 'claude/future-model[1m]']);
  assert.ok(live.every(model => !model.detail.includes('cached')));
  await restarted.refresh();
  const { MODEL_CACHE_KEY } = require('../out/bridgeModelCache');
  const refreshed = JSON.parse(await readFile(cacheFile, 'utf8'))[MODEL_CACHE_KEY];
  assert.deepEqual(refreshed.catalogs.codex.models.map(model => model.id), ['codex/newly-discovered']);

  offline = true;
  await assert.rejects(restarted.refresh(), /Bridge unavailable/);
  const retained = await restarted.provideLanguageModelChatInformation({ silent: false }, token);
  assert.deepEqual(retained.map(model => model.id), live.map(model => model.id));
  assert.ok(retained.every(model => model.detail.includes('cached')));
  await assert.rejects(restarted.refresh(), /Bridge unavailable/);
  settings.set('aiUsage.bridge.codex.executable', '/different/codex');
  assert.deepEqual(await restarted.provideLanguageModelChatInformation({ silent: true }, token), []);
});
