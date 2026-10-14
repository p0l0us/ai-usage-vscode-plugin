const assert = require('node:assert/strict');
const test = require('node:test');
const c = require('../out/codexSwitch');

test('only a real Codex account change records a switch', () => {
  assert.equal(c.recordsCodexSwitch('codex', { kind: 'activated', accountChanged: true }), true);
  assert.equal(c.recordsCodexSwitch('codex', { kind: 'saved', accountChanged: false }), false);
  assert.equal(c.recordsCodexSwitch('codex', { kind: 'activated', accountChanged: false }), false);
  assert.equal(c.recordsCodexSwitch('claude', { kind: 'activated', accountChanged: true }), false);
});

test('the switch record names the profile, with a fallback when none is active', () => {
  assert.deepEqual(c.codexSwitchRecord('Work', 123), { switchedAt: 123, profileName: 'Work' });
  assert.deepEqual(c.codexSwitchRecord(undefined, 5), { switchedAt: 5, profileName: 'the selected profile' });
  assert.equal(c.codexSwitchRecord('', 5).profileName, '', 'an empty name is kept as is');
});

test('the shared storage keys are versioned', () => {
  assert.equal(c.CODEX_SWITCH_KEY, 'aiUsage.codexSwitch.v1');
  assert.equal(c.CODEX_SWITCH_NOTIFIED_KEY, 'aiUsage.codexSwitchNotified.v1');
});

function host(overrides = {}) {
  const calls = { findStale: 0, warn: [], marked: [], logs: [], restarted: 0 };
  let notified = overrides.notifiedAt;
  const h = {
    calls,
    hintEnabled: () => true, proxyActive: () => false,
    record: () => ({ switchedAt: 1000, profileName: 'Work “A”' }),
    notified: () => notified,
    markNotified: async (value) => { notified = value; calls.marked.push(value); },
    findStale: async () => { calls.findStale += 1; return [{ pid: 11 }, { pid: 22 }]; },
    log: (message) => calls.logs.push(message),
    warn: async (message, ...actions) => { calls.warn.push([message, actions]); return overrides.choice; },
    restartExtensionHost: async () => { calls.restarted += 1; },
    ...overrides
  };
  return h;
}

test('the hint is opt-in: disabled, nothing is checked', async () => {
  const h = host({ hintEnabled: () => false });
  await c.warnAboutStaleCodexProcesses(h);
  assert.equal(h.calls.findStale, 0);
  assert.deepEqual(h.calls.warn, []);
});

test('with the account proxy active no restart is offered', async () => {
  const h = host({ proxyActive: () => true });
  await c.warnAboutStaleCodexProcesses(h);
  assert.equal(h.calls.findStale, 0);
});

test('no recorded switch, or one this window already warned about, stays quiet without looking for processes', async () => {
  for (const h of [host({ record: () => undefined }), host({ notifiedAt: 1000 })]) {
    await c.warnAboutStaleCodexProcesses(h);
    assert.equal(h.calls.findStale, 0);
    assert.deepEqual(h.calls.warn, []);
  }
  const older = host({ notifiedAt: 999 });
  await c.warnAboutStaleCodexProcesses(older);
  assert.equal(older.calls.findStale, 1, 'a different (older) notified switch does not suppress the check');
});

test('no stale process: no warning and the switch is not marked as notified', async () => {
  const h = host({ findStale: async () => [] });
  await c.warnAboutStaleCodexProcesses(h);
  assert.deepEqual(h.calls.marked, []);
  assert.deepEqual(h.calls.warn, []);
});

test('another call that warned while processes were being looked up wins: no second warning', async () => {
  let notified;
  const h = host({ findStale: async () => { notified = 1000; return [{ pid: 1 }]; } });
  h.notified = () => notified;
  await c.warnAboutStaleCodexProcesses(h);
  assert.deepEqual(h.calls.warn, []);
  assert.deepEqual(h.calls.marked, []);
});

test('a stale process is logged with its pids, the switch is marked and the warning offers a restart', async () => {
  const h = host({ choice: 'Later' });
  await c.warnAboutStaleCodexProcesses(h);
  assert.deepEqual(h.calls.marked, [1000]);
  assert.deepEqual(h.calls.logs, ['codex: app-server pid 11, 22 started before the switch to "Work “A”"']);
  assert.deepEqual(h.calls.warn, [[c.staleCodexMessage('Work “A”'), ['Restart extensions', 'Later']]]);
  assert.equal(h.calls.restarted, 0);
  await c.warnAboutStaleCodexProcesses(h);
  assert.equal(h.calls.warn.length, 1, 'one warning per switch');
});

test('choosing Restart extensions restarts the extension host; dismissing does not', async () => {
  const yes = host({ choice: 'Restart extensions' });
  await c.warnAboutStaleCodexProcesses(yes);
  assert.equal(yes.calls.restarted, 1);
  const dismissed = host({ choice: undefined });
  await c.warnAboutStaleCodexProcesses(dismissed);
  assert.equal(dismissed.calls.restarted, 0);
});

test('the warning text names the new profile', () => {
  assert.equal(c.staleCodexMessage('Work'), 'Codex switched to “Work”, but this window\'s Codex extension started before the switch and keeps the previous login; its chats will fail until extensions restart. Restart extensions to use the new login in Codex here.');
});
