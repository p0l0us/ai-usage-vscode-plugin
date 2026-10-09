const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { McpServer, TOOLS, PROTOCOL_VERSIONS, runMcpStdio, serviceSummary, summaryText } = require('../out/mcp');
const { runDaemon } = require('../out/daemon');
const { ServiceClient } = require('../out/client');
const { defaultConfig } = require('../out/configStore');

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
  const configuration = defaultConfig();
  configuration.claude.checkIntervalMinutes = 60; configuration.codex.checkIntervalMinutes = 60; configuration.mcp = config;
  return Object.assign(new EventEmitter(), {
    calls, connected: true, config: configuration,
    close() { if (this.connected) { this.connected = false; this.emit('close'); } },
    status: { cursor: { epoch: 'fixture-epoch', revision: 0 }, configRevision: 0, capturedAt: NOW.toISOString(), lifecycle: 'running', providers: [] },
    async statusSnapshot(filter = {}) {
      calls.push(['statusSnapshot', filter]);
      if (filter.since?.epoch === this.status.cursor.epoch && filter.since.revision === this.status.cursor.revision) return { status: 'unchanged', cursor: { ...this.status.cursor } };
      const snapshot = structuredClone(this.status);
      snapshot.providers = snapshot.providers.filter(row => !filter.providers || filter.providers.includes(row.provider));
      if (filter.accountIds) for (const row of snapshot.providers) { row.accounts = row.accounts.filter(a => filter.accountIds.includes(a.id)); if (!filter.accountIds.includes(row.native.profileId)) row.native = { kind: 'unknown', quota: { state: 'unknown', windows: [], availability: 'unknown' } }; }
      return { status: 'snapshot', snapshot, resync: !!filter.since && filter.since.epoch !== snapshot.cursor.epoch };
    },
    async getConfig() { return this.config; },
    async liveUsage(provider, force = false) {
      calls.push(['liveUsage', provider, force]);
      return { identity: 'opaque', profileId: provider === 'claude' ? 'p-a' : undefined, result: { kind: 'ok', usage: { provider, title: provider, fetchedAt: iso(0), windows: [{ label: '5h', usedPercent: 12, resetsAt: iso(4) }, { label: '7d Fable', usedPercent: 100, resetsAt: iso(20) }] } } };
    },
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
  });
}

const server = (client) => new McpServer({ connect: async () => client, version: '9.9.9', now: () => NOW });
const call = (mcp, id, method, params) => mcp.handle({ jsonrpc: '2.0', id, method, params });
const tool = (mcp, name, args) => call(mcp, 7, 'tools/call', { name, arguments: args }).then((response) => response.result);

test('initialize negotiates the protocol version, names the server and gives instructions', async () => {
  const mcp = server(fakeClient());
  let response = await call(mcp, 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } });
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, '2025-03-26', 'a supported version is echoed');
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false }, resources: { subscribe: true, listChanged: false } });
  assert.equal(response.result.serverInfo.name, 'ai-usage');
  assert.equal(response.result.serverInfo.version, '9.9.9');
  assert.match(response.result.instructions, /list_accounts/);
  response = await call(mcp, 2, 'initialize', { protocolVersion: '1999-01-01' });
  assert.equal(response.result.protocolVersion, PROTOCOL_VERSIONS[0], 'an unknown version gets the newest one');
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined, 'notifications are not answered');
  assert.deepEqual((await call(mcp, 3, 'ping')).result, {});
  response = await call(mcp, 4, 'resources/list');
  assert.equal(response.result.resources.length, 4);
  response = await mcp.handle({ jsonrpc: '2.0', id: 5 });
  assert.equal(response.error.code, -32600);
});

