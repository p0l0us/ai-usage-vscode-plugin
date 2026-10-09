require('./helpers/fixtureNetwork');
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { startServiceHost, ServiceClient } = require('../service/out');
const { isolateHomes, seedFixture } = require('./helpers/runtimeHost');
const { options } = require('./helpers/statusSnapshotHostChild');
const provider = (snapshot, id) => snapshot.providers.find(value => value.provider === id);
async function fixture(t, mode) {
  const f = isolateHomes(t); seedFixture(f.home, f.env);
  if (mode === 'embedded') {
    f.host = await startServiceHost(options(f.home, mode)); f.cleanups.push(() => f.host.stop());
  } else {
    const child = fork(path.join(__dirname, 'helpers/statusSnapshotHostChild.js'), [], { env: f.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    f.cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.send('stop', () => {});
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      }
    });
    const [message] = await once(child, 'message'); if (message.error) throw new Error(message.error);
  }
  f.connect = async name => {
    const client = await ServiceClient.connect({ home: f.home, client: name, subscribe: ['statusChanged', 'lifecycle'] });
    f.cleanups.push(() => client.close()); return client;
  };
  f.a = await f.connect('status-a'); f.b = await f.connect('status-b');
  f.readCount = () => fs.existsSync(path.join(f.home, 'reads.jsonl')) ? fs.readFileSync(path.join(f.home, 'reads.jsonl'), 'utf8').trim().split('\n').length : 0;
  return f;
}
for (const mode of ['background', 'embedded']) {
  test(`${mode}: multiple status subscribers share cached baseline/counts/credits and reconnect cursors without provider reads`, async t => {
    const f = await fixture(t, mode);
    const saved = await f.a.saveNative('codex', { name: 'Known zero' });
    await f.a.importCredential('codex', 'Unknown credits', { tokens: { access_token: 'second', account_id: 'second' } });
    for (const id of ['claude', 'codex', 'copilot']) await f.a.liveUsage(id);
    const reads = f.readCount(); const first = await f.a.statusSnapshot();
    assert.equal(f.a.supports('status-snapshot'), true);
    const codex = provider(first.snapshot, 'codex');
    assert.equal(codex.savedAccountCount, 2); assert.equal(codex.accounts.length, 2);
    assert.equal(codex.accounts.find(row => row.id === saved.profile.id).resetCredits.availableCount, 0);
    assert.equal(codex.accounts.find(row => row.id !== saved.profile.id).resetCredits.state, 'unknown');
    assert.equal(codex.native.kind, 'saved'); assert.equal(codex.native.profileId, saved.profile.id);
    assert.deepEqual((await f.b.statusSnapshot()).snapshot.cursor, first.snapshot.cursor);
    for (let i = 0; i < 5; i++) assert.equal((await f.b.statusSnapshot({ since: first.snapshot.cursor })).status, 'unchanged');
    const filtered = await f.b.statusSnapshot({ providers: ['codex'], accountIds: [codex.accounts.find(row => row.id !== saved.profile.id).id] });
    assert.equal(filtered.snapshot.providers[0].savedAccountCount, 2); assert.equal(filtered.snapshot.providers[0].native.kind, 'unknown');
    f.b.close(); const reconnect = await f.connect('status-reconnect');
    assert.equal((await reconnect.statusSnapshot({ since: first.snapshot.cursor })).status, 'unchanged');
    assert.equal((await reconnect.statusSnapshot({ since: { epoch: 'old-engine', revision: 1 } })).resync, true);
    assert.equal(f.readCount(), reads);
  });

  test(`${mode}: Copilot normal toolbar context populates same status facts while other context remains unknown`, async t => {
    const f = await fixture(t, mode);
    await f.a.usageContext({ accounts: [{ login: 'A', token: 'synthetic-a' }], workspaceOwners: ['A'] });
    await f.b.usageContext({ accounts: [{ login: 'B', token: 'synthetic-b' }], workspaceOwners: ['B'] });
    const toolbar = await f.a.liveUsage('copilot'); const reads = f.readCount();
    const own = provider((await f.a.statusSnapshot()).snapshot, 'copilot');
    const other = provider((await f.b.statusSnapshot()).snapshot, 'copilot');
    assert.equal(own.native.quota.windows[0].usedPercent, toolbar.result.usage.windows[0].usedPercent);
    assert.equal(other.native.quota.state, 'unknown'); assert.deepEqual(other.native.quota.windows, []);
    await f.a.call('workspace.context', { github: { accounts: [{ login: 'A2', token: 'synthetic-a2' }], workspaceOwners: ['A2'] } });
    assert.equal(provider((await f.a.statusSnapshot()).snapshot, 'copilot').native.quota.state, 'unknown');
    assert.equal(f.readCount(), reads);
  });
}
