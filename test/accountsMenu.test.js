const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const informationMessages = [];
const warningMessages = [];
const errorMessages = [];
const warningResponses = [];
const inputBoxResponses = [];
const quickPickResponses = [];
const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'vscode') return {
    QuickPickItemKind: { Separator: -1 },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    ConfigurationTarget: { Global: 1 },
    ProgressLocation: { Notification: 15 },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    Uri: { file: (fsPath) => ({ scheme: 'file', fsPath }) },
    window: {
      showInformationMessage(message) { informationMessages.push(message); },
      showWarningMessage(message) { warningMessages.push(message); return warningResponses.shift(); },
      showErrorMessage(message) { errorMessages.push(message); },
      showInputBox: async () => inputBoxResponses.shift(),
      showQuickPick(items) { const response = quickPickResponses.shift(); return typeof response === 'function' ? response(items) : response; }
    },
    commands: { executeCommand: async () => undefined },
    workspace: { fs: {}, getConfiguration: () => ({ get: (key, fallback) => fallback, update: async () => undefined }) }
  };
  return load.call(this, id, ...args);
};
const { AccountsMenu, usageDetail, pickScope } = require('../out/accountsMenu');
Module._load = load;
const { defaultConfig } = require('../service/out/configStore');

const scopes = { privateEnabled: true, projectEnabled: true, folders: [] };
const profile = (overrides) => ({ id: 'a', name: 'Work', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', active: false, number: 1, problems: [],
  limit: { readOnly: false, dimmed: false }, hasCredential: true, ...overrides });

function fixture(views) {
  informationMessages.length = 0; warningMessages.length = 0; errorMessages.length = 0;
  warningResponses.length = 0; inputBoxResponses.length = 0; quickPickResponses.length = 0;
  const calls = [];
  const client = {
    connected: true, info: { version: 'test', clients: 1 },
    list: async (provider) => views[provider],
    activate: async (provider, id) => { calls.push(['activate', provider, id]); return { level: 'info', message: 'ok' }; },
    saveNative: async (provider, options) => { calls.push(['saveNative', provider, options]); return options.name === 'Twin' && !options.allowDuplicate
      ? { status: 'duplicate', twin: { id: 'a', name: 'Work' }, warning: 'already saved as “Work”' } : { status: options.id ? 'updated' : 'saved', profile: { id: 'n', name: options.name ?? 'Work' } }; },
    rename: async (provider, id, name) => { calls.push(['rename', provider, id, name]); return { id, name }; },
    delete: async (provider, id) => { calls.push(['delete', provider, id]); return { profile: { id, name: 'x' }, wasActive: false }; },
    keepAliveNow: async (provider, id) => { calls.push(['keepAliveNow', provider, id]); return {}; },
    getConfig: async () => defaultConfig()
  };
  const services = { enabled: true, connected: client, views: {}, config: defaultConfig(), isInstalled: () => true, require: () => client, ensure: async () => client, install: async () => true, showMenu: async () => { calls.push(['showMenu']); } };
  const menu = new AccountsMenu(services, () => undefined);
  return { menu, calls, services };
}

test('the usage detail line shows every window, the check time and known problems', () => {
  const now = Date.now();
  const detail = usageDetail(profile({ usage: { provider: 'claude', title: 'Claude', fetchedAt: new Date(now).toISOString(), windows: [
    { label: '5h', usedPercent: 41, resetsAt: new Date(now + 2 * 3_600_000).toISOString() }, { label: '7d', usedPercent: 7 }] },
    problems: [{ check: 'keepAlive', raw: 'x', label: 'Insufficient credits', known: true }, { check: 'usage', raw: 'weird', label: 'weird', known: false }] }));
  assert.match(detail, /^5h: 41% \(2h\) · 7d: 7% · Checked .* · \$\(warning\) Insufficient credits · \$\(warning\) Usage check failed: weird$/);
  assert.equal(usageDetail(profile()), undefined);
});

test('choosing a profile activates it through the service and closes the menu; an exhausted one only warns', async () => {
  const views = { claude: { provider: 'claude', title: 'Claude', profiles: [profile({ active: true }), profile({ id: 'b', name: 'Full', number: 2, limit: { readOnly: true, dimmed: false } })],
    activeProfileId: 'a', activeNumber: 1, nativeUnsaved: false, checkingActive: false, keepAlive: true, autoRotate: false, strategySummary: '', scopes } };
  const f = fixture(views);
  quickPickResponses.push((items) => {
    assert.equal(items[0].label, '$(check) Work');
    assert.equal(items[0].description, 'Active');
    assert.equal(items[1].label, '$(circle-slash) Full');
    assert.match(items[1].description, /At its usage limit/);
    assert.ok(items.some((item) => item.action === 'save'), 'manage actions are listed');
    assert.ok(items.some((item) => item.action === 'service'), 'the service item is listed');
    assert.match(items.find((item) => item.action === 'settings').description, /Keep-alive on · rotation off/);
    return items[1];
  });
  quickPickResponses.push((items) => items[0]);
  const hooks = { sendKeepAlive: async () => undefined, signIn: async () => undefined, beforeActivate: async () => { f.calls.push(['before']); } };
  await f.menu.show('claude', hooks);
  assert.match(warningMessages[0], /at its usage limit/);
  assert.deepEqual(f.calls, [['before'], ['activate', 'claude', 'a']]);
  assert.equal(quickPickResponses.length, 0);
});

