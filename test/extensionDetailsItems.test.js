const assert = require('node:assert/strict');
const test = require('node:test');
const d = require('../out/detailsItems');
const { NOW, minutes, usage } = require('./helpers/e-fakes');

const SEP = -1;
const env = (overrides = {}) => ({ separator: SEP, now: NOW, host: 'this computer',
  settingsFor: () => ({ source: 'api', checkIntervalMs: 300_000 }), updateIntervalMs: 60_000, ...overrides });
const provider = (id, fields = {}) => ({ id, icon: id, ...fields });
const ok = (u) => ({ kind: 'ok', usage: u });

test('host description names the remote or this computer', () => {
  assert.equal(d.hostDescription(undefined), 'this computer');
  assert.equal(d.hostDescription(''), 'this computer');
  assert.equal(d.hostDescription('ssh-remote'), 'the remote (ssh-remote)');
});

test('the panel title of a provider is its last good title, else the default one', () => {
  assert.equal(d.titleFor({ id: 'claude', lastGood: usage({ title: 'Claude Pro' }) }), 'Claude Pro');
  assert.equal(d.titleFor({ id: 'codex' }), 'Codex');
});

test('no reading yet: header named after the provider id, an Accounts row for Claude and Codex only, and a waiting row', () => {
  assert.deepEqual(d.providerItems(provider('claude', { accountsSummary: () => '2 saved · none active' }), env()), [
    { label: 'claude', kind: SEP },
    { label: '$(key) Accounts', description: '2 saved · none active', detail: 'Save, name, and switch logins, or configure automatic account rotation.', action: 'profiles', providerId: 'claude' },
    { label: '$(clock) Waiting for first reading…' }
  ]);
  assert.deepEqual(d.providerItems(provider('copilot'), env()), [{ label: 'copilot', kind: SEP }, { label: '$(clock) Waiting for first reading…' }]);
});

test('the Accounts row description falls back to the active profile name, then None saved', () => {
  assert.equal(d.providerItems(provider('codex', { activeProfileName: () => 'Work' }), env())[1].description, 'Work');
  assert.equal(d.providerItems(provider('codex'), env())[1].description, 'None saved');
});

test('Copilot without a sign-in offers to connect and stops', () => {
  const items = d.providerItems(provider('copilot', { last: { kind: 'unavailable', provider: 'copilot', reason: 'No GitHub sign-in' } }), env());
  assert.deepEqual(items.slice(1), [{ label: '$(github) Connect GitHub account',
    detail: 'Allow AI Usage to read Copilot quota with the account VS Code is signed in to.', action: 'connect' }]);
});

test('unavailable explains where the login has to be, with the provider specific sign-in hint', () => {
  const items = d.providerItems(provider('codex', { last: { kind: 'unavailable', provider: 'codex' } }), env({ host: 'the remote (ssh-remote)' }));
  assert.equal(items[2].detail, 'Not installed or not signed in the remote (ssh-remote).');
  assert.equal(items[3].label, '$(info) Where the login has to be');
  assert.equal(items[3].detail, 'The extension reads Codex where it runs (the remote (ssh-remote)). In the Agents window that is always your local computer, even for remote sessions. Sign in there with the same account (run `codex login`); limits are per account, so the figures match.');
  const withReason = d.providerItems(provider('claude', { last: { kind: 'unavailable', provider: 'claude', reason: 'no credentials' } }), env());
  assert.equal(withReason[2].detail, 'no credentials');
  assert.match(withReason[3].detail, /run `claude` once and log in/);
  const copilotOther = d.providerItems(provider('copilot', { last: { kind: 'unavailable', provider: 'copilot', reason: 'other' } }), env());
  assert.equal(copilotOther[1].label, '$(circle-slash) Not available');
  assert.match(copilotOther[2].detail, /sign in to GitHub in VS Code/);
});

test('an error without a reading shows the message only; with a reading it adds the age and the figures', () => {
  const bare = d.providerItems(provider('copilot', { last: { kind: 'error', provider: 'copilot', title: 'Copilot', message: 'HTTP 500' } }), env());
  assert.deepEqual(bare, [{ label: 'Copilot', kind: SEP }, { label: '$(warning) Last refresh failed', detail: 'HTTP 500' }]);
  const good = usage({ fetchedAt: NOW });
  const kept = d.providerItems(provider('claude', { last: { kind: 'error', provider: 'claude', title: 'Claude', message: 'offline' }, lastGood: good }), env());
  assert.equal(kept[2].detail, `offline — showing the reading from ${NOW.toLocaleTimeString()}.`);
  assert.equal(kept.length, 4);
});

