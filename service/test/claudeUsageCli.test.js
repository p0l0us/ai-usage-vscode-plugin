const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fetchClaudeUsageCli } = require('../out/live');

const ACCOUNT = '11111111-2222-3333-4444-555555555555';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-claude-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A home holding only what the readers look at: the login, and the account file Claude Code keeps. */
function home(root, { credentials = true, account = true } = {}) {
  const dir = path.join(root, 'home');
  fs.mkdirSync(dir, { recursive: true });
  if (credentials) {
    fs.writeFileSync(path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'token', subscriptionType: 'max' } }));
  }
  const file = path.join(dir, '.claude.json');
  if (account) {
    fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT } }));
  }
  return { dir, file };
}

/** Stands in for `claude`: `body` runs with `file` in scope, so it can write the cache or fail. */
function fakeCli(root, body) {
  const cli = path.join(root, 'fake-claude');
  fs.writeFileSync(cli, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return cli;
}

const writesCache = (file, utilization) => `
const fs = require('fs');
const file = ${JSON.stringify(file)};
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
data.cachedUsageUtilization = {
  fetchedAtMs: Date.now(),
  accountUuid: ${JSON.stringify(ACCOUNT)},
  utilization: ${JSON.stringify(utilization)}
};
fs.writeFileSync(file, JSON.stringify(data));
console.log('Current session: 41% used');
`;

test('runs /usage and reports the reading it caused Claude Code to cache', async (t) => {
  const root = temporary(t);
  const { dir, file } = home(root);
  const cli = fakeCli(root, writesCache(file, {
    five_hour: { utilization: 41, resets_at: '2026-09-22T23:00:00Z' },
    seven_day: { utilization: 56, resets_at: '2026-09-26T20:00:00Z' }
  }));

  const result = await fetchClaudeUsageCli(cli, dir, file);

  assert.equal(result.kind, 'ok');
  assert.deepEqual(result.usage.windows.map((w) => [w.label, w.usedPercent]), [['5h', 41], ['7d', 56]]);
  assert.equal(result.usage.plan, 'max');
  assert.deepEqual(result.usage.details, ['Source: Claude Code CLI (/usage)']);
});

test('asks for the non-interactive /usage without loading anything of the user own', async (t) => {
  const root = temporary(t);
  const { dir, file } = home(root);
  const args = path.join(root, 'args.json');
  const cli = fakeCli(root, `
require('fs').writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2)));
${writesCache(file, { five_hour: { utilization: 7 } })}
`);

  await fetchClaudeUsageCli(cli, dir, file);
  const passed = JSON.parse(fs.readFileSync(args, 'utf8'));

  assert.equal(passed.at(-1), '/usage');
  // --print is what selects the headless command; the rest keeps a background reading from
  // running the user's hooks, MCP servers or leaving a session behind.
  assert.ok(passed.includes('--print'));
  assert.ok(passed.includes('--strict-mcp-config'));
  assert.ok(passed.includes('--no-session-persistence'));
  assert.equal(passed[passed.indexOf('--settings') + 1], '{"disableAllHooks":true}');
  assert.equal(passed[passed.indexOf('--setting-sources') + 1], '');
});

test('a missing CLI names the setting rather than failing silently', async (t) => {
  const root = temporary(t);
  const { dir, file } = home(root);

  const result = await fetchClaudeUsageCli(path.join(root, 'absent'), dir, file);

  assert.equal(result.kind, 'error');
  assert.match(result.message, /aiUsage\.claude\.cliPath/);
  assert.ok(!result.transient, 'a missing CLI will not fix itself on the next check');
});

test('the CLI is never started when there is no login to read', async (t) => {
  const root = temporary(t);
  const { dir, file } = home(root, { credentials: false });
  const ran = path.join(root, 'ran');
  const cli = fakeCli(root, `require('fs').writeFileSync(${JSON.stringify(ran)}, 'x');`);

  const result = await fetchClaudeUsageCli(cli, dir, file);

  assert.equal(result.kind, 'unavailable');
  assert.equal(fs.existsSync(ran), false);
});

test('a run that caches nothing is reported with what the CLI said', async (t) => {
  const root = temporary(t);
  const { dir, file } = home(root);
  const cli = fakeCli(root, "console.log('Usage limits are not available for this account');");

  const result = await fetchClaudeUsageCli(cli, dir, file);

  assert.equal(result.kind, 'error');
  assert.match(result.message, /not available for this account/);
  assert.ok(result.transient);
});

test('a failing CLI is reported with its own message and stays retryable', async (t) => {
  const root = temporary(t);
  const { dir, file } = home(root);
  const cli = fakeCli(root, "console.log('Invalid API key · Please run /login'); process.exit(1);");

  const result = await fetchClaudeUsageCli(cli, dir, file);

  assert.equal(result.kind, 'error');
  assert.match(result.message, /Invalid API key/);
  assert.ok(result.transient);
});

test('a cache left behind by the previous account is not reported as the new one usage', async (t) => {
  const root = temporary(t);
  const { dir, file } = home(root);
  // What Claude Code leaves when it has not yet answered for the freshly activated login.
  const cli = fakeCli(root, `
const fs = require('fs');
const file = ${JSON.stringify(file)};
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
data.cachedUsageUtilization = {
  fetchedAtMs: Date.now(),
  accountUuid: 'a-different-account',
  utilization: { five_hour: { utilization: 99 } }
};
fs.writeFileSync(file, JSON.stringify(data));
console.log('Current session: 99% used');
`);

  const result = await fetchClaudeUsageCli(cli, dir, file);

  assert.equal(result.kind, 'error');
  assert.ok(result.transient);
});
