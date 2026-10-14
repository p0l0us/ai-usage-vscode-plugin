const assert = require('node:assert/strict');
const test = require('node:test');
const labels = require('../out/usageLabels');
const { NOW, minutes, usage } = require('./helpers/e-fakes');

const reader = (values) => ({ get: (key, fallback) => (key in values ? values[key] : fallback) });

test('status bar and chip style default to icon-only rich labels and named chips', () => {
  assert.deepEqual(labels.statusBarStyle(reader({})), { labels: 'iconOnly', usage: 'rich' });
  assert.deepEqual(labels.statusBarStyle(reader({ 'aiUsage.statusBar.labels': 'none', 'aiUsage.statusBar.usage': 'simple' })), { labels: 'none', usage: 'simple' });
  assert.deepEqual(labels.chipStyle(reader({})), { named: true, usage: 'rich' });
  assert.deepEqual(labels.chipStyle(reader({ 'aiUsage.chatChips.labels': 'icon', 'aiUsage.chatChips.usage': 'simple' })), { named: false, usage: 'simple' });
});

test('the status bar is visible only when enabled here and shown by VS Code (an explicit false hides it)', () => {
  assert.equal(labels.statusBarVisible(reader({})), true);
  assert.equal(labels.statusBarVisible(reader({ 'aiUsage.statusBar.enabled': false })), false);
  assert.equal(labels.statusBarVisible(reader({ 'workbench.statusBar.visible': false })), false);
  assert.equal(labels.statusBarVisible(reader({ 'workbench.statusBar.visible': undefined })), true);
});

test('the update interval has a 15 second floor and defaults to one minute', () => {
  assert.equal(labels.updateIntervalMs(reader({})), 60_000);
  assert.equal(labels.updateIntervalMs(reader({ 'aiUsage.updateIntervalMinutes': 0.1 })), 15_000);
  assert.equal(labels.updateIntervalMs(reader({ 'aiUsage.updateIntervalMinutes': -5 })), 15_000);
  assert.equal(labels.updateIntervalMs(reader({ 'aiUsage.updateIntervalMinutes': 5 })), 300_000);
});

test('intervals under a minute show seconds, others whole minutes', () => {
  assert.equal(labels.formatInterval(15_000), '15s');
  assert.equal(labels.formatInterval(59_999), '60s');
  assert.equal(labels.formatInterval(60_000), '1 min');
  assert.equal(labels.formatInterval(90_000), '2 min');
});

test('window names are spelled out, with model-scoped weekly windows keeping their scope', () => {
  assert.equal(labels.windowName('5h'), '5-hour window');
  assert.equal(labels.windowName('7d'), '7-day window');
  assert.equal(labels.windowName('month'), 'Premium requests (month)');
  assert.equal(labels.windowName('chat'), 'Chat');
  assert.equal(labels.windowName('completions'), 'Completions');
  assert.equal(labels.windowName('7d Fable'), '7-day window · Fable');
  assert.equal(labels.windowName('7d '), '7d ');
  assert.equal(labels.windowName('weird'), 'weird');
});

test('usage icons switch exactly at 80 and 95 percent', () => {
  assert.equal(labels.usageIcon(79.99), '$(pass)');
  assert.equal(labels.usageIcon(80), '$(warning)');
  assert.equal(labels.usageIcon(94.99), '$(warning)');
  assert.equal(labels.usageIcon(95), '$(error)');
  assert.equal(labels.usageIcon(-3), '$(pass)');
  assert.equal(labels.usageIcon(NaN), '$(pass)');
});

test('the worst percentage is the rounded maximum over all windows', () => {
  assert.equal(labels.worstPercent(usage()), 26);
  assert.equal(labels.worstPercent(usage({ windows: [{ label: 'x', usedPercent: 79.5 }] })), 80);
  assert.equal(labels.worstPercent(usage({ windows: [{ label: 'x', usedPercent: -4 }] })), -4);
  assert.equal(labels.worstPercent(usage({ windows: [] })), -Infinity);
});

test('usage labels show a rounded percentage with the compact reset countdown', () => {
  const u = usage();
  assert.equal(labels.usagePart(u.windows[0], NOW), '17% (3h)');
  assert.equal(labels.usagePart(u.windows[1], NOW), '26% (3d)');
  assert.equal(labels.usagePart({ label: 'x', usedPercent: 3 }, NOW), '3%', 'no reset time, no parentheses');
  assert.equal(labels.usagePart({ label: 'x', usedPercent: 3, resetsAt: minutes(-5) }, NOW), '3% (0m)', 'a reset in the past clamps to 0m');
  assert.equal(labels.usagePart({ label: 'x', usedPercent: 3, resetsAt: minutes(59) }, NOW), '3% (59m)');
  assert.equal(labels.usagePart({ label: 'x', usedPercent: 3, resetsAt: minutes(60) }, NOW), '3% (1h)');
  assert.equal(labels.usagePart({ label: 'x', usedPercent: 3, resetsAt: minutes(24 * 60) }, NOW), '3% (1d)');
  assert.equal(labels.usagePart({ label: 'x', usedPercent: NaN }, NOW), 'NaN%');
});