test('tools/list offers the account and cached-status tools with schemas and annotations, without the switching tools when switching is off', async () => {
  let response = await call(server(fakeClient()), 1, 'tools/list');
  assert.deepEqual(response.result.tools.map((entry) => entry.name), ['list_accounts', 'refresh_usage', 'switch_account', 'rotate_account', 'get_usage_status', 'wait_for_usage_updates']);
  for (const entry of response.result.tools) {
    assert.equal(entry.inputSchema.type, 'object');
    assert.equal(typeof entry.annotations.readOnlyHint, 'boolean');
    assert.ok(!('switching' in entry), 'the internal flag is not sent');
  }
  assert.deepEqual(response.result.tools[1].inputSchema.required, ['service']);
  response = await call(server(fakeClient({ enabled: true, switching: false })), 1, 'tools/list');
  assert.deepEqual(response.result.tools.map((entry) => entry.name), ['list_accounts', 'refresh_usage', 'get_usage_status', 'wait_for_usage_updates']);
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
  assert.match(text, /Codex: active none \(the current login is not a saved profile\) · keep-alive off · rotation off \(5h ≥ 100%, 7d ≥ 99%\)\n {2}native active login \(unsaved\): .*\n {2}no saved profiles/);
  const [claude, codex] = result.structuredContent.services;
  assert.equal(claude.service, 'claude');
  assert.deepEqual(claude.activeProfile, { id: 'p-a', name: 'Work', number: 1 });
  assert.deepEqual(claude.profiles.map((entry) => [entry.number, entry.usable, entry.atLimit, Boolean(entry.loginProblem)]), [[1, true, false, false], [2, false, true, false], [3, false, false, true]]);
  assert.deepEqual(claude.profiles[0].usage.windows[0], { label: '5h', usedPercent: 23, resetsAt: iso(2), resetsIn: '2h', scope: 'account' });
  assert.equal(claude.profiles[2].usage, undefined);
  assert.deepEqual(codex.profiles, []);
  assert.ok(!JSON.stringify(result).includes('credential'), 'no login material leaves the service');
  client.calls.length = 0;
  const only = await tool(mcp, 'list_accounts', { service: 'codex' });
  assert.deepEqual(client.calls, [['list', 'codex'], ['liveUsage', 'codex', false]]);
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
  assert.equal(listed.result.tools.length, 6, 'account and cached-status tools are discoverable after reconnect');
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
  return { lines, send: (message) => input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`), next, end: () => { input.end(); return done; } };
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
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude: { enabled: false }, codex: { enabled: false, autoReset: { enabled: false } }, copilot: { enabled: false }, bridge: { autoStart: false } }));
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
  assert.deepEqual(claude.profiles.map((entry) => [entry.number, entry.name, entry.active, entry.usable]), [[1, 'Work', true, false], [2, 'Backup', false, false]]);
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
  assert.deepEqual(response.result.tools.map((entry) => entry.name), ['list_accounts', 'refresh_usage', 'get_usage_status', 'wait_for_usage_updates']);
  assert.equal(await io.end(), 0);
});

test('native unsaved usage exposes freshness/model limits and refreshes without selecting a profile or model', async () => {
  const client = fakeClient(); const mcp = server(client);
  const listed = await tool(mcp, 'list_accounts', { service: 'codex' });
  const summary = listed.structuredContent.services[0];
  assert.equal(summary.nativeUnsaved, true);
  assert.equal(summary.activeUsage.saved, false);
  assert.equal(summary.activeUsage.freshness.state, 'fresh');
  assert.equal(summary.activeUsage.modelLimited, true);
  assert.equal(summary.activeUsage.usage.windows[1].scope, 'model');
  assert.equal(summary.activeUsage.usage.windows[1].model, 'Fable');
  assert.equal(summary.profiles.length, 0);
  const refreshed = await tool(mcp, 'refresh_usage', { service: 'codex' });
  assert.equal(refreshed.isError, undefined);
  assert.ok(client.calls.some(c => c[0] === 'liveUsage' && c[2] === true));
  assert.ok(!client.calls.some(c => ['activate', 'readUsage', 'rotate'].includes(c[0])));
  assert.match(TOOLS.find(t => t.name === 'switch_account').description, /does not select or change a model/);
});

test('missing and failed last-good readings are unknown/stale rather than spare capacity', async () => {
  const client = fakeClient();
  client.liveUsage = async () => ({ identity: 'opaque', result: { kind: 'unavailable', provider: 'codex', reason: 'No native login.' } });
  let result = await tool(server(client), 'refresh_usage', { service: 'codex' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.activeUsage.freshness.state, 'unknown');
  assert.equal(result.structuredContent.activeUsage.usage, undefined);
  client.liveUsage = async () => ({ identity: 'opaque', result: { kind: 'error', provider: 'codex', title: 'Codex', message: 'offline' },
    lastGood: { provider: 'codex', title: 'Codex', fetchedAt: iso(-2), windows: [{ label: '5h', usedPercent: 0 }] } });
  result = await tool(server(client), 'refresh_usage', { service: 'codex' });
  assert.equal(result.structuredContent.activeUsage.freshness.state, 'stale');
  assert.equal(result.structuredContent.activeUsage.status, 'error');
});

test('unavailable or disabled engines offer no tools, and cancellation reaches an active request', async () => {
  const unavailable = new McpServer({ version: 'test', connect: async () => { throw new Error('offline'); } });
  assert.deepEqual((await call(unavailable, 1, 'tools/list')).result.tools, []);
  assert.deepEqual((await call(server(fakeClient({ enabled: false, switching: true })), 1, 'tools/list')).result.tools, []);
  const client = fakeClient(); let started;
  const pending = new Promise(resolve => { started = resolve; });
  client.activate = async (provider, target, options) => {
    started();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled; outcome may be unknown')), { once: true }));
  };
  const mcp = server(client);
  const request = call(mcp, 42, 'tools/call', { name: 'switch_account', arguments: { service: 'codex', profile: 'Work' } });
  await pending;
  await mcp.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } });
  assert.equal((await request).result.isError, true);
});

test('expired resets and absent saved readings cannot advertise spare capacity', () => {
  const { profileSummary, activeUsageSummary } = require('../out/mcp');
  const usage = { provider: 'claude', title: 'Claude', fetchedAt: iso(0), windows: [{ label: '5h', usedPercent: 0, resetsAt: iso(-0.001) }] };
  const saved = profileSummary(profile({ usage }), NOW);
  assert.equal(saved.freshness.state, 'stale');
  assert.equal(saved.usable, false);
  assert.equal(profileSummary(profile({ usage: undefined }), NOW).usable, false);
  const native = activeUsageSummary({ identity: 'opaque', result: { kind: 'ok', usage } }, true, NOW, 60_000);
  assert.equal(native.freshness.state, 'stale');
});

test('each tool uses one live configuration snapshot without retaining it for later calls', async () => {
  const client = fakeClient(); let reads = 0;
  client.getConfig = async () => { reads++; return client.config; };
  const mcp = server(client);
  await tool(mcp, 'list_accounts', { service: 'codex' });
  assert.equal(reads, 1);
  await tool(mcp, 'refresh_usage', { service: 'codex' });
  assert.equal(reads, 2);
  client.config.mcp.enabled = false;
  assert.equal((await tool(mcp, 'list_accounts', {})).isError, true);
  assert.equal(reads, 3);
});

test('MCP rejects malformed envelopes and extra tool arguments before engine actions', async () => {
  const client = fakeClient(); const mcp = server(client);
  assert.equal((await mcp.handle({ jsonrpc: '1.0', id: 1, method: 'ping' })).error.code, -32600);
  assert.equal((await call(mcp, 2, 'tools/call', { name: 'switch_account', arguments: { service: 'codex', profile: 'Work', model: 'gpt-test' } })).error.code, -32602);
  assert.equal((await call(mcp, 3, 'tools/call', { name: 'list_accounts', arguments: [] })).error.code, -32602);
  assert.deepEqual(client.calls, []);
});

test('filtered account lists expose both live policies and reflect user-approved configuration changes without writing them', async () => {
  const client = fakeClient();
  client.config.claude.autoRotate.enabled = true;
  client.config.codex.autoRotate.enabled = true;
  client.config.claude.autoRotate.modelLimits = 'always';
  client.config.claude.autoRotate.weeklyThresholdPercent = 93;
  client.config.codex.autoReset.enabled = true;
  client.config.codex.autoReset.confirmationRequired = true;
  const snapshot = structuredClone(client.config);
  client.patchConfig = async () => { throw new Error('MCP must not change configuration'); };
  client.setConfig = client.patchConfig;
  const mcp = server(client);
  let result = await tool(mcp, 'list_accounts', { service: 'claude' });
  let policy = result.structuredContent.rotationPolicy;
  assert.equal(result.structuredContent.services.length, 1);
  assert.equal(policy.settings['claude.autoRotate.enabled'], true);
  assert.equal(policy.settings['codex.autoRotate.enabled'], true);
  assert.equal(policy.settings['claude.autoRotate.modelLimits'], 'always');
  assert.equal(policy.settings['claude.autoRotate.weeklyThresholdPercent'], 93);
  assert.equal(policy.managedProviderPrerequisites.claude.setting, 'claude.autoRotate.enabled');
  assert.equal(policy.managedProviderPrerequisites.codex.setting, 'codex.autoRotate.enabled');
  assert.equal(policy.managedProviderPrerequisites.claude.currentlyDisabled, false);
  assert.equal(policy.allBuiltInRotationDisabled, false);
  assert.equal(policy.userApprovalRequiredForSettingsChanges, true);
  assert.equal(policy.exclusiveAccountControlGuaranteed, false);
  assert.equal(policy.automaticActions.keepAlive.nativeAccountSelection, false);
  assert.equal(policy.automaticActions.codexEarnedReset.enabled, true);
  assert.equal(policy.automaticActions.codexEarnedReset.confirmationRequired, true);
  assert.equal(policy.automaticActions.codexEarnedReset.nativeAccountSelection, false);
  assert.equal(policy.agentScheduling.engineEventsForwardedToMcp, true);
  assert.equal(policy.agentScheduling.automaticModelWakeupProvided, false);
  assert.match(result.content[0].text, /ask the user.*every managed provider/);
  assert.deepEqual(client.config, snapshot, 'a policy read does not disable rotation or alter settings');
  client.config.claude.autoRotate.enabled = false;
  result = await tool(mcp, 'list_accounts', { service: 'codex' }); policy = result.structuredContent.rotationPolicy;
  assert.equal(policy.managedProviderPrerequisites.claude.currentlyDisabled, true);
  assert.equal(policy.managedProviderPrerequisites.codex.currentlyDisabled, false);
  assert.equal(policy.allBuiltInRotationDisabled, false, 'one disabled provider does not imply both are disabled');
  client.config.codex.autoRotate.enabled = false;
  result = await tool(mcp, 'list_accounts', { service: 'claude' });
  assert.equal(result.structuredContent.rotationPolicy.allBuiltInRotationDisabled, true);
  client.config.claude.autoRotate.enabled = true;
  assert.equal((await tool(mcp, 'list_accounts', {})).structuredContent.rotationPolicy.allBuiltInRotationDisabled, false);
  assert.deepEqual(TOOLS.map(t => t.name), ['list_accounts', 'refresh_usage', 'switch_account', 'rotate_account', 'get_usage_status', 'wait_for_usage_updates']);
});

test('occasional account selection stays allowed with automatic rotation enabled and reports possible override', async () => {
  const client = fakeClient(); client.config.claude.autoRotate.enabled = true;
  const mcp = server(client);
  const result = await tool(mcp, 'switch_account', { service: 'claude', profile: 'Backup' });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.accountChanged, true);
  assert.deepEqual(client.calls, [['activate', 'claude', { ref: 'Backup' }]]);
  assert.match(result.content[0].text, /automatic rotation remains enabled.*select another account later/);
  assert.equal(client.config.claude.autoRotate.enabled, true, 'a deliberate switch never silently disables automatic rotation');
  assert.equal(result.structuredContent.rotationPolicy.settings['claude.autoRotate.enabled'], true);
  client.config.claude.autoRotate.enabled = false;
  const rotated = await tool(mcp, 'rotate_account', { service: 'claude' });
  assert.deepEqual(client.calls.at(-1), ['rotate', 'claude']);
  assert.equal(rotated.structuredContent.selectionMode, 'enginePolicy');
  assert.equal(rotated.structuredContent.rotationPolicy.settings['claude.autoRotate.enabled'], false);
  assert.match(TOOLS.find(t => t.name === 'rotate_account').description, /configured deterministic rotation policy once/);
  assert.match(TOOLS.find(t => t.name === 'switch_account').description, /already-running Codex session needs the account proxy or a restart/);
});

test('MCP guidance and profile facts distinguish general exhaustion from a model-limited fallback', async () => {
  const client = fakeClient();
  const generallyCapable = profile({ limit: { readOnly: false, dimmed: true }, usage: { provider: 'claude', title: 'Claude', fetchedAt: iso(0), windows: [
    { label: '5h', usedPercent: 0, resetsAt: iso(2) }, { label: '7d', usedPercent: 65, resetsAt: iso(24) }, { label: '7d Fable', usedPercent: 100, resetsAt: iso(24) }] } });
  const generallyExhausted = profile({ id: 'exhausted', name: 'Exhausted', number: 2, active: false, limit: { readOnly: true, dimmed: false }, usage: {
    provider: 'claude', title: 'Claude', fetchedAt: iso(0), windows: [{ label: '5h', usedPercent: 100, resetsAt: iso(2) }, { label: '7d Fable', usedPercent: 62, resetsAt: iso(24) }] } });
  client.list = async () => ({ ...claudeView(), profiles: [generallyCapable, generallyExhausted] });
  const mcp = server(client);
  const result = await tool(mcp, 'list_accounts', { service: 'claude' });
  const profiles = result.structuredContent.services[0].profiles;
  assert.deepEqual(profiles.map(p => [p.usable, p.atLimit, p.modelLimited]), [[true, false, true], [false, true, false]]);
  assert.equal(profiles[0].usage.windows.find(w => w.model === 'Fable').usedPercent, 100);
  const initialized = await call(mcp, 99, 'initialize', {});
  const instructions = initialized.result.instructions;
  assert.match(instructions, /ASK THE USER.*permission to disable/);
  assert.match(instructions, /Managing both requires both settings false/);
  assert.match(instructions, /before later decisions/);
  assert.match(instructions, /generally eligible fallback.*Fable remains limited/);
  assert.match(instructions, /never select a generally exhausted account solely for Fable headroom/);
  assert.match(instructions, /policy cutoffs.*not proof that all quota is exhausted/);
  assert.match(instructions, /oscillating among model-limited accounts/);
  assert.match(instructions, /no.*configuration-write tool/);
});

for (const mode of ['background', 'embedded']) test(`${mode}: MCP reads the shared engine's live rotation prerequisites across configuration toggles`, async t => {
  const { runtimeFixture } = require('../../test/helpers/runtimeHost');
  const fixture = await runtimeFixture(t, mode);
  await fixture.client.setConfig({ 'mcp.enabled': true, 'claude.autoRotate.enabled': true, 'codex.autoRotate.enabled': true });
  const mcp = new McpServer({ connect: () => fixture.connect('w20-mcp'), version: 'w20-fixture' });
  fixture.cleanups.push(() => mcp.close());
  let result = await tool(mcp, 'list_accounts', { service: 'claude' });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.rotationPolicy.settings['codex.autoRotate.enabled'], true);
  await fixture.client.setConfig({ 'claude.autoRotate.enabled': false });
  result = await tool(mcp, 'list_accounts', { service: 'codex' });
  assert.equal(result.structuredContent.rotationPolicy.managedProviderPrerequisites.claude.currentlyDisabled, true);
  assert.equal(result.structuredContent.rotationPolicy.managedProviderPrerequisites.codex.currentlyDisabled, false);
  assert.equal(result.structuredContent.rotationPolicy.allBuiltInRotationDisabled, false);
  await fixture.client.setConfig({ 'codex.autoRotate.enabled': false });
  assert.equal((await tool(mcp, 'list_accounts', { service: 'claude' })).structuredContent.rotationPolicy.allBuiltInRotationDisabled, true);
  await fixture.client.setConfig({ 'codex.autoRotate.enabled': true });
  assert.equal((await tool(mcp, 'list_accounts', { service: 'claude' })).structuredContent.rotationPolicy.allBuiltInRotationDisabled, false);
});


