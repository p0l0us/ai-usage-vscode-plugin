const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { ServiceClient, startServiceHost, RpcError, readServiceInfo, readToken, socketPath } = require('../service/out');
const { RpcClient } = require('../service/out/rpc');
const { readServiceUsage } = require('../out/usageClient');
const { runtimeFixture, isolateHomes, seedFixture, setFixture, childHost, hostOptions, eventually } = require('./helpers/runtimeHost');
const { mcpProcess } = require('./helpers/mcpProcess');

for (const mode of ['background', 'embedded']) {
  test(`${mode}: authoritative usage, diagnostics, native unsaved accounts and connection context share the socket engine`, async t => {
    const f = await runtimeFixture(t, mode);
    const b = await f.connect('parity-window-b');
    const info = await f.client.serviceInfo();
    assert.equal(info.mode, mode);
    assert.equal(info.pid, mode === 'embedded' ? process.pid : f.owner.child.pid);
    assert.equal((await f.client.call('service.status')).clients.length, 2);
    for (const provider of ['claude', 'codex', 'copilot']) {
      const view = await readServiceUsage(f.client, provider, false, true);
      assert.equal(view.result.usage.windows[0].usedPercent, 37);
      assert.ok(view.result.usage.fetchedAt instanceof Date);
      if (provider !== 'copilot') {
        const accounts = await b.list(provider);
        assert.equal(accounts.nativeUnsaved, true);
        assert.deepEqual(accounts.profiles, []);
        assert.deepEqual(JSON.parse(JSON.stringify(view.diagnostics)), await b.call('rotation.diagnostics', { provider }));
      }
    }
    await Promise.all([f.client.usageContext({ workspaceOwners: ['window-a'] }), b.usageContext({ workspaceOwners: ['window-b'] })]);
    await Promise.all([f.client.liveUsage('copilot', true), b.liveUsage('copilot', true)]);
    const reads = fs.readFileSync(path.join(f.home, 'reads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(reads.some(read => read.provider === 'copilot' && read.owners.includes('window-a')));
    assert.ok(reads.some(read => read.provider === 'copilot' && read.owners.includes('window-b')));
    await assert.rejects(f.client.call('usage.observe', { provider: 'codex' }), /collected by the service/);
  });

  test(`${mode}: concurrent windows use revision conflicts, disjoint edits, events, logs and reconnect without losing settings`, async t => {
    const f = await runtimeFixture(t, mode); const b = await f.connect('parity-window-b');
    const state = await f.client.getConfigState(); const events = [];
    b.on('event', event => events.push(event));
    const writes = await Promise.allSettled([
      f.client.patchConfig({ 'codex.checkIntervalMinutes': 17 }, state.revision),
      b.patchConfig({ 'codex.checkIntervalMinutes': 19 }, state.revision)
    ]);
    assert.equal(writes.filter(write => write.status === 'fulfilled').length, 1);
    const failure = writes.find(write => write.status === 'rejected').reason;
    assert.ok(failure instanceof RpcError); assert.equal(failure.code, 'config-conflict');
    assert.deepEqual(failure.data.keys, ['codex.checkIntervalMinutes']);
    await Promise.all([
      f.client.patchConfig({ 'claude.checkIntervalMinutes': 23 }, state.revision),
      b.patchConfig({ 'copilot.checkIntervalMinutes': 29 }, state.revision)
    ]);
    await eventually(() => events.some(event => event.event === 'configChanged' && event.revision > state.revision));
    await eventually(() => events.some(event => event.event === 'log' && /config/.test(event.line)));
    const latest = await f.client.getConfigState();
    assert.equal(latest.config.claude.checkIntervalMinutes, 23); assert.equal(latest.config.copilot.checkIntervalMinutes, 29);
    assert.ok((await f.client.tailLog(50)).some(line => /parity-window-b/.test(line)));
    const profile = await f.client.importCredential('claude', 'Preserved fixture', { claudeAiOauth: { accessToken: 'saved-synthetic' } });
    assert.equal(profile.status, 'saved');
    b.close(); await eventually(() => !b.connected);
    const reconnect = await f.connect('parity-window-b-reconnect');
    assert.deepEqual(await reconnect.getConfigState(), latest);
    assert.equal((await reconnect.list('claude')).profiles[0].name, 'Preserved fixture');
    await assert.rejects(reconnect.patchConfig({ 'accountService.enabled': false }, latest.revision), error => error.code === 'config-local-setting');
  });

  test(`${mode}: typed errors and incompatible protocol versions have the same client behavior`, async t => {
    const f = await runtimeFixture(t, mode);
    await assert.rejects(f.client.call('unknown.parity.method'), error => error instanceof RpcError && error.code === 'unknown_method');
    await assert.rejects(f.client.call('usage.live', { provider: 'invalid' }), error => error instanceof RpcError && error.code === 'invalid_params');
    const token = readToken(f.home);
    await assert.rejects(RpcClient.connect({ socketPath: socketPath(f.home), token, client: 'incompatible', protocolVersion: 999 }), error => error.code === 'incompatible');
  });

  test(`${mode}: request deadlines, cancellation and shutdown have the same client behavior`, async t => {
    const f = await runtimeFixture(t, mode);
    setFixture(f.home, { delayMs: 300 });
    await f.client.usageContext({ workspaceOwners: ['deadline'] });
    await assert.rejects(f.client.call('usage.live', { provider: 'copilot', force: true }, { timeoutMs: 20 }), error => error.code === 'timeout');
    const controller = new AbortController();
    await f.client.usageContext({ workspaceOwners: ['cancel'] });
    const pending = f.client.call('usage.live', { provider: 'copilot', force: true }, { signal: controller.signal, timeoutMs: 1000 });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, error => error.code === 'cancelled');
    assert.equal((await f.client.serviceInfo()).mode, mode, 'cancelled requests do not poison the socket');
    const lifecycle = []; f.client.on('event', event => lifecycle.push(event));
    const closed = once(f.client, 'close');
    await f.client.shutdown(); await closed;
    await eventually(() => readServiceInfo(f.home) === undefined);
    assert.ok(lifecycle.some(event => event.event === 'lifecycle' && event.state === 'stopping'));
  });

  test(`${mode}: one owner wins simultaneous starts and crash takeover preserves credentials, profiles and config`, async t => {
    const f = isolateHomes(t); seedFixture(f.home, f.env);
    const winners = await Promise.all([childHost(t, f.home, f.env, mode), childHost(t, f.home, f.env, mode)]);
    assert.equal(winners.filter(owner => owner.ready).length, 1);
    const loser = winners.find(owner => !owner.ready);
    assert.ok(['owner-running', 'owner-unreachable'].includes(loser.code), loser.error);
    const owner = winners.find(owner => owner.ready);
    const client = await ServiceClient.connect({ home: f.home, client: 'crash-parity' }); f.cleanups.push(() => client.close());
    await client.setConfig({ 'codex.checkIntervalMinutes': 31 });
    await client.importCredential('claude', 'Existing profile', { claudeAiOauth: { accessToken: 'saved-before-crash' } });
    const nativeFiles = [path.join(f.env.CLAUDE_CONFIG_DIR, '.credentials.json'), path.join(f.env.CODEX_HOME, 'auth.json'), path.join(f.env.CODEX_HOME, 'config.toml')];
    const before = nativeFiles.map(file => fs.readFileSync(file, 'utf8'));
    const profilesBefore = fs.readFileSync(path.join(f.home, 'profiles.json'), 'utf8');
    const closed = once(client, 'close'); owner.child.kill('SIGKILL'); await owner.exited; await closed;
    const replacement = await startServiceHost({ ...hostOptions(f.home, mode), seedConfig: { 'codex.checkIntervalMinutes': 999 } });
    f.cleanups.push(() => replacement.stop());
    const next = await ServiceClient.connect({ home: f.home, client: 'takeover-parity' }); f.cleanups.push(() => next.close());
    assert.notEqual((await next.serviceInfo()).instanceId, owner.instanceId);
    assert.equal((await next.getConfig()).codex.checkIntervalMinutes, 31);
    assert.equal((await next.list('claude')).profiles[0].name, 'Existing profile');
    assert.equal(fs.readFileSync(path.join(f.home, 'profiles.json'), 'utf8'), profilesBefore);
    assert.deepEqual(nativeFiles.map(file => fs.readFileSync(file, 'utf8')), before);
    await next.shutdown(); await replacement.stopped;
  });

  test(`${mode}: bundled MCP works without installation and reports native usage, freshness and model limits`, async t => {
    const f = await runtimeFixture(t, mode);
    await f.client.setConfig({ 'mcp.enabled': true, 'mcp.switching': false });
    assert.equal(fs.existsSync(path.join(f.home, 'service')), false);
    const mcp = mcpProcess(t, f.home, f.env);
    const initialized = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity' } });
    assert.equal(initialized.result.serverInfo.name, 'ai-usage');
    const tools = await mcp.request('tools/list');
    assert.deepEqual(tools.result.tools.map(tool => tool.name), ['list_accounts', 'refresh_usage']);
    const result = await mcp.request('tools/call', { name: 'list_accounts', arguments: { service: 'claude' } });
    assert.equal(result.result.isError, undefined);
    const summary = result.result.structuredContent.services[0];
    assert.equal(summary.nativeUnsaved, true); assert.deepEqual(summary.profiles, []);
    assert.match(result.result.content[0].text, /5h 37%/);
    assert.match(result.result.content[0].text, /7d Sonnet 100%/);
    assert.equal(summary.activeUsage.freshness.state, 'fresh');
    assert.equal(summary.activeUsage.modelLimited, true);
    assert.equal(summary.activeUsage.usage.windows.find(window => window.label === '7d Sonnet').scope, 'model');
    assert.equal(summary.activeUsage.usage.windows[0].scope, 'account');
    const refreshed = await mcp.request('tools/call', { name: 'refresh_usage', arguments: { service: 'codex' } });
    assert.equal(refreshed.result.isError, undefined);
    assert.match(refreshed.result.content[0].text, /5h 37%/);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-claude|accessToken|synthetic-codex|access_token/);
    assert.equal(fs.existsSync(path.join(f.home, 'service')), false);
    mcp.child.stdin.end(); const [exitCode] = await mcp.exited; assert.equal(exitCode, 0);
  });

  test(`${mode}: MCP distinguishes unknown and stale native readings from usable current quota`, async t => {
    const f = await runtimeFixture(t, mode);
    await f.client.setConfig({ 'mcp.enabled': true });
    setFixture(f.home, { kind: 'unavailable' });
    const mcp = mcpProcess(t, f.home, f.env);
    const unknown = await mcp.request('tools/call', { name: 'refresh_usage', arguments: { service: 'claude' } });
    assert.match(JSON.stringify(unknown.result), /unknown|unavailable|No synthetic usage/i);
    setFixture(f.home, { ageMs: 86_400_000 });
    const stale = await mcp.request('tools/call', { name: 'refresh_usage', arguments: { service: 'codex' } });
    assert.match(JSON.stringify(stale.result), /stale|expired/i);
  });
}

