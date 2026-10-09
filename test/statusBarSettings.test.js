const assert = require('node:assert/strict');
const test = require('node:test');
const { CODEX_EARNED_RESETS_SETTING, codexUsageSettingsChanged } = require('../out/statusBarSettings');
const { configKeys, settingScope } = require('../service/out/configStore');
const properties = Object.assign({}, ...require('../package.json').contributes.configuration.map(block => block.properties));

function changed(...keys) {
  return query => keys.some(key => key === query || key.startsWith(`${query}.`));
}

test('earned reset toolbar setting defaults on and stays presentation-only', () => {
  assert.equal(properties[CODEX_EARNED_RESETS_SETTING].default, true);
  assert.equal(settingScope('codex.statusBar.earnedResets'), 'presentation');
});

test('earned reset display changes do not refresh usage while other and simultaneous Codex changes still do', () => {
  const keys = configKeys();
  assert.equal(codexUsageSettingsChanged(changed(CODEX_EARNED_RESETS_SETTING), keys), false);
  assert.equal(codexUsageSettingsChanged(changed('aiUsage.codex.source'), keys), true);
  assert.equal(codexUsageSettingsChanged(changed(CODEX_EARNED_RESETS_SETTING, 'aiUsage.codex.source'), keys), true);
  assert.equal(codexUsageSettingsChanged(changed('aiUsage.claude.source'), keys), false);
});
