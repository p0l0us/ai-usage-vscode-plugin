const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Every window shares these user settings, as VS Code does.
const settings = new Map();
const informationMessages = [];
const warningMessages = [];
const errorMessages = [];
// Answers for the notification buttons, in the order the messages appear; undefined is a dismissed notification.
const informationResponses = [];
const warningResponses = [];
const shownDocuments = [];
test.beforeEach(() => { quickPickResponses.length = 0; informationMessages.length = 0; warningMessages.length = 0; errorMessages.length = 0; informationResponses.length = 0; warningResponses.length = 0; shownDocuments.length = 0; });
const quickPickResponses = [];
const executed = [];
const menus = [];
const { quickPickFactory } = require('./helpers/quickPick');
const environment = {};
const workspaceFolders = [];

// The real service layer would call systemctl, loginctl, launchctl and reg; these stand-ins on PATH record nothing and
// report that no systemd user manager exists, so no test can register or start a real service.
const fakeTools = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-fake-tools-'));
for (const name of ['systemctl', 'loginctl', 'launchctl', 'reg']) { fs.writeFileSync(path.join(fakeTools, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 }); }
process.env.PATH = `${fakeTools}${path.delimiter}${process.env.PATH}`;
test.after(() => fs.rmSync(fakeTools, { recursive: true, force: true }));

const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'vscode') return {
    QuickPickItemKind: { Separator: -1 },
    ConfigurationTarget: { Global: 1 },
    ProgressLocation: { Notification: 15 },
    EventEmitter: class {
      constructor() { const listeners = new Set(); this.listeners = listeners; this.event = (listener) => { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; }; }
      fire(value) { for (const listener of [...this.listeners]) { listener(value); } }
      dispose() { this.listeners.clear(); }
    },
    Uri: { file: (fsPath) => ({ scheme: 'file', fsPath }) },
    env: environment,
    window: {
      showInformationMessage: async (message, ...rest) => { informationMessages.push(message); return informationResponses.shift(); },
      showWarningMessage: async (message, ...rest) => { warningMessages.push(message); return warningResponses.shift(); },
      showErrorMessage: async (message) => { errorMessages.push(message); return undefined; },
      showTextDocument: async (uri, options) => { shownDocuments.push([uri.fsPath, options]); },
      withProgress: async (options, task) => task(),
      showQuickPick: async (items, options) => { const response = quickPickResponses.shift(); return typeof response === 'function' ? response(items, options) : response; },
      createQuickPick: quickPickFactory(quickPickResponses, menus)
    },
    commands: { executeCommand: async (...args) => { executed.push(args); } },
    workspace: {
      get workspaceFolders() { return workspaceFolders; },
      getConfiguration: (section) => ({
        get: (key, fallback) => { const full = section ? `${section}.${key}` : key; return settings.has(full) ? settings.get(full) : fallback; },
        inspect: (key) => ({ globalValue: settings.get(section ? `${section}.${key}` : key) }),
        update: async (key, value) => { settings.set(section ? `${section}.${key}` : key, value); }
      })
    }
  };
  return load.call(this, id, ...args);
};
const { ServiceManager } = require('../out/serviceManager');
Module._load = load;

/** VS Code's global state and SecretStorage, shared by every window of one user; never the real user's. */
function userStorage() {
  return { state: new Map(), secrets: new Map() };
}

/** One VS Code window's extension context over the user's storage. */
function windowContext(storage, user = userStorage()) {
  const { state, secrets } = user;
  return {
    extensionPath: path.join(__dirname, '..'),
    extension: { packageJSON: { version: '1.0.0-test' } },
    globalStorageUri: { fsPath: storage },
    globalState: { get: (key) => state.get(key), update: async (key, value) => { state.set(key, value); } },
    secrets: { get: async (key) => secrets.get(key), delete: async (key) => { secrets.delete(key); }, store: async (key, value) => { secrets.set(key, value); } },
    environmentVariableCollection: { prepend() {}, clear() {} }
  };
}

async function until(condition, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error('timed out'); }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('the background service survives window disposal and a manual stop is respected by reopened windows and CLI reads', async t => {
  const { installService, stopService, readServiceInfo } = require('../service/out');
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-background-'));
  const previous = process.env.AI_USAGE_HOME;
  const home = path.join(root, 'home');
  process.env.AI_USAGE_HOME = home;
  settings.clear();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude: { enabled: false }, codex: { enabled: false,
    autoReset: { enabled: false } }, copilot: { enabled: false }, bridge: { autoStart: false } }));
  const managers = [];
  t.after(async () => {
    await Promise.all(managers.map(manager => manager.stop()));
    await stopService(home);
    if (previous === undefined) delete process.env.AI_USAGE_HOME; else process.env.AI_USAGE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const installed = installService({ home, sourceDir: path.join(__dirname, '..', 'service'),
    node: { command: process.execPath, args: [], env: {}, version: process.version.slice(1), source: 'test' }, autostart: false });
  const open = name => {
    const manager = new ServiceManager(windowContext(path.join(root, name)), () => {});
    managers.push(manager);
    return manager;
  };
  const first = open('first');
  const client = await first.ensure();
  assert.ok(client);
  assert.equal(client.info.mode, 'background');
  await client.setConfig({ 'codex.checkIntervalMinutes': 17 });
  const pid = client.info.pid;
  await first.stop();
  const second = open('second');
  assert.equal((await second.ensure()).info.pid, pid, 'a reopened window uses the same process');
  await stopService(home);
  await until(() => !second.connected);
  assert.equal(await second.ensure(), undefined, 'reconnection does not undo an explicit stop');
  assert.equal(await open('third').ensure(), undefined, 'a fresh window honors the stop too');
  const cli = spawnSync(process.execPath, [path.join(installed.dir, 'bin', 'ai-usage.js'), 'status'], { encoding: 'utf8', env: process.env });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /stopped manually/);
  const autostart = spawnSync(process.execPath, [path.join(installed.dir, 'bin', 'ai-usage.js'), 'daemon'], { encoding: 'utf8', env: process.env });
  assert.equal(autostart.status, 0, 'autostart also respects the manual stop');
  assert.equal(readServiceInfo(home), undefined, 'a CLI read does not restart the stopped service');
  quickPickResponses.push(items => items.find(item => item.action === 'start'));
  await second.showMenu();
  const resumed = second.connected;
  assert.ok(resumed);
  assert.equal(resumed.info.mode, 'background');
  assert.notEqual(resumed.info.instanceId, client.info.instanceId);
  assert.equal((await resumed.getConfig()).codex.checkIntervalMinutes, 17);
  quickPickResponses.push(items => items.find(item => item.action === 'restart'));
  await second.showMenu();
  assert.ok(second.connected);
  assert.equal(second.connected.info.mode, 'background');
  assert.notEqual(second.connected.info.instanceId, resumed.info.instanceId);
  assert.equal((await second.connected.getConfig()).codex.checkIntervalMinutes, 17);
});