const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('MCP fixture condition timed out'); await pause(5); }
}
function statusClient() {
  const client = fakeClient();
  const quota = { state: 'fresh', fetchedAt: iso(0), validUntil: iso(1), accountAttributed: true, windows: [{ label: '5h', kind: 'general', usedPercent: 35.6, displayUsedPercent: 36, availability: 'available' }], availability: 'available' };
  client.status.providers = [{ provider: 'codex', savedAccountCount: 3, accounts: [
    { id: 'zero', name: 'Zero', selected: false, quota, resetCredits: { state: 'known', availableCount: 0, observedAt: iso(0), validUntil: iso(1) } },
    { id: 'stale', name: 'Stale', selected: false, quota, resetCredits: { state: 'stale', lastReportedAvailableCount: 5, observedAt: iso(-1), validUntil: iso(-0.5) } },
    { id: 'unknown', name: 'Unknown', selected: false, quota, resetCredits: { state: 'unknown' } }
  ], native: { kind: 'unsaved', quota, resetCredits: { state: 'unknown' } } }];
  client.advance = (event = 'statusChanged') => { client.status.cursor.revision++; client.emit('event', { event, data: { cursor: { ...client.status.cursor } } }); };
  return client;
}

test('cached status tools preserve rounded/raw facts, per-account credit states and filtered native privacy without collecting usage', async t => {
  const client = statusClient(); const mcp = server(client); t.after(() => mcp.close());
  const result = await tool(mcp, 'get_usage_status', {});
  const snapshot = result.structuredContent.snapshot;
  assert.equal(snapshot.providers[0].savedAccountCount, 3);
  const [zero, stale, unknown] = snapshot.providers[0].accounts;
  assert.equal(zero.resetCredits.availableCount, 0);
  assert.equal(stale.resetCredits.availableCount, undefined); assert.equal(stale.resetCredits.lastReportedAvailableCount, 5);
  assert.equal(unknown.resetCredits.availableCount, undefined);
  assert.equal(zero.quota.windows[0].usedPercent, 35.6); assert.equal(zero.quota.windows[0].displayUsedPercent, 36);
  assert.equal(snapshot.providers[0].native.kind, 'unsaved');
  const filtered = await tool(mcp, 'get_usage_status', { providers: ['codex'], accountIds: ['zero'] });
  assert.equal(filtered.structuredContent.snapshot.providers[0].savedAccountCount, 3);
  assert.equal(filtered.structuredContent.snapshot.providers[0].accounts.length, 1);
  assert.equal(filtered.structuredContent.snapshot.providers[0].native.kind, 'unknown');
  assert.equal(filtered.structuredContent.snapshot.providers[0].native.quota.windows.length, 0);
  assert.equal(filtered.structuredContent.snapshot.rotationPolicy.settings['claude.autoRotate.enabled'], client.config.claude.autoRotate.enabled);
  assert.equal((await tool(mcp, 'get_usage_status', { since: snapshot.cursor })).structuredContent.status, 'unchanged');
  const resync = await tool(mcp, 'get_usage_status', { since: { epoch: 'previous-engine', revision: 999 } });
  assert.equal(resync.structuredContent.resync, true);
  assert.ok(client.calls.every(c => c[0] === 'statusSnapshot'), 'status reads never call collection or account actions');
  for (const args of [{ providers: ['bad'] }, { providers: ['codex', 'codex'] }, { accountIds: ['x'.repeat(129)] }, { since: { epoch: 'x', revision: -1 } }]) {
    assert.equal((await call(mcp, 51, 'tools/call', { name: 'get_usage_status', arguments: args })).error.code, -32602);
  }
});

