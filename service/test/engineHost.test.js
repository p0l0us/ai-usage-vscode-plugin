const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

// Every home this file touches is temporary, including the native CLI homes the engine would write settings to.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-w1-'));
for (const [name, dir] of [['HOME', 'home'], ['AI_USAGE_HOME', 'aiu'], ['CODEX_HOME', 'codex'], ['CLAUDE_CONFIG_DIR', 'claude']]) {
  process.env[name] = path.join(sandbox, dir);
  fs.mkdirSync(process.env[name], { recursive: true });
}
process.on('exit', () => fs.rmSync(sandbox, { recursive: true, force: true }));

const { startServiceHost, probeEngine, EngineOwnedError } = require('../out/daemon');
const { acquireEngineLease, leaseHeld, canonicalHome, tcpLeasePort } = require('../out/runtimeLease');
const { SERVICE_CAPABILITIES, SERVICE_PROTOCOL_VERSION } = require('../out/protocol');
const { connectService } = require('../out/client');
const { RpcServer } = require('../out/rpc');
const { AccountService } = require('../out/accountService');
const { ConfigAuthority, settingScope } = require('../out/configStore');
const { infoFile, readServiceInfo, readOrCreateToken, socketPath, tokenFile } = require('../out/paths');

const QUIET = { claude: { enabled: false }, codex: { enabled: false, autoReset: { enabled: false } }, copilot: { enabled: false }, bridge: { autoStart: false } };
const offline = { fetchUsage: async (provider) => ({ kind: 'unavailable', provider, reason: 'test' }) };

function newHome(t, config = QUIET) {
  const home = fs.mkdtempSync(path.join(sandbox, 'h-'));
  if (config) { fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config)); }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** A child Node process that runs `code` with the sandbox environment and reports "ready" on stdout. */
function child(t, code) {
  const proc = spawn(process.execPath, ['-e', code], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { proc.kill('SIGKILL'); } catch { /* Gone. */ } });
  const ready = new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (chunk) => { out += chunk; if (out.includes('ready')) { resolve(); } });
    proc.once('exit', (status) => reject(new Error(`child exited ${status}: ${out}`)));
  });
  return { proc, ready, exited: new Promise((resolve) => proc.once('exit', resolve)) };
}
const out = (file) => JSON.stringify(path.join(__dirname, '..', 'out', file));

for (const kind of process.platform === 'linux' || process.platform === 'win32' ? ['os', 'tcp'] : ['tcp']) {
  test(`the ${kind} lease admits one holder per home and is free again after release`, async (t) => {
    const home = newHome(t, undefined);
    const first = await acquireEngineLease(home, { kind });
    assert.ok(first);
    assert.equal(await leaseHeld(home, { kind }), true);
    assert.equal(await acquireEngineLease(home, { kind }), undefined);
    // Another spelling of the same directory is the same home.
    const alias = path.join(sandbox, `alias-${kind}`);
    fs.symlinkSync(home, alias);
    t.after(() => fs.rmSync(alias, { force: true }));
    assert.equal(await acquireEngineLease(alias, { kind }), undefined);
    first.release();
    assert.equal(first.held(), false);
    assert.throws(() => first.assertHeld(), /no longer owns/);
    assert.equal(await leaseHeld(home, { kind }), false);
    const second = await acquireEngineLease(home, { kind });
    assert.ok(second);
    assert.notEqual(second.instanceId, first.instanceId);
    second.release();
  });

  test(`a ${kind} lease of a killed process is reclaimed`, async (t) => {
    const home = newHome(t, undefined);
    const holder = child(t, `require(${out('runtimeLease.js')}).acquireEngineLease(${JSON.stringify(home)}, { kind: ${JSON.stringify(kind)} })
      .then((lease) => { if (!lease) process.exit(3); console.log('ready'); setInterval(() => {}, 1000); });`);
    await holder.ready;
    assert.equal(await acquireEngineLease(home, { kind }), undefined);
    holder.proc.kill('SIGKILL');
    await holder.exited;
    const lease = await acquireEngineLease(home, { kind });
    assert.ok(lease, 'the lease of a dead owner is free');
    lease.release();
  });
}

