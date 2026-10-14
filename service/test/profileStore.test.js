const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore, validateName, activationMessage, importOutcome, MAX_PROFILES } = require('../out/profileStore');

const claudeLogin = (token) => ({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: 9999999999999 } });
const codexLogin = (account) => ({ auth_mode: 'chatgpt', tokens: { access_token: `t-${account}`, refresh_token: `r-${account}`, account_id: account }, last_refresh: '2026-09-29T00:00:00Z' });

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-store-'));
  const claudeHome = path.join(root, 'claude');
  const codexHome = path.join(root, 'codex');
  fs.mkdirSync(claudeHome); fs.mkdirSync(codexHome);
  const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const nativeClaude = path.join(claudeHome, '.credentials.json');
  const nativeCodex = path.join(codexHome, 'auth.json');
  fs.writeFileSync(nativeClaude, JSON.stringify({ ...claudeLogin('a'), mcpOAuth: { keep: true } }));
  fs.writeFileSync(nativeCodex, JSON.stringify(codexLogin('acc-x')));
  const logs = [];
  // Identities come from the token: "a" → a@example.com; unknown tokens have none.
  const identities = { a: { email: 'a@example.com', accountId: 'account-a' }, b: { email: 'b@example.com', accountId: 'account-b' }, ...options.identities };
  const identityOf = async (provider, credential) => {
    if (provider === 'codex') { const id = credential.tokens?.account_id; return { email: id ? `${id}@example.com` : undefined, accountId: id }; }
    return identities[credential.claudeAiOauth?.accessToken] ?? {};
  };
  const store = new ProfileStore(path.join(root, 'profiles.json'), (message) => logs.push(message), identityOf);
  return { root, store, logs, nativeClaude, nativeCodex, claudeHome, readNative: (file) => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('saving the native login creates an active profile with its identity, and the file is private', async (t) => {
  const f = fixture(t);
  const outcome = await f.store.saveNative('claude', { name: 'Work' });
  assert.equal(outcome.status, 'saved');
  assert.equal(outcome.profile.email, 'a@example.com');
  assert.equal(outcome.profile.accountId, 'account-a');
  assert.equal(f.store.activeProfileId('claude'), outcome.profile.id);
  assert.equal(f.store.activeProfileName('claude'), 'Work');
  assert.equal(f.store.profileCount('claude'), 1);
  assert.ok(f.store.hasCredential('claude', outcome.profile.id));
  assert.equal(f.store.profiles('claude')[0].credential, undefined, 'metadata never carries the login');
  if (process.platform !== 'win32') { assert.equal(fs.statSync(path.join(f.root, 'profiles.json')).mode & 0o777, 0o600); }
  assert.equal(validateName(''), 'Enter a profile name.');
  assert.equal(validateName('   '), 'Enter a profile name.');
  assert.equal(validateName('x'.repeat(61)), 'Use 60 characters or fewer.');
  await assert.rejects(f.store.saveNative('claude', { name: 'work' }), /already exists/);
});

test('a login that is already saved is reported as a duplicate unless a copy is allowed', async (t) => {
  const f = fixture(t);
  await f.store.saveNative('claude', { name: 'Work' });
  const duplicate = await f.store.saveNative('claude', { name: 'Again' });
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.twin.name, 'Work');
  assert.match(duplicate.warning, /already saved as “Work”/);
  const copy = await f.store.saveNative('claude', { name: 'Again', allowDuplicate: true });
  assert.equal(copy.status, 'saved');
  assert.equal(f.store.profileCount('claude'), 2);
});

test('an identical credential is detected even when the account identity is unavailable', async (t) => {
  const f = fixture(t);
  const first = await f.store.importCredential('claude', 'Unknown', claudeLogin('unknown'));
  const second = await f.store.importCredential('claude', 'Again', claudeLogin('unknown'));
  assert.equal(first.status, 'saved');
  assert.equal(second.status, 'duplicate');
  assert.equal(second.twin.id, first.profile.id);
  assert.equal(f.store.profileCount('claude'), 1);
});

