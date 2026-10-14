const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const informationMessages = [];
const warningMessages = [];
const errorMessages = [];
const warningResponses = [];
const inputBoxResponses = [];
const inputBoxOptions = [];
const quickPickResponses = [];
const menus = [];
const terminals = [];
// Dialogs and files: open/save dialog answers, the files VS Code can read, what was written and opened, and executed commands.
const openDialogResponses = [];
const saveDialogResponses = [];
const files = new Map();
const written = [];
const shownDocuments = [];
const executedCommands = [];
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
    Uri: { file: (fsPath) => ({ scheme: 'file', fsPath, toString() { return `file://${fsPath}`; } }) },
    window: {
      showInformationMessage(message) { informationMessages.push(message); },
      showWarningMessage(message) { warningMessages.push(message); return warningResponses.shift(); },
      showErrorMessage(message) { errorMessages.push(message); },
      showInputBox: async (options) => { inputBoxOptions.push(options); return inputBoxResponses.shift(); },
      showOpenDialog: async () => openDialogResponses.shift(),
      showSaveDialog: async () => saveDialogResponses.shift(),
      showTextDocument: async (uri) => { shownDocuments.push(uri); },
      showQuickPick(items, options) { const response = quickPickResponses.shift(); return typeof response === 'function' ? response(items, options) : response; },
      createQuickPick: quickPickFactory(quickPickResponses, menus),
      createTerminal(options) { const terminal = { options, shown: false, sent: [], show() { this.shown = true; }, sendText(value) { this.sent.push(value); } }; terminals.push(terminal); return terminal; }
    },
    commands: { executeCommand: async (...args) => { executedCommands.push(args); } },
    workspace: { fs: { readFile: async (uri) => { if (!files.has(uri.fsPath)) { throw new Error(`ENOENT ${uri.fsPath}`); } return Buffer.from(files.get(uri.fsPath)); }, writeFile: async (uri, bytes) => { written.push([uri.fsPath, Buffer.from(bytes).toString('utf8')]); } }, workspaceFolders: [], getConfiguration: () => ({ get: (key, fallback) => fallback, update: async () => undefined }) }
  };
  return load.call(this, id, ...args);
};
const { AccountsMenu, usageDetail, pickScope, cliTerminalCommand } = require('../out/accountsMenu');
Module._load = load;
const { defaultConfig } = require('../service/out/configStore');

const scopes = { privateEnabled: true, projectEnabled: true, folders: [] };
const profile = (overrides) => ({ id: 'a', name: 'Work', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', active: false, number: 1, problems: [],
  limit: { readOnly: false, dimmed: false }, hasCredential: true, ...overrides });

