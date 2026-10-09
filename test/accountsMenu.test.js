const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const informationMessages = [];
const warningMessages = [];
const errorMessages = [];
const warningResponses = [];
const inputBoxResponses = [];
const quickPickResponses = [];
const menus = [];
const { quickPickFactory } = require('./helpers/quickPick');
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
      showQuickPick(items, options) { const response = quickPickResponses.shift(); return typeof response === 'function' ? response(items, options) : response; },
      createQuickPick: quickPickFactory(quickPickResponses, menus)
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
    reorder: async (provider, id, step) => {
      calls.push(['reorder', provider, id, step]);
      const profiles = views[provider].profiles;
      const at = profiles.findIndex((candidate) => candidate.id === id);
      const peers = profiles.flatMap((candidate, index) => candidate.folder === profiles[at].folder ? [index] : []);
      const position = peers.indexOf(at);
      [profiles[at], profiles[peers[position + step]]] = [profiles[peers[position + step]], profiles[at]];
      return profiles;
    },
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
  const old = profile({ usage: { provider: 'claude', title: 'Claude', fetchedAt: new Date(now - 60_000).toISOString(),
    windows: [{ label: '5h', usedPercent: 95, resetsAt: new Date(now - 1000).toISOString() }] } });
  const current = { provider: 'claude', title: 'Claude', fetchedAt: new Date(now), windows: [{ label: '5h', usedPercent: 4, resetsAt: new Date(now + 5 * 3_600_000) }] };
  assert.match(usageDetail(old, current), /5h: 4%/);
  assert.doesNotMatch(usageDetail(old, current), /95%/);
  const codex = profile({ usage: { provider: 'codex', title: 'Codex', fetchedAt: new Date(now).toISOString(),
    windows: [{ label: '7d', usedPercent: 80, resetsAt: new Date(now + 24 * 3_600_000).toISOString() }],
    resetCredits: { availableCount: 1, totalCount: 2, earliestExpiresAt: Math.floor((now + 2 * 3_600_000) / 1000) } } });
  assert.match(usageDetail(codex), /Earned resets: 1 of 2 observed available \(next expires in 2h\)/);
});

test('an open account picker updates from service events and retains the focused account', async () => {
  const views = { claude: { provider: 'claude', title: 'Claude', profiles: [profile({ active: true })],
    activeProfileId: 'a', nativeUnsaved: false, checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '', scopes } };
  const f = fixture(views);
  const listeners = new Set();
  f.services.onStateChanged = listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; };
  quickPickResponses.push(async (items, options, picker) => {
    const focused = items.find(item => item.profile?.id === 'a');
    picker.activeItems = [focused];
    assert.doesNotMatch(focused.detail, /5h:/);
    views.claude = { ...views.claude, profiles: [profile({ active: true, usage: { provider: 'claude', title: 'Claude',
      fetchedAt: new Date().toISOString(), windows: [{ label: '5h', usedPercent: 42 }] } })] };
    f.services.views.claude = views.claude;
    for (const listener of listeners) listener('claude');
    assert.match(picker.items.find(item => item.profile?.id === 'a').detail, /5h: 42%/);
    assert.equal(picker.activeItems[0].profile.id, 'a');
    return undefined;
  });
  await f.menu.show('claude');
  assert.equal(listeners.size, 0, 'closing the picker releases its subscription');
});

test('usage displays round percentages while stored and live readings retain their precision', () => {
  const now = new Date();
  const saved = profile({ usage: { provider: 'claude', title: 'Claude', fetchedAt: now.toISOString(), windows: [
    { label: '5h', usedPercent: 0.0999999999999432 },
    { label: '7d', usedPercent: 59.6 }
  ] } });
  const live = { provider: 'claude', title: 'Claude', fetchedAt: new Date(now.getTime() + 1000), windows: [
    { label: '5h', usedPercent: 59.6 },
    { label: '7d', usedPercent: 0.0999999999999432 }
  ] };
  const savedBefore = structuredClone(saved);
  const liveBefore = structuredClone(live);
  assert.match(usageDetail(saved), /^5h: 0% · 7d: 60% · Checked /);
  assert.match(usageDetail(saved, live), /^5h: 60% · 7d: 0% · Checked /);
  assert.deepEqual(saved, savedBefore);
  assert.deepEqual(live, liveBefore);
});