test('stdio resource registration coalesces updates, reads latest status, validates identities and cleans up unsubscribe/disable', async t => {
  const client = statusClient(); const io = stdio({ connect: async () => client, version: 'test', now: () => NOW }); t.after(() => io.end());
  io.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal((await io.next()).result.protocolVersion, '2024-11-05');
  io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const uri = 'ai-usage://status?provider=codex&account=zero';
  io.send({ jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri } }); assert.deepEqual((await io.next()).result, {});
  for (let i = 0; i < 50; i++) client.advance();
  const notification = await io.next(); assert.equal(notification.method, 'notifications/resources/updated'); assert.deepEqual(notification.params, { uri });
  await pause(130); assert.equal(io.lines.length, 0, 'a burst has one invalidation, not fifty');
  io.send({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri } });
  const read = JSON.parse((await io.next()).result.contents[0].text);
  assert.equal(read.snapshot.cursor.revision, 50); assert.equal(read.snapshot.providers[0].accounts[0].id, 'zero');
  assert.equal(read.snapshot.providers[0].native.kind, 'unknown');
  for (const bad of ['ai-usage://status?provider=other', 'ai-usage://status?provider=codex&provider=claude', 'ai-usage://status?account=zero', 'ai-usage://status?account=zero&provider=codex', 'ai-usage://status#fragment']) {
    io.send({ jsonrpc: '2.0', id: 4, method: 'resources/subscribe', params: { uri: bad } }); assert.ok((await io.next()).error);
  }
  io.send({ jsonrpc: '2.0', id: 5, method: 'resources/unsubscribe', params: { uri } }); assert.deepEqual((await io.next()).result, {});
  client.advance(); await pause(140); assert.equal(io.lines.length, 0);
  io.send({ jsonrpc: '2.0', id: 6, method: 'resources/subscribe', params: { uri } }); await io.next();
  client.config.mcp.enabled = false; client.advance('configChanged'); await pause(150); assert.equal(io.lines.length, 0, 'disable suppresses outgoing status events');
  io.send({ jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri } }); assert.ok((await io.next()).error);
  client.config.mcp.enabled = true; client.advance('configChanged'); await pause(150); assert.equal(io.lines.length, 0, 're-enable requires explicit registration');
  await io.end(); assert.equal(client.listenerCount('event'), 0); assert.equal(client.listenerCount('close'), 0);
  assert.ok(client.calls.every(c => c[0] === 'statusSnapshot'));
});

