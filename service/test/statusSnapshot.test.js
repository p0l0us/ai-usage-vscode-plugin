require('../../test/helpers/fixtureNetwork');
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { AccountService } = require('../out/accountService');
const { isolateHomes, seedFixture } = require('../../test/helpers/runtimeHost');
const { serializeLiveUsage } = require('../out/usageMonitor');

function fixture(t) {
  const f = isolateHomes(t); seedFixture(f.home, f.env);
  let now = Date.now(), reads = 0, probes = 0;
  const service = new AccountService({ home: f.home, version: 'synthetic', log: () => {}, now: () => now,
    identityOf: async (provider, credential) => ({ accountId: credential.tokens?.account_id || credential.claudeAiOauth?.accessToken }),
    fetchUsage: async provider => { reads++; return { kind: 'ok', usage: { provider, title: provider, source: 'api', fetchedAt: new Date(now), windows: [{ label: '5h', usedPercent: 35.6, resetsAt: new Date(now + 3600000) }], ...(provider === 'codex' ? { resetCredits: { availableCount: 0 } } : {}) } }; },
    probe: async () => { probes++; throw new Error('Subscription cannot probe'); },
    reset: async () => { throw new Error('Subscription cannot redeem'); },
    verifyCodex: async () => ({ status: 'match', detail: 'synthetic' }), syncClaudeMetadata: async () => ({ status: 'synced', detail: 'synthetic' }) });
  f.cleanups.push(() => service.dispose());
  return { ...f, service, calls: () => [reads, probes], advance: ms => { now += ms; }, now: () => now };
}
const provider = (snapshot, id) => snapshot.providers.find(value => value.provider === id);

test('cached status baseline/counts/conditional cursor/filters observe no provider calls or mutations', async t => {
  const f = fixture(t);
  const saved = await f.service.handle('profiles.saveNative', { provider: 'codex', name: 'Saved zero' });
  await f.service.liveUsage('codex');
  await f.service.handle('profiles.importCredential', { provider: 'codex', name: 'Unknown credits', credential: { tokens: { access_token: 'other', account_id: 'other' } } });
  const calls = f.calls();
  const initial = await f.service.handle('status.snapshot');
  assert.equal(initial.status, 'snapshot');
  const codex = provider(initial.snapshot, 'codex');
  assert.equal(codex.savedAccountCount, 2); assert.equal(codex.accounts.length, 2);
  assert.equal(codex.accounts.find(row => row.id === saved.profile.id).resetCredits.availableCount, 0);
  assert.equal(codex.accounts.find(row => row.id !== saved.profile.id).resetCredits.state, 'unknown');
  assert.equal(codex.native.kind, 'saved'); assert.equal(codex.native.resetCredits.availableCount, 0);
  for (let i = 0; i < 5; i++) {
    assert.equal((await f.service.handle('status.snapshot', { since: initial.snapshot.cursor })).status, 'unchanged');
  }
  const filtered = await f.service.handle('status.snapshot', { providers: ['codex'], accountIds: [codex.accounts.find(row => row.id !== saved.profile.id).id] });
  assert.equal(filtered.snapshot.providers.length, 1); assert.equal(filtered.snapshot.providers[0].savedAccountCount, 2);
  assert.equal(filtered.snapshot.providers[0].accounts.length, 1); assert.equal(filtered.snapshot.providers[0].native.kind, 'unknown');
  assert.equal(filtered.snapshot.providers[0].native.profileId, undefined); assert.deepEqual(filtered.snapshot.providers[0].native.quota.windows, []);
  assert.equal((await f.service.handle('status.snapshot', { since: { epoch: 'previous-engine', revision: 99 } })).resync, true);
  assert.deepEqual(f.calls(), calls);
  assert.ok(!JSON.stringify(initial).includes('synthetic-codex')); assert.ok(!JSON.stringify(initial).includes(f.home));
});

test('native unsaved row is separate; changed native identity withholds old quota and credit facts', async t => {
  const f = fixture(t); await f.service.liveUsage('codex');
  const first = f.service.statusSnapshot().snapshot;
  assert.equal(provider(first, 'codex').savedAccountCount, 0); assert.equal(provider(first, 'codex').native.kind, 'unsaved');
  const filtered = f.service.statusSnapshot({ accountIds: ['nonexistent'] }).snapshot;
  assert.equal(provider(filtered, 'codex').native.kind, 'unknown');
  fs.writeFileSync(path.join(f.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { access_token: 'changed', account_id: 'changed' } }));
  const changed = provider(f.service.statusSnapshot().snapshot, 'codex');
  assert.equal(changed.native.kind, 'unknown'); assert.equal(changed.native.resetCredits.state, 'unknown'); assert.deepEqual(changed.native.quota.windows, []);
});

