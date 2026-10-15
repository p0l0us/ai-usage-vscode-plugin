const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { main } = require('../out/cli');
const { startServiceHost } = require('../out/daemon');

/**
 * The command line against a real service host in this process, with the provider calls injected, so that every
 * command's output and exit code is exercised without a network, a vendor CLI or the real account service home.
 * A "stopped" home (the manual-stop marker) is how the not-running state is reached without spawning a daemon.
 */
const HOUR = 3_600_000;
const login = (token) => ({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: 9999999999999 } });
const usage = (provider, percents, now = Date.now()) => ({ provider, title: provider, fetchedAt: new Date(now),
  windows: percents.map((value, index) => ({ label: index ? '7d' : '5h', usedPercent: value, resetsAt: new Date(now + 3 * HOUR) })) });

const saved = {};
const keepEnv = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'NO_COLOR', 'AI_USAGE_NODE'];
for (const key of keepEnv) { saved[key] = process.env[key]; }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-clicmd-'));
const originalCwd = process.cwd();
const claudeHome = path.join(root, 'claude'); fs.mkdirSync(claudeHome);
const codexHome = path.join(root, 'codex'); fs.mkdirSync(codexHome);
process.env.CLAUDE_CONFIG_DIR = claudeHome;
process.env.CODEX_HOME = codexHome;
process.env.NO_COLOR = '1';
test.after(() => {
  process.chdir(originalCwd);
  for (const key of keepEnv) { if (saved[key] === undefined) { delete process.env[key]; } else { process.env[key] = saved[key]; } }
  fs.rmSync(root, { recursive: true, force: true });
});

let counter = 0;
const freshHome = () => { const home = path.join(root, `h${++counter}`); fs.mkdirSync(home, { recursive: true }); return home; };

/** Runs a command with its output captured. */
async function capture(args, home) {
  const out = [], err = [];
  const code = await main([...args, '--home', home], { stdout: (text) => out.push(String(text)), stderr: (text) => err.push(String(text)) });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/**
 * A running service. `behavior.percents[token]` is what that login reads; `behavior.keepAliveErrors[token]` makes its
 * keep-alive fail; `behavior.usageErrors[token]` makes its reading fail; `behavior.gate` holds probes until resolved.
 */
async function runningService(t, behavior = {}) {
  const home = freshHome();
  fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify(login('a')));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude: { enabled: false, keepAlive: { enabled: false }, autoRotate: { enabled: false } }, codex: { enabled: false, keepAlive: { enabled: false }, autoRotate: { enabled: false }, autoReset: { enabled: false } }, copilot: { enabled: false }, bridge: { autoStart: false } }));
  const probes = [];
  const percents = { a: [41, 7], b: [10, 5], c: [20, 6], ...behavior.percents };
  const host = await startServiceHost({
    home, version: 'cli-test', mode: 'background',
    engineOptions: {
      fetchUsage: async (provider) => ({ kind: 'ok', usage: usage(provider, [50, 5]) }),
      // The active account is read through the native login, with the values of the token the native file holds.
      readNativeUsage: async (provider) => {
        const token = JSON.parse(fs.readFileSync(path.join(claudeHome, '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken;
        const readings = percents[token];
        return readings && !behavior.usageErrors?.[token] ? { kind: 'ok', usage: usage(provider, readings) } : { kind: 'error', provider, title: provider, message: behavior.usageErrors?.[token] ?? 'Unavailable' };
      },
      identityOf: async (provider, credential) => ({ email: `${credential.claudeAiOauth?.accessToken}@example.com`, accountId: `acct-${credential.claudeAiOauth?.accessToken}` }),
      verifyCodex: async () => ({ status: 'match', detail: 'ok' }),
      syncClaudeMetadata: async (credential) => ({ status: 'synced', identity: { email: `${credential.claudeAiOauth.accessToken}@example.com`, accountId: `acct-${credential.claudeAiOauth.accessToken}` }, detail: 'synced' }),
      probe: async (provider, credential, settings, keepAlive) => {
        const token = credential.claudeAiOauth.accessToken;
        probes.push([token, keepAlive]);
        if (behavior.gate) { await behavior.gate(token); }
        const readings = percents[token];
        return {
          credential, keepAliveError: keepAlive ? behavior.keepAliveErrors?.[token] : undefined,
          result: readings && !behavior.usageErrors?.[token] ? { kind: 'ok', usage: usage(provider, readings) } : { kind: 'error', provider, title: provider, message: behavior.usageErrors?.[token] ?? 'Unavailable' }
        };
      }
    }
  });
  t.after(async () => { await host.stop('test over').catch(() => undefined); });
  const run = (...args) => capture(args, home);
  return { home, host, probes, run };
}

/** A home with the manual-stop marker: connecting fails at once with the stopped message instead of starting anything. */
function stoppedHome() {
  const home = freshHome();
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'service-stopped'), '');
  return home;
}

const credentialFile = (name, token) => { const file = path.join(root, name); fs.writeFileSync(file, JSON.stringify(login(token))); return file; };

test('help, version, the default command and unknown commands need no service', async () => {
  const home = freshHome();
  let result = await capture(['--help'], home);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^ai-usage – Claude Code and Codex account profiles, keep-alives and rotation\n\nUsage: ai-usage <command>/);
  assert.match(result.stdout, /history export readings\|events\|jsonl \[file\]/);
  assert.equal((await capture(['-h'], home)).stdout, result.stdout);
  assert.equal((await capture(['help'], home)).stdout, result.stdout);
  result = await capture(['--version'], home);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal((await capture(['-v'], home)).stdout, result.stdout);
  result = await capture(['frobnicate'], home);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^Unknown command "frobnicate"\.\n\nai-usage – /);
  assert.equal(result.stdout, '');
  // The live view needs a terminal; the tests run without one.
  result = await capture(['top'], home);
  assert.equal(result.code, 2);
  assert.equal(result.stderr, 'The live view needs a terminal; use "ai-usage status" instead.\n');
  assert.equal((await capture(['watch'], home)).code, 2);
  assert.equal((await capture(['live'], home)).code, 2);
});

