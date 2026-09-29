const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultConfig, normalizeConfig, setConfigValue, getConfigValue, listConfig, loadConfig, saveConfig, automationSettings, strategySummary, SETTINGS } = require('../out/configStore');

test('defaults match the extension settings: Claude rotates at 95/99.5 with soonestReset, Codex at 100/99 sequentially', () => {
  const config = defaultConfig();
  assert.equal(config.claude.autoRotate.fiveHourThresholdPercent, 95);
  assert.equal(config.claude.autoRotate.weeklyThresholdPercent, 99.5);
  assert.equal(config.claude.autoRotate.strategy, 'soonestReset');
  assert.equal(config.codex.autoRotate.fiveHourThresholdPercent, 100);
  assert.equal(config.codex.autoRotate.weeklyThresholdPercent, 99);
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
  assert.throws(() => setConfigValue(config, 'codex.autoRotate.strategy', 'evenPace'), /does not apply to Codex/);
  assert.throws(() => setConfigValue(config, 'copilot.keepAlive.enabled', true), /start with claude\. or codex\./);
  assert.throws(() => setConfigValue(config, 'claude.nothing', true), /Unknown setting/);
});

test('listConfig lists every applicable key with Claude first and Codex without the Claude-only ones', () => {
  const entries = listConfig(defaultConfig());
  const keys = entries.map((entry) => entry.key);
  assert.equal(keys[0], 'claude.keepAlive.enabled');
  assert.ok(keys.includes('claude.autoRotate.strategy'));
  assert.ok(!keys.includes('codex.autoRotate.strategy'));
  assert.ok(keys.includes('codex.autoRotate.fiveHourThresholdPercent'));
  assert.equal(entries.length, SETTINGS.length + SETTINGS.filter((setting) => !setting.providers).length);
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

test('automation settings bound the intervals and force Codex to sequential at its limit', () => {
  let config = defaultConfig();
  config = setConfigValue(config, 'claude.keepAlive.periodHours', 0.5);
  config = setConfigValue(config, 'claude.autoRotate.trigger', 'proactive');
  const claude = automationSettings(config, 'claude');
  assert.equal(claude.intervalMs, 30 * 60_000);
  assert.equal(claude.checkIntervalMs, 10 * 60_000);
  assert.equal(claude.trigger, 'proactive');
  assert.equal(claude.strategy, 'soonestReset');
  assert.equal(claude.minStayMs, 30 * 60_000);
  assert.equal(claude.home, '~/.claude-tmp');
  const codex = automationSettings(config, 'codex');
  assert.equal(codex.strategy, 'sequential');
  assert.equal(codex.trigger, 'limit');
  assert.equal(codex.intervalMs, 6 * 3_600_000);
  assert.equal(strategySummary(config, 'claude'), 'soonestReset, proactive, 5h ≥ 95%, 7d ≥ 99.5%');
  assert.equal(strategySummary(config, 'codex'), '5h ≥ 100%, 7d ≥ 99%');
});