function fixture(views) {
  informationMessages.length = 0; warningMessages.length = 0; errorMessages.length = 0;
  warningResponses.length = 0; inputBoxResponses.length = 0; quickPickResponses.length = 0;
  terminals.length = 0;
  inputBoxOptions.length = 0; openDialogResponses.length = 0; saveDialogResponses.length = 0; files.clear(); written.length = 0; shownDocuments.length = 0; executedCommands.length = 0;
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
    prepareCli: async (provider, id) => {
      calls.push(['prepareCli', provider, id]);
      const home = views[provider].profiles.find(p => p.id === id).home;
      return { cli: `/custom path/${provider}`, args: provider === 'codex' ? ['-c', 'cli_auth_credentials_store="file"'] : [],
        cwd: home, env: { HOME: home, [provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: home } };
    },
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
  assert.match(usageDetail(codex), /7d: 80% \(1d\) · \$\(refresh\) 1\/2 \(2h\) · Checked /);
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

test('Codex menu shows reset counts once after usage, including zero, expired quotas, stale and unknown reports', async () => {
  const now = Date.now();
  const usage = (count, age = 0, expiredQuota = false) => ({ provider: 'codex', title: 'Codex', fetchedAt: new Date(now - age).toISOString(),
    windows: [{ label: '5h', usedPercent: 90, resetsAt: new Date(now + (expiredQuota ? -1000 : 3_600_000)).toISOString() }],
    ...(count === undefined ? {} : { resetCredits: { availableCount: count, totalCount: 4, earliestExpiresAt: Math.floor((now + 10 * 86_400_000) / 1000) } }) });
  const views = { codex: { provider: 'codex', title: 'Codex', profiles: [
    profile({ active: true, usage: usage(2) }),
    profile({ id: 'b', name: 'Login expired', loginProblem: 'Login token expired', usage: usage(1) }),
    profile({ id: 'c', name: 'Quota reset', limit: { readOnly: true, dimmed: false }, usage: usage(3, 0, true) }),
    profile({ id: 'd', name: 'Old reading', usage: usage(4, 16 * 60_000) }),
    profile({ id: 'e', name: 'Missing report', usage: usage(undefined) })
  ], activeProfileId: 'a', nativeUnsaved: false, checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '', scopes } };
  const f = fixture(views);
  quickPickResponses.push(items => {
    const rows = items.filter(item => item.profile);
    assert.deepEqual(rows.map(item => item.label), [
      '$(check) Work', 'Login expired', '$(circle-slash) Quota reset',
      '$(key) Old reading', '$(key) Missing report'
    ]);
    for (const row of rows) {
      assert.equal((row.detail.match(/\$\(refresh\)/g) ?? []).length, 1);
      assert.doesNotMatch(row.detail, /Earned resets:/);
    }
    assert.match(rows[0].detail, /\$\(refresh\) 0\/4 \(10d\) · Checked/);
    assert.match(rows[1].detail, /5h: 90% \(1h\) · \$\(refresh\) 1\/4 \(10d\) · Checked/);
    assert.match(rows[2].detail, /Usage reset; waiting for a new reading · \$\(refresh\) 3\/4 \(10d\)/);
    assert.match(rows[3].detail, /5h: 90% \(1h\) · \$\(refresh\) 4\/4 \(10d\) \(stale\) · Checked/);
    assert.match(rows[4].detail, /5h: 90% \(1h\) · \$\(refresh\) \?\/\? · Checked/);
    return undefined;
  });
  // Toolbar visibility only controls the toolbar; menu counts remain available.
  f.services.config.codex.statusBar.earnedResets = false;
  await f.menu.show('codex', { activeUsage: (provider, id) => {
    assert.equal(provider, 'codex'); assert.equal(id, 'a');
    return { ...usage(0), fetchedAt: new Date(now), windows: [] };
  } });
  assert.deepEqual(f.calls, [], 'opening the menu never probes or redeems credits');
});

test('an open Codex picker updates the reset balance and expiry from service events', async () => {
  const now = Date.now();
  const usage = count => ({ provider: 'codex', title: 'Codex', fetchedAt: new Date().toISOString(),
    windows: [{ label: '5h', usedPercent: 95 }], resetCredits: { availableCount: count, totalCount: 3, earliestExpiresAt: Math.floor((now + (count === 3 ? 12 : 10) * 86_400_000) / 1000) } });
  const view = { provider: 'codex', title: 'Codex', profiles: [profile({ active: true, usage: usage(3) })],
    activeProfileId: 'a', nativeUnsaved: false, checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '', scopes };
  const f = fixture({ codex: view });
  const listeners = new Set();
  f.services.onStateChanged = listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; };
  quickPickResponses.push((items, options, picker) => {
    const account = (list) => list.find((item) => item.profile);
    assert.doesNotMatch(account(items).label, /\$\(refresh\)/);
    assert.match(account(items).detail, /5h: 95% · \$\(refresh\) 3\/3 \(12d\) · Checked/);
    picker.activeItems = [account(items)];
    f.services.views.codex = { ...view, profiles: [profile({ active: true, usage: usage(2) })] };
    for (const listener of listeners) listener('codex');
    assert.doesNotMatch(account(picker.items).label, /\$\(refresh\)/);
    assert.match(account(picker.items).detail, /5h: 95% · \$\(refresh\) 2\/3 \(10d\) · Checked/);
    assert.equal(picker.activeItems[0].profile.id, 'a');
    return undefined;
  });
  await f.menu.show('codex');
  assert.equal(listeners.size, 0);
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

for (const provider of ['claude', 'codex']) {
  test(`${provider}: one Settings entry and Open CLI launches the selected persistent home without activation`, async () => {
    const home = `/home/user/.${provider}-profile-7`;
    const folder = provider === 'codex' ? '/workspace/project with spaces' : undefined;
    const view = { provider, title: provider, profiles: [profile({ active: true, home: `/home/user/.${provider}-profile-1` }),
      profile({ id: 'b', name: 'Backup', number: 2, home, folder, loginProblem: 'Login expired' })],
      activeProfileId: 'a', nativeUnsaved: false, checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '', scopes };
    const f = fixture({ [provider]: view });
    quickPickResponses.push(items => {
      const settings = items.filter(item => item.action === 'settings' || item.action === 'serviceSettings');
      assert.equal(settings.length, 1);
      assert.equal(settings[0].label, '$(gear) Settings…');
      return items.find(item => item.action === 'openCli');
    });
    quickPickResponses.push((items, options) => {
      assert.match(options.title, /Open .* CLI/);
      assert.deepEqual(items.filter(item => item.profile).map(item => item.profile.id), ['a', 'b']);
      assert.equal(items.find(item => item.profile?.id === 'b').detail, home);
      return items.find(item => item.profile?.id === 'b');
    });
    await f.menu.show(provider);
    assert.deepEqual(f.calls, [['prepareCli', provider, 'b']]);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].shown, true);
    assert.deepEqual(terminals[0].options, {
      name: `${provider === 'claude' ? 'Claude' : 'Codex'} · Backup`,
      ...(process.platform === 'win32' ? { shellPath: 'powershell.exe', shellArgs: ['-NoLogo', '-NoExit'] } : {}),
      cwd: folder ?? home, env: { HOME: home, [provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: home }, strictEnv: true
    });
    assert.deepEqual(terminals[0].sent, [cliTerminalCommand(`/custom path/${provider}`,
      provider === 'codex' ? ['-c', 'cli_auth_credentials_store="file"'] : [])]);
  });
}

test('Open CLI quotes executable and arguments before sending them to the persistent shell', () => {
  const command = cliTerminalCommand("/tmp/a b/cli'$(touch marker)", ['-c', 'value="file"; echo broken']);
  if (process.platform === 'win32') {
    assert.equal(command, "& '/tmp/a b/cli''$(touch marker)' '-c' 'value=\"file\"; echo broken'");
  } else {
    assert.equal(command, "'/tmp/a b/cli'\\''$(touch marker)' '-c' 'value=\"file\"; echo broken'");
  }
});

test('Open CLI cancellation returns to the account menu without preparing or launching a CLI', async () => {
  const view = { provider: 'claude', title: 'Claude', profiles: [profile()], nativeUnsaved: false,
    checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '', scopes };
  const f = fixture({ claude: view });
  quickPickResponses.push(items => items.find(item => item.action === 'openCli'), undefined, undefined);
  await f.menu.show('claude');
  assert.deepEqual(f.calls, []);
  assert.equal(terminals.length, 0);
});

test('choosing a profile activates it through the service and closes the menu; an exhausted one only warns', async () => {
  const views = { claude: { provider: 'claude', title: 'Claude', profiles: [profile({ active: true }), profile({ id: 'b', name: 'Full', number: 2, limit: { readOnly: true, dimmed: false } })],
    activeProfileId: 'a', activeNumber: 1, nativeUnsaved: false, checkingActive: false, keepAlive: true, autoRotate: false, strategySummary: '', scopes } };
  const f = fixture(views);
  quickPickResponses.push((items) => {
    // The active account is marked by a separator, whose label VS Code shows right-aligned on its row, and an
    // unlabelled one keeps the next account out of that group.
    assert.deepEqual(items.slice(0, 2).map((item) => [item.label, item.kind]), [['Active', -1], ['$(check) Work', undefined]]);
    assert.equal(items[1].description, undefined, 'the description no longer repeats it');
    assert.deepEqual([items[2].label, items[2].kind], ['', -1]);
    assert.equal(items[3].label, '$(circle-slash) Full');
    assert.match(items[3].description, /At its usage limit/);
    assert.ok(items.some((item) => item.action === 'save'), 'manage actions are listed');
    assert.ok(!items.some((item) => item.action === 'service'), 'the one service for both is controlled from the root menu, not here');
    assert.match(items.find((item) => item.action === 'settings').description, /Keep-alive on · rotation off/);
    return items[3];
  });
  quickPickResponses.push((items) => items.find((item) => item.profile?.id === 'a'));
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

test('background installation is an optional action when the account connection is unavailable', async () => {
  const f = fixture({});
  f.services.connected = undefined;
  f.services.ensure = async () => undefined;
  f.services.isInstalled = () => false;
  f.services.background = true;
  let installed = false;
  f.services.install = async () => { installed = true; return true; };
  quickPickResponses.push((items) => {
    assert.equal(items[0].action, 'retry');
    const install = items.find(item => item.action === 'install');
    assert.match(install.detail, /Optional/);
    return install;
  });
  await f.menu.show('claude', { sendKeepAlive: async () => undefined, signIn: async () => undefined });
  assert.equal(installed, true);
});

for (const enabled of [false, true]) test(`standalone account recovery works without installation (service enabled=${enabled})`, async () => {
  const view = { provider: 'codex', title: 'Codex', profiles: [], nativeUnsaved: false, checkingActive: false,
    keepAlive: false, autoRotate: false, strategySummary: '', scopes };
  const f = fixture({ codex: view });
  const client = f.services.connected;
  f.services.connected = undefined;
  f.services.enabled = enabled;
  f.services.background = false;
  f.services.isInstalled = () => false;
  f.services.install = async () => assert.fail('standalone recovery must not install a daemon');
  let attempts = 0;
  f.services.ensure = async () => {
    if (++attempts === 1) return undefined;
    f.services.connected = client;
    return client;
  };
  quickPickResponses.push(items => {
    assert.equal(items.some(item => item.action === 'install'), false);
    assert.doesNotMatch(JSON.stringify(items), /Accounts are turned off|Turn aiUsage.accountService.enabled on/);
    return items.find(item => item.action === 'retry');
  }, items => {
    assert.ok(items.some(item => item.action === 'save'), 'the connected account menu is available');
    return undefined;
  });
  await f.menu.show('codex');
  assert.equal(attempts, 2);
});

test('a failed account retry opens runtime status without installing or enabling the service', async () => {
  const f = fixture({});
  f.services.connected = undefined;
  f.services.enabled = false;
  f.services.ensure = async () => undefined;
  f.services.install = async () => assert.fail('a failed retry must not install a daemon');
  quickPickResponses.push(items => items.find(item => item.action === 'retry'));
  await f.menu.show('claude');
  assert.deepEqual(f.calls, [['showMenu']]);
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

// ---- Flows beyond activation: provider choice, errors, keep-alive, save, import, export, manage, events. ----

const baseView = (provider, profiles, overrides = {}) => ({ provider, title: provider, profiles, activeProfileId: profiles.find((p) => p.active)?.id, nativeUnsaved: false,
  checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '', scopes, ...overrides });
const hooksOf = (over = {}) => ({ sendKeepAlive: async () => undefined, signIn: async () => undefined, ...over });
const pickAction = (action) => (items) => items.find((item) => item.action === action);

test('without a provider the menu asks which service, shows the saved counts, and Escape ends it', async () => {
  const f = fixture({ claude: baseView('claude', [profile({ active: true }), profile({ id: 'b', name: 'B', number: 2 })]), codex: baseView('codex', []) });
  f.services.views = { claude: baseView('claude', [profile(), profile({ id: 'b' })]) };
  quickPickResponses.push((items, options) => {
    assert.equal(options.title, 'AI Usage · Authentication profiles');
    assert.deepEqual(items.map((item) => [item.label, item.description]), [['$(claude) Claude', '2/20 profiles'], ['$(openai) Codex', undefined]]);
    return items[1];
  });
  quickPickResponses.push((items, options) => { assert.equal(options.title, 'AI Usage · Codex accounts'); return undefined; });
  menus.length = 0;
  await f.menu.show();
  assert.equal(menus.at(-1).title, 'AI Usage · Codex accounts', 'the choice opens that service\'s menu');
  quickPickResponses.push(undefined);
  await f.menu.show();
  assert.equal(quickPickResponses.length, 0);
  assert.deepEqual(f.calls, []);
});

test('the menu connects first, and reports an unreadable account list instead of showing a menu', async () => {
  const f = fixture({ claude: baseView('claude', [profile()]) });
  const client = f.services.connected;
  f.services.connected = undefined;
  let ensured;
  f.services.ensure = async (options) => { ensured = options; return client; };
  quickPickResponses.push(undefined);
  await f.menu.show('claude');
  assert.deepEqual(ensured, { promptInstall: true }, 'a first connection may offer the background installation');
  client.list = async () => { throw new Error('the service went away'); };
  f.services.connected = client;
  await f.menu.show('claude');
  assert.deepEqual(errorMessages, ['AI Usage: could not read the Claude accounts: the service went away']);
  assert.equal(quickPickResponses.length, 0);
});

test('a failing action is reported and logged, and the list stays open for another choice', async () => {
  const f = fixture({ claude: baseView('claude', [profile({ active: true }), profile({ id: 'b', name: 'Other', number: 2 })]) });
  const logs = [];
  f.menu = new AccountsMenu(f.services, (message) => logs.push(message));
  f.services.connected.activate = async () => { throw new Error('credential file is locked'); };
  quickPickResponses.push((items) => items.find((item) => item.profile?.id === 'b'), undefined);
  await f.menu.show('claude');
  assert.deepEqual(errorMessages, ['AI Usage: authentication profile operation failed: credential file is locked']);
  assert.deepEqual(logs, ['claude: authentication profile operation failed: credential file is locked']);
  assert.equal(quickPickResponses.length, 0);
  // A thrown non-Error is reported by its text too.
  f.services.connected.activate = async () => { throw 'plain text failure'; };
  quickPickResponses.push((items) => items.find((item) => item.profile?.id === 'b'), undefined);
  await f.menu.show('claude');
  assert.equal(errorMessages.at(-1), 'AI Usage: authentication profile operation failed: plain text failure');
});

test('rows describe duplicates, projects, limits and what has not been read yet', async () => {
  const folder = '/work/my app';
  const view = baseView('claude', [
    profile({ active: true, email: 'a@example.com' }),
    profile({ id: 'b', name: 'Twin', number: 2, email: 'a@example.com', folder }),
    profile({ id: 'c', name: 'Fable', number: 3, limit: { readOnly: false, dimmed: true } }),
    profile({ id: 'd', name: 'Checked', number: 4, checkedAt: '2026-03-04T05:06:07Z' }),
    profile({ id: 'e', name: 'Broken', number: 5, loginProblem: 'OAuth token has expired' }),
    profile({ id: 'f', name: 'Full', number: 6, limit: { readOnly: true, dimmed: false }, loginProblem: 'OAuth token has expired' })
  ]);
  const f = fixture({ claude: view });
  quickPickResponses.push((items) => {
    const row = (id) => items.find((item) => item.profile?.id === id);
    assert.equal(row('a').description, 'a@example.com · duplicate of “Twin”');
    // Rows cannot have a hover: an info button carries the account's reading as text, problems included.
    assert.equal(row('a').buttons[0].iconPath.id, 'info');
    assert.match(row('a').buttons[0].tooltip, /Usage not checked yet\.\n\nThis is the active account\.$/);
    assert.match(row('e').info, /Login problem: OAuth token has expired/);
    assert.match(row('f').info, /At its usage limit/);
    assert.equal(row('b').description, 'a@example.com · project my app · duplicate of “Work”');
    assert.equal(row('c').label, 'Fable', 'a dimmed account loses its icon');
    assert.equal(row('c').iconPath.id, 'key');
    assert.equal(row('c').description, 'Fable limit reached');
    assert.match(row('d').detail, /^Last checked .* · waiting for the service to refresh usage after reset$/);
    assert.match(row('a').detail, /^Saved .* · Usage not checked yet$/);
    assert.equal(row('e').iconPath.id, 'warning');
    assert.equal(row('e').iconPath.color.id, 'editorWarning.foreground');
    assert.equal(row('e').description, 'Login problem');
    assert.equal(row('f').label, '$(circle-slash) Full');
    assert.equal(row('f').description, 'At its usage limit', 'an exhausted account hides its login trouble');
    assert.equal(row('f').loginProblem, undefined);
    assert.equal(row('f').readOnly, true);
    return undefined;
  });
  await f.menu.show('claude');
  // An empty list says so and still offers saving; the items shown depend on what exists.
  const empty = fixture({ codex: baseView('codex', []) });
  quickPickResponses.push((items) => {
    assert.equal(items[0].label, 'No profiles saved yet');
    assert.deepEqual(items.filter((item) => item.action).map((item) => item.action), ['save', 'manage', 'settings']);
    assert.match(items.find((item) => item.action === 'settings').description, /^Keep-alive off · rotation off · earned resets (on|off)$/);
    assert.ok(!items.some((item) => item.action === 'back'), 'no Back item without a hook');
    return undefined;
  });
  await empty.menu.show('codex');
});

test('Settings opens the service-specific settings and closes the menu', async () => {
  const f = fixture({ codex: baseView('codex', [profile()]) });
  quickPickResponses.push(pickAction('settings'));
  await f.menu.show('codex');
  assert.deepEqual(executedCommands, [['workbench.action.openSettings2', { query: '@ext:p0l0us.ai-usage-vscode-plugin @id:aiUsage.codex*' }]]);
  assert.equal(quickPickResponses.length, 0, 'the menu did not reopen');
});

test('keep-alive now: one account, all of them, Back and Escape', async () => {
  const f = fixture({ claude: baseView('claude', [profile({ active: true }), profile({ id: 'b', name: 'Other', number: 2 })]) });
  const sent = [];
  const hooks = hooksOf({ sendKeepAlive: async (provider, profiles) => { sent.push([provider, profiles.map((p) => p.id)]); } });
  quickPickResponses.push(pickAction('keepAliveNow'), (items, options) => {
    assert.equal(options.title, 'Send a Claude keep-alive now');
    assert.deepEqual(items.filter((item) => item.kind !== -1).map((item) => item.label), ['$(run-all) All accounts', 'Work', 'Other', '$(arrow-left) Back']);
    assert.equal(items[0].description, '2 saved accounts, one by one');
    return items[0];
  }, undefined);
  await f.menu.show('claude', hooks);
  assert.deepEqual(sent, [['claude', ['a', 'b']]]);
  quickPickResponses.push(pickAction('keepAliveNow'), (items) => items.find((item) => item.label === 'Other'), undefined);
  await f.menu.show('claude', hooks);
  assert.deepEqual(sent.at(-1), ['claude', ['b']]);
  // Back (no profiles on its row) and Escape send nothing and return to the list.
  quickPickResponses.push(pickAction('keepAliveNow'), (items) => items.at(-1), pickAction('keepAliveNow'), undefined, undefined);
  await f.menu.show('claude', hooks);
  assert.equal(sent.length, 2);
  assert.equal(quickPickResponses.length, 0);
  // A single saved account has no "All accounts" row.
  const single = fixture({ claude: baseView('claude', [profile()]) });
  quickPickResponses.push(pickAction('keepAliveNow'), (items) => { assert.ok(!items.some((item) => /All accounts/.test(item.label))); return undefined; }, undefined);
  await single.menu.show('claude', hooks);
  // Without a hook nothing breaks either.
  quickPickResponses.push(pickAction('keepAliveNow'), (items) => items.find((item) => item.label === 'Work'), undefined);
  await single.menu.show('claude');
});

test('Open CLI: Back reopens the account menu, a failing preparation is reported, and the project folder is the terminal cwd', async () => {
  const view = baseView('claude', [profile({ active: true, home: '/h/1' }), profile({ id: 'b', name: 'B', number: 2, home: '/h/2' })]);
  const f = fixture({ claude: view });
  menus.length = 0;
  quickPickResponses.push(pickAction('openCli'), (items) => items.find((item) => item.action === 'back'), (items) => { assert.ok(items[0].profile, 'the account menu replaced the CLI menu'); return undefined; });
  await f.menu.show('claude');
  assert.equal(terminals.length, 0);
  assert.equal(menus[1].title, 'AI Usage · Open Claude CLI');
  // The CLI could not be prepared: the error goes to the notification and the account list stays.
  f.services.connected.prepareCli = async () => { throw new Error('no home available'); };
  quickPickResponses.push(pickAction('openCli'), (items) => items.find((item) => item.profile?.id === 'b'), undefined);
  await f.menu.show('claude');
  assert.equal(errorMessages.at(-1), 'AI Usage: authentication profile operation failed: no home available');
  assert.equal(terminals.length, 0);
});

test('saving: a full list can only update, cancelling at each prompt saves nothing, a project can be chosen', async () => {
  const many = Array.from({ length: 20 }, (_, index) => profile({ id: `p${index}`, name: `P${index}`, number: index + 1, active: index === 0 }));
  const f = fixture({ claude: baseView('claude', many) });
  const afterSaved = [];
  const hooks = hooksOf({ afterSaved: async (provider) => { afterSaved.push(provider); } });
  quickPickResponses.push(pickAction('save'), (items, options) => {
    assert.ok(!items.some((item) => item.create), 'no "create" row at the maximum');
    assert.equal(options.placeHolder, 'Choose a profile to update (20/20)');
    return undefined;
  }, undefined);
  await f.menu.show('claude', hooks);
  assert.deepEqual(f.calls, []);
  // Updating a duplicate answer is not a success: afterSaved is not called.
  f.services.connected.saveNative = async () => ({ status: 'duplicate', warning: 'w' });
  quickPickResponses.push(pickAction('save'), (items) => items.find((item) => item.profile?.id === 'p3'), undefined);
  await f.menu.show('claude', hooks);
  assert.deepEqual(afterSaved, []);
  assert.deepEqual(informationMessages, []);
  // With a free slot: Escape at the type, the name, and the scope.
  const g = fixture({ claude: baseView('claude', [profile({ active: true })], { scopes: { privateEnabled: true, projectEnabled: true, folders: ['/work/app'] } }) });
  quickPickResponses.push(pickAction('save'), undefined, undefined);
  await g.menu.show('claude', hooks);
  quickPickResponses.push(pickAction('save'), (items) => items.find((item) => item.create), undefined);
  inputBoxResponses.push(undefined);
  await g.menu.show('claude', hooks);
  quickPickResponses.push(pickAction('save'), (items) => items.find((item) => item.create), undefined, undefined);
  inputBoxResponses.push('  New one  ');
  await g.menu.show('claude', hooks);
  assert.deepEqual(g.calls, [], 'nothing was saved after any cancel');
  // Choosing the project saves into its file and says so.
  quickPickResponses.push(pickAction('save'), (items) => items.find((item) => item.create), (items) => items.find((item) => item.folder), undefined);
  inputBoxResponses.push('  New one  ');
  await g.menu.show('claude', hooks);
  assert.deepEqual(g.calls, [['saveNative', 'claude', { name: 'New one', folder: '/work/app' }]]);
  assert.equal(informationMessages.at(-1), 'Claude login saved as “New one” in project app.');
  assert.deepEqual(afterSaved, ['claude']);
});

test('the profile name prompt validates length, emptiness and duplicates', async () => {
  const f = fixture({ claude: baseView('claude', [profile({ active: true })]) });
  quickPickResponses.push(pickAction('save'), (items) => items.find((item) => item.create), undefined);
  await f.menu.show('claude');
  const validate = inputBoxOptions.at(-1).validateInput;
  assert.equal(inputBoxOptions.at(-1).title, 'Claude authentication profile');
  assert.equal(inputBoxOptions.at(-1).prompt, 'Name the login that is currently active.');
  assert.equal(validate('   '), 'Enter a profile name.');
  assert.equal(validate('x'.repeat(61)), 'Use 60 characters or fewer.');
  assert.equal(validate(' work '), 'That profile name already exists.');
  assert.equal(validate('Fresh'), undefined);
});

const claudeCredential = (token) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: 9999999999999 } });
const manage = (items) => items.find((item) => item.action === 'manage');
const file = (fsPath) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` });

test('Import credential JSON: reads the file, asks a name, imports without activating, and every cancel stops quietly', async () => {
  const view = baseView('claude', [profile({ active: true })], { scopes: { privateEnabled: true, projectEnabled: true, folders: ['/work/app'] } });
  const f = fixture({ claude: view });
  const imports = [];
  f.services.connected.importCredential = async (...args) => { imports.push(args); return { status: 'saved', profile: { id: 'n', name: args[1] } }; };
  const toImport = (items) => items.find((item) => item.action === 'importCredential');
  files.set('/in/b.json', claudeCredential('b'));
  // Dialog cancelled.
  quickPickResponses.push(pickAction('manage'), toImport, undefined, undefined);
  await f.menu.show('claude');
  assert.deepEqual(imports, []);
  // Name cancelled, then scope cancelled.
  openDialogResponses.push([file('/in/b.json')]);
  inputBoxResponses.push(undefined);
  quickPickResponses.push(pickAction('manage'), toImport, undefined, undefined);
  await f.menu.show('claude');
  openDialogResponses.push([file('/in/b.json')]);
  inputBoxResponses.push('Imported');
  quickPickResponses.push(pickAction('manage'), toImport, undefined, undefined, undefined);
  await f.menu.show('claude');
  assert.deepEqual(imports, []);
  // Into the project folder.
  openDialogResponses.push([file('/in/b.json')]);
  inputBoxResponses.push('Imported');
  quickPickResponses.push(pickAction('manage'), toImport, (items) => items.find((item) => item.folder), undefined, undefined);
  await f.menu.show('claude');
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0].slice(0, 2), ['claude', 'Imported']);
  assert.equal(imports[0][2].claudeAiOauth.accessToken, 'b');
  assert.deepEqual(imports[0].slice(3), [false, '/work/app']);
  assert.equal(informationMessages.at(-1), 'Claude credential imported as “Imported” in project app. Choose it from the profile menu to activate it.');
  assert.deepEqual(f.calls, [], 'importing never activates');
  // A broken or missing file is an error notification, not an exception.
  files.set('/in/bad.json', '{nope');
  for (const name of ['/in/bad.json', '/in/missing.json']) {
    openDialogResponses.push([file(name)]);
    quickPickResponses.push(pickAction('manage'), toImport, undefined, undefined);
    await f.menu.show('claude');
    assert.match(errorMessages.at(-1), /^AI Usage: could not import the credential: /);
  }
  assert.equal(imports.length, 1);
});

test('Import credential JSON: the duplicate warning, the limit of 20 profiles and the private default', async () => {
  const f = fixture({ claude: baseView('claude', [profile({ active: true })]) });
  const imports = [];
  f.services.connected.importCredential = async (provider, name, credential, allowDuplicate, folder) => {
    imports.push([name, allowDuplicate, folder]);
    return allowDuplicate ? { status: 'saved', profile: { id: 'n', name } } : { status: 'duplicate', warning: 'already saved as “Work”' };
  };
  files.set('/in/b.json', claudeCredential('b'));
  const run = async () => {
    openDialogResponses.push([file('/in/b.json')]);
    inputBoxResponses.push('Copy');
    quickPickResponses.push(pickAction('manage'), (items) => items.find((item) => item.action === 'importCredential'), undefined);
    await f.menu.show('claude');
  };
  warningResponses.push(undefined);
  await run();
  assert.deepEqual(imports, [['Copy', false, undefined]]);
  assert.deepEqual(informationMessages, []);
  assert.equal(warningMessages.at(-1), 'already saved as “Work”');
  warningResponses.push('Save a copy anyway');
  await run();
  assert.deepEqual(imports.slice(1), [['Copy', false, undefined], ['Copy', true, undefined]]);
  assert.equal(informationMessages.at(-1), 'Claude credential imported as “Copy”. Choose it from the profile menu to activate it.');
  // At the maximum the file is not even asked for.
  const many = fixture({ claude: baseView('claude', Array.from({ length: 20 }, (_, index) => profile({ id: `p${index}`, name: `P${index}`, number: index + 1 }))) });
  quickPickResponses.push(pickAction('manage'), (items) => items.find((item) => item.action === 'importCredential'), undefined);
  openDialogResponses.push([file('/in/b.json')]);
  await many.menu.show('claude');
  assert.equal(warningMessages.at(-1), 'Claude already has the maximum of 20 saved profiles.');
  assert.equal(openDialogResponses.length, 1, 'the dialog was never opened');
});

test('manage menu lists what fits the state and Back or Escape returns to the account list', async () => {
  const none = fixture({ claude: baseView('claude', []) });
  quickPickResponses.push(pickAction('manage'), (items, options) => {
    assert.equal(options.title, 'AI Usage · Manage saved Claude profiles');
    assert.deepEqual(items.filter((item) => item.action).map((item) => item.action), ['importCredential', 'transfer']);
    return items.at(-1);
  }, undefined);
  await none.menu.show('claude');
  const one = fixture({ claude: baseView('claude', [profile()]) });
  quickPickResponses.push(pickAction('manage'), (items) => {
    assert.deepEqual(items.filter((item) => item.action).map((item) => item.action), ['importCredential', 'transfer', 'signIn', 'rename', 'delete'], 'no reorder with one profile');
    return undefined;
  }, undefined);
  await one.menu.show('claude');
  assert.equal(quickPickResponses.length, 0);
});

test('rename: validated name, unchanged name and cancels do nothing; a service error is reported', async () => {
  const f = fixture({ claude: baseView('claude', [profile({ active: true }), profile({ id: 'b', name: 'Backup', number: 2 })]) });
  const rename = (items) => items.find((item) => item.action === 'rename');
  const pick = (id) => (items) => items.find((item) => item.profile?.id === id);
  quickPickResponses.push(pickAction('manage'), rename, pick('b'), undefined, undefined);
  inputBoxResponses.push('Renamed');
  await f.menu.show('claude');
  assert.deepEqual(f.calls, [['rename', 'claude', 'b', 'Renamed']]);
  assert.equal(inputBoxOptions.at(-1).value, 'Backup');
  assert.equal(inputBoxOptions.at(-1).validateInput('work'), 'That profile name already exists.');
  assert.equal(inputBoxOptions.at(-1).validateInput('backup'), undefined, 'its own name is allowed');
  f.calls.length = 0;
  quickPickResponses.push(pickAction('manage'), rename, pick('b'), undefined, undefined);
  inputBoxResponses.push('Backup');
  await f.menu.show('claude');
  quickPickResponses.push(pickAction('manage'), rename, pick('b'), undefined, undefined);
  inputBoxResponses.push(undefined);
  await f.menu.show('claude');
  quickPickResponses.push(pickAction('manage'), rename, undefined, undefined, undefined);
  await f.menu.show('claude');
  quickPickResponses.push(pickAction('manage'), rename, (items) => items.at(-1), undefined, undefined);
  await f.menu.show('claude');
  assert.deepEqual(f.calls, []);
  f.services.connected.rename = async () => { throw new Error('name taken in another window'); };
  quickPickResponses.push(pickAction('manage'), rename, pick('b'), undefined, undefined);
  inputBoxResponses.push('Other');
  await f.menu.show('claude');
  assert.equal(errorMessages.at(-1), 'AI Usage: authentication profile operation failed: name taken in another window');
});

test('delete: a modal confirmation (with the active-profile warning), cancel and Back delete nothing', async () => {
  const f = fixture({ claude: baseView('claude', [profile({ active: true }), profile({ id: 'b', name: 'Backup', number: 2 })]) });
  const del = (items) => items.find((item) => item.action === 'delete');
  const pick = (id) => (items) => items.find((item) => item.profile?.id === id);
  warningResponses.push('Delete');
  quickPickResponses.push(pickAction('manage'), del, pick('b'), undefined, undefined);
  await f.menu.show('claude');
  assert.deepEqual(f.calls, [['delete', 'claude', 'b']]);
  assert.equal(warningMessages.at(-1), 'Delete the saved profile “Backup”?');
  f.calls.length = 0;
  warningResponses.push('Delete');
  quickPickResponses.push(pickAction('manage'), del, pick('a'), undefined, undefined);
  await f.menu.show('claude');
  assert.equal(warningMessages.at(-1), 'Delete the saved profile “Work”? The native login remains active until you switch or sign out.');
  assert.deepEqual(f.calls, [['delete', 'claude', 'a']]);
  f.calls.length = 0;
  warningResponses.push(undefined);
  quickPickResponses.push(pickAction('manage'), del, pick('b'), undefined, undefined);
  await f.menu.show('claude');
  quickPickResponses.push(pickAction('manage'), del, (items) => items.at(-1), undefined, undefined);
  await f.menu.show('claude');
  assert.deepEqual(f.calls, []);
});

test('Sign in again hands the chosen profile to the hook; without a choice nothing starts', async () => {
  const f = fixture({ codex: baseView('codex', [profile({ active: true }), profile({ id: 'b', name: 'Backup', number: 2, loginProblem: 'OAuth token has expired' })]) });
  const signedIn = [];
  const hooks = hooksOf({ signIn: async (provider, p) => { signedIn.push([provider, p.id]); } });
  quickPickResponses.push(pickAction('manage'), pickAction('signIn'), (items, options) => {
    assert.equal(options.title, 'Sign in again for a Codex profile');
    assert.equal(items.find((item) => item.profile?.id === 'b').description, 'Login problem');
    return items.find((item) => item.profile?.id === 'b');
  }, undefined, undefined);
  await f.menu.show('codex', hooks);
  assert.deepEqual(signedIn, [['codex', 'b']]);
  quickPickResponses.push(pickAction('manage'), pickAction('signIn'), undefined, undefined, undefined);
  await f.menu.show('codex', hooks);
  assert.equal(signedIn.length, 1);
});

test('reordering moves step by step until Done, and stops when the profile is gone', async () => {
  const f = fixture({ claude: baseView('claude', [profile({ id: 'a', name: 'A', active: true }), profile({ id: 'b', name: 'B', number: 2 }), profile({ id: 'c', name: 'C', number: 3 })]) });
  const steps = [];
  quickPickResponses.push(pickAction('manage'), pickAction('reorder'), (items) => items.find((item) => item.profile?.id === 'b'),
    (items, options) => { steps.push(options.placeHolder); assert.deepEqual(items.filter((item) => item.step).map((item) => item.description), ['above “A”', 'below “C”']); return items.find((item) => item.step === 1); },
    (items, options) => { steps.push(options.placeHolder); assert.deepEqual(items.filter((item) => item.step).map((item) => item.step), [-1], 'at the end only up is offered'); return items.find((item) => item.label === '$(check) Done'); },
    undefined, undefined);
  await f.menu.show('claude');
  assert.deepEqual(f.calls, [['reorder', 'claude', 'b', 1]]);
  assert.deepEqual(steps, ['Position 2 of 3: A, B, C', 'Position 3 of 3: A, C, B']);
  // The profile disappears (deleted in another window) while the dialog is open: it ends without a prompt.
  f.calls.length = 0;
  const view = f.services.connected.list;
  let listed = 0;
  f.services.connected.list = async (provider) => { const result = await view(provider); return ++listed >= 4 ? { ...result, profiles: result.profiles.filter((p) => p.id !== 'c') } : result; };
  quickPickResponses.push(pickAction('manage'), pickAction('reorder'), (items) => items.find((item) => item.profile?.id === 'c'), undefined, undefined);
  await f.menu.show('claude');
  assert.deepEqual(f.calls, []);
  assert.equal(quickPickResponses.length, 0);
});

test('export: choose profiles, a file, write it with owner-only access and open it with the warning', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-export-'));
  const target = path.join(dir, 'out.json');
  fs.writeFileSync(target, '');
  try {
    const f = fixture({ claude: baseView('claude', [profile({ active: true, email: 'a@example.com' }), profile({ id: 'b', name: 'Nologin', number: 2, hasCredential: false })]), codex: baseView('codex', [profile({ id: 'c', name: 'Cx', number: 1 })]) });
    const exportCalls = [];
    f.services.connected.exportProfiles = async (selection) => { exportCalls.push(selection); return { text: '{"profiles":[]}', entries: selection, missing: ['Claude Nologin'] }; };
    f.services.views = { claude: view('claude'), codex: view('codex') };
    function view(provider) { return baseView(provider, [profile()]); }
    saveDialogResponses.push(file(target));
    quickPickResponses.push((items, options) => {
      assert.equal(options.canPickMany, true);
      assert.deepEqual(items.map((item) => [item.label, item.picked]), [['Claude', undefined], ['Work', true], ['Nologin', false], ['Codex', undefined], ['Cx', true]]);
      return items.filter((item) => item.entry && item.picked);
    });
    assert.equal(await f.menu.exportProfiles(), true);
    assert.deepEqual(exportCalls, [[{ provider: 'claude', id: 'a' }, { provider: 'codex', id: 'c' }]]);
    assert.deepEqual(written, [[target, '{"profiles":[]}']]);
    if (process.platform !== 'win32') { assert.equal(fs.statSync(target).mode & 0o777, 0o600); }
    assert.deepEqual(shownDocuments.map((uri) => uri.fsPath), [target]);
    assert.equal(warningMessages.at(-1), `AI Usage: exported 2 profiles to ${target}. The file holds their login tokens in plain text: import it on the other computer, then delete it. Skipped, no login saved: Claude Nologin.`);
    // Cancelling the selection, the file dialog, or an export with no logins writes nothing.
    written.length = 0;
    quickPickResponses.push(undefined);
    assert.equal(await f.menu.exportProfiles(), false);
    quickPickResponses.push((items) => []);
    assert.equal(await f.menu.exportProfiles(), false);
    quickPickResponses.push((items) => items.filter((item) => item.entry));
    saveDialogResponses.push(undefined);
    assert.equal(await f.menu.exportProfiles(), false);
    f.services.connected.exportProfiles = async () => ({ text: '', entries: [], missing: ['Claude Work'] });
    quickPickResponses.push((items) => items.filter((item) => item.entry));
    saveDialogResponses.push(file(target));
    assert.equal(await f.menu.exportProfiles(), false);
    assert.equal(informationMessages.at(-1), 'AI Usage: no login is saved for Claude Work, so there is nothing to export.');
    assert.deepEqual(written, []);
    // Nothing saved at all.
    f.services.connected.list = async (provider) => baseView(provider, []);
    assert.equal(await f.menu.exportProfiles(), false);
    assert.equal(informationMessages.at(-1), 'AI Usage: no Claude or Codex profiles are saved yet, so there is nothing to export.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import of an export: plans are listed per service, applied only for the chosen ones, failures are reported', async () => {
  const f = fixture({ claude: baseView('claude', [profile()]) });
  const plans = [
    { provider: 'claude', id: 'x1', name: 'New one', email: 'n@example.com', outcome: 'Will be added', kind: 'new', suggested: true },
    { provider: 'codex', id: 'x2', name: 'Same', outcome: 'Already saved', kind: 'same', suggested: false }
  ];
  const applied = [];
  const client = f.services.connected;
  client.planImport = async (text) => { assert.equal(text, '{"export":1}'); return plans; };
  client.applyImport = async (text, chosen) => { applied.push(chosen); return { imported: chosen.length, summary: '1 added' }; };
  files.set('/in/export.json', '{"export":1}');
  openDialogResponses.push([file('/in/export.json')]);
  quickPickResponses.push((items, options) => {
    assert.equal(options.canPickMany, true);
    assert.deepEqual(items.map((item) => [item.label, item.description, item.picked]), [
      ['Claude', undefined, undefined], ['New one', 'n@example.com · Will be added', true], ['Codex', undefined, undefined], ['Same', 'Already saved', false]]);
    return items.filter((item) => item.plan?.suggested);
  });
  assert.equal(await f.menu.importProfiles(), true);
  assert.deepEqual(applied, [[{ provider: 'claude', id: 'x1' }]]);
  assert.equal(informationMessages.at(-1), 'AI Usage: imported 1 profile: 1 added. Nothing was activated; choose a profile from its Accounts menu to use it.');
  // Nothing chosen, dialog cancelled, unreadable file, empty export, and a rejected apply.
  openDialogResponses.push([file('/in/export.json')]);
  quickPickResponses.push(undefined);
  assert.equal(await f.menu.importProfiles(), false);
  assert.equal(await f.menu.importProfiles(), false, 'the dialog was cancelled');
  openDialogResponses.push([file('/in/gone.json')]);
  assert.equal(await f.menu.importProfiles(), false);
  assert.match(errorMessages.at(-1), /^AI Usage: could not import the profiles: ENOENT/);
  client.planImport = async () => [];
  openDialogResponses.push([file('/in/export.json')]);
  assert.equal(await f.menu.importProfiles(), false);
  assert.equal(informationMessages.at(-1), 'AI Usage: the export holds no profiles.');
  client.planImport = async () => plans;
  client.applyImport = async () => { throw new Error('The service changed.'); };
  openDialogResponses.push([file('/in/export.json')]);
  quickPickResponses.push((items) => items.filter((item) => item.plan));
  assert.equal(await f.menu.importProfiles(), false);
  assert.equal(warningMessages.at(-1), 'AI Usage: The service changed. Deselect some and import again.');
  assert.equal(applied.length, 1);
});

test('the export and import entry lives in Manage: Export only appears once something is saved, Back returns', async () => {
  const f = fixture({ claude: baseView('claude', []) });
  quickPickResponses.push(pickAction('manage'), pickAction('transfer'), (items, options) => {
    assert.equal(options.title, 'AI Usage · Export or import saved profiles');
    assert.deepEqual(items.filter((item) => item.action).map((item) => item.action), ['import']);
    return items.at(-1);
  }, undefined, undefined);
  await f.menu.show('claude');
  f.services.views = {};
  f.services.connected.list = async (provider) => baseView(provider, provider === 'claude' ? [profile()] : []);
  quickPickResponses.push(pickAction('manage'), pickAction('transfer'), (items) => { assert.deepEqual(items.filter((item) => item.action).map((item) => item.action), ['export', 'import']); return items.find((item) => item.action === 'export'); },
    undefined, undefined, undefined);
  await f.menu.show('claude');
  assert.equal(quickPickResponses.length, 0, 'the export was cancelled at its first prompt and the menus unwound');
});

test('the unavailable menu: retry that fails opens the service menu, install that already exists reconnects, Back and the service entry', async () => {
  const f = fixture({ claude: baseView('claude', []) });
  const client = f.services.connected;
  f.services.connected = undefined;
  f.services.background = true;
  f.services.isInstalled = () => true;
  f.services.ensure = async () => undefined;
  const hooks = hooksOf({ back: async () => { f.calls.push(['back']); } });
  quickPickResponses.push((items) => {
    assert.ok(!items.some((item) => item.action === 'install'), 'already installed: no install offer');
    assert.deepEqual(items.map((item) => item.action), ['retry', 'service', undefined, 'back']);
    return items.find((item) => item.action === 'service');
  });
  await f.menu.show('claude', hooks);
  assert.deepEqual(f.calls, [['showMenu']]);
  f.calls.length = 0;
  quickPickResponses.push((items) => items.find((item) => item.action === 'back'));
  await f.menu.show('claude', hooks);
  assert.deepEqual(f.calls, [['back']]);
  // Escape ends it without any action.
  f.calls.length = 0;
  quickPickResponses.push(undefined);
  await f.menu.show('claude', hooks);
  assert.deepEqual(f.calls, []);
  // Install while the package exists only reconnects; when that fails too the service menu opens.
  f.services.isInstalled = () => false;
  f.services.install = async () => { f.services.isInstalled = () => true; return false; };
  quickPickResponses.push(pickAction('install'));
  await f.menu.show('claude');
  assert.deepEqual(f.calls, [], 'the install failed and nothing is connected, so no account menu opens');
  f.services.install = async () => assert.fail('already installed');
  f.services.isInstalled = () => true;
  quickPickResponses.push((items) => items.find((item) => item.action === 'retry'));
  // After an install the account menu opens when connected.
  f.services.isInstalled = () => false;
  f.services.install = async () => { f.services.connected = client; return true; };
  quickPickResponses.length = 0;
  quickPickResponses.push(pickAction('install'), pickAction('save'), undefined);
  await f.menu.show('claude');
  assert.deepEqual(f.calls, [], 'the account menu opened after installing (and the save was cancelled)');
  assert.equal(quickPickResponses.length, 0);
});

test('events: configChanged redraws an open menu, other providers\' changes and a lost view are ignored, and the disposables are released', async () => {
  const view = baseView('claude', [profile({ active: true })]);
  const f = fixture({ claude: view });
  const state = new Set(), events = new Set();
  f.services.onStateChanged = (listener) => { state.add(listener); return { dispose: () => state.delete(listener) }; };
  f.services.onEvent = (listener) => { events.add(listener); return { dispose: () => events.delete(listener) }; };
  quickPickResponses.push((items, options, picker) => {
    const settings = () => picker.items.find((item) => item.action === 'settings').description;
    assert.match(settings(), /^Keep-alive off · rotation off$/);
    f.services.views.claude = { ...view, keepAlive: true };
    // Another service's change, and non-config events, leave the items alone.
    for (const listener of state) { listener('codex'); }
    for (const listener of events) { listener({ event: 'log', line: 'x' }); }
    assert.match(settings(), /rotation off$/);
    assert.match(settings(), /Keep-alive off/);
    for (const listener of state) { listener(undefined); }
    assert.match(settings(), /Keep-alive on/, 'a lost connection (undefined) refreshes every menu');
    f.services.views.claude = { ...view, keepAlive: true, autoRotate: true, strategySummary: 'soonest reset' };
    f.services.config.claude.autoRotate.strategy = 'soonestReset';
    for (const listener of events) { listener({ event: 'configChanged', config: f.services.config }); }
    assert.match(settings(), /rotation on \(/);
    // The view disappears (connection lost): the items stay as they were.
    f.services.views.claude = undefined;
    const before = picker.items;
    for (const listener of state) { listener('claude'); }
    assert.equal(picker.items, before);
    return undefined;
  });
  await f.menu.show('claude');
  assert.equal(state.size + events.size, 0);
});