test('service names are validated before anything connects', async () => {
  const home = stoppedHome();
  for (const args of [['list', 'gemini'], ['use'], ['use', 'gemini', 'x'], ['save'], ['rotate'], ['keepalive', 'copilot'], ['rotation-weights', 'gemini'], ['login'], ['delete', 'x'], ['rename'], ['move']]) {
    const result = await capture(args, home);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, /^Name the service: claude or codex/, args.join(' '));
  }
  assert.equal((await capture(['use', 'gemini', 'x'], home)).stderr, 'Name the service: claude or codex, not "gemini".\n');
  // Case and surrounding spaces do not matter, so this gets as far as the connection.
  const result = await capture(['use', ' CLAUDE ', 'x'], home);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /stopped manually/);
  // Missing arguments are usage errors, not connection attempts.
  for (const [args, message] of [
    [['use', 'claude'], 'Name the profile to activate: its name, number or id.\n'],
    [['rename', 'claude', 'a'], 'Usage: ai-usage rename <service> <profile> <new name>\n'],
    [['move', 'claude', 'a', 'sideways'], 'Usage: ai-usage move <service> <profile> up|down\n'],
    [['delete', 'claude'], 'Name the profile to delete.\n'],
    [['login', 'claude'], 'Name the profile to sign in for.\n'],
    [['import', 'claude'], 'Name the credential JSON file to import.\n'],
    [['import', 'claude', 'f.json'], 'Pass --name <profile name> for the imported login.\n'],
    [['import-profiles'], 'Name the profile export file to import.\n'],
    [['usage', 'gemini'], 'Choose claude, codex or copilot.\n']
  ]) {
    const missing = await capture(args, home);
    assert.deepEqual([missing.code, missing.stderr], [2, message], args.join(' '));
  }
});

test('without a running service: the stopped marker, no installation and service commands report plainly', async () => {
  const home = stoppedHome();
  for (const args of [['status'], ['list'], ['status', '--json'], ['config'], ['history'], ['rotate', 'claude']]) {
    const result = await capture(args, home);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '✗ The account service was stopped manually. Run "ai-usage service start" to resume it.\n');
  }
  let result = await capture(['service', 'status'], home);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, [`Home:       ${home}`, 'Installed:  no', 'Running:    no', result.stdout.split('\n')[3], 'Command:    not installed', ''].join('\n'));
  assert.match(result.stdout, /\nAutostart:  (none \(no systemd user manager\)|systemd, not registered|launchd, not registered|windows, not registered|none)\n/);
  result = await capture(['service', 'status', '--json'], home);
  const status = JSON.parse(result.stdout);
  assert.equal(status.home, home);
  assert.equal(status.running, false);
  assert.equal(status.installed, undefined);
  result = await capture(['service'], home);
  assert.match(result.stdout, /^Home: /, 'status is the default service action');
  result = await capture(['service', 'start'], home);
  assert.deepEqual([result.code, result.stdout], [1, '✗ the account service is not installed\n']);
  assert.equal(fs.existsSync(path.join(home, 'state', 'service-stopped')), true, 'a failed start leaves the marker');
  result = await capture(['service', 'restart'], home);
  assert.deepEqual([result.code, result.stdout], [1, '✗ the account service is not installed\n']);
  result = await capture(['service', 'stop'], home);
  assert.deepEqual([result.code, result.stdout], [0, '✓ was not running\n']);
  result = await capture(['service', 'path'], home);
  assert.equal(result.stdout, `${path.join(home, 'bin', 'ai-usage')}\n`);
  result = await capture(['service', 'wibble'], home);
  assert.deepEqual([result.code, result.stdout, result.stderr], [2, '', 'Unknown service action "wibble": use status, install, uninstall, start, stop, restart or run.\n']);
  // Uninstalling asks first, and without a terminal that means -y.
  result = await capture(['service', 'uninstall'], home);
  assert.deepEqual([result.code, result.stderr], [2, 'Stop the account service, unregister it and remove the installed package? Profiles and settings are kept. Pass -y to confirm without a prompt.\n']);
  // The daemon command honors the marker: a stopped service is not started again by a stray autostart.
  result = await capture(['daemon'], home);
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', '']);
});

test('log shows the tail of the service log, honors -n, and following needs a running service', async () => {
  const home = freshHome();
  assert.deepEqual(await capture(['log'], home), { code: 0, stdout: '', stderr: '' });
  fs.writeFileSync(path.join(home, 'service.log'), Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n') + '\n');
  let result = await capture(['log'], home);
  assert.equal(result.stdout.split('\n').filter(Boolean).length, 50);
  assert.match(result.stdout, /^line 31\n/);
  assert.match(result.stdout, /line 80\n$/);
  result = await capture(['logs', '-n', '2'], home);
  assert.equal(result.stdout, 'line 79\nline 80\n');
  result = await capture(['log', '--lines', 'many'], home);
  assert.equal(result.stdout.split('\n').filter(Boolean).length, 50, 'a non-numeric count falls back to 50');
  result = await capture(['log', '-f', '-n', '1'], home);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, 'line 80\n');
  assert.match(result.stderr, /^✗ /);
});

