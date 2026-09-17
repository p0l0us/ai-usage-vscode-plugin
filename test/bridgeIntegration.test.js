const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const http = require('node:http');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const settings = new Map();
const registered = { commands: new Map(), tools: new Map(), participants: new Map() };
const disposable = { dispose() {} };
const vscode = {
  window: { registerUriHandler: handler => { registered.uriHandler = handler; return disposable; } },
  version: 'test', env: { remoteName: 'ssh-remote' }, extensions: { getExtension: () => ({}) },
  workspace: { onDidChangeConfiguration: () => disposable, getConfiguration: section => ({ get: (key, fallback) => settings.get(section ? section + '.' + key : key) ?? fallback }) },
  lm: { selectChatModels: async () => [{ id: 'codex/test', vendor: 'customendpoint' }], registerTool: (name, tool) => { registered.tools.set(name, tool); return disposable; } },
  commands: { registerCommand: (name, callback) => { registered.commands.set(name, callback); return disposable; } },
  chat: { createChatParticipant: (name, callback) => { registered.participants.set(name, callback); return disposable; } },
  ThemeIcon: class {}, CancellationError: class extends Error {},
  LanguageModelTextPart: class { constructor(value) { this.value = value; } },
  LanguageModelToolResult: class { constructor(content) { this.content = content; } }
};
const original = Module._load;
Module._load = function (id, ...args) { return id === 'vscode' ? vscode : original.call(this, id, ...args); };
const integration = require('../out/bridgeIntegration');
Module._load = original;

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-extension-test-'));
  const tokenFile = path.join(directory, 'token'); await writeFile(tokenFile, 'local-test-token');
  const routes = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-test-token'); routes.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/diagnostics') res.end(JSON.stringify({ backends: [{ backend: 'codex', status: 'ready', models: [{ id: 'codex/test', bridge: { cli_version: '0.154.0', image_input: true } }] }, { backend: 'claude', status: 'error', code: 'subscription_required', message: 'Sign in with Claude.' }] }));
    else if (req.url.endsWith('/subagents')) res.end(JSON.stringify({ data: [], reason: 'Native subagents disabled' }));
    else res.end(JSON.stringify({ id: req.url.split('/').at(-1), status: 'tool_handoff' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  settings.set('aiUsage.bridge.url', `http://127.0.0.1:${server.address().port}`); settings.set('aiUsage.bridge.tokenFile', tokenFile);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); settings.clear(); await rm(directory, { recursive: true, force: true }); });
  return routes;
}

test('integration report validates utility selections, backend login, capabilities, and remote host', async t => {
  const routes = await setup(t);
  settings.set('chat.utilityModel', 'codex/test'); settings.set('chat.utilitySmallModel', 'missing/model');
  const report = await integration.integrationReport();
  assert.match(report, /ssh-remote/); assert.match(report, /chat.utilityModel.*available/);
  assert.match(report, /chat.utilitySmallModel.*not found/); assert.match(report, /subscription_required/);
  assert.match(report, /images yes/); assert.deepEqual(routes, ['/v1/diagnostics']);
  assert.doesNotMatch(report, /local-test-token/);
});

test('metadata tools require an explicit session ID and call only read endpoints', async t => {
  const routes = await setup(t);
  const context = { subscriptions: [] };
  integration.registerBridgeIntegration(context);
  t.after(() => context.subscriptions.forEach(subscription => subscription.dispose()));
  const id = '11111111-1111-1111-1111-111111111111';
  const info = registered.tools.get('aiUsage_get_cli_session_info');
  await assert.rejects(info.invoke({ input: { session_id: '../health' } }), /explicit bridge session ID/);
  const result = await info.invoke({ input: { session_id: id } }); assert.match(result.content[0].value, /tool_handoff/);
  await registered.tools.get('aiUsage_list_cli_subagents').invoke({ input: { session_id: id } });
  assert.deepEqual(routes.filter(route => route !== '/v1/session-settings'), [`/v1/sessions/${id}`, `/v1/sessions/${id}/subagents`]);
  assert.ok(registered.commands.has('aiUsage.checkCopilotIntegration'));
  assert.ok(registered.commands.has('aiUsage.inspectCliSessions'));
  assert.ok(registered.participants.has('aiUsage.bridge'));
});

test('extension refuses remote endpoints before reading or sending a token', async () => {
  settings.set('aiUsage.bridge.url', 'http://example.com');
  await assert.rejects(integration.bridgeGet('/health'), /loopback/); settings.clear();
});

test('cancelling diagnostics releases a stalled model-picker lookup', async t => {
  await setup(t);
  const originalSelect = vscode.lm.selectChatModels;
  vscode.lm.selectChatModels = () => new Promise(() => {});
  t.after(() => { vscode.lm.selectChatModels = originalSelect; });
  const listeners = new Set();
  const token = { isCancellationRequested: false, onCancellationRequested: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; } };
  const work = integration.integrationReport(token);
  await new Promise(resolve => setTimeout(resolve, 20));
  token.isCancellationRequested = true; for (const callback of [...listeners]) callback();
  const report = await work;
  assert.match(report, /Model picker discovery failed/);
  assert.equal(listeners.size, 0);
});
