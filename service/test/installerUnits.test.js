const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * The installer drives systemctl, loginctl, launchctl, reg and wscript.exe. Here they are shell scripts in a temporary
 * directory at the front of PATH that record their arguments, so no real service manager is ever touched; the platform
 * is switched through process.platform to reach the macOS and Windows branches on any host. XDG_CONFIG_HOME and HOME
 * point into the temporary root too, so the unit file, the plist and the launchers land there.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-units-'));
const fake = path.join(root, 'fake');
const calls = path.join(root, 'calls.log');
fs.mkdirSync(fake, { recursive: true });
const originals = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, NVM_DIR: process.env.NVM_DIR, AI_USAGE_NODE: process.env.AI_USAGE_NODE };
const realPlatform = process.platform;
const configHome = path.join(root, 'home dir', 'cfg');
process.env.HOME = path.join(root, 'home dir');
process.env.XDG_CONFIG_HOME = configHome;
process.env.NVM_DIR = path.join(root, 'no-nvm');
delete process.env.AI_USAGE_NODE;

/** A recording tool: appends "name args" to the call log; `exit.<name>.<md5 of the arguments>` makes that call fail with its content as stderr. */
function fakeTool(name) {
  const file = path.join(fake, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${calls}"\nkey="${name}.$(printf %s "$*" | md5sum | cut -c1-12)"\nif [ -f "${fake}/exit.$key" ]; then cat "${fake}/exit.$key" >&2; exit 1; fi\nif [ -f "${fake}/out.$key" ]; then cat "${fake}/out.$key"; fi\nexit 0\n`, { mode: 0o755 });
}
for (const name of ['systemctl', 'loginctl', 'launchctl', 'reg', 'wscript.exe']) { fakeTool(name); }
// A stand-in node for the detached start: records its arguments and AI_USAGE_HOME, then exits.
const fakeNode = path.join(fake, 'fake-node');
fs.writeFileSync(fakeNode, `#!/bin/sh\necho "node $* HOME=$AI_USAGE_HOME" >> "${calls}"\nexit 0\n`, { mode: 0o755 });
process.env.PATH = `${fake}${path.delimiter}${originals.PATH}`;

const callKey = (name, args) => `${name}.${require('node:crypto').createHash('md5').update(args).digest('hex').slice(0, 12)}`;
const failing = (name, args, stderr = 'boom') => fs.writeFileSync(path.join(fake, `exit.${callKey(name, args)}`), stderr);
const resetFake = () => {
  for (const entry of fs.readdirSync(fake)) { if (/^(exit|out)\./.test(entry)) { fs.rmSync(path.join(fake, entry)); } }
  fs.rmSync(calls, { force: true });
};
const callLog = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);
const setPlatform = (value) => Object.defineProperty(process, 'platform', { value, configurable: true });

/** A fresh module instance: the installer caches whether systemd answers, so each availability needs its own. */
function load() {
  for (const key of Object.keys(require.cache)) { if (key.includes(`${path.sep}service${path.sep}out${path.sep}installer.js`)) { delete require.cache[key]; } }
  return require('../out/installer');
}

test.afterEach(() => { setPlatform(realPlatform); resetFake(); });
test.after(() => {
  setPlatform(realPlatform);
  for (const [key, value] of Object.entries(originals)) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
  fs.rmSync(root, { recursive: true, force: true });
});

const sourcePackage = () => {
  const dir = fs.mkdtempSync(path.join(root, 'pkg-'));
  fs.mkdirSync(path.join(dir, 'bin')); fs.mkdirSync(path.join(dir, 'out', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '9.8.7' }));
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
  fs.writeFileSync(path.join(dir, 'bin', 'ai-usage.js'), '// bin');
  fs.writeFileSync(path.join(dir, 'out', 'cli.js'), '// cli');
  fs.writeFileSync(path.join(dir, 'out', 'sub', 'deep.js'), '// deep');
  return dir;
};
const nodeChoice = (over = {}) => ({ command: fakeNode, args: [], env: {}, version: '22.1.0', source: 'test', ...over });
const newHome = (name = 'ai usage ünï') => { const home = path.join(root, `h-${Math.random().toString(16).slice(2)}`, name); fs.mkdirSync(home, { recursive: true }); return home; };