test('log -f streams new lines from a running service until interrupted', async (t) => {
  const { home, host } = await runningService(t);
  const out = [];
  const following = main(['log', '-f', '-n', '1', '--home', home], { stdout: (text) => out.push(text), stderr: () => undefined });
  for (let attempt = 0; attempt < 100 && !out.join('').includes('client connected: cli-log'); attempt++) { await new Promise((resolve) => setTimeout(resolve, 20)); }
  host.log('a line written while following');
  for (let attempt = 0; attempt < 100 && !out.join('').includes('a line written while following'); attempt++) { await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.ok(out.join('').includes('a line written while following\n'), out.join(''));
  process.emit('SIGINT');
  assert.equal(await following, 0);
});

test('status, list and the JSON forms against a running service', async (t) => {
  const { run } = await runningService(t);
  const credential = credentialFile('b.json', 'b');
  assert.equal((await run('save', 'claude', 'Work')).code, 0);
  assert.equal((await run('import', 'claude', credential, '--name', 'Backup')).code, 0);
  let result = await run('status');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^AI Usage account service cli-test · pid \d+ · up 0m · \d+ clients? · /);
  assert.match(result.stdout, /Claude  active: Work \(a@example.com\)  ·  keep-alive off  ·  rotation off/);
  assert.match(result.stdout, /1  Work +●  a@example.com/);
  assert.match(result.stdout, /2  Backup +b@example.com/);
  assert.match(result.stdout, /Codex  active: none/);
  assert.match(result.stdout, /no saved profiles/);
  // No service argument: the default command without a terminal is status.
  const bare = await run();
  assert.match(bare.stdout, /^AI Usage account service/);
  const json = JSON.parse((await run('status', '--json')).stdout);
  assert.deepEqual(Object.keys(json.providers).sort(), ['claude', 'codex']);
  assert.deepEqual(json.providers.claude.profiles.map((profile) => profile.name), ['Work', 'Backup']);
  result = await run('list', 'codex');
  assert.match(result.stdout, /^Codex {2}active: none {2}·.*\n {2}no saved profiles\n\n$/);
  result = await run('ls');
  assert.match(result.stdout, /Claude  active: Work[\s\S]*Codex  active: none/);
  const single = JSON.parse((await run('list', 'claude', '--json')).stdout);
  assert.equal(single.provider, 'claude', 'one service prints one view');
  assert.equal(single.profiles.length, 2);
  const both = JSON.parse((await run('list', '--json')).stdout);
  assert.ok(Array.isArray(both) && both.length === 2, 'no service prints both views');
});

test('use accepts a name, number, #number, email or id, and reports what it could not find', async (t) => {
  const { run } = await runningService(t);
  await run('save', 'claude', 'Work');
  await run('import', 'claude', credentialFile('b.json', 'b'), '--name', 'Backup');
  await run('import', 'claude', credentialFile('c.json', 'c'), '--name', 'Third account');
  const view = JSON.parse((await run('list', 'claude', '--json')).stdout);
  const idOf = (name) => view.profiles.find((profile) => profile.name === name).id;
  const activeAfter = async () => JSON.parse((await run('list', 'claude', '--json')).stdout).profiles.find((profile) => profile.active).name;
  for (const [ref, expected] of [['2', 'Backup'], ['#1', 'Work'], ['third account', 'Third account'], ['Backup', 'Backup'], [idOf('Work'), 'Work'], ['c@example.com', 'Third account']]) {
    const args = ref === 'third account' ? ['use', 'claude', 'third', 'account'] : ['use', 'claude', ref];
    const result = await run(...args);
    assert.equal(result.code, 0, `${ref}: ${result.stderr}${result.stdout}`);
    assert.match(result.stdout, new RegExp(`^✓ Claude switched to “${expected}”`), ref);
    assert.equal(await activeAfter(), expected, ref);
  }
  assert.equal((await run('switch', 'claude', '2')).code, 0);
  assert.equal((await run('activate', 'claude', '1')).code, 0);
  // Missing references come back as the service's own error on stderr, exit 1.
  for (const ref of ['nobody', '9', '#0']) {
    const result = await run('use', 'claude', ref);
    assert.equal(result.code, 1, ref);
    assert.equal(result.stdout, '', ref);
    assert.equal(result.stderr, `✗ No Claude profile matches "${ref}". Run "ai-usage list claude" to see them.\n`, ref);
    assert.equal(await activeAfter(), 'Work');
  }
  const json = JSON.parse((await run('use', 'claude', 'Backup', '--json')).stdout);
  assert.equal(json.level, 'info');
  assert.match(json.message, /switched to “Backup”/);
  const failed = await run('use', 'claude', 'nobody', '--json');
  assert.deepEqual([failed.code, failed.stdout], [1, ''], 'a missing profile is an error even with --json');
});