test('status cursor advances for quota/credit freshness and config policy without captures-only churn', async t => {
  const f = fixture(t); await f.service.liveUsage('codex');
  const first = f.service.statusSnapshot().snapshot; const calls = f.calls();
  f.advance(15 * 60000);
  const stale = f.service.statusSnapshot({ since: first.cursor });
  assert.equal(stale.status, 'snapshot'); assert.ok(stale.snapshot.cursor.revision > first.cursor.revision);
  assert.equal(provider(stale.snapshot, 'codex').native.resetCredits.state, 'stale');
  f.advance(1); assert.equal(f.service.statusSnapshot({ since: stale.snapshot.cursor }).status, 'unchanged');
  assert.deepEqual(f.calls(), calls);
  await f.service.handle('config.patch', { values: { 'codex.autoRotate.strategy': 'sequential' }, baseRevision: f.service.configAuthority.revision });
  assert.ok(f.service.statusSnapshot().snapshot.configRevision > first.configRevision);
});

test('status filter bounds and pre-cancelled requests use typed socket errors', async t => {
  const f = fixture(t);
  for (const params of [{ providers: ['bad'] }, { providers: ['claude', 'codex', 'copilot', 'claude'] }, { accountIds: Array(41).fill('x') }, { accountIds: ['x'.repeat(129)] }, { since: { epoch: 'a', revision: -1 } }]) {
    await assert.rejects(f.service.handle('status.snapshot', params), error => error.code === 'invalid_params');
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.handle('status.snapshot', {}, 1, { signal: controller.signal }), error => error.code === 'cancelled');
});

test('per-account expired quota retains independently fresh credit reports and readonly snapshot leaves state intact', async t => {
  const f = fixture(t); const saved = await f.service.handle('profiles.saveNative', { provider: 'codex', name: 'Expired quota' });
  const reading = { provider: 'codex', title: 'Codex', fetchedAt: new Date(f.now()), resetCredits: { availableCount: 2 }, windows: [{ label: '5h', usedPercent: 100, resetsAt: new Date(f.now() - 1) }] };
  f.service.automation.write('codex', saved.profile.id, { usage: serializeLiveUsage(reading) });
  const before = fs.readFileSync(path.join(f.home, 'profiles.json'), 'utf8');
  const account = provider(f.service.statusSnapshot().snapshot, 'codex').accounts[0];
  assert.equal(account.quota.state, 'stale'); assert.equal(account.resetCredits.availableCount, 2);
  assert.equal(fs.readFileSync(path.join(f.home, 'profiles.json'), 'utf8'), before); assert.deepEqual(f.calls(), [0, 0]);
});


test('Copilot normal toolbar-context cache is shared with own status only; context replacement and disconnect invalidate', async t => {
  const f = fixture(t);
  await f.service.handle('usage.context', { accounts: [{ login: 'A', token: 'synthetic-a' }], workspaceOwners: ['A'] }, 11);
  await f.service.handle('usage.context', { accounts: [{ login: 'B', token: 'synthetic-b' }], workspaceOwners: ['B'] }, 22);
  const toolbar = await f.service.liveUsage('copilot', false, 11);
  const calls = f.calls();
  const own = provider(f.service.statusSnapshot({}, 11).snapshot, 'copilot');
  const other = provider(f.service.statusSnapshot({}, 22).snapshot, 'copilot');
  assert.equal(own.native.quota.windows[0].usedPercent, toolbar.result.usage.windows[0].usedPercent);
  assert.equal(other.native.quota.state, 'unknown'); assert.deepEqual(other.native.quota.windows, []);
  assert.deepEqual(f.calls(), calls);
  await f.service.handle('workspace.context', { github: { accounts: [{ login: 'A2', token: 'synthetic-a2' }] } }, 11);
  assert.equal(provider(f.service.statusSnapshot({}, 11).snapshot, 'copilot').native.quota.state, 'unknown');
  f.service.forgetFolders(11); assert.equal(f.service.retainedStatus.has('copilot:11'), false);
});

