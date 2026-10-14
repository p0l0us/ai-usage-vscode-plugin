const assert = require('node:assert/strict');
const test = require('node:test');
const m = require('../out/manualAccounts');
const views = require('../out/accountViews');

const account = (fields = {}) => ({ name: 'Team', period: 'monthly', usedTokens: 250, tokenLimit: 1000, usedBudget: 5, budgetLimit: 20, ...fields });

test('the manual item counts only once a user layer of the setting is set', () => {
  assert.equal(m.hasUserConfiguredAccounts(undefined), false);
  assert.equal(m.hasUserConfiguredAccounts({}), false);
  assert.equal(m.hasUserConfiguredAccounts({ globalValue: [] }), true, 'an empty array is still truthy');
  assert.equal(m.hasUserConfiguredAccounts({ workspaceValue: [account()] }), true);
  assert.equal(m.hasUserConfiguredAccounts({ workspaceFolderValue: [account()] }), true);
  assert.equal(m.hasUserConfiguredAccounts({ globalValue: undefined, workspaceValue: null }), false);
});

test('entries need a name, finite figures and a positive token limit', () => {
  const good = account();
  const bad = [account({ name: '' }), account({ name: undefined }), account({ usedTokens: NaN }), account({ tokenLimit: Infinity }),
    account({ usedBudget: '5' }), account({ budgetLimit: undefined }), account({ tokenLimit: 0 }), account({ tokenLimit: -10 }), null, undefined];
  assert.deepEqual(m.validAccounts([good, ...bad]), [good]);
  assert.deepEqual(m.validAccounts([account({ usedTokens: -5, usedBudget: 0, budgetLimit: 0 })]).length, 1, 'negative usage is accepted as given');
  assert.deepEqual(m.validAccounts([]), []);
});

test('without accounts the summary explains the setting and shows 0 percent', () => {
  assert.deepEqual(m.summarize([]), { remainingPercent: 0, lines: ['No AI usage accounts configured. Set aiUsage.accounts in settings.'] });
  assert.deepEqual(m.manualStatus([]), { text: '$(hubot) AI 0%', tooltip: 'No AI usage accounts configured. Set aiUsage.accounts in settings.' });
});

test('the summary totals tokens across accounts and clamps remaining figures at zero', () => {
  const summary = m.summarize([account({ name: 'A', usedTokens: 250, tokenLimit: 1000 }), account({ name: 'B', period: 'daily', usedTokens: 3000, tokenLimit: 1000, usedBudget: 50, budgetLimit: 20 })]);
  assert.equal(summary.remainingPercent, 0, 'overall overuse clamps at 0');
  assert.deepEqual(summary.lines, [
    `A (monthly) • ${(750).toLocaleString()} tokens left • 15/20 budget left`,
    'B (daily) • 0 tokens left • 0/20 budget left'
  ]);
  assert.equal(m.summarize([account({ usedTokens: 333, tokenLimit: 1000 })]).remainingPercent, 67);
  assert.equal(m.summarize([account({ usedTokens: 0, tokenLimit: 1000 }), account({ usedTokens: 500, tokenLimit: 1000 })]).remainingPercent, 75);
  assert.equal(m.summarize([account({ usedTokens: -100, tokenLimit: 1000 })]).remainingPercent, 110, 'negative usage is not clamped on the high side');
});

test('the manual item text and tooltip come from the summary, one line per account', () => {
  const status = m.manualStatus([account({ name: 'A' }), account({ name: 'A very long account name '.repeat(4).trim(), period: 'weekly' })]);
  assert.equal(status.text, '$(hubot) AI 75%');
  assert.equal(status.tooltip.split('\n').length, 2);
  assert.match(status.tooltip.split('\n')[1], /^A very long account name A very long account name .+ \(weekly\) • /);
});

