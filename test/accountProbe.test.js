const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probeAccount, isolatedHome, isolatedEnvironment, acquireAccountLock, keepAliveArgs } = require('../out/accountProbe');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function environment(t, key, value) {
  const old = process.env[key];
  process.env[key] = value;
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
}
function fakeCli(root, source) {
  const file = path.join(root, 'fake-cli');
  fs.writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return file;
}

test('background home rejects native home and symlinks pointing to it', t => {
  const root = temporary(t);
  const native = path.join(root, 'native');
  fs.mkdirSync(native);
  environment(t, 'CLAUDE_CONFIG_DIR', native);
  assert.throws(() => isolatedHome('claude', native), /separate/);
  assert.throws(() => isolatedHome('claude', path.join(native, 'nested')), /separate/);
  assert.throws(() => isolatedHome('claude', root), /separate/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(native, path.join(root, 'linked'));
    assert.throws(() => isolatedHome('claude', path.join(root, 'linked')), /separate/);
  }
});

test('isolated environment removes inherited account and routing overrides without mutating process env', t => {
  environment(t, 'ANTHROPIC_API_KEY', 'wrong-account');
  environment(t, 'CLAUDE_CODE_OAUTH_TOKEN', 'wrong-token');
  environment(t, 'OPENAI_BASE_URL', 'https://wrong.example');
  environment(t, 'CODEX_SQLITE_HOME', '/wrong/home');
  const env = isolatedEnvironment('codex', '/dedicated');
  assert.equal(env.CODEX_HOME, '/dedicated');
  assert.equal(env.HOME, '/dedicated');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.CODEX_SQLITE_HOME, undefined);
  assert.equal(process.env.ANTHROPIC_API_KEY, 'wrong-account');
});

test('home lock cannot be stolen while its owner is alive', t => {
  const file = path.join(temporary(t), 'lock');
  const unlock = acquireAccountLock(file);
  assert.equal(typeof unlock, 'function');
  assert.equal(acquireAccountLock(file), undefined);
  unlock();
  const next = acquireAccountLock(file);
  assert.equal(typeof next, 'function');
  next();
});

test('keep-alives use the configured model and exact small prompt', () => {
  for (const provider of ['claude', 'codex']) {
    const args = keepAliveArgs(provider, 'small-model');
    assert.equal(args.at(-1), 'what is date today');
    assert.equal(args[args.indexOf('--model') + 1], 'small-model');
  }
  assert.equal(keepAliveArgs('claude', '')[2], 'haiku');
});

test('Claude swaps only the isolated login, captures refreshed tokens and collects usage after failed call',
  { skip: process.platform === 'win32' }, async t => {
  const root = temporary(t);
  const native = path.join(root, 'native');
  fs.mkdirSync(native);
  environment(t, 'CLAUDE_CONFIG_DIR', native);
  const nativeFile = path.join(native, '.credentials.json');
  fs.writeFileSync(nativeFile, '{"untouched":true}');
  const home = path.join(root, 'claude-tmp');
  const cliPath = fakeCli(root, `
    const fs = require('fs'), path = require('path');
    const home = process.env.CLAUDE_CONFIG_DIR;
    const file = path.join(home, '.credentials.json');
    const auth = JSON.parse(fs.readFileSync(file));
    fs.writeFileSync(path.join(home, 'observed.json'), JSON.stringify({ token: auth.claudeAiOauth.accessToken,
      args: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME, mode: fs.statSync(file).mode & 0o777 }));
    auth.claudeAiOauth.accessToken = 'refreshed';
    fs.writeFileSync(file, JSON.stringify(auth));
    process.exit(1);
  `);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer refreshed');
    return new Response(JSON.stringify({ five_hour: { utilization: 99 }, seven_day: { utilization: 12 } }), { status: 200 });
  };
  const result = await probeAccount('claude', { claudeAiOauth: { accessToken: 'saved' } },
    { home, cliPath, model: 'haiku' }, true, new AbortController().signal);
  assert.equal(result.result.kind, 'ok');
  assert.deepEqual(result.result.usage.windows.map(w => w.usedPercent), [99, 12]);
  assert.equal(result.credential.claudeAiOauth.accessToken, 'refreshed');
  assert.match(result.keepAliveError, /code 1/);
  const observed = JSON.parse(fs.readFileSync(path.join(home, 'observed.json')));
  assert.equal(observed.token, 'saved');
  assert.equal(observed.home, home);
  assert.equal(observed.cwd, home);
  assert.equal(observed.mode, 0o600);
  assert.equal(fs.readFileSync(nativeFile, 'utf8'), '{"untouched":true}');
  assert.equal(fs.existsSync(path.join(home, '.credentials.json')), false);
  assert.equal(fs.existsSync(path.join(home, '.ai-usage.lock')), false);
});