test('save: names, --update, duplicates need confirmation, JSON output', async (t) => {
  const { run } = await runningService(t);
  let result = await run('save', 'claude');
  assert.deepEqual([result.code, result.stderr], [2, 'Name the new profile, or pass --update <profile> to replace a saved one.\n']);
  result = await run('save', 'claude', 'Work');
  assert.deepEqual([result.code, result.stdout], [0, '✓ Claude login saved as “Work” (a@example.com).\n']);
  // The same login again is a duplicate: it is reported, and a copy needs a yes that a script cannot give interactively.
  result = await run('save', 'claude', 'Copy');
  assert.equal(result.code, 2);
  assert.match(result.stdout, /^! /);
  assert.match(result.stderr, /^Save a copy anyway\? Pass -y to confirm without a prompt\.\n$/);
  result = await run('save', 'claude', 'Copy', '-y');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^! [^\n]*\n✓ Claude login saved as “Copy” \(a@example\.com\)\.\n$/);
  result = await run('save', 'claude', 'Third', '--allow-duplicate', '--json');
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).profile.name, 'Third');
  // --name works for a name with words the shell would split; --update stores into an existing profile.
  result = await run('save', 'claude', '--update', 'copy');
  assert.deepEqual([result.code, result.stdout], [0, '✓ Claude login stored into “Copy” (a@example.com).\n']);
  result = await run('save', 'claude', '--update', 'nobody');
  assert.deepEqual([result.code, result.stderr], [2, 'No Claude profile matches "nobody".\n']);
  result = await run('save', 'claude', '--name', 'Fourth', '--allow-duplicate');
  assert.match(result.stdout, /saved as “Fourth”/);
});

test('import: from a file, with the name as a flag or an argument, duplicates and JSON output', async (t) => {
  const { run } = await runningService(t);
  const file = credentialFile('imp.json', 'b');
  let result = await run('import', 'claude', file, '--name', 'Backup');
  assert.deepEqual([result.code, result.stdout], [0, '✓ Claude credential imported as “Backup”. Activate it with: ai-usage use claude "Backup"\n']);
  result = await run('import', 'claude', file, 'Positional');
  assert.equal(result.code, 2, 'the same login again asks before saving a copy');
  assert.match(result.stdout, /^! /);
  result = await run('import', 'claude', file, 'Positional', '-y');
  assert.match(result.stdout, /imported as “Positional”/);
  result = await run('import', 'claude', file, '--name', 'Json', '--allow-duplicate', '--json');
  assert.equal(JSON.parse(result.stdout).profile.name, 'Json');
  fs.writeFileSync(path.join(root, 'broken.json'), '{not json');
  result = await run('import', 'claude', path.join(root, 'broken.json'), '--name', 'X');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^✗ .*JSON/);
  result = await run('import', 'claude', path.join(root, 'missing.json'), '--name', 'X');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT/);
});

test('rename, move and delete resolve profiles like use does and confirm destructive steps', async (t) => {
  const { run } = await runningService(t);
  await run('save', 'claude', 'Work');
  await run('import', 'claude', credentialFile('b.json', 'b'), '--name', 'Backup');
  await run('import', 'claude', credentialFile('c.json', 'c'), '--name', 'Third');
  const names = async () => JSON.parse((await run('list', 'claude', '--json')).stdout).profiles.map((profile) => profile.name);
  let result = await run('rename', 'claude', '2', 'Spare', 'one');
  assert.deepEqual([result.code, result.stdout], [0, '✓ Renamed to “Spare one”.\n']);
  assert.equal(JSON.parse((await run('rename', 'claude', 'Third', 'Last', '--json')).stdout).name, 'Last');
  result = await run('rename', 'claude', 'nobody', 'X');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^✗ /);
  result = await run('move', 'claude', 'Last', 'up');
  assert.deepEqual([result.code, result.stdout], [0, '✓ Moved “Last” up.\n']);
  assert.deepEqual(await names(), ['Work', 'Last', 'Spare one']);
  result = await run('move', 'claude', '1', 'down');
  assert.equal(result.stdout, '✓ Moved “Work” down.\n');
  assert.deepEqual(await names(), ['Last', 'Work', 'Spare one']);
  const moved = JSON.parse((await run('move', 'claude', 'Work', 'up', '--json')).stdout);
  assert.deepEqual(moved.map((profile) => profile.name), ['Work', 'Last', 'Spare one']);
  result = await run('move', 'claude', 'nobody', 'up');
  assert.deepEqual([result.code, result.stderr], [2, 'No Claude profile matches "nobody".\n']);
  // Delete: without -y a script cannot answer, so nothing is deleted; the active profile's warning is part of the question.
  result = await run('delete', 'claude', 'Work');
  assert.equal(result.code, 2);
  assert.equal(result.stderr, 'Delete the saved Claude profile “Work”? The native login remains active until you switch or sign out. Pass -y to confirm without a prompt.\n');
  result = await run('rm', 'claude', 'spare one');
  assert.equal(result.stderr, 'Delete the saved Claude profile “Spare one”? Pass -y to confirm without a prompt.\n');
  assert.deepEqual(await names(), ['Work', 'Last', 'Spare one']);
  result = await run('delete', 'claude', 'Spare', 'one', '-y');
  assert.deepEqual([result.code, result.stdout], [0, '✓ Deleted “Spare one”.\n']);
  assert.equal(JSON.parse((await run('remove', 'claude', '2', '-y', '--json')).stdout).profile.name, 'Last');
  result = await run('delete', 'claude', 'nobody', '-y');
  assert.deepEqual([result.code, result.stderr], [2, 'No Claude profile matches "nobody".\n']);
  assert.deepEqual(await names(), ['Work']);
});