test('concurrent imports commit one copy of a login and recheck duplicate names', async (t) => {
  const f = fixture(t);
  let releaseIdentity;
  const gate = new Promise((resolve) => { releaseIdentity = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const store = new ProfileStore(path.join(f.root, 'concurrent-profiles.json'), () => undefined, async (_provider, credential) => {
    started();
    await gate;
    const token = credential.claudeAiOauth.accessToken;
    return { email: `${token}@example.com`, accountId: token };
  });
  const first = store.importCredential('claude', 'First', claudeLogin('same'));
  await entered;
  const second = store.importCredential('claude', 'Second', claudeLogin('same'));
  releaseIdentity();
  const [saved, duplicate] = await Promise.all([first, second]);
  assert.equal(saved.status, 'saved');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.twin.id, saved.profile.id);
  assert.equal(store.profileCount('claude'), 1);

  const sameName = await Promise.allSettled([
    store.importCredential('claude', 'New', claudeLogin('other')),
    store.importCredential('claude', 'new', claudeLogin('third'))
  ]);
  assert.equal(sameName.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(sameName.find((result) => result.status === 'rejected').reason.message, /already exists/);
  assert.equal(store.profileCount('claude'), 2);
});

test('reordering persists within the same profile scope without changing the active login', async (t) => {
  const f = fixture(t);
  const a = await f.store.saveNative('claude', { name: 'A' });
  const b = await f.store.importCredential('claude', 'B', claudeLogin('b'));
  const project = path.join(f.root, 'project');
  fs.mkdirSync(project);
  f.store.setProjectFolders([project]);
  const p = await f.store.importCredential('claude', 'Project', claudeLogin('project'), false, project);
  const q = await f.store.importCredential('claude', 'Project 2', claudeLogin('project2'), false, project);
  assert.deepEqual(f.store.profiles('claude').map((item) => item.id), [a.profile.id, b.profile.id, p.profile.id, q.profile.id]);
  assert.deepEqual(f.store.reorder('claude', b.profile.id, -1).map((item) => item.id), [b.profile.id, a.profile.id, p.profile.id, q.profile.id]);
  assert.equal(f.store.activeProfileId('claude'), a.profile.id);
  assert.equal(f.store.activeProfileNumber('claude'), 2);
  assert.deepEqual(f.store.profiles('claude').map((item) => item.id), [b.profile.id, a.profile.id, p.profile.id, q.profile.id]);
  assert.throws(() => f.store.reorder('claude', p.profile.id, -1), /cannot move further/);
  f.store.reorder('claude', q.profile.id, -1);
  assert.deepEqual(f.store.profiles('claude').map((item) => item.id), [b.profile.id, a.profile.id, q.profile.id, p.profile.id]);
  const file = path.join(project, '.ai-usage.profiles.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).profiles.map((item) => item.id), [q.profile.id, p.profile.id]);
});

test('importing a credential saves it without activating; activating writes the native file and keeps MCP entries', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const imported = await f.store.importCredential('claude', 'Backup', claudeLogin('b'));
  assert.equal(imported.status, 'saved');
  assert.equal(f.store.activeProfileId('claude'), work.profile.id);
  assert.equal(f.readNative(f.nativeClaude).claudeAiOauth.accessToken, 'a');
  const outcome = await f.store.activateProfile('claude', imported.profile.id);
  assert.equal(outcome.level, 'info');
  assert.equal(outcome.accountChanged, true);
  assert.match(outcome.message, /Claude switched to “Backup”/);
  assert.equal(f.store.activeProfileId('claude'), imported.profile.id);
  const native = f.readNative(f.nativeClaude);
  assert.equal(native.claudeAiOauth.accessToken, 'b');
  assert.deepEqual(native.mcpOAuth, { keep: true });
  // Re-activating the same profile is not an account change.
  assert.equal((await f.store.activateProfile('claude', imported.profile.id)).accountChanged, false);
});

test('the verifier decides what the outcome says, and a Claude mismatch of account ids is reported as an error', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  f.store.verifyActivation = async () => ({ status: 'unverified', detail: 'rate limited' });
  assert.equal((await f.store.activateProfile('claude', work.profile.id)).level, 'warning');
  f.store.verifyActivation = async () => ({ status: 'match', detail: 'ok', email: 'other@example.com', accountId: 'account-other' });
  const mismatch = await f.store.activateProfile('claude', work.profile.id);
  assert.equal(mismatch.level, 'error');
  assert.match(mismatch.message, /reports a different login/);
  // A match with a new account id upgrades legacy metadata instead.
  const imported = await f.store.importCredential('claude', 'Legacy', claudeLogin('legacy'));
  assert.equal(imported.profile.accountId, undefined);
  f.store.verifyActivation = async () => ({ status: 'match', detail: 'ok', email: 'legacy@example.com', accountId: 'account-legacy' });
  const upgraded = await f.store.activateProfile('claude', imported.profile.id);
  assert.equal(upgraded.level, 'info');
  assert.equal(f.store.profile('claude', imported.profile.id).accountId, 'account-legacy');
});

test('a native login switched outside the service makes its saved profile active; an unsaved one leaves no number', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const backup = await f.store.importCredential('claude', 'Backup', claudeLogin('b'));
  fs.writeFileSync(f.nativeClaude, JSON.stringify(claudeLogin('b')));
  assert.equal(await f.store.followNative('claude'), true);
  assert.equal(f.store.activeProfileId('claude'), backup.profile.id);
  assert.equal(f.store.activeProfileNumber('claude'), 2);
  assert.equal(await f.store.followNative('claude'), false, 'an unchanged file is not checked again');
  fs.writeFileSync(f.nativeClaude, JSON.stringify(claudeLogin('stranger')));
  assert.equal(await f.store.followNative('claude'), false);
  assert.equal(f.store.activeProfileId('claude'), backup.profile.id, 'the active profile is kept');
  assert.equal(f.store.activeProfileNumber('claude'), undefined);
  assert.equal(f.store.nativeIsUnsaved('claude'), true);
  assert.ok(f.logs.some((line) => /not one of the saved profiles/.test(line)));
  assert.equal(await f.store.matchesNative('claude', work.profile.id), false);
});

test('refreshed tokens are written back only while the stored and native logins are still the ones that were read', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const before = await f.store.credential('claude', work.profile.id);
  const after = claudeLogin('a-refreshed');
  await f.store.refreshedCredential('claude', work.profile.id, before, after);
  assert.equal(f.readNative(f.nativeClaude).claudeAiOauth.accessToken, 'a-refreshed');
  assert.deepEqual(await f.store.credential('claude', work.profile.id), after);
  // Someone else changed the native login meanwhile: the stale refresh is dropped.
  fs.writeFileSync(f.nativeClaude, JSON.stringify(claudeLogin('manual')));
  await f.store.refreshedCredential('claude', work.profile.id, after, claudeLogin('late'));
  assert.equal(f.readNative(f.nativeClaude).claudeAiOauth.accessToken, 'manual');
});

test('rename, delete and resolve by name, number, id or email', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const backup = await f.store.importCredential('claude', 'Backup', claudeLogin('b'));
  assert.equal(f.store.resolve('claude', 'backup').id, backup.profile.id);
  assert.equal(f.store.resolve('claude', '#1').id, work.profile.id);
  assert.equal(f.store.resolve('claude', '2').id, backup.profile.id);
  assert.equal(f.store.resolve('claude', work.profile.id).id, work.profile.id);
  assert.equal(f.store.resolve('claude', 'B@example.com').id, backup.profile.id);
  assert.equal(f.store.resolve('claude', 'nobody'), undefined);
  assert.equal(f.store.rename('claude', backup.profile.id, 'Spare').name, 'Spare');
  assert.throws(() => f.store.rename('claude', backup.profile.id, 'work'), /already exists/);
  const deleted = f.store.delete('claude', work.profile.id);
  assert.equal(deleted.wasActive, true);
  assert.equal(f.store.activeProfileId('claude'), undefined);
  assert.deepEqual(f.store.profiles('claude').map((profile) => profile.name), ['Spare']);
  assert.equal(f.readNative(f.nativeClaude).claudeAiOauth.accessToken, 'a', 'the native login stays until the next switch');
});

