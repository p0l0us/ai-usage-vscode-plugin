const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Every window shares these user settings, as VS Code does.
const settings = new Map();
const informationMessages = [];
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
      showErrorMessage: async () => undefined
    },
    commands: { executeCommand: async () => undefined },
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
  settings.set('aiUsage.accountService.background', false);
  const managers = [];
  t.after(() => {
    for (const manager of managers) { manager.dispose(); }
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
  assert.equal(client.info.profileStore, 'vscode');
  assert.deepEqual((await client.list('codex')).profiles.map((profile) => profile.name), ['Codex 1'], 'the profiles saved in VS Code are listed');
  assert.equal(fs.existsSync(path.join(root, 'home', 'profiles.json')), false, 'nothing is written to the service file');

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
  informationMessages.length = 0;
  const manager = new ServiceManager(windowContext(path.join(root, 'window')), () => {});
  t.after(() => {
    manager.dispose();
    if (previous === undefined) delete process.env.AI_USAGE_HOME; else process.env.AI_USAGE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.ok(await manager.ensure({ promptInstall: true }));
  assert.equal(manager.hosting, true);
  assert.equal(informationMessages.filter((message) => /run its account service in the background/.test(message)).length, 1);
  manager.dispose();
  assert.equal(fs.existsSync(path.join(root, 'home', 'service')), false, 'no service package was installed');
});