test('bounded wait enforces one concurrent slot, deadlines, cancellation and cursor resync without a provider loop', async t => {
  const client = statusClient(); const mcp = server(client); t.after(() => mcp.close());
  const since = { ...client.status.cursor };
  const pending = call(mcp, 20, 'tools/call', { name: 'wait_for_usage_updates', arguments: { since, timeoutSeconds: 5 } });
  await until(() => client.calls.some(c => c[0] === 'statusSnapshot'));
  assert.equal((await call(mcp, 21, 'tools/call', { name: 'wait_for_usage_updates', arguments: { since } })).error.code, -32602);
  client.advance(); const changed = (await pending).result.structuredContent;
  assert.equal(changed.status, 'snapshot'); assert.equal(changed.timedOut, false); assert.equal(changed.snapshot.cursor.revision, 1);
  const current = { ...client.status.cursor }; const deadline = Date.now();
  const timeout = await tool(mcp, 'wait_for_usage_updates', { since: current, timeoutSeconds: 1 });
  assert.equal(timeout.structuredContent.status, 'unchanged'); assert.equal(timeout.structuredContent.timedOut, true);
  assert.ok(Date.now() - deadline < 2000);
  const cancelled = call(mcp, 22, 'tools/call', { name: 'wait_for_usage_updates', arguments: { since: current, timeoutSeconds: 30 } });
  await pause(10); await mcp.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 22 } });
  assert.equal((await cancelled).result.isError, true);
  const oldEpoch = await tool(mcp, 'wait_for_usage_updates', { since: { epoch: 'old', revision: 0 }, timeoutSeconds: 1 });
  assert.equal(oldEpoch.structuredContent.resync, true); assert.equal(oldEpoch.structuredContent.timedOut, false);
  const disabled = call(mcp, 23, 'tools/call', { name: 'wait_for_usage_updates', arguments: { since: current } });
  await pause(10); client.config.mcp.enabled = false; client.advance('configChanged'); assert.equal((await disabled).result.isError, true);
  client.config.mcp.enabled = true;
  for (const timeoutSeconds of [0, 31, 1.5]) assert.equal((await call(mcp, 24, 'tools/call', { name: 'wait_for_usage_updates', arguments: { since: current, timeoutSeconds } })).error.code, -32602);
  assert.ok(client.calls.every(c => c[0] === 'statusSnapshot'));
});

