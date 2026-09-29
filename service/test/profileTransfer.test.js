const assert = require('node:assert/strict');
const test = require('node:test');
const { PROFILE_EXPORT_FORMAT, parseProfileExport, planImport, serializeProfileExport, uniqueName } = require('../out/profileTransfer');

const claude = { provider: 'claude', id: 'a', name: 'Claude 5', email: 'a@example.com', accountId: 'acc-a',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', credential: { claudeAiOauth: { accessToken: 'x', refreshToken: 'y' } } };
const codex = { provider: 'codex', id: 'b', name: 'Codex 1', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
  credential: { tokens: { access_token: 'x', refresh_token: 'y', account_id: 'acc-b' } } };
const document = (profiles) => JSON.stringify({ aiUsageProfiles: 1, profiles });

test('an export round-trips every profile with its login', () => {
  const text = serializeProfileExport([claude, codex], new Date('2026-09-29T12:00:00Z'));
  const parsed = JSON.parse(text);
  assert.equal(parsed.aiUsageProfiles, PROFILE_EXPORT_FORMAT);
  assert.equal(parsed.exportedAt, '2026-09-29T12:00:00.000Z');
  assert.deepEqual(parseProfileExport(text), [claude, codex]);
});

test('parsing rejects files that are not a profile export or hold a broken login', () => {
  assert.throws(() => parseProfileExport('nope'), /not valid JSON/);
  assert.throws(() => parseProfileExport(JSON.stringify({ claudeAiOauth: { accessToken: 'x' } })), /not an AI Usage profile export/);
  assert.throws(() => parseProfileExport(JSON.stringify({ aiUsageProfiles: 2, profiles: [] })), /format 2/);
  assert.throws(() => parseProfileExport(document([{ ...claude, credential: {} }])), /Profile 1 .*“Claude 5”.*accessToken/);
  assert.throws(() => parseProfileExport(document([claude, { ...codex, provider: 'gemini' }])), /Profile 2 .*unknown service: gemini/);
  assert.throws(() => parseProfileExport(document([{ ...codex, name: '  ' }])), /has no name/);
});

test('an entry without id or dates still imports, with fresh ones and a trimmed name', () => {
  const [entry] = parseProfileExport(document([{ provider: 'codex', name: ' Codex 1 ', credential: codex.credential }]));
  assert.match(entry.id, /^[0-9a-f-]{36}$/);
  assert.equal(entry.name, 'Codex 1');
  assert.ok(Date.parse(entry.createdAt));
  assert.deepEqual(entry.credential, codex.credential);
});

test('an import plan matches saved profiles by id, then account id, then email, and tells restore from replace', () => {
  const existing = { claude: [{ id: 'a', name: 'Mine', accountId: 'acc-a' }, { id: 'c', name: 'Other', email: 'C@example.com' }], codex: [] };
  const logins = { 'claude:c': { claudeAiOauth: { accessToken: 'old' } } };
  const other = { ...claude, id: 'zzz', name: 'Other copy', email: 'c@example.com', accountId: undefined, credential: { claudeAiOauth: { accessToken: 'old' } } };
  const plan = (entries) => planImport(entries, (provider) => existing[provider], (provider, id) => logins[`${provider}:${id}`]);
  assert.deepEqual(plan([claude, other, codex]).map((item) => [item.kind, item.target?.id]), [['restore', 'a'], ['same', 'c'], ['new', undefined]]);
  assert.equal(plan([{ ...other, credential: { claudeAiOauth: { accessToken: 'new' } } }])[0].kind, 'replace');
  // The same id wins over a different account: the profile list is the same one, seen from another client.
  assert.equal(plan([{ ...claude, id: 'c', accountId: 'acc-a' }])[0].target.id, 'c');
});

test('a new profile gets a name no saved profile uses', () => {
  assert.equal(uniqueName('Claude 5', ['Claude 4']), 'Claude 5');
  assert.equal(uniqueName('Claude 5', ['claude 5', 'Claude 5 (2)']), 'Claude 5 (3)');
  assert.equal(uniqueName('x'.repeat(60), ['x'.repeat(60)]).length, 60);
});
