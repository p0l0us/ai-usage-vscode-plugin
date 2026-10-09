const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultConfig, normalizeConfig, setConfigValue, getConfigValue, listConfig, loadConfig, saveConfig, automationSettings, strategySummary, SETTINGS, GLOBAL_SETTINGS } = require('../out/configStore');

test('defaults match the extension settings: Claude rotates at 95/99.5, Codex at 100/99 with reset awareness', () => {
  const config = defaultConfig();
  assert.equal(config.claude.autoRotate.fiveHourThresholdPercent, 95);
  assert.equal(config.claude.autoRotate.weeklyThresholdPercent, 99.5);
  assert.equal(config.claude.autoRotate.strategy, 'soonestReset');
  assert.equal(config.codex.autoRotate.fiveHourThresholdPercent, 100);
  assert.equal(config.codex.autoRotate.weeklyThresholdPercent, 99);
  assert.equal(config.codex.autoRotate.strategy, 'sequential');
  assert.equal(config.codex.autoRotate.resetAware, true);
  assert.equal(config.codex.autoReset.enabled, true);
  assert.equal(config.codex.keepAlive.periodHours, 6);
  assert.equal(config.codex.keepAlive.model, 'gpt-5.6-luna');
  assert.equal(config.claude.keepAlive.home, '~/.claude-tmp');
});

test('a parsed file is merged over the defaults and invalid values keep the default', () => {
  const config = normalizeConfig({ claude: { autoRotate: { enabled: 'true', strategy: 'evenPace', weeklyThresholdPercent: 250 }, keepAlive: { periodHours: '3' } }, codex: { cliPath: '/opt/codex' }, junk: 1 });
  assert.equal(config.claude.autoRotate.enabled, true);
  assert.equal(config.claude.autoRotate.strategy, 'evenPace');
  assert.equal(config.claude.autoRotate.weeklyThresholdPercent, 99.5, 'out of range keeps the default');
  assert.equal(config.claude.keepAlive.periodHours, 3);
  assert.equal(config.codex.cliPath, '/opt/codex');
  assert.equal(config.version, 1);
});

test('setConfigValue coerces command-line strings, validates and never mutates the input', () => {
  const config = defaultConfig();
  const next = setConfigValue(setConfigValue(config, 'claude.autoRotate.enabled', 'on'), 'claude.autoRotate.fiveHourThresholdPercent', '90');
  assert.equal(next.claude.autoRotate.enabled, true);
  assert.equal(next.claude.autoRotate.fiveHourThresholdPercent, 90);
  assert.equal(config.claude.autoRotate.enabled, false);
  assert.equal(getConfigValue(next, 'claude.autoRotate.fiveHourThresholdPercent'), 90);
  assert.throws(() => setConfigValue(config, 'claude.autoRotate.strategy', 'random'), /must be one of/);
  assert.throws(() => setConfigValue(config, 'claude.keepAlive.periodHours', '0'), /at least 0.25/);
  assert.throws(() => setConfigValue(config, 'claude.keepAlive.enabled', 'maybe'), /true or false/);
  assert.equal(getConfigValue(setConfigValue(config, 'codex.autoRotate.strategy', 'evenPace'), 'codex.autoRotate.strategy'), 'evenPace');
  assert.equal(getConfigValue(setConfigValue(config, 'codex.autoRotate.resetAware', 'off'), 'codex.autoRotate.resetAware'), false);
  assert.equal(getConfigValue(setConfigValue(config, 'codex.autoReset.enabled', 'off'), 'codex.autoReset.enabled'), false);
  assert.throws(() => setConfigValue(config, 'copilot.keepAlive.enabled', true), /start with claude\. or codex\./);
  assert.throws(() => setConfigValue(config, 'claude.nothing', true), /Unknown setting/);
});

test('listConfig lists every applicable key with Claude first and Codex without the Claude-only ones', () => {
  const entries = listConfig(defaultConfig());
  const keys = entries.map((entry) => entry.key);
  assert.equal(keys[0], 'claude.keepAlive.enabled');
  assert.ok(keys.includes('claude.autoRotate.strategy'));
  assert.ok(keys.includes('codex.autoRotate.strategy'));
  assert.ok(keys.includes('codex.autoRotate.resetAware'));
  assert.ok(keys.includes('codex.autoReset.enabled'));
  assert.ok(keys.includes('codex.autoRotate.fiveHourThresholdPercent'));
  assert.equal(entries.length, ['claude', 'codex'].reduce((sum, provider) => sum + SETTINGS.filter(setting => !setting.providers || setting.providers.includes(provider)).length, 0) + GLOBAL_SETTINGS.length);
});