test('keepalive: one account, the failure and unreadable-usage lines, and the sweep with its progress on stderr', async (t) => {
  const { run, probes } = await runningService(t, { keepAliveErrors: { b: 'Keep-alive CLI exited with code 1: Insufficient credits' }, usageErrors: { c: 'Request failed' }, percents: { a: [96, 82] } });
  await run('save', 'claude', 'Work');
  await run('import', 'claude', credentialFile('b.json', 'b'), '--name', 'Backup');
  await run('import', 'claude', credentialFile('c.json', 'c'), '--name', 'Third');
  // Work is the active login: it is never kept alive, and the command says why.
  let result = await run('keepalive', 'claude', 'Work');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^✗ Claude keep-alive for “Work” not sent: .*is the active login/);
  assert.ok(!probes.some(([token, keepAlive]) => token === 'a' && keepAlive), 'no keep-alive prompt went to the active login');
  result = await run('ka', 'claude', 'Backup');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^✗ Claude keep-alive failed for “Backup”: .*[Ii]nsufficient credits.* Usage statistics were still updated\.\n$/);
  result = await run('keep-alive', 'claude', 'Third');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^! Claude keep-alive completed for “Third”, but usage could not be read: Network error\. The service could not be reached\./);
  result = await run('keepalive', 'claude', 'nobody');
  assert.deepEqual([result.code, result.stderr], [2, 'No Claude profile matches "nobody".\n']);
  // Several accounts: all but the active login with --all, progress on stderr, results in order on stdout, failures counted.
  result = await run('keepalive', 'claude', '--all');
  assert.equal(result.code, 1, 'a failing account makes the sweep fail');
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^✗ .*“Backup”/);
  assert.match(lines[1], /^! .*“Third”/);
  // Without a name or --all and with several accounts, a script has to say yes.
  result = await run('keepalive', 'claude');
  assert.deepEqual([result.code, result.stderr], [2, 'Send the keep-alive to all 2 Claude accounts? Pass -y to confirm without a prompt.\n']);
  result = await run('keepalive', 'claude', '-y');
  assert.equal(result.stdout.trim().split('\n').length, 2);
  result = await run('keepalive', 'codex');
  assert.deepEqual([result.code, result.stderr], [2, 'No Codex profiles are saved.\n']);
});

// The keepalive command subscribes to the progress events so the sweep is reported while it runs.
test('keepalive: the sweep reports its progress on stderr', async (t) => {
  const { run } = await runningService(t);
  await run('save', 'claude', 'Work');
  await run('import', 'claude', credentialFile('b.json', 'b'), '--name', 'Backup');
  await run('import', 'claude', credentialFile('c.json', 'c'), '--name', 'Third');
  const result = await run('keepalive', 'claude', '--all');
  assert.match(result.stderr, /1\/2: “Backup”…\n.*2\/2: “Third”…\n/s);
});

test('keepalive: a successful sweep exits 0, and Ctrl-C cancels the rest with a "cancelled" line', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const gated = { current: false };
  const { run, probes } = await runningService(t, { percents: { d: [30, 8] }, gate: async (token) => { if (gated.current && token === 'c') { await gate; } } });
  await run('save', 'claude', 'Work');
  await run('import', 'claude', credentialFile('b.json', 'b'), '--name', 'Backup');
  await run('import', 'claude', credentialFile('c.json', 'c'), '--name', 'Third');
  await run('import', 'claude', credentialFile('d.json', 'd'), '--name', 'Fourth');
  // Work, the active login, is left out: three others.
  let result = await run('keepalive', 'claude', '--all');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('✓')).length, 3);
  // A single account whose check fails outright (a rejected request) is reported as not sent.
  gated.current = true;
  const before = probes.length;
  const sweep = run('keepalive', 'claude', '--all');
  for (let attempt = 0; attempt < 500 && probes.length < before + 2; attempt++) { await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.equal(probes.length, before + 2, 'the sweep is held at the second account');
  process.emit('SIGINT');
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  result = await sweep;
  assert.equal(result.code, 1);
  assert.match(result.stdout, /✓ Claude keep-alive completed for “Backup”/);
  assert.match(result.stdout, /! \d of 3 not sent: cancelled\.\n$/);
  assert.ok(probes.length < before + 3, 'the third account was never probed');
});

test('rotate reports a switch or why there was none', async (t) => {
  const { run } = await runningService(t, { percents: { a: [99, 50], b: [5, 5] } });
  await run('save', 'claude', 'Work');
  await run('import', 'claude', credentialFile('b.json', 'b'), '--name', 'Backup');
  await run('keepalive', 'claude', '--all');
  let result = await run('rotate', 'claude');
  assert.deepEqual([result.code, result.stdout], [0, '✓ Claude rotated to “Backup”.\n']);
  assert.equal(JSON.parse((await run('list', 'claude', '--json')).stdout).profiles.find((profile) => profile.active).name, 'Backup');
  result = await run('rotate', 'claude');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^– Claude not rotated: .+\.\n$/);
  result = await run('rotate', 'claude', '--json');
  const json = JSON.parse(result.stdout);
  assert.equal(json.switched, false);
  assert.equal(typeof json.reason, 'string');
  result = await run('rotate', 'codex');
  assert.match(result.stdout, /^– Codex not rotated: /);
});