for (const mode of ['background', 'embedded']) {
  test(`${mode}: two windows infer with their own signed workspace context through mocked native executable children`, async t => {
    const f = await runtimeFixture(t, mode);
    const directoryA = path.join(f.directory, 'window-a'); const directoryB = path.join(f.directory, 'window-b');
    fs.mkdirSync(directoryA); fs.mkdirSync(directoryB);
    await f.client.call('workspace.context', { folders: [directoryA] });
    const b = await f.connect('inference-window-b', [directoryB]);
    const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const executable = path.join(__dirname, 'helpers/nativeBridgeFixture.mjs');
    await f.client.setConfig({ 'bridge.autoStart': true, 'bridge.url': `http://127.0.0.1:${port}`,
      'bridge.tokenFile': path.join(f.directory, 'bridge-token'),
      'bridge.codex.executable': executable, 'bridge.claude.executable': executable,
      'bridge.codex.persistSessions': true, 'bridge.claude.persistSessions': true,
      'bridge.codex.subagentsEnabled': false, 'bridge.claude.subagentsEnabled': false });
    const [aConnection, bConnection] = await Promise.all([f.client.call('bridge.ensure'), b.call('bridge.ensure')]);
    assert.equal(aConnection.endpoint, bConnection.endpoint);
    assert.equal(aConnection.workspaceContext.directories.codex, directoryA);
    assert.equal(bConnection.workspaceContext.directories.codex, directoryB);
    const invoke = async (connection, provider, tamper = false) => {
      const scope = structuredClone(connection.workspaceContext);
      if (tamper) scope.directories[provider] = directoryB;
      const response = await fetch(new URL('/v1/chat/completions', connection.endpoint), {
        method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: `${provider}/parity`, bridge_workspace_context: scope,
          messages: [{ role: 'user', content: 'Synthetic inference' }], stream: false })
      });
      return { response, body: await response.json() };
    };
    for (const provider of ['codex', 'claude']) {
      const [aResult, bResult] = await Promise.all([invoke(aConnection, provider), invoke(bConnection, provider)]);
      assert.equal(aResult.response.status, 200, JSON.stringify(aResult.body));
      assert.equal(bResult.response.status, 200, JSON.stringify(bResult.body));
      assert.equal(aResult.body.choices[0].message.content, directoryA);
      assert.equal(bResult.body.choices[0].message.content, directoryB);
      assert.equal(aResult.body.usage.total_tokens, 12); assert.equal(bResult.body.usage.total_tokens, 12);
    }
    const tampered = await invoke(aConnection, 'codex', true);
    assert.equal(tampered.response.status, 400);
    const policy = JSON.parse(fs.readFileSync(path.join(f.directory, 'bridge-token.session-settings.json'), 'utf8'));
    assert.doesNotMatch(JSON.stringify(policy), /window-a|window-b/);
    await f.client.shutdown();
    await eventually(() => readServiceInfo(f.home) === undefined);
    await assert.rejects(fetch(new URL('/health', aConnection.endpoint)), /fetch failed/);
  });

  test(`${mode}: independent process starts through an absent symlinked home still elect one engine`, { skip: process.platform === 'win32' }, async t => {
    const f = isolateHomes(t);
    const realParent = path.join(f.directory, 'real-parent'); const aliasParent = path.join(f.directory, 'alias-parent');
    fs.mkdirSync(realParent); fs.symlinkSync(realParent, aliasParent, 'dir');
    const realHome = path.join(realParent, 'new-home'); const aliasHome = path.join(aliasParent, 'new-home');
    assert.equal(fs.existsSync(realHome), false);
    const owners = await Promise.all([childHost(t, realHome, f.env, mode), childHost(t, aliasHome, f.env, mode)]);
    assert.equal(owners.filter(owner => owner.ready).length, 1, JSON.stringify(owners.map(({ ready, error, code }) => ({ ready, error, code }))));
    const winner = owners.find(owner => owner.ready); const loser = owners.find(owner => !owner.ready);
    assert.ok(['owner-running', 'owner-unreachable'].includes(loser.code));
    winner.child.send('stop'); await winner.exited;
  });
}