test('without the background service one window hosts the service, the others use it, and one takes over when it closes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-windows-'));
  const previous = process.env.AI_USAGE_HOME;
  process.env.AI_USAGE_HOME = path.join(root, 'home');
  settings.clear();
  for (const key of ['claude.enabled', 'codex.enabled', 'copilot.enabled', 'codex.autoReset.enabled', 'bridge.autoStart']) settings.set(`aiUsage.${key}`, false);
  settings.set('aiUsage.accountService.background', false);
  const managers = [];
  t.after(async () => {
    for (const manager of managers) { await manager.stop(); }
    if (previous === undefined) delete process.env.AI_USAGE_HOME; else process.env.AI_USAGE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const user = userStorage();
  user.state.set('aiUsage.authProfiles.v1', { codex: { profiles: [{ id: 'x1', name: 'Codex 1', createdAt: '2026-10-07T12:00:00.000Z', updatedAt: '2026-10-07T12:00:00.000Z' }] } });
  user.secrets.set('aiUsage.authProfile.v1.codex.x1', JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a', refresh_token: 'r', account_id: 'acc-1' }, last_refresh: '2026-10-07T12:00:00.000Z' }));
  const open = (name) => {
    const manager = new ServiceManager(windowContext(path.join(root, name), user), () => {});
    managers.push(manager);
    return manager;
  };

  const first = open('first');
  const client = await first.ensure({ promptInstall: true });
  assert.ok(client, 'the first window connects to a service');
  assert.equal(first.hosting, true);
  assert.equal(first.isInstalled(), false, 'nothing is installed');
  assert.equal(informationMessages.length, 0, 'no install offer while the background service is off');
  assert.equal(client.info.profileStore, 'service');
  assert.deepEqual((await client.list('codex')).profiles.map((profile) => profile.name), ['Codex 1'], 'the profiles saved in VS Code are listed');
  assert.equal(fs.existsSync(path.join(root, 'home', 'profiles.json')), true, 'the service owns migrated credentials');
  assert.equal(user.secrets.has('aiUsage.authProfile.v1.codex.x1'), false, 'the migrated key no longer lives in VS Code');

  const second = open('second');
  assert.ok(await second.ensure());
  assert.equal(second.hosting, false, 'the second window uses the first window\'s service');

  first.dispose();
  await until(() => second.hosting && second.connected);
  assert.ok(second.connected, 'the second window took over');
  assert.deepEqual((await second.connected.list('codex')).profiles.map((profile) => profile.name), ['Codex 1']);
});

test('declining the background service offers it once and still gives the window a working service', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-windows-'));
  const previous = process.env.AI_USAGE_HOME;
  process.env.AI_USAGE_HOME = path.join(root, 'home');
  settings.clear();
  for (const key of ['claude.enabled', 'codex.enabled', 'copilot.enabled', 'codex.autoReset.enabled', 'bridge.autoStart']) settings.set(`aiUsage.${key}`, false);
  informationMessages.length = 0;
  const manager = new ServiceManager(windowContext(path.join(root, 'window')), () => {});
  t.after(async () => {
    await manager.stop();
    if (previous === undefined) delete process.env.AI_USAGE_HOME; else process.env.AI_USAGE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.ok(await manager.ensure({ promptInstall: true }));
  assert.equal(manager.hosting, true);
  assert.equal(informationMessages.filter((message) => /run its account service in the background/.test(message)).length, 1);
  manager.dispose();
  assert.equal(fs.existsSync(path.join(root, 'home', 'service')), false, 'no service package was installed');
});

test('the Account service menu ends with Back, to the AI Usage menu or to the menu that opened it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-windows-'));
  const previous = process.env.AI_USAGE_HOME;
  process.env.AI_USAGE_HOME = path.join(root, 'home');
  settings.clear();
  for (const key of ['claude.enabled', 'codex.enabled', 'copilot.enabled', 'codex.autoReset.enabled', 'bridge.autoStart']) settings.set(`aiUsage.${key}`, false);
  const manager = new ServiceManager(windowContext(path.join(root, 'window')), () => {});
  t.after(async () => {
    await manager.stop();
    if (previous === undefined) delete process.env.AI_USAGE_HOME; else process.env.AI_USAGE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  executed.length = 0;
  menus.length = 0;
  quickPickResponses.push((items) => {
    assert.equal(items.at(-1).label, '$(arrow-left) Back');
    assert.equal(items.at(-1).description, 'AI Usage menu of all services');
    return items.at(-1);
  });
  await manager.showMenu();
  assert.deepEqual(executed, [['aiUsage.showDetails']]);
  assert.equal(menus[0].hidden, false, 'the AI Usage menu replaces this one instead of opening after it closed');
  assert.equal(menus[0].disposed, true);

  let returnedWhileOpen;
  quickPickResponses.push((items) => {
    assert.equal(items.at(-1).description, 'Codex accounts');
    return items.at(-1);
  });
  await manager.showMenu({ description: 'Codex accounts', run: async () => { returnedWhileOpen = !menus[1].hidden && !menus[1].disposed; } });
  assert.equal(returnedWhileOpen, true);
});

test('explicit first-run engine settings seed once, persisted values win on reconnect and presentation stays local', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-usage-config-ui-'));
  const previous=process.env.AI_USAGE_HOME;process.env.AI_USAGE_HOME=path.join(root,'home');
  settings.clear();for(const key of ['claude.enabled','codex.enabled','copilot.enabled','codex.autoReset.enabled','bridge.autoStart','accountService.background'])settings.set(`aiUsage.${key}`,false);
  settings.set('aiUsage.codex.source','cli');settings.set('aiUsage.codex.advanced.rotationDiagnostics',true);
  const manager=new ServiceManager(windowContext(path.join(root,'window')),()=>{});
  t.after(async()=>{await manager.stop();if(previous===undefined)delete process.env.AI_USAGE_HOME;else process.env.AI_USAGE_HOME=previous;fs.rmSync(root,{recursive:true,force:true});});
  const client=await manager.ensure();assert.equal((await client.getConfig()).codex.source,'cli');
  assert.equal((await client.getConfig()).codex.advanced.rotationDiagnostics,false);assert.equal(settings.get('aiUsage.codex.advanced.rotationDiagnostics'),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'home','config.json'),'utf8')).codex.source,'cli','initial editor settings persist for standalone restarts');
  await client.setConfig({'codex.source':'sessionLog'});
  await until(()=>settings.get('aiUsage.codex.source')==='sessionLog');
  settings.set('aiUsage.codex.source','cli');
  const before=await client.getConfigState();
  client.close();
  const reconnected=await manager.ensure();
  assert.equal((await reconnected.getConfig()).codex.source,'sessionLog');
  assert.equal((await reconnected.getConfigState()).revision,before.revision,'reconnect does not mutate engine config');
  assert.equal(settings.get('aiUsage.codex.source'),'sessionLog');
});

