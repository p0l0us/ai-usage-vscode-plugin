const assert = require('node:assert/strict');
const test = require('node:test');
const a = require('../out/agentsWindow');

test('the extension is allowed in the Agents window when its id (any case) is set to true', () => {
  assert.equal(a.isAllowedInAgentsWindow({ 'P0L0US.AI-Usage-VSCode-Plugin': true }, 'p0l0us.ai-usage-vscode-plugin'), true);
  assert.equal(a.isAllowedInAgentsWindow({ 'p0l0us.ai-usage-vscode-plugin': false }, 'p0l0us.ai-usage-vscode-plugin'), false);
  assert.equal(a.isAllowedInAgentsWindow({ other: true }, 'p0l0us.x'), false);
  assert.equal(a.isAllowedInAgentsWindow({}, 'p0l0us.x'), false);
  assert.equal(a.isAllowedInAgentsWindow(undefined, 'p0l0us.x'), false);
});

test('allowing the extension keeps the other entries and overrides a false for itself', () => {
  assert.deepEqual(a.withAgentsWindowEntry({ other: true, me: false }, 'me'), { other: true, me: true });
  assert.deepEqual(a.withAgentsWindowEntry(undefined, 'me'), { me: true });
});

test('the enable message differs for remote windows', () => {
  assert.match(a.agentsWindowEnabledMessage(true), /^AI Usage is now allowed in the Agents window\. Because this window is remote, also install the extension on your local computer, then reload the Agents window\.$/);
  assert.equal(a.agentsWindowEnabledMessage(false), 'AI Usage is now allowed in the Agents window. Reload the Agents window to see the chips.');
});

function host(overrides = {}) {
  const calls = { updates: [], marked: 0, infos: [], errors: [], logs: [], runs: [] };
  return {
    calls, extensionId: 'p0l0us.ext',
    effectiveSetting: () => undefined, globalSetting: () => ({ keep: true }),
    updateGlobalSetting: async (value) => { calls.updates.push(value); },
    chipsEnabled: () => true, hintShown: () => undefined, markHintShown: async () => { calls.marked += 1; },
    remote: () => false,
    info: async (message, ...actions) => { calls.infos.push([message, actions]); return overrides.choice; },
    error: (message) => calls.errors.push(message), log: (message) => calls.logs.push(message),
    run: async (command, ...args) => { calls.runs.push([command, ...args]); },
    ...overrides
  };
}

test('enabling writes the user setting, logs, tells the user and offers the guide and settings.json', async () => {
  const h = host({ choice: 'Setup guide', remote: () => true });
  await a.enableAgentsWindow(h);
  assert.deepEqual(h.calls.updates, [{ keep: true, 'p0l0us.ext': true }]);
  assert.deepEqual(h.calls.logs, ['agents window: p0l0us.ext added to extensions.supportAgentsWindow']);
  assert.deepEqual(h.calls.infos, [[a.agentsWindowEnabledMessage(true), ['Setup guide', 'Open settings.json']]]);
  assert.deepEqual(h.calls.runs, [['aiUsage.openAgentsWindowSetup']]);
  const open = host({ choice: 'Open settings.json' });
  await a.enableAgentsWindow(open);
  assert.deepEqual(open.calls.runs, [['workbench.action.openSettingsJson']]);
  const none = host({ choice: undefined, globalSetting: () => undefined });
  await a.enableAgentsWindow(none);
  assert.deepEqual(none.calls.runs, []);
  assert.deepEqual(none.calls.updates, [{ 'p0l0us.ext': true }]);
});

test('a failing settings update is reported and nothing else happens', async () => {
  const h = host({ updateGlobalSetting: async () => { throw new Error('read-only'); } });
  await a.enableAgentsWindow(h);
  assert.deepEqual(h.calls.errors, ['AI Usage: could not update extensions.supportAgentsWindow: Error: read-only']);
  assert.deepEqual(h.calls.logs, []);
  assert.deepEqual(h.calls.infos, []);
});

test('the one-time hint is skipped when already shown, already allowed or the Agents window chips are off', async () => {
  for (const h of [host({ hintShown: () => true }), host({ effectiveSetting: () => ({ 'P0L0US.EXT': true }) }), host({ chipsEnabled: () => false })]) {
    await a.maybeOfferAgentsWindowSetup(h);
    assert.equal(h.calls.marked, 0);
    assert.deepEqual(h.calls.infos, []);
  }
});

test('the one-time hint is remembered before asking and opens the setup guide on Set up', async () => {
  const h = host({ choice: 'Set up', effectiveSetting: () => ({ 'p0l0us.ext': false }) });
  await a.maybeOfferAgentsWindowSetup(h);
  assert.equal(h.calls.marked, 1);
  assert.deepEqual(h.calls.infos, [[a.AGENTS_WINDOW_HINT_MESSAGE, ['Set up', 'Not now']]]);
  assert.deepEqual(h.calls.runs, [['aiUsage.openAgentsWindowSetup']]);
  const later = host({ choice: 'Not now' });
  await a.maybeOfferAgentsWindowSetup(later);
  assert.deepEqual(later.calls.runs, []);
  assert.equal(later.calls.marked, 1);
});
