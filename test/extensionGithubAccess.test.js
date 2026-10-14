const assert = require('node:assert/strict');
const test = require('node:test');
const g = require('../out/githubAccess');

function auth({ accounts = [], sessions = () => undefined, accountsError } = {}) {
  const calls = [];
  return { calls,
    getAccounts: async () => { if (accountsError) { throw accountsError; } return accounts; },
    getSession: async (provider, scopes, options) => { calls.push({ provider, scopes, options }); return sessions(scopes, options); } };
}

test('the preferred account is matched case-insensitively, else the first', () => {
  const accounts = [{ label: 'Alice', id: '1' }, { label: 'Bob', id: '2' }];
  assert.equal(g.preferredAccount(accounts, 'bob').id, '2');
  assert.equal(g.preferredAccount(accounts, 'carol').id, '1');
  assert.equal(g.preferredAccount(accounts, undefined).id, '1');
  assert.equal(g.preferredAccount([], 'bob'), undefined);
});

test('connecting asks to create a session with the minimal scope for the preferred account and logs the outcome', async () => {
  const logs = [];
  const a = auth({ accounts: [{ label: 'Alice' }, { label: 'Bob' }], sessions: () => ({ accessToken: 't', account: { label: 'Bob' } }) });
  assert.equal(await g.connectGitHub(a, 'BOB', (m) => logs.push(m)), true);
  assert.deepEqual(a.calls, [{ provider: 'github', scopes: ['user:email'], options: { createIfNone: true, account: { label: 'Bob' } } }]);
  assert.deepEqual(logs, ['github: access granted for Bob']);
  const empty = auth({ sessions: () => undefined });
  assert.equal(await g.connectGitHub(empty, '', (m) => logs.push(m)), false);
  assert.equal(empty.calls[0].options.account, undefined);
  assert.equal(logs[1], 'github: access not granted');
});

test('a failing connection is logged and reported as not granted', async () => {
  const logs = [];
  assert.equal(await g.connectGitHub(auth({ accountsError: new Error('no auth') }), undefined, (m) => logs.push(m)), false);
  assert.deepEqual(logs, ['github: access request failed: Error: no auth']);
});

test('silent lookup tries the scope sets in order per account and uses the first session with a token', async () => {
  const logs = [];
  const a = auth({ accounts: [{ label: 'alice' }], sessions: (scopes) => scopes.length === 1 && scopes[0] === 'user:email'
    ? { accessToken: 'tok', account: { label: 'Alice' } } : { accessToken: '', account: { label: 'x' } } });
  assert.deepEqual(await g.getGitHubAccounts(a, (m) => logs.push(m)), [{ login: 'Alice', token: 'tok' }]);
  assert.deepEqual(a.calls.map((call) => call.scopes), [['read:user', 'user:email', 'repo', 'workflow'], ['user:email']]);
  assert.ok(a.calls.every((call) => call.options.silent === true && call.options.account.label === 'alice'));
  assert.equal(logs[0], 'github: 1 account(s) signed in: alice');
});

test('the account label is the fallback login and unreadable scope sets are logged then skipped', async () => {
  const logs = [];
  const a = auth({ accounts: [{ label: 'alice' }], sessions: (scopes) => {
    if (scopes.includes('repo')) { throw new Error('denied'); }
    return { accessToken: 'tok', account: { label: '' } };
  } });
  assert.deepEqual(await g.getGitHubAccounts(a, (m) => logs.push(m)), [{ login: 'alice', token: 'tok' }]);
  assert.ok(logs.includes('github: getSession(read:user user:email repo workflow) for alice failed: Error: denied'));
});

test('without accounts the default session is tried; with nothing signed in the result is empty and the log says why', async () => {
  const logs = [];
  const a = auth({ accounts: [], sessions: () => ({ accessToken: 'tok', account: { label: 'Default' } }) });
  assert.deepEqual(await g.getGitHubAccounts(a, (m) => logs.push(m)), [{ login: 'Default', token: 'tok' }]);
  assert.equal(logs[0], 'github: 0 account(s) signed in: -');
  assert.equal(a.calls[0].options.account, undefined);
  const none = auth({ accountsError: new Error('boom') });
  const noneLogs = [];
  assert.deepEqual(await g.getGitHubAccounts(none, (m) => noneLogs.push(m)), []);
  assert.deepEqual(noneLogs, ['github: getAccounts failed: Error: boom', 'github: 0 account(s) signed in: -',
    'github: no silent session for default account with any known Copilot scope set']);
});

test('remote URLs are read from every url line of a git config', () => {
  const config = '[remote "origin"]\n\turl = git@github.com:acme/app.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[remote "up"]\n  url=https://github.com/other/app\n[core]\n\tbare = false\n';
  assert.deepEqual(g.remoteUrlsFromGitConfig(config), ['git@github.com:acme/app.git', 'https://github.com/other/app']);
  assert.deepEqual(g.remoteUrlsFromGitConfig(''), []);
});

test('owners come from github.com remotes in ssh and https form, deduplicated; other hosts are ignored', () => {
  assert.deepEqual(g.ownersFromRemoteUrls([
    'git@github.com:acme/app.git', 'https://github.com/acme/other', 'https://GitHub.com/Beta/x/', 'https://gitlab.com/gl/proj', 'git@github.com:solo', 'ssh://git@github.com/ssh-org/x.git'
  ]), ['acme', 'Beta', 'ssh-org']);
  assert.deepEqual(g.ownersFromRemoteUrls([]), []);
  assert.deepEqual(g.ownersFromRemoteUrls(new Set(['https://github.com/a/b'])), ['a']);
});