test('disabling background integration still uses one authenticated socket engine across windows', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-usage-local-ui-'));
  const previous=process.env.AI_USAGE_HOME;process.env.AI_USAGE_HOME=path.join(root,'home');
  settings.clear();for(const key of ['claude.enabled','codex.enabled','copilot.enabled','codex.autoReset.enabled','bridge.autoStart','accountService.enabled'])settings.set(`aiUsage.${key}`,false);
  settings.set('aiUsage.codex.autoRotate.strategy','leastWaste');
  const manager=new ServiceManager(windowContext(path.join(root,'window')),()=>{});
  t.after(async()=>{await manager.stop();if(previous===undefined)delete process.env.AI_USAGE_HOME;else process.env.AI_USAGE_HOME=previous;fs.rmSync(root,{recursive:true,force:true});});
  const client=await manager.ensure();assert.ok(client);assert.equal(manager.hosting,true);
  assert.equal(client.info.profileStore,'service');assert.match(manager.summary(),/inside this VS Code window/);
  assert.equal((await client.call('rotation.diagnostics',{provider:'codex'})).strategy,'leastWaste');
  assert.equal((await client.getConfig()).codex.autoRotate.strategy,'leastWaste');
  assert.equal(fs.existsSync(path.join(root,'home','service.sock')),true,'embedded engine serves the shared socket');
  const second=new ServiceManager(windowContext(path.join(root,'second')),()=>{});
  try {
    const peer=await second.ensure();assert.ok(peer);assert.equal(second.hosting,false);
    assert.equal(peer.info.pid,client.info.pid);
    await manager.stop();await until(()=>second.hosting&&second.connected);
    assert.equal((await second.connected.getConfig()).codex.autoRotate.strategy,'leastWaste');
  } finally { await second.stop(); }
});


test('a queued editor edit keeps its original revision and cannot overwrite a competing same-key change', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-usage-revision-ui-'));
  const previous=process.env.AI_USAGE_HOME;process.env.AI_USAGE_HOME=path.join(root,'home');
  const { defaultConfig }=require('../service/out');
  const persisted=defaultConfig();
  const manager=new ServiceManager(windowContext(path.join(root,'window')),()=>{});
  t.after(async()=>{await manager.stop();if(previous===undefined)delete process.env.AI_USAGE_HOME;else process.env.AI_USAGE_HOME=previous;fs.rmSync(root,{recursive:true,force:true});});
  const calls=[];
  const client={connected:true,close(){this.connected=false;},async getConfigState(){return {config:persisted,revision:8};},
    async patchConfig(values,baseRevision){calls.push({values,baseRevision});assert.equal(baseRevision,7);throw new Error('config-conflict');}};
  manager.client=client;manager.config=persisted;manager.configRevision=7;
  settings.clear();settings.set('aiUsage.claude.autoRotate.enabled',false);
  let release;manager.settingsQueue=new Promise(resolve=>{release=resolve;});
  const edited=manager.pushSettings({affectsConfiguration:key=>key==='aiUsage.claude.autoRotate.enabled'});
  manager.configRevision=8; // A competing configChanged arrives while the edit is queued.
  release();await edited;
  assert.deepEqual(calls,[{values:{'claude.autoRotate.enabled':false},baseRevision:7}]);
  assert.equal(persisted.claude.autoRotate.enabled,true);
  assert.equal(settings.get('aiUsage.claude.autoRotate.enabled'),true,'conflict reads and hydrates the winning value');
});


test('closing a window during initial connection cannot leave an embedded host or client', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-usage-dispose-ui-'));
  const previous=process.env.AI_USAGE_HOME;process.env.AI_USAGE_HOME=path.join(root,'home');
  settings.clear();settings.set('aiUsage.accountService.background',false);
  const manager=new ServiceManager(windowContext(path.join(root,'window')),()=>{});
  t.after(async()=>{await manager.stop();if(previous===undefined)delete process.env.AI_USAGE_HOME;else process.env.AI_USAGE_HOME=previous;fs.rmSync(root,{recursive:true,force:true});});
  const connecting=manager.ensure();
  await manager.stop();
  assert.equal(await connecting,undefined);
  assert.equal(manager.connected,undefined);
  assert.equal(manager.hosting,false);
  assert.equal(fs.existsSync(path.join(root,'home','service.sock')),false);
});

