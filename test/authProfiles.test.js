const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const informationMessages = [];
const errorMessages = [];
const warningMessages = [];
const warningResponses = [];
const inputBoxResponses = [];
const quickPickResponses = [];
const settings = new Map();
// This suite exercises SecretStorage/native-file behavior without a running VS Code host.
const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'vscode') return {
    QuickPickItemKind: { Separator: -1 },
    window: {
      showInformationMessage(message) { informationMessages.push(message); },
      showErrorMessage(message) { errorMessages.push(message); },
      showWarningMessage(message) { warningMessages.push(message); return warningResponses.shift(); },
      showInputBox: async () => inputBoxResponses.shift(),
      showQuickPick(items) {
        const response = quickPickResponses.shift();
        return typeof response === 'function' ? response(items) : response;
      }
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    commands: { executeCommand: async () => undefined },
    workspace: {
      getConfiguration: () => ({
        get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
        inspect: (key) => ({ globalValue: settings.get(key) }),
        update: async (key, value) => { settings.set(key, value); }
      })
    }
  };
  return load.call(this, id, ...args);
};
const { AuthProfileManager } = require('../out/authProfiles');
Module._load = load;

function fixture(t, verify) {
  informationMessages.length = 0;
  errorMessages.length = 0;
  warningMessages.length = 0;
  warningResponses.length = 0;
  inputBoxResponses.length = 0;
  quickPickResponses.length = 0;
  settings.clear();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-profile-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const previousCodex = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = home;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const before = { claudeAiOauth: { accessToken: 'before', refreshToken: 'refresh-before' } };
  const after = { claudeAiOauth: { accessToken: 'after', refreshToken: 'refresh-after' } };
  const file = path.join(home, '.credentials.json');
  fs.writeFileSync(file, JSON.stringify({ ...before, mcpOAuth: { unrelated: true } }));
  const codex = { auth_mode: 'chatgpt', tokens: { access_token: 'x', refresh_token: 'y', account_id: 'acc-x' }, last_refresh: '2026-09-17T00:00:00Z' };
  let state = { claude: { profiles: [{ id: 'a', name: 'A' }], activeProfileId: 'a' }, codex: { profiles: [{ id: 'x', name: 'X' }] } };
  const globalValues = new Map([['aiUsage.authProfiles.v1', state]]);
  const secrets = new Map([
    ['aiUsage.authProfile.v1.claude.a', JSON.stringify(before)],
    ['aiUsage.authProfile.v1.codex.x', JSON.stringify(codex)]
  ]);
  const manager = new AuthProfileManager({
    globalState: {
      get: key => structuredClone(globalValues.get(key)),
      update: async (key, value) => {
        globalValues.set(key, structuredClone(value));
        if (key === 'aiUsage.authProfiles.v1') state = structuredClone(value);
      }
    },
    secrets: { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); } }
  }, () => {}, undefined, verify, async (provider, credential) =>
    provider === 'codex' ? (credential.tokens?.account_id === 'acc-x' ? 'x@example.com' : undefined) : (credential.claudeAiOauth?.accessToken === 'after' ? 'a@example.com' : undefined));
  return { manager, before, after, file, secrets, state, globalValues, settings, codex, codexFile: path.join(home, 'auth.json') };
}

test('account feature switches are ordinary settings per provider', async t => {
  const f = fixture(t);
  assert.equal(f.manager.automationEnabled('claude', 'keepAlive'), false);
  assert.equal(f.manager.automationEnabled('codex', 'autoRotate'), false);
  await f.manager.setAutomationEnabled('claude', 'keepAlive', true);
  await f.manager.setAutomationEnabled('codex', 'autoRotate', true);
  assert.equal(f.settings.get('aiUsage.claude.keepAlive.enabled'), true);
  assert.equal(f.settings.get('aiUsage.codex.autoRotate.enabled'), true);
  assert.equal(f.manager.automationEnabled('claude', 'keepAlive'), true);
  assert.equal(f.manager.automationEnabled('claude', 'autoRotate'), false);
  assert.equal(f.manager.automationEnabled('codex', 'keepAlive'), false);
  assert.equal(f.manager.automationEnabled('codex', 'autoRotate'), true);
});

test('switches saved by the previous menu toggles move into settings once', async t => {
  const f = fixture(t);
  settings.set('aiUsage.claude.keepAlive.enabled', false);
  f.globalValues.set('aiUsage.accountAutomation.v1', {
    claude: { keepAlive: true, autoRotate: true },
    codex: { keepAlive: true, autoRotate: false }
  });
  await f.manager.migrateAutomationSettings();
  assert.equal(f.manager.automationEnabled('claude', 'autoRotate'), true);
  assert.equal(f.manager.automationEnabled('codex', 'keepAlive'), true);
  assert.equal(f.manager.automationEnabled('codex', 'autoRotate'), false);
  // A setting the user already chose wins over the state left behind by the old menu.
  assert.equal(f.manager.automationEnabled('claude', 'keepAlive'), false);
  assert.equal(f.globalValues.get('aiUsage.accountAutomation.v1'), undefined);
  await f.manager.migrateAutomationSettings();
  assert.equal(f.manager.automationEnabled('codex', 'keepAlive'), true);
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

test('automatic activation identifies the service and destination account', async t => {
  const f = fixture(t);
  assert.equal(await f.manager.activateProfile('claude', 'a', true), true);
  assert.deepEqual(informationMessages, ['AI Usage: Claude automatically rotated to account “A”.']);
});

test('account menu offers an immediate keep-alive action when profiles exist', t => {
  const f = fixture(t);
  const action = f.manager.items('claude').find(item => item.action === 'keepAliveNow');
  assert.match(action.label, /Send keep-alive now/);
  assert.match(action.detail, /refresh its usage statistics/);
});

test('save current login can replace an existing profile', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify(f.after));
  quickPickResponses.push(items => items.find(item => item.profile?.id === 'a'));
  assert.equal(await f.manager.saveCurrent('claude'), true);
  assert.deepEqual(JSON.parse(f.secrets.get('aiUsage.authProfile.v1.claude.a')), f.after);
  assert.equal(f.globalValues.get('aiUsage.authProfiles.v1').claude.activeProfileId, 'a');
  assert.deepEqual(informationMessages, ['Claude profile “A” updated from the current login.']);
});

