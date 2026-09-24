const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CLAUDE_SETTINGS,
  applyClaudeSettings,
  applyClaudeSettingsToFile,
  readClaudeSettingAssignments
} = require('../out/claudeSettings');

const SUBAGENTS = { ...CLAUDE_SETTINGS[0], value: 50 };
const WORKFLOW = { ...CLAUDE_SETTINGS[1], value: 32 };

test('an empty file gains an env object with string values', () => {
  assert.equal(applyClaudeSettings('', [SUBAGENTS]), '{\n  "env": {\n    "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "50"\n  }\n}\n');
});

test('other keys and env entries are kept, with the file indentation', () => {
  const original = '{\n    "model": "opus",\n    "env": {\n        "FOO": "1",\n        "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "20"\n    }\n}\n';
  const updated = JSON.parse(applyClaudeSettings(original, [SUBAGENTS, WORKFLOW]));
  assert.deepEqual(updated, {
    model: 'opus',
    env: { FOO: '1', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '50', CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: '32' }
  });
  assert.ok(applyClaudeSettings(original, [SUBAGENTS]).startsWith('{\n    "model"'));
});

test('an unchanged value leaves the text byte for byte', () => {
  const original = '{"env":{"CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS":"50"}}';
  assert.equal(applyClaudeSettings(original, [SUBAGENTS]), original);
});

test('a file that is not a JSON object, or a non-object env, is refused', () => {
  assert.throws(() => applyClaudeSettings('{ broken', [SUBAGENTS]));
  assert.throws(() => applyClaudeSettings('[]', [SUBAGENTS]), /not a JSON object/);
  assert.throws(() => applyClaudeSettings('{"env": "x"}', [SUBAGENTS]), /"env"/);
});

test('only set, valid settings become assignments', () => {
  const values = {
    'aiUsage.claudeConfig.env.maxConcurrentSubagents': 50,
    'aiUsage.claudeConfig.env.workflowMaxConcurrentAgents': 300
  };
  const invalid = [];
  const assignments = readClaudeSettingAssignments((id) => values[id], (setting, value) => invalid.push([setting.env, value]));
  assert.deepEqual(assignments.map((a) => [a.env, a.value]), [['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', 50]]);
  assert.deepEqual(invalid, [['CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS', 300]]);
  assert.deepEqual(readClaudeSettingAssignments(() => null), []);
});

test('the file is written only when something changes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-claude-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  assert.equal(applyClaudeSettingsToFile(file, []), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(applyClaudeSettingsToFile(file, [SUBAGENTS]), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '50' } });
  assert.equal(applyClaudeSettingsToFile(file, [SUBAGENTS]), false);
});