test('the file round-trips and a missing file yields the defaults', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  assert.deepEqual(loadConfig(file), defaultConfig());
  const config = setConfigValue(defaultConfig(), 'codex.autoRotate.enabled', true);
  saveConfig(file, config);
  assert.deepEqual(loadConfig(file), config);
  if (process.platform !== 'win32') { assert.equal(fs.statSync(file).mode & 0o777, 0o600); }
});

test('automation settings bound intervals and honor Codex strategy, trigger and reset awareness', () => {
  let config = defaultConfig();
  config = setConfigValue(config, 'claude.keepAlive.periodHours', 0.5);
  config = setConfigValue(config, 'claude.autoRotate.trigger', 'proactive');
  const claude = automationSettings(config, 'claude');
  assert.equal(claude.intervalMs, 30 * 60_000);
  assert.equal(claude.checkIntervalMs, 30 * 60_000);
  assert.equal(claude.trigger, 'proactive');
  assert.equal(claude.strategy, 'soonestReset');
  assert.equal(claude.minStayMs, 30 * 60_000);
  assert.equal(claude.home, '~/.claude-tmp');
  const codex = automationSettings(config, 'codex');
  assert.equal(codex.strategy, 'sequential');
  assert.equal(codex.trigger, 'limit');
  assert.equal(codex.resetAware, true);
  assert.equal(codex.autoReset, true);
  assert.equal(codex.intervalMs, 6 * 3_600_000);
  assert.equal(strategySummary(config, 'claude'), 'soonestReset, proactive, 5h ≥ 95%, 7d ≥ 99.5%');
  assert.equal(strategySummary(config, 'codex'), 'sequential, limit, 5h ≥ 100%, 7d ≥ 99%, reset-aware');
  const tuned = setConfigValue(setConfigValue(config, 'codex.autoRotate.strategy', 'leastWaste'), 'codex.autoRotate.trigger', 'proactive');
  assert.equal(automationSettings(tuned, 'codex').strategy, 'leastWaste');
  assert.equal(automationSettings(tuned, 'codex').trigger, 'proactive');
});

test('the mcp block is a global setting: off by default, switching on, listed after the provider settings and synced like them', () => {
  const config = defaultConfig();
  assert.deepEqual(config.mcp, { enabled: false, switching: true });
  assert.equal(normalizeConfig({ mcp: { enabled: 'yes', switching: 'maybe' } }).mcp.enabled, true);
  assert.equal(normalizeConfig({ mcp: { enabled: 'yes', switching: 'maybe' } }).mcp.switching, true, 'an invalid value keeps the default');
  const next = setConfigValue(config, 'mcp.enabled', 'on');
  assert.equal(next.mcp.enabled, true);
  assert.equal(config.mcp.enabled, false);
  assert.equal(getConfigValue(next, 'mcp.enabled'), true);
  assert.equal(getConfigValue(setConfigValue(next, 'mcp.switching', false), 'mcp.switching'), false);
  assert.throws(() => setConfigValue(config, 'claude.mcp.enabled', true), /Unknown setting/);
  assert.throws(() => setConfigValue(config, 'mcp.nothing', true), /mcp\.enabled, mcp\.switching/);
  const keys = listConfig(next).map((entry) => entry.key);
  assert.deepEqual(keys.filter(key => key.startsWith('mcp.')), ['mcp.enabled', 'mcp.switching']);
  assert.equal(listConfig(next).find((entry) => entry.key === 'mcp.enabled').value, true);
  assert.ok(GLOBAL_SETTINGS.filter((setting) => setting.key.startsWith('mcp.')).every((setting) => setting.type === 'boolean'));
});

test('the history block is a global setting: on by default, a year of retention, directory empty', () => {
  const config = defaultConfig();
  assert.deepEqual(config.history, { enabled: true, retentionDays: 365, directory: '' });
  const next = setConfigValue(setConfigValue(config, 'history.retentionDays', '30'), 'history.directory', '~/ai-usage-history');
  assert.equal(next.history.retentionDays, 30);
  assert.equal(next.history.directory, '~/ai-usage-history');
  assert.throws(() => setConfigValue(config, 'history.retentionDays', 0), /at least 1/);
  assert.deepEqual(listConfig(config).map((entry) => entry.key).filter((key) => key.startsWith('history.')), ['history.enabled', 'history.retentionDays', 'history.directory']);
});

