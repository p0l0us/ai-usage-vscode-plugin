const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findNode, installService, readCurrentInstall, systemdUnitText, launchdPlistText, windowsLauncherText, launchScriptText, startService, stopService, serviceStatus, pruneOldInstalls, launcherPath } = require('../out/installer');
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
});