test('Claude restores the saved OAuth credential when its CLI clears the temporary credential file',
  { skip: process.platform === 'win32' }, async t => {
  const root = temporary(t);
  const home = path.join(root, 'claude-tmp');
  const cliPath = fakeCli(root, `
    const fs = require('fs'), path = require('path');
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), '{}');
  `);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer saved');
    return new Response(JSON.stringify({ five_hour: { utilization: 12 }, seven_day: { utilization: 34 } }), { status: 200 });
  };
  const result = await probeAccount('claude', { claudeAiOauth: { accessToken: 'saved', refreshToken: 'refresh' } },
    { home, cliPath, model: 'haiku' }, true, new AbortController().signal);
  assert.equal(result.result.kind, 'ok');
  assert.deepEqual(result.result.usage.windows.map(window => window.usedPercent), [12, 34]);
  assert.equal(result.credential.claudeAiOauth.accessToken, 'saved');
  assert.equal(result.keepAliveError, undefined);
  assert.equal(fs.existsSync(path.join(home, '.credentials.json')), false);
});

test('Codex keep-alive and app-server use the same isolated account and retain both limits',
  { skip: process.platform === 'win32' }, async t => {
  const root = temporary(t);
  const home = path.join(root, 'codex-tmp');
  const cliPath = fakeCli(root, `
    const fs = require('fs'), path = require('path');
    const home = process.env.CODEX_HOME;
    const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json')));
    if (auth.tokens.account_id !== 'account-b') process.exit(2);
    if (process.argv.includes('exec')) {
      fs.writeFileSync(path.join(home, 'called'), 'yes');
    } else {
      require('readline').createInterface({input: process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        console.log(JSON.stringify({id: request.id, result: request.id === 1 ? {} : {
          rateLimits: { primary: { usedPercent: 15.2, windowDurationMins: 300 },
            secondary: { usedPercent: 99, windowDurationMins: 10080 } }
        }}));
      });
    }
  `);
  const result = await probeAccount('codex', { tokens: { access_token: 'test-token', account_id: 'account-b' } },
    { home, cliPath, model: '' }, true, new AbortController().signal);
  assert.equal(result.result.kind, 'ok');
  assert.deepEqual(result.result.usage.windows.map(w => [w.label, w.usedPercent]), [['5h', 15.2], ['7d', 99]]);
  assert.equal(fs.existsSync(path.join(home, 'called')), true);
  assert.equal(fs.existsSync(path.join(home, 'auth.json')), false);
});

test('cancelled keep-alive stops its child and removes staged credentials',
  { skip: process.platform === 'win32' }, async t => {
  const root = temporary(t);
  const home = path.join(root, 'claude-tmp');
  const cliPath = fakeCli(root, 'setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const pending = probeAccount('claude', { claudeAiOauth: { accessToken: 'saved' } },
    { home, cliPath, model: 'haiku' }, true, controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.result.kind, 'unavailable');
  assert.equal(fs.existsSync(path.join(home, '.credentials.json')), false);
});