test('a profile with a login problem is checked again instead of activated', async () => {
  const views = { codex: { provider: 'codex', title: 'Codex', profiles: [profile({ loginProblem: 'OAuth token has expired' })], nativeUnsaved: false, checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '', scopes } };
  const f = fixture(views);
  const sent = [];
  quickPickResponses.push((items) => { assert.match(items[0].description, /Login problem/); return items[0]; });
  quickPickResponses.push(undefined);
  await f.menu.show('codex', { sendKeepAlive: async (provider, profiles) => { sent.push([provider, profiles.map((p) => p.id)]); }, signIn: async () => undefined });
  assert.deepEqual(sent, [['codex', ['a']]]);
  assert.deepEqual(f.calls, []);
});

test('saving the current login asks for a name, warns about a duplicate, and can update an existing profile', async () => {
  const views = { claude: { provider: 'claude', title: 'Claude', profiles: [profile({ active: true })], activeProfileId: 'a', nativeUnsaved: false, checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '', scopes } };
  const f = fixture(views);
  const saved = [];
  const hooks = { sendKeepAlive: async () => undefined, signIn: async () => undefined, afterSaved: async (provider) => { saved.push(provider); } };
  // Create a new profile whose login is already saved: declined, then accepted as a copy.
  quickPickResponses.push((items) => items.find((item) => item.action === 'save'));
  quickPickResponses.push((items) => items.find((item) => item.create));
  inputBoxResponses.push('Twin');
  warningResponses.push(undefined);
  quickPickResponses.push((items) => items.find((item) => item.action === 'save'));
  quickPickResponses.push((items) => items.find((item) => item.create));
  inputBoxResponses.push('Twin');
  warningResponses.push('Save a copy anyway');
  // Update the existing profile from the current login.
  quickPickResponses.push((items) => items.find((item) => item.action === 'save'));
  quickPickResponses.push((items) => items.find((item) => item.profile));
  quickPickResponses.push(undefined);
  await f.menu.show('claude', hooks);
  assert.deepEqual(f.calls, [
    ['saveNative', 'claude', { name: 'Twin', folder: undefined }],
    ['saveNative', 'claude', { name: 'Twin', folder: undefined }], ['saveNative', 'claude', { name: 'Twin', allowDuplicate: true, folder: undefined }],
    ['saveNative', 'claude', { id: 'a' }]
  ]);
  assert.deepEqual(saved, ['claude', 'claude']);
  assert.match(informationMessages[0], /login saved as “Twin”/);
  assert.match(informationMessages[1], /profile “Work” updated from the current login/);
});

test('without the service the menu offers to install it', async () => {
  const f = fixture({});
  f.services.connected = undefined;
  f.services.ensure = async () => undefined;
  f.services.isInstalled = () => false;
  let installed = false;
  f.services.install = async () => { installed = true; return true; };
  quickPickResponses.push((items) => { assert.match(items[0].label, /Install the account service/); return items[0]; });
  await f.menu.show('claude', { sendKeepAlive: async () => undefined, signIn: async () => undefined });
  assert.equal(installed, true);
});

test('where to keep a profile is asked only when both kinds are possible, and names the project', async () => {
  const view = (overrides) => ({ provider: 'claude', title: 'Claude', profiles: [], nativeUnsaved: false, checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '',
    scopes: { privateEnabled: true, projectEnabled: true, folders: [], ...overrides } });
  assert.deepEqual(await pickScope(view({})), {});
  assert.deepEqual(await pickScope(view({ privateEnabled: false, folders: ['/work/app'] })), { folder: '/work/app' });
  assert.deepEqual(await pickScope(view({ projectEnabled: false, folders: ['/work/app'] })), {});
  quickPickResponses.push((items) => {
    assert.deepEqual(items.map((item) => item.label), ['$(account) Private profile', '$(root-folder) Project profile in app', '$(root-folder) Project profile in lib']);
    return items[2];
  });
  assert.deepEqual(await pickScope(view({ folders: ['/work/app', '/work/lib'] })), { folder: '/work/lib' });
  quickPickResponses.push(undefined);
  assert.equal(await pickScope(view({ folders: ['/work/app'] })), undefined);
});