test('export and import move profiles between stores, restore a missing login and activate nothing', async (t) => {
  const f = fixture(t);
  await f.store.saveNative('claude', { name: 'Work' });
  const codex = await f.store.saveNative('codex', { name: 'Main' });
  const { entries, missing } = f.store.exportEntries();
  assert.deepEqual(entries.map((entry) => [entry.provider, entry.name]), [['claude', 'Work'], ['codex', 'Main']]);
  assert.deepEqual(missing, []);
  const other = new ProfileStore(path.join(f.root, 'other.json'), () => undefined, async () => ({}));
  const plans = other.planImport(entries);
  assert.deepEqual(plans.map((plan) => plan.kind), ['new', 'new']);
  const outcome = await other.applyImport(plans);
  assert.equal(outcome.imported, 2);
  assert.match(outcome.summary, /2 added/);
  assert.deepEqual(other.profiles('codex').map((profile) => profile.id), [codex.profile.id]);
  assert.equal(other.activeProfileId('claude'), undefined);
  // A profile whose login was lost gets it back from the export.
  const damaged = JSON.parse(fs.readFileSync(path.join(f.root, 'other.json'), 'utf8'));
  delete damaged.codex.profiles[0].credential;
  fs.writeFileSync(path.join(f.root, 'other.json'), JSON.stringify(damaged));
  assert.equal(other.hasCredential('codex', codex.profile.id), false);
  const again = other.planImport(entries);
  assert.deepEqual(again.map((plan) => plan.kind), ['same', 'restore']);
  await other.applyImport(again.filter((plan) => plan.kind === 'restore'));
  assert.equal(other.hasCredential('codex', codex.profile.id), true);
});

test('replacing the login of the active profile replaces the native login as well', async (t) => {
  const f = fixture(t);
  const main = await f.store.saveNative('codex', { name: 'Main' });
  assert.equal(await f.store.replaceCredential('codex', main.profile.id, codexLogin('acc-new')), true);
  assert.equal(f.readNative(f.nativeCodex).tokens.account_id, 'acc-new');
  assert.equal(f.store.profile('codex', main.profile.id).accountId, 'acc-new');
  const spare = await f.store.importCredential('codex', 'Spare', codexLogin('acc-spare'));
  assert.equal(await f.store.replaceCredential('codex', spare.profile.id, codexLogin('acc-spare-2')), false);
  assert.equal(f.readNative(f.nativeCodex).tokens.account_id, 'acc-new');
});

function projectStore(f, options = {}) {
  const config = { file: '.ai-usage.profiles.json', projectEnabled: true, privateEnabled: true, ...options };
  const notices = [];
  const store = new ProfileStore(path.join(f.root, 'profiles.json'), (message) => f.logs.push(message),
    async (provider, credential) => provider === 'codex' ? { email: `${credential.tokens?.account_id}@example.com`, accountId: credential.tokens?.account_id }
      : ({ a: { email: 'a@example.com', accountId: 'account-a' }, external: { email: 'other@example.com', accountId: 'account-other' } }[credential.claudeAiOauth?.accessToken] ?? {}),
    { projectFileName: () => config.file, projectProfilesEnabled: () => config.projectEnabled, privateProfilesEnabled: () => config.privateEnabled, notice: (message) => notices.push(message) });
  return { store, config, notices };
}

test('project profiles of a declared folder are listed with the private ones, keep their login in the file, and are written back', async (t) => {
  const f = fixture(t);
  const { store, config } = projectStore(f, { file: 'config/ai-usage.json' });
  await store.saveNative('claude', { name: 'A' });
  const project = path.join(f.root, 'project');
  fs.mkdirSync(path.join(project, 'config'), { recursive: true });
  const file = path.join(project, 'config', 'ai-usage.json');
  const login = claudeLogin('project');
  fs.writeFileSync(file, JSON.stringify({ aiUsageProfiles: 1, profiles: [{ provider: 'claude', id: 'p1', name: 'Client', email: 'client@example.com', accountId: 'acc-c',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', credential: login }] }));
  assert.deepEqual(store.profiles('claude').map((p) => p.folder), [undefined], 'nothing is read until the folder is declared');
  assert.equal(store.setProjectFolders([project]), true);
  assert.equal(store.setProjectFolders([project]), false);
  assert.deepEqual(store.profiles('claude').map((p) => [p.id, p.name, p.folder]), [[store.profiles('claude')[0].id, 'A', undefined], ['p1', 'Client', project]]);
  assert.deepEqual(store.scopes(), { privateEnabled: true, projectEnabled: true, folders: [project] });
  assert.deepEqual(await store.credential('claude', 'p1'), login);
  assert.ok(!fs.readFileSync(path.join(f.root, 'profiles.json'), 'utf8').includes('p1'), 'a project profile never reaches profiles.json');
  // A refreshed token goes back to the project file.
  const refreshed = claudeLogin('project2');
  await store.refreshedCredential('claude', 'p1', login, refreshed);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0].credential, refreshed);
  assert.deepEqual(await store.credential('claude', 'p1'), refreshed);
  // A hand-edited file is read again; renames are written back.
  const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
  edited.profiles[0].name = 'Client (edited)';
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(file, JSON.stringify(edited));
  assert.equal(store.profile('claude', 'p1').name, 'Client (edited)');
  store.rename('claude', 'p1', 'Customer');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0].name, 'Customer');
  // With project profiles turned off the folder is left alone and its profiles are not listed.
  config.projectEnabled = false;
  assert.deepEqual(store.profiles('claude').map((p) => p.name), ['A']);
  assert.deepEqual(store.scopes().folders, []);
  config.projectEnabled = true;
  // Deleting a project profile removes it from the file; export includes project profiles.
  assert.deepEqual(store.exportEntries().entries.map((entry) => entry.name), ['A', 'Customer']);
  store.delete('claude', 'p1');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).profiles, []);
  assert.deepEqual(store.profiles('claude').map((p) => p.name), ['A']);
});