test('subscription reservations resist concurrent overflow, late baseline, unsubscribe and cancellation races', async t => {
  const client = statusClient(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = client.statusSnapshot;
  client.statusSnapshot = async filter => { await gate; return original.call(client, filter); };
  const mcp = server(client); t.after(() => mcp.close());
  const pending = Array.from({ length: 8 }, (_, i) => call(mcp, i + 1, 'resources/subscribe', { uri: `ai-usage://status?provider=codex&account=id${i}` }));
  assert.equal((await call(mcp, 30, 'resources/subscribe', { uri: 'ai-usage://status?provider=claude' })).error.code, -32602);
  await call(mcp, 31, 'resources/unsubscribe', { uri: 'ai-usage://status?provider=codex&account=id0' });
  await mcp.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
  release(); const results = await Promise.all(pending);
  assert.ok(results[0].error, 'unsubscribe invalidates pending baseline'); assert.ok(results[1].error, 'cancellation releases reserved slot');
  assert.ok(results.slice(2).every(r => r.result));
  assert.deepEqual((await call(mcp, 32, 'resources/subscribe', { uri: 'ai-usage://status?provider=claude' })).result, {});
  assert.deepEqual((await call(mcp, 33, 'resources/subscribe', { uri: 'ai-usage://status?provider=copilot' })).result, {});
  mcp.close(); assert.equal(client.listenerCount('event'), 0);
});

test('stdio slow output coalesces notifications and bounds ordinary response backlog', async t => {
  const client = statusClient(), input = new PassThrough(), frames = [], callbacks = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { frames.push(JSON.parse(String(chunk))); callbacks.push(callback); } });
  const done = runMcpStdio({ connect: async () => client, version: 'test', input, output });
  t.after(() => { input.end(); for (const callback of callbacks.splice(0)) callback(); });
  const send = (id, method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }) + '\n');
  send(1, 'initialize', { protocolVersion: '2025-06-18' }); await until(() => callbacks.length); callbacks.shift()();
  send(undefined, 'notifications/initialized'); send(2, 'resources/subscribe', { uri: 'ai-usage://status' });
  await until(() => callbacks.length); callbacks.shift()();
  for (let i = 0; i < 100; i++) client.advance();
  await until(() => callbacks.length); assert.equal(frames.filter(f => f.method).length, 1);
  for (let i = 0; i < 100; i++) client.advance(); await pause(150);
  assert.equal(frames.filter(f => f.method).length, 1, 'no further writes before drain');
  send(3, 'resources/unsubscribe', { uri: 'ai-usage://status' }); await pause(10); callbacks.shift()();
  await until(() => callbacks.length); callbacks.shift()(); await pause(150);
  assert.equal(frames.filter(f => f.method).length, 1, 'unsubscribe removes dirty notification before drain');
  send(4, 'ping'); await until(() => callbacks.length);
  for (let i = 5; i < 90; i++) send(i, 'ping');
  await until(() => !client.connected); assert.equal(await done, 0);
  assert.equal(frames.length, 5, 'blocked reader cannot accumulate arbitrarily many frames');
});