test('systemd unit: exact text with quoting for spaces, quotes, backslashes and unicode', () => {
  const { systemdUnitText } = load();
  const home = '/home/Zoë/my "ai" usage';
  const text = systemdUnitText(home, { command: '/opt/My Node/bin/node', args: ['--max-old-space-size=256'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(text, [
    '[Unit]', 'Description=AI Usage account service (Claude Code and Codex profiles, keep-alives and rotation)', 'After=network-online.target', 'StartLimitIntervalSec=0', '',
    '[Service]', 'Type=simple',
    'ExecStart="/opt/My Node/bin/node" "--max-old-space-size=256" "/home/Zoë/my \\"ai\\" usage/service/launch.js" "daemon"',
    'Restart=on-failure', 'RestartSec=5',
    'Environment="ELECTRON_RUN_AS_NODE=1"', 'Environment="AI_USAGE_HOME=/home/Zoë/my \\"ai\\" usage"', '',
    '[Install]', 'WantedBy=default.target', ''
  ].join('\n'));
  assert.match(systemdUnitText('C:\\x', { command: 'n', args: [], env: {} }), /Environment="AI_USAGE_HOME=C:\\\\x"/, 'backslashes are doubled');
});

test('launchd plist: exact structure, XML escaping, restart only after a crash, log path in the home', () => {
  const { launchdPlistText } = load();
  const previous = process.env.PATH;
  process.env.PATH = '/a&b:/c<d';
  try {
    const text = launchdPlistText('/Users/u/App & Data', { command: '/usr/local/bin/node', args: ['--flag'], env: { K: '<v>' } });
    assert.equal(text, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">', '<dict>',
      '  <key>Label</key>\n  <string>com.p0l0us.ai-usage</string>',
      '  <key>ProgramArguments</key>\n  <array>\n    <string>/usr/local/bin/node</string>\n    <string>--flag</string>\n    <string>/Users/u/App &amp; Data/service/launch.js</string>\n    <string>daemon</string>\n  </array>',
      '  <key>EnvironmentVariables</key>\n  <dict>\n    <key>K</key>\n    <string>&lt;v&gt;</string>\n    <key>AI_USAGE_HOME</key>\n    <string>/Users/u/App &amp; Data</string>\n    <key>PATH</key>\n    <string>/a&amp;b:/c&lt;d</string>\n  </dict>',
      '  <key>RunAtLoad</key>\n  <true/>',
      '  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>',
      '  <key>StandardOutPath</key>\n  <string>/Users/u/App &amp; Data/launchd.log</string>',
      '  <key>StandardErrorPath</key>\n  <string>/Users/u/App &amp; Data/launchd.log</string>',
      '</dict>', '</plist>', ''
    ].join('\n'));
    delete process.env.PATH;
    assert.match(launchdPlistText('/h', { command: 'n', args: [], env: {} }), /<key>PATH<\/key>\n    <string>\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/, 'a default PATH when none is set');
  } finally { process.env.PATH = previous; }
});

test('windows launcher script: quotes only what needs it, doubles VBScript quotes, sets the environment', () => {
  const { windowsLauncherText } = load();
  const text = windowsLauncherText('C:\\Users\\Zoë\\.ai-usage', { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['--x'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(text, [
    'Set shell = CreateObject("WScript.Shell")', 'Set env = shell.Environment("PROCESS")',
    'env("ELECTRON_RUN_AS_NODE") = "1"\r\nenv("AI_USAGE_HOME") = "C:\\Users\\Zoë\\.ai-usage"',
    'shell.Run """C:\\Program Files\\nodejs\\node.exe"" --x ""C:\\Users\\Zoë\\.ai-usage/service/launch.js"" daemon", 0, False', ''
  ].join('\r\n'));
  // A node without spaces stays unquoted; a quote inside a value is doubled for VBScript.
  assert.match(windowsLauncherText('C:\\h', { command: 'C:\\node.exe', args: [], env: { Q: 'a"b' } }), /env\("Q"\) = "a""b"\r\n/);
  assert.match(windowsLauncherText('C:\\h', { command: 'C:\\node.exe', args: [], env: {} }), /shell.Run "C:\\node.exe ""/);
});

test('launcher and install paths: the launcher is ai-usage, or ai-usage.cmd on Windows', () => {
  const installer = load();
  assert.equal(installer.launcherPath('/h'), path.join('/h', 'bin', 'ai-usage'));
  setPlatform('win32');
  assert.equal(installer.launcherPath('/h'), path.join('/h', 'bin', 'ai-usage.cmd'));
});

test('autostartKind follows the platform; systemd needs a user manager that answers', () => {
  let installer = load();
  assert.equal(installer.autostartKind(), 'systemd');
  assert.ok(callLog().some((line) => line === 'systemctl --user show-environment'));
  failing('systemctl', '--user show-environment');
  installer = load();
  assert.equal(installer.autostartKind(), 'none', 'systemctl present but no user manager');
  setPlatform('darwin'); assert.equal(installer.autostartKind(), 'launchd');
  setPlatform('win32'); assert.equal(installer.autostartKind(), 'windows');
  setPlatform('freebsd'); assert.equal(installer.autostartKind(), 'none');
});

test('Linux: install writes the unit, reloads, enables, enables lingering, and reinstalling is idempotent', () => {
  const installer = load();
  const home = newHome();
  const source = sourcePackage();
  const logs = [];
  const first = installer.installService({ home, sourceDir: source, node: nodeChoice(), log: (line) => logs.push(line) });
  assert.equal(first.version, '9.8.7');
  assert.equal(first.dir, path.join(home, 'service', '9.8.7'));
  assert.equal(first.autostart.kind, 'systemd');
  assert.equal(first.autostart.ok, true);
  assert.equal(first.autostart.detail, 'systemd user unit ai-usage.service');
  const unitFile = path.join(configHome, 'systemd', 'user', 'ai-usage.service');
  const unit = fs.readFileSync(unitFile, 'utf8');
  assert.equal(unit, installer.systemdUnitText(home, { command: fakeNode, args: [], env: {} }));
  assert.ok(unit.includes(`AI_USAGE_HOME=${home}`), 'home with spaces and unicode survives');
  assert.deepEqual(callLog().filter((line) => !line.includes('show-environment')), ['systemctl --user daemon-reload', 'systemctl --user enable ai-usage.service', 'loginctl enable-linger']);
  assert.ok(logs.some((line) => line.includes(', lingering enabled')));
  assert.ok(logs.some((line) => line.startsWith('installed the account service 9.8.7')));
  // Copied: package.json, README, bin, nested out/.
  for (const file of ['package.json', 'README.md', 'bin/ai-usage.js', 'out/cli.js', 'out/sub/deep.js']) { assert.ok(fs.existsSync(path.join(first.dir, file)), file); }
  assert.equal(fs.readFileSync(path.join(home, 'service', 'launch.js'), 'utf8'), installer.launchScriptText());
  const current = JSON.parse(fs.readFileSync(path.join(home, 'service', 'current.json'), 'utf8'));
  assert.deepEqual({ version: current.version, dir: current.dir, node: current.node }, { version: '9.8.7', dir: first.dir, node: { command: fakeNode, args: [], env: {} } });
  const launcher = fs.readFileSync(first.launcher, 'utf8');
  assert.equal(launcher, ['#!/bin/sh', `export AI_USAGE_HOME='${home}'`, `exec '${fakeNode}' '${path.join(home, 'service', 'launch.js')}' "$@"`, ''].join('\n'));
  assert.equal(fs.statSync(first.launcher).mode & 0o777, 0o755);
  // Reinstall: a stale file in the version directory goes, the result is the same and the unit is rewritten unchanged.
  fs.writeFileSync(path.join(first.dir, 'stale.js'), 'x');
  const second = installer.installService({ home, sourceDir: source, node: nodeChoice(), autostart: true });
  assert.equal(second.dir, first.dir);
  assert.ok(!fs.existsSync(path.join(first.dir, 'stale.js')));
  assert.equal(fs.readFileSync(unitFile, 'utf8'), unit);
  assert.equal(installer.readCurrentInstall(home).version, '9.8.7');
});

test('Linux: a service with a quote and a single quote in the node path gets a safe launcher', () => {
  const installer = load();
  const home = newHome();
  const node = path.join(root, "it's node");
  fs.copyFileSync(fakeNode, node); fs.chmodSync(node, 0o755);
  const result = installer.installService({ home, sourceDir: sourcePackage(), node: nodeChoice({ command: node }), autostart: false });
  assert.match(fs.readFileSync(result.launcher, 'utf8'), /exec '.*it'\\''s node' '/);
});

test('Linux: failing systemctl and loginctl steps are reported with their reasons', () => {
  const installer = load();
  const home = newHome();
  const node = { command: fakeNode, args: [], env: {} };
  failing('systemctl', '--user daemon-reload', 'Failed to connect to bus\n');
  let result = installer.registerAutostart(home, node);
  assert.deepEqual(result, { kind: 'systemd', ok: false, detail: 'systemctl --user daemon-reload failed: Failed to connect to bus' });
  resetFake(); failing('systemctl', '--user enable ai-usage.service', 'no such unit');
  result = installer.registerAutostart(home, node);
  assert.deepEqual(result, { kind: 'systemd', ok: false, detail: 'systemctl --user enable failed: no such unit' });
  resetFake(); failing('loginctl', 'enable-linger', 'Interactive authentication required.');
  const logs = [];
  result = installer.registerAutostart(home, node, (line) => logs.push(line));
  assert.equal(result.ok, true);
  assert.match(result.detail, /run "loginctl enable-linger" to keep it running after you log out/);
  assert.match(logs[0], /loginctl enable-linger failed: Interactive authentication required\./);
  // An unwritable unit directory comes back as a failed step rather than an exception.
  fs.rmSync(path.join(configHome, 'systemd'), { recursive: true, force: true });
  fs.mkdirSync(configHome, { recursive: true }); fs.writeFileSync(path.join(configHome, 'systemd'), 'a file, not a directory');
  result = installer.registerAutostart(home, node);
  assert.equal(result.ok, false);
  assert.match(result.detail, /ENOTDIR|EEXIST/);
  fs.rmSync(path.join(configHome, 'systemd'));
});

test('Linux without a systemd user manager: install succeeds, autostart is none with an explanation', () => {
  failing('systemctl', '--user show-environment');
  const installer = load();
  const home = newHome();
  const result = installer.installService({ home, sourceDir: sourcePackage(), node: nodeChoice() });
  assert.equal(result.autostart.kind, 'none');
  assert.equal(result.autostart.ok, false);
  assert.match(result.autostart.detail, /no systemd user manager is available/);
  assert.ok(!fs.existsSync(path.join(configHome, 'systemd', 'user', 'ai-usage.service')) || !fs.readFileSync(path.join(configHome, 'systemd', 'user', 'ai-usage.service'), 'utf8').includes(home));
  const status = installer.serviceStatus(home);
  assert.deepEqual(status.autostart, { kind: 'none', registered: false, detail: 'no systemd user manager' });
  assert.equal(status.installed.version, '9.8.7');
  assert.equal(status.running, false);
  assert.equal(status.launcher, installer.launcherPath(home));
});

test('an unsupported platform reports that there is no autostart mechanism and status shows no detail', () => {
  const installer = load();
  setPlatform('freebsd');
  const result = installer.registerAutostart('/h', { command: 'n', args: [], env: {} });
  assert.deepEqual(result, { kind: 'none', ok: false, detail: 'no autostart mechanism for this platform' });
  assert.deepEqual(installer.unregisterAutostart('/h'), { ok: true, detail: 'nothing was registered' });
  assert.deepEqual(installer.serviceStatus(newHome()).autostart, { kind: 'none', registered: false, detail: undefined });
});

test('Linux: status reflects registration, start goes through systemd, stop also stops the unit, uninstall removes the unit and package but keeps data', async () => {
  const installer = load();
  const home = newHome();
  installer.installService({ home, sourceDir: sourcePackage(), node: nodeChoice() });
  assert.equal(installer.serviceStatus(home).autostart.registered, true);
  assert.equal(installer.serviceStatus(newHome()).autostart.registered, false, 'a unit for another home does not count');
  resetFake();
  assert.deepEqual(installer.startService(home), { ok: true, detail: 'started through systemd' });
  assert.deepEqual(callLog(), ['systemctl --user start ai-usage.service']);
  // When systemd refuses, the daemon is started detached from the install.
  failing('systemctl', '--user start ai-usage.service');
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'service-stopped'), '');
  assert.deepEqual(installer.startService(home), { ok: true, detail: 'started detached' });
  assert.equal(installer.serviceManuallyStopped(home), false, 'start clears the manual-stop marker');
  for (let attempt = 0; attempt < 40 && !callLog().some((line) => line.startsWith('node ')); attempt++) { await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.ok(callLog().includes(`node ${path.join(home, 'service', 'launch.js')} daemon HOME=${home}`), callLog().join('\n'));
  // Data files outlive the uninstall.
  fs.writeFileSync(path.join(home, 'profiles.json'), '{}');
  fs.writeFileSync(path.join(home, 'config.json'), '{}');
  resetFake();
  const logs = [];
  const result = await installer.uninstallService(home, (line) => logs.push(line));
  assert.deepEqual(result.autostart, { ok: true, detail: 'systemd user unit removed' });
  assert.equal(result.stopped.ok, true);
  assert.equal(result.stopped.detail, 'was not running');
  assert.ok(callLog().includes('systemctl --user stop ai-usage.service'));
  assert.ok(callLog().includes('systemctl --user disable --now ai-usage.service'));
  assert.ok(!fs.existsSync(path.join(configHome, 'systemd', 'user', 'ai-usage.service')));
  assert.ok(!fs.existsSync(path.join(home, 'service')) && !fs.existsSync(path.join(home, 'bin')));
  assert.ok(fs.existsSync(path.join(home, 'profiles.json')) && fs.existsSync(path.join(home, 'config.json')));
  assert.equal(installer.serviceManuallyStopped(home), true, 'uninstall leaves the stop marker so nothing restarts it');
  assert.ok(logs.some((line) => line.includes('profiles, configuration and readings were kept')));
  assert.equal(installer.readCurrentInstall(home), undefined);
  // A second uninstall has nothing registered any more.
  assert.deepEqual((await installer.uninstallService(home)).autostart, { ok: true, detail: 'nothing was registered' });
});

test('start without an installation fails, and does not clear the stop marker', () => {
  const installer = load();
  const home = newHome();
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'service-stopped'), '');
  assert.deepEqual(installer.startService(home), { ok: false, detail: 'the account service is not installed' });
  assert.equal(installer.serviceManuallyStopped(home), true);
});

test('stop: marks the service stopped, reports "was not running", and a stale service.json is not a running service', async () => {
  const installer = load();
  const home = newHome();
  assert.deepEqual(await installer.stopService(home, 50), { ok: true, detail: 'was not running' });
  assert.equal(installer.serviceManuallyStopped(home), true);
  installer.clearManualServiceStop(home);
  assert.equal(installer.serviceManuallyStopped(home), false);
  // service.json naming a process that does not exist.
  fs.writeFileSync(path.join(home, 'service.json'), JSON.stringify({ pid: 2 ** 22 + 12345, version: '1.0.0', startedAt: 'x', socket: path.join(home, 'nope.sock'), node: 'n', home }));
  assert.equal(installer.serviceStatus(home).running, false);
  assert.deepEqual(await installer.stopService(home, 50), { ok: true, detail: 'was not running' });
  // One naming this very process counts as running (pid and version come from the file), but nothing answers on the
  // socket, so stop gives up after the wait: a non-embedded process is only signaled when it is the same instance.
  fs.writeFileSync(path.join(home, 'service.json'), JSON.stringify({ pid: process.pid, version: '3.2.1', startedAt: 'x', socket: path.join(home, 'nope.sock'), node: 'n', home, mode: 'embedded' }));
  const status = installer.serviceStatus(home);
  assert.equal(status.running, true);
  assert.equal(status.pid, process.pid);
  assert.equal(status.runningVersion, '3.2.1');
  const stopped = await installer.stopService(home, 250);
  assert.deepEqual(stopped, { ok: false, detail: 'embedded account service did not stop' });
});

test('stop: a service.json that disappears while waiting counts as stopped', async () => {
  const installer = load();
  const home = newHome();
  fs.writeFileSync(path.join(home, 'service.json'), JSON.stringify({ pid: process.pid, version: '1', startedAt: 'x', socket: path.join(home, 'nope.sock'), node: 'n', home, instanceId: 'a' }));
  setTimeout(() => fs.rmSync(path.join(home, 'service.json')), 100);
  assert.deepEqual(await installer.stopService(home, 3000), { ok: true, detail: 'stopped' });
});

test('stop: a daemon that ignores the request is sent SIGTERM; one that survives is reported', async () => {
  const installer = load();
  const home = newHome();
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('up')"], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  try {
    fs.writeFileSync(path.join(home, 'service.json'), JSON.stringify({ pid: child.pid, version: '1', startedAt: 's', socket: path.join(home, 'nope.sock'), node: 'n', home }));
    assert.deepEqual(await installer.stopService(home, 250), { ok: false, detail: `process ${child.pid} did not stop` });
  } finally { child.kill('SIGKILL'); }
  const victim = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000); console.log('up')"], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => victim.stdout.once('data', resolve));
  const exited = new Promise((resolve) => victim.once('exit', resolve));
  try {
    fs.writeFileSync(path.join(home, 'service.json'), JSON.stringify({ pid: victim.pid, version: '1', startedAt: 's', socket: path.join(home, 'nope.sock'), node: 'n', home }));
    assert.deepEqual(await installer.stopService(home, 250), { ok: true, detail: 'stopped' });
    assert.equal(await exited, null, 'terminated by a signal');
  } finally { victim.kill('SIGKILL'); }
});

test('restart: stops, starts again from the install and prunes older versions; a failed stop is returned as is', async () => {
  const installer = load();
  const home = newHome();
  installer.installService({ home, sourceDir: sourcePackage(), node: nodeChoice() });
  fs.mkdirSync(path.join(home, 'service', '0.0.1'));
  resetFake();
  const result = await installer.restartService(home);
  assert.deepEqual(result, { ok: true, detail: 'started through systemd' });
  assert.deepEqual(callLog().filter((line) => line.startsWith('systemctl --user st')), ['systemctl --user stop ai-usage.service', 'systemctl --user start ai-usage.service']);
  assert.ok(!fs.existsSync(path.join(home, 'service', '0.0.1')));
  assert.equal(installer.serviceManuallyStopped(home), false);
  // An embedded service that does not stop makes the restart fail without starting another.
  fs.writeFileSync(path.join(home, 'service.json'), JSON.stringify({ pid: process.pid, version: '1', startedAt: 's', socket: path.join(home, 'nope.sock'), node: 'n', home, embedded: true }));
  resetFake();
  const stuck = await installer.restartService(home);
  assert.equal(stuck.ok, false);
  assert.ok(!callLog().includes('systemctl --user start ai-usage.service'));
});

test('macOS: install writes the plist and loads it; a failed bootstrap falls back to load, and both failing is reported', () => {
  const installer = load();
  setPlatform('darwin');
  const home = newHome();
  const uid = process.getuid();
  const result = installer.installService({ home, sourceDir: sourcePackage(), node: nodeChoice() });
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.p0l0us.ai-usage.plist');
  assert.deepEqual(result.autostart, { kind: 'launchd', ok: true, detail: 'launchd agent com.p0l0us.ai-usage' });
  assert.equal(fs.readFileSync(plist, 'utf8'), installer.launchdPlistText(home, { command: fakeNode, args: [], env: {} }));
  assert.deepEqual(callLog(), [`launchctl bootout gui/${uid}/com.p0l0us.ai-usage`, `launchctl bootstrap gui/${uid} ${plist}`]);
  assert.equal(installer.serviceStatus(home).autostart.registered, true);
  assert.equal(installer.serviceStatus(home).autostart.detail, undefined);
  resetFake(); failing('launchctl', `bootstrap gui/${uid} ${plist}`, 'bootstrap failed');
  assert.equal(installer.registerAutostart(home, { command: fakeNode, args: [], env: {} }).ok, true);
  assert.ok(callLog().includes(`launchctl load -w ${plist}`));
  failing('launchctl', `load -w ${plist}`, 'load failed');
  const both = installer.registerAutostart(home, { command: fakeNode, args: [], env: {} });
  assert.deepEqual(both, { kind: 'launchd', ok: false, detail: `launchctl could not load ${plist}: bootstrap failed` });
});

test('macOS: start uses kickstart, falls back to a detached start, and uninstall boots the agent out and removes the plist', async () => {
  const installer = load();
  setPlatform('darwin');
  const home = newHome();
  const uid = process.getuid();
  installer.installService({ home, sourceDir: sourcePackage(), node: nodeChoice() });
  resetFake();
  assert.deepEqual(installer.startService(home), { ok: true, detail: 'started through launchd' });
  assert.deepEqual(callLog(), [`launchctl kickstart gui/${uid}/com.p0l0us.ai-usage`]);
  failing('launchctl', `kickstart gui/${uid}/com.p0l0us.ai-usage`);
  assert.equal(installer.startService(home).detail, 'started detached');
  resetFake();
  const result = await installer.uninstallService(home);
  assert.deepEqual(result.autostart, { ok: true, detail: 'launchd agent removed' });
  assert.ok(callLog().includes(`launchctl bootout gui/${uid}/com.p0l0us.ai-usage`));
  assert.ok(!fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.p0l0us.ai-usage.plist')));
});

test('Windows: install writes the hidden launcher, the .cmd launcher and the Run key; start runs wscript; uninstall removes them', async () => {
  const installer = load();
  setPlatform('win32');
  const home = newHome();
  const run = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const node = nodeChoice({ env: { ELECTRON_RUN_AS_NODE: '1' } });
  const result = installer.installService({ home, sourceDir: sourcePackage(), node });
  const vbs = path.join(home, 'service', 'launch-hidden.vbs');
  assert.deepEqual(result.autostart, { kind: 'windows', ok: true, detail: 'Run registry key (starts at sign-in)' });
  assert.equal(fs.readFileSync(vbs, 'utf8'), installer.windowsLauncherText(home, { command: fakeNode, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }));
  assert.deepEqual(callLog(), [`reg add ${run} /v AIUsageAccountService /t REG_SZ /d wscript.exe //B "${vbs}" /f`]);
  assert.equal(result.launcher, path.join(home, 'bin', 'ai-usage.cmd'));
  assert.equal(fs.readFileSync(result.launcher, 'utf8'), ['@echo off', 'setlocal', `set "ELECTRON_RUN_AS_NODE=1"\r\nset "AI_USAGE_HOME=${home}"`, `"${fakeNode}" "${path.join(home, 'service', 'launch.js')}" %*`, ''].join('\r\n'));
  // Registered only when the Run value names this home's launcher.
  resetFake();
  assert.equal(installer.serviceStatus(home).autostart.registered, false, 'reg query printed nothing');
  fs.writeFileSync(path.join(fake, `out.${callKey('reg', `query ${run} /v AIUsageAccountService`)}`), `    AIUsageAccountService    REG_SZ    wscript.exe //B "${vbs.toUpperCase()}"\n`);
  assert.deepEqual(installer.serviceStatus(home).autostart, { kind: 'windows', registered: true, detail: undefined });
  resetFake();
  assert.deepEqual(installer.startService(home), { ok: true, detail: 'started hidden' });
  for (let attempt = 0; attempt < 40 && !callLog().some((line) => line.startsWith('wscript.exe')); attempt++) { await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.ok(callLog().includes(`wscript.exe //B ${vbs}`), callLog().join('\n'));
  resetFake();
  const gone = await installer.uninstallService(home);
  assert.deepEqual(gone.autostart, { ok: true, detail: 'Run registry value removed' });
  assert.ok(callLog().includes(`reg delete ${run} /v AIUsageAccountService /f`));
  assert.ok(!fs.existsSync(vbs));
  // Without the launcher script, start falls back to a detached node.
  assert.equal(installer.startService(home).ok, false, 'not installed any more');
});

test('Windows: a failing reg add is reported with its message', () => {
  const installer = load();
  setPlatform('win32');
  const home = newHome();
  fs.mkdirSync(path.join(home, 'service'), { recursive: true });
  failing('reg', `add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v AIUsageAccountService /t REG_SZ /d wscript.exe //B "${path.join(home, 'service', 'launch-hidden.vbs')}" /f`, 'Access is denied.\n');
  assert.deepEqual(installer.registerAutostart(home, { command: 'n', args: [], env: {} }), { kind: 'windows', ok: false, detail: 'could not add the Run registry value: Access is denied.' });
});

test('readCurrentInstall rejects a damaged or incomplete current.json and a directory without the package', () => {
  const { readCurrentInstall } = load();
  const home = newHome();
  const file = path.join(home, 'service', 'current.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assert.equal(readCurrentInstall(home), undefined, 'no file');
  fs.writeFileSync(file, '{not json');
  assert.equal(readCurrentInstall(home), undefined);
  fs.writeFileSync(file, JSON.stringify({ version: '1.0.0', dir: path.join(home, 'service', '1.0.0') }));
  assert.equal(readCurrentInstall(home), undefined, 'no node recorded');
  fs.writeFileSync(file, JSON.stringify({ version: '1.0.0', dir: path.join(home, 'service', '1.0.0'), node: { command: 'n', args: [], env: {} } }));
  assert.equal(readCurrentInstall(home), undefined, 'the package is missing');
  fs.mkdirSync(path.join(home, 'service', '1.0.0', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'service', '1.0.0', 'bin', 'ai-usage.js'), '');
  assert.equal(readCurrentInstall(home).version, '1.0.0');
  fs.writeFileSync(file, JSON.stringify({ version: 1, dir: 'x', node: {} }));
  assert.equal(readCurrentInstall(home), undefined, 'a non-string version');
});

test('install copies the bridge next to the package when the source has one, and defaults the version', () => {
  const installer = load();
  const home = newHome();
  const source = sourcePackage();
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'x' }));
  fs.mkdirSync(path.join(source, 'bridge', 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'bridge', 'src', 'cli.mjs'), '// bridge');
  fs.writeFileSync(path.join(source, 'bridge', 'package.json'), '{}');
  const result = installer.installService({ home, sourceDir: source, node: nodeChoice(), autostart: false });
  assert.equal(result.version, '0.0.0');
  assert.deepEqual(result.autostart, { kind: 'none', ok: false, detail: 'not requested' });
  assert.ok(fs.existsSync(path.join(result.dir, 'bridge', 'src', 'cli.mjs')));
  assert.ok(fs.existsSync(path.join(result.dir, 'bridge', 'package.json')));
});

test('pruneOldInstalls keeps only the current version and tolerates a missing install directory', () => {
  const installer = load();
  const home = newHome();
  installer.pruneOldInstalls(home);
  installer.installService({ home, sourceDir: sourcePackage(), node: nodeChoice(), autostart: false });
  fs.mkdirSync(path.join(home, 'service', '1.0.0'));
  fs.mkdirSync(path.join(home, 'service', '10.0.0'));
  installer.pruneOldInstalls(home);
  assert.deepEqual(fs.readdirSync(path.join(home, 'service')).sort(), ['9.8.7', 'current.json', 'launch.js']);
});

/** A node stand-in answering --version with the given text. */
function versionedNode(dir, name, banner, exitCode = 0) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = "1" ] && echo "electron-flag" >> "${calls}"\necho "${banner}"\nexit ${exitCode}\n`, { mode: 0o755 });
  return file;
}

test('findNode: AI_USAGE_NODE first, then PATH, then nvm newest first; too old or broken ones are skipped', () => {
  const installer = load();
  const lonely = path.join(root, 'lonely');
  process.env.PATH = lonely;
  try {
    const nvm = path.join(root, 'nvm');
    process.env.NVM_DIR = nvm;
    versionedNode(path.join(nvm, 'versions', 'node', 'v18.20.0', 'bin'), 'node', 'v18.20.0');
    const v22 = versionedNode(path.join(nvm, 'versions', 'node', 'v22.3.1', 'bin'), 'node', 'v22.3.1');
    versionedNode(path.join(nvm, 'versions', 'node', 'v9.0.0', 'bin'), 'node', 'v9.0.0');
    fs.mkdirSync(path.join(nvm, 'versions', 'node', 'notes'));
    const viaNvm = installer.findNode();
    assert.ok(viaNvm);
    // A real node in a known location may come before nvm on this host; only assert the nvm pick when it did.
    if (viaNvm.source === 'nvm') { assert.deepEqual(viaNvm, { command: v22, args: [], env: {}, version: '22.3.1', source: 'nvm' }); }
    const onPath = versionedNode(lonely, 'node', 'v20.1.2');
    assert.deepEqual(installer.findNode(), { command: onPath, args: [], env: {}, version: '20.1.2', source: 'PATH' });
    const configured = versionedNode(path.join(root, 'cfg-node'), 'my-node', 'v21.0.0');
    process.env.AI_USAGE_NODE = configured;
    assert.deepEqual(installer.findNode(), { command: configured, args: [], env: {}, version: '21.0.0', source: 'AI_USAGE_NODE' });
    // Too old, or not answering with a version, falls through to the next candidate.
    const old = versionedNode(path.join(root, 'old-node'), 'node', 'v16.0.0');
    process.env.AI_USAGE_NODE = old;
    assert.equal(installer.findNode().command, onPath);
    process.env.AI_USAGE_NODE = versionedNode(path.join(root, 'junk-node'), 'node', 'not a version', 1);
    assert.equal(installer.findNode().command, onPath);
    assert.equal(installer.findNode({ minMajor: 22 })?.command === onPath, false, 'a stricter minimum skips the PATH node');
  } finally { delete process.env.AI_USAGE_NODE; process.env.NVM_DIR = path.join(root, 'no-nvm'); process.env.PATH = `${fake}${path.delimiter}${originals.PATH}`; }
});

test('findNode: the VS Code runtime is used with ELECTRON_RUN_AS_NODE, the server runtime without', () => {
  const installer = load();
  const lonely = path.join(root, 'lonely-2');
  fs.mkdirSync(lonely, { recursive: true });
  process.env.PATH = lonely;
  try {
    // Known locations (/usr/bin/node …) may exist on the host and win; make the fallback the only candidate by asking for a version nothing else has.
    const electron = versionedNode(path.join(root, 'electron'), 'code', 'v99.1.0');
    const found = installer.findNode({ fallback: { execPath: electron, electron: true }, minMajor: 99 });
    assert.deepEqual(found, { command: electron, args: [], env: { ELECTRON_RUN_AS_NODE: '1' }, version: '99.1.0', source: 'the VS Code runtime' });
    assert.ok(callLog().includes('electron-flag'), 'the version probe ran with ELECTRON_RUN_AS_NODE set');
    const server = installer.findNode({ fallback: { execPath: electron, electron: false }, minMajor: 99 });
    assert.deepEqual(server, { command: electron, args: [], env: {}, version: '99.1.0', source: 'the VS Code server runtime' });
    assert.equal(installer.findNode({ fallback: { execPath: path.join(root, 'missing'), electron: false }, minMajor: 99 }), undefined);
  } finally { process.env.PATH = `${fake}${path.delimiter}${originals.PATH}`; }
});