test('a new profile may go to a declared project folder, which gets the file, mode 0600, and a .gitignore line', async (t) => {
  const f = fixture(t);
  const { store, config, notices } = projectStore(f);
  const project = path.join(f.root, 'repo');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/');
  await assert.rejects(store.saveNative('claude', { name: 'Client', folder: project }), /not an open project folder/);
  store.setProjectFolders([project]);
  const saved = await store.saveNative('claude', { name: 'Client', folder: project });
  assert.equal(saved.status, 'saved');
  assert.equal(saved.profile.folder, project);
  assert.equal(store.activeProfileId('claude'), saved.profile.id);
  const file = path.join(project, '.ai-usage.profiles.json');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written.profiles.map((p) => [p.provider, p.name, p.email, p.credential.claudeAiOauth.accessToken]), [['claude', 'Client', 'a@example.com', 'a']]);
  if (process.platform !== 'win32') { assert.equal(fs.statSync(file).mode & 0o777, 0o600); }
  assert.equal(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), 'node_modules/\n# AI Usage project profiles hold login tokens\n.ai-usage.profiles.json\n');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Added \.ai-usage\.profiles\.json to repo\/\.gitignore/);
  // The private file keeps only the pointer to the active profile, never the project profile itself.
  const privateFile = JSON.parse(fs.readFileSync(path.join(f.root, 'profiles.json'), 'utf8'));
  assert.equal(privateFile.claude.activeProfileId, saved.profile.id);
  assert.ok(!privateFile.claude.profiles.some((profile) => profile.id === saved.profile.id));
  // An import into a project needs project profiles on; a private one needs private profiles on.
  config.projectEnabled = false;
  await assert.rejects(store.importCredential('claude', 'B', claudeLogin('b'), false, project), /Project profiles are turned off/);
  config.projectEnabled = true;
  config.privateEnabled = false;
  await assert.rejects(store.importCredential('claude', 'B', claudeLogin('b')), /Private profiles are turned off/);
  assert.deepEqual(store.scopes(), { privateEnabled: false, projectEnabled: true, folders: [project] });
  const imported = await store.importCredential('claude', 'B', claudeLogin('b'), false, project);
  assert.equal(imported.profile.folder, project);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).profiles.length, 2);
  // A second save does not touch .gitignore again, nor does a file in an ignored subfolder.
  assert.equal(notices.length, 1);
});

/** A store over the fixture's native files whose identity lookup is `identityOf`. */
const storeWith = (f, identityOf, options) => new ProfileStore(path.join(f.root, 'profiles.json'), (message) => f.logs.push(message), identityOf, options);

test('activation messages say what the user has to do per provider, for automatic and manual switches', () => {
  assert.equal(activationMessage('claude', 'Work', false), 'Claude switched to “Work”. Chats and CLI sessions use it from their next turn.');
  assert.equal(activationMessage('claude', 'Work', true), 'Claude automatically rotated to account “Work”. Chats and CLI sessions use it from their next turn.');
  assert.equal(activationMessage('codex', 'Pro', false), 'Codex switched to “Pro”. New Codex CLI sessions use it now; the Codex VS Code extension needs an extension restart.');
  assert.equal(activationMessage('codex', 'Pro', true), 'Codex automatically rotated to account “Pro”. New Codex CLI sessions use it now; the Codex VS Code extension needs an extension restart.');
  assert.equal(activationMessage('codex', 'Pro', false, true), 'Codex switched to “Pro”. Codex chats and new CLI sessions use it from their next turn.');
  assert.equal(activationMessage('codex', 'Pro', true, true), 'Codex automatically rotated to account “Pro”. Codex chats and new CLI sessions use it from their next turn.');
});

test('a profiles.json that is truncated, garbage or of the wrong shape lists nothing, and its valid entries and size are bounded', async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'profiles.json');
  for (const text of ['', '{"version":1,"claude":{"profiles":[{"id":"x","na', 'not json at all', 'null', '[]', '{"claude":5,"codex":{"profiles":"no"}}']) {
    fs.writeFileSync(file, text);
    assert.deepEqual(f.store.profiles('claude'), [], JSON.stringify(text));
    assert.deepEqual(f.store.profiles('codex'), []);
    assert.equal(f.store.activeProfileId('claude'), undefined);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'reading never rewrites the file');
  }
  // Entries without an id or name are dropped; an active id that is not a string is ignored.
  const entry = (id, name) => ({ id, name, createdAt: 'x', updatedAt: 'x', credential: claudeLogin(id) });
  fs.writeFileSync(file, JSON.stringify({ version: 1, claude: { activeProfileId: 7, profiles: [entry('a', 'A'), { name: 'no id' }, { id: 'b' }, null, 'text', entry('c', 'C')] }, codex: { profiles: [] } }));
  assert.deepEqual(f.store.profiles('claude').map((profile) => profile.id), ['a', 'c']);
  assert.equal(f.store.activeProfileId('claude'), undefined);
  // No more than MAX_PROFILES per provider are read, whatever the file holds.
  fs.writeFileSync(file, JSON.stringify({ version: 1, claude: { profiles: Array.from({ length: MAX_PROFILES + 5 }, (_, i) => entry(`p${i}`, `P${i}`)) }, codex: { profiles: [] } }));
  assert.equal(f.store.profiles('claude').length, MAX_PROFILES);
});

// A corrupt private file is read as "no profiles" and then replaced by the next save, taking every stored login with
// it. Setting the unreadable file aside (as the project profile file is left alone) is the safer behavior; todo
// until the store does that. See the report on the bug.
test('a corrupt profiles.json is kept as a copy before the next profile is saved over it', async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'profiles.json');
  const corrupt = '{"version":1,"claude":{"profiles":[{"id":"x","name":"Precious","credential":{"claudeAiOauth":{"accessToken":"valuable"';
  fs.writeFileSync(file, corrupt);
  await f.store.saveNative('claude', { name: 'Fresh' }).catch(() => undefined);
  const kept = fs.readdirSync(f.root).filter((name) => name.startsWith('profiles.json') && name !== 'profiles.json');
  const holdsOriginal = fs.readFileSync(file, 'utf8') === corrupt || kept.some((name) => fs.readFileSync(path.join(f.root, name), 'utf8') === corrupt);
  assert.ok(holdsOriginal, 'the unreadable file survives somewhere');
});