test('Codex activation tells the user open chats follow on their next turn', async t => {
  const verified = [];
  const f = fixture(t, async (provider, credential) => { verified.push([provider, credential]); return { status: 'match', detail: 'Codex reports account acc-x.' }; });
  assert.equal(await f.manager.activateProfile('codex', 'x'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.codexFile)), f.codex);
  assert.deepEqual(verified, [['codex', f.codex]]);
  assert.deepEqual(informationMessages, ['Codex switched to “X”. New Codex CLI sessions use it now; the Codex extension needs an extension restart.']);
  assert.deepEqual(errorMessages, []);
  informationMessages.length = 0;
  assert.equal(await f.manager.activateProfile('codex', 'x', true), true);
  assert.deepEqual(informationMessages, ['AI Usage: Codex automatically rotated to account “X”. New Codex CLI sessions use it now; the Codex extension needs an extension restart.']);
});

test('a verifier mismatch replaces the success message with an error and keeps the profile active', async t => {
  const f = fixture(t, async () => ({ status: 'mismatch', detail: 'Codex reports account acc-other, expected acc-x.' }));
  assert.equal(await f.manager.activateProfile('codex', 'x'), true);
  assert.deepEqual(informationMessages, []);
  assert.equal(errorMessages.length, 1);
  assert.match(errorMessages[0], /switched to “X”, but Codex reports a different login\. Codex reports account acc-other/);
  assert.equal(f.globalValues.get('aiUsage.authProfiles.v1').codex.activeProfileId, 'x');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.codexFile)), f.codex);
});

test('an unverifiable or failing verifier still reports success', async t => {
  const f = fixture(t, async () => { throw new Error('codex not installed'); });
  assert.equal(await f.manager.activateProfile('codex', 'x'), true);
  assert.deepEqual(informationMessages, ['Codex switched to “X”. New Codex CLI sessions use it now; the Codex extension needs an extension restart.']);
  assert.deepEqual(errorMessages, []);
});

test('Claude activation keeps its wording and is not verified', async t => {
  const verified = [];
  const f = fixture(t, async (provider) => { verified.push(provider); return undefined; });
  assert.equal(await f.manager.activateProfile('claude', 'a'), true);
  assert.deepEqual(verified, ['claude']);
  assert.deepEqual(informationMessages, ['Claude switched to “A”. New requests will use this login.']);
});

test('saving or replacing a login records its email and the menu shows it beside the name', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify(f.after));
  quickPickResponses.push(items => items.find(item => item.profile?.id === 'a'));
  assert.equal(await f.manager.saveCurrent('claude'), true);
  assert.equal(f.globalValues.get('aiUsage.authProfiles.v1').claude.profiles[0].email, 'a@example.com');
  const item = f.manager.items('claude').find(item => item.profile?.id === 'a');
  assert.equal(item.description, 'a@example.com · Active');
});

test('profiles saved before emails were recorded are backfilled when the menu opens', async t => {
  const f = fixture(t);
  quickPickResponses.push(undefined); // close the menu right away
  await f.manager.show('codex');
  assert.equal(f.globalValues.get('aiUsage.authProfiles.v1').codex.profiles[0].email, 'x@example.com');
  assert.equal(f.manager.items('codex').find(item => item.profile?.id === 'x').description, 'x@example.com');
});

test('saving a login that is already saved warns about token revocation and marks the duplicate', async t => {
  const f = fixture(t);
  // Profile X already records its email; the native Codex file holds that same account.
  f.globalValues.get('aiUsage.authProfiles.v1').codex.profiles[0].email = 'x@example.com';
  fs.writeFileSync(f.codexFile, JSON.stringify(f.codex));
  quickPickResponses.push(items => items.find(item => item.create));
  warningResponses.push(undefined); // user dismisses the warning
  assert.equal(await f.manager.saveCurrent('codex'), false);
  assert.equal(warningMessages.length, 1);
  assert.match(warningMessages[0], /already saved as “X”.*revoked/);
  assert.equal(f.globalValues.get('aiUsage.authProfiles.v1').codex.profiles.length, 1);
  // Accepting the copy still works, and the menu marks both entries as duplicates of each other.
  quickPickResponses.push(items => items.find(item => item.create));
  warningResponses.push('Save a copy anyway');
  inputBoxResponses.push('X copy');
  assert.equal(await f.manager.saveCurrent('codex'), true);
  const items = f.manager.items('codex').filter(item => item.profile);
  assert.equal(items.length, 2);
  assert.equal(items[0].description, 'x@example.com · duplicate of “X copy”');
  assert.equal(items[1].description, 'x@example.com · duplicate of “X” · Active');
});
