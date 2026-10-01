const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountService } = require('../out/accountService');

const HOUR = 3_600_000;
const claudeLogin = (token) => ({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: 9999999999999 } });
const usage = (provider, percents, now = Date.now()) => ({ provider, title: provider, fetchedAt: new Date(now),
  windows: percents.map((value, index) => ({ label: index ? '7d' : '5h', usedPercent: value, resetsAt: new Date(now + 24 * HOUR) })) });

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-service-'));
  const claudeHome = path.join(root, 'claude'); fs.mkdirSync(claudeHome);
  const codexHome = path.join(root, 'codex'); fs.mkdirSync(codexHome);
  const home = path.join(root, 'home');
  const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify(claudeLogin('a')));
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 't', refresh_token: 'r', account_id: 'acc-1' } }));
  const logs = [], events = [], probes = [];
  const values = { a: [10, 10], b: [10, 10], ...options.values };
  const service = new AccountService({
    home, version: 'test', log: (message) => logs.push(message),
    identityOf: async (provider, credential) => provider === 'codex'
      ? { email: `${credential.tokens?.account_id}@example.com`, accountId: credential.tokens?.account_id }
      : { email: `${credential.claudeAiOauth?.accessToken}@example.com`, accountId: `account-${credential.claudeAiOauth?.accessToken}` },
    verifyCodex: async () => ({ status: 'match', detail: 'ok' }),
    syncClaudeMetadata: async (credential) => ({ status: 'synced', identity: { email: `${credential.claudeAiOauth.accessToken}@example.com`, accountId: `account-${credential.claudeAiOauth.accessToken}` }, detail: 'synced' }),
    probe: async (provider, credential, settings, keepAlive) => {
      const token = provider === 'claude' ? credential.claudeAiOauth.accessToken : credential.tokens.account_id;
      probes.push([provider, token, keepAlive]);
      const percents = values[token];
      return { credential, keepAliveError: keepAlive ? options.keepAliveErrors?.[token] : undefined,
        result: percents ? { kind: 'ok', usage: usage(provider, percents) } : { kind: 'error', provider, title: provider, message: options.usageErrors?.[token] ?? 'Unavailable' } };
    }
  });
  service.events.on('event', (event) => events.push(event));
  t.after(() => {
    service.dispose();
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, service, logs, events, probes, values, claudeHome, call: (method, params) => service.handle(method, params) };
}

test('profiles are listed as views with numbers, active marks, readings and problems', async (t) => {
  const f = fixture(t, { keepAliveErrors: { b: 'Keep-alive CLI exited with code 1: out of credits' } });
  const saved = await f.call('profiles.saveNative', { provider: 'claude', name: 'Work' });
  assert.equal(saved.status, 'saved');
  const imported = await f.call('profiles.importCredential', { provider: 'claude', name: 'Backup', credential: claudeLogin('b') });
  await f.call('automation.keepAliveNow', { provider: 'claude', id: imported.profile.id });
  const view = await f.call('profiles.list', { provider: 'claude' });
  assert.equal(view.title, 'Claude');
  assert.equal(view.activeProfileId, saved.profile.id);
  assert.equal(view.activeNumber, 1);
  assert.deepEqual(view.profiles.map((profile) => [profile.number, profile.name, profile.active, profile.hasCredential, profile.email]),
    [[1, 'Work', true, true, 'a@example.com'], [2, 'Backup', false, true, 'b@example.com']]);
  const backup = view.profiles[1];
  assert.equal(backup.usage.windows[0].usedPercent, 10);
  assert.ok(backup.checkedAt);
  assert.deepEqual(backup.problems.map((problem) => [problem.check, problem.label]), [['keepAlive', 'Insufficient credits']]);
  assert.equal(view.keepAlive, false);
  assert.equal(view.strategySummary, 'soonestReset, limit, 5h ≥ 95%, 7d ≥ 99.5%');
  assert.ok(!('credential' in backup));
});

