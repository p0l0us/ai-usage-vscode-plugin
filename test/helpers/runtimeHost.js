require('./fixtureNetwork');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { startServiceHost, ServiceClient, defaultConfig, saveConfig, configFileOf } = require('../../service/out');
const { hostOptions } = require('./runtimeHostOptions');

const fixtures = new Map();
const keys = ['HOME', 'AI_USAGE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'USERPROFILE', 'GH_TOKEN', 'GITHUB_TOKEN'];
exports.isolateHomes = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-parity-'));
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const env = { ...process.env };
  for (const [key, suffix] of Object.entries({ HOME: 'home', AI_USAGE_HOME: 'service', CODEX_HOME: 'codex', CLAUDE_CONFIG_DIR: 'claude' })) {
    env[key] = path.join(directory, suffix); fs.mkdirSync(env[key]); process.env[key] = env[key];
  }
  env.USERPROFILE = env.HOME; process.env.USERPROFILE = env.HOME;
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) { delete env[key]; delete process.env[key]; }
  const fixture = { directory, home: env.AI_USAGE_HOME, env, cleanups: [] };
  fixtures.set(env.HOME, fixture);
  t.after(async () => {
    try {
      for (const cleanup of fixture.cleanups.reverse()) await cleanup();
    } finally {
      fixtures.delete(env.HOME);
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  return fixture;
};
exports.registerCleanup = (t, env, cleanup) => {
  const fixture = fixtures.get(env.HOME);
  if (fixture) fixture.cleanups.push(cleanup); else t.after(cleanup);
};
exports.seedFixture = (home, env) => {
  const config = defaultConfig();
  config.bridge.autoStart = false; config.codex.autoReset.enabled = false;
  config.claude.keepAlive.enabled = false; config.codex.keepAlive.enabled = false;
  config.claude.autoRotate.enabled = false; config.codex.autoRotate.enabled = false;
  config.claude.api.minIntervalSeconds = 0;
  saveConfig(configFileOf(home), config);
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-claude', expiresAt: Date.now() + 86_400_000 }, unrelated: 'preserved' }));
  fs.writeFileSync(path.join(env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { access_token: 'synthetic-codex', account_id: 'fixture-account' }, unrelated: 'preserved' }));
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), '# Existing native settings\nmodel = "fixture"\n');
  exports.setFixture(home, {});
};
exports.setFixture = (home, values) => fs.writeFileSync(path.join(home, 'fixture.json'), JSON.stringify({ now: Date.now(), ...values }));
exports.childHost = async (t, home, env, mode) => {
  const child = fork(path.join(__dirname, 'runtimeHostChild.js'), [mode], { cwd: path.resolve(__dirname, '../..'), env: { ...env, AI_USAGE_HOME: home }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send('stop', () => {});
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
  };
  exports.registerCleanup(t, env, cleanup);
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture host startup timed out: ' + stderr)), 10_000);
    child.once('message', message => { clearTimeout(timer); resolve(message); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture host exited ${code}: ${stderr}`)); });
  });
  return { child, exited, ...message };
};
exports.runtimeFixture = async (t, mode) => {
  const fixture = exports.isolateHomes(t);
  exports.seedFixture(fixture.home, fixture.env);
  if (mode === 'background') {
    const owner = await exports.childHost(t, fixture.home, fixture.env, mode);
    if (owner.error) throw new Error(owner.error);
    fixture.owner = owner;
  } else {
    fixture.host = await startServiceHost(hostOptions(fixture.home, mode));
    fixture.cleanups.push(() => fixture.host.stop());
  }
  fixture.connect = async (name, folders = []) => {
    const client = await ServiceClient.connect({ home: fixture.home, client: name, folders, subscribe: 'all' });
    fixture.cleanups.push(() => client.close());
    return client;
  };
  fixture.client = await fixture.connect('parity-window-a');
  return fixture;
};
exports.hostOptions = hostOptions;
exports.eventually = async (predicate, message = 'Condition did not become true') => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
};