test('export and import-profiles: file, stdout, provider filter, nothing to export, plans and --replace', async (t) => {
  const { run } = await runningService(t);
  await run('save', 'claude', 'Work');
  await run('import', 'claude', credentialFile('b.json', 'b'), '--name', 'Backup');
  const file = path.join(root, `export-${counter}.json`);
  let result = await run('export', file);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^✓ Exported 2 profiles to .*export-\d+\.json\. The file holds login tokens in plain text: import it on the other computer, then delete it\.\n$/);
  if (process.platform !== 'win32') { assert.equal(fs.statSync(file).mode & 0o777, 0o600); }
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(exported.profiles.map((profile) => profile.name).sort(), ['Backup', 'Work']);
  result = await run('export', '--provider', 'claude', '-');
  assert.equal(JSON.parse(result.stdout).profiles.length, 2);
  result = await run('export', '-', '--provider', 'codex');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^! Nothing to export/);
  result = await run('export', '-', '--provider', 'bogus');
  assert.equal(result.code, 2);
  // Importing into the service that already has them: nothing new, so nothing to do; --json shows the plans.
  result = await run('import-profiles', file);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Service +Profile +Email +Outcome[\s\S]*skip[\s\S]*! Nothing to import/);
  const plans = JSON.parse((await run('import-profiles', file, '--json')).stdout);
  assert.equal(plans.length, 2);
  assert.ok(plans.every((plan) => plan.suggested === false));
  // After deleting one, it is suggested; a script has to confirm.
  await run('delete', 'claude', 'Backup', '-y');
  result = await run('import-profiles', file);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /Backup[\s\S]*import/);
  assert.equal(result.stderr, 'Import 1 profile? Nothing is activated. Pass -y to confirm without a prompt.\n');
  result = await run('import-profiles', file, '-y', '--json');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.slice(result.stdout.search(/^\{/m))).imported, 1);
  // A differing login is only replaced with --replace.
  const changed = JSON.parse(JSON.stringify(exported));
  const backup = changed.profiles.find((profile) => profile.name === 'Backup');
  const credential = backup.credential ?? backup.login;
  assert.ok(credential, JSON.stringify(Object.keys(backup)));
  const text = JSON.stringify(changed).replace('"accessToken":"b"', '"accessToken":"b2"').replace(/"refreshToken":"r-b"/, '"refreshToken":"r-b2"');
  const changedFile = path.join(root, `changed-${counter}.json`);
  fs.writeFileSync(changedFile, text);
  result = await run('import-profiles', changedFile);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /\(pass --replace to replace differing logins\)/);
  result = await run('import-profiles', changedFile, '--replace', '-y');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ Imported 1: .*Nothing was activated\./);
  assert.equal(JSON.parse((await run('export', '-')).stdout).profiles.find((profile) => profile.name === 'Backup').auth?.claudeAiOauth?.accessToken ?? JSON.stringify(JSON.parse((await run('export', '-')).stdout)).includes('b2'), true);
  result = await run('import-profiles', path.join(root, 'nope.json'));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT/);
});

test('usage, rotation-weights and the config command', async (t) => {
  const { run } = await runningService(t);
  await run('save', 'claude', 'Work');
  let result = await run('usage', 'claude');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.provider ?? 'claude', 'claude');
  assert.ok(Array.isArray(JSON.parse((await run('usage')).stdout)), 'no service argument reads all three');
  result = await run('rotation-weights', 'claude');
  assert.equal(JSON.parse(result.stdout).candidates[0].name, 'Work');
  result = await run('rotation-weights', 'gemini');
  assert.deepEqual([result.code, result.stderr], [2, 'Name the service: claude or codex, not "gemini".\n']);
  // config: list, get, set (also as get/set commands), coercion of values, JSON forms.
  result = await run('config');
  assert.match(result.stdout, /^ {2}Setting +Value[^\n]*\n/);
  assert.match(result.stdout, /claude\.autoRotate\.strategy +leastWaste +How the next account is chosen\./);
  assert.equal(JSON.parse((await run('config', '--json')).stdout).claude.autoRotate.strategy, 'leastWaste');
  assert.equal((await run('config', 'list')).stdout, result.stdout);
  result = await run('config', 'claude.autoRotate.strategy');
  assert.equal(result.stdout, 'claude.autoRotate.strategy = leastWaste\n');
  result = await run('get', 'claude.autoRotate.strategy', '--json');
  assert.equal(result.stdout, '"leastWaste"\n');
  result = await run('config', 'get', 'claude.keepAlive.periodHours');
  assert.equal(result.stdout, 'claude.keepAlive.periodHours = 2\n');
  result = await run('config', 'claude.keepAlive.periodHours', '3');
  assert.equal(result.stdout, '✓ claude.keepAlive.periodHours = 3\n');
  assert.equal((await run('config', 'claude.keepAlive.periodHours', '--json')).stdout, '3\n', 'a number stays a number');
  result = await run('set', 'claude.autoRotate.enabled', 'true', '--json');
  assert.equal(result.stdout, 'true\n');
  result = await run('config', 'set', 'claude.autoRotate.enabled', 'false');
  assert.equal(result.stdout, '✓ claude.autoRotate.enabled = false\n');
  result = await run('config', 'claude.keepAlive.model', 'a', 'b');
  assert.equal(result.stdout, '✓ claude.keepAlive.model = a b\n', 'the words of a value are joined');
});