test('details rows show the used percentage with the threshold icon, tokens left and the budget left', () => {
  assert.deepEqual(m.accountDetailItem(account()), { label: '$(pass) Team', description: `25% used · ${(750).toLocaleString()} tokens left`, detail: 'monthly · budget 15/20 left' });
  assert.equal(m.accountDetailItem(account({ usedTokens: 800 })).label, '$(warning) Team');
  assert.equal(m.accountDetailItem(account({ usedTokens: 950 })).label, '$(error) Team');
  assert.deepEqual(m.accountDetailItem(account({ usedTokens: 1500, usedBudget: 30 })), {
    label: '$(error) Team', description: '150% used · 0 tokens left', detail: 'monthly · budget 0/20 left' });
});

const profile = (fields = {}) => ({ id: 'p1', name: 'Work', active: false, ...fields });
const service = (views, connected = true) => ({ views, connected });
const config = (values = {}) => ({ get: (key, fallback) => (key in values ? values[key] : fallback) });

test('the account number appears only with several saved profiles, a known active one and the setting on', () => {
  const two = { profiles: [profile(), profile({ id: 'p2' })], activeNumber: 2 };
  assert.equal(views.accountNumberLabel(service({ claude: two }), 'claude', config()), '#2');
  assert.equal(views.accountNumberLabel(service({ claude: two }), 'claude', config({ 'aiUsage.claude.statusBar.accountNumber': false })), undefined);
  assert.equal(views.accountNumberLabel(service({ codex: two }), 'codex', config({ 'aiUsage.claude.statusBar.accountNumber': false })), '#2', 'the setting is per service');
  assert.equal(views.accountNumberLabel(service({ claude: { profiles: [profile()], activeNumber: 1 } }), 'claude', config()), undefined);
  assert.equal(views.accountNumberLabel(service({ claude: { profiles: two.profiles } }), 'claude', config()), undefined);
  assert.equal(views.accountNumberLabel(service({}), 'claude', config()), undefined);
});

test('the active profile name is that of the active profile, if any', () => {
  assert.equal(views.activeProfileName(service({ claude: { profiles: [profile(), profile({ id: 'p2', name: 'Home', active: true })] } }), 'claude'), 'Home');
  assert.equal(views.activeProfileName(service({ claude: { profiles: [profile()] } }), 'claude'), undefined);
  assert.equal(views.activeProfileName(service({}), 'codex'), undefined);
});

test('the Accounts summary covers every state of the service and the saved profiles', () => {
  assert.equal(views.accountsSummary(service({}, true), 'claude'), 'Loading…');
  assert.equal(views.accountsSummary(service({}, null), 'claude'), 'Account service not connected');
  assert.equal(views.accountsSummary(service({ claude: { profiles: [profile({ active: true, name: 'Work' })] } }), 'claude'), 'Work');
  assert.equal(views.accountsSummary(service({ claude: { profiles: [] } }), 'claude'), 'None saved');
  assert.equal(views.accountsSummary(service({ claude: { profiles: [profile(), profile({ id: 'b' })], nativeUnsaved: true } }), 'claude'), '2 saved · current login not saved');
  assert.equal(views.accountsSummary(service({ claude: { profiles: [profile()], nativeUnsaved: false } }), 'claude'), '1 saved · none active');
});

test('the active profile usage is deserialized from the saved profile that is active', () => {
  const reading = { provider: 'claude', title: 'Claude', windows: [{ label: '5h', usedPercent: 3, resetsAt: '2026-10-11T15:00:00.000Z' }], fetchedAt: '2026-10-11T12:00:00.000Z' };
  const view = { activeNumber: 1, activeProfileId: 'p2', profiles: [profile({ usage: { ...reading, title: 'wrong' } }), profile({ id: 'p2', usage: reading })] };
  const result = views.accountUsage(service({ claude: view }), 'claude');
  assert.equal(result.title, 'Claude');
  assert.equal(result.fetchedAt.toISOString(), '2026-10-11T12:00:00.000Z');
  assert.equal(result.windows[0].resetsAt.toISOString(), '2026-10-11T15:00:00.000Z');
  assert.equal(views.accountUsage(service({ claude: { ...view, activeNumber: undefined } }), 'claude'), undefined, 'a native login has no profile reading');
  assert.equal(views.accountUsage(service({ claude: { ...view, activeProfileId: 'gone' } }), 'claude'), undefined);
  assert.equal(views.accountUsage(service({}), 'codex'), undefined);
});
