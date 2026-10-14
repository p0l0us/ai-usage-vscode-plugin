const assert = require('node:assert/strict');
const test = require('node:test');
const si = require('../out/statusItem');
const { api, fakeItem, NOW, minutes, usage } = require('./helpers/e-fakes');

const inputs = (overrides = {}) => ({ barVisible: true, labels: 'iconOnly', usageStyle: 'rich', earnedResetsEnabled: true, now: NOW, ...overrides });
const provider = (id, fields = {}) => ({ id, icon: id === 'claude' ? 'claude' : id === 'codex' ? 'openai' : 'copilot', ...fields });
const ok = (u) => ({ kind: 'ok', usage: u });
const err = (message = 'boom', title = 'Claude') => ({ kind: 'error', provider: 'claude', title, message });

test('click commands: Claude and Codex open their accounts, Copilot the details', () => {
  assert.deepEqual(si.clickCommand('claude'), { command: 'aiUsage.manageAuthProfiles', title: 'Manage accounts', arguments: ['claude'] });
  assert.deepEqual(si.clickCommand('codex'), { command: 'aiUsage.manageAuthProfiles', title: 'Manage accounts', arguments: ['codex'] });
  assert.deepEqual(si.clickCommand('copilot'), { command: 'aiUsage.showDetails', title: 'Show usage details' });
});

test('visibleUsage prefers the live reading and falls back to the last good one', () => {
  const live = usage({ title: 'live' }), good = usage({ title: 'good' });
  assert.equal(si.visibleUsage({ last: ok(live), lastGood: good }), live);
  assert.equal(si.visibleUsage({ last: err(), lastGood: good }), good);
  assert.equal(si.visibleUsage({}), undefined);
});

test('a hidden status bar hides the item whatever the readings are', () => {
  assert.deepEqual(si.statusItemModel(provider('claude', { last: ok(usage()) }), inputs({ barVisible: false })), { visible: false });
});

test('no reading and no diagnostics hides a Claude item; with diagnostics it waits with a clock and the rotation tooltip', () => {
  assert.deepEqual(si.statusItemModel(provider('claude'), inputs()), { visible: false });
  assert.deepEqual(si.statusItemModel(provider('codex', { last: { kind: 'unavailable', provider: 'codex' } }), inputs()), { visible: false });
  const diagnostics = { strategy: 's', trigger: 't', reason: 'r', scoreMeaning: 'm', candidates: [] };
  const model = si.statusItemModel(provider('claude', { diagnostics }), inputs({ labels: 'iconAndName' }));
  assert.deepEqual(model, { visible: true, text: '$(claude) Claude $(clock)', tooltip: { kind: 'rotation', diagnostics } });
  assert.equal('background' in model, false, 'the background is left as it was');
});

test('Copilot without a GitHub sign-in offers to connect; other reasons say n/a with the log hint', () => {
  const needs = si.statusItemModel(provider('copilot', { last: { kind: 'unavailable', provider: 'copilot', reason: 'No GitHub sign-in found' } }), inputs());
  assert.deepEqual(needs, {
    visible: true, text: '$(copilot) connect', command: 'aiUsage.connectGitHub', background: null,
    tooltip: { kind: 'text', text: 'Copilot\nClick to allow AI Usage to read your GitHub Copilot quota with the account VS Code is signed in to.' }
  });
  const na = si.statusItemModel(provider('copilot', { last: { kind: 'unavailable', provider: 'copilot', reason: 'Quota API refused' } }), inputs({ labels: 'nameOnly' }));
  assert.deepEqual(na, {
    visible: true, text: 'Copilot n/a', command: 'aiUsage.showDetails', background: null,
    tooltip: { kind: 'text', text: 'Copilot\nQuota API refused\nSee Output → AI Usage for details.' }
  });
  assert.deepEqual(si.statusItemModel(provider('copilot', { last: { kind: 'unavailable', provider: 'copilot' } }), inputs()), { visible: false },
    'unavailable without a reason hides it');
});

test('an error without any earlier reading shows a warning with the message, the rotation lines and a warning background', () => {
  const model = si.statusItemModel(provider('claude', { last: err('HTTP 500', 'Claude API') }), inputs({ labels: 'nameOnly' }));
  assert.deepEqual(model, { visible: true, text: 'Claude API $(warning)', background: 'warning',
    tooltip: { kind: 'text', text: 'Claude API\nHTTP 500' } });
  const diagnostics = { strategy: 'lowest', trigger: 'limit', reason: 'because', scoreMeaning: 'higher is better', candidates: [
    { active: true, name: 'A', score: 0.5, reason: 'ok', rank: 1 }, { active: false, name: 'B', reason: 'new', rank: 2, fetchedAt: 'yesterday' }] };
  const withDiagnostics = si.statusItemModel(provider('claude', { last: err('x'), diagnostics }), inputs());
  assert.equal(withDiagnostics.tooltip.text,
    'Claude\nx\n\nlowest / limit. because\nhigher is better\nCurrent: A · score 0.500 · ok\n#2: B · score n/a · new Checked yesterday.');
});