test('a usage row lists every window, the icon of the worst, the source and the refresh cadence, then the detail lines', () => {
  const u = usage({ plan: 'Max', subtitle: 'me@example.com', details: ['Credits: 5 left', 'Note: with: colons', 'bare'],
    windows: [{ label: '5h', usedPercent: 17, resetsAt: minutes(180) }, { label: '7d', usedPercent: 96, resetsAt: minutes(3 * 1440) }] });
  const items = d.providerItems(provider('claude', { last: ok(u) }), env());
  assert.deepEqual(items, [
    { label: 'Claude · me@example.com · Max', kind: SEP },
    { label: '$(key) Accounts', description: 'None saved', detail: 'Save, name, and switch logins, or configure automatic account rotation.', action: 'profiles', providerId: 'claude' },
    { label: '$(error) 5h 17% (3h) · 7d 96% (3d)', description: `Updated ${NOW.toLocaleTimeString()}`,
      detail: 'Refresh now · service API · checked every 5 min · display refreshed every 1 min', action: 'refreshProvider', providerId: 'claude' },
    { label: '$(info) Credits', description: '5 left' },
    { label: '$(info) Note', description: 'with: colons' },
    { label: '$(info) bare' }
  ]);
});

test('unknown source ids are printed as they are and short intervals in seconds', () => {
  const row = d.providerItems(provider('copilot', { last: ok(usage({ provider: 'copilot', title: 'Copilot', windows: [{ label: 'month', usedPercent: 85 }] })) }),
    env({ settingsFor: () => ({ source: 'custom', checkIntervalMs: 30_000 }), updateIntervalMs: 15_000 }))[1];
  assert.equal(row.label, '$(warning) month 85%');
  assert.equal(row.detail, 'Refresh now · custom · checked every 30s · display refreshed every 0 min');
});

test('the full panel lists all providers, configured accounts, actions, the MCP and service rows, and generic settings', () => {
  const providers = [provider('copilot')];
  const items = d.buildDetailItems(providers, undefined, env(), { configured: true, usage: () => [
    { name: 'Team', period: 'weekly', usedTokens: 900, tokenLimit: 1000, usedBudget: 30, budgetLimit: 20 }] }, () => 'Running');
  assert.deepEqual(items.map((item) => item.label), [
    'copilot', '$(clock) Waiting for first reading…', 'Configured accounts', '$(warning) Team', 'Actions',
    '$(refresh) Refresh now', '$(output) Open log', '$(history) Usage history', '$(plug) Set up MCP server…',
    '$(server-process) Account service…', '$(gear) Settings']);
  assert.deepEqual(items[3], { label: '$(warning) Team', description: '90% used · 100 tokens left', detail: 'weekly · budget 0/20 left' });
  assert.equal(items[9].description, 'Running');
  assert.equal(items[9].action, 'service');
  assert.deepEqual(items[10], { label: '$(gear) Settings', description: 'aiUsage.*', action: 'settings' });
});

test('without configured accounts the section is omitted; the service summary may be missing', () => {
  const items = d.buildDetailItems([provider('copilot')], undefined, env(), { configured: false, usage: () => { throw new Error('not read'); } });
  assert.equal(items.some((item) => item.label === 'Configured accounts'), false);
  assert.equal(items.find((item) => item.action === 'service').description, undefined);
});

test('a focused panel shows one provider, a way back to all, no MCP or service rows, and that provider settings', () => {
  const focused = provider('claude', { lastGood: usage({ title: 'Claude Pro' }) });
  const items = d.buildDetailItems([focused, provider('codex')], focused, env(), { configured: true, usage: () => [] });
  assert.deepEqual(items.map((item) => item.label), [
    'Claude Pro', '$(key) Accounts', '$(pass) 5h 17% (3h) · 7d 26% (3d)', 'Actions', '$(list-flat) Show all providers',
    '$(refresh) Refresh now', '$(output) Open log', '$(history) Usage history', '$(gear) Claude Pro settings']);
  assert.deepEqual(items[8], { label: '$(gear) Claude Pro settings', description: 'aiUsage.claude.*', action: 'settings', providerId: 'claude' });
  assert.equal(items.find((item) => item.label === '$(list-flat) Show all providers').action, 'all');
});