for (const enabled of [false, true]) test(`standalone Start, Stop and Restart preserve state without installation (service enabled=${enabled})`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-lifecycle-ui-'));
  const previous = process.env.AI_USAGE_HOME;
  process.env.AI_USAGE_HOME = path.join(root, 'home');
  settings.clear();
  for (const key of ['claude.enabled', 'codex.enabled', 'copilot.enabled', 'codex.autoReset.enabled', 'bridge.autoStart']) settings.set(`aiUsage.${key}`, false);
  settings.set('aiUsage.accountService.enabled', enabled);
  settings.set('aiUsage.accountService.background', !enabled);
  const manager = new ServiceManager(windowContext(path.join(root, 'window')), () => {});
  t.after(async () => {
    await manager.stop();
    if (previous === undefined) delete process.env.AI_USAGE_HOME; else process.env.AI_USAGE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const choose = async action => {
    quickPickResponses.push(items => {
      for (const expected of ['start', 'stop', 'restart']) assert.ok(items.some(item => item.action === expected), `${expected} works without installation`);
      assert.doesNotMatch(JSON.stringify(items), /Turned off by aiUsage.accountService.enabled/);
      return items.find(item => item.action === action);
    });
    await manager.showMenu();
  };
  const first = await manager.ensure();
  assert.ok(first);
  await first.setConfig({ 'codex.checkIntervalMinutes': 17 });
  await choose('stop');
  await until(() => !manager.connected && !manager.hosting);
  assert.equal(await manager.ensure(), undefined, 'automatic reconnect respects the manual stop');
  manager.tick();
  assert.equal(manager.hosting, false);
  await choose('start');
  assert.ok(manager.connected);
  const resumed = manager.connected;
  assert.notEqual(resumed.info.instanceId, first.info.instanceId);
  assert.equal((await resumed.getConfig()).codex.checkIntervalMinutes, 17);
  await choose('restart');
  assert.ok(manager.connected);
  assert.notEqual(manager.connected.info.instanceId, resumed.info.instanceId);
  assert.equal((await manager.connected.getConfig()).codex.checkIntervalMinutes, 17);
  assert.equal(manager.isInstalled(), false);
  assert.equal(fs.existsSync(path.join(root, 'home', 'service')), false);
});

// ---- Connection failures, reconnects, events, settings, installation, transfers and the menu. ----

const service = require('../service/out');

/** A window over a temporary service home whose settings keep every provider quiet; `background: false` hosts in the window. */
function scenario(t, { background = false, home } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-sm-'));
  const previous = process.env.AI_USAGE_HOME;
  const serviceHome = home ?? path.join(root, 'home');
  process.env.AI_USAGE_HOME = serviceHome;
  settings.clear();
  for (const key of ['claude.enabled', 'codex.enabled', 'copilot.enabled', 'codex.autoReset.enabled', 'bridge.autoStart']) settings.set(`aiUsage.${key}`, false);
  settings.set('aiUsage.accountService.background', background);
  delete environment.remoteName;
  const logs = [];
  const user = userStorage();
  const prepends = [];
  let cleared = 0;
  const context = windowContext(path.join(root, 'window'), user);
  context.environmentVariableCollection = { prepend: (name, value) => prepends.push([name, value]), clear: () => { cleared++; }, set description(value) { this.text = value; } };
  const managers = [];
  const open = (extra = {}) => {
    const manager = new ServiceManager({ ...context, ...extra }, (line) => logs.push(line));
    managers.push(manager);
    return manager;
  };
  const manager = open();
  t.after(async () => {
    for (const each of managers) { await each.stop().catch(() => undefined); }
    await service.stopService(serviceHome).catch(() => undefined);
    if (previous === undefined) delete process.env.AI_USAGE_HOME; else process.env.AI_USAGE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home: serviceHome, manager, open, logs, user, prepends, context, cleared: () => cleared };
}

/** Node as a stand-in command: the real runtime behind a path, so an installed service really starts, from the test's temporary home. */
function standInNode(root) {
  const file = path.join(root, 'stand-in-node');
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  return file;
}

test('summary and the bundled version describe where the service runs, and require() says what to do', async (t) => {
  const s = scenario(t);
  assert.equal(s.manager.summary(), 'not running');
  assert.equal(s.manager.profileStore(), undefined);
  assert.throws(() => s.manager.require(), /The account service is not answering yet; try again in a moment\. AI Usage: Account Service… shows its state\./);
  assert.equal(s.manager.bundledVersion(), JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'service', 'package.json'), 'utf8')).version);
  const noPackage = new ServiceManager({ ...s.context, extensionPath: path.join(s.root, 'empty') }, () => {});
  assert.equal(noPackage.bundledVersion(), '0.0.0', 'a missing bundled package reads as 0.0.0');
  assert.equal(noPackage.bundledDir, path.join(s.root, 'empty', 'service'));
  assert.ok(await s.manager.ensure());
  assert.equal(s.manager.summary(), `inside this VS Code window · version ${s.manager.connected.info.version} · Claude and Codex`);
  assert.equal(s.manager.profileStore(), 'service');
  // A service hosted by another window reads as "inside a VS Code window"; a background one as "background".
  const other = s.open();
  await s.manager.stop();
  const peerHost = await service.startServiceHost({ home: s.home, version: '7.7.7', mode: 'embedded' });
  t.after(() => peerHost.stop().catch(() => undefined));
  assert.ok(await other.ensure());
  assert.equal(other.summary(), 'inside a VS Code window · version 7.7.7 · Claude and Codex');
  assert.equal(other.hosting, false);
  assert.equal(other.enabled, true);
  assert.equal(other.background, false);
});

test('a connection failure is logged and retried: tick waits out the retry delay, then reconnects', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-blocked-'));
  const blocker = path.join(root, 'home');
  fs.writeFileSync(blocker, 'a file where the service home should be');
  const s = scenario(t, { home: blocker });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(await s.manager.ensure(), undefined);
  assert.equal(s.manager.connected, undefined);
  assert.equal(s.manager.hosting, false);
  assert.ok(s.logs.some((line) => line.startsWith('service: not hosted in this window: ')), s.logs.join('\n'));
  assert.equal(s.manager.summary(), 'not running');
  // The home becomes usable. A tick right after the failure does nothing; one after the retry delay reconnects.
  fs.rmSync(blocker);
  let attempts = 0;
  const ensure = s.manager.ensure.bind(s.manager);
  s.manager.ensure = (...args) => { attempts++; return ensure(...args); };
  s.manager.tick();
  assert.equal(attempts, 0, 'the last attempt was just now');
  s.manager.lastAttemptAt = Date.now() - 31_000;
  s.manager.tick();
  assert.equal(attempts, 1);
  await until(() => s.manager.connected);
  s.manager.tick();
  assert.equal(attempts, 1, 'connected: nothing to do');
  assert.equal(s.manager.hosting, true);
});

