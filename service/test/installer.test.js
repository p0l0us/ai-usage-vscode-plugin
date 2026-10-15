const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findNode, installService, readCurrentInstall, systemdUnitText, launchdPlistText, windowsLauncherText, launchScriptText, startService, stopService, serviceStatus, pruneOldInstalls, launcherPath, serviceManuallyStopped } = require('../out/installer');
const { pingService } = require('../out/client');
const { servicePackageDir } = require('../out/version');

const node = { command: '/usr/bin/node', args: [], env: { ELECTRON_RUN_AS_NODE: '1' } };

test('the autostart definitions name the launcher, the home and the runtime environment', () => {
  const unit = systemdUnitText('/home/u/.ai-usage', node);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/home\/u\/.ai-usage\/service\/launch.js" "daemon"/);
  assert.match(unit, /Environment="ELECTRON_RUN_AS_NODE=1"/);
  assert.match(unit, /Environment="AI_USAGE_HOME=\/home\/u\/.ai-usage"/);
  assert.match(unit, /WantedBy=default.target/);
  const plist = launchdPlistText('/Users/u/Library/Application Support/ai-usage', node);
  assert.match(plist, /<string>com.p0l0us.ai-usage<\/string>/);
  assert.match(plist, /<string>\/Users\/u\/Library\/Application Support\/ai-usage\/service\/launch.js<\/string>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  const vbs = windowsLauncherText('C:\\Users\\u\\.ai-usage', { command: 'C:\\Program Files\\nodejs\\node.exe', args: [], env: {} });
  assert.match(vbs, /shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\u\\.ai-usage[\\/]service[\\/]launch.js"" daemon", 0, False/);
  assert.match(vbs, /env\("AI_USAGE_HOME"\) = "C:\\Users\\u\\.ai-usage"/);
  assert.match(launchScriptText(), /require\('.\/current.json'\)/);
});

test('findNode accepts the fallback runtime when nothing is on PATH and rejects one that is too old', () => {
  const previous = process.env.PATH;
  process.env.PATH = '';
  try {
    const found = findNode({ fallback: { execPath: process.execPath, electron: false } });
    assert.ok(found, 'the test runtime itself qualifies');
    assert.equal(found.command, process.execPath);
    assert.equal(`v${found.version}`, process.version);
    assert.equal(findNode({ fallback: { execPath: process.execPath, electron: false }, minMajor: 999 }), undefined);
  } finally {
    process.env.PATH = previous;
  }
});

function installFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-reinstall-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { home: path.join(root, 'home'), sourceDir: servicePackageDir(),
    node: { command: process.execPath, args: [], env: {}, version: process.version.slice(1), source: 'test' }, autostart: false };
  return { root, options, installed: installService(options) };
}

test('the installed package can reinstall itself and keeps its bridge, license and launcher', t => {
  const { options, installed } = installFixture(t);
  const reinstalled = installService({ ...options, sourceDir: installed.dir });
  assert.equal(reinstalled.dir, installed.dir);
  for (const file of ['out/cli.js', 'out/index.d.ts', 'bridge/src/cli.mjs', 'LICENSE']) {
    assert.equal(fs.readFileSync(path.join(reinstalled.dir, file), 'utf8'), fs.readFileSync(path.join(servicePackageDir(), file), 'utf8'));
  }
  const result = require('node:child_process').spawnSync(process.execPath, [path.join(reinstalled.dir, 'bin/ai-usage.js'), '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), installed.version);
  assert.equal(readCurrentInstall(options.home).dir, installed.dir);
});

test('an incomplete replacement leaves the current install and launcher usable', t => {
  const { root, options, installed } = installFixture(t);
  const source = path.join(root, 'incomplete');
  fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(installed.dir, 'package.json'), path.join(source, 'package.json'));
  fs.writeFileSync(path.join(source, 'bin/ai-usage.js'), '// incomplete replacement');
  const before = fs.readFileSync(path.join(installed.dir, 'bin/ai-usage.js'), 'utf8');
  assert.throws(() => installService({ ...options, sourceDir: source }));
  assert.equal(fs.readFileSync(path.join(installed.dir, 'bin/ai-usage.js'), 'utf8'), before);
  assert.ok(fs.existsSync(path.join(installed.dir, 'out/cli.js')));
  assert.equal(readCurrentInstall(options.home).dir, installed.dir);
  assert.deepEqual(fs.readdirSync(path.dirname(installed.dir)).filter(name => name.startsWith('.install-')), []);
});

test('package versions cannot escape the service install directory', t => {
  const { root, options } = installFixture(t);
  const source = path.join(root, 'malformed');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '../../protected' }));
  const protectedFile = path.join(options.home, 'protected', 'keep');
  fs.mkdirSync(path.dirname(protectedFile)); fs.writeFileSync(protectedFile, 'preserved');
  assert.throws(() => installService({ ...options, sourceDir: source }), /Invalid service package version/);
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'preserved');
});

test('installing copies the package, writes the launchers, and the service starts and stops from the install', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-install-'));
  const home = path.join(root, 'home');
  const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  process.env.CODEX_HOME = path.join(root, 'codex');
  t.after(async () => {
    await stopService(home);
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const logs = [];
  const result = installService({ home, sourceDir: servicePackageDir(), node: { command: process.execPath, args: [], env: {}, version: process.version.slice(1), source: 'test' }, autostart: false, log: (line) => logs.push(line) });
  assert.equal(result.autostart.ok, false);
  assert.ok(fs.existsSync(path.join(result.dir, 'bin', 'ai-usage.js')));
  assert.ok(fs.existsSync(path.join(result.dir, 'out', 'cli.js')));
  assert.equal(readCurrentInstall(home).dir, result.dir);
  assert.equal(result.launcher, launcherPath(home));
  if (process.platform !== 'win32') { assert.ok(fs.statSync(result.launcher).mode & 0o100); }
  // An older install is pruned once a newer one is current.
  fs.mkdirSync(path.join(home, 'service', '0.0.1'));
  pruneOldInstalls(home);
  assert.ok(!fs.existsSync(path.join(home, 'service', '0.0.1')));
  assert.ok(fs.existsSync(result.dir));
  const started = startService(home);
  assert.equal(started.ok, true, started.detail);
  let info;
  for (let attempt = 0; attempt < 40 && !info; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    info = await pingService(home);
  }
  assert.ok(info, 'the installed service answered');
  assert.equal(info.version, result.version);
  const status = serviceStatus(home);
  assert.equal(status.running, true);
  assert.equal(status.installed.version, result.version);
  const stopped = await stopService(home);
  assert.equal(stopped.ok, true, stopped.detail);
  assert.equal(serviceStatus(home).running, false);
  assert.equal(serviceManuallyStopped(home), true);
  assert.equal(startService(home).ok, true);
  assert.equal(serviceManuallyStopped(home), false, 'an explicit start allows reconnection again');
});