test('profile actions live in Manage saved profiles and moving a profile updates its order', async () => {
  const views = { codex: { provider: 'codex', title: 'Codex', profiles: [profile({ active: true }), profile({ id: 'b', name: 'Backup', number: 2 })],
    activeProfileId: 'a', nativeUnsaved: false, checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '', scopes } };
  const f = fixture(views);
  quickPickResponses.push((items) => {
    assert.ok(!items.some((item) => item.action === 'rename'));
    return items.find((item) => item.action === 'manage');
  });
  quickPickResponses.push((items) => {
    assert.deepEqual(items.filter((item) => item.action).map((item) => item.action), ['importCredential', 'transfer', 'signIn', 'rename', 'reorder', 'delete']);
    return items.find((item) => item.action === 'reorder');
  });
  quickPickResponses.push((items) => items.find((item) => item.profile?.id === 'b'));
  quickPickResponses.push((items) => items.find((item) => item.step === -1));
  quickPickResponses.push((items) => { assert.match(items.at(-1).description, /Codex accounts/); return items.at(-1); });
  quickPickResponses.push((items) => { assert.equal(items.at(-1).description, 'Codex accounts'); return items.at(-1); });
  quickPickResponses.push(undefined);
  await f.menu.show('codex');
  assert.deepEqual(f.calls, [['reorder', 'codex', 'b', -1]]);
  assert.deepEqual(views.codex.profiles.map((item) => item.id), ['b', 'a']);
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
    assert.ok(!items.some((item) => item.action === 'service'), 'the one service for both is controlled from the root menu, not here');
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

test('a profile with a login problem offers renew, keep-alive or back instead of activating', async () => {
  const views = { codex: { provider: 'codex', title: 'Codex', profiles: [profile({ loginProblem: 'OAuth token has expired' })], nativeUnsaved: false, checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '', scopes } };
  const f = fixture(views);
  const sent = [], signedIn = [];
  const hooks = { sendKeepAlive: async (provider, profiles) => { sent.push([provider, profiles.map((p) => p.id)]); }, signIn: async (provider, p) => { signedIn.push([provider, p.id]); } };
  // Choosing the profile opens its menu: renew first, keep-alive second, Back last, the problem as the placeholder.
  let menu;
  quickPickResponses.push((items) => { assert.match(items[0].description, /Login problem/); return items[0]; });
  quickPickResponses.push((items, options) => { menu = { items, options }; return items.find((item) => item.choice === 'keepAlive'); });
  quickPickResponses.push(undefined); // close the accounts list that reopens after the check
  await f.menu.show('codex', hooks);
  assert.deepEqual(menu.items.filter((item) => item.kind === undefined).map((item) => item.label),
    ['$(sign-in) Renew the login…', '$(play) Try a keep-alive', '$(check) Select anyway', '$(arrow-left) Back']);
  assert.match(menu.items[0].detail, /separate home inside the keep-alive home .* “Work”/);
  assert.equal(menu.options.title, 'AI Usage · Codex account “Work” · Login problem');
  assert.match(menu.options.placeHolder, /expired/i);
  assert.deepEqual(sent, [['codex', ['a']]]);
  assert.deepEqual(signedIn, []);
  // Renew hands the profile to the sign-in hook, which signs in under the keep-alive home.
  quickPickResponses.push((items) => items[0]);
  quickPickResponses.push((items) => items.find((item) => item.choice === 'renew'));
  quickPickResponses.push(undefined);
  await f.menu.show('codex', hooks);
  assert.deepEqual(signedIn, [['codex', 'a']]);
  // Back returns to the accounts list without touching the login.
  quickPickResponses.push((items) => items[0]);
  quickPickResponses.push((items) => items.find((item) => /Back/.test(item.label)));
  quickPickResponses.push((items) => { assert.ok(items[0].profile, 'the accounts list is shown again'); return undefined; });
  await f.menu.show('codex', hooks);
  assert.deepEqual(sent, [['codex', ['a']]]);
  assert.deepEqual(signedIn, [['codex', 'a']]);
  assert.deepEqual(f.calls, []);
  // Select anyway activates the login as it is through the service and closes the menu.
  quickPickResponses.push((items) => items[0]);
  quickPickResponses.push((items) => items.find((item) => item.choice === 'select'));
  await f.menu.show('codex', hooks);
  assert.deepEqual(f.calls, [['activate', 'codex', 'a']]);
  assert.equal(quickPickResponses.length, 0);
});

test('the MCP registration item is offered while mcp.enabled is on and a hook exists, shows the CLI entry, and runs the hook', async () => {
  const views = { claude: { provider: 'claude', title: 'Claude', profiles: [profile({ active: true })], activeProfileId: 'a', nativeUnsaved: false, checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '', scopes } };
  const f = fixture(views);
  const base = { sendKeepAlive: async () => undefined, signIn: async () => undefined };
  // Off: no item, even with the hook.
  quickPickResponses.push((items) => { assert.ok(!items.some((item) => item.action === 'registerMcp')); return undefined; });
  await f.menu.show('claude', { ...base, registerMcp: async () => undefined });
  // On, but no hook: still no item.
  f.services.config.mcp.enabled = true;
  quickPickResponses.push((items) => { assert.ok(!items.some((item) => item.action === 'registerMcp')); return undefined; });
  await f.menu.show('claude', base);
  // On with the hook: the item tells the CLI's entry, choosing it runs the hook, and the list returns with the new state.
  const registered = [];
  let registration = { registered: false, current: false };
  const hooks = { ...base, mcpRegistration: () => registration,
    registerMcp: async (provider) => { registered.push(provider); registration = { registered: true, current: true, command: '/x/ai-usage', args: ['mcp'] }; } };
  quickPickResponses.push((items) => {
    const item = items.find((candidate) => candidate.action === 'registerMcp');
    assert.match(item.label, /Register the MCP server with the Claude CLI/);
    assert.equal(item.description, 'Not registered');
    assert.match(item.detail, /claude mcp add ai-usage/);
    return item;
  });
  quickPickResponses.push((items) => { assert.equal(items.find((candidate) => candidate.action === 'registerMcp').description, 'Registered'); return undefined; });
  await f.menu.show('claude', hooks);
  assert.deepEqual(registered, ['claude']);
  registration = { registered: true, current: false, command: 'node', args: ['/old.js', 'mcp'] };
  quickPickResponses.push((items) => { assert.equal(items.find((candidate) => candidate.action === 'registerMcp').description, 'Registered with another command'); return undefined; });
  await f.menu.show('claude', hooks);
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

test('Back at the end of an Accounts menu opens the previous menu over it, then closes it', async () => {
  const views = { codex: { provider: 'codex', title: 'Codex', profiles: [profile({ active: true })],
    activeProfileId: 'a', activeNumber: 1, nativeUnsaved: false, checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '', scopes } };
  const f = fixture(views);
  menus.length = 0;
  let backTo;
  let openWhileGoingBack;
  quickPickResponses.push((items) => {
    const back = items.at(-1);
    assert.equal(back.label, '$(arrow-left) Back');
    return back;
  });
  quickPickResponses.push(() => { throw new Error('the Accounts menu was shown again instead of going back'); });
  await f.menu.show('codex', { back: async (provider) => { backTo = provider; openWhileGoingBack = !menus[0].hidden && !menus[0].disposed; },
    sendKeepAlive: async () => undefined, signIn: async () => undefined });
  assert.equal(backTo, 'codex');
  // A menu that closed first would hand focus back to the chat or editor, and that focus closes the next menu.
  assert.equal(openWhileGoingBack, true, 'the Accounts menu is still open while the previous menu opens');
  assert.equal(menus[0].disposed, true);
});


test('manual selection permits a Fable-exhausted general-capable account and shows its actual limitation', async () => {
  const limited = profile({ id: 'fallback', name: 'Claude 1', limit: { readOnly: false, dimmed: true }, usage: {
    provider: 'claude', title: 'Claude', fetchedAt: new Date().toISOString(),
    windows: [{ label: '5h', usedPercent: 0 }, { label: '7d', usedPercent: 65 }, { label: '7d Fable', usedPercent: 100 }]
  } });
  const f = fixture({ claude: { provider: 'claude', title: 'Claude', profiles: [limited], scopes } });
  quickPickResponses.push(items => {
    const item = items.find(item => item.profile?.id === 'fallback');
    assert.equal(item.readOnly, false); assert.match(item.description, /Fable limit reached/);
    assert.match(item.detail, /7d Fable: 100%/); return item;
  });
  await f.menu.show('claude');
  assert.deepEqual(f.calls, [['activate', 'claude', 'fallback']]);
  assert.deepEqual(warningMessages, []);
});