test('tick stays quiet while a manual stop is in effect, while connecting and after disposal', async (t) => {
  const s = scenario(t);
  let attempts = 0;
  s.manager.ensure = () => { attempts++; return Promise.resolve(undefined); };
  s.manager.lastAttemptAt = 0;
  fs.mkdirSync(path.join(s.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(s.home, 'state', 'service-stopped'), '');
  s.manager.tick();
  assert.equal(attempts, 0, 'stopped manually');
  fs.rmSync(path.join(s.home, 'state', 'service-stopped'));
  s.manager.connecting = Promise.resolve(undefined);
  s.manager.tick();
  assert.equal(attempts, 0, 'a connection attempt is already running');
  s.manager.connecting = undefined;
  await s.manager.stop();
  s.manager.tick();
  assert.equal(attempts, 0, 'disposed');
  assert.equal(await ServiceManager.prototype.ensure.call(s.manager), undefined, 'a disposed window does not connect');
});

test('concurrent ensure calls share one connection attempt and one hosted service', async (t) => {
  const s = scenario(t);
  const [a, b] = await Promise.all([s.manager.ensure(), s.manager.ensure()]);
  assert.ok(a);
  assert.equal(a, b);
  assert.equal(s.logs.filter((line) => line.startsWith('service: running inside this VS Code window')).length, 1);
  assert.equal(await s.manager.ensure(), a, 'connected: the same client again');
  assert.ok(s.logs.some((line) => /^service: connected to version .* \(pid \d+, home /.test(line)));
});

test('reconnect: a window takes the service over when the one it used goes away, and views and listeners follow', async (t) => {
  const s = scenario(t);
  const states = [];
  s.manager.onStateChanged((provider) => states.push(provider));
  const external = await service.startServiceHost({ home: s.home, version: '5.0.0', mode: 'embedded' });
  t.after(() => external.stop().catch(() => undefined));
  const first = await s.manager.ensure();
  assert.ok(first);
  assert.equal(s.manager.hosting, false);
  assert.deepEqual(Object.keys(s.manager.views).sort(), ['claude', 'codex'], 'views were read on connecting');
  states.length = 0;
  await external.stop();
  await until(() => s.manager.hosting && s.manager.connected && s.manager.connected !== first && s.manager.views.codex);
  assert.ok(states.includes(undefined), 'the loss of the connection was announced');
  assert.ok(s.logs.includes('service: connection closed'));
  assert.deepEqual(Object.keys(s.manager.views).sort(), ['claude', 'codex'], 'views were read again after the takeover');
  assert.notEqual(s.manager.connected.info.instanceId, first.info.instanceId);
});

test('reconnect retries every second until a service answers, and gives up after a manual stop', async (t) => {
  const s = scenario(t);
  const outcomes = [undefined, undefined, 'connected'];
  let attempts = 0;
  s.manager.ensure = async () => { attempts++; const outcome = outcomes.shift(); if (attempts === 2) { fs.mkdirSync(path.join(s.home, 'state'), { recursive: true }); fs.writeFileSync(path.join(s.home, 'state', 'service-stopped'), ''); } return outcome; };
  s.manager.scheduleReconnect(10);
  await until(() => attempts >= 2, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  assert.equal(attempts, 2, 'no third attempt after the manual stop');
  // scheduleReconnect itself refuses while stopped, and after disposal.
  s.manager.scheduleReconnect(10);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(attempts, 2);
});

test('a manual stop is honored until Start, and a stopped home still connects to a service someone else runs', async (t) => {
  const s = scenario(t);
  fs.mkdirSync(path.join(s.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(s.home, 'state', 'service-stopped'), '');
  assert.equal(await s.manager.ensure(), undefined, 'nothing is hosted while stopped');
  assert.equal(s.manager.hosting, false);
  const external = await service.startServiceHost({ home: s.home, version: '5.1.0', mode: 'embedded' });
  t.after(() => external.stop().catch(() => undefined));
  const client = await s.manager.ensure();
  assert.ok(client, 'an existing service is connected to even while stopped');
  assert.equal(client.info.version, '5.1.0');
  assert.equal(s.manager.hosting, false);
});

test('events from the service: state changes refresh the view, configuration changes hydrate settings, logs are relayed', async (t) => {
  const s = scenario(t);
  const events = [], states = [];
  s.manager.onEvent((event) => events.push(event.event));
  s.manager.onStateChanged((provider) => states.push(provider));
  const client = await s.manager.ensure();
  states.length = 0;
  let listed = 0;
  const list = client.list.bind(client);
  client.list = async (provider) => { listed++; return list(provider); };
  client.emit('event', { event: 'stateChanged', provider: 'codex' });
  await until(() => states.includes('codex'));
  assert.equal(listed, 1, 'only the changed provider was read');
  assert.ok(events.includes('stateChanged'));
  // A configuration change from the service replaces the cached config and is mirrored into user settings.
  settings.set('aiUsage.codex.checkIntervalMinutes', 30); // Only settings the user has set are written back.
  const changed = JSON.parse(JSON.stringify(s.manager.config));
  changed.codex.checkIntervalMinutes = 45;
  client.emit('event', { event: 'configChanged', config: changed, revision: s.manager.configRevision + 5 });
  assert.equal(s.manager.config.codex.checkIntervalMinutes, 45);
  await until(() => settings.get('aiUsage.codex.checkIntervalMinutes') === 45);
  // An older revision is ignored.
  const stale = JSON.parse(JSON.stringify(changed));
  stale.codex.checkIntervalMinutes = 3;
  client.emit('event', { event: 'configChanged', config: stale, revision: s.manager.configRevision - 1 });
  assert.equal(s.manager.config.codex.checkIntervalMinutes, 45);
  // Log lines lose their timestamp and are tagged.
  client.emit('event', { event: 'log', line: '[2026-10-11T10:00:00.000Z] claude: switched' });
  assert.ok(s.logs.includes('[service] claude: switched'));
  assert.ok(events.includes('log'));
  // Events of a client that is no longer current are not forwarded.
  events.length = 0;
  const stray = Object.create(null);
  s.manager.client = stray;
  client.emit('event', { event: 'log', line: 'late' });
  assert.deepEqual(events, []);
  s.manager.client = client;
});

test('a view that cannot be read is logged and leaves the others alone', async (t) => {
  const s = scenario(t);
  const client = await s.manager.ensure();
  const before = s.manager.views.claude;
  client.list = async () => { throw new Error('read failed'); };
  await s.manager.refreshViews('claude');
  assert.ok(s.logs.includes('service: could not read the claude view: read failed'));
  await s.manager.refreshViews();
  assert.ok(s.logs.includes('service: could not read the account view: read failed'));
  assert.equal(s.manager.views.claude, before);
  assert.equal(await s.manager.snapshot().then((value) => value === undefined || typeof value === 'object'), true);
  // Without a connection both are no-ops.
  await s.manager.stop();
  assert.equal(await s.manager.snapshot(), undefined);
  await s.manager.refreshViews();
});

test('snapshot returns the service state and adopts a newer configuration revision', async (t) => {
  const s = scenario(t);
  const client = await s.manager.ensure();
  const snapshot = await s.manager.snapshot();
  assert.deepEqual(Object.keys(snapshot.providers).sort(), ['claude', 'codex']);
  assert.deepEqual(Object.keys(s.manager.views).sort(), ['claude', 'codex']);
  await client.setConfig({ 'codex.checkIntervalMinutes': 21 });
  await until(() => s.manager.config.codex.checkIntervalMinutes === 21);
  client.snapshot = async () => { throw new Error('gone'); };
  assert.equal(await s.manager.snapshot(), undefined, 'a failing read is not an error');
});

test('settings pushed from the editor reach the service; a rejection is warned about and the persisted value is read back', async (t) => {
  const s = scenario(t);
  const client = await s.manager.ensure();
  const changeOf = (...keys) => ({ affectsConfiguration: (key) => keys.includes(key) });
  // No connection and no changes: nothing is sent.
  const calls = [];
  const patch = client.patchConfig.bind(client);
  client.patchConfig = async (values, revision) => { calls.push([values, revision]); return patch(values, revision); };
  await s.manager.pushSettings(changeOf('aiUsage.somethingElse'));
  assert.deepEqual(calls, []);
  settings.set('aiUsage.codex.checkIntervalMinutes', 40);
  const revision = s.manager.configRevision;
  await s.manager.pushSettings(changeOf('aiUsage.codex.checkIntervalMinutes'));
  assert.deepEqual(calls, [[{ 'codex.checkIntervalMinutes': 40 }, revision]]);
  assert.equal(s.manager.config.codex.checkIntervalMinutes, 40);
  assert.ok(s.manager.configRevision > revision);
  assert.ok(s.logs.includes('settings: pushed codex.checkIntervalMinutes to the account service'));
  assert.deepEqual(warningMessages, []);
  // The service rejects the value: the user is told, and the persisted value comes back into the editor settings.
  client.patchConfig = async () => { throw new Error('checkIntervalMinutes must be at least 1'); };
  settings.set('aiUsage.codex.checkIntervalMinutes', 0);
  await s.manager.pushSettings(changeOf('aiUsage.codex.checkIntervalMinutes'));
  assert.deepEqual(warningMessages, ['AI Usage: the account service rejected the setting: checkIntervalMinutes must be at least 1']);
  assert.ok(s.logs.includes('service: adopted persisted engine settings'));
  await until(() => settings.get('aiUsage.codex.checkIntervalMinutes') === 40);
  // A client that is no longer current is not written to.
  client.patchConfig = async () => assert.fail('a stale client must not be used');
  settings.set('aiUsage.codex.checkIntervalMinutes', 50);
  const pushing = s.manager.pushSettings(changeOf('aiUsage.codex.checkIntervalMinutes'));
  s.manager.client = undefined;
  await pushing;
  assert.equal(warningMessages.length, 1);
});

test('the workspace folders and session directories are declared on connecting and when they change', async (t) => {
  const s = scenario(t);
  workspaceFolders.push({ uri: { scheme: 'file', fsPath: '/work/app' } }, { uri: { scheme: 'vscode-remote', fsPath: '/remote/lib' } });
  settings.set('aiUsage.bridge.claude.sessionDirectory', '/sessions/claude');
  settings.set('aiUsage.bridge.codex.sessionDirectory', '');
  t.after(() => { workspaceFolders.length = 0; });
  assert.deepEqual(ServiceManager.localFolders(), ['/work/app'], 'only local folders hold profile files');
  const declared = [];
  const client = await s.manager.ensure();
  const call = client.call.bind(client);
  client.call = async (method, params) => { if (method === 'workspace.context') { declared.push(params); } return call(method, params); };
  await s.manager.declareFolders();
  assert.deepEqual(declared, [{ folders: ['/work/app'], sessionDirectory: { claude: '/sessions/claude' } }]);
  // A change of a session directory declares again; another bridge setting does not.
  declared.length = 0;
  await s.manager.pushSettings({ affectsConfiguration: (key) => key === 'aiUsage.bridge.codex.sessionDirectory' });
  assert.equal(declared.length, 1);
  await s.manager.pushSettings({ affectsConfiguration: (key) => key === 'aiUsage.bridge.url' });
  assert.equal(declared.length, 1);
  // A failing declaration is logged, not thrown.
  client.call = async () => { throw new Error('socket closed'); };
  await s.manager.declareFolders();
  assert.ok(s.logs.includes('service: could not declare the workspace folders: socket closed'));
  await s.manager.declareFolders(undefined).catch(() => assert.fail('no client is a no-op'));
});

test('the install offer: asked once, "Install" installs, "Don\'t ask again" turns the background setting off, "Not now" does nothing', async (t) => {
  const s = scenario(t, { background: true });
  settings.set('aiUsage.accountService.background', true);
  let installs = 0;
  s.manager.install = async () => { installs++; return true; };
  informationResponses.push('Install');
  assert.ok(await s.manager.ensure({ promptInstall: true }), 'a service is hosted while the offer is open');
  await until(() => installs === 1);
  assert.equal(informationMessages.filter((message) => /run its account service in the background/.test(message)).length, 1);
  assert.match(informationMessages[0], /It goes to ~\/\.ai-usage and is registered to start when you sign in\.$/);
  // Offered once per window: another attempt does not ask again.
  await s.manager.stop();
  const again = s.open();
  again.install = async () => { installs++; return true; };
  informationResponses.push('Not now');
  assert.ok(await again.ensure({ promptInstall: true }));
  await until(() => informationMessages.length >= 2);
  assert.equal(installs, 1, '"Not now" installs nothing');
  assert.equal(settings.get('aiUsage.accountService.background'), true);
  await again.stop();
  const third = s.open();
  informationResponses.push("Don't ask again");
  assert.ok(await third.ensure({ promptInstall: true }));
  await until(() => settings.get('aiUsage.accountService.background') === false);
  await until(() => informationMessages.some((message) => /nothing runs in the background/.test(message)));
  assert.match(informationMessages.at(-1), /^AI Usage: accounts keep working while VS Code is open; nothing runs in the background\. Turn aiUsage\.accountService\.background on to install the service later\.$/);
  // Without promptInstall (a reconnect) nobody is asked.
  const quiet = s.open();
  settings.set('aiUsage.accountService.background', true);
  const before = informationMessages.length;
  await third.stop();
  assert.ok(await quiet.ensure());
  assert.equal(informationMessages.length, before);
});

test('install: copies the bundled package, starts it, connects, reports the outcome; upgrade follows the bundled version', async (t) => {
  const s = scenario(t, { background: true });
  settings.set('aiUsage.accountService.background', true);
  fs.mkdirSync(s.home, { recursive: true });
  fs.writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ claude: { enabled: false }, codex: { enabled: false, autoReset: { enabled: false } }, copilot: { enabled: false }, bridge: { autoStart: false } }));
  const previousNode = process.env.AI_USAGE_NODE;
  process.env.AI_USAGE_NODE = standInNode(s.root);
  t.after(() => { if (previousNode === undefined) delete process.env.AI_USAGE_NODE; else process.env.AI_USAGE_NODE = previousNode; });
  const installed = [];
  s.manager.onDidInstall(() => installed.push('install'));
  environment.remoteName = 'ssh-remote';
  assert.equal(s.manager.isInstalled(), false);
  assert.equal(await s.manager.install(), true);
  assert.equal(s.manager.isInstalled(), true);
  assert.deepEqual(installed, ['install']);
  assert.ok(s.manager.connected, 'the installed service answered');
  assert.equal(s.manager.connected.info.mode, 'background');
  assert.equal(s.manager.summary(), `background · version ${s.manager.bundledVersion()} · Claude and Codex`);
  const message = informationMessages.at(-1);
  assert.match(message, new RegExp(`^AI Usage: account service ${s.manager.bundledVersion().replace(/\./g, '\\.')} installed with Node\\.js \\d+\\.\\d+\\.\\d+ from AI_USAGE_NODE; (starts at sign-in \\(|not registered to start at sign-in: )`));
  assert.ok(message.includes(`The ai-usage command is available in VS Code terminals of this remote; elsewhere add ${service.launcherDir(s.home)} to your PATH.`), message);
  assert.equal(fs.existsSync(path.join(s.home, 'service', s.manager.bundledVersion(), 'bin', 'ai-usage.js')), true);
  assert.ok(s.logs.some((line) => /^service: restarted \(started /.test(line)), s.logs.join('\n'));
  // Terminals get the launcher on PATH once connected with an installation.
  const second = s.open();
  await s.manager.stop();
  await service.stopService(s.home);
  await until(() => !service.serviceStatus(s.home).running);
  // The installed version is older than the bundled one: connecting upgrades it first.
  const currentFile = path.join(s.home, 'service', 'current.json');
  const current = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
  fs.writeFileSync(currentFile, JSON.stringify({ ...current, version: '0.0.1' }));
  service.clearManualServiceStop(s.home);
  second.onDidInstall(() => installed.push('upgrade'));
  assert.ok(await second.ensure());
  assert.deepEqual(installed, ['install', 'upgrade']);
  assert.ok(s.logs.some((line) => line.startsWith(`service: upgraded 0.0.1 → ${second.bundledVersion()}; restarted (`)), s.logs.join('\n'));
  assert.equal(second.connected.info.version, second.bundledVersion());
  assert.ok(s.prepends.some(([name, value]) => name === 'PATH' && value === `${service.launcherDir(s.home)}${path.delimiter}`), 'the ai-usage command is on the terminals\' PATH');
});

test('install reports a package that cannot be installed and does nothing when disposed', async (t) => {
  const s = scenario(t, { background: true });
  const broken = new ServiceManager({ ...s.context, extensionPath: path.join(s.root, 'missing') }, (line) => s.logs.push(line));
  t.after(() => broken.stop());
  assert.equal(await broken.install(), false);
  assert.equal(errorMessages.length, 1);
  assert.match(errorMessages[0], /^AI Usage: could not install the account service: /);
  assert.ok(s.logs.some((line) => line.startsWith('service: installation failed: ')));
  assert.equal(s.manager.isInstalled(), false);
});

test('profiles transfer between VS Code and the service: nothing to move, cancels, copy and move, and failures', async (t) => {
  const s = scenario(t);
  const client = await s.manager.ensure();
  // Nothing saved in VS Code yet.
  assert.equal(await s.manager.transfer('vscode', 'service'), false);
  assert.equal(informationMessages.at(-1), 'AI Usage: VS Code keeps no profiles to transfer.');
  // Two profiles appear in VS Code's storage (as an older window would have left them).
  const stamp = '2026-10-07T12:00:00.000Z';
  s.user.state.set('aiUsage.authProfiles.v1', { codex: { profiles: [
    { id: 'x1', name: 'Codex 1', createdAt: stamp, updatedAt: stamp }, { id: 'x2', name: 'Codex 2', createdAt: stamp, updatedAt: stamp }] } });
  for (const [id, account] of [['x1', 'acc-1'], ['x2', 'acc-2']]) {
    s.user.secrets.set(`aiUsage.authProfile.v1.codex.${id}`, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: `a-${id}`, refresh_token: `r-${id}`, account_id: account }, last_refresh: stamp }));
  }
  const names = async () => (await client.list('codex')).profiles.map((profile) => profile.name).sort();
  assert.deepEqual(await names(), []);
  // Cancel at the profile choice, and at the move-or-copy choice.
  quickPickResponses.push(undefined);
  assert.equal(await s.manager.transfer('vscode', 'service'), false);
  quickPickResponses.push((items) => items.slice(0, 1).map((item) => item), undefined);
  assert.equal(await s.manager.transfer('vscode', 'service'), false);
  quickPickResponses.push([]);
  assert.equal(await s.manager.transfer('vscode', 'service'), false, 'an empty selection transfers nothing');
  assert.deepEqual(await names(), []);
  // Copy one: the service has it, VS Code keeps it.
  quickPickResponses.push((items, options) => {
    assert.equal(options.title, 'AI Usage · Profiles from VS Code to the account service');
    assert.equal(options.canPickMany, true);
    assert.deepEqual(items.map((item) => [item.label, item.description, item.picked]), [['Codex 1', 'Codex', true], ['Codex 2', 'Codex', true]]);
    return [items[0]];
  }, (items) => {
    assert.deepEqual(items.map((item) => item.mode), ['move', 'copy']);
    return items.find((item) => item.mode === 'copy');
  });
  assert.equal(await s.manager.transfer('vscode', 'service'), true, errorMessages.join('\n'));
  assert.deepEqual(await names(), ['Codex 1']);
  assert.ok(s.user.secrets.has('aiUsage.authProfile.v1.codex.x1'), 'a copy leaves the source in place');
  assert.match(informationMessages.at(-1), /^AI Usage: copied 1 profile to the account service \(/);
  assert.ok(s.logs.some((line) => line.startsWith('profiles: copied 1 from VS Code to the account service: ')));
  // Move the other with a preset mode: no second question.
  quickPickResponses.push((items) => [items.find((item) => item.label === 'Codex 2')]);
  assert.equal(await s.manager.transfer('vscode', 'service', 'move'), true);
  assert.deepEqual(await names(), ['Codex 1', 'Codex 2']);
  assert.equal(s.user.secrets.has('aiUsage.authProfile.v1.codex.x2'), false, 'a move removes the source');
  assert.match(informationMessages.at(-1), /^AI Usage: moved 1 profile to the account service \(/);
  // The other way: from the service (what is connected) to VS Code.
  quickPickResponses.push((items) => { assert.equal(items.length, 2); return items; });
  assert.equal(await s.manager.transfer('service', 'vscode', 'copy'), true);
  assert.ok(s.user.secrets.has('aiUsage.authProfile.v1.codex.x2'));
  assert.match(informationMessages.at(-1), /^AI Usage: copied 2 profiles to VS Code \(/);
  // A failure while listing is reported rather than thrown.
  client.exportProfiles = async () => { throw new Error('service is busy'); };
  assert.equal(await s.manager.transfer('service', 'vscode', 'copy'), false);
  assert.equal(errorMessages.at(-1), 'AI Usage: could not transfer the profiles: service is busy');
  assert.ok(s.logs.includes('profiles: transfer from the account service to VS Code failed: service is busy'));
});

test('the Account service menu describes the state and each entry does what it says', async (t) => {
  const s = scenario(t);
  const choose = (action, inspect) => quickPickResponses.push((items) => { inspect?.(items); return items.find((item) => item.action === action); });
  // Not installed, not running, no connection: the menu says so, and offers the bundled version.
  quickPickResponses.push((items, options) => {
    assert.equal(options.title, 'AI Usage · Account service');
    const labels = items.map((item) => item.label);
    assert.ok(labels.includes('$(package) Not installed'));
    assert.match(items.find((item) => item.label === '$(package) Not installed').detail, /^Bundled version [\d.]+ can be installed under .*home\.$/);
    assert.ok(labels.includes('$(circle-slash) Not running'));
    assert.equal(items.find((item) => item.label === '$(circle-slash) Not running').detail, 'Not connected');
    assert.ok(labels.includes('$(database) In use: none (not connected)'));
    assert.ok(labels.includes('$(cloud-download) Install'));
    assert.ok(!items.some((item) => item.action === 'uninstall'), 'nothing to uninstall');
    assert.ok(!labels.some((label) => label.startsWith('$(terminal) Command')), 'no command without an installation');
    assert.match(items.find((item) => item.action === 'toService').detail, /^Copy or move; 0 saved in VS Code\.$/);
    return undefined;
  });
  await s.manager.showMenu();
  // Manually stopped says how to resume.
  fs.mkdirSync(path.join(s.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(s.home, 'state', 'service-stopped'), '');
  quickPickResponses.push((items) => { assert.equal(items.find((item) => item.label === '$(circle-slash) Not running').detail, 'Stopped manually; choose Start to resume.'); return undefined; });
  await s.manager.showMenu();
  fs.rmSync(path.join(s.home, 'state', 'service-stopped'));
  // Running inside this window: the connection line and the profile store.
  await s.manager.ensure();
  quickPickResponses.push((items) => {
    const running = items.find((item) => /^\$\(pass\) Running inside this VS Code window: pid \d+, version /.test(item.label));
    assert.ok(running, items.map((item) => item.label).join('\n'));
    assert.match(running.detail, /^Connected · \d+ clients?$/);
    assert.ok(items.some((item) => item.label === '$(database) In use: saved in the account service'));
    assert.match(items.find((item) => item.label.startsWith('$(database)')).detail, /profiles\.json, also without VS Code\./);
    const autostart = items.find((item) => item.label.includes('Autostart'));
    assert.equal(autostart.label, '$(warning) Autostart: none available');
    assert.equal(autostart.detail, 'no systemd user manager');
    return undefined;
  });
  await s.manager.showMenu();
  // Entries: the log opens in an editor, settings open filtered, install runs the install, transfer asks.
  choose('log');
  await s.manager.showMenu();
  assert.deepEqual(shownDocuments, [[path.join(s.home, 'service.log'), { preview: false }]]);
  executed.length = 0;
  choose('settings');
  await s.manager.showMenu();
  assert.deepEqual(executed, [['workbench.action.openSettings2', { query: '@ext:p0l0us.ai-usage-vscode-plugin aiUsage.accountService' }]]);
  let installs = 0, transfers = [];
  s.manager.install = async () => { installs++; return true; };
  s.manager.transfer = async (...args) => { transfers.push(args); return true; };
  choose('install');
  await s.manager.showMenu();
  assert.equal(installs, 1);
  choose('toService');
  await s.manager.showMenu();
  assert.deepEqual(transfers, [['vscode', 'service']]);
  // Back runs the supplied menu.
  let backed = 0;
  choose('back');
  await s.manager.showMenu({ description: 'Claude accounts', run: async () => { backed++; } });
  assert.equal(backed, 1);
  assert.ok(s.logs.includes('service: Account service menu → Back to Claude accounts'));
  // Escape does nothing at all.
  quickPickResponses.push(undefined);
  await s.manager.showMenu();
  assert.equal(installs, 1);
});

test('Stop reports what happened; Start and Restart report success or that the service could not start', async (t) => {
  const s = scenario(t);
  const pick = (action) => quickPickResponses.push((items) => items.find((item) => item.action === action));
  await s.manager.ensure();
  pick('stop');
  await s.manager.showMenu();
  assert.match(informationMessages.at(-1), /^AI Usage: account service (stopped|was not running)\.$/);
  await until(() => !s.manager.connected);
  // Start succeeds: hosted again, and said so.
  pick('start');
  await s.manager.showMenu();
  assert.ok(s.manager.connected);
  assert.equal(informationMessages.at(-1), 'AI Usage: account management started.');
  pick('restart');
  await s.manager.showMenu();
  assert.equal(informationMessages.at(-1), 'AI Usage: account management restarted.');
  assert.ok(s.manager.connected);
  // Start cannot connect: a warning that points at the log.
  s.manager.ensure = async () => undefined;
  pick('start');
  await s.manager.showMenu();
  assert.equal(warningMessages.at(-1), 'AI Usage: account management could not start. See the service log for details.');
  assert.equal(service.serviceManuallyStopped(s.home), false, 'Start allows connecting again');
});

test('Uninstall asks for confirmation, then stops, unregisters and removes the package but keeps the data', async (t) => {
  const s = scenario(t, { background: true });
  const node = { command: process.execPath, args: [], env: {}, version: process.version.slice(1), source: 'test' };
  service.installService({ home: s.home, sourceDir: s.manager.bundledDir, node, autostart: false });
  fs.writeFileSync(path.join(s.home, 'profiles.json'), '{}');
  assert.equal(s.manager.isInstalled(), true);
  const pickUninstall = () => quickPickResponses.push((items) => {
    assert.ok(items.some((item) => /^\$\(package\) Installed: version /.test(item.label)));
    assert.ok(items.some((item) => item.label.startsWith('$(terminal) Command: ai-usage')));
    return items.find((item) => item.action === 'uninstall');
  });
  // Dismissed or declined: nothing is removed.
  pickUninstall();
  await s.manager.showMenu();
  assert.equal(warningMessages.at(-1).startsWith('Uninstall the AI Usage background service?'), true);
  assert.equal(s.manager.isInstalled(), true);
  warningResponses.push('Cancel');
  pickUninstall();
  await s.manager.showMenu();
  assert.equal(s.manager.isInstalled(), true);
  assert.equal(s.cleared(), 0);
  warningResponses.push('Uninstall');
  pickUninstall();
  await s.manager.showMenu();
  assert.equal(s.manager.isInstalled(), false);
  assert.equal(fs.existsSync(path.join(s.home, 'service')), false);
  assert.equal(fs.existsSync(path.join(s.home, 'profiles.json')), true, 'saved profiles stay');
  assert.equal(s.cleared(), 1, 'the terminals lose the ai-usage PATH entry');
  assert.match(informationMessages.at(-1), /^AI Usage: account service uninstalled \(was not running; nothing was registered\)\.$/);
});