test('rich labels show at most two windows; simple shows only the most used one', () => {
  const three = usage({ windows: [
    { label: '5h', usedPercent: 10, resetsAt: minutes(30) },
    { label: '7d', usedPercent: 40, resetsAt: minutes(60 * 48) },
    { label: '7d Fable', usedPercent: 90, resetsAt: minutes(60 * 100) }
  ] });
  assert.equal(labels.formatUsageLabel(three, true, 'rich', NOW), 'Claude 10% (30m) 40% (2d)');
  assert.equal(labels.formatUsageLabel(three, false, 'rich', NOW), '10% (30m) 40% (2d)');
  assert.equal(labels.formatUsageLabel(three, true, 'simple', NOW), 'Claude 90% (4d)');
  assert.equal(labels.formatUsageLabel(three, false, 'simple', NOW), '90% (4d)');
  const tie = usage({ windows: [{ label: 'a', usedPercent: 50 }, { label: 'b', usedPercent: 50, resetsAt: minutes(5) }] });
  assert.equal(labels.formatUsageLabel(tie, false, 'simple', NOW), '50%', 'the first of equally used windows wins');
  assert.throws(() => labels.formatUsageLabel(usage({ windows: [] })), TypeError);
});

test('status text puts icon, name and account number before the body according to the label style', () => {
  assert.equal(labels.statusText('iconOnly', 'claude', undefined, '17%', 'Claude'), '$(claude) 17%');
  assert.equal(labels.statusText('none', 'claude', undefined, '17%', 'Claude'), '17%');
  assert.equal(labels.statusText('nameOnly', 'claude', '#2', '17%', 'Claude'), 'Claude #2 17%');
  assert.equal(labels.statusText('iconAndName', 'openai', '#1', '17%', 'Codex'), '$(openai) Codex #1 17%');
  assert.equal(labels.statusText('iconAndName', 'openai', undefined, '17%'), '$(openai) 17%', 'no title, no name');
  assert.equal(labels.statusText('none', 'claude', undefined, ''), '', 'trailing space is trimmed');
  assert.equal(labels.statusText('iconAndName', 'copilot', undefined, '', 'Copilot'), '$(copilot) Copilot');
  assert.equal(labels.statusText('none', 'claude', '#3', 'x'.repeat(3), 'A very long account name that goes on'), '#3 xxx');
});

test('the visible reading is the live one on success, otherwise the last good one', () => {
  const live = usage({ title: 'live' }), good = usage({ title: 'good' });
  assert.equal(labels.visibleUsageOf({ kind: 'ok', usage: live }, good), live);
  assert.equal(labels.visibleUsageOf({ kind: 'error', provider: 'claude', title: 'C', message: 'm' }, good), good);
  assert.equal(labels.visibleUsageOf({ kind: 'unavailable', provider: 'claude' }, undefined), undefined);
  assert.equal(labels.visibleUsageOf(undefined, good), good);
});

const entries = (map) => Object.fromEntries(map);

test('chip context keys: rich mode sets one key per configured window, rounded', () => {
  assert.deepEqual(entries(labels.chipContextValues('claude', true, { kind: 'ok', usage: usage() }, usage(), true)),
    { simple: undefined, '5h': '17', '7d': '26' });
});

test('chip context keys: simple mode and providers without rich windows set the single figure', () => {
  assert.deepEqual(entries(labels.chipContextValues('claude', true, undefined, usage(), false)),
    { simple: '26', '5h': undefined, '7d': undefined });
  const copilot = usage({ provider: 'copilot', windows: [{ label: 'month', usedPercent: 41.5 }] });
  assert.deepEqual(entries(labels.chipContextValues('copilot', true, undefined, copilot, true)), { simple: '42' });
  const unlisted = usage({ windows: [{ label: '7d Fable', usedPercent: 99.4 }] });
  assert.deepEqual(entries(labels.chipContextValues('codex', true, undefined, unlisted, true)),
    { simple: '99', '5h': undefined, '7d': undefined }, 'a reading with no chip window falls back to the single figure');
});

test('chip context keys: only windows that have a generated command are published in rich mode', () => {
  const partial = usage({ windows: [{ label: '7d', usedPercent: 5 }, { label: '7d Fable', usedPercent: 60 }] });
  assert.deepEqual(entries(labels.chipContextValues('claude', true, undefined, partial, true)),
    { simple: undefined, '5h': undefined, '7d': '5' });
});

test('chip context keys: states for no reading, unavailable, error, empty windows, and everything unset when disabled', () => {
  assert.equal(labels.chipContextValues('claude', true, undefined, undefined, true).get('simple'), 'pending');
  assert.equal(labels.chipContextValues('claude', true, { kind: 'unavailable', provider: 'claude' }, undefined, true).get('simple'), 'unavailable');
  assert.equal(labels.chipContextValues('claude', true, { kind: 'error', provider: 'claude', title: 'C', message: 'm' }, undefined, true).get('simple'), 'error');
  assert.equal(labels.chipContextValues('claude', true, undefined, usage({ windows: [] }), true).get('simple'), 'pending',
    'a reading without windows counts as no reading');
  assert.deepEqual(entries(labels.chipContextValues('claude', false, undefined, usage(), true)),
    { simple: undefined, '5h': undefined, '7d': undefined });
  assert.deepEqual([...labels.chipContextValues('copilot', false, undefined, undefined, true).keys()], ['simple']);
});

