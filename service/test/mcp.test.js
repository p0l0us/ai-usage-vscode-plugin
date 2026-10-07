const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { McpServer, TOOLS, PROTOCOL_VERSIONS, runMcpStdio, serviceSummary, summaryText } = require('../out/mcp');
const { runDaemon } = require('../out/daemon');
const { ServiceClient } = require('../out/client');

const NOW = new Date('2026-09-30T22:00:00Z');
const iso = (hours) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

const profile = (overrides) => ({
  id: 'p-a', name: 'Work', email: 'a@example.com', createdAt: iso(-100), updatedAt: iso(-1), active: true, number: 1, problems: [],
  limit: { readOnly: false, dimmed: false }, hasCredential: true, checkedAt: iso(-0.5),
  usage: { provider: 'claude', title: 'Claude', fetchedAt: iso(-0.5), windows: [
    { label: '5h', usedPercent: 23, resetsAt: iso(2) }, { label: '7d', usedPercent: 56, resetsAt: iso(50) }, { label: '7d Fable', usedPercent: 58, resetsAt: iso(50) }] },
  ...overrides
});

const claudeView = () => ({
  provider: 'claude', title: 'Claude', activeProfileId: 'p-a', activeNumber: 1, nativeUnsaved: false, checkingActive: false, keepAlive: true, autoRotate: true,
  strategySummary: 'leastWaste, proactive, 5h ≥ 95%, 7d ≥ 99.5%',
  profiles: [
    profile({}),
    profile({ id: 'p-b', name: 'Backup', email: 'b@example.com', active: false, number: 2, limit: { readOnly: true, dimmed: false },
      usage: { provider: 'claude', title: 'Claude', fetchedAt: iso(-3), windows: [{ label: '5h', usedPercent: 100, resetsAt: iso(1) }, { label: '7d', usedPercent: 40, resetsAt: iso(30) }] } }),
    profile({ id: 'p-c', name: 'Spare', email: undefined, active: false, number: 3, usage: undefined, checkedAt: undefined, loginProblem: 'OAuth token has expired', hasCredential: true })
  ]
});
const codexView = () => ({ provider: 'codex', title: 'Codex', nativeUnsaved: true, checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '5h ≥ 100%, 7d ≥ 99%', profiles: [] });

/** A client with the few calls the server makes, recording them. */
function fakeClient(config = { enabled: true, switching: true }) {
  const calls = [];
  return {
    calls, connected: true, config: { version: 1, claude: {}, codex: {}, mcp: config },
    close() { this.connected = false; },
    async getConfig() { return this.config; },
    async list(provider) { calls.push(['list', provider]); return provider === 'claude' ? claudeView() : codexView(); },
    async activate(provider, target) {
      calls.push(['activate', provider, target]);
      return { profile: { id: 'p-b', name: 'Backup', email: 'b@example.com' }, level: 'info', message: 'Claude switched to “Backup” (b@example.com).', accountChanged: true, verification: { status: 'match', detail: 'ok' } };
    },
    async readUsage(provider, target) {
      calls.push(['readUsage', provider, target]);
      if (target.ref === 'dead') { return { profile: { id: 'p-c', name: 'Spare' }, usageError: 'OAuth token has expired' }; }
      return { profile: { id: 'p-b', name: 'Backup', email: 'b@example.com' }, usage: { provider, title: 'Claude', fetchedAt: iso(0), windows: [{ label: '5h', usedPercent: 12, resetsAt: iso(4) }, { label: '7d', usedPercent: 41, resetsAt: iso(100) }] } };
    },
    async rotateNow(provider) { calls.push(['rotate', provider]); return { switched: false, reason: 'the active account is below every threshold', activeProfileId: 'p-a', activeProfileName: 'Work' }; }
  };
}

const server = (client) => new McpServer({ connect: async () => client, version: '9.9.9', now: () => NOW });
const call = (mcp, id, method, params) => mcp.handle({ jsonrpc: '2.0', id, method, params });
const tool = (mcp, name, args) => call(mcp, 7, 'tools/call', { name, arguments: args }).then((response) => response.result);

