const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyCodexProxyProvider, removeCodexProxyProvider } = require('../out/codexConfig');
const {
  CODEX_SETTINGS,
  applyCodexSettingsToFile,
  readCodexSettingAssignments,
  setCodexConfigValue
} = require('../out/codexSettings');

const KEY = 'max_concurrent_threads_per_session';

test('an empty file gains the table', () => {
  assert.equal(setCodexConfigValue('', 'agents', KEY, 8), `[agents]\n${KEY} = 8\n`);
});

test('an existing value is replaced in place, keeping its comment and the rest of the file', () => {
  const original = [
    'model = "gpt-5"',
    '',
    '[agents]',
    `${KEY} = 100 # plenty`,
    'max_depth = 2',
    '',
    '[tui]',
    'status_line_use_colors = true',
    ''
  ].join('\n');
  const updated = setCodexConfigValue(original, 'agents', KEY, 6);
  assert.equal(updated, original.replace(`${KEY} = 100 # plenty`, `${KEY} = 6 # plenty`));
  assert.equal(setCodexConfigValue(updated, 'agents', KEY, 6), updated);
});

test('a missing key goes after the last line of its table, not into the next one', () => {
  const original = '[agents]\nmax_depth = 2\n\n[agents.explorer]\ndescription = "x"\n';
  assert.equal(
    setCodexConfigValue(original, 'agents', KEY, 4),
    `[agents]\nmax_depth = 2\n${KEY} = 4\n\n[agents.explorer]\ndescription = "x"\n`
  );
});

test('a new table is added before the account proxy block, which survives re-application and removal', () => {
  const proxied = applyCodexProxyProvider('model = "gpt-5"\n', { baseUrl: 'http://127.0.0.1:43117/v1', secret: 's' });
  const updated = setCodexConfigValue(proxied, 'agents', KEY, 12);
  const agents = updated.indexOf('[agents]');
  assert.ok(agents > 0 && agents < updated.indexOf('# >>> ai-usage'));
  assert.ok(updated.includes(`[agents]\n${KEY} = 12\n\n# >>> ai-usage`));
  // A second key lands inside [agents], not after the proxy block's comment lines.
  const both = setCodexConfigValue(updated, 'agents', 'max_depth', 3);
  assert.ok(both.includes(`[agents]\n${KEY} = 12\nmax_depth = 3\n\n# >>> ai-usage`));
  assert.ok(applyCodexProxyProvider(both, { baseUrl: 'http://127.0.0.1:43117/v1', secret: 's' }).includes(`${KEY} = 12`));
  assert.equal(removeCodexProxyProvider(both), `model = "gpt-5"\n\n[agents]\n${KEY} = 12\nmax_depth = 3\n`);
});

test('a root-level dotted key is updated in place and an inline table is refused', () => {
  assert.equal(setCodexConfigValue(`agents.${KEY} = 1\n[tui]\n`, 'agents', KEY, 5), `agents.${KEY} = 5\n[tui]\n`);
  assert.throws(() => setCodexConfigValue(`agents = { ${KEY} = 1 }\n`, 'agents', KEY, 5), /inline table/);
});

test('CRLF files keep CRLF', () => {
  assert.equal(setCodexConfigValue(`[agents]\r\n${KEY} = 1\r\n`, 'agents', KEY, 2), `[agents]\r\n${KEY} = 2\r\n`);
});

test('only set, valid settings become assignments', () => {
  const values = {
    'aiUsage.codexConfig.agents.maxConcurrentThreadsPerSession': 10,
    'aiUsage.codexConfig.agents.maxDepth': null,
    'aiUsage.codexConfig.agents.jobMaxRuntimeSeconds': 0
  };
  const invalid = [];
  const assignments = readCodexSettingAssignments((id) => values[id], (setting, value) => invalid.push([setting.key, value]));
  assert.deepEqual(assignments.map((a) => [a.key, a.value]), [[KEY, 10]]);
  assert.deepEqual(invalid, [['job_max_runtime_seconds', 0]]);
  assert.equal(CODEX_SETTINGS.length, 3);
});

test('the file is written only when something changes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-codex-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.toml');
  const assignment = { ...CODEX_SETTINGS[0], value: 7 };
  assert.equal(applyCodexSettingsToFile(file, []), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(applyCodexSettingsToFile(file, [assignment]), true);
  assert.equal(fs.readFileSync(file, 'utf8'), `[agents]\n${KEY} = 7\n`);
  assert.equal(applyCodexSettingsToFile(file, [assignment]), false);
});