test('many concurrent imports are all saved through atomic writes that leave a valid private file and no temporary files', async (t) => {
  const f = fixture(t);
  const names = Array.from({ length: 12 }, (_, i) => `Profile ${i}`);
  const outcomes = await Promise.all(names.map((name, i) => f.store.importCredential('claude', name, claudeLogin(`token-${i}`))));
  assert.ok(outcomes.every((outcome) => outcome.status === 'saved'));
  const file = path.join(f.root, 'profiles.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(parsed.claude.profiles.map((profile) => profile.name), names, 'saved in request order, none lost');
  assert.equal(new Set(parsed.claude.profiles.map((profile) => profile.id)).size, 12);
  assert.deepEqual(fs.readdirSync(f.root).filter((name) => name.startsWith('profiles.json')), ['profiles.json']);
  if (process.platform !== 'win32') { assert.equal(fs.statSync(file).mode & 0o777, 0o600); }
  // The same login imported concurrently under different names is kept once.
  const twins = await Promise.all(['Twin A', 'Twin B', 'Twin C'].map((name) => f.store.importCredential('claude', name, claudeLogin('twin'))));
  assert.deepEqual(twins.map((outcome) => outcome.status).sort(), ['duplicate', 'duplicate', 'saved']);
  assert.equal(f.store.profileCount('claude'), 13);
});

test('a private file that cannot be written fails the save without touching the native login or listing the profile', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const backup = await f.store.importCredential('claude', 'Backup', claudeLogin('b'));
  const before = fs.readFileSync(path.join(f.root, 'profiles.json'), 'utf8');
  const nativeBefore = fs.readFileSync(f.nativeClaude, 'utf8');
  // The store's directory is read-only: the temporary file for the atomic write cannot be created.
  t.after(() => { try { fs.chmodSync(f.root, 0o700); } catch { /* Already removed. */ } });
  fs.chmodSync(f.root, 0o500);
  await assert.rejects(f.store.importCredential('claude', 'Third', claudeLogin('c')), /EACCES|permission/i);
  await assert.rejects(f.store.activateProfile('claude', backup.profile.id), /EACCES|permission/i);
  fs.chmodSync(f.root, 0o700);
  assert.equal(fs.readFileSync(path.join(f.root, 'profiles.json'), 'utf8'), before, 'the stored profiles are unchanged');
  assert.deepEqual(f.store.profiles('claude').map((profile) => profile.name), ['Work', 'Backup']);
  assert.equal(f.store.activeProfileId('claude'), work.profile.id, 'the failed switch did not move the active profile');
  // The native login is written before the profile state, so a failed state write leaves them disagreeing until
  // the service follows the native file again; the profile that holds it is found by its token.
  assert.equal(f.readNative(f.nativeClaude).claudeAiOauth.accessToken, 'b');
  assert.notEqual(fs.readFileSync(f.nativeClaude, 'utf8'), nativeBefore);
  assert.equal(await f.store.followNative('claude'), true);
  assert.equal(f.store.activeProfileId('claude'), backup.profile.id);
});

test('an activation that cannot write the native login says so and keeps the previous profile active', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const backup = await f.store.importCredential('claude', 'Backup', claudeLogin('b'));
  // The native path is a directory, which no write can replace.
  fs.rmSync(f.nativeClaude);
  fs.mkdirSync(f.nativeClaude);
  await assert.rejects(f.store.activateProfile('claude', backup.profile.id), /^Error: Could not activate “Backup”: /);
  assert.equal(f.store.activeProfileId('claude'), work.profile.id);
  assert.equal(await f.store.matchesNative('claude', work.profile.id), false, 'an unreadable native login matches nothing');
  assert.equal(await f.store.followNative('claude'), false);
});

test('activating a profile without a usable login or that no longer exists fails before the native file is touched', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const hollow = await f.store.importCredential('claude', 'Hollow', claudeLogin('b'));
  const file = path.join(f.root, 'profiles.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.claude.profiles.find((profile) => profile.id === hollow.profile.id).credential = { claudeAiOauth: {} };
  fs.writeFileSync(file, JSON.stringify(stored));
  const nativeBefore = fs.readFileSync(f.nativeClaude, 'utf8');
  assert.equal(f.store.hasCredential('claude', hollow.profile.id), false);
  await assert.rejects(f.store.activateProfile('claude', hollow.profile.id), /The login of “Hollow” is missing or invalid/);
  await assert.rejects(f.store.activateProfile('claude', 'nope'), /The profile no longer exists/);
  assert.equal(fs.readFileSync(f.nativeClaude, 'utf8'), nativeBefore);
  assert.equal(f.store.activeProfileId('claude'), work.profile.id);
  assert.equal(await f.store.credential('claude', hollow.profile.id), undefined);
  assert.equal(await f.store.credential('claude', 'nope'), undefined);
});

test('a verifier that throws leaves the switch done and reported as unconfirmed', async (t) => {
  const f = fixture(t);
  await f.store.saveNative('claude', { name: 'Work' });
  const backup = await f.store.importCredential('claude', 'Backup', claudeLogin('b'));
  f.store.verifyActivation = async () => { throw new Error('app-server did not start'); };
  const outcome = await f.store.activateProfile('claude', backup.profile.id);
  assert.equal(outcome.level, 'warning');
  assert.equal(outcome.verification.detail, 'app-server did not start');
  assert.match(outcome.message, /switched to “Backup”, but the login could not be confirmed: app-server did not start/);
  assert.equal(f.store.activeProfileId('claude'), backup.profile.id);
  assert.equal(f.readNative(f.nativeClaude).claudeAiOauth.accessToken, 'b');
});

test('switching away from the active profile first captures the tokens its own CLI refreshed, and survives a missing native file', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const backup = await f.store.importCredential('claude', 'Backup', claudeLogin('b'));
  // The CLI refreshed the access token of the active login: same refresh token, new access token.
  const refreshed = { claudeAiOauth: { accessToken: 'a-new', refreshToken: 'r-a', expiresAt: 9999999999999 } };
  fs.writeFileSync(f.nativeClaude, JSON.stringify(refreshed));
  await f.store.activateProfile('claude', backup.profile.id);
  assert.equal((await f.store.credential('claude', work.profile.id)).claudeAiOauth.accessToken, 'a-new');
  assert.ok(f.logs.some((line) => /captured refreshed tokens for profile "Work"/.test(line)));
  // Another owner's login in the native file is never taken for the active profile.
  fs.writeFileSync(f.nativeClaude, JSON.stringify(claudeLogin('stranger')));
  await f.store.activateProfile('claude', work.profile.id);
  assert.equal((await f.store.credential('claude', backup.profile.id)).claudeAiOauth.accessToken, 'b');
  // A missing native file does not stop the switch.
  fs.rmSync(f.nativeClaude);
  const outcome = await f.store.activateProfile('claude', backup.profile.id);
  assert.equal(outcome.level, 'info');
  assert.equal(f.readNative(f.nativeClaude).claudeAiOauth.accessToken, 'b');
});