for (const kind of process.platform === 'linux' || process.platform === 'win32' ? ['os', 'tcp'] : ['tcp']) {
  test(`a ${kind} lease of a home that does not exist yet is the same through a symlinked parent`, async (t) => {
    const real = fs.mkdtempSync(path.join(sandbox, 'real-'));
    const alias = path.join(sandbox, `link-${kind}`);
    fs.symlinkSync(real, alias);
    t.after(() => { fs.rmSync(alias, { force: true }); fs.rmSync(real, { recursive: true, force: true }); });
    assert.equal(canonicalHome(path.join(alias, 'new', 'home')), path.join(fs.realpathSync(real), 'new', 'home'));
    const first = await acquireEngineLease(path.join(alias, 'new-home'), { kind });
    assert.ok(first);
    assert.equal((await probeEngine(path.join(real, 'new-home'), { leaseKind: kind })).state, 'unreachable', 'a held lease counts even before home creation');
    fs.mkdirSync(path.join(alias, 'new-home'), { recursive: true });
    assert.equal(await acquireEngineLease(path.join(real, 'new-home'), { kind }), undefined, 'one home, one lease');
    first.release();
  });
}

test('an unresolvable home fails closed instead of naming another lease', async () => {
  const file = path.join(sandbox, 'plain-file');
  fs.writeFileSync(file, '');
  fs.chmodSync(sandbox, 0o700);
  // A path through a regular file resolves to that file's would-be child; a permission error is thrown.
  assert.equal(canonicalHome(path.join(file, 'x')), path.join(fs.realpathSync(file), 'x'));
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const closed = fs.mkdtempSync(path.join(sandbox, 'closed-'));
    fs.mkdirSync(path.join(closed, 'inner'));
    fs.chmodSync(closed, 0o000);
    try { assert.throws(() => canonicalHome(path.join(closed, 'inner', 'home')), /EACCES/); }
    finally { fs.chmodSync(closed, 0o700); }
  }
});

// --- TCP fallback: OS-owned ownership regressions (W6-004/005, final Design B) ---------------------------------

test('TCP lease: simultaneous contenders and a third challenger preserve the incumbent', async (t) => {
  const home = newHome(t, null);
  const results = await Promise.all([1, 2, 3].map(() => acquireEngineLease(home, { kind: 'tcp' })));
  const holders = results.filter(Boolean);
  t.after(() => holders.forEach((lease) => lease.release()));
  assert.equal(holders.length, 1);
  const incumbent = holders[0];
  assert.equal(await acquireEngineLease(home, { kind: 'tcp' }), undefined);
  assert.equal(incumbent.held(), true);
  incumbent.assertHeld();
  assert.equal(await leaseHeld(home, { kind: 'tcp' }), true);
  assert.deepEqual(fs.readdirSync(home), [], 'the OS lease creates no claims or tombstones');
});

