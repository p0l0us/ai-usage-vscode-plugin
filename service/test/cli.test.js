const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, formatStatus, profileRows, main } = require('../out/cli');
const { runDaemon } = require('../out/daemon');
const { ServiceClient } = require('../out/client');

test('arguments: positionals, boolean and value flags, short aliases and --no- forms', () => {
  assert.deepEqual(parseArgs(['use', 'claude', 'Work account', '--json', '-y']), { positional: ['use', 'claude', 'Work account'], flags: { json: true, yes: true } });
  assert.deepEqual(parseArgs(['log', '-n', '20', '-f', '--home=/tmp/x']).flags, { lines: '20', follow: true, home: '/tmp/x' });
  assert.deepEqual(parseArgs(['service', 'install', '--no-autostart']).flags, { autostart: false });
  assert.deepEqual(parseArgs(['save', 'codex', '--update', 'Main', '--', '--literal']).positional, ['save', 'codex', '--literal']);
  assert.deepEqual(parseArgs(['save', 'claude', 'X', '--project']).flags, { project: true });
  assert.deepEqual(parseArgs(['list', '--project=/work/app']).flags, { project: '/work/app' });
  assert.deepEqual(parseArgs(['history', '--days', '7']).flags, { days: '7' });
});

const snapshot = () => ({
  service: { version: '1.2.3', pid: 42, startedAt: new Date(Date.now() - 90 * 60_000).toISOString(), home: '/home/u/.ai-usage', node: 'node', socket: '', clients: 2 },
  config: {},
  providers: {
    claude: { provider: 'claude', title: 'Claude', activeProfileId: 'a', activeNumber: 1, nativeUnsaved: false, checkingActive: false, keepAlive: true, autoRotate: true, strategySummary: 'soonestReset, limit, 5h ≥ 95%, 7d ≥ 99.5%',
      profiles: [
        { id: 'a', name: 'Work', email: 'a@example.com', active: true, number: 1, problems: [], limit: { readOnly: false, dimmed: false }, hasCredential: true, checkedAt: new Date().toISOString(),
          usage: { provider: 'claude', title: 'Claude', fetchedAt: new Date().toISOString(), windows: [{ label: '5h', usedPercent: 41, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() }, { label: '7d', usedPercent: 7 }, { label: '7d Fable', usedPercent: 96 }] } },
        { id: 'b', name: 'Backup', active: false, number: 2, problems: [{ check: 'keepAlive', raw: 'x', label: 'Insufficient credits', known: true }], limit: { readOnly: false, dimmed: false }, hasCredential: true, loginProblem: 'OAuth token has expired' }
      ] },
    codex: { provider: 'codex', title: 'Codex', nativeUnsaved: true, checkingActive: false, keepAlive: false, autoRotate: false, strategySummary: '5h ≥ 100%, 7d ≥ 99%', profiles: [] }
  }
});

test('status output names the active accounts, readings, problems and the service', () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const text = formatStatus(snapshot());
    assert.match(text, /AI Usage account service 1\.2\.3 · pid 42 · up 1h 30m · 2 clients/);
    assert.match(text, /Claude  active: Work \(a@example.com\)  ·  keep-alive on  ·  rotation on \(soonestReset, limit/);
    assert.match(text, /1  Work +●  a@example.com  41% \(2h\)  7%  7d Fable 96%/);
    assert.match(text, /2  Backup +–  +–  +– +Login expired/);
    assert.match(text, /Codex  active: none  ·  keep-alive off  ·  rotation off/);
    assert.match(text, /no saved profiles/);
    const rows = profileRows(snapshot().providers.claude);
    assert.deepEqual(rows[0], ['#', 'Profile', '', 'Email', '5h', '7d', 'Other', 'Checked', 'Problem']);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous;
  }
});

/** Runs the command with its output captured; the process streams stay untouched for the test runner. */
async function capture(fn) {
  const chunks = [];
  const errors = [];
  const code = await fn({ stdout: (text) => chunks.push(String(text)), stderr: (text) => errors.push(String(text)) });
  return { code, stdout: chunks.join(''), stderr: errors.join('') };
}