test('a refreshed token for an inactive, unknown or meanwhile-changed profile is written only where it belongs', async (t) => {
  const f = fixture(t);
  await f.store.saveNative('claude', { name: 'Work' });
  const backup = await f.store.importCredential('claude', 'Backup', claudeLogin('b'));
  const before = claudeLogin('b');
  const after = { claudeAiOauth: { accessToken: 'b2', refreshToken: 'r-b2', expiresAt: 9999999999999 } };
  await f.store.refreshedCredential('claude', 'nope', before, after);
  assert.equal(f.readNative(f.nativeClaude).claudeAiOauth.accessToken, 'a', 'an unknown profile changes nothing');
  await f.store.refreshedCredential('claude', backup.profile.id, claudeLogin('other-before'), after);
  assert.equal((await f.store.credential('claude', backup.profile.id)).claudeAiOauth.accessToken, 'b', 'the stored login changed since it was read');
  await f.store.refreshedCredential('claude', backup.profile.id, before, after);
  assert.equal((await f.store.credential('claude', backup.profile.id)).claudeAiOauth.accessToken, 'b2');
  assert.equal(f.readNative(f.nativeClaude).claudeAiOauth.accessToken, 'a', 'an inactive profile never touches the native login');
  // The active profile's native file is unreadable: the stored copy is left alone.
  const work = f.store.resolve('claude', 'Work');
  fs.rmSync(f.nativeClaude);
  await f.store.refreshedCredential('claude', work.id, claudeLogin('a'), claudeLogin('a3'));
  assert.equal((await f.store.credential('claude', work.id)).claudeAiOauth.accessToken, 'a');
});

test('identity lookups that fail or say nothing never break saving, and later fill in what a profile lacks', async (t) => {
  const f = fixture(t);
  let mode = 'throw';
  const store = storeWith(f, async (provider, credential) => {
    if (mode === 'throw') throw new Error('offline');
    if (mode === 'empty') return {};
    return { email: `${credential.claudeAiOauth.accessToken}@example.com`, accountId: `acc-${credential.claudeAiOauth.accessToken}` };
  });
  assert.deepEqual(await store.identity('claude', claudeLogin('a')), {});
  assert.equal(await store.duplicateOf('claude', claudeLogin('a')), undefined);
  const saved = await store.importCredential('claude', 'Anon', claudeLogin('a'));
  assert.equal(saved.status, 'saved');
  assert.equal(saved.profile.email, undefined);
  assert.equal((await store.duplicateOf('claude', claudeLogin('a'))).name, 'Anon', 'the same login is recognized by its credential');
  assert.deepEqual(store.activeIdentity('claude'), { email: undefined, accountId: undefined });
  await store.backfillEmails('claude');
  assert.equal(store.profile('claude', saved.profile.id).email, undefined, 'a failed lookup leaves the profile as it was');
  mode = 'empty';
  await store.backfillEmails('claude');
  assert.equal(store.profile('claude', saved.profile.id).email, undefined);
  mode = 'ok';
  await store.backfillEmails('claude');
  assert.deepEqual([store.profile('claude', saved.profile.id).email, store.profile('claude', saved.profile.id).accountId], ['a@example.com', 'acc-a']);
  const stamp = store.profile('claude', saved.profile.id).updatedAt;
  await store.backfillEmails('claude');
  assert.equal(store.profile('claude', saved.profile.id).updatedAt, stamp, 'nothing is rewritten when the identity is unchanged');
  fs.writeFileSync(f.nativeClaude, JSON.stringify(claudeLogin('a')));
  await store.saveNative('claude', { id: saved.profile.id });
  assert.deepEqual(store.activeIdentity('claude'), { email: 'a@example.com', accountId: 'acc-a' });
});

test('saving the native login into an existing profile updates it, and a vanished profile is refused', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const backup = await f.store.importCredential('claude', 'Backup', claudeLogin('b'));
  const outcome = await f.store.saveNative('claude', { id: backup.profile.id });
  assert.equal(outcome.status, 'updated');
  assert.equal(outcome.profile.id, backup.profile.id);
  assert.equal(f.store.activeProfileId('claude'), backup.profile.id, 'the profile now holding the native login is the active one');
  assert.equal((await f.store.credential('claude', backup.profile.id)).claudeAiOauth.accessToken, 'a');
  assert.equal((await f.store.credential('claude', work.profile.id)).claudeAiOauth.accessToken, 'a');
  await assert.rejects(f.store.saveNative('claude', { id: 'gone' }), /selected profile no longer exists/);
  await assert.rejects(f.store.replaceCredential('claude', 'gone', claudeLogin('z')), /The profile no longer exists/);
});

test('names, limits and vanished profiles are refused for save, rename, reorder, delete and import', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.store.importCredential('claude', '', claudeLogin('x')), /Enter a profile name/);
  await assert.rejects(f.store.importCredential('claude', 'x'.repeat(61), claudeLogin('x')), /60 characters or fewer/);
  const first = await f.store.importCredential('claude', 'First', claudeLogin('t0'));
  const second = await f.store.importCredential('claude', 'Second', claudeLogin('t1'));
  assert.throws(() => f.store.rename('claude', first.profile.id, ' '), /Enter a profile name/);
  assert.throws(() => f.store.rename('claude', 'gone', 'New'), /The profile no longer exists/);
  assert.throws(() => f.store.rename('claude', first.profile.id, 'SECOND'), /already exists/);
  assert.equal(f.store.rename('claude', first.profile.id, 'FIRST').name, 'FIRST', 'a profile may take another case of its own name');
  assert.throws(() => f.store.reorder('claude', 'gone', 1), /The profile no longer exists/);
  assert.throws(() => f.store.delete('claude', 'gone'), /The profile no longer exists/);
  for (let i = 2; i < MAX_PROFILES; i++) await f.store.importCredential('claude', `Profile ${i}`, claudeLogin(`t${i}`));
  assert.equal(f.store.profileCount('claude'), MAX_PROFILES);
  await assert.rejects(f.store.importCredential('claude', 'One too many', claudeLogin('extra')), /already has the maximum of 20 saved profiles/);
  assert.equal(f.store.profileCount('claude'), MAX_PROFILES);
  assert.equal(f.store.delete('claude', second.profile.id).wasActive, false);
  assert.equal((await f.store.importCredential('claude', 'One more', claudeLogin('extra'))).status, 'saved', 'a freed slot can be used');
});

