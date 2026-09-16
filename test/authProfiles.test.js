const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
// This suite exercises SecretStorage/native-file behavior without a running VS Code host.
const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'vscode') return {
    window: { showInformationMessage() {}, showErrorMessage() {} },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) }
  };
  return load.call(this, id, ...args);
};
const { AuthProfileManager } = require('../out/authProfiles');
Module._load = load;

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-profile-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const before = { claudeAiOauth: { accessToken: 'before', refreshToken: 'refresh-before' } };
  const after = { claudeAiOauth: { accessToken: 'after', refreshToken: 'refresh-after' } };
  const file = path.join(home, '.credentials.json');
  fs.writeFileSync(file, JSON.stringify({ ...before, mcpOAuth: { unrelated: true } }));
  let state = { claude: { profiles: [{ id: 'a', name: 'A' }], activeProfileId: 'a' }, codex: { profiles: [] } };
  const globalValues = new Map([['aiUsage.authProfiles.v1', state]]);
  const secrets = new Map([['aiUsage.authProfile.v1.claude.a', JSON.stringify(before)]]);
  const manager = new AuthProfileManager({
    globalState: {
      get: key => structuredClone(globalValues.get(key)),
      update: async (key, value) => {
        globalValues.set(key, structuredClone(value));
        if (key === 'aiUsage.authProfiles.v1') state = structuredClone(value);
      }
    },
    secrets: { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); } }
  }, () => {});
  return { manager, before, after, file, secrets, state, globalValues };
}

test('account feature switches are stored in extension state per provider', async t => {
  const f = fixture(t);
  assert.equal(f.manager.automationEnabled('claude', 'keepAlive'), false);
  assert.equal(f.manager.automationEnabled('codex', 'autoRotate'), false);
  await f.manager.setAutomationEnabled('claude', 'keepAlive', true);
  await f.manager.setAutomationEnabled('codex', 'autoRotate', true);
  assert.equal(f.manager.automationEnabled('claude', 'keepAlive'), true);
  assert.equal(f.manager.automationEnabled('claude', 'autoRotate'), false);
  assert.equal(f.manager.automationEnabled('codex', 'keepAlive'), false);
  assert.equal(f.manager.automationEnabled('codex', 'autoRotate'), true);
  assert.deepEqual(f.globalValues.get('aiUsage.accountAutomation.v1'), {
    claude: { keepAlive: true, autoRotate: false },
    codex: { keepAlive: false, autoRotate: true }
  });
});

test('active background refresh updates native and secret credentials while preserving MCP data', async t => {
  const f = fixture(t);
  await f.manager.refreshedCredential('claude', 'a', f.before, f.after);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), { ...f.after, mcpOAuth: { unrelated: true } });
  assert.deepEqual(JSON.parse(f.secrets.values().next().value), f.after);
});

test('background refresh does not overwrite a login changed during the call', async t => {
  const f = fixture(t);
  const external = { claudeAiOauth: { accessToken: 'external', refreshToken: 'external' } };
  fs.writeFileSync(f.file, JSON.stringify(external));
  await f.manager.refreshedCredential('claude', 'a', f.before, f.after);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), external);
  assert.deepEqual(JSON.parse(f.secrets.values().next().value), f.before);
});

test('inactive token refresh is saved without changing the native login', async t => {
  const f = fixture(t);
  f.state.claude.activeProfileId = undefined;
  await f.manager.refreshedCredential('claude', 'a', f.before, f.after);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).claudeAiOauth.accessToken, 'before');
  assert.deepEqual(JSON.parse(f.secrets.values().next().value), f.after);
});

test('reactivating the current profile preserves tokens refreshed in the native CLI', async t => {
  const f = fixture(t);
  const refreshed = { claudeAiOauth: { ...f.before.claudeAiOauth, accessToken: 'native-refresh' } };
  fs.writeFileSync(f.file, JSON.stringify(refreshed));
  assert.equal(await f.manager.activateProfile('claude', 'a'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), refreshed);
});