test('one engine freshness deadline event updates status without requests and shutdown clears state/timer', async t => {
  const f = fixture(t); const events = [];
  const reading = { provider: 'codex', title: 'Codex', fetchedAt: new Date(f.now()).toISOString(), windows: [{ label: '5h', usedPercent: 4, resetsAt: new Date(f.now() + 80).toISOString() }] };
  const id = await f.service.handle('profiles.saveNative', { provider: 'codex', name: 'clock' });
  f.service.automation.write('codex', id.profile.id, { usage: reading });
  f.service.events.on('event', event => { if (event.event === 'statusChanged') events.push(event); });
  const cursor = f.service.statusSnapshot().snapshot.cursor;
  f.advance(80);
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.ok(events.some(event => event.cursor.revision > cursor.revision));
  assert.deepEqual(f.calls(), [0, 0]);
  await f.service.dispose();
  assert.equal(f.service.statusTimer, undefined); assert.equal(f.service.retainedStatus.size, 0);
  assert.equal(f.service.statusLifecycle, 'stopped');
});

test('changing Copilot account selection withholds retained previous-account facts until normal collection', async t => {
  const f = fixture(t); await f.service.liveUsage('copilot');
  const calls = f.calls();
  assert.equal(provider(f.service.statusSnapshot().snapshot, 'copilot').native.quota.state, 'fresh');
  f.service.configAuthority.patch({ 'copilot.account': 'other-account' });
  assert.equal(provider(f.service.statusSnapshot().snapshot, 'copilot').native.quota.state, 'unknown');
  assert.deepEqual(f.calls(), calls);
});


test('late ordinary Copilot read cannot repopulate replaced context or account selection', async t => {
  for (const change of ['context', 'account']) {
    const f = fixture(t); let release, entered;
    const blocked = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    f.service.usageMonitor.options.fetch = async provider => {
      entered(); await blocked;
      return { kind: 'ok', usage: { provider, title: provider, fetchedAt: new Date(f.now()), windows: [{ label: '7d', usedPercent: 42 }] } };
    };
    await f.service.handle('usage.context', { workspaceOwners: ['old'] }, 3);
    const reading = f.service.liveUsage('copilot', true, 3); await ready;
    if (change === 'context') await f.service.handle('workspace.context', { github: { workspaceOwners: ['new'] } }, 3);
    else f.service.configAuthority.patch({ 'copilot.account': 'new' });
    release(); await reading;
    assert.equal(provider(f.service.statusSnapshot({}, 3).snapshot, 'copilot').native.quota.state, 'unknown', change);
  }
});

test('Codex native projection keeps unknown-auto/session-log provenance unattributed and API positive', async t => {
  for (const source of [undefined, 'sessionLog', 'api']) {
    const f = fixture(t); await f.service.handle('profiles.saveNative', { provider: 'codex', name: 'Attribution' });
    f.service.usageMonitor.options.fetch = async provider => ({ kind: 'ok', usage: { provider, title: provider, source, fetchedAt: new Date(f.now()), windows: [{ label: '5h', usedPercent: 4 }] } });
    await f.service.liveUsage('codex', true);
    const native = provider(f.service.statusSnapshot().snapshot, 'codex').native;
    assert.equal(native.quota.accountAttributed, source === 'api');
  }
});

test('saved-account probe reading without a source tag retains positive native attribution', async t => {
  const f = fixture(t); const saved = await f.service.handle('profiles.saveNative', { provider: 'codex', name: 'Probe facts' });
  f.service.automation.write('codex', saved.profile.id, { usage: { provider: 'codex', title: 'Codex', fetchedAt: new Date(f.now()).toISOString(), windows: [{ label: '5h', usedPercent: 10 }] } });
  f.service.usageMonitor.options.fetch = async provider => ({ kind: 'ok', usage: { provider, title: provider, fetchedAt: new Date(f.now() - 1000), windows: [{ label: '5h', usedPercent: 20 }] } });
  await f.service.liveUsage('codex', true);
  const native = provider(f.service.statusSnapshot().snapshot, 'codex').native;
  assert.equal(native.quota.accountAttributed, true); assert.equal(native.quota.windows[0].usedPercent, 10);
});