test('the command line drives a running service: save, list, use, config, rotate, export and import', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-cli-'));
  const home = path.join(root, 'home');
  const claudeHome = path.join(root, 'claude'); fs.mkdirSync(claudeHome);
  const codexHome = path.join(root, 'codex'); fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 9999999999999 } }));
  const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, NO_COLOR: process.env.NO_COLOR };
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  process.env.NO_COLOR = '1';
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude: { enabled: false }, codex: { enabled: false, autoReset: { enabled: false } }, copilot: { enabled: false }, bridge: { autoStart: false } }));
  const daemon = runDaemon({ home, version: 'cli-test' });
  t.after(async () => {
    // The daemon runs inside this process: ask it to stop over the socket rather than by pid.
    try { const client = await ServiceClient.connect({ home, client: 'test' }); await client.shutdown(); client.close(); } catch { /* Already stopped. */ }
    await daemon.catch(() => undefined);
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const run = (...args) => capture((io) => main([...args, '--home', home], io));
  // The Claude identity lookup would hit the network with a fake token; it fails fast or times out and leaves no email.
  let result = await run('save', 'claude', 'Work');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Claude login saved as “Work”/);
  const credential = path.join(root, 'b.json');
  fs.writeFileSync(credential, JSON.stringify({ claudeAiOauth: { accessToken: 'b', refreshToken: 'r-b' } }));
  result = await run('import', 'claude', credential, '--name', 'Backup');
  assert.equal(result.code, 0, result.stderr);
  result = await run('list', 'claude');
  assert.match(result.stdout, /1  Work +●/);
  assert.match(result.stdout, /2  Backup/);
  result = await run('use', 'claude', '2');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Claude switched to “Backup”/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(claudeHome, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken, 'b');
  result = await run('config', 'claude.autoRotate.strategy', 'evenPace');
  assert.match(result.stdout, /claude.autoRotate.strategy = evenPace/);
  result = await run('config', 'claude.autoRotate.strategy', '--json');
  assert.equal(result.stdout.trim(), '"evenPace"');
  result = await run('config', 'claude.autoRotate.strategy', 'bogus');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /must be one of/);
  // The sweep reads the active account with the real probe; keep its staged home inside the test root.
  await run('config', 'claude.keepAlive.home', path.join(root, 'claude-tmp'));
  result = await run('rotate', 'claude');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /not rotated: the active account could not be read/);
  result = await run('export', '-');
  const exported = JSON.parse(result.stdout);
  assert.equal(exported.profiles.length, 2);
  result = await run('delete', 'claude', 'Work', '-y');
  assert.match(result.stdout, /Deleted “Work”/);
  const file = path.join(root, 'export.json');
  fs.writeFileSync(file, JSON.stringify(exported));
  result = await run('import-profiles', file, '-y');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Imported 1: 1 added/);
  result = await run('status', '--json');
  const snapshotOut = JSON.parse(result.stdout);
  assert.equal(snapshotOut.providers.claude.profiles.length, 2);
  result = await run('rename', 'claude', 'Backup', 'Spare');
  assert.match(result.stdout, /Renamed to “Spare”/);
  // A project profile: saved into the named folder's file, listed with the project while that folder is declared.
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  result = await run('save', 'claude', 'Client', `--project=${project}`, '--allow-duplicate');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /saved as “Client” in project project/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.ai-usage.profiles.json'), 'utf8')).profiles[0].name, 'Client');
  result = await run('list', 'claude', `--project=${project}`);
  assert.match(result.stdout, /Client +●  – · project project/);
  result = await run('list', 'claude');
  assert.ok(!/Client/.test(result.stdout), 'without the folder declared, its profiles are not listed');
  // The usage history: the switches above were recorded, and the summary and the files are reachable.
  result = await run('history', '--days', '7');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^# AI Usage history · the last 7 days/);
  assert.match(result.stdout, /by hand 1/);
  result = await run('history', 'path');
  assert.ok(result.stdout.includes(path.join(home, 'usage-history')), result.stdout);
  result = await run('history', 'export', 'events', '-');
  assert.match(result.stdout, /^time,provider,type,reason/);
  result = await run('history', 'nonsense');
  assert.equal(result.code, 2);
  result = await run('nonsense');
  assert.equal(result.code, 2);
  result = await run('service', 'status');
  assert.match(result.stdout, /Running: +yes/);
});