test('activating by name emits an activated event and answers with the message', async (t) => {
  const f = fixture(t);
  await f.call('profiles.saveNative', { provider: 'claude', name: 'Work' });
  await f.call('profiles.importCredential', { provider: 'claude', name: 'Backup', credential: claudeLogin('b') });
  const result = await f.call('profiles.activate', { provider: 'claude', ref: 'backup' });
  assert.equal(result.level, 'info');
  assert.equal(result.profile.name, 'Backup');
  assert.equal(result.accountChanged, true);
  assert.equal(result.verification.status, 'match');
  const activated = f.events.find((event) => event.event === 'activated');
  assert.equal(activated.name, 'Backup');
  assert.equal(activated.automatic, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.claudeHome, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken, 'b');
  await assert.rejects(f.call('profiles.activate', { provider: 'claude', ref: 'nobody' }), /No Claude profile matches "nobody"/);
  await assert.rejects(f.call('profiles.activate', { provider: 'copilot', ref: 'x' }), /claude or codex/);
});

test('an observed reading of the active account is stored, and a hand-run sweep rotates to the account below the thresholds', async (t) => {
  const f = fixture(t, { values: { a: [99.5, 10], b: [10, 10] } });
  const work = await f.call('profiles.saveNative', { provider: 'claude', name: 'Work' });
  await f.call('profiles.importCredential', { provider: 'claude', name: 'Backup', credential: claudeLogin('b') });
  const reading = usage('claude', [50, 5]);
  await f.call('usage.observe', { provider: 'claude', id: work.profile.id, usage: { ...reading, fetchedAt: reading.fetchedAt.toISOString(),
    windows: reading.windows.map((window) => ({ ...window, resetsAt: window.resetsAt.toISOString() })) } });
  let view = await f.call('profiles.list', { provider: 'claude' });
  assert.equal(view.profiles[0].usage.windows[0].usedPercent, 50);
  // Rotation is off, but a sweep requested by hand still runs; it reads the active account fresh (99.5%).
  const outcome = await f.call('automation.rotateNow', { provider: 'claude' });
  assert.equal(outcome.switched, true, outcome.reason);
  assert.equal(outcome.activeProfileName, 'Backup');
  const rotated = f.events.find((event) => event.event === 'activated' && event.automatic);
  assert.ok(rotated);
  assert.match(rotated.message, /automatically rotated to account “Backup”/);
  // Backup was read and then verified with a keep-alive before the switch.
  assert.deepEqual(f.probes.filter(([, token]) => token === 'b').map(([, , keepAlive]) => keepAlive), [false, true]);
  view = await f.call('profiles.list', { provider: 'claude' });
  assert.equal(view.activeNumber, 2);
  const again = await f.call('automation.rotateNow', { provider: 'claude' });
  assert.equal(again.switched, false);
  assert.match(again.reason, /below its thresholds/);
});

test('configuration changes are validated, saved, announced and reloaded from a hand-edited file', async (t) => {
  const f = fixture(t);
  const config = await f.call('config.set', { values: { 'claude.autoRotate.enabled': 'true', 'codex.keepAlive.periodHours': 12 } });
  assert.equal(config.claude.autoRotate.enabled, true);
  assert.equal(config.codex.keepAlive.periodHours, 12);
  assert.equal(f.events.filter((event) => event.event === 'configChanged').length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'config.json'), 'utf8')).codex.keepAlive.periodHours, 12);
  await assert.rejects(f.call('config.set', { values: { 'claude.autoRotate.strategy': 'nonsense' } }), /must be one of/);
  await f.call('config.set', { values: { 'codex.keepAlive.periodHours': 12 } });
  assert.equal(f.events.filter((event) => event.event === 'configChanged').length, 1, 'an unchanged value announces nothing');
  const edited = JSON.parse(fs.readFileSync(path.join(f.home, 'config.json'), 'utf8'));
  edited.claude.autoRotate.strategy = 'leastWaste';
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(edited));
  await f.call('automation.tick');
  assert.equal((await f.call('config.get')).claude.autoRotate.strategy, 'leastWaste');
  assert.equal(f.events.filter((event) => event.event === 'configChanged').length, 2);
});

