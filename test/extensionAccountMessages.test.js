const assert = require('node:assert/strict');
const test = require('node:test');
const m = require('../out/accountMessages');
const { readableProblem } = require('../service/out');
const h = require('../out/historyMenu');
const mcp = require('../out/mcpSetupItems');

test('provider and account labels', () => {
  assert.equal(m.providerTitle('claude'), 'Claude');
  assert.equal(m.providerTitle('codex'), 'Codex');
  assert.equal(m.accountLabel('Work', 'me@example.com'), '“Work” (me@example.com)');
  assert.equal(m.accountLabel('Work'), '“Work”');
  assert.equal(m.accountLabel('A very long account name '.repeat(5).trim()), `“${'A very long account name '.repeat(5).trim()}”`);
});

test('a successful keep-alive is an information notice, a failed or partial one a warning', () => {
  assert.deepEqual(m.keepAliveOutcome('claude', 'Work', { usage: {} }),
    { message: 'AI Usage: Claude keep-alive completed for “Work”. Usage statistics updated.', severity: 'info', dead: false });
  const noUsage = m.keepAliveOutcome('codex', 'Work', {});
  assert.deepEqual(noUsage, { message: 'AI Usage: Codex keep-alive completed for “Work”, but usage statistics could not be updated.', severity: 'warning', dead: false });
  const withError = m.keepAliveOutcome('codex', 'Work', { usageError: 'HTTP 500' });
  assert.equal(withError.message, `AI Usage: Codex keep-alive completed for “Work”, but usage statistics could not be updated: ${readableProblem('HTTP 500')}`);
  assert.equal(withError.severity, 'warning');
});

test('a failed keep-alive says whether usage was still updated and whether a new sign-in is the only way out', () => {
  const failed = m.keepAliveOutcome('claude', 'Work', { keepAliveError: 'network down', usage: {} });
  assert.equal(failed.message, `AI Usage: Claude keep-alive failed for “Work”: ${readableProblem('network down')} Usage statistics were still updated.`);
  assert.equal(failed.severity, 'warning');
  assert.equal(failed.dead, false);
  const dead = m.keepAliveOutcome('claude', 'Work', { keepAliveError: 'invalid_grant: refresh token revoked' });
  assert.equal(dead.dead, true, 'a revoked login needs a new sign-in');
  const usageDead = m.keepAliveOutcome('claude', 'Work', { keepAliveError: 'network down', usageError: 'invalid_grant: refresh token revoked' });
  assert.equal(usageDead.dead, true);
  assert.match(usageDead.message, /Usage statistics could not be updated either: /);
  const sameError = m.keepAliveOutcome('claude', 'Work', { keepAliveError: 'invalid_grant: refresh token revoked', usageError: 'invalid_grant: refresh token revoked' });
  assert.doesNotMatch(sameError.message, /either/);
  const deadButUsage = m.keepAliveOutcome('codex', 'Work', { usage: {}, usageError: 'invalid_grant: refresh token revoked' });
  assert.equal(deadButUsage.severity, 'warning', 'a dead login is never a success notice');
});

test('a keep-alive that could not be sent names the readable problem', () => {
  assert.match(m.keepAliveNotSentMessage('claude', 'Work', new Error('The account service is unavailable')), /^AI Usage: Claude keep-alive for “Work” not sent: .+/);
  assert.match(m.keepAliveNotSentMessage('codex', 'Work', 'plain'), /Codex keep-alive for “Work” not sent: plain/);
});

test('a sweep summary counts successes, skipped accounts and lists problems', () => {
  const clean = m.keepAliveSweepOutcome('claude', { results: [{ id: 'a', name: 'A', usage: {} }, { id: 'b', name: 'B', usage: {} }], done: 2, total: 2, cancelled: false });
  assert.deepEqual(clean, { message: 'AI Usage: Claude keep-alive sent to 2 of 2 accounts. Usage statistics updated.', severity: 'info' });
  const cancelled = m.keepAliveSweepOutcome('codex', { results: [{ id: 'a', name: 'A', usage: {} }], done: 1, total: 3, cancelled: true });
  assert.equal(cancelled.message, 'AI Usage: Codex keep-alive sent to 1 of 3 accounts (2 cancelled). Usage statistics updated.');
  const blocked = m.keepAliveSweepOutcome('codex', { results: [], done: 0, total: 2, cancelled: false, blocked: 'a sign-in is needed' });
  assert.equal(blocked.message, 'AI Usage: Codex keep-alive sent to 0 of 2 accounts (2 not sent: a sign-in is needed). Usage statistics updated.');
  const stopped = m.keepAliveSweepOutcome('codex', { results: [], done: 0, total: 1, cancelled: false });
  assert.match(stopped.message, /\(1 not sent: the sweep stopped\)/);
  const problems = m.keepAliveSweepOutcome('claude', { results: [{ id: 'a', name: 'A', error: 'gone' }, { id: 'b', name: 'B', keepAliveError: 'x' },
    { id: 'c', name: 'C', usageError: 'y' }, { id: 'd', name: 'D' }, { id: 'e', name: 'E', usage: {} }], done: 5, total: 5, cancelled: false });
  assert.equal(problems.severity, 'warning');
  assert.match(problems.message, /^AI Usage: Claude keep-alive sent to 1 of 5 accounts\. Problems: “A”: .*gone.*; “B”: .*x.*; “C”: .*y.*; “D”: .*usage statistics could not be updated.*$/);
  assert.doesNotMatch(problems.message, /Usage statistics updated/);
});