test('initialize negotiates the protocol version, names the server and gives instructions', async () => {
  const mcp = server(fakeClient());
  let response = await call(mcp, 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } });
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, '2025-03-26', 'a supported version is echoed');
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  assert.equal(response.result.serverInfo.name, 'ai-usage');
  assert.equal(response.result.serverInfo.version, '9.9.9');
  assert.match(response.result.instructions, /list_accounts/);
  response = await call(mcp, 2, 'initialize', { protocolVersion: '1999-01-01' });
  assert.equal(response.result.protocolVersion, PROTOCOL_VERSIONS[0], 'an unknown version gets the newest one');
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined, 'notifications are not answered');
  assert.deepEqual((await call(mcp, 3, 'ping')).result, {});
  response = await call(mcp, 4, 'resources/list');
  assert.equal(response.error.code, -32601);
  response = await mcp.handle({ jsonrpc: '2.0', id: 5 });
  assert.equal(response.error.code, -32600);
});

test('tools/list offers the four tools with schemas and annotations, without the switching tools when switching is off', async () => {
  let response = await call(server(fakeClient()), 1, 'tools/list');
  assert.deepEqual(response.result.tools.map((entry) => entry.name), ['list_accounts', 'refresh_usage', 'switch_account', 'rotate_account']);
  for (const entry of response.result.tools) {
    assert.equal(entry.inputSchema.type, 'object');
    assert.equal(typeof entry.annotations.readOnlyHint, 'boolean');
    assert.ok(!('switching' in entry), 'the internal flag is not sent');
  }
  assert.deepEqual(response.result.tools[1].inputSchema.required, ['service', 'profile']);
  response = await call(server(fakeClient({ enabled: true, switching: false })), 1, 'tools/list');
  assert.deepEqual(response.result.tools.map((entry) => entry.name), ['list_accounts', 'refresh_usage']);
  assert.equal(TOOLS.filter((entry) => entry.switching).length, 2);
});

