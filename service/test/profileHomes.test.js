const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileHomes } = require('../out/profileHomes');
const { stagedCredentialPath } = require('../out/accountProbe');
const { applyCodexProxyProvider } = require('../out/codexConfig');

const credential = token => ({ claudeAiOauth: { accessToken: token, refreshToken: `refresh-${token}` } });
function fixture(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-profile-homes-'));
  const previous = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  for (const [key, name] of [['CLAUDE_CONFIG_DIR', 'claude'], ['CODEX_HOME', 'codex']]) {
    process.env[key] = path.join(root, name); fs.mkdirSync(process.env[key]);
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const manager = () => new ProfileHomes(path.join(root, 'state'), key => settings[key]);
  const template = provider => path.join(root, `.${provider}-profile-{number}`);
  return { root, manager, homes: manager(), template };
}

test('homes have no #, reserve saved order, and keep ownership after reorder, restart and deletion', t => {
  const f = fixture(t);
  const b = f.homes.resolve('claude', 'b', ['a', 'b'], f.template('claude'));
  const a = f.homes.resolve('claude', 'a', ['a', 'b'], f.template('claude'));
  assert.equal(path.basename(a), '.claude-profile-1');
  assert.equal(path.basename(b), '.claude-profile-2');
  const restarted = f.manager();
  assert.equal(restarted.resolve('claude', 'a', ['b', 'a'], f.template('claude')), a);
  assert.equal(restarted.resolve('claude', 'b', ['b', 'a'], f.template('claude')), b);
  const c = restarted.resolve('claude', 'c', ['b', 'c'], f.template('claude'));
  assert.equal(path.basename(c), '.claude-profile-3', 'deleted accounts never donate a home to another account');
  assert.equal(path.basename(restarted.resolve('codex', 'x', ['x'], f.template('codex'))), '.codex-profile-1');
  if (process.platform !== 'win32') assert.equal(fs.statSync(a).mode & 0o777, 0o700);
});

test('custom legacy paths get per-account siblings and unrelated folders are never overwritten', t => {
  const f = fixture(t);
  const configured = path.join(f.root, 'staging');
  fs.mkdirSync(`${configured}-profile-1`);
  fs.writeFileSync(path.join(`${configured}-profile-1`, 'auth.json'), 'do not replace');
  const home = f.homes.resolve('codex', 'a', ['a'], configured);
  assert.equal(home, `${configured}-profile-2`);
  assert.equal(fs.readFileSync(path.join(`${configured}-profile-1`, 'auth.json'), 'utf8'), 'do not replace');
});

test('existing ownership markers recover stable homes if the service registry was lost', t => {
  const f = fixture(t);
  const home = f.homes.resolve('claude', 'a', ['a'], f.template('claude'));
  fs.rmSync(path.join(f.root, 'state', 'profile-homes.json'));
  assert.equal(f.manager().resolve('claude', 'a', ['a'], f.template('claude')), home);
});

test('model settings seed once, remove shared proxy/auth routing, and preserve later account edits', t => {
  const f = fixture(t, { 'aiUsage.claudeConfig.env.maxConcurrentSubagents': 3 });
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ model: 'sonnet',
    env: { ANTHROPIC_AUTH_TOKEN: 'another-account', ANTHROPIC_BASE_URL: 'http://proxy', OTHER: 'kept' }, extra: true }));
  const nativeCodex = 'model = "small-model"\nmodel_reasoning_effort = "high"\ncli_auth_credentials_store = "keyring" # native preference\n';
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), applyCodexProxyProvider(nativeCodex,
    { baseUrl: 'http://localhost:9999', secret: 'proxy-secret' }));
  const claude = f.homes.resolve('claude', 'a', ['a'], f.template('claude'));
  const codex = f.homes.resolve('codex', 'a', ['a'], f.template('codex'));
  const settingsFile = path.join(claude, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile));
  assert.equal(settings.model, 'sonnet');
  assert.deepEqual(settings.env, { OTHER: 'kept', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3' });
  assert.equal(settings.extra, true);
  assert.equal(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), nativeCodex.replace('"keyring"', '"file"'));
  assert.match(fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8'), /"keyring"/);
  settings.model = 'custom-account-model'; fs.writeFileSync(settingsFile, JSON.stringify(settings));
  f.manager().resolve('claude', 'a', ['a'], f.template('claude'));
  assert.equal(JSON.parse(fs.readFileSync(settingsFile)).model, 'custom-account-model');
});

test('external CLI refreshes are adopted, store refreshes propagate, and conflicting refreshes remain intact', async t => {
  const f = fixture(t);
  const home = f.homes.resolve('claude', 'a', ['a'], f.template('claude'));
  const file = stagedCredentialPath('claude', home);
  const adopt = async (before, after) => { assert.deepEqual(before, credential('initial')); return after; };
  await f.homes.synchronize('claude', home, credential('initial'), adopt);
  fs.writeFileSync(file, JSON.stringify(credential('external')));
  const external = await f.manager().synchronize('claude', home, credential('initial'), adopt);
  assert.deepEqual(external, credential('external'));
  await f.homes.synchronize('claude', home, credential('store-refreshed'), async () => assert.fail('store updates need no adoption'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), credential('store-refreshed'));
  fs.writeFileSync(file, JSON.stringify(credential('another-cli-refresh')));
  await assert.rejects(f.homes.synchronize('claude', home, credential('another-store-refresh'), adopt), /changed in both/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), credential('another-cli-refresh'));
  f.homes.replace('claude', home, credential('new-sign-in'));
  assert.deepEqual(await f.homes.synchronize('claude', home, credential('new-sign-in'), adopt), credential('new-sign-in'));
});

test('a rejected store compare-and-swap leaves the CLI refresh available for reconciliation', async t => {
  const f = fixture(t);
  const home = f.homes.resolve('claude', 'a', ['a'], f.template('claude'));
  await f.homes.synchronize('claude', home, credential('initial'), async (_, after) => after);
  fs.writeFileSync(stagedCredentialPath('claude', home), JSON.stringify(credential('refreshed')));
  await assert.rejects(f.homes.synchronize('claude', home, credential('initial'), async () => credential('different')), /changed while/);
  assert.deepEqual(JSON.parse(fs.readFileSync(stagedCredentialPath('claude', home))), credential('refreshed'));
  assert.ok(!fs.existsSync(path.join(home, '.ai-usage.lock')));
});