test('TCP lease: six real processes racing for one home yield exactly one owner', async (t) => {
  const home = newHome(t, null);
  const code = `process.send('ready'); process.once('message', async () => {
    const lease = await require(${out('runtimeLease.js')}).acquireEngineLease(${JSON.stringify(home)}, { kind: 'tcp' });
    process.send(lease ? 'owner' : 'busy');
    process.once('message', () => { lease?.release(); process.exit(0); });
  });`;
  const processes = [1, 2, 3, 4, 5, 6].map(() => spawn(process.execPath, ['-e', code], {
    env: process.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  }));
  t.after(() => processes.forEach((proc) => { if (proc.exitCode === null) proc.kill('SIGKILL'); }));
  await Promise.all(processes.map((proc) => new Promise((resolve) => proc.once('message', resolve))));
  const outputs = processes.map((proc) => new Promise((resolve) => proc.once('message', resolve)));
  processes.forEach((proc) => proc.send('go'));
  const results = await Promise.all(outputs);
  assert.equal(results.filter((line) => line === 'owner').length, 1, results.join(','));
  assert.equal(results.filter((line) => line === 'busy').length, 5);
  assert.equal(await acquireEngineLease(home, { kind: 'tcp' }), undefined, 'a seventh challenger cannot evict the owner');
  const exited = processes.map((proc) => new Promise((resolve) => proc.once('exit', resolve)));
  processes.forEach((proc) => proc.send('stop'));
  await Promise.all(exited);
  assert.equal(await leaseHeld(home, { kind: 'tcp' }), false);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('TCP lease: an unrelated occupied port fails closed with its fixed port named and no home writes', async (t) => {
  const home = newHome(t);
  const before = fs.readdirSync(home).map((name) => [name, fs.readFileSync(path.join(home, name), 'utf8')]);
  const port = tcpLeasePort(home);
  const foreign = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => { foreign.once('error', reject); foreign.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  assert.equal(await leaseHeld(home, { kind: 'tcp' }), true);
  assert.equal(await acquireEngineLease(home, { kind: 'tcp' }), undefined);
  await assert.rejects(startServiceHost({ home, leaseKind: 'tcp', ownerWaitMs: 20, engineOptions: offline }),
    (error) => error instanceof EngineOwnedError && error.code === 'owner-unreachable' && error.message.includes(`127.0.0.1:${port}`));
  assert.equal(foreign.address().port, port, 'the foreign listener remains untouched');
  assert.equal(tcpLeasePort(home), port, 'refusal never selects an alternate port');
  assert.deepEqual(fs.readdirSync(home).map((name) => [name, fs.readFileSync(path.join(home, name), 'utf8')]), before);
});

test('TCP lease observation fails closed on uncertain errors and timeouts', async (t) => {
  const home = newHome(t, null);
  const connect = net.connect;
  t.after(() => { net.connect = connect; });
  for (const code of ['EACCES', 'ECONNRESET', 'ENOENT', 'timeout', 'ECONNREFUSED']) {
    net.connect = () => {
      const socket = new (require('node:events').EventEmitter)();
      socket.destroy = () => {};
      socket.setTimeout = (ms, callback) => { if (code === 'timeout') setImmediate(callback); };
      if (code !== 'timeout') setImmediate(() => socket.emit('error', Object.assign(new Error(code), { code })));
      return socket;
    };
    assert.equal(await leaseHeld(home, { kind: 'tcp' }), code !== 'ECONNREFUSED', code);
  }
});

test('TCP lease: the live incumbent host keeps admitted work while other contenders are refused', async (t) => {
  const home = newHome(t);
  const host = await startServiceHost({ home, leaseKind: 'tcp', engineOptions: { ...offline,
    identityOf: async (provider, credential) => ({ email: `${credential.claudeAiOauth.accessToken}@example.com`, accountId: `account-${credential.claudeAiOauth.accessToken}` }) } });
  t.after(() => host.stop().catch(() => undefined));
  let release;
  host.service.automation.pending = new Promise((resolve) => { release = resolve; });
  const admitted = host.service.handle('profiles.importCredential', { provider: 'claude', name: 'Kept', credential: { claudeAiOauth: { accessToken: 'k', refreshToken: 'r', expiresAt: 9999999999999 } } }, 1, {});
  assert.deepEqual(await Promise.all([1, 2].map(() => acquireEngineLease(home, { kind: 'tcp' }))), [undefined, undefined]);
  await assert.rejects(startServiceHost({ home, leaseKind: 'tcp', ownerWaitMs: 200, engineOptions: offline }),
    (error) => error instanceof EngineOwnedError && error.code === 'owner-running');
  release();
  assert.equal((await admitted).status, 'saved');
  assert.equal(readServiceInfo(home).instanceId, host.instanceId);
  assert.equal(await leaseHeld(home, { kind: 'tcp' }), true);
});

test('concurrent hosts of one home: exactly one engine, the others are told to connect to it', async (t) => {
  const home = newHome(t);
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => startServiceHost({ home, mode: 'embedded', version: '9.0.0', engineOptions: offline })));
  const hosts = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  t.after(() => Promise.all(hosts.map((host) => host.stop())));
  assert.equal(hosts.length, 1);
  for (const result of results.filter((result) => result.status === 'rejected')) {
    assert.ok(result.reason instanceof EngineOwnedError, String(result.reason));
    assert.equal(result.reason.code, 'owner-running');
  }
  const info = readServiceInfo(home);
  assert.equal(info.mode, 'embedded');
  assert.equal(info.embedded, true);
  assert.equal(info.instanceId, hosts[0].instanceId);
  assert.equal(info.protocol, SERVICE_PROTOCOL_VERSION);
  assert.equal(info.lease, process.platform === 'linux' || process.platform === 'win32' ? 'os' : 'tcp');
  const probe = await probeEngine(home);
  assert.equal(probe.state, 'running');
  assert.equal(probe.info.instanceId, hosts[0].instanceId);
});

test('a live owner that does not answer keeps every other host out, and nothing in the home is touched', async (t) => {
  const home = newHome(t);
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  const holder = child(t, `require(${out('runtimeLease.js')}).acquireEngineLease(${JSON.stringify(home)})
    .then((lease) => { if (!lease) process.exit(3); console.log('ready'); setInterval(() => {}, 1000); });`);
  await holder.ready;
  await assert.rejects(startServiceHost({ home, mode: 'embedded', ownerWaitMs: 300, engineOptions: offline }),
    (error) => error instanceof EngineOwnedError && error.code === 'owner-unreachable');
  assert.equal(fs.existsSync(tokenFile(home)), false, 'no token was created');
  assert.equal(fs.existsSync(path.join(home, 'state')), false, 'no state was created');
  assert.equal(fs.existsSync(infoFile(home)), false);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
  assert.equal((await probeEngine(home)).state, 'unreachable');
  holder.proc.kill('SIGKILL');
  await holder.exited;
  assert.equal((await probeEngine(home)).state, 'free');
  const host = await startServiceHost({ home, mode: 'embedded', engineOptions: offline });
  await host.stop();
});

test('a crashed host is replaced: its stale socket and info file give way to the new owner', async (t) => {
  const home = newHome(t);
  const crashed = child(t, `require(${out('engineHost.js')}).startServiceHost({ home: ${JSON.stringify(home)}, mode: 'background', version: '1.0.0' })
    .then(() => console.log('ready'));`);
  await crashed.ready;
  const old = readServiceInfo(home);
  assert.equal(old.mode, 'background');
  crashed.proc.kill('SIGKILL');
  await crashed.exited;
  if (process.platform !== 'win32') { assert.ok(fs.existsSync(socketPath(home)), 'the crash left its socket behind'); }
  const host = await startServiceHost({ home, mode: 'embedded', version: '1.0.1', engineOptions: offline });
  t.after(() => host.stop());
  assert.notEqual(readServiceInfo(home).instanceId, old.instanceId);
  const client = await connectService({ home, client: 'test' });
  assert.equal(client.info.version, '1.0.1');
  client.close();
});

test('a service from before the lease that answers on the socket keeps the home; the new host steps back', async (t) => {
  const home = newHome(t);
  const token = readOrCreateToken(home);
  const legacy = new RpcServer({ socketPath: socketPath(home), token, handle: async () => null,
    onHello: () => ({ ok: true, service: { version: '1.0.9', pid: 4242, startedAt: new Date().toISOString(), home, node: 'node', socket: socketPath(home), clients: 0 } }) });
  await legacy.listen();
  t.after(() => legacy.close());
  await assert.rejects(startServiceHost({ home, engineOptions: offline }), (error) => error instanceof EngineOwnedError && error.code === 'owner-running' && error.info.version === '1.0.9');
  // The attempt released the lease again.
  const lease = await acquireEngineLease(home);
  assert.ok(lease);
  lease.release();
});

for (const mode of ['background', 'embedded']) {
  test(`${mode} host: lifecycle and log commands go through the host`, async (t) => {
    const home = newHome(t);
    const host = await startServiceHost({ home, mode, version: '2.0.0', engineOptions: offline });
    t.after(() => host.stop());
    const client = await connectService({ home, client: 'test', version: '1' });
    t.after(() => client.close());
    assert.equal(client.info.mode, mode);
    assert.equal(client.info.instanceId, host.instanceId);
    for (const capability of SERVICE_CAPABILITIES) { assert.ok(client.info.capabilities.includes(capability), capability); }
    const status = await client.call('service.status');
    assert.equal(status.mode, mode);
    assert.deepEqual(status.clients.map((entry) => entry.client), ['test']);
    const lines = await client.tailLog(50);
    assert.ok(lines.some((line) => line.includes('account service 2.0.0 started')));
    assert.deepEqual(await client.call('service.shutdown', { reason: 'test' }), { ok: true, mode });
    const stopped = await host.stopped;
    assert.equal(stopped.by, 'client');
    assert.equal(stopped.client, 'test');
    assert.equal(readServiceInfo(home), undefined);
    assert.equal(await leaseHeld(home), false, 'the lease is released last');
  });
}

test('a TCP host whose OS listener closes stops instead of writing without ownership', async (t) => {
  const home = newHome(t);
  const createServer = net.createServer;
  let leaseServer;
  net.createServer = (...args) => { leaseServer = createServer(...args); return leaseServer; };
  // Capture only the lease listener, before host startup proceeds to create its RPC listener.
  const starting = startServiceHost({ home, leaseKind: 'tcp', engineOptions: offline });
  net.createServer = createServer;
  const host = await starting;
  t.after(() => host.stop());
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  await new Promise((resolve) => leaseServer.close(resolve));
  await assert.rejects(host.service.handle('config.set', { values: { 'claude.keepAlive.enabled': true } }), /no longer owns|stopping|stopped/);
  assert.equal((await host.stopped).by, 'lease-lost');
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
});

test('the engine runs its background work only with the lease', (t) => {
  const home = newHome(t);
  const engine = new AccountService({ home, version: 'test', log() {}, ...offline });
  t.after(() => engine.dispose());
  assert.throws(() => engine.start(), /needs the ownership of its home/);
});

test('seed values fill a first run only; existing settings are never replaced', async (t) => {
  const fresh = newHome(t, null);
  const first = await startServiceHost({ home: fresh, engineOptions: offline, seedConfig: { ...QUIET_KEYS, 'codex.proxy.port': 45000 } });
  assert.equal(first.service.config.codex.proxy.port, 45000);
  await first.stop();
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'config.json'), 'utf8')).codex.proxy.port, 45000);

  const home = newHome(t, { ...QUIET, codex: { ...QUIET.codex, proxy: { port: 44000 } } });
  const host = await startServiceHost({ home, engineOptions: offline, initialConfig: { 'codex.proxy.port': 45000, 'claude.cliPath': '/x/claude' } });
  t.after(() => host.stop());
  assert.equal(host.service.config.codex.proxy.port, 44000, 'an existing value wins over the seed');
  assert.equal(host.service.config.claude.cliPath, '/x/claude', 'a key the file lacked is seeded');
});
const QUIET_KEYS = { 'claude.enabled': false, 'codex.enabled': false, 'codex.autoReset.enabled': false, 'copilot.enabled': false, 'bridge.autoStart': false };

