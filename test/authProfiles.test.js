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
const saveDialogResponses = [];
const openDialogResponses = [];
const openedDocuments = [];
const workspaceFolders = [];
const uri = (fsPath) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` });
const settings = new Map();
// This suite exercises SecretStorage/native-file behavior without a running VS Code host.
const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'vscode') return {
    QuickPickItemKind: { Separator: -1 },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    window: {
      showInformationMessage(message) { informationMessages.push(message); },
      showErrorMessage(message) { errorMessages.push(message); },
      showWarningMessage(message) { warningMessages.push(message); return warningResponses.shift(); },
      showInputBox: async () => inputBoxResponses.shift(),
      showQuickPick(items, options) {
        const response = quickPickResponses.shift();
        return typeof response === 'function' ? response(items, options) : response;
      },
      showSaveDialog: async () => saveDialogResponses.shift(),
      showOpenDialog: async () => openDialogResponses.shift(),
      showTextDocument: async (target) => { openedDocuments.push(target.fsPath); }
    },
    Uri: { file: uri },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    commands: { executeCommand: async () => undefined },
    workspace: {
      get workspaceFolders() { return workspaceFolders; },
      fs: {
        readFile: async (target) => fs.readFileSync(target.fsPath),
        writeFile: async (target, bytes) => fs.writeFileSync(target.fsPath, bytes)
      },
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
  saveDialogResponses.length = 0;
  openDialogResponses.length = 0;
  openedDocuments.length = 0;
  workspaceFolders.length = 0;
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
    provider === 'codex'
      ? { email: credential.tokens?.account_id === 'acc-x' ? 'x@example.com' : undefined, accountId: credential.tokens?.account_id }
      : credential.claudeAiOauth?.accessToken === 'external'
        ? { email: 'other@example.com', accountId: 'account-other' }
        : { email: 'a@example.com', accountId: 'account-a' });
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

test('same-organization Claude users cannot overwrite each other during token capture', async t => {
  const f = fixture(t);
  const state = f.globalValues.get('aiUsage.authProfiles.v1');
  state.claude.profiles[0].email = 'a@example.com';
  state.claude.profiles[0].accountId = 'account-a';
  f.globalValues.set('aiUsage.authProfiles.v1', state);
  const otherUser = { claudeAiOauth: { accessToken: 'external', refreshToken: 'external' }, organizationUuid: 'shared-team' };
  const savedUser = { ...f.before, organizationUuid: 'shared-team' };
  f.secrets.set('aiUsage.authProfile.v1.claude.a', JSON.stringify(savedUser));
  fs.writeFileSync(f.file, JSON.stringify(otherUser));
  assert.equal(await f.manager.activateProfile('claude', 'a'), true);
  assert.deepEqual(JSON.parse(f.secrets.get('aiUsage.authProfile.v1.claude.a')), savedUser);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).claudeAiOauth, savedUser.claudeAiOauth);
});

test('automatic activation identifies the service and destination account', async t => {
  const f = fixture(t);
  assert.equal(await f.manager.activateProfile('claude', 'a', true), true);
  assert.deepEqual(informationMessages, ['AI Usage: Claude automatically rotated to account “A”. Chats and CLI sessions use it from their next turn.']);
});

test('account menu offers an immediate keep-alive action when profiles exist', t => {
  const f = fixture(t);
  const action = f.manager.items('claude').find(item => item.action === 'keepAliveNow');
  assert.match(action.label, /Send keep-alive now/);
  assert.match(action.detail, /refresh usage statistics/);
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

test('Claude verification upgrades legacy identity but rejects a different stable account UUID', async t => {
  const verified = { status: 'match', detail: 'Claude reports login new@example.com.', email: 'new@example.com', accountId: 'account-new' };
  const migrated = fixture(t, async () => verified);
  const legacy = migrated.globalValues.get('aiUsage.authProfiles.v1');
  legacy.claude.profiles[0].email = 'stale@example.com';
  migrated.globalValues.set('aiUsage.authProfiles.v1', legacy);
  assert.equal(await migrated.manager.activateProfile('claude', 'a'), true);
  assert.equal(migrated.globalValues.get('aiUsage.authProfiles.v1').claude.profiles[0].email, 'new@example.com');
  assert.equal(migrated.globalValues.get('aiUsage.authProfiles.v1').claude.profiles[0].accountId, 'account-new');
  assert.equal(errorMessages.length, 0);

  const mismatch = fixture(t, async () => verified);
  const identified = mismatch.globalValues.get('aiUsage.authProfiles.v1');
  identified.claude.profiles[0].email = 'saved@example.com';
  identified.claude.profiles[0].accountId = 'account-saved';
  mismatch.globalValues.set('aiUsage.authProfiles.v1', identified);
  assert.equal(await mismatch.manager.activateProfile('claude', 'a'), true);
  assert.match(errorMessages[0], /token belongs to new@example\.com.*saved for saved@example\.com/);
  assert.equal(mismatch.globalValues.get('aiUsage.authProfiles.v1').claude.profiles[0].accountId, 'account-saved');
});

test('a failing verifier switches the login but says the account could not be confirmed', async t => {
  const f = fixture(t, async () => { throw new Error('codex not installed'); });
  assert.equal(await f.manager.activateProfile('codex', 'x'), true);
  assert.deepEqual(informationMessages, []);
  assert.deepEqual(warningMessages, ['AI Usage: Codex switched to “X”, but the login could not be confirmed: codex not installed']);
  assert.deepEqual(errorMessages, []);
});

test('an unverified verdict is reported as a warning with the reason', async t => {
  const f = fixture(t, async () => ({ status: 'unverified', detail: 'the profile endpoint answered HTTP 429; the previous account identity was removed.' }));
  assert.equal(await f.manager.activateProfile('claude', 'a'), true);
  assert.deepEqual(informationMessages, []);
  assert.match(warningMessages[0], /Claude switched to “A”, but the login could not be confirmed: the profile endpoint answered HTTP 429/);
});

test('Claude activation keeps its wording and is not verified', async t => {
  const verified = [];
  const f = fixture(t, async (provider) => { verified.push(provider); return undefined; });
  assert.equal(await f.manager.activateProfile('claude', 'a'), true);
  assert.deepEqual(verified, ['claude']);
  assert.deepEqual(informationMessages, ['Claude switched to “A”. Chats and CLI sessions use it from their next turn.']);
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

test('items() marks an exhausted profile read-only and a Fable-only cap as dimmed but selectable', async t => {
  const f = fixture(t);
  f.manager.limitState = (provider, id) => (provider === 'claude' && id === 'a') ? { readOnly: true, dimmed: false } : undefined;
  const readOnlyItem = f.manager.items('claude').find(item => item.profile?.id === 'a');
  assert.equal(readOnlyItem.readOnly, true);
  assert.match(readOnlyItem.label, /^\$\(circle-slash\) A$/);
  assert.equal(readOnlyItem.description, 'Active · At its usage limit');

  f.manager.limitState = (provider, id) => (provider === 'claude' && id === 'a') ? { readOnly: false, dimmed: true } : undefined;
  const dimmedItem = f.manager.items('claude').find(item => item.profile?.id === 'a');
  assert.equal(dimmedItem.readOnly, false);
  assert.equal(dimmedItem.label, 'A');
  assert.equal(dimmedItem.iconPath.id, 'check');
  assert.equal(dimmedItem.iconPath.color.id, 'disabledForeground');
  assert.equal(dimmedItem.description, 'Active · Fable limit reached');
});

test('a read-only profile warns instead of activating', async t => {
  const f = fixture(t);
  f.manager.limitState = (provider, id) => (provider === 'claude' && id === 'a') ? { readOnly: true, dimmed: false } : undefined;
  quickPickResponses.push(items => items.find(item => item.profile?.id === 'a'));
  quickPickResponses.push(undefined); // close the menu
  await f.manager.show('claude');
  assert.deepEqual(warningMessages, ['“A” is at its usage limit and can\'t be activated until it resets.']);
  assert.equal(informationMessages.length, 0);
});

test('a profile with a login problem is marked and offers renew, keep-alive or back instead of activating', async t => {
  const f = fixture(t);
  const problem = 'Keep-alive CLI exited with code 1: Failed to authenticate: OAuth session expired and could not be refreshed';
  f.manager.loginProblem = (provider, id) => (provider === 'claude' && id === 'a') ? problem : undefined;
  const item = f.manager.items('claude').find(item => item.profile?.id === 'a');
  assert.equal(item.label, 'A');
  assert.equal(item.iconPath.id, 'warning');
  assert.equal(item.iconPath.color.id, 'editorWarning.foreground');
  assert.equal(item.description, 'Active · Login problem');
  assert.equal(item.loginProblem, problem);
  const checked = [], signedIn = [], changes = [];
  const hooks = {
    sendKeepAlive: async (provider, profiles) => { checked.push([provider, profiles.map(profile => profile.id)]); },
    signIn: async (provider, profile) => { signedIn.push([provider, profile.id]); },
    afterActivate: async (provider, change) => { changes.push(change); }
  };
  // Choosing the profile opens its menu: renew first, keep-alive second, Back last, the problem as the placeholder.
  let menu;
  quickPickResponses.push(items => items.find(item => item.profile?.id === 'a'));
  quickPickResponses.push((items, options) => {
    menu = { items, options };
    return items.find(item => item.choice === 'keepAlive');
  });
  quickPickResponses.push(undefined); // close the accounts list that reopens after the check
  await f.manager.show('claude', hooks);
  assert.deepEqual(menu.items.filter(item => item.kind === undefined).map(item => item.label),
    ['$(sign-in) Renew the login…', '$(play) Try a keep-alive', '$(check) Select anyway', '$(arrow-left) Back']);
  assert.match(menu.items[0].detail, /separate home inside the keep-alive home .* “A”/);
  assert.equal(menu.options.title, 'AI Usage · Claude account “A” · Login problem');
  assert.equal(menu.options.placeHolder, 'Login expired. The saved login has expired and could not be refreshed. Sign in again for this profile.');
  assert.deepEqual(checked, [['claude', ['a']]]);
  assert.deepEqual(signedIn, []);

  // Renew hands the profile to the sign-in hook, which signs in under the keep-alive home.
  quickPickResponses.push(items => items.find(item => item.profile?.id === 'a'));
  quickPickResponses.push(items => items.find(item => item.choice === 'renew'));
  quickPickResponses.push(undefined);
  await f.manager.show('claude', hooks);
  assert.deepEqual(signedIn, [['claude', 'a']]);
  assert.deepEqual(checked, [['claude', ['a']]]);

  // Back returns to the accounts list without doing anything to the login.
  quickPickResponses.push(items => items.find(item => item.profile?.id === 'a'));
  quickPickResponses.push(items => items.find(item => /Back/.test(item.label)));
  quickPickResponses.push(items => { assert.ok(items.some(item => item.profile?.id === 'a')); return undefined; });
  await f.manager.show('claude', hooks);
  assert.deepEqual(signedIn, [['claude', 'a']]);
  assert.deepEqual(checked, [['claude', ['a']]]);
  assert.deepEqual(changes, []);
  assert.equal(warningMessages.length, 0);

  // Select anyway activates the login as it is and closes the menu, like choosing a healthy profile.
  quickPickResponses.push(items => items.find(item => item.profile?.id === 'a'));
  quickPickResponses.push(items => items.find(item => item.choice === 'select'));
  await f.manager.show('claude', hooks);
  assert.deepEqual(changes, [{ kind: 'activated', accountChanged: false }]);
  assert.equal(quickPickResponses.length, 0);
  assert.deepEqual(checked, [['claude', ['a']]]);

  // An exhausted account is blocked as before; its login trouble is not what stops it.
  f.manager.limitState = (provider, id) => (provider === 'claude' && id === 'a') ? { readOnly: true, dimmed: false } : undefined;
  const blocked = f.manager.items('claude').find(item => item.profile?.id === 'a');
  assert.equal(blocked.loginProblem, undefined);
  assert.match(blocked.description, /Active · At its usage limit$/);
});

test('Sign in again… picks a saved profile and hands it to the sign-in hook', async t => {
  const f = fixture(t);
  const signedIn = [];
  const action = f.manager.items('claude').find(item => item.action === 'signIn');
  assert.match(action.label, /Sign in again/);
  quickPickResponses.push(items => items.find(item => item.action === 'signIn'));
  quickPickResponses.push(items => items.find(item => item.profile?.id === 'a'));
  quickPickResponses.push(undefined);
  await f.manager.show('claude', { signIn: async (provider, profile) => { signedIn.push([provider, profile.id]); } });
  assert.deepEqual(signedIn, [['claude', 'a']]);
});

test('only a real account change is reported to the activation hook', async t => {
  const f = fixture(t);
  const changes = [];
  const hooks = { afterActivate: async (provider, change) => { changes.push([provider, change.kind, change.accountChanged]); } };
  // Re-selecting the login that is already active and already written starts nothing on a new account.
  quickPickResponses.push(items => items.find(item => item.profile?.id === 'a'));
  await f.manager.show('claude', hooks);
  assert.deepEqual(changes, [['claude', 'activated', false]]);

  // Saving the current login into a profile is not a switch either.
  changes.length = 0;
  fs.writeFileSync(f.file, JSON.stringify(f.after));
  quickPickResponses.push(items => items.find(item => item.action === 'save'));
  quickPickResponses.push(items => items.find(item => item.profile?.id === 'a'));
  quickPickResponses.push(() => undefined);
  await f.manager.show('claude', hooks);
  assert.deepEqual(changes, [['claude', 'saved', false]]);
});

test('switching to another profile is reported as an account change', async t => {
  const f = fixture(t);
  const state = f.globalValues.get('aiUsage.authProfiles.v1');
  state.claude.profiles.push({ id: 'b', name: 'B' });
  f.globalValues.set('aiUsage.authProfiles.v1', state);
  f.secrets.set('aiUsage.authProfile.v1.claude.b', JSON.stringify({ claudeAiOauth: { accessToken: 'b', refreshToken: 'refresh-b' } }));
  const changes = [];
  const activations = [];
  f.manager.onActivated = (provider, change) => activations.push([provider, change.previous?.id, change.profile.id, change.automatic, change.external]);
  quickPickResponses.push(items => items.find(item => item.profile?.id === 'b'));
  await f.manager.show('claude', { afterActivate: async (provider, change) => { changes.push(change.accountChanged); } });
  assert.deepEqual(changes, [true]);
  assert.deepEqual(activations, [['claude', 'a', 'b', false, false]]);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).claudeAiOauth.accessToken, 'b');
});

test('a native login switched outside this window makes its saved profile active', async t => {
  const f = fixture(t);
  const state = f.globalValues.get('aiUsage.authProfiles.v1');
  state.claude.profiles = [{ id: 'a', name: 'A', accountId: 'account-a' }, { id: 'b', name: 'B', accountId: 'account-b' }];
  f.globalValues.set('aiUsage.authProfiles.v1', state);
  f.secrets.set('aiUsage.authProfile.v1.claude.b', JSON.stringify({ claudeAiOauth: { accessToken: 'b', refreshToken: 'refresh-b' } }));
  assert.equal(f.manager.activeProfileNumber('claude'), 1);
  const activations = [];
  f.manager.onActivated = (provider, change) => activations.push([change.previous?.id, change.profile.id, change.automatic, change.external]);
  // The same token as the saved copy.
  fs.writeFileSync(f.file, JSON.stringify({ claudeAiOauth: { accessToken: 'b', refreshToken: 'refresh-b' } }));
  await f.manager.followNative('claude');
  assert.equal(f.manager.activeProfileId('claude'), 'b');
  assert.deepEqual(activations, [['a', 'b', false, true]]);
  assert.equal(f.manager.activeProfileNumber('claude'), 2);
  // Rotated tokens: the account file's account UUID decides.
  fs.writeFileSync(f.file, JSON.stringify({ claudeAiOauth: { accessToken: 'new', refreshToken: 'refresh-new' } }));
  fs.writeFileSync(path.join(path.dirname(f.file), '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } }));
  await f.manager.followNative('claude');
  assert.equal(f.manager.activeProfileId('claude'), 'a');
  // A login no saved profile owns keeps the active profile but drops its number.
  fs.writeFileSync(f.file, JSON.stringify({ claudeAiOauth: { accessToken: 'other', refreshToken: 'refresh-other' } }));
  fs.writeFileSync(path.join(path.dirname(f.file), '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-z' } }));
  await f.manager.followNative('claude');
  assert.equal(f.manager.activeProfileId('claude'), 'a');
  assert.equal(f.manager.activeProfileNumber('claude'), undefined);
});

test('export writes the chosen profiles with their logins and names one whose login is missing here', async t => {
  const f = fixture(t);
  f.globalValues.set('aiUsage.authProfiles.v1', { claude: { profiles: [{ id: 'a', name: 'A', email: 'a@example.com' }, { id: 'b', name: 'B' }], activeProfileId: 'a' },
    codex: { profiles: [{ id: 'x', name: 'X' }] } });
  const target = path.join(path.dirname(f.file), 'export.json');
  quickPickResponses.push(items => {
    assert.deepEqual(items.filter(item => item.entry).map(item => [item.label, item.picked]), [['A', true], ['X', true]]);
    return items.filter(item => item.picked);
  });
  saveDialogResponses.push(uri(target));
  assert.equal(await f.manager.exportProfiles(), true);
  const document = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(document.aiUsageProfiles, 1);
  assert.deepEqual(document.profiles.map(p => [p.provider, p.id, p.name, p.email]), [['claude', 'a', 'A', 'a@example.com'], ['codex', 'x', 'X', undefined]]);
  assert.deepEqual(document.profiles[0].credential, f.before);
  assert.deepEqual(document.profiles[1].credential, f.codex);
  assert.match(warningMessages.at(-1), /exported 2 profiles to .*export\.json\. The file holds their login tokens in plain text.* Skipped, no login on this computer: Claude “B”\./);
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  // The saved file opens in the editor right away.
  assert.deepEqual(openedDocuments, [target]);
});

test('import adds new profiles with their ids, restores a missing login into the same profile, and activates nothing', async t => {
  const f = fixture(t);
  f.globalValues.set('aiUsage.authProfiles.v1', { claude: { profiles: [
    { id: 'a', name: 'A', email: 'a@example.com', accountId: 'account-a' }, { id: 'b', name: 'B', email: 'b@example.com', accountId: 'account-b' }], activeProfileId: 'a' },
    codex: { profiles: [{ id: 'x', name: 'X' }] } });
  const fresh = { claudeAiOauth: { accessToken: 'external', refreshToken: 'r-ext' } };
  const bLogin = { claudeAiOauth: { accessToken: 'b', refreshToken: 'r-b' } };
  const file = path.join(path.dirname(f.file), 'import.json');
  fs.writeFileSync(file, JSON.stringify({ aiUsageProfiles: 1, profiles: [
    { provider: 'claude', id: 'a', name: 'A', email: 'a@example.com', accountId: 'account-a', credential: f.before },
    { provider: 'claude', id: 'b', name: 'B on the server', email: 'b@example.com', accountId: 'account-b', credential: bLogin },
    { provider: 'claude', id: 'n', name: 'A', email: 'other@example.com', accountId: 'account-other', credential: fresh },
    { provider: 'codex', id: 'y', name: 'Y', credential: { ...f.codex, tokens: { ...f.codex.tokens, account_id: 'acc-y' } } }
  ] }));
  openDialogResponses.push([uri(file)]);
  quickPickResponses.push(items => {
    assert.deepEqual(items.filter(item => item.plan).map(item => [item.label, item.description, item.picked]), [
      ['A', 'a@example.com · already saved', false],
      ['B on the server', 'b@example.com · restores the missing login of “B”', true],
      ['A', 'other@example.com · new profile', true],
      ['Y', 'new profile', true]
    ]);
    return items.filter(item => item.picked);
  });
  assert.equal(await f.manager.importProfiles(), true);
  const state = f.globalValues.get('aiUsage.authProfiles.v1');
  assert.deepEqual(state.claude.profiles.map(p => [p.id, p.name]), [['a', 'A'], ['b', 'B'], ['n', 'A (2)']]);
  assert.equal(state.claude.activeProfileId, 'a');
  assert.deepEqual(state.codex.profiles.map(p => [p.id, p.name, p.accountId]), [['x', 'X', undefined], ['y', 'Y', 'acc-y']]);
  assert.deepEqual(JSON.parse(f.secrets.get('aiUsage.authProfile.v1.claude.b')), bLogin);
  assert.deepEqual(JSON.parse(f.secrets.get('aiUsage.authProfile.v1.claude.n')), fresh);
  assert.equal(JSON.parse(f.secrets.get('aiUsage.authProfile.v1.codex.y')).tokens.account_id, 'acc-y');
  assert.match(informationMessages.at(-1), /imported 3 profiles: 2 added, 1 login restored\. Nothing was activated/);
  // The native login is not touched: nothing is activated by an import.
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).claudeAiOauth, f.before.claudeAiOauth);
});

test('a file that is not a profile export is refused with the reason', async t => {
  const f = fixture(t);
  const file = path.join(path.dirname(f.file), 'credential.json');
  fs.writeFileSync(file, JSON.stringify(f.before));
  openDialogResponses.push([uri(file)]);
  assert.equal(await f.manager.importProfiles(), false);
  assert.match(errorMessages.at(-1), /could not import the profiles: The selected file is not an AI Usage profile export/);
});

test('export and import share one Accounts menu item that opens a picker of the two', async t => {
  const f = fixture(t);
  const labels = f.manager.items('claude').map(item => item.label);
  assert.equal(labels.filter(label => label === '$(arrow-swap) Export or import saved profiles…').length, 1);
  assert.ok(!labels.some(label => label.endsWith('Export saved profiles…') || label.endsWith('Import saved profiles…')));
  const target = path.join(path.dirname(f.file), 'export.json');
  quickPickResponses.push(items => items.find(item => item.action === 'transfer'));
  quickPickResponses.push(items => {
    assert.deepEqual(items.map(item => item.label), ['$(export) Export saved profiles…', '$(cloud-download) Import saved profiles…', '', '$(arrow-left) Back']);
    return items[0];
  });
  quickPickResponses.push(items => items.filter(item => item.picked));
  saveDialogResponses.push(uri(target));
  // Back in the accounts list afterwards; closing it ends the menu.
  quickPickResponses.push(undefined);
  await f.manager.show('claude');
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).profiles.map(p => [p.provider, p.id]), [['claude', 'a'], ['codex', 'x']]);
  assert.equal(quickPickResponses.length, 0);
});

function projectFolder(t, options = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-project-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  if (options.git) fs.mkdirSync(path.join(folder, '.git'));
  workspaceFolders.push({ uri: { scheme: 'file', fsPath: folder }, name: path.basename(folder) });
  return folder;
}

test('project profiles in an open folder are listed with the private ones, keep their login in the file, and are written back', async t => {
  const f = fixture(t);
  const project = projectFolder(t);
  // The file's path is a setting, relative to the folder.
  settings.set('aiUsage.projectProfiles.file', 'config/ai-usage.json');
  const file = path.join(project, 'config', 'ai-usage.json');
  fs.mkdirSync(path.dirname(file));
  const login = { claudeAiOauth: { accessToken: 'project', refreshToken: 'r-project' } };
  fs.writeFileSync(file, JSON.stringify({ aiUsageProfiles: 1, profiles: [{ provider: 'claude', id: 'p1', name: 'Client', email: 'client@example.com', accountId: 'acc-c',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', credential: login }] }));
  assert.deepEqual(f.manager.profiles('claude').map(p => [p.id, p.name, p.folder]), [['a', 'A', undefined], ['p1', 'Client', project]]);
  assert.match(f.manager.items('claude').find(item => item.profile?.id === 'p1').description, /^client@example.com · project ai-usage-project-/);
  assert.deepEqual(await f.manager.credential('claude', 'p1'), login);
  assert.equal(f.secrets.has('aiUsage.authProfile.v1.claude.p1'), false);
  // A refreshed token goes back to the project file; the private list in global state is untouched.
  const refreshed = { claudeAiOauth: { accessToken: 'project2', refreshToken: 'r-project2' } };
  await f.manager.refreshedCredential('claude', 'p1', login, refreshed);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0].credential, refreshed);
  assert.deepEqual(await f.manager.credential('claude', 'p1'), refreshed);
  assert.deepEqual(f.globalValues.get('aiUsage.authProfiles.v1').claude.profiles.map(p => p.id), ['a']);
  // With project profiles turned off the folder is left alone and its profiles are not listed.
  settings.set('aiUsage.projectProfiles.enabled', false);
  assert.deepEqual(f.manager.profiles('claude').map(p => p.id), ['a']);
  settings.set('aiUsage.projectProfiles.enabled', true);
  // Deleting a project profile removes it from the file.
  quickPickResponses.push(items => items.find(item => item.profile?.id === 'p1'));
  warningResponses.push('Delete');
  await f.manager.delete('claude');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).profiles, []);
  assert.deepEqual(f.manager.profiles('claude').map(p => p.id), ['a']);
});

test('saving the current login asks where to keep it and writes a project profile to the folder, ignored by Git', async t => {
  const f = fixture(t);
  const project = projectFolder(t, { git: true });
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/');
  // A native login that is not the saved profile's, so it is not a duplicate.
  fs.writeFileSync(f.file, JSON.stringify({ claudeAiOauth: { accessToken: 'external', refreshToken: 'r-ext' } }));
  quickPickResponses.push(items => items.find(item => item.create));
  inputBoxResponses.push('Client');
  quickPickResponses.push(items => {
    assert.deepEqual(items.map(item => item.label), ['$(account) Private profile', '$(root-folder) Project profile']);
    return items[1];
  });
  assert.equal(await f.manager.saveCurrent('claude'), true);
  assert.match(informationMessages.at(-1), /login saved as “Client” in project ai-usage-project-/);
  const file = path.join(project, '.ai-usage.profiles.json');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written.profiles.map(p => [p.provider, p.name, p.email, p.accountId, p.credential.claudeAiOauth.accessToken]),
    [['claude', 'Client', 'other@example.com', 'account-other', 'external']]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), 'node_modules/\n# AI Usage project profiles hold login tokens\n.ai-usage.profiles.json\n');
  assert.ok(informationMessages.some(message => /added \.ai-usage\.profiles\.json to .*\.gitignore/.test(message)));
  const state = f.globalValues.get('aiUsage.authProfiles.v1');
  assert.deepEqual(state.claude.profiles.map(p => p.id), ['a']);
  assert.equal(state.claude.activeProfileId, written.profiles[0].id);
  assert.equal([...f.secrets.keys()].some(key => key.includes(written.profiles[0].id)), false);
  assert.deepEqual(f.manager.profiles('claude').map(p => [p.name, p.folder]), [['A', undefined], ['Client', project]]);
  // With one kind possible there is nothing to choose.
  settings.set('aiUsage.projectProfiles.enabled', false);
  assert.deepEqual(await f.manager.pickScope(), {});
  settings.set('aiUsage.projectProfiles.enabled', true);
  settings.set('aiUsage.privateProfiles.enabled', false);
  assert.deepEqual(await f.manager.pickScope(), { folder: project });
});

test('a project file in a subfolder is not added to .gitignore again when its folder is already ignored', async t => {
  const f = fixture(t);
  const project = projectFolder(t, { git: true });
  settings.set('aiUsage.projectProfiles.file', 'secrets/ai-usage.json');
  fs.writeFileSync(path.join(project, '.gitignore'), 'secrets/\n');
  fs.writeFileSync(f.file, JSON.stringify({ claudeAiOauth: { accessToken: 'external', refreshToken: 'r-ext' } }));
  quickPickResponses.push(items => items.find(item => item.create));
  inputBoxResponses.push('Client');
  quickPickResponses.push(items => items[1]);
  assert.equal(await f.manager.saveCurrent('claude'), true);
  assert.ok(fs.existsSync(path.join(project, 'secrets', 'ai-usage.json')));
  assert.equal(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), 'secrets/\n');
});