test('a sign-in is prepared with an isolated home and finished from the file the CLI writes', async (t) => {
  const f = fixture(t);
  const cli = path.join(f.root, process.platform === 'win32' ? 'fake-cli.cmd' : 'fake-cli');
  fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await f.call('config.set', { values: { 'claude.cliPath': cli, 'claude.keepAlive.home': path.join(f.root, 'claude-tmp') } });
  const work = await f.call('profiles.saveNative', { provider: 'claude', name: 'Work' });
  const prepared = await f.call('profiles.signIn.prepare', { provider: 'claude' });
  assert.equal(prepared.cli, cli);
  assert.deepEqual(prepared.args, ['auth', 'login']);
  assert.equal(prepared.env.CLAUDE_CONFIG_DIR, prepared.cwd);
  assert.equal(prepared.env.HOME, prepared.cwd);
  assert.ok(prepared.cwd.startsWith(path.join(f.root, 'claude-tmp')));
  // While the sign-in is pending, this service's checks wait, and hand-run ones say so.
  await assert.rejects(f.call('automation.keepAliveNow', { provider: 'claude', id: work.profile.id }), /A Claude sign-in is in progress; keep-alives wait until it finishes\./);
  assert.equal((await f.call('automation.rotateNow', { provider: 'claude' })).reason, 'a Claude sign-in is in progress');
  await assert.rejects(f.call('profiles.signIn.finish', { provider: 'claude', id: work.profile.id }), /wrote no login/);
  // A finish without a login lifts the hold; a new prepare holds again.
  f.values.a = [5, 5];
  assert.ok((await f.call('automation.keepAliveNow', { provider: 'claude', id: work.profile.id })).usage);
  await f.call('profiles.signIn.prepare', { provider: 'claude' });
  await assert.rejects(f.call('automation.keepAliveNow', { provider: 'claude', id: work.profile.id }), /sign-in is in progress/);
  fs.writeFileSync(prepared.file, JSON.stringify(claudeLogin('other')));
  const refused = await f.call('profiles.signIn.finish', { provider: 'claude', id: work.profile.id });
  assert.equal(refused.status, 'otherAccount');
  assert.match(refused.message, /signed in as other@example.com, but the profile “Work” holds a@example.com/);
  assert.ok(fs.existsSync(prepared.file), 'the login stays for a retry');
  const replaced = await f.call('profiles.signIn.finish', { provider: 'claude', id: work.profile.id, allowOtherAccount: true });
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.active, true);
  assert.ok(!fs.existsSync(prepared.file));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.claudeHome, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken, 'other');
  assert.equal((await f.call('profiles.list', { provider: 'claude' })).profiles[0].email, 'other@example.com');
  // The stored login lifted the hold: checks run again.
  f.values.other = [5, 5];
  assert.ok((await f.call('automation.keepAliveNow', { provider: 'claude', id: work.profile.id })).usage);
  // A cancelled sign-in lifts it too.
  await f.call('profiles.signIn.prepare', { provider: 'claude' });
  await f.call('profiles.signIn.cancel', { provider: 'claude' });
  assert.ok((await f.call('automation.keepAliveNow', { provider: 'claude', id: work.profile.id })).usage);
});