test('history: summary, day counts, exports, the files and a recording switch, with and without data', async (t) => {
  const { run, home } = await runningService(t);
  let result = await run('history');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^# AI Usage history · the last 30 days\n/);
  result = await run('history', '7');
  assert.match(result.stdout, /^# AI Usage history · the last 7 days\n/);
  result = await run('history', '--days', '3');
  assert.match(result.stdout, /^# AI Usage history · the last 3 days\n/);
  result = await run('history', '--all');
  assert.match(result.stdout, /^# AI Usage history · everything kept\n/);
  for (const bad of [['--days', '0'], ['--days', '-2'], ['--days', 'x']]) {
    result = await run('history', ...bad);
    assert.deepEqual([result.code, result.stderr], [2, '--days expects a positive number.\n'], bad.join(' '));
  }
  result = await run('history', 'weekly');
  assert.deepEqual([result.code, result.stderr], [2, 'Unknown history action "weekly": use a number of days, --all, export or path.\n']);
  const summary = JSON.parse((await run('history', '--json')).stdout);
  assert.equal(typeof summary, 'object');
  // The files: where they are, how many, and that recording can be off.
  result = await run('history', 'path');
  assert.equal(result.stdout.split('\n')[0], path.join(home, 'usage-history'));
  assert.match(result.stdout.split('\n')[1], /^\d+ month files?, kept 365 days/);
  assert.equal(JSON.parse((await run('history', 'path', '--json')).stdout).retentionDays, 365);
  await run('config', 'history.enabled', 'false');
  assert.match((await run('history', 'path')).stdout.split('\n')[0], /\(recording is off: history.enabled\)$/);
  await run('config', 'history.enabled', 'true');
  // Exports: each kind to stdout and to a file, a usage line for a bad kind. A reading comes from a keep-alive of a
  // saved account other than the active login, which is never kept alive.
  await run('save', 'claude', 'Work');
  await run('import', 'claude', credentialFile('history-b.json', 'b'), '--name', 'Backup');
  await run('keepalive', 'claude', 'Backup');
  assert.match((await run('history', 'export', 'readings', '-')).stdout, /^time,provider,/);
  assert.match((await run('history', 'export', 'events', '-')).stdout, /^time,provider,type,reason/);
  const jsonl = (await run('history', 'export', 'jsonl', '-')).stdout;
  assert.ok(jsonl.trim().split('\n').every((line) => { JSON.parse(line); return true; }));
  const target = path.join(root, 'readings.csv');
  result = await run('history', 'export', 'readings', target);
  assert.equal(result.stdout, `✓ Exported the usage history readings to ${target}.\n`);
  assert.match(fs.readFileSync(target, 'utf8'), /^time,provider,/);
  result = await run('history', 'export', 'weekly');
  assert.deepEqual([result.code, result.stderr], [2, 'Usage: ai-usage history export readings|events|jsonl [file]\n']);
  result = await run('history', 'export');
  assert.equal(result.code, 2);
});

test('--project: the current folder, a named folder, and a folder that holds a profile file', async (t) => {
  const { run } = await runningService(t);
  const project = fs.mkdtempSync(path.join(root, 'proj-'));
  const other = fs.mkdtempSync(path.join(root, 'other-'));
  process.chdir(project);
  try {
    // `--project` alone means the current directory.
    let result = await run('save', 'claude', 'Here', '--project');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `✓ Claude login saved as “Here” (a@example.com) in project ${path.basename(project)}.\n`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.ai-usage.profiles.json'), 'utf8')).profiles[0].name, 'Here');
    // The folder now holds a profile file, so later commands from it list the project profile without a flag.
    result = await run('list', 'claude');
    assert.match(result.stdout, new RegExp(`Here +●?.*project ${path.basename(project)}`));
    process.chdir(other);
    result = await run('list', 'claude');
    assert.ok(!/Here/.test(result.stdout), 'from a folder without a profile file the project profile is not listed');
    result = await run('list', 'claude', `--project=${project}`);
    assert.match(result.stdout, /Here/);
    result = await run('list', 'claude', '--project', '--json');
    assert.equal(JSON.parse(result.stdout).profiles.length, 0, 'the bare flag names the current folder, which has no profiles');
    // Importing into a named folder.
    result = await run('import', 'claude', credentialFile('p.json', 'b'), '--name', 'Imported', `--project=${other}`);
    assert.equal(result.stdout, `✓ Claude credential imported as “Imported” in project ${path.basename(other)}. Activate it with: ai-usage use claude "Imported"\n`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(other, '.ai-usage.profiles.json'), 'utf8')).profiles[0].name, 'Imported');
  } finally { process.chdir(originalCwd); }
});

test('login: runs the vendor CLI in an isolated home, finishes from its file, and says when nothing was stored', async (t) => {
  const { run } = await runningService(t);
  await run('save', 'claude', 'Work');
  const cli = path.join(root, 'fake-claude');
  const writes = path.join(root, 'fake-claude-mode');
  fs.writeFileSync(cli, `#!/bin/sh\nmode=$(cat "${writes}" 2>/dev/null)\nif [ "$mode" = "same" ]; then printf '%s' '{"claudeAiOauth":{"accessToken":"a","refreshToken":"r-a2","expiresAt":9999999999999}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"; fi\nif [ "$mode" = "other" ]; then printf '%s' '{"claudeAiOauth":{"accessToken":"z","refreshToken":"r-z","expiresAt":9999999999999}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"; fi\nexit 0\n`, { mode: 0o755 });
  await run('config', 'claude.cliPath', cli);
  await run('config', 'claude.keepAlive.home', path.join(root, 'claude-login-{number}'));
  let result = await run('login', 'claude', 'nobody');
  assert.deepEqual([result.code, result.stderr], [2, 'No Claude profile matches "nobody".\n']);
  // The CLI exits without writing a login: the profile is unchanged and the hold is lifted.
  fs.writeFileSync(writes, 'none');
  result = await run('login', 'claude', 'Work');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^Signing in for Claude profile “Work” \(a@example.com\) with a separate home; the active login is untouched until the profile is active\.\n! The sign-in was not completed \(the CLI exited with 0\); the profile is unchanged\.\n$/);
  // The same account signs in again: stored.
  fs.writeFileSync(writes, 'same');
  result = await run('signin', 'claude', '1');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\n✓ .+\n$/);
  // Another account would replace this profile's login: it asks, and a script has to confirm with -y.
  fs.writeFileSync(writes, 'other');
  result = await run('login', 'claude', 'Work');
  assert.equal(result.code, 2);
  assert.match(result.stdout, /\n! .+\n$/);
  assert.equal(result.stderr, "Replace the profile's login anyway? Pass -y to confirm without a prompt.\n");
  result = await run('sign-in', 'claude', 'Work', '-y', '--json');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout.slice(result.stdout.search(/^\{/m))).status, 'replaced');
});