test('every VS Code setting is also a validated standalone CLI setting, with identical defaults', () => {
  const manifest = require('../../package.json'); const config = defaultConfig();
  for (const block of manifest.contributes.configuration) for (const [key, schema] of Object.entries(block.properties)) {
    const dotted = key.replace(/^aiUsage\./, '');
    assert.deepEqual(getConfigValue(config, dotted), schema.default, key);
    if (schema.default !== undefined) assert.deepEqual(getConfigValue(setConfigValue(config, dotted, schema.default), dotted), schema.default);
  }
  assert.equal(getConfigValue(setConfigValue(config, 'codexConfig.agents.maxDepth', 'null'), 'codexConfig.agents.maxDepth'), null);
  assert.deepEqual(getConfigValue(setConfigValue(config, 'accounts', '[{"name":"test"}]'), 'accounts'), [{ name: 'test' }]);
});


test('new clients default to auto with 30-minute checks and opt-in reset confirmation', () => {
  const config = defaultConfig();
  for (const provider of ['claude', 'codex']) {
    assert.equal(config[provider].source, 'auto');
    assert.equal(config[provider].checkIntervalMinutes, 30);
    assert.equal(automationSettings(config, provider).checkIntervalMs, 30 * 60_000);
    assert.equal(getConfigValue(setConfigValue(config, `${provider}.source`, 'auto'), `${provider}.source`), 'auto');
  }
  assert.equal(config.codex.autoReset.confirmationRequired, false);
  assert.equal(automationSettings(config, 'codex').resetConfirmationRequired, false);
  const next = setConfigValue(config, 'codex.autoReset.confirmationRequired', 'on');
  assert.equal(automationSettings(next, 'codex').resetConfirmationRequired, true);
  assert.equal(next.codex.autoReset.enabled, config.codex.autoReset.enabled);
  assert.throws(() => setConfigValue(config, 'claude.autoReset.confirmationRequired', true), /does not apply/);
  assert.throws(() => setConfigValue(config, 'codex.autoReset.confirmationRequired', 'maybe'), /true or false/);
});

test('legacy persisted source modes and explicit intervals survive normalization and disk round-trip', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-config-auto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [provider, sources] of [['claude', ['both', 'cli', 'api', 'accountFile']], ['codex', ['both', 'cli', 'api', 'sessionLog']]]) {
    for (const source of sources) {
      const minutes = provider === 'claude' ? 10 : 5;
      const config = normalizeConfig({ [provider]: { source, checkIntervalMinutes: minutes, autoReset: { enabled: false } } });
      assert.equal(config[provider].source, source);
      assert.equal(config[provider].checkIntervalMinutes, minutes);
      assert.equal(config[provider].autoReset.enabled, false);
      assert.equal(config.codex.autoReset.confirmationRequired, false);
      const file = path.join(dir, 'config.json'); saveConfig(file, config);
      assert.deepEqual(loadConfig(file), config);
    }
  }
  const optIn = normalizeConfig({ codex: { autoReset: { enabled: false, confirmationRequired: true } } });
  assert.equal(optIn.codex.autoReset.enabled, false, 'confirmation does not enable automation');
  assert.equal(optIn.codex.autoReset.confirmationRequired, true);
  const invalid = normalizeConfig({ claude: { source: 'unknown' }, codex: { autoReset: { confirmationRequired: 'invalid' } } });
  assert.equal(invalid.claude.source, 'auto'); assert.equal(invalid.codex.autoReset.confirmationRequired, false);
});

test('new engine settings retain per-key revision conflicts and persisted user settings', (t) => {
  const { ConfigAuthority } = require('../out/configStore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-config-cas-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ claude: { source: 'both', checkIntervalMinutes: 10 }, codex: { source: 'cli', checkIntervalMinutes: 5 } }));
  const authority = new ConfigAuthority(file, { persist: true });
  const baseRevision = authority.revision;
  authority.patch({ 'codex.autoReset.confirmationRequired': true }, { baseRevision });
  assert.throws(() => authority.patch({ 'codex.autoReset.confirmationRequired': false }, { baseRevision }), error =>
    error.code === 'config-conflict' && error.data.keys[0] === 'codex.autoReset.confirmationRequired');
  authority.patch({ 'claude.source': 'auto' }, { baseRevision });
  const reopened = new ConfigAuthority(file);
  assert.equal(reopened.config.codex.autoReset.confirmationRequired, true);
  assert.equal(reopened.config.codex.source, 'cli'); assert.equal(reopened.config.codex.checkIntervalMinutes, 5);
  assert.equal(reopened.config.claude.source, 'auto'); assert.equal(reopened.config.claude.checkIntervalMinutes, 10);
  assert.equal(reopened.view().scopes['codex.autoReset.confirmationRequired'], 'engine');
});
