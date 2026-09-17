const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const http = require('node:http');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const settings = new Map();
const opened = []; const terminals = []; const copied = []; const commands = [];
let installed = true;
const vscode = {
  env: { uriScheme: 'vscode-insiders', asExternalUri: async uri => uri, openExternal: async uri => { opened.push(uri.toString()); return true; }, clipboard: { writeText: async text => copied.push(text) } },
  extensions: { getExtension: () => installed ? { activate: async () => {} } : undefined },
  commands: { executeCommand: async (...args) => commands.push(args) },
  workspace: { workspaceFolders: [], getConfiguration: section => ({
    get: (key, fallback) => settings.get(`${section}.${key}`) ?? fallback,
    update: async (key, value) => { settings.set(`${section}.${key}`, value); }
  }) },
  ConfigurationTarget: { Global: 1 },
  window: { createTerminal: options => { terminals.push(options); return { show() {} }; } },
  Uri: { parse: value => {
    const url = new URL(value);
    return { authority: url.hostname, path: url.pathname, with({ scheme }) { return vscode.Uri.parse(value.replace(/^[^:]+/, scheme)); }, toString: () => url.toString() };
  } },
  CancellationError: class extends Error {}
};
const original = Module._load;
Module._load = function (id, ...args) { return id === 'vscode' ? vscode : original.call(this, id, ...args); };
const integration = require('../out/bridgeIntegration');
const agents = require('../out/bridgeAgents');
const { sessionHeader, stripSessionFooter, resumeCommand } = require('../out/bridgeSessionLinks');
Module._load = original;

async function setup(t, provider) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge session UI '));
  const tokenFile = path.join(directory, 'token'); await writeFile(tokenFile, 'test-private-token');
  const id = '11111111-1111-1111-1111-111111111111';
  const session = { id, model: `${provider}/test`, backend: provider, native_session_id: 'native-session', persisted: true, released: true, cwd: directory,
    launch: { cli: { command: '/custom/cli executable', args: [provider === 'claude' ? '--resume' : 'resume', 'native-session'], cwd: directory },
      extension_url: provider === 'claude' ? 'vscode://anthropic.claude-code/open?session=native-session' : 'vscode://openai.chatgpt/local/native-session' } };
  const updates = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-private-token');
    if (req.url === '/v1/session-settings') {
      assert.equal(req.method, 'PUT'); let body = ''; for await (const chunk of req) body += chunk;
      updates.push(JSON.parse(body)); res.end('{}');
    } else if (req.url === `/v1/sessions/${id}/graph`) { res.end(JSON.stringify({ data: [session, ...(session.testBranches || [])] }));
    } else { assert.equal(req.url, `/v1/sessions/${id}`); res.end(JSON.stringify(session)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  settings.set('aiUsage.bridge.url', `http://127.0.0.1:${server.address().port}`);
  settings.set('aiUsage.bridge.tokenFile', tokenFile);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: directory } }];
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true }); settings.clear();
    opened.length = terminals.length = copied.length = commands.length = 0; installed = true;
  });
  return { session, updates };
}

