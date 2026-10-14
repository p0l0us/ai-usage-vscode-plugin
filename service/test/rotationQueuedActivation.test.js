// Regression for a real incident: a manual `profiles.activate` that arrives while a rotation sweep is switching accounts
// must run after the automatic switch, leaving both switches recorded and the rotation bookkeeping describing the
// automatic one.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountService } = require('../out/accountService');

const HOUR = 3_600_000;
const login = (token) => ({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: 9999999999999 } });
const usage = (percents, now = Date.now()) => ({ provider: 'claude', title: 'claude', fetchedAt: new Date(now),
  windows: percents.map((value, index) => ({ label: index ? '7d' : '5h', usedPercent: value, resetsAt: new Date(now + 24 * HOUR) })) });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-queued-'));
  const claudeHome = path.join(root, 'claude'); fs.mkdirSync(claudeHome);
  const codexHome = path.join(root, 'codex'); fs.mkdirSync(codexHome);
  const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify(login('a')));
  const events = [], probes = [];
  // The first identity sync, which an automatic switch waits for, stays open until the test lets it finish.
  let release; const gate = new Promise(resolve => { release = resolve; });
  let reached; const inSync = new Promise(resolve => { reached = resolve; });
  let syncs = 0;
  const service = new AccountService({
    home: path.join(root, 'home'), version: 'test', log: () => undefined,
    seedConfig: { 'claude.keepAlive.enabled': false, 'codex.keepAlive.enabled': false, 'claude.autoRotate.enabled': true,
      'codex.autoRotate.enabled': false, 'claude.keepAlive.home': path.join(root, '.claude-profile-{number}') },
    fetchUsage: async () => ({ kind: 'ok', usage: usage([50, 5]) }),
    identityOf: async (provider, credential) => ({ email: `${credential.claudeAiOauth?.accessToken}@example.com`, accountId: `account-${credential.claudeAiOauth?.accessToken}` }),
    verifyCodex: async () => ({ status: 'match', detail: 'ok' }),
    syncClaudeMetadata: async (credential) => {
      if (++syncs === 1) { reached(); await gate; }
      return { status: 'synced', detail: 'synced',
        identity: { email: `${credential.claudeAiOauth.accessToken}@example.com`, accountId: `account-${credential.claudeAiOauth.accessToken}` } };
    },
    probe: async (provider, credential, settings, keepAlive) => {
      probes.push([credential.claudeAiOauth.accessToken, keepAlive]);
      return { credential, result: { kind: 'ok', usage: usage([10, 10]) } };
    }
  });
  service.events.on('event', event => events.push(event));
  t.after(async () => {
    release();
    await service.dispose();
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = (method, params) => service.handle(method, params);
  const ids = {};
  ids.a = (await call('profiles.saveNative', { provider: 'claude', name: 'A' })).profile.id;
  ids.b = (await call('profiles.importCredential', { provider: 'claude', name: 'B', credential: login('b') })).profile.id;
  ids.c = (await call('profiles.importCredential', { provider: 'claude', name: 'C', credential: login('c') })).profile.id;
  // a is exhausted, b has a little headroom left and c plenty, so rotation picks c unless the test changes it.
  service.automation.observe('claude', ids.a, usage([100, 5]));
  service.automation.observe('claude', ids.b, usage([10, 10]));
  service.automation.observe('claude', ids.c, usage([60, 60]));
  events.length = 0;
  return { service, call, ids, events, probes, release, inSync, syncs: () => syncs };
}

const switches = f => [...f.service.history.events()].filter(event => event.type === 'switch');
const activated = f => f.events.filter(event => event.event === 'activated');

test('a manual activation requested while rotation is switching runs after the automatic switch', async t => {
  const f = await fixture(t);
  const sweep = f.service.automation.tick();
  await f.inSync; // the sweep has chosen b and is inside the activation, holding the account lock
  assert.equal(f.service.automation.heldFor('claude'), undefined);
  let manualDone = false;
  const manual = f.call('profiles.activate', { provider: 'claude', id: f.ids.c }).then(result => { manualDone = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(manualDone, false, 'the manual request waits for the sweep instead of interleaving with it');
  assert.deepEqual(activated(f), [], 'neither switch has been announced yet');
  f.release();
  const result = await manual;
  await sweep;
  assert.equal(result.profile.id, f.ids.c);
  assert.equal(result.accountChanged, true);
  const view = await f.call('profiles.list', { provider: 'claude' });
  assert.equal(view.activeProfileId, f.ids.c, 'the manual choice is the final active account');

  assert.deepEqual(activated(f).map(event => [event.id, event.automatic]), [[f.ids.b, true], [f.ids.c, false]]);
  const records = switches(f);
  assert.equal(records.length, 2);
  assert.deepEqual([records[0].automatic, records[0].reason, records[0].from.id, records[0].to.id], [true, 'limit', f.ids.a, f.ids.b]);
  assert.deepEqual([records[1].automatic, records[1].reason, records[1].from.id, records[1].to.id], [false, 'manual', f.ids.b, f.ids.c],
    'the manual switch starts from the account the rotation chose');
  assert.deepEqual(f.probes, [], 'neither a usage call nor a keep-alive was needed');
});

test('the queued manual activation does not corrupt the rotation bookkeeping', async t => {
  const f = await fixture(t);
  const sweep = f.service.automation.tick();
  await f.inSync;
  const manual = f.call('profiles.activate', { provider: 'claude', id: f.ids.c });
  f.release();
  await manual;
  await sweep;
  // The activation schedules a tick (its background sweep); let it finish before reading the bookkeeping.
  await f.service.automation.tick();
  // Rotation recorded b when it chose it. The manual switch restarts the stay clock for c, the account now in use,
  // and leaves nothing behind that still counts b as the account being watched.
  const stay = f.service.automation.accountState('claude', 'rotation-stay');
  assert.equal(stay.activeId, f.ids.c, 'the stay record follows the manually chosen account');
  assert.equal(f.service.automation.stayed('claude', f.ids.b), undefined);
  const stayed = f.service.automation.stayed('claude', f.ids.c);
  assert.ok(stayed !== undefined && stayed < 60_000, 'the manually chosen account starts its minimum stay when the switch happens');
  // The next sweep treats c, which is healthy, as the active account and does not move away from it.
  f.service.automation.observe('claude', f.ids.c, usage([20, 20]));
  await f.service.automation.tick();
  assert.equal((await f.call('profiles.list', { provider: 'claude' })).activeProfileId, f.ids.c);
  assert.equal(switches(f).length, 2, 'no further switch follows');
});

test('a manual activation of the account rotation just chose records no second switch', async t => {
  const f = await fixture(t);
  f.service.automation.observe('claude', f.ids.c, usage([99.9, 99.9]));
  f.service.automation.observe('claude', f.ids.b, usage([10, 10]));
  const sweep = f.service.automation.tick();
  await f.inSync;
  const manual = f.call('profiles.activate', { provider: 'claude', id: f.ids.b });
  f.release();
  const result = await manual;
  await sweep;
  assert.equal(result.profile.id, f.ids.b);
  assert.equal(result.accountChanged, false, 'the account is already active when the request runs');
  assert.equal((await f.call('profiles.list', { provider: 'claude' })).activeProfileId, f.ids.b);
  const records = switches(f);
  assert.equal(records.length, 1, 'only the automatic switch is recorded');
  assert.deepEqual([records[0].automatic, records[0].to.id], [true, f.ids.b]);
  // The request is still announced, as a manual activation that changed nothing.
  assert.deepEqual(activated(f).map(event => [event.id, event.automatic, event.accountChanged]), [[f.ids.b, true, true], [f.ids.b, false, false]]);
  assert.equal(f.service.automation.accountState('claude', 'rotation-stay').activeId, f.ids.b);
});
