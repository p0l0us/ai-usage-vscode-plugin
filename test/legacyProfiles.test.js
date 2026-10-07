const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'vscode') return {};
  return load.call(this, id, ...args);
};
const { collectLegacyProfiles, copyLegacyReadings, migrateLegacyProfiles } = require('../out/legacyProfiles');
Module._load = load;

const state = () => ({
  claude: { profiles: [{ id: 'a', name: 'Work', email: 'a@example.com', accountId: 'acc-a', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' }, { id: 'b', name: 'Lost' }], activeProfileId: 'a' },
  codex: { profiles: [{ id: 'x', name: 'Main' }] }
});
const secrets = () => new Map([
  ['aiUsage.authProfile.v1.claude.a', JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } })],
  ['aiUsage.authProfile.v1.codex.x', JSON.stringify({ tokens: { access_token: 't', refresh_token: 'r', account_id: 'acc-x' } })]
]);

test('the previous storage is read into import entries; a profile without a login is named', async () => {
  const store = secrets();
  const collected = await collectLegacyProfiles({ get: () => state() }, { get: async (key) => store.get(key) });
  assert.deepEqual(collected.entries.map((entry) => [entry.provider, entry.id, entry.name, entry.email, entry.accountId]),
    [['claude', 'a', 'Work', 'a@example.com', 'acc-a'], ['codex', 'x', 'Main', undefined, undefined]]);
  assert.equal(collected.entries[0].createdAt, '2026-01-01T00:00:00Z');
  assert.ok(collected.entries[1].createdAt, 'missing dates are filled in');
  assert.deepEqual(collected.withoutLogin, ['Claude “Lost”']);
  assert.deepEqual(collected.activeIds, { claude: 'a' });
  assert.deepEqual((await collectLegacyProfiles({ get: () => undefined }, { get: async () => undefined })).entries, []);
});

test('migration imports the entries once, copies the readings, and removes the previous copies', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const globalStorage = path.join(root, 'global');
  fs.mkdirSync(path.join(globalStorage, 'account-usage'), { recursive: true });
  fs.writeFileSync(path.join(globalStorage, 'account-usage', 'claude-abc.json'), '{"checkedAt":1}');
  fs.writeFileSync(path.join(globalStorage, 'account-usage', 'claude.lock'), '1');
  const home = path.join(root, 'home');
  const values = new Map([['aiUsage.authProfiles.v1', state()]]);
  const store = secrets();
  const deleted = [];
  const context = {
    globalState: { get: (key) => values.get(key), update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); } },
    secrets: { get: async (key) => store.get(key), delete: async (key) => { deleted.push(key); store.delete(key); } },
    globalStorageUri: { fsPath: globalStorage }
  };
  const imported = [];
  const client = { applyImportEntries: async (entries) => { imported.push(entries); return { imported: entries.length, counts: { new: 2, restore: 0, replace: 0, same: 0 }, summary: '2 added' }; } };
  const logs = [];
  const result = await migrateLegacyProfiles(context, client, home, (line) => logs.push(line));
  assert.deepEqual(result, { moved: 2, withoutLogin: ['Claude “Lost”'] });
  assert.equal(imported.length, 1);
  assert.deepEqual(imported[0].map((entry) => entry.id), ['a', 'x']);
  assert.ok(fs.existsSync(path.join(home, 'state', 'account-usage', 'claude-abc.json')));
  assert.ok(!fs.existsSync(path.join(home, 'state', 'account-usage', 'claude.lock')));
  assert.deepEqual(deleted, ['aiUsage.authProfile.v1.claude.a', 'aiUsage.authProfile.v1.codex.x']);
  assert.equal(values.get('aiUsage.authProfiles.v1'), undefined);
  assert.equal(values.get('aiUsage.authProfilesMigrated.v1'), true);
  // Never twice.
  assert.equal(await migrateLegacyProfiles(context, client, home, () => undefined), undefined);
  assert.equal(imported.length, 1);
  assert.equal(copyLegacyReadings(globalStorage, home, () => undefined), 0, 'already copied readings are left alone');
});
