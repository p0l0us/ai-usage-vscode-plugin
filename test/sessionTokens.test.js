const assert = require('node:assert/strict');
const test = require('node:test');
const { compactTokenCount, parseClaudeSession, parseCodexSession } = require('../out/sessionTokens');

const jsonl = (entries) => entries.map(JSON.stringify).join('\n');

test('Codex uses the latest cumulative token counter', () => {
  const usage = parseCodexSession(jsonl([
    { type: 'session_meta', payload: { id: 'codex-session' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, total_tokens: 120
    } } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: 220, cached_input_tokens: 80, output_tokens: 30, total_tokens: 250
    } } } }
  ]));

  assert.equal(usage?.sessionId, 'codex-session');
  assert.equal(usage?.inputTokens, 220);
  assert.equal(usage?.cachedInputTokens, 80);
  assert.equal(usage?.outputTokens, 30);
  assert.equal(usage?.totalTokens, 250);
});

test('Claude de-duplicates streaming records and includes cache tokens', () => {
  const usage = parseClaudeSession(jsonl([
    { type: 'assistant', sessionId: 'claude-session', message: { id: 'a', usage: {
      input_tokens: 2, cache_creation_input_tokens: 8, cache_read_input_tokens: 90, output_tokens: 10
    } } },
    { type: 'assistant', sessionId: 'claude-session', message: { id: 'a', usage: {
      input_tokens: 2, cache_creation_input_tokens: 8, cache_read_input_tokens: 90, output_tokens: 20
    } } },
    { type: 'assistant', sessionId: 'claude-session', message: { id: 'b', usage: {
      input_tokens: 5, output_tokens: 5
    } } }
  ]));

  assert.equal(usage?.sessionId, 'claude-session');
  assert.equal(usage?.inputTokens, 105);
  assert.equal(usage?.cachedInputTokens, 90);
  assert.equal(usage?.outputTokens, 25);
  assert.equal(usage?.totalTokens, 130);
});

test('compact token labels use the generated one-significant-digit buckets', () => {
  assert.equal(compactTokenCount(0), '0');
  assert.equal(compactTokenCount(406_537), '400k');
  assert.equal(compactTokenCount(1_250), '1k');
  assert.equal(compactTokenCount(6_700_000), '7m');
  assert.equal(compactTokenCount(1_500_000_000), '1b+');
});
