const assert = require('node:assert/strict');
const test = require('node:test');
const { compareCodexAccount } = require('../out/live');

const jwt = claims => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const AUTH = 'https://api.openai.com/auth';
const token = (accountId, extra = {}) => jwt({ [AUTH]: { chatgpt_account_id: accountId }, ...extra });
const chatgpt = (accountId, email = 'a@example.com') => ({
  auth_mode: 'chatgpt',
  tokens: { id_token: token(accountId, { email }), access_token: token(accountId), refresh_token: 'r', account_id: accountId },
  last_refresh: '2026-09-17T00:00:00Z'
});

test('matching account id from the getAuthStatus token is a match', () => {
  const result = compareCodexAccount(chatgpt('acc-1'), { authMethod: 'chatgpt', authToken: token('acc-1') });
  assert.equal(result.status, 'match');
  assert.equal(result.accountId, 'acc-1');
});

test('a different account id is a mismatch naming both ids', () => {
  const result = compareCodexAccount(chatgpt('acc-1'), { authMethod: 'chatgpt', authToken: token('acc-2') });
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /acc-2.*acc-1/);
});

test('account id is taken from the stored id token when tokens.account_id is missing', () => {
  const stored = chatgpt('acc-1');
  delete stored.tokens.account_id;
  assert.equal(compareCodexAccount(stored, { authMethod: 'chatgpt', authToken: token('acc-1') }).status, 'match');
  assert.equal(compareCodexAccount(stored, { authMethod: 'chatgpt', authToken: token('acc-9') }).status, 'mismatch');
});

test('account/read fallback compares the email case-insensitively', () => {
  const stored = chatgpt('acc-1', 'User@Example.com');
  assert.equal(compareCodexAccount(stored, { account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' } }).status, 'match');
  assert.equal(compareCodexAccount(stored, { account: { type: 'chatgpt', email: 'other@example.com' } }).status, 'mismatch');
});

test('API-key-only profiles are verified by auth method alone', () => {
  const stored = { OPENAI_API_KEY: 'sk-test', auth_mode: 'apikey' };
  assert.equal(compareCodexAccount(stored, { authMethod: 'apikey', authToken: 'sk-test' }).status, 'match');
  assert.equal(compareCodexAccount(stored, { account: { type: 'apiKey' } }).status, 'match');
  assert.equal(compareCodexAccount(stored, { authMethod: 'chatgpt', authToken: token('acc-1') }).status, 'mismatch');
  assert.equal(compareCodexAccount(chatgpt('acc-1'), { authMethod: 'apikey', authToken: 'sk-test' }).status, 'mismatch');
});

test('no login and no comparable identity are reported distinctly', () => {
  assert.equal(compareCodexAccount(chatgpt('acc-1'), { authMethod: null, authToken: null }).status, 'mismatch');
  assert.equal(compareCodexAccount(chatgpt('acc-1'), { account: null }).status, 'mismatch');
  const stored = { tokens: { access_token: 'opaque', refresh_token: 'r' } };
  assert.equal(compareCodexAccount(stored, { authMethod: 'chatgpt', authToken: 'opaque' }).status, 'unverified');
});