test('an import that would exceed the profile limit is refused whole, and an export names profiles whose login is missing', async (t) => {
  const f = fixture(t);
  const source = fixture(t);
  const sources = [];
  for (let i = 0; i < 3; i++) sources.push(await source.store.importCredential('claude', `Src ${i}`, claudeLogin(`s${i}`)));
  for (let i = 0; i < MAX_PROFILES - 2; i++) await f.store.importCredential('claude', `Own ${i}`, claudeLogin(`o${i}`));
  const { entries } = source.store.exportEntries();
  assert.equal(entries.length, 3);
  const plans = f.store.planImport(entries);
  await assert.rejects(f.store.applyImport(plans), /Claude has room for 2 more profiles \(20 at most\), but 3 new ones were chosen/);
  assert.equal(f.store.profileCount('claude'), MAX_PROFILES - 2, 'nothing was added');
  // Export honors a selection and reports a profile without a usable login instead of failing.
  const file = path.join(source.root, 'profiles.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.claude.profiles[1].credential = {};
  fs.writeFileSync(file, JSON.stringify(stored));
  const all = source.store.exportEntries();
  assert.deepEqual(all.entries.map((entry) => entry.name), ['Src 0', 'Src 2']);
  assert.deepEqual(all.missing, ['Claude “Src 1”']);
  const chosen = source.store.exportEntries([{ provider: 'claude', id: sources[2].profile.id }]);
  assert.deepEqual(chosen.entries.map((entry) => entry.name), ['Src 2']);
  assert.deepEqual(chosen.missing, []);
});

test('an import asks the vendor only about profiles whose exported metadata lacks an identity', async (t) => {
  const f = fixture(t);
  const lookups = [];
  const store = storeWith(f, async (provider, credential) => { lookups.push(credential.claudeAiOauth.accessToken); return { email: `${credential.claudeAiOauth.accessToken}@example.com`, accountId: `acc-${credential.claudeAiOauth.accessToken}` }; });
  const stamp = '2026-09-01T00:00:00.000Z';
  const entry = (id, name, token, identity = {}) => ({ provider: 'claude', id, name, createdAt: stamp, updatedAt: stamp, credential: claudeLogin(token), ...identity });
  const outcome = await store.applyImport(store.planImport([entry('i1', 'Known', 'k', { email: 'k@example.com', accountId: 'acc-k' }), entry('i2', 'Unknown', 'u')]));
  assert.deepEqual(lookups, ['u']);
  assert.deepEqual(store.profiles('claude').map((profile) => [profile.name, profile.email]), [['Known', 'k@example.com'], ['Unknown', 'u@example.com']]);
  assert.ok(outcome);
});

test('project profile files that are unreadable, missing or odd are skipped and never overwritten, and .gitignore is only edited when it should be', async (t) => {
  const f = fixture(t);
  const { store, notices } = projectStore(f);
  const repo = path.join(f.root, 'repo');
  const missing = path.join(f.root, 'not-there');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const file = path.join(repo, '.ai-usage.profiles.json');
  fs.writeFileSync(file, '{ this is not json');
  store.setProjectFolders([repo, missing]);
  assert.deepEqual(store.profiles('claude'), [], 'neither the broken file nor the missing folder lists anything or throws');
  assert.ok(f.logs.some((line) => line.includes(`project profiles in ${file} were not loaded`)));
  // Saving a profile into the folder with the unreadable file must not replace the file.
  const saved = await store.saveNative('claude', { name: 'Client', folder: repo });
  assert.equal(saved.status, 'saved');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json', 'the user has to fix or remove the file');
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false, 'nothing was written, so nothing is ignored');
  assert.deepEqual(notices, []);
  // The user fixes the file: it is read again, and the profile can be saved.
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(file, JSON.stringify({ aiUsageProfiles: 1, profiles: [] }));
  assert.equal((await store.importCredential('claude', 'Mended', claudeLogin('m'), false, repo)).status, 'saved');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).profiles.map((profile) => profile.name), ['Mended']);
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false, 'the file existed already, so it is not for this write to ignore');
  assert.equal(fs.statSync(file).isFile(), true);
});

test('a project profile file is added to .gitignore once, joined to an existing last line, and left alone when it is already ignored or lies outside the folder', async (t) => {
  const cases = [
    { ignore: undefined, expected: '# AI Usage project profiles hold login tokens\n.ai-usage.profiles.json\n' },
    { ignore: 'dist', expected: 'dist\n# AI Usage project profiles hold login tokens\n.ai-usage.profiles.json\n' },
    { ignore: 'dist\r\n.ai-usage.profiles.json\r\n', expected: 'dist\r\n.ai-usage.profiles.json\r\n' },
    { ignore: '/.ai-usage.profiles.json\n', expected: '/.ai-usage.profiles.json\n' },
    { ignore: 'config/\n', file: 'config/profiles.json', expected: 'config/\n' },
    { ignore: '/config\n', file: 'config/profiles.json', expected: '/config\n' },
    { ignore: 'config/other.json\n', file: 'config/profiles.json', expected: 'config/other.json\n# AI Usage project profiles hold login tokens\nconfig/profiles.json\n' }
  ];
  for (const { ignore, expected, file = '.ai-usage.profiles.json' } of cases) {
    const f = fixture(t);
    const { store, notices } = projectStore(f, { file });
    const repo = path.join(f.root, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    if (ignore !== undefined) fs.writeFileSync(path.join(repo, '.gitignore'), ignore);
    store.setProjectFolders([repo]);
    await store.importCredential('claude', 'P', claudeLogin('p'), false, repo);
    const actual = fs.existsSync(path.join(repo, '.gitignore')) ? fs.readFileSync(path.join(repo, '.gitignore'), 'utf8') : undefined;
    assert.equal(actual, expected, JSON.stringify({ ignore, file }));
    assert.equal(notices.length, expected === ignore ? 0 : 1);
  }
  // A folder that is not a Git repository gets no .gitignore, and a file path outside the folder is not the repository's to ignore.
  const f = fixture(t);
  const plain = path.join(f.root, 'plain');
  fs.mkdirSync(plain);
  const outside = path.join(f.root, 'elsewhere', 'profiles.json');
  const { store: plainStore, notices: plainNotices } = projectStore(f);
  plainStore.setProjectFolders([plain]);
  await plainStore.importCredential('claude', 'P', claudeLogin('p'), false, plain);
  assert.equal(fs.existsSync(path.join(plain, '.gitignore')), false);
  const repo = path.join(f.root, 'repo2');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const { store: outsideStore, notices: outsideNotices } = projectStore(f, { file: outside });
  outsideStore.setProjectFolders([repo]);
  await outsideStore.importCredential('claude', 'Q', claudeLogin('q'), false, repo);
  assert.equal(fs.existsSync(outside), true, 'an absolute file name is used as it is');
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false);
  assert.deepEqual([...plainNotices, ...outsideNotices], []);
});