for (const mode of ['background', 'embedded']) test(`${mode}: deployed CLI MCP receives engine events and waits using cached projection only`, { timeout: 15000 }, async t => {
  const { runtimeFixture } = require('../../test/helpers/runtimeHost');
  const { spawn } = require('node:child_process');
  const fixture = await runtimeFixture(t, mode);
  await fixture.client.setConfig({ 'mcp.enabled': true });
  await fixture.client.liveUsage('codex', true);
  const readFile = path.join(fixture.home, 'reads.jsonl');
  const beforeReads = fs.readFileSync(readFile, 'utf8');
  const child = spawn(process.execPath, [path.join(__dirname, '../bin/ai-usage.js'), 'mcp', '--home', fixture.home], { cwd: path.resolve(__dirname, '../..'), env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', rest = ''; const lines = [], waiters = [];
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { rest += String(chunk); let index; while ((index = rest.indexOf('\n')) >= 0) { lines.push(JSON.parse(rest.slice(0, index))); rest = rest.slice(index + 1); waiters.shift()?.(); } });
  const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }) + '\n');
  const next = async () => { if (!lines.length) await Promise.race([new Promise(resolve => waiters.push(resolve)), pause(4000).then(() => { throw new Error('CLI MCP frame timeout: ' + stderr); })]); return lines.shift(); };
  fixture.cleanups.push(async () => { child.stdin.end(); if (child.exitCode === null && child.signalCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(1500)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } });
  send(1, 'initialize', { protocolVersion: '2025-03-26' }); assert.equal((await next()).result.capabilities.resources.subscribe, true);
  send(undefined, 'notifications/initialized');
  const uri = 'ai-usage://status?provider=codex';
  send(2, 'resources/subscribe', { uri }); assert.deepEqual((await next()).result, {});
  send(3, 'resources/read', { uri }); const first = JSON.parse((await next()).result.contents[0].text).snapshot;
  assert.equal(first.providers[0].savedAccountCount, 0); assert.equal(first.providers[0].native.kind, 'unsaved');
  assert.equal(first.providers[0].native.resetCredits.state, 'unknown');
  assert.equal(first.providers[0].native.quota.windows[0].displayUsedPercent, 37);
  assert.equal(first.rotationPolicy.settings['claude.autoRotate.enabled'], false);
  await fixture.client.setConfig({ 'codex.autoRotate.strategy': 'leastWaste' });
  assert.deepEqual((await next()).params, { uri });
  send(4, 'resources/read', { uri }); const updated = JSON.parse((await next()).result.contents[0].text).snapshot;
  assert.equal(updated.rotationPolicy.settings['codex.autoRotate.strategy'], 'leastWaste'); assert.ok(updated.cursor.revision > first.cursor.revision);
  send(5, 'resources/unsubscribe', { uri }); assert.deepEqual((await next()).result, {});
  send(6, 'tools/call', { name: 'wait_for_usage_updates', arguments: { since: updated.cursor, providers: ['codex'], timeoutSeconds: 5 } });
  await pause(30); await fixture.client.setConfig({ 'claude.autoRotate.strategy': 'leastWaste' });
  const waited = (await next()).result.structuredContent; assert.equal(waited.status, 'snapshot'); assert.equal(waited.timedOut, false);
  assert.equal(waited.snapshot.rotationPolicy.settings['claude.autoRotate.strategy'], 'leastWaste', 'filtered rows retain both provider policies');
  send(7, 'tools/call', { name: 'wait_for_usage_updates', arguments: { since: waited.snapshot.cursor, timeoutSeconds: 30 } });
  await pause(20); send(undefined, 'notifications/cancelled', { requestId: 7 }); assert.equal((await next()).result.isError, true);
  assert.equal(fs.readFileSync(readFile, 'utf8'), beforeReads, 'MCP clients/readers/waits perform zero extra provider requests');
  child.stdin.end();
});


test('stdio subscription survives engine reconnect by reading the new epoch and discards listeners from the old connection', { timeout: 6000 }, async t => {
  const first = statusClient(), second = statusClient(); second.status.cursor.epoch = 'new-engine';
  let connections = 0;
  const io = stdio({ connect: async () => connections++ ? second : first, version: 'test' }); t.after(() => io.end());
  io.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }); await io.next();
  io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  io.send({ jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri: 'ai-usage://status' } }); await io.next();
  first.close();
  assert.equal((await io.next()).method, 'notifications/resources/updated');
  io.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_usage_status', arguments: { since: first.status.cursor } } });
  const result = (await io.next()).result.structuredContent;
  assert.equal(result.resync, true); assert.equal(result.snapshot.cursor.epoch, 'new-engine');
  assert.equal(first.listenerCount('event'), 0); assert.equal(first.listenerCount('close'), 0);
  assert.equal(connections, 2); assert.ok(second.calls.every(c => c[0] === 'statusSnapshot'));
});

