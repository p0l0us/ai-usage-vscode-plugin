const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const settings = new Map();
const updates = [];
const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'vscode') return {
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: () => ({
      get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
      update: async (key, value) => { updates.push([key, value]); settings.set(key, value); }
    }) }
  };
  return load.call(this, id, ...args);
};
const { configKeyOf, settingKey, readSettings, differences, ConfigSync } = require('../out/configSync');
Module._load = load;
const { defaultConfig, setConfigValue } = require('../service/out/configStore');

test('setting names map to service keys only for known settings of the right service', () => {
  assert.equal(settingKey('claude.autoRotate.strategy'), 'aiUsage.claude.autoRotate.strategy');
  assert.equal(configKeyOf('aiUsage.claude.autoRotate.strategy'), 'claude.autoRotate.strategy');
  assert.equal(configKeyOf('aiUsage.codex.keepAlive.periodHours'), 'codex.keepAlive.periodHours');
  assert.equal(configKeyOf('aiUsage.codex.autoRotate.strategy'), undefined, 'Codex has no strategy setting');
  assert.equal(configKeyOf('aiUsage.claude.source'), undefined, 'the usage source is not a service setting');
  assert.equal(configKeyOf('aiUsage.statusBar.enabled'), undefined);
  assert.equal(configKeyOf('aiUsage.mcp.enabled'), 'mcp.enabled', 'the MCP switches are global service settings');
  assert.equal(configKeyOf('aiUsage.mcp.switching'), 'mcp.switching');
  assert.equal(configKeyOf('aiUsage.mcp.other'), undefined);
  assert.equal(settingKey('mcp.enabled'), 'aiUsage.mcp.enabled');
});

test('the MCP switches are seeded, pulled and pushed like the provider settings', async () => {
  settings.clear(); updates.length = 0;
  // VS Code answers an unset setting with its package.json default; the mock needs the value set.
  settings.set('aiUsage.mcp.enabled', true);
  settings.set('aiUsage.mcp.switching', true);
  const config = defaultConfig();
  assert.equal(readSettings(config)['mcp.enabled'], true);
  assert.deepEqual(differences(config).map((diff) => diff.key), ['mcp.enabled']);
  const sync = new ConfigSync(() => undefined);
  assert.equal(await sync.pull(setConfigValue(config, 'mcp.switching', false)), 2, 'the service values win: enabled off, switching off');
  assert.deepEqual(updates.sort(), [['aiUsage.mcp.enabled', false], ['aiUsage.mcp.switching', false]]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  settings.set('aiUsage.mcp.enabled', true);
  assert.deepEqual(sync.changedKeys({ affectsConfiguration: (key) => key === 'aiUsage.mcp.enabled' }, config), { 'mcp.enabled': true });
});

test('user settings are read for seeding, differences are found, and pulls write only what differs', async () => {
  settings.clear(); updates.length = 0;
  settings.set('aiUsage.claude.autoRotate.enabled', true);
  settings.set('aiUsage.claude.autoRotate.strategy', 'evenPace');
  settings.set('aiUsage.codex.keepAlive.periodHours', 12);
  const config = defaultConfig();
  const values = readSettings(config);
  assert.equal(values['claude.autoRotate.enabled'], true);
  assert.equal(values['claude.autoRotate.strategy'], 'evenPace');
  assert.equal(values['codex.keepAlive.periodHours'], 12);
  assert.equal(values['claude.keepAlive.enabled'], undefined, 'unset settings seed nothing');
  const diffs = differences(config);
  assert.deepEqual(diffs.map((diff) => diff.key).sort(), ['claude.autoRotate.enabled', 'claude.autoRotate.strategy', 'codex.keepAlive.periodHours']);
  const sync = new ConfigSync(() => undefined);
  const serviceConfig = setConfigValue(config, 'claude.autoRotate.strategy', 'leastWaste');
  assert.equal(await sync.pull(serviceConfig), 3);
  assert.deepEqual(updates.sort(), [['aiUsage.claude.autoRotate.enabled', false], ['aiUsage.claude.autoRotate.strategy', 'leastWaste'], ['aiUsage.codex.keepAlive.periodHours', 6]]);
  assert.equal(sync.isWriting, true, 'its own writes are guarded while their change events arrive');
  assert.deepEqual(sync.changedKeys({ affectsConfiguration: () => true }, serviceConfig), {}, 'nothing is pushed back during a pull');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(sync.isWriting, false);
  settings.set('aiUsage.claude.autoRotate.fiveHourThresholdPercent', 90);
  const pushed = sync.changedKeys({ affectsConfiguration: (key) => key === 'aiUsage.claude.autoRotate.fiveHourThresholdPercent' }, serviceConfig);
  assert.deepEqual(pushed, { 'claude.autoRotate.fiveHourThresholdPercent': 90 });
});