test('config patches are revision-checked per key; reconnecting clients cannot overwrite newer values', async (t) => {
  const home = newHome(t);
  const host = await startServiceHost({ home, engineOptions: offline });
  t.after(() => host.stop());
  const a = await connectService({ home, client: 'window-a', subscribe: ['configChanged'] });
  const b = await connectService({ home, client: 'window-b' });
  t.after(() => { a.close(); b.close(); });
  const view = await a.call('config.read');
  assert.equal(view.scopes['accountService.background'], 'local');
  assert.equal(view.scopes['statusBar.enabled'], 'presentation');
  assert.equal(view.scopes['bridge.codex.sessionDirectory'], 'workspace');
  assert.equal(view.scopes['codex.proxy.port'], 'engine');
  const base = view.revision;
  const events = [];
  a.on('event', (event) => events.push(event));

  const changed = await b.call('config.patch', { values: { 'codex.proxy.port': 45001 }, baseRevision: base, source: 'window-b' });
  assert.deepEqual(changed.changed, ['codex.proxy.port']);
  assert.equal(changed.revision, base + 1);
  // Window A still has the old view: its change of the same key is refused, of another key accepted.
  await assert.rejects(a.call('config.patch', { values: { 'codex.proxy.port': 43117 }, baseRevision: base }),
    (error) => error.code === 'config-conflict' && /codex\.proxy\.port/.test(error.message));
  const other = await a.call('config.patch', { values: { 'claude.keepAlive.periodHours': 3 }, baseRevision: base });
  assert.equal(other.revision, base + 2);
  assert.equal(host.service.config.codex.proxy.port, 45001);
  await assert.rejects(a.call('config.patch', { values: { 'accountService.background': false } }), (error) => error.code === 'config-local-setting');
  await assert.rejects(a.call('config.patch', { values: { 'codex.proxy.port': 'x' } }), (error) => error.code === 'config-invalid');
  // An unchanged value is no change and no revision.
  assert.deepEqual((await a.call('config.patch', { values: { 'codex.proxy.port': 45001 }, baseRevision: 0 })).changed, []);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events.filter((event) => event.event === 'configChanged').map((event) => [event.changed, event.revision]),
    [[['codex.proxy.port'], base + 1], [['claude.keepAlive.periodHours'], base + 2]]);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(saved.revision, base + 2);
  assert.equal(saved.revisions['codex.proxy.port'], base + 1);
  // The legacy unconditional write still works for the command line.
  assert.equal((await b.setConfig({ 'codex.proxy.port': 45002 })).codex.proxy.port, 45002);
});

