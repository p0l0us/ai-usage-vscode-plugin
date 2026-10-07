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
const { vscodeProfileBackend, vscodeProfileCount, directAccess, transferProfiles, STATE_KEY } = require('../out/vscodeProfiles');
Module._load = load;

const STAMP = '2026-10-07T12:00:00.000Z';
const codexLogin = (account) => ({ auth_mode: 'chatgpt', tokens: { access_token: `access-${account}`, refresh_token: `refresh-${account}`, account_id: account }, last_refresh: STAMP });
const claudeLogin = (token) => ({ claudeAiOauth: { accessToken: token, refreshToken: `refresh-${token}` } });

/** VS Code's global state and SecretStorage for one user, in memory. */
function vscodeStorage(profiles = {}, logins = {}) {
  const state = new Map([[STATE_KEY, profiles]]);
  const secrets = new Map(Object.entries(logins).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    state, secrets,
    context: {
      globalState: { get: (key) => structuredClone(state.get(key)), update: async (key, value) => { state.set(key, structuredClone(value)); } },
      secrets: { get: async (key) => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async (key) => { secrets.delete(key); } }
    }
  };
}

test('the VS Code backend reads the original format and writes the list to global state and logins to SecretStorage', async () => {
  const storage = vscodeStorage(
    { claude: { profiles: [{ id: 'c1', name: 'Claude 1', createdAt: STAMP, updatedAt: STAMP, email: 'user1@example.com' }], activeProfileId: 'c1' },
      codex: { profiles: [{ id: 'x1', name: 'Codex 1', createdAt: STAMP, updatedAt: STAMP }, { id: 'x2', name: 'No login', createdAt: STAMP, updatedAt: STAMP }] } },
    { 'aiUsage.authProfile.v1.claude.c1': claudeLogin('one'), 'aiUsage.authProfile.v1.codex.x1': codexLogin('acc-1') });
  const backend = await vscodeProfileBackend(storage.context, () => {});
  assert.equal(backend.kind, 'vscode');
  const read = backend.read();
  assert.equal(read.claude.activeProfileId, 'c1');
  assert.deepEqual(read.claude.profiles[0].credential, claudeLogin('one'));
  assert.equal(read.codex.profiles[1].credential, undefined, 'a profile without a login is kept, without one');
  assert.equal(vscodeProfileCount(storage.context), 3);

  read.codex.profiles = [read.codex.profiles[0]];
  read.codex.profiles[0].name = 'Codex one';
  read.codex.profiles[0].credential = codexLogin('acc-1b');
  backend.write(read);
  assert.equal(backend.read().codex.profiles[0].name, 'Codex one', 'reads see the write at once');
  await backend.flush();
  const list = storage.state.get(STATE_KEY);
  assert.deepEqual(list.codex.profiles.map((profile) => profile.name), ['Codex one']);
  assert.equal('credential' in list.codex.profiles[0], false, 'no login in global state');
  assert.deepEqual(JSON.parse(storage.secrets.get('aiUsage.authProfile.v1.codex.x1')), codexLogin('acc-1b'));
  assert.ok(storage.secrets.has('aiUsage.authProfile.v1.claude.c1'));
});

test('profiles move from VS Code to the service file and are copied back, logins included', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-transfer-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const storage = vscodeStorage(
    { claude: { profiles: [{ id: 'c1', name: 'Claude 1', createdAt: STAMP, updatedAt: STAMP, email: 'user1@example.com' }] },
      codex: { profiles: [{ id: 'x1', name: 'Codex 1', createdAt: STAMP, updatedAt: STAMP, email: 'user1@example.com' }] } },
    { 'aiUsage.authProfile.v1.claude.c1': claudeLogin('one'), 'aiUsage.authProfile.v1.codex.x1': codexLogin('acc-1') });

  const fromVscode = await directAccess('vscode', home, storage.context, () => {});
  const toService = await directAccess('service', home, storage.context, () => {});
  const entries = await fromVscode.list();
  assert.deepEqual(entries.map((entry) => [entry.provider, entry.name]), [['claude', 'Claude 1'], ['codex', 'Codex 1']]);
  await transferProfiles(fromVscode, toService, entries, true);

  const file = JSON.parse(fs.readFileSync(path.join(home, 'profiles.json'), 'utf8'));
  assert.deepEqual(file.claude.profiles.map((profile) => [profile.id, profile.name, profile.email]), [['c1', 'Claude 1', 'user1@example.com']]);
  assert.deepEqual(file.codex.profiles[0].credential, codexLogin('acc-1'));
  assert.equal(fs.statSync(path.join(home, 'profiles.json')).mode & 0o777, 0o600);
  assert.deepEqual(storage.state.get(STATE_KEY).claude.profiles, [], 'moved: gone from VS Code');
  assert.equal(storage.secrets.size, 0, 'and its logins too');

  const fromService = await directAccess('service', home, storage.context, () => {});
  const toVscode = await directAccess('vscode', home, storage.context, () => {});
  await transferProfiles(fromService, toVscode, await fromService.list(), false);
  assert.deepEqual(storage.state.get(STATE_KEY).codex.profiles.map((profile) => profile.name), ['Codex 1']);
  assert.deepEqual(JSON.parse(storage.secrets.get('aiUsage.authProfile.v1.claude.c1')), claudeLogin('one'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'profiles.json'), 'utf8')).codex.profiles.length, 1, 'copied: still in the service');
});
