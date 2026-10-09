const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Every window shares these user settings, as VS Code does.
const settings = new Map();
const informationMessages = [];
const quickPickResponses = [];
const executed = [];
const menus = [];
const { quickPickFactory } = require('./helpers/quickPick');
const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'vscode') return {
    QuickPickItemKind: { Separator: -1 },
    ConfigurationTarget: { Global: 1 },
    ProgressLocation: { Notification: 15 },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    Uri: { file: (fsPath) => ({ scheme: 'file', fsPath }) },
    env: {},
    window: {
      showInformationMessage: async (message) => { informationMessages.push(message); return undefined; },
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showQuickPick: async (items) => { const response = quickPickResponses.shift(); return typeof response === 'function' ? response(items) : response; },
      createQuickPick: quickPickFactory(quickPickResponses, menus)
    },
    commands: { executeCommand: async (...args) => { executed.push(args); } },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({
        get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
        inspect: (key) => ({ globalValue: settings.get(key) }),
        update: async (key, value) => { settings.set(key, value); }
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
  settings.clear();settings.set('aiUsage.claude.autoRotate.enabled',true);
  let release;manager.settingsQueue=new Promise(resolve=>{release=resolve;});
  const edited=manager.pushSettings({affectsConfiguration:key=>key==='aiUsage.claude.autoRotate.enabled'});
  manager.configRevision=8; // A competing configChanged arrives while the edit is queued.
  release();await edited;
  assert.deepEqual(calls,[{values:{'claude.autoRotate.enabled':true},baseRevision:7}]);
  assert.equal(persisted.claude.autoRotate.enabled,false);
  assert.equal(settings.get('aiUsage.claude.autoRotate.enabled'),false,'conflict reads and hydrates the winning value');
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