test('an ok reading without windows cannot be formatted (the label needs a most used window)', () => {
  assert.throws(() => si.statusItemModel(provider('claude', { last: ok(usage({ windows: [] })) }), inputs()), TypeError);
});

test('a usable reading shows the labelled figures, the usage tooltip and a green background', () => {
  const u = usage();
  const model = si.statusItemModel(provider('claude', { last: ok(u), accountNumber: () => '#2', activeProfileName: () => 'Work' }), inputs());
  assert.deepEqual(model, {
    visible: true, text: '$(claude) #2 17% (3h) 26% (3d)',
    tooltip: { kind: 'usage', usage: u, refreshError: undefined, activeProfile: 'Work', diagnostics: undefined },
    greyed: false, background: null
  });
});

test('the colour thresholds are exactly 80 (warning) and 95 (error) of the most used window', () => {
  const at = (percent) => si.statusItemModel(provider('claude', { last: ok(usage({ windows: [{ label: '5h', usedPercent: percent }] })) }), inputs()).background;
  assert.equal(at(79.4), null);
  assert.equal(at(79.5), 'warning', 'rounds before comparing');
  assert.equal(at(80), 'warning');
  assert.equal(at(94.4), 'warning');
  assert.equal(at(94.5), 'error');
  assert.equal(at(100), 'error');
  assert.equal(at(0), null);
  assert.equal(at(-1), null);
});

test('a reading turns grey at exactly 15 minutes old', () => {
  const fetched = (ageMs) => si.statusItemModel(provider('claude', { last: ok(usage({ fetchedAt: new Date(NOW.getTime() - ageMs) })) }), inputs()).greyed;
  assert.equal(fetched(0), false);
  assert.equal(fetched(15 * 60_000 - 1), false);
  assert.equal(fetched(15 * 60_000), true);
  assert.equal(fetched(60 * 60_000), true);
  assert.equal(fetched(-60_000), false, 'a reading from the future is fresh');
});

test('after a failed refresh the last good reading stays, tooltip carries the error, and simple style shows the most used window', () => {
  const good = usage({ fetchedAt: minutes(-30) });
  const model = si.statusItemModel(provider('claude', { last: err('offline'), lastGood: good }), inputs({ usageStyle: 'simple' }));
  assert.equal(model.text, '$(claude) 26% (3d)');
  assert.equal(model.tooltip.refreshError, 'offline');
  assert.equal(model.greyed, true);
});

test('Codex shows the earned reset count after the figures only when known and enabled', () => {
  const credits = (extra) => usage({ provider: 'codex', title: 'Codex', fetchedAt: NOW, resetCredits: { availableCount: 2, ...extra } });
  const render = (u, overrides) => si.statusItemModel(provider('codex', { last: ok(u) }), inputs({ now: NOW, ...overrides })).text;
  assert.match(render(credits({})), /^\$\(openai\) 17% \(\d+h\) 26% \(3d\) \$\(refresh\) 2$/);
  assert.match(render(credits({ availableCount: 0 })), /\$\(refresh\) 0$/);
  assert.doesNotMatch(render(credits({}), { earnedResetsEnabled: false }), /refresh/);
  assert.doesNotMatch(render(usage({ provider: 'codex', title: 'Codex', fetchedAt: NOW })), /refresh/);
  assert.doesNotMatch(si.statusItemModel(provider('claude', { last: ok(usage({ fetchedAt: NOW, resetCredits: { availableCount: 2 } })) }),
    inputs({ now: NOW })).text, /refresh/, 'only Codex has earned resets');
});

test('the tooltip of a usage reading lists windows with exact resets, the plan, details and the profile', () => {
  const u = usage({ subtitle: 'me@example.com', plan: 'Max', details: ['Extra: 5', 'plain line'], fetchedAt: NOW,
    windows: [{ label: '5h', usedPercent: 17.4, resetsAt: minutes(180) }, { label: '7d Fable', usedPercent: 50 }] });
  const md = si.buildTooltip(new api.MarkdownString(undefined, true), u, NOW, undefined, 'Work');
  assert.equal(md.supportThemeIcons, true);
  assert.equal(md.value,
    '**Claude · me@example.com** · Max\n\n' +
    `- **5-hour window**: 17% used · resets in 3h (${minutes(180).toLocaleString()})\n` +
    '- **7-day window · Fable**: 50% used\n' +
    '\nExtra: 5  \nplain line  \n' +
    `\n_Updated ${NOW.toLocaleTimeString()}_` +
    '\n\n$(key) \\TEXT(Authentication profile: Work)');
});