test('status change during an awaited subscription baseline is not lost, and input close aborts a pending wait promptly', async t => {
  const client = statusClient(); const original = client.statusSnapshot; let release, started;
  const entered = new Promise(resolve => { started = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  client.statusSnapshot = async function(filter) { started(); await gate; return original.call(this, filter); };
  const io = stdio({ connect: async () => client, version: 'test' }); t.after(() => io.end());
  io.send({ jsonrpc: '2.0', id: 1, method: 'initialize' }); await io.next(); io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  io.send({ jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri: 'ai-usage://status' } });
  await entered; client.advance(); release(); assert.deepEqual((await io.next()).result, {});
  assert.equal((await io.next()).method, 'notifications/resources/updated');
  io.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wait_for_usage_updates', arguments: { since: client.status.cursor, timeoutSeconds: 30 } } });
  await pause(20); const before = Date.now(); await io.end(); assert.ok(Date.now() - before < 500);
  assert.equal(client.listenerCount('event'), 0); assert.equal(client.connected, false);
});


test('wait deadline and cancellation include delayed connect/config, and late cancelled connections install no listeners', { timeout: 8000 }, async t => {
  for (const phase of ['connect', 'config', 'status']) {
    const client = statusClient(); let release;
    const delayed = new Promise(resolve => { release = resolve; });
    if (phase === 'config') client.getConfig = async () => { await delayed; return client.config; };
    if (phase === 'status') { const original = client.statusSnapshot; client.statusSnapshot = async function(filter) { await delayed; return original.call(this, filter); }; }
    const mcp = new McpServer({ connect: () => phase === 'connect' ? delayed.then(() => client) : Promise.resolve(client), version: 'test' });
    t.after(() => mcp.close());
    const before = Date.now();
    const pending = call(mcp, 1, 'tools/call', { name: 'wait_for_usage_updates', arguments: { since: client.status.cursor, timeoutSeconds: 1 } });
    const result = (await pending).result;
    assert.equal(result.isError, true); assert.equal(result.structuredContent.timedOut, true);
    assert.ok(Date.now() - before < 1400, `${phase} is included in the total wait deadline`);
    release(); await pause(10); assert.equal(client.listenerCount('event'), 0, 'deadline leaves no late observation listener');
  }
  const client = statusClient(); let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const mcp = new McpServer({ connect: () => delayed.then(() => client), version: 'test' }); t.after(() => mcp.close());
  const pending = call(mcp, 11, 'tools/call', { name: 'wait_for_usage_updates', arguments: { since: client.status.cursor, timeoutSeconds: 30 } });
  await pause(10); const before = Date.now(); await mcp.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 11 } });
  assert.equal((await pending).result.isError, true); assert.ok(Date.now() - before < 200);
  release(); await pause(10); assert.equal(client.listenerCount('event'), 0); assert.equal(client.listenerCount('close'), 0);
});

test('normal stdio EOF drains successful queued response frames after a delayed writable drain', { timeout: 4000 }, async () => {
  const client = fakeClient(), input = new PassThrough(), frames = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { frames.push(JSON.parse(String(chunk))); setTimeout(callback, 40); } });
  const done = runMcpStdio({ connect: async () => client, version: 'test', input, output });
  input.end([1, 2, 3].map(id => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })).join('\n') + '\n');
  await done; assert.deepEqual(frames.map(frame => frame.id), [1, 2, 3]); assert.ok(frames.every(frame => frame.result && !frame.error));
});


test('stdio output close releases every input listener even while input remains open', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const events = ['data', 'error', 'end', 'close'];
  const baseline = events.map(event => input.listenerCount(event));
  const done = runMcpStdio({ connect: async () => fakeClient(), version: 'test', input, output });
  output.destroy(); await done;
  assert.deepEqual(events.map(event => input.listenerCount(event)), baseline);
  assert.equal(input.readableEnded, false); input.destroy();
});


for (const initialized of [true, false]) test(`rapid disable/re-enable revokes prior registrations and waits even when initialized=${initialized}`, async t => {
  const client = statusClient(); const io = stdio({ connect: async () => client, version: 'test' }); t.after(() => io.end());
  io.send({ jsonrpc: '2.0', id: 1, method: 'initialize' }); await io.next();
  if (initialized) io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const uri = 'ai-usage://status';
  io.send({ jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri } }); await io.next();
  io.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wait_for_usage_updates', arguments: { since: client.status.cursor, timeoutSeconds: 30 } } });
  await pause(10);
  client.config.mcp.enabled = false; client.emit('event', { event: 'configChanged', config: structuredClone(client.config) });
  client.config.mcp.enabled = true; client.emit('event', { event: 'configChanged', config: structuredClone(client.config) });
  const cancelled = await io.next(); assert.equal(cancelled.id, 3); assert.equal(cancelled.result.isError, true);
  if (!initialized) io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  client.advance(); await pause(150); assert.equal(io.lines.length, 0, 'old registration cannot resume when settings become enabled again');
  assert.equal(client.listenerCount('event'), 0);
  io.send({ jsonrpc: '2.0', id: 4, method: 'resources/subscribe', params: { uri } }); assert.deepEqual((await io.next()).result, {});
  client.advance(); assert.equal((await io.next()).method, 'notifications/resources/updated', 'explicit new subscription receives events');
});