test('export and import go through the same plans the extension shows', async (t) => {
  const f = fixture(t);
  await f.call('profiles.saveNative', { provider: 'claude', name: 'Work' });
  await f.call('profiles.saveNative', { provider: 'codex', name: 'Main' });
  const exported = await f.call('profiles.export', {});
  assert.equal(exported.entries.length, 2);
  assert.match(exported.text, /"aiUsageProfiles": 1/);
  await f.call('profiles.delete', { provider: 'codex', ref: 'Main' });
  const plans = await f.call('profiles.planImport', { text: exported.text });
  assert.deepEqual(plans.map((plan) => [plan.name, plan.kind, plan.suggested, plan.outcome]), [['Work', 'same', false, 'already saved'], ['Main', 'new', true, 'new profile']]);
  const summary = await f.call('profiles.applyImport', { text: exported.text });
  assert.equal(summary.imported, 1);
  assert.equal((await f.call('profiles.list', { provider: 'codex' })).profiles.length, 1);
  // Nothing was activated by the import; the native Codex login simply belongs to the re-imported profile, and is followed.
  const codex = await f.call('profiles.list', { provider: 'codex' });
  assert.equal(codex.activeProfileId, codex.profiles[0].id);
  assert.equal(codex.nativeUnsaved, false);
});

test('clients declare project folders; the union is listed while they are connected, and a profile can be saved into one', async (t) => {
  const f = fixture(t);
  const project = path.join(f.root, 'project');
  fs.mkdirSync(project);
  await f.call('profiles.saveNative', { provider: 'claude', name: 'Work' });
  await assert.rejects(f.call('session.folders', { folders: [project] }), /Only a connected client/);
  f.service.declareFolders(7, [project]);
  let view = await f.call('profiles.list', { provider: 'claude' });
  assert.deepEqual(view.scopes, { privateEnabled: true, projectEnabled: true, folders: [project] });
  const saved = await f.call('profiles.importCredential', { provider: 'claude', name: 'Client', credential: claudeLogin('b'), folder: project });
  assert.equal(saved.profile.folder, project);
  view = await f.call('profiles.list', { provider: 'claude' });
  assert.deepEqual(view.profiles.map((profile) => [profile.name, profile.folder]), [['Work', undefined], ['Client', project]]);
  assert.ok(fs.existsSync(path.join(project, '.ai-usage.profiles.json')));
  // Another client's folder joins the union; a disconnect removes its folders.
  const other = path.join(f.root, 'other');
  fs.mkdirSync(other);
  await f.service.handle('session.folders', { folders: [other] }, 8);
  assert.deepEqual((await f.call('profiles.list', { provider: 'claude' })).scopes.folders, [project, other]);
  f.service.forgetFolders(7);
  view = await f.call('profiles.list', { provider: 'claude' });
  assert.deepEqual(view.scopes.folders, [other]);
  assert.deepEqual(view.profiles.map((profile) => profile.name), ['Work']);
  assert.ok(f.events.some((event) => event.event === 'stateChanged'));
});

test('a keep-alive sweep over every account runs in the service, reports progress, and can be cancelled', async (t) => {
  const f = fixture(t, { keepAliveErrors: { b: 'Keep-alive CLI exited with code 1: out of credits' } });
  await f.call('profiles.saveNative', { provider: 'claude', name: 'Work' });
  await f.call('profiles.importCredential', { provider: 'claude', name: 'Backup', credential: claudeLogin('b') });
  const progress = [];
  f.service.events.on('event', (event) => { if (event.event === 'keepAliveProgress') { progress.push(`${event.index}/${event.total} ${event.name}`); } });
  // The sweep pauses between accounts; cancelling during that pause ends it with the first account done.
  const sweep = f.call('automation.keepAliveAll', { provider: 'claude', token: 't1' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await f.call('automation.cancel', { token: 't1' });
  const result = await sweep;
  assert.deepEqual(progress, ['0/2 Work']);
  assert.equal(result.done, 1);
  assert.equal(result.total, 2);
  assert.equal(result.cancelled, true);
  assert.ok(result.results[0].usage);
  // Only the chosen accounts, when ids are given.
  const chosen = await f.call('automation.keepAliveAll', { provider: 'claude', ids: [(await f.call('profiles.list', { provider: 'claude' })).profiles[1].id] });
  assert.equal(chosen.total, 1);
  assert.equal(chosen.results[0].name, 'Backup');
  assert.match(chosen.results[0].keepAliveError, /out of credits/);
  assert.equal(chosen.cancelled, false);
});