test('a hand edit is merged with a new revision, and an unparsable file is set aside rather than overwritten', (t) => {
  const home = newHome(t);
  const file = path.join(home, 'config.json');
  const logs = [];
  const authority = new ConfigAuthority(file, { persist: true, log: (line) => logs.push(line) });
  authority.patch({ 'claude.cliPath': '/a' });
  const revision = authority.revision;
  const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
  edited.codex.cliPath = '/hand';
  fs.writeFileSync(file, JSON.stringify(edited, null, 1));
  // A patch based on the old view of that key now conflicts, because the hand edit came later.
  assert.throws(() => authority.patch({ 'codex.cliPath': '/b' }, { baseRevision: revision }), (error) => error.code === 'config-conflict');
  assert.equal(authority.config.codex.cliPath, '/hand');
  assert.equal(authority.revisionOf('codex.cliPath'), revision + 1);

  fs.writeFileSync(file, '{ not json');
  assert.equal(authority.reloadIfChanged(), undefined);
  assert.equal(authority.config.codex.cliPath, '/hand', 'an unreadable file keeps the current settings');
  authority.patch({ 'claude.cliPath': '/c' });
  const aside = fs.readdirSync(home).filter((name) => name.startsWith('config.json.invalid-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(home, aside[0]), 'utf8'), '{ not json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claude.cliPath, '/c');
  assert.equal(settingScope('accountService.enabled'), 'local');
});

test('an engine without the lease writes no configuration', (t) => {
  const home = newHome(t, null);
  const authority = new ConfigAuthority(path.join(home, 'config.json'), { persist: false, seed: { 'codex.proxy.port': 45000 },
    assertWritable: () => { throw new Error('not the owner'); } });
  assert.equal(authority.config.codex.proxy.port, 45000);
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
  assert.throws(() => authority.patch({ 'codex.proxy.port': 45001 }), /not the owner/);
  assert.equal(authority.config.codex.proxy.port, 45000, 'a refused write leaves the values unchanged');
});

test('workspace contexts are per connection and go with the bridge requests of that connection only', async (t) => {
  const home = newHome(t);
  const host = await startServiceHost({ home, engineOptions: offline });
  t.after(() => host.stop());
  const seen = [];
  host.service.runtime.bridge.syncSettings = async (context) => { seen.push(context); };
  const a = await connectService({ home, client: 'a', folders: [path.join(home, 'wa')] });
  const b = await connectService({ home, client: 'b' });
  t.after(() => { a.close(); b.close(); });
  const context = await a.call('workspace.context', { sessionDirectory: { codex: '/work/a', claude: '' }, github: { accounts: [{ login: 'u', token: 't' }], workspaceOwners: ['org'] } });
  assert.deepEqual(context.folders, [path.join(home, 'wa')]);
  assert.deepEqual(context.sessionDirectory, { codex: '/work/a' });
  await b.call('workspace.context', { folders: ['/work/b'] });
  await a.call('bridge.sync');
  await b.call('bridge.sync');
  assert.deepEqual(seen, [{ folders: [path.join(home, 'wa')], sessionDirectory: { codex: '/work/a' } }, { folders: ['/work/b'] }]);
  const closed = new Promise((resolve) => setTimeout(resolve, 50));
  a.close();
  await closed;
  const ids = [...Array(10).keys()];
  assert.equal(ids.map((id) => host.service.workspaceContext(id)).filter((entry) => entry?.sessionDirectory).length, 0, 'a closed connection leaves no context');
});

test('stopping waits for the bridge process to exit before the lease is released', async (t) => {
  const home = newHome(t);
  const host = await startServiceHost({ home, leaseKind: 'tcp', engineOptions: offline });
  let exit;
  host.service.runtime.bridge.dispose = () => new Promise((resolve) => { exit = resolve; });
  const stopping = host.stop('test');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await leaseHeld(home, { kind: 'tcp' }), true, 'still owned while the bridge child runs');
  await assert.rejects(startServiceHost({ home, leaseKind: 'tcp', ownerWaitMs: 100, engineOptions: offline }), (error) => error instanceof EngineOwnedError);
  exit();
  await stopping;
  assert.equal(await leaseHeld(home, { kind: 'tcp' }), false);
  assert.equal((await host.stopped).by, 'host');
});

test('a request cancelled or past its deadline before it starts changes nothing', async (t) => {
  const home = newHome(t);
  const host = await startServiceHost({ home, engineOptions: offline });
  t.after(() => host.stop());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(host.service.handle('config.set', { values: { 'codex.proxy.port': 45005 } }, 1, { signal: controller.signal }), (error) => error.code === 'cancelled');
  await assert.rejects(host.service.handle('config.set', { values: { 'codex.proxy.port': 45005 } }, 1, { deadlineAt: Date.now() - 1 }), (error) => error.code === 'timeout');
  assert.equal(host.service.config.codex.proxy.port, 43117);
});

const claudeLogin = (token) => ({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: 9999999999999 } });
function ownedEngine(t, home, extra = {}) {
  const ownership = { owned: true, held() { return this.owned; }, assertHeld() { if (!this.owned) { throw Object.assign(new Error('no longer owns'), { code: 'lease-lost' }); } } };
  const engine = new AccountService({ home, version: 'test', log() {}, ownership, ...offline,
    identityOf: async (provider, credential) => ({ email: `${credential.claudeAiOauth?.accessToken}@example.com`, accountId: `account-${credential.claudeAiOauth?.accessToken}` }), ...extra });
  t.after(() => engine.dispose().catch(() => undefined));
  return { engine, ownership };
}
function holdSweep(engine) {
  let release;
  engine.automation.pending = new Promise((resolve) => { release = resolve; });
  return () => release();
}
const savedNames = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'profiles.json'), 'utf8')).claude?.profiles?.map((p) => p.name) ?? []; } catch { return []; } };