test('service install, status and uninstall through the command, with a stand-in node so nothing real starts', async () => {
  const home = stoppedHome();
  const node = path.join(root, 'stand-in-node');
  fs.writeFileSync(node, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v22.4.0; fi\nexit 0\n', { mode: 0o755 });
  const previous = { AI_USAGE_NODE: process.env.AI_USAGE_NODE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.AI_USAGE_NODE = node;
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
  try {
    let result = await capture(['service', 'install', '--no-autostart'], home);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /installed the account service [\d.]+ to .* \(node 22\.4\.0 from AI_USAGE_NODE\); launcher /);
    assert.match(result.stdout, /✓ Installed the account service [\d.]+ \(started detached\)\. Autostart: not registered: not requested\.\n/);
    assert.match(result.stdout, new RegExp(`  Command: ${path.join(home, 'bin', 'ai-usage').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n  Add ${path.join(home, 'bin').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} to your PATH`));
    assert.equal(fs.existsSync(path.join(home, 'state', 'service-stopped')), false, 'installing starts the service again');
    result = await capture(['service', 'status', '--json'], home);
    const status = JSON.parse(result.stdout);
    assert.equal(status.installed.node.command, node);
    assert.equal(status.launcher, path.join(home, 'bin', 'ai-usage'));
    result = await capture(['service', 'status'], home);
    assert.match(result.stdout, new RegExp(`Installed:  [\\d.]+ at .* \\(node: ${node}\\)\\n`));
    result = await capture(['service', 'start'], home);
    assert.deepEqual([result.code, result.stdout], [0, '✓ started detached\n']);
    result = await capture(['service', 'uninstall', '-y'], home);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /✓ Uninstalled \(was not running; nothing was registered\)\.\n$/);
    assert.equal(fs.existsSync(path.join(home, 'service')), false);
    assert.equal(fs.existsSync(path.join(home, 'bin')), false);
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } } }
});

test('service install says so when no Node.js 20 or newer exists', async () => {
  const home = stoppedHome();
  const previous = { PATH: process.env.PATH, AI_USAGE_NODE: process.env.AI_USAGE_NODE };
  const realExecPath = process.execPath;
  // findNode falls back to the running runtime, so a missing runtime needs the fallback to be too old: ask for nothing newer than exists.
  process.env.PATH = '';
  process.env.AI_USAGE_NODE = path.join(root, 'does-not-exist');
  Object.defineProperty(process, 'execPath', { value: path.join(root, 'also-missing'), configurable: true });
  try {
    const known = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'].some((candidate) => fs.existsSync(candidate));
    if (known) { return; } // A node in a well-known location is a valid runtime on this host.
    const result = await capture(['service', 'install', '--no-autostart'], home);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^✗ No Node\.js 20\+ was found to run the service with\. Install Node\.js or set AI_USAGE_NODE\.\n$/);
  } finally {
    Object.defineProperty(process, 'execPath', { value: realExecPath, configurable: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
  }
});

/** Runs the real command line as a child process, writes `input` to its stdin and collects the result. */
function runProcess(args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'ai-usage.js'), ...args], { env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('the executable: usage text, exit codes and the MCP server over stdin and stdout', async (t) => {
  const home = stoppedHome();
  let result = await runProcess(['--help', '--home', home], '');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^ai-usage – /);
  result = await runProcess(['frobnicate', '--home', home], '');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown command "frobnicate"/);
  result = await runProcess(['status', '--home', home], '');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /stopped manually/);
  // mcp without a running service still serves: it says why on stderr and answers on stdout.
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  result = await runProcess(['mcp', '--home', home], `${request}\n`);
  assert.equal(result.code, 0, result.stderr);
  const reply = JSON.parse(result.stdout.trim().split('\n')[0]);
  assert.equal(reply.id, 1);
  assert.equal(reply.result.serverInfo.name, 'ai-usage');
  assert.equal(reply.result.protocolVersion, '2025-06-18');
  assert.equal(result.stderr, 'The account service has never run here: no service token was found.\n');
  // With the service running but the MCP switch off, stderr says the tools are off.
  const { home: runningHome } = await runningService(t);
  result = await runProcess(['mcp', '--home', runningHome], `${request}\n`);
  assert.match(result.stderr, /^The AI Usage MCP server is turned off: its tools answer with that until "ai-usage config mcp\.enabled true"/);
  assert.equal(JSON.parse(result.stdout.trim().split('\n')[0]).id, 1);
});

test('disable and enable take a profile out of rotation and the list says so', async (t) => {
  const { run } = await runningService(t);
  await run('save', 'claude', 'Work');
  await run('import', 'claude', credentialFile('b.json', 'b'), '--name', 'Backup');
  let result = await run('disable', 'claude', 'Backup');
  assert.deepEqual([result.code, result.stdout], [0, '✓ Disabled “Backup”: rotation, keep-alives and background usage reads leave it out.\n']);
  assert.equal(JSON.parse((await run('list', 'claude', '--json')).stdout).profiles[1].disabled, true);
  assert.match((await run('list', 'claude')).stdout, /disabled/);
  result = await run('enable', 'claude', '2');
  assert.deepEqual([result.code, result.stdout], [0, '✓ Enabled “Backup”.\n']);
  assert.equal(JSON.parse((await run('list', 'claude', '--json')).stdout).profiles[1].disabled, false);
  result = await run('disable', 'claude');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Usage: ai-usage disable <service> <profile>/);
  result = await run('disable', 'claude', 'nobody');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /No Claude profile matches "nobody"/);
});