test('account problem notices differ for a revoked login and a failed keep-alive', () => {
  const event = { provider: 'claude', name: 'Work', email: 'me@example.com', readable: 'Sign in again.' };
  assert.equal(m.accountProblemMessage({ ...event, revoked: true }),
    'AI Usage: the saved Claude login for “Work” (me@example.com) no longer works and cannot be used or rotated to: Sign in again.');
  assert.equal(m.accountProblemMessage({ ...event, provider: 'codex', email: undefined, revoked: false }),
    'AI Usage: automatic rotation will not switch to the Codex account “Work”: its keep-alive failed. Sign in again.');
});

test('the no-candidate notice names the service and the engine detail', () => {
  assert.equal(m.noCandidateMessage('codex', 'every account is at its limit'), 'AI Usage: not rotating Codex: every account is at its limit.');
});

test('the reset confirmation detail lists the quota windows, the credits, the reason and the expiry time', () => {
  const expiresAt = '2026-10-11T12:30:00.000Z';
  assert.equal(m.resetConfirmationDetail({ windows: [{ label: '5h', usedPercent: 99 }, { label: '7d', usedPercent: 40 }], plannedCredits: 1,
    availableCredits: 3, reason: 'limit reached', expiresAt }),
  `The engine plans to use 1 reset credit(s). Current quota: 5h: 99% used, 7d: 40% used. 3 credit(s) are available. Reason: limit reached. This decision expires at ${new Date(expiresAt).toLocaleTimeString()}.`);
  assert.match(m.resetConfirmationDetail({ windows: [], plannedCredits: 0, availableCredits: 0, reason: '', expiresAt: 0 }), /Current quota: \./);
});

test('the history menu has summaries for four periods, three exports, the newest file and the settings', () => {
  const items = h.historyItems({ location: '/home/u/.ai-usage/usage-history', enabled: true, retentionDays: 365 }, -1);
  assert.deepEqual(items.map((item) => item.label), [
    'Summary', '$(graph) Summary of the last 7 days', '$(graph) Summary of the last 30 days', '$(graph) Summary of the last 90 days', '$(graph) Summary of everything kept',
    'Export', '$(export) Readings as CSV…', '$(export) Switches, sweeps and check failures as CSV…', '$(json) Everything as JSON Lines…',
    'Files', '$(file) Open the newest month file', '$(gear) History settings']);
  assert.deepEqual(items.filter((item) => item.kind === -1).length, 3);
  assert.deepEqual(items.filter((item) => item.action === 'summary').map((item) => item.days), [7, 30, 90, undefined]);
  assert.equal(items[10].description, '/home/u/.ai-usage/usage-history');
  assert.equal(items[11].description, 'aiUsage.history.* · on, kept 365 days');
  assert.equal(h.historyItems({ location: 'x', enabled: false, retentionDays: 365 }, -1)[11].description, 'aiUsage.history.* · off');
});

test('the history placeholder pluralises the month files and an export is named by date', () => {
  assert.equal(h.historyPlaceholder({ files: [], location: '/x' }), '0 month files in /x');
  assert.equal(h.historyPlaceholder({ files: ['a'], location: '/x' }), '1 month file in /x');
  assert.equal(h.historyPlaceholder({ files: ['a', 'b'], location: '/x' }), '2 month files in /x');
  assert.equal(h.historyExportName('readings', 'csv', new Date('2026-10-11T23:59:59Z')), 'ai-usage-readings-2026-10-11.csv');
  assert.equal(h.historyExportName('jsonl', 'jsonl', new Date('2026-01-02T00:00:00Z')), 'ai-usage-jsonl-2026-01-02.jsonl');
});

test('the MCP setup menu offers connect, then enable, then one registration row per CLI, always ending with the settings', () => {
  const connect = mcp.mcpSetupItems(false, false, undefined);
  assert.deepEqual(connect.map((item) => item.action), ['connect', 'settings']);
  assert.equal(connect[1].description, 'Disabled');
  const enable = mcp.mcpSetupItems(true, false, undefined);
  assert.deepEqual(enable.map((item) => item.action), ['enable', 'settings']);
  const registered = mcp.mcpSetupItems(true, true, { claude: { current: true, registered: true }, codex: { registered: true } });
  assert.deepEqual(registered.map((item) => [item.action, item.description]), [
    ['claude', 'Registered'], ['codex', 'Registered with another command'], ['settings', 'Enabled']]);
  assert.equal(registered[0].label, '$(plug) Register with Claude CLI…');
  assert.match(registered[1].detail, /^Adds the .+ MCP server to Codex in terminal sessions\.$/);
  assert.match(registered[0].detail, /to Claude Code in terminal sessions\.$/);
  assert.equal(mcp.mcpSetupItems(true, true, { claude: {}, codex: {} })[0].description, 'Not registered');
});

test('the displayed MCP command quotes parts with spaces or quotes and defaults to the launcher with `mcp`', () => {
  assert.equal(mcp.displayedMcpCommand('/opt/ai usage/launcher'), '"/opt/ai usage/launcher" mcp');
  assert.equal(mcp.displayedMcpCommand('/bin/ai-usage', { command: 'node', args: ['a b', 'say "hi"', 'plain'] }), 'node "a b" "say \\"hi\\"" plain');
  assert.equal(mcp.displayedMcpCommand('/bin/x', { args: [] }), '/bin/x');
  assert.equal(mcp.mcpWhere('claude'), 'in its user scope, for every project');
  assert.equal(mcp.mcpWhere('codex'), 'in its config.toml');
});