test('list_accounts answers with a readable text and structured content per service, and can be limited to one', async () => {
  const client = fakeClient();
  const mcp = server(client);
  const result = await tool(mcp, 'list_accounts', {});
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, 'text');
  const text = result.content[0].text;
  assert.match(text, /^Claude: active “Work” \(#1\) · keep-alive on · rotation on \(leastWaste, proactive/m);
  assert.match(text, /#1 “Work” a@example.com \[active\]: 5h 23% \(resets in 2h\) · 7d 56% \(resets in 2d\) · 7d Fable 58% \(resets in 2d\) · checked 2026-09-30T21:30:00.000Z/);
  assert.match(text, /#2 “Backup” b@example.com \[at its limit\]: 5h 100% \(resets in 1h\)/);
  assert.match(text, /#3 “Spare” \[login problem: Login expired[^\]]*\]: no reading yet/);
  assert.match(text, /Codex: active none \(the current login is not a saved profile\) · keep-alive off · rotation off \(5h ≥ 100%, 7d ≥ 99%\)\n {2}no saved profiles/);
  const [claude, codex] = result.structuredContent.services;
  assert.equal(claude.service, 'claude');
  assert.deepEqual(claude.activeProfile, { id: 'p-a', name: 'Work', number: 1 });
  assert.deepEqual(claude.profiles.map((entry) => [entry.number, entry.usable, entry.atLimit, Boolean(entry.loginProblem)]), [[1, true, false, false], [2, false, true, false], [3, false, false, true]]);
  assert.deepEqual(claude.profiles[0].usage.windows[0], { label: '5h', usedPercent: 23, resetsAt: iso(2), resetsIn: '2h' });
  assert.equal(claude.profiles[2].usage, undefined);
  assert.deepEqual(codex.profiles, []);
  assert.ok(!JSON.stringify(result).includes('credential'), 'no login material leaves the service');
  client.calls.length = 0;
  const only = await tool(mcp, 'list_accounts', { service: 'codex' });
  assert.deepEqual(client.calls, [['list', 'codex']]);
  assert.equal(only.structuredContent.services.length, 1);
  const bad = await call(mcp, 8, 'tools/call', { name: 'list_accounts', arguments: { service: 'copilot' } });
  assert.equal(bad.error.code, -32602);
  assert.equal((await call(mcp, 9, 'tools/call', { name: 'nothing' })).error.code, -32602);
});

test('the switches gate every call: a turned-off server and turned-off switching answer with a tool error that says what to do', async () => {
  const off = server(fakeClient({ enabled: false, switching: true }));
  let result = await tool(off, 'list_accounts', {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /turned off.*aiUsage\.mcp\.enabled.*ai-usage config mcp\.enabled true/);
  const readOnly = fakeClient({ enabled: true, switching: false });
  const reader = server(readOnly);
  result = await tool(reader, 'switch_account', { service: 'claude', profile: 'Backup' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Switching accounts through MCP is turned off/);
  result = await tool(reader, 'rotate_account', { service: 'claude' });
  assert.equal(result.isError, true);
  assert.deepEqual(readOnly.calls, [], 'nothing reached the service');
  result = await tool(reader, 'list_accounts', { service: 'claude' });
  assert.equal(result.isError, undefined, 'the usage tools still work');
});

test('switch_account, rotate_account and refresh_usage pass the reference through and report the outcome', async () => {
  const client = fakeClient();
  const mcp = server(client);
  let result = await tool(mcp, 'switch_account', { service: 'claude', profile: ' 2 ' });
  assert.deepEqual(client.calls.at(-1), ['activate', 'claude', { ref: '2' }]);
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Claude switched to “Backup” (b@example.com).');
  assert.equal(result.structuredContent.accountChanged, true);
  assert.equal(result.structuredContent.profile.name, 'Backup');
  result = await tool(mcp, 'rotate_account', { service: 'claude' });
  assert.equal(result.content[0].text, 'Claude not rotated: the active account is below every threshold.');
  assert.equal(result.structuredContent.switched, false);
  result = await tool(mcp, 'refresh_usage', { service: 'claude', profile: 'Backup' });
  assert.deepEqual(client.calls.at(-1), ['readUsage', 'claude', { ref: 'Backup' }]);
  assert.match(result.content[0].text, /^Claude profile “Backup”: 5h 12% \(resets in 4h\) · 7d 41% \(resets in 4d\) · read /);
  assert.equal(result.structuredContent.usage.windows[1].resetsIn, '4d');
  result = await tool(mcp, 'refresh_usage', { service: 'claude', profile: 'dead' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Claude profile “Spare”: Login expired/);
  const invalid = await call(mcp, 3, 'tools/call', { name: 'switch_account', arguments: { service: 'claude' } });
  assert.equal(invalid.error.code, -32602);
  assert.match(invalid.error.message, /profile must name a saved profile/);
});

test('a service that cannot be reached is a tool error, and the next call connects again', async () => {
  let attempts = 0;
  const client = fakeClient();
  const mcp = new McpServer({ version: '1', now: () => NOW, connect: async () => { attempts++; if (attempts === 1) { throw new Error('The account service is not running.'); } return client; } });
  let result = await tool(mcp, 'list_accounts', {});
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'The account service is not running.');
  result = await tool(mcp, 'list_accounts', { service: 'claude' });
  assert.equal(result.isError, undefined);
  assert.equal(attempts, 2);
  const listed = await call(mcp, 2, 'tools/list');
  assert.equal(listed.result.tools.length, 4, 'the tool list does not need the service');
});

test('summaries describe a profile without a reading and keep model-scoped windows', () => {
  const summary = serviceSummary(claudeView(), NOW);
  assert.equal(summary.profiles[0].usage.windows.length, 3);
  assert.equal(summary.profiles[0].modelLimited, false);
  assert.match(summaryText({ ...summary, profiles: [] }), /no saved profiles/);
});

/** Feeds lines to the stdio server and collects the answers, one JSON document per line. */
function stdio(options) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  const waiting = [];
  let rest = '';
  output.on('data', (chunk) => {
    rest += String(chunk);
    let newline;
    while ((newline = rest.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(rest.slice(0, newline)));
      rest = rest.slice(newline + 1);
      if (waiting.length) { waiting.shift()(); }
    }
  });
  const done = runMcpStdio({ ...options, input, output });
  const next = () => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve) => waiting.push(() => resolve(lines.shift())));
  return { send: (message) => input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`), next, end: () => { input.end(); return done; } };
}

test('over stdio: one message per line, parse errors are answered, batches are answered as batches, and the end of the input ends the server', async () => {
  const client = fakeClient();
  const io = stdio({ connect: async () => client, version: '1', now: () => NOW });
  io.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal((await io.next()).result.protocolVersion, '2025-06-18');
  io.send('{not json');
  const parse = await io.next();
  assert.equal(parse.error.code, -32700);
  assert.equal(parse.id, null);
  io.send([{ jsonrpc: '2.0', id: 2, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
  const batch = await io.next();
  assert.ok(Array.isArray(batch));
  assert.deepEqual(batch, [{ jsonrpc: '2.0', id: 2, result: {} }]);
  io.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_accounts', arguments: { service: 'claude' } } });
  assert.match((await io.next()).result.content[0].text, /^Claude: active “Work”/);
  assert.equal(await io.end(), 0);
  assert.equal(client.connected, false, 'the service connection is closed with the input');
});

test('end to end: an agent lists the saved profiles of a running service and switches by number', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-mcp-'));
  const home = path.join(root, 'home');
  const claudeHome = path.join(root, 'claude'); fs.mkdirSync(claudeHome);
  const codexHome = path.join(root, 'codex'); fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 9999999999999 } }));
  const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  const daemon = runDaemon({ home, version: 'mcp-test' });
  t.after(async () => {
    try { const client = await ServiceClient.connect({ home, client: 'test' }); await client.shutdown(); client.close(); } catch { /* Already stopped. */ }
    await daemon.catch(() => undefined);
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const connect = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await ServiceClient.connect({ home, client: 'mcp-test' }); }
      catch (error) { if (attempt > 40) { throw error; } await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  };
  const admin = await connect();
  t.after(() => admin.close());
  assert.equal((await admin.saveNative('claude', { name: 'Work' })).status, 'saved');
  assert.equal((await admin.importCredential('claude', 'Backup', { claudeAiOauth: { accessToken: 'b', refreshToken: 'r-b' } })).status, 'saved');
  const io = stdio({ connect, version: 'mcp-test' });
  io.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_accounts' } });
  let response = await io.next();
  assert.equal(response.result.isError, true, 'off by default');
  assert.match(response.result.content[0].text, /turned off/);
  await admin.setConfig({ 'mcp.enabled': true });
  io.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_accounts', arguments: { service: 'claude' } } });
  response = await io.next();
  assert.equal(response.result.isError, undefined, response.result.content[0].text);
  const claude = response.result.structuredContent.services[0];
  assert.deepEqual(claude.profiles.map((entry) => [entry.number, entry.name, entry.active, entry.usable]), [[1, 'Work', true, true], [2, 'Backup', false, true]]);
  io.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'switch_account', arguments: { service: 'claude', profile: '2' } } });
  response = await io.next();
  assert.equal(response.result.isError, undefined, response.result.content[0].text);
  assert.match(response.result.content[0].text, /switched to “Backup”/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(claudeHome, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken, 'b', 'the native login changed');
  await admin.setConfig({ 'mcp.switching': false });
  io.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'switch_account', arguments: { service: 'claude', profile: '1' } } });
  response = await io.next();
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Switching accounts through MCP is turned off/);
  io.send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
  response = await io.next();
  assert.deepEqual(response.result.tools.map((entry) => entry.name), ['list_accounts', 'refresh_usage']);
  assert.equal(await io.end(), 0);
});