test('CHIP_WINDOWS matches the windows the manifest generator creates commands for', () => {
  const generator = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'scripts', 'generate-manifest.js'), 'utf8');
  for (const [id, windows] of Object.entries(labels.CHIP_WINDOWS)) {
    assert.match(generator, new RegExp(`id: '${id}'.*windows: \\[${windows.map((w) => `'${w}'`).join(', ')}\\]`));
  }
  assert.equal(labels.CHIP_COMMAND_PREFIX, 'aiUsage.chip.');
  assert.equal(labels.CHAT_TOKEN_COMMAND_PREFIX, 'aiUsage.chatTokens.chip.');
});

test('chips show in a regular window per the workbench mode', () => {
  assert.equal(labels.chipsInWorkbench('always', true, true), true);
  assert.equal(labels.chipsInWorkbench('always', false, false), false);
  assert.equal(labels.chipsInWorkbench('whenNoStatusBar', true, false), true);
  assert.equal(labels.chipsInWorkbench('whenNoStatusBar', true, true), false);
  assert.equal(labels.chipsInWorkbench('never', true, false), false);
  assert.equal(labels.chipsInWorkbench('whenNoStatusBar', false, false), false);
});

test('chip commands route to their provider, unknown providers and the debug chip to all providers', () => {
  const commands = [
    { command: 'aiUsage.chip.claude.simple' }, { command: 'aiUsage.chip.codex.5h' }, { command: 'aiUsage.chip.debug' },
    { command: 'aiUsage.chip.named' }, { command: 'aiUsage.refresh' }, { command: 'aiUsage.chatTokens.chip.claude' }
  ];
  assert.deepEqual(labels.chipCommands(commands, new Set(['claude', 'codex', 'copilot'])), [
    { command: 'aiUsage.chip.claude.simple', target: 'claude' }, { command: 'aiUsage.chip.codex.5h', target: 'codex' },
    { command: 'aiUsage.chip.debug', target: undefined }, { command: 'aiUsage.chip.named', target: undefined }
  ]);
  assert.deepEqual(labels.chipCommands([], new Set()), []);
});

test('token chip commands exist only for Claude and Codex', () => {
  assert.deepEqual(labels.chatTokenChipCommands([
    { command: 'aiUsage.chatTokens.chip.claude' }, { command: 'aiUsage.chatTokens.chip.codex.x' },
    { command: 'aiUsage.chatTokens.chip.copilot' }, { command: 'aiUsage.chip.claude.simple' }
  ]), [
    { command: 'aiUsage.chatTokens.chip.claude', providerId: 'claude' }, { command: 'aiUsage.chatTokens.chip.codex.x', providerId: 'codex' }
  ]);
});

test('the chat token message gives the totals, input with cached figure only when non-zero, and the missing-data notice', () => {
  assert.equal(labels.chatTokensMessage('claude', { totalTokens: 12345, inputTokens: 10000, cachedInputTokens: 2000, outputTokens: 2345 }),
    `Claude chat: ${(12345).toLocaleString()} tokens · ${(10000).toLocaleString()} input (${(2000).toLocaleString()} cached) · ${(2345).toLocaleString()} output`);
  assert.equal(labels.chatTokensMessage('codex', { totalTokens: 5, inputTokens: 3, cachedInputTokens: 0, outputTokens: 2 }),
    'Codex chat: 5 tokens · 3 input · 2 output');
  assert.equal(labels.chatTokensMessage('codex', { totalTokens: 5, inputTokens: 3, outputTokens: 2 }), 'Codex chat: 5 tokens · 3 input · 2 output');
  assert.equal(labels.chatTokensMessage('claude', undefined), 'AI Usage: no Claude token data was found for this workspace.');
  assert.equal(labels.chatTokensMessage('codex', undefined), 'AI Usage: no Codex token data was found for this workspace.');
});

test('provider titles, sign-in hints, source labels and thresholds are the documented ones', () => {
  assert.deepEqual(labels.PROVIDER_TITLES, { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' });
  assert.equal(labels.SIGN_IN_HINTS.claude, 'run `claude` once and log in');
  assert.equal(labels.SIGN_IN_HINTS.codex, 'run `codex login`');
  assert.equal(labels.SIGN_IN_HINTS.copilot, 'sign in to GitHub in VS Code');
  assert.equal(Object.keys(labels.SOURCE_LABELS).length, 6);
  assert.equal(labels.SOURCE_LABELS.both, 'local file, service API when stale');
  assert.equal(labels.SOURCE_LABELS.auto, 'automatic source selection');
  assert.equal(labels.STALE_AFTER_MS, 900_000);
  assert.equal(labels.WARNING_PERCENT, 80);
  assert.equal(labels.ERROR_PERCENT, 95);
});