test('an import plan is described by what applying it would do', () => {
  const plan = (kind, target, name = 'Imported') => ({ kind, target, entry: { name } });
  assert.equal(importOutcome(plan('new')), 'new profile');
  assert.equal(importOutcome(plan('restore', { name: 'Imported' })), 'restores the missing login');
  assert.equal(importOutcome(plan('restore', { name: 'Saved' })), 'restores the missing login of “Saved”');
  assert.equal(importOutcome(plan('replace', { name: 'Imported' })), 'replaces the saved login');
  assert.equal(importOutcome(plan('replace', { name: 'Saved' })), 'replaces the saved login of “Saved”');
  assert.equal(importOutcome(plan('same', { name: 'Imported' })), 'already saved');
  assert.equal(importOutcome(plan('same', { name: 'Saved' })), 'already saved as “Saved”');
});

test('the native login is matched to its profile by account id or e-mail when the refresh token was rotated, and by nothing else', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const rotated = (access) => JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: 'r-rotated', expiresAt: 9999999999999 } });
  fs.writeFileSync(f.nativeClaude, rotated('a'));
  assert.equal(await f.store.matchesNative('claude', work.profile.id), true, 'the token still belongs to the saved account id');
  fs.writeFileSync(f.nativeClaude, rotated('b'));
  assert.equal(await f.store.matchesNative('claude', work.profile.id), false, 'another account id');
  fs.writeFileSync(f.nativeClaude, rotated('unknown'));
  assert.equal(await f.store.matchesNative('claude', work.profile.id), false, 'a token nobody can identify');
  // A profile known only by e-mail matches case-insensitively; one with no identity at all matches only by token.
  const file = path.join(f.root, 'profiles.json');
  const edit = (change) => { const stored = JSON.parse(fs.readFileSync(file, 'utf8')); change(stored.claude.profiles[0]); fs.writeFileSync(file, JSON.stringify(stored)); };
  edit((profile) => { delete profile.accountId; profile.email = 'A@EXAMPLE.COM'; });
  fs.writeFileSync(f.nativeClaude, rotated('a'));
  assert.equal(await f.store.matchesNative('claude', work.profile.id), true);
  edit((profile) => { delete profile.email; });
  assert.equal(await f.store.matchesNative('claude', work.profile.id), false);
  assert.equal(await f.store.matchesNative('claude', 'gone'), false);
});

test('a Codex login whose tokens differ from the saved ones is still followed to the profile that holds its account id', async (t) => {
  const f = fixture(t);
  const saved = await f.store.importCredential('codex', 'Pro', { auth_mode: 'chatgpt', tokens: { access_token: 't', refresh_token: 'r-saved' } });
  const file = path.join(f.root, 'profiles.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.codex.profiles[0].accountId = 'acc-z';
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.equal(f.store.activeProfileId('codex'), undefined);
  fs.writeFileSync(f.nativeCodex, JSON.stringify(codexLogin('acc-z')));
  assert.equal(await f.store.followNative('codex'), true);
  assert.equal(f.store.activeProfileId('codex'), saved.profile.id);
  assert.equal(f.store.nativeIsUnsaved('codex'), false);
  fs.writeFileSync(f.nativeCodex, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x', refresh_token: 'r-other' } }));
  assert.equal(await f.store.followNative('codex'), false);
  assert.equal(f.store.nativeIsUnsaved('codex'), true, 'a login with no account id and no matching token belongs to no profile');
});

test('a profile list that changes while a new profile is being checked is rechecked before the save is committed', async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'profiles.json');
  const entry = (name, i) => ({ id: `p${i}`, name, createdAt: 'x', updatedAt: 'x', credential: claudeLogin(`o${i}`) });
  const write = (claude) => fs.writeFileSync(file, JSON.stringify({ version: 1, claude: { profiles: claude }, codex: { profiles: [] } }));
  let during;
  const store = storeWith(f, async () => { during?.(); return {}; });
  // A profile with the same name appears while the identity is looked up.
  during = () => write([entry('Racer', 1)]);
  await assert.rejects(store.importCredential('claude', 'racer', claudeLogin('new')), /A Claude profile named “racer” already exists/);
  // The list fills up meanwhile.
  during = () => write(Array.from({ length: MAX_PROFILES }, (_, i) => entry(`Full ${i}`, i)));
  await assert.rejects(store.importCredential('claude', 'Late', claudeLogin('new2')), /already has the maximum of 20 saved profiles/);
  assert.equal(store.profileCount('claude'), MAX_PROFILES);
});

test('a disabled profile keeps the flag in the store and its exports, and can be enabled again', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const backup = await f.store.importCredential('claude', 'Backup', claudeLogin('b'));
  assert.equal(f.store.setDisabled('claude', backup.profile.id, true).disabled, true);
  assert.equal(f.store.profile('claude', backup.profile.id).disabled, true);
  assert.ok(!('disabled' in f.store.profile('claude', work.profile.id)), 'an enabled profile carries no flag');
  assert.throws(() => f.store.setDisabled('claude', 'gone', true), /no longer exists/);
  const exported = f.store.exportEntries();
  assert.equal(exported.entries.find((entry) => entry.id === backup.profile.id).disabled, true);
  assert.ok(!('disabled' in exported.entries.find((entry) => entry.id === work.profile.id)));
  // Disabling twice changes nothing; enabling removes the flag.
  const before = f.store.profile('claude', backup.profile.id).updatedAt;
  assert.equal(f.store.setDisabled('claude', backup.profile.id, true).updatedAt, before);
  assert.ok(!('disabled' in f.store.setDisabled('claude', backup.profile.id, false)));
});
