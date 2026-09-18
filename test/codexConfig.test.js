const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  applyCodexProxyProvider,
  applyCodexProxyProviderToFile,
  hasCodexProxyProvider,
  readCodexProxySecret,
  removeCodexProxyProvider,
  removeCodexProxyProviderFromFile
} = require('../out/codexConfig');

const config = { baseUrl: 'http://127.0.0.1:43117/v1', secret: 'abc123' };
const MANAGED_LINE = 'model_provider = "ai-usage" # managed by ai-usage';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-codex-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('an empty config gains the provider block and selects it', () => {
  const text = applyCodexProxyProvider('', config);
  const lines = text.split('\n');
  assert.equal(lines[0], MANAGED_LINE);
  assert.ok(text.includes('[model_providers.ai-usage]'));
  assert.ok(text.includes('base_url = "http://127.0.0.1:43117/v1"'));
  assert.ok(text.includes('wire_api = "responses"'));
  assert.ok(text.includes('requires_openai_auth = false'));
  assert.ok(text.includes('http_headers = { Authorization = "Bearer abc123" }'));
  assert.ok(text.endsWith('\n'));
  assert.equal(hasCodexProxyProvider(text), true);
  assert.equal(readCodexProxySecret(text), 'abc123');
  assert.equal(hasCodexProxyProvider(''), false);
  assert.equal(readCodexProxySecret(''), undefined);
});

test('existing content is preserved, the user provider is replaced and restored on removal', () => {
  const original = [
    '# my config',
    'model = "gpt-5"',
    'model_provider = "azure"',
    '',
    '[model_providers.azure]',
    'name = "Azure"',
    'base_url = "https://example.invalid/v1"',
    '',
    '[mcp_servers.fs]',
    'command = "npx"',
    ''
  ].join('\n');
  const applied = applyCodexProxyProvider(original, config);
  const lines = applied.split('\n');
  assert.equal(lines[0], '# my config');
  assert.equal(lines[1], 'model = "gpt-5"');
  assert.equal(lines[2], MANAGED_LINE);
  assert.ok(applied.includes('[model_providers.azure]\nname = "Azure"\nbase_url = "https://example.invalid/v1"'));
  assert.ok(applied.includes('[mcp_servers.fs]\ncommand = "npx"'));
  assert.ok(applied.includes('# ai-usage.previous_model_provider = "model_provider = \\"azure\\""'));
  assert.ok(applied.indexOf('[model_providers.ai-usage]') > applied.indexOf('[mcp_servers.fs]'), 'block is appended at the end');
  assert.equal(removeCodexProxyProvider(applied), original);
});

test('applying is idempotent and re-applying with a new address keeps the recorded user line', () => {
  const original = 'model_provider = "openai"\n\n[history]\npersistence = "none"\n';
  const once = applyCodexProxyProvider(original, config);
  assert.equal(applyCodexProxyProvider(once, config), once);
  const moved = applyCodexProxyProvider(once, { ...config, baseUrl: 'http://127.0.0.1:50000/v1' });
  assert.ok(moved.includes('base_url = "http://127.0.0.1:50000/v1"'));
  assert.ok(!moved.includes('43117'));
  assert.equal(moved.split(MANAGED_LINE).length, 2, 'exactly one managed line');
  assert.equal(moved.split('[model_providers.ai-usage]').length, 2, 'exactly one provider table');
  assert.equal(removeCodexProxyProvider(moved), original);
});

test('a config that starts with a table gets model_provider in the root section', () => {
  const original = '[mcp_servers.fs]\ncommand = "npx"\n';
  const applied = applyCodexProxyProvider(original, config);
  const lines = applied.split('\n');
  assert.equal(lines[0], MANAGED_LINE);
  assert.equal(lines[1], '');
  assert.equal(lines[2], '[mcp_servers.fs]');
  assert.ok(applied.includes('# ai-usage.previous_model_provider = null'));
  assert.equal(removeCodexProxyProvider(applied), original);
});

test('removal leaves a config without the provider untouched, byte for byte', () => {
  for (const text of ['', 'model = "gpt-5"\n', 'model_provider = "openai"\n\n\n', '[a]\nb = 1']) {
    assert.equal(removeCodexProxyProvider(text), text);
  }
});

test('an unmarked copy of the provider table is replaced, not duplicated', () => {
  const stray = 'model_provider = "ai-usage"\n\n[model_providers.ai-usage]\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\n\n[other]\nx = 1\n';
  assert.equal(readCodexProxySecret(stray), undefined);
  const applied = applyCodexProxyProvider(stray, config);
  assert.equal(applied.split('[model_providers.ai-usage]').length, 2);
  assert.ok(!applied.includes('127.0.0.1:1/v1'));
  assert.ok(applied.includes('[other]\nx = 1'));
  // The user's own selection of the provider name is what removal restores.
  assert.equal(removeCodexProxyProvider(applied), 'model_provider = "ai-usage"\n\n[other]\nx = 1\n');
});

test('CRLF line endings are kept', () => {
  const original = 'model = "gpt-5"\r\nmodel_provider = "openai"\r\n';
  const applied = applyCodexProxyProvider(original, config);
  assert.ok(applied.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(applied));
  assert.equal(removeCodexProxyProvider(applied), original);
});

test('file helpers report changes, write with mode 0600 and delete an emptied file', (t) => {
  const file = path.join(temporary(t), 'config.toml');
  assert.equal(applyCodexProxyProviderToFile(file, config), true);
  assert.equal(applyCodexProxyProviderToFile(file, config), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(hasCodexProxyProvider(fs.readFileSync(file, 'utf8')), true);
  assert.equal(removeCodexProxyProviderFromFile(file), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(removeCodexProxyProviderFromFile(file), false);
  fs.writeFileSync(file, 'model = "gpt-5"\n');
  applyCodexProxyProviderToFile(file, config);
  assert.equal(removeCodexProxyProviderFromFile(file), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'model = "gpt-5"\n');
});
