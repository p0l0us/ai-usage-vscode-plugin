const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const settings = new Map();
const updates = [];
const warnings = [];
/** Settings declared without a default: VS Code reports their type's empty value when nobody set them. */
const noDefault = new Map();
const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'vscode') return {
    ConfigurationTarget: { Global: 1 },
    window: { showWarningMessage: message => { warnings.push(message); return Promise.resolve(undefined); } },
    workspace: { getConfiguration: () => ({
      get: (key, fallback) => (settings.has(key) ? settings.get(key) : noDefault.has(key) ? noDefault.get(key) : fallback),
      inspect: (key) => ({ key, defaultValue: noDefault.has(key) ? undefined : null, globalValue: settings.get(key) }),
      update: async (key, value) => { updates.push([key, value]); settings.set(key, value); }
    }) }
  };
  return load.call(this, id, ...args);
};
const { configKeyOf, settingKey, readSettings, differences, ConfigSync, readSeedSettings, configFromSettings } = require('../out/configSync');
Module._load = load;
const { defaultConfig, setConfigValue } = require('../service/out/configStore');

test('setting names map to service keys only for known settings of the right service', () => {
  assert.equal(settingKey('claude.autoRotate.strategy'), 'aiUsage.claude.autoRotate.strategy');
  assert.equal(configKeyOf('aiUsage.claude.autoRotate.strategy'), 'claude.autoRotate.strategy');
  assert.equal(configKeyOf('aiUsage.codex.keepAlive.periodHours'), 'codex.keepAlive.periodHours');
  assert.equal(configKeyOf('aiUsage.codex.autoRotate.strategy'), 'codex.autoRotate.strategy');
  assert.equal(configKeyOf('aiUsage.codex.autoRotate.resetAware'), 'codex.autoRotate.resetAware');
  assert.equal(configKeyOf('aiUsage.codex.autoReset.enabled'), 'codex.autoReset.enabled');
  assert.equal(configKeyOf('aiUsage.claude.source'), 'claude.source', 'the service owns usage sources');
  assert.equal(configKeyOf('aiUsage.statusBar.enabled'), 'statusBar.enabled');
  assert.equal(configKeyOf('aiUsage.mcp.enabled'), 'mcp.enabled', 'the MCP switches are global service settings');
  assert.equal(configKeyOf('aiUsage.mcp.switching'), 'mcp.switching');
  assert.equal(configKeyOf('aiUsage.mcp.other'), undefined);
  assert.equal(configKeyOf('aiUsage.projectProfiles.file'), 'projectProfiles.file', 'the profile scope switches are global service settings');
  assert.equal(configKeyOf('aiUsage.privateProfiles.enabled'), 'privateProfiles.enabled');
  assert.equal(configKeyOf('aiUsage.history.retentionDays'), 'history.retentionDays');
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
  assert.equal(sync.isWriting, false, 'hydration has finished; expected values suppress only matching events');
  assert.deepEqual(sync.changedKeys({ affectsConfiguration: () => true }, serviceConfig), {}, 'nothing is pushed back during a pull');
  assert.equal(sync.isWriting, false);
  settings.set('aiUsage.claude.autoRotate.fiveHourThresholdPercent', 90);
  const pushed = sync.changedKeys({ affectsConfiguration: (key) => key === 'aiUsage.claude.autoRotate.fiveHourThresholdPercent' }, serviceConfig);
  assert.deepEqual(pushed, { 'claude.autoRotate.fiveHourThresholdPercent': 90 });
});

test('a setting without a default that nobody set is not sent, so the service accepts the rest', () => {
  settings.clear(); noDefault.clear();
  noDefault.set('aiUsage.refreshIntervalMinutes', 0);
  settings.set('aiUsage.claude.autoRotate.enabled', true);
  const values = readSettings(defaultConfig());
  assert.equal('refreshIntervalMinutes' in values, false);
  assert.equal(values['claude.autoRotate.enabled'], true);
  settings.set('aiUsage.refreshIntervalMinutes', 5);
  assert.equal(readSettings(defaultConfig()).refreshIntervalMinutes, 5, 'a value the user set is sent');
  noDefault.clear();
});

test('invalid legacy settings are ignored without breaking config reads or changing editor settings', () => {
  settings.clear(); warnings.length = 0;
  settings.set('aiUsage.refreshIntervalMinutes', 0.5);
  settings.set('aiUsage.claude.autoRotate.enabled', true);

  const config = defaultConfig();
  const values = readSettings(config);
  assert.equal('refreshIntervalMinutes' in values, false);
  assert.equal(values['claude.autoRotate.enabled'], true, 'valid settings remain available');
  const interpreted = configFromSettings();
  assert.equal(interpreted.refreshIntervalMinutes, config.refreshIntervalMinutes, 'invalid legacy value falls back to the valid default');
  assert.equal(interpreted.claude.autoRotate.enabled, true);
  assert.equal(settings.get('aiUsage.refreshIntervalMinutes'), 0.5, "the user's setting is left untouched");
  assert.equal(warnings.length, 1, 'repeated reads warn at most once for this key in the session');
  assert.match(warnings[0], /aiUsage\.refreshIntervalMinutes.*Change or remove it in Settings/);
  assert.doesNotMatch(warnings[0], /0\.5/, 'warning does not expose the invalid value');

  settings.set('aiUsage.refreshIntervalMinutes', 5);
  warnings.length = 0;
  assert.equal(readSettings(config).refreshIntervalMinutes, 5);
  assert.equal(warnings.length, 0, 'valid explicit and default values do not warn');
});


test('presentation, deployment and workspace values stay editor-local on seed, hydration and user change', async () => {
  settings.clear(); updates.length = 0;
  for (const [key, value] of Object.entries({
    'statusBar.enabled': false, 'accountService.enabled': false,
    'codex.advanced.rotationDiagnostics': true, 'bridge.codex.sessionDirectory': '/editor/project',
    'codex.source': 'cli'
  })) settings.set(`aiUsage.${key}`, value);
  const config = defaultConfig();
  assert.deepEqual(readSeedSettings(config), { 'codex.source': 'cli' });
  const sync = new ConfigSync(() => undefined);
  await sync.pull(config);
  assert.deepEqual(updates, [['aiUsage.codex.source', 'auto']]);
  assert.equal(settings.get('aiUsage.statusBar.enabled'), false);
  assert.equal(settings.get('aiUsage.codex.advanced.rotationDiagnostics'), true);
  assert.equal(settings.get('aiUsage.bridge.codex.sessionDirectory'), '/editor/project');
  assert.deepEqual(sync.changedKeys({ affectsConfiguration: () => true }, config), {});
});

test('an unrelated user change during hydration is not discarded by a global writing guard', async () => {
  settings.clear(); updates.length = 0;
  settings.set('aiUsage.codex.source', 'cli');
  const config = defaultConfig();
  const sync = new ConfigSync(() => undefined);
  await sync.pull(config);
  settings.set('aiUsage.claude.autoRotate.enabled', true);
  assert.deepEqual(sync.changedKeys({ affectsConfiguration: key => key === 'aiUsage.claude.autoRotate.enabled' }, config),
    { 'claude.autoRotate.enabled': true });
});