for (const provider of ['codex', 'claude']) {
  test(`${provider} settings gate CLI and extension actions independently, including stale selections`, async t => {
    const { session, updates } = await setup(t, provider);
    assert.ok(!integration.sessionActions(session).includes('Open in CLI'));
    settings.set(`aiUsage.bridge.${provider}.persistSessions`, true);
    settings.set(`aiUsage.bridge.${provider}.openInExtension`, true);
    assert.ok(integration.sessionActions(session).includes('Open in VS Code Extension'));
    await integration.openSession(session.id, 'copyLink');
    assert.match(copied[0], /^vscode-insiders:/);
    await integration.openSession(session.id, 'extension');
    assert.equal(opened.length, provider === 'claude' ? 0 : 1);
    if (provider === 'claude') assert.deepEqual(commands, [
      ['claude-vscode.sidebar.open'],
      ['claude-vscode.editor.open', 'native-session', undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' }]
    ]);
    else assert.deepEqual(commands, [['chatgpt.openSidebar']]);
    await assert.rejects(integration.openSession(session.id, 'cli'), /cannot be opened/);
    settings.set(`aiUsage.bridge.${provider}.openInCli`, true);
    await integration.openSession(session.id, 'cli');
    assert.deepEqual(terminals[0], { name: `${provider} session`, shellPath: '/custom/cli executable', shellArgs: session.launch.cli.args, cwd: session.cwd });
    assert.equal(updates.at(-1)[provider].persistSessions, true);
    assert.equal(updates.at(-1)[provider].sessionDirectory, session.cwd);
    assert.equal(updates.at(-1)[provider === 'codex' ? 'claude' : 'codex'].persistSessions, false);
    settings.set(`aiUsage.bridge.${provider}.openInExtension`, false);
    await assert.rejects(integration.openSession(session.id, 'extension'), /cannot be opened/);
    session.released = false;
    await assert.rejects(integration.openSession(session.id, 'cli'), /still running/);
    assert.equal(terminals.length, 1); assert.equal(opened.length, provider === 'claude' ? 0 : 1);
  });
}

test('Claude opening checks the extension and workspace before dispatching a URI', async t => {
  const { session } = await setup(t, 'claude');
  settings.set('aiUsage.bridge.claude.openInExtension', true);
  installed = false;
  await assert.rejects(integration.openSession(session.id, 'extension'), /Install.*Claude/);
  installed = true; vscode.workspace.workspaceFolders = [];
  await assert.rejects(integration.openSession(session.id, 'extension'), /Open the session folder/);
  assert.equal(opened.length, 0);
  await integration.openSession(session.id, 'copyLink'); assert.equal(copied.length, 1);
});

test('explicit session directory overrides workspace defaults, with no arbitrary multi-root selection', async t => {
  const { updates } = await setup(t, 'claude');
  settings.set('aiUsage.bridge.claude.sessionDirectory', '/explicit/saved-workspace');
  await integration.syncSessionSettings();
  assert.equal(updates.at(-1).claude.sessionDirectory, '/explicit/saved-workspace');
  settings.delete('aiUsage.bridge.claude.sessionDirectory');
  vscode.workspace.workspaceFolders.push({ uri: { fsPath: '/second/workspace' } });
  await integration.syncSessionSettings();
  assert.equal(updates.at(-1).claude.sessionDirectory, '');
});

test('chat header honors switches and identity, routes to this host, and renders before worker release without markers', async t => {
  const { session } = await setup(t, 'codex');
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const footer = () => sessionHeader(session, 'codex/test', token);
  assert.equal(await footer(), '');
  settings.set('aiUsage.bridge.codex.openInCli', true);
  let text = await footer();
  assert.match(text, /Open in CLI/); assert.doesNotMatch(text, /Open in Codex chat/);
  assert.equal(stripSessionFooter(text + 'Answer'), 'Answer');
  assert.doesNotMatch(text, /<!--/);
  settings.set('aiUsage.bridge.codex.openInCli', false);
  settings.set('aiUsage.bridge.codex.openInExtension', true);
  text = await footer();
  assert.doesNotMatch(text, /Open in CLI/);
  assert.ok(text.includes(`vscode-insiders://p0l0us.ai-usage-vscode-plugin/sessions/${session.id}/extension`));
  session.persisted = false; assert.equal(await footer(), ''); session.persisted = true;
  session.released = false; assert.match(await footer(), /Open in Codex chat/); session.released = true;
  session.model = 'codex/other'; assert.equal(await footer(), ''); session.model = 'codex/test';
  token.isCancellationRequested = true; assert.equal(await footer(), '');
  assert.equal(await sessionHeader({ ...session, id: '../sessions' }, 'codex/test', token), '');
  assert.equal(stripSessionFooter('A normal answer mentioning Open in CLI'), 'A normal answer mentioning Open in CLI');
});

test('copyable CLI command preserves shell metacharacters as literal arguments', () => {
  const { spawnSync } = require('node:child_process');
  const value = "space ' quote `tick` $(printf unwanted); &";
  const cli = { cwd: os.tmpdir(), command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', value] };
  if (process.platform !== 'win32') {
    const result = spawnSync('/bin/sh', ['-c', resumeCommand(cli, 'linux')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [value]);
  }
  assert.match(resumeCommand(cli, 'win32'), /Set-Location -LiteralPath.*if \(\$\?\) \{ & /);
  assert.equal(resumeCommand({ ...cli, command: 'bad\ncommand' }), '');
});

test('routed chat links open the exact Claude session in the preferred sidebar and reject active or invalid sessions', async t => {
  const { session } = await setup(t, 'claude');
  settings.set('aiUsage.bridge.claude.openInExtension', true);
  const uri = vscode.Uri.parse(`vscode-insiders://p0l0us.ai-usage-vscode-plugin/sessions/${session.id}/extension`);
  session.released = false;
  await assert.rejects(integration.handleSessionUri(uri), /still running/);
  assert.equal(commands.length, 0);
  session.released = true;
  await integration.handleSessionUri(uri);
  assert.equal(settings.get('claudeCode.preferredLocation'), 'sidebar');
  assert.deepEqual(commands, [
    ['claude-vscode.sidebar.open'],
    ['claude-vscode.editor.open', 'native-session', undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' }]
  ]);
  assert.equal(opened.length, 0); // No OS URL dispatch to another window or editor tab.
  for (const value of [`vscode://wrong.extension/sessions/${session.id}/extension`,
    `vscode://p0l0us.ai-usage-vscode-plugin/sessions/${session.id}/execute`,
    'vscode://p0l0us.ai-usage-vscode-plugin/sessions/not-an-id/cli']) {
    await assert.rejects(integration.handleSessionUri(vscode.Uri.parse(value)), /Invalid session link/);
  }
  assert.equal(commands.length, 2);
});

test('chat links preserve the remote routing supplied by VS Code', async t => {
  const { session } = await setup(t, 'claude');
  settings.set('aiUsage.bridge.claude.openInExtension', true);
  const oldResolve = vscode.env.asExternalUri;
  vscode.env.asExternalUri = async uri => vscode.Uri.parse(uri.toString() + '?windowId=remote-window');
  t.after(() => { vscode.env.asExternalUri = oldResolve; });
  const header = await sessionHeader(session, session.model, { isCancellationRequested: false });
  assert.ok(header.includes(`/sessions/${session.id}/extension?windowId=remote-window`));
  assert.equal(stripSessionFooter(header + 'Answer'), 'Answer');
  assert.equal(stripSessionFooter(`Answer\n\n<!-- ai-usage-session:${session.id} -->\nold controls\n<!-- /ai-usage-session -->`), 'Answer');
});

test('agent links open a metadata map inside Copilot and preserve the input draft', async t => {
  const { session } = await setup(t, 'claude');
  for (const suffix of ['agents', 'agent/tool-1']) {
    await integration.handleSessionUri(vscode.Uri.parse(await agents.sessionLink(session.id, suffix)));
  }
  assert.deepEqual(commands, [
    ['workbench.action.chat.open', { query: `@aiusage /agents ${session.id}`, preserveInput: true }],
    ['workbench.action.chat.open', { query: `@aiusage /agents ${session.id} tool-1`, preserveInput: true }]
  ]);
  await assert.rejects(agents.sessionLink(session.id, 'agent/../../execute'), /Invalid/);
});

test('agent map links branches and Claude details retain the parent resume route', async t => {
  const { session } = await setup(t, 'claude');
  settings.set('aiUsage.bridge.claude.openInExtension', true);
  session.status = 'completed';
  session.subagents = [{ id: 'native-child', tool_call_id: 'tool-1', native_session_id: 'native-child',
    label: 'Review [unsafe](command:bad) | code', status: 'completed', summary: 'A result\n```\n[do not execute](command:bad)' }];
  session.testBranches = [{ id: '22222222-2222-2222-2222-222222222222', model: 'claude/test', status: 'completed', parent_id: session.id }];
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const map = await agents.agentMap(session.id, token);
  assert.match(map, /Agent map/); assert.match(map, /Branch 22222222/);
  assert.ok(map.includes(`/sessions/${session.id}/agent/tool-1`));
  assert.ok(map.includes('Review \\[unsafe\\]\\(command:bad\\) \\| code'));
  const detail = await agents.agentMap(`${session.id} tool-1`, token);
  assert.match(detail, /Resume agent native-child/);
  assert.match(detail, /````text\nA result/);
  assert.ok(detail.includes(`/sessions/${session.id}/extension`));
  assert.doesNotMatch(detail, /session=native-child/);
  await assert.rejects(agents.agentMap(`${session.id} unknown`, token), /no longer available/);
});

test('Codex child opening revalidates ownership, release and settings and opens its exact native thread', async t => {
  const { session } = await setup(t, 'codex');
  const native = '33333333-3333-3333-3333-333333333333';
  settings.set('aiUsage.bridge.codex.openInExtension', true);
  settings.set('aiUsage.bridge.codex.openInCli', true);
  session.subagents = [{ id: native, native_session_id: native, status: 'completed' }];
  const uri = vscode.Uri.parse(await agents.sessionLink(session.id, `agent/${native}/extension`));
  await integration.handleSessionUri(uri);
  assert.equal(opened[0], `vscode-insiders://openai.chatgpt/local/${native}`);
  await integration.openSession(session.id, 'cli', native);
  assert.deepEqual(terminals[0].shellArgs, ['resume', native]);
  await assert.rejects(integration.openSession(session.id, 'extension', 'not-owned'), /cannot be opened/);
  session.released = false;
  await assert.rejects(integration.handleSessionUri(uri), /still running/);
  assert.equal(opened.length, 1);
});

test('subagent presentation lines strip cleanly from history including remote routing', async t => {
  const { session } = await setup(t, 'codex');
  const child = { id: 'child-1', tool_call_id: 'tool-1', label: 'Child', status: 'running' };
  const notice = await agents.subagentNotice(session.id, child);
  assert.equal(stripSessionFooter('before' + notice + 'after'), 'beforeafter');
  assert.equal(stripSessionFooter(notice + notice + 'answer'), 'answer');
  const encoded = notice.replace(`/sessions/${session.id}/agent/tool-1`, `%2Fsessions%2F${session.id}%2Fagent%2Ftool-1`);
  assert.equal(stripSessionFooter(encoded + 'answer'), 'answer');
  assert.equal(await agents.subagentNotice(session.id, { ...child, tool_call_id: '../bad' }), '');
  assert.equal(stripSessionFooter('**Subagent:** a normal answer'), '**Subagent:** a normal answer');
});