test('a change queued behind a sweep is refused when its request was cancelled meanwhile', async (t) => {
  const home = newHome(t);
  const { engine } = ownedEngine(t, home);
  const release = holdSweep(engine);
  const controller = new AbortController();
  const queued = engine.handle('profiles.importCredential', { provider: 'claude', name: 'Late', credential: claudeLogin('late') }, 1, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  release();
  await assert.rejects(queued, (error) => error.code === 'cancelled');
  assert.deepEqual(savedNames(home), []);
});

test('stopping drains admitted work: a queued change is refused, and nothing is written after dispose resolves', async (t) => {
  const home = newHome(t);
  const { engine } = ownedEngine(t, home);
  const release = holdSweep(engine);
  const queued = engine.handle('profiles.importCredential', { provider: 'claude', name: 'Late', credential: claudeLogin('late') }, 1, {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  let disposed = false;
  const disposing = engine.dispose().then(() => { disposed = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disposed, false, 'dispose waits for the admitted request');
  await assert.rejects(engine.handle('config.set', { values: { 'codex.proxy.port': 45009 } }, 1), (error) => error.code === 'closed');
  release();
  await assert.rejects(queued, (error) => error.code === 'closed');
  await disposing;
  assert.deepEqual(savedNames(home), []);
});

test('a change queued while the lease is lost is refused when it reaches the front', async (t) => {
  const home = newHome(t);
  const { engine, ownership } = ownedEngine(t, home);
  const release = holdSweep(engine);
  const queued = engine.handle('profiles.importCredential', { provider: 'claude', name: 'Late', credential: claudeLogin('late') }, 1, {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  ownership.owned = false;
  release();
  await assert.rejects(queued, /no longer owns/);
  assert.deepEqual(savedNames(home), []);
});

test('dispose rejects when admitted work does not finish in time, and can be retried', async (t) => {
  const home = newHome(t);
  const { engine } = ownedEngine(t, home, { drainTimeoutMs: 100 });
  let finish;
  const stuck = new Promise((resolve) => { finish = resolve; });
  engine.track(stuck);
  await assert.rejects(engine.dispose(), /did not finish/);
  finish();
  await engine.dispose();
});

test('a host whose engine did not stop cleanly keeps the lease; a retried stop releases it', async (t) => {
  const home = newHome(t);
  const host = await startServiceHost({ home, leaseKind: 'tcp', engineOptions: offline });
  const bridge = host.service.runtime.bridge;
  let fail = true;
  bridge.dispose = async () => { if (fail) { throw new Error('the previous CLI bridge did not exit'); } };
  await assert.rejects(host.stop('test'), /did not stop cleanly/);
  assert.equal(await leaseHeld(home, { kind: 'tcp' }), true, 'still owned: the bridge child may be alive');
  await assert.rejects(startServiceHost({ home, leaseKind: 'tcp', ownerWaitMs: 100, engineOptions: offline }), (error) => error instanceof EngineOwnedError && error.code === 'owner-unreachable');
  fail = false;
  await host.stop('retry');
  assert.equal(await leaseHeld(home, { kind: 'tcp' }), false);
  assert.equal((await host.stopped).reason, 'retry');
});

test('the dispatcher answers unknown methods and bad parameters with typed codes', async (t) => {
  const home = newHome(t);
  const { engine } = ownedEngine(t, home);
  await assert.rejects(engine.handle('nothing.here', {}), (error) => error.code === 'unknown_method');
  await assert.rejects(engine.handle('profiles.list', { provider: 'gemini' }), (error) => error.code === 'invalid_params');
  await assert.rejects(engine.handle('usage.live', { provider: 'x' }), (error) => error.code === 'invalid_params');
  await assert.rejects(engine.handle('config.patch', { values: {}, baseRevision: -1 }), (error) => error.code === 'invalid_params');
});