test('the tooltip without a profile offers to manage them; Copilot has no profile line; errors and rotation lines are added', () => {
  const claude = si.buildTooltip(new api.MarkdownString(), usage({ fetchedAt: minutes(-7) }), NOW, 'HTTP 429');
  assert.match(claude.value, /^\$\(warning\) \*\*Refresh failed\*\* \(HTTP 429\)\. Showing the reading from 7 min ago\.\n\n\*\*Claude\*\*\n\n/);
  assert.match(claude.value, /\$\(key\) \\TEXT\(Manage authentication profiles\)$/);
  const copilot = si.buildTooltip(new api.MarkdownString(), usage({ provider: 'copilot', title: 'Copilot', windows: [{ label: 'month', usedPercent: 1 }] }), NOW);
  assert.doesNotMatch(copilot.value, /\$\(key\)/);
  assert.match(copilot.value, /- \*\*Premium requests \(month\)\*\*: 1% used\n/);
  const diagnostics = { strategy: 'a', trigger: 'b', reason: 'c', scoreMeaning: 'd', candidates: [] };
  const rotated = si.buildTooltip(new api.MarkdownString(), usage(), NOW, undefined, undefined, diagnostics);
  assert.match(rotated.value, /\n\n---\n\n\*\*Rotation diagnostics\*\*\n\n\n\n\\TEXT\(a \/ b\. c\)\n\n\\TEXT\(d\)$/);
});

test('the Codex tooltip reports earned resets as known, stale or unknown', () => {
  const now = new Date();
  const base = { provider: 'codex', title: 'Codex', fetchedAt: now };
  const known = si.buildTooltip(new api.MarkdownString(), usage({ ...base, resetCredits: { availableCount: 2, totalCount: 3, earliestExpiresAt: Math.floor(now.getTime() / 1000) + 3600 } }), now);
  assert.match(known.value, /\n- \*\*Earned resets:\*\* 2 of 3 observed available · next credit expires .+\n/);
  const stale = si.buildTooltip(new api.MarkdownString(), usage({ ...base, fetchedAt: new Date(now.getTime() - 3 * 3600_000), resetCredits: { availableCount: 2 } }), now);
  assert.match(stale.value, /\n- \*\*Earned resets:\*\* Availability stale · last reported 2; current availability unknown\.\n/);
  const unknown = si.buildTooltip(new api.MarkdownString(), usage(base), now);
  assert.match(unknown.value, /\n- \*\*Earned resets:\*\* Availability unknown · not reported in the current account reading\.\n/);
  const plain = si.buildTooltip(new api.MarkdownString(), usage({ ...base, resetCredits: { availableCount: 1 } }), now);
  assert.match(plain.value, /Earned resets:\*\* 1 available\n/);
});

test('applying a model: hidden items are hidden; shown items get text, tooltip, colours and the click command', () => {
  const command = si.clickCommand('claude');
  const hidden = fakeItem();
  si.applyStatusItem(hidden, { visible: false }, command, api, NOW);
  assert.deepEqual([hidden.hidden, hidden.shown, hidden.color, hidden.command, hidden.text], [1, 0, undefined, command, undefined]);

  const item = fakeItem();
  const model = si.statusItemModel(provider('claude', { last: ok(usage({ windows: [{ label: '5h', usedPercent: 97 }], fetchedAt: minutes(-20) })) }), inputs());
  si.applyStatusItem(item, model, command, api, NOW);
  assert.equal(item.text, '$(claude) 97%');
  assert.equal(item.shown, 1);
  assert.equal(item.command, command);
  assert.equal(item.color.id, 'disabledForeground');
  assert.equal(item.backgroundColor.id, 'statusBarItem.errorBackground');
  assert.equal(item.tooltip.supportThemeIcons, true);
  assert.match(item.tooltip.value, /^\*\*Claude\*\*/);
});

test('applying: warning background, cleared background, untouched background, overridden command and plain/rotation tooltips', () => {
  const command = si.clickCommand('copilot');
  const warn = fakeItem();
  si.applyStatusItem(warn, { visible: true, text: 't', tooltip: { kind: 'text', text: 'tip' }, background: 'warning' }, command, api, NOW);
  assert.equal(warn.backgroundColor.id, 'statusBarItem.warningBackground');
  assert.equal(warn.tooltip, 'tip');
  assert.equal(warn.color, undefined);

  const cleared = fakeItem();
  si.applyStatusItem(cleared, { visible: true, text: 't', tooltip: { kind: 'text', text: 'tip' }, background: null, command: 'aiUsage.connectGitHub' }, command, api, NOW);
  assert.equal(cleared.backgroundColor, undefined);
  assert.equal(cleared.command, 'aiUsage.connectGitHub');

  const untouched = fakeItem();
  const diagnostics = { strategy: 's', trigger: 't', reason: 'r', scoreMeaning: 'm', candidates: [] };
  si.applyStatusItem(untouched, { visible: true, text: 't', tooltip: { kind: 'rotation', diagnostics } }, command, api, NOW);
  assert.equal(untouched.backgroundColor, 'untouched');
  assert.equal(untouched.tooltip.value, '\\TEXT(s / t. r)\n\n\\TEXT(m)\n\n');
  assert.equal(untouched.supportThemeIcons, undefined);
});
