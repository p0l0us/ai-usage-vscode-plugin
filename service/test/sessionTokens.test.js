const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compactTokenCount, parseClaudeSession, parseCodexSession, readCurrentSessionTokens } = require('../out/sessionTokens');

const jsonl = (entries) => entries.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n');
const AT = new Date('2026-10-11T10:00:00Z');

const claudeTurn = (id, usage, extra = {}) => ({ type: 'assistant', sessionId: 'claude-s', message: { id, usage }, ...extra });
const codexTotal = (total) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total } } });

// --- parsers ---------------------------------------------------------------------------------------

test('Claude parse: sums turns, counts cache creation as input and cache reads as cached input', () => {
  const usage = parseClaudeSession(jsonl([
    claudeTurn('m1', { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 50 }),
    { type: 'user', message: { content: 'hello' } },
    claudeTurn('m2', { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 70 })
  ]), AT);
  assert.deepEqual(usage, {
    provider: 'claude', sessionId: 'claude-s', updatedAt: AT,
    inputTokens: 3 + 1000 + 1 + 10 + 1000, cachedInputTokens: 1000, outputTokens: 120, totalTokens: 2014 + 120
  });
});

test('Claude parse: the last record for a message id wins, even when later records have smaller numbers', () => {
  const usage = parseClaudeSession(jsonl([
    claudeTurn('m1', { input_tokens: 10, output_tokens: 90 }),
    claudeTurn('m1', { input_tokens: 10, output_tokens: 5 })
  ]), AT);
  assert.equal(usage.outputTokens, 5);
  assert.equal(usage.inputTokens, 10);
});

test('Claude parse: records without a message id are each counted', () => {
  const usage = parseClaudeSession(jsonl([
    { type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 2 } } },
    { type: 'assistant', message: { id: 7, usage: { input_tokens: 10, output_tokens: 20 } } },
    { type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 200 } } }
  ]), AT);
  assert.equal(usage.inputTokens, 111);
  assert.equal(usage.outputTokens, 222);
  assert.equal(usage.sessionId, undefined);
});

test('Claude parse: sidechain (sub-agent) turns count like any other assistant record', () => {
  // Sub-agent turns carry isSidechain: true in the same file; they are billed usage too.
  const usage = parseClaudeSession(jsonl([
    claudeTurn('main', { input_tokens: 1, output_tokens: 1 }),
    claudeTurn('side', { input_tokens: 4, output_tokens: 4 }, { isSidechain: true })
  ]), AT);
  assert.equal(usage.totalTokens, 10);
});

test('Claude parse: corrupt lines, blank lines, non-object JSON and non-assistant records are skipped', () => {
  const usage = parseClaudeSession([
    '', '   ', 'not json', '[1,2,3]', '42', 'null',
    JSON.stringify({ type: 'user', sessionId: 'first', message: { usage: { input_tokens: 999 } } }),
    JSON.stringify(claudeTurn('m1', { input_tokens: 2, output_tokens: 3 })),
    '{"type":"assistant","message":{"id":"m2","usage":{"input_tok'
  ].join('\n'), AT);
  assert.equal(usage.totalTokens, 5);
  assert.equal(usage.sessionId, 'first', 'the session id is taken from the first record that has one');
});

test('Claude parse: negative, NaN-like and non-numeric counters count as zero', () => {
  const usage = parseClaudeSession(jsonl([
    claudeTurn('m1', { input_tokens: -5, cache_creation_input_tokens: '12', cache_read_input_tokens: null, output_tokens: 4 })
  ]), AT);
  assert.deepEqual([usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.totalTokens], [0, 0, 4, 4]);
});

test('Claude parse: no usage anywhere gives undefined; an assistant record with empty usage gives zeros', () => {
  assert.equal(parseClaudeSession('', AT), undefined);
  assert.equal(parseClaudeSession(jsonl([{ type: 'assistant', message: { content: 'x' } }, { type: 'summary' }]), AT), undefined);
  assert.equal(parseClaudeSession(jsonl([claudeTurn('m1', {})]), AT).totalTokens, 0);
});

test('Codex parse: tokens use the latest counter, the session id the latest meta, total falls back to input + output', () => {
  const usage = parseCodexSession(jsonl([
    { type: 'session_meta', payload: { id: 'old' } },
    codexTotal({ input_tokens: 5, output_tokens: 1, total_tokens: 6 }),
    { type: 'session_meta', payload: { id: 'new' } },
    { type: 'event_msg', payload: { type: 'token_count', info: null } },
    { type: 'event_msg', payload: { type: 'agent_message', info: { total_token_usage: { input_tokens: 1e6 } } } },
    codexTotal({ input_tokens: 40, cached_input_tokens: 10, output_tokens: 8 })
  ]), AT);
  assert.deepEqual(usage, {
    provider: 'codex', sessionId: 'new', updatedAt: AT,
    inputTokens: 40, cachedInputTokens: 10, outputTokens: 8, totalTokens: 48
  });
});

test('Codex parse: null info keeps the previous counter; corrupt lines and no counter are tolerated', () => {
  assert.equal(parseCodexSession(jsonl([codexTotal({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }), 'garbage',
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: null } } }]), AT).totalTokens, 2);
  assert.equal(parseCodexSession('', AT), undefined);
  assert.equal(parseCodexSession(jsonl([{ type: 'session_meta', payload: { id: 's' } }]), AT), undefined);
  // Garbage counters are zero rather than NaN.
  const odd = parseCodexSession(jsonl([codexTotal({ input_tokens: 'x', output_tokens: -1, total_tokens: NaN })]), AT);
  assert.deepEqual([odd.inputTokens, odd.outputTokens, odd.totalTokens], [0, 0, 0]);
});

test('compactTokenCount: every bucket boundary rounds to its step', () => {
  const cases = [[-50, '0'], [49, '0'], [50, '100'], [1_000, '1k'], [9_499, '9k'], [9_500, '10k'], [99_999, '100k'], [123_456, '100k'],
    [1_500_000, '2m'], [9_999_999, '10m'], [45_000_000, '50m'], [99_000_000, '100m'], [1e9, '1b+']];
  for (const [tokens, label] of cases) {
    assert.equal(compactTokenCount(tokens), label, String(tokens));
  }
});

test('compactTokenCount: rounding up at the top of a bucket stays in that bucket (observed quirk)', () => {
  // 950..999 renders as "1000", 950k..999k as "1000k" and 950m+ as "1000m" instead of rolling to the next unit.
  assert.equal(compactTokenCount(999), '1000');
  assert.equal(compactTokenCount(999_999), '1000k');
  assert.equal(compactTokenCount(999_999_999), '1000m');
});

// --- reading the newest session from disk ---------------------------------------------------------

function environment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-session-tokens-'));
  const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  process.env.CODEX_HOME = path.join(root, 'codex');
  t.after(() => {
    for (const [name, value] of [['CLAUDE_CONFIG_DIR', saved.claude], ['CODEX_HOME', saved.codex]]) {
      if (value === undefined) { delete process.env[name]; } else { process.env[name] = value; }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function write(file, text, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) { fs.utimesSync(file, new Date(mtime), new Date(mtime)); }
  return file;
}

const claudeFile = (workspace) => (name) => path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'), name);
const claudeLog = (output, id = 'x') => jsonl([claudeTurn(id, { input_tokens: 1, output_tokens: output })]);
const codexLog = (cwd, total, id = 'cx') => jsonl([
  { type: 'session_meta', payload: { id, cwd } }, codexTotal({ input_tokens: total, output_tokens: 0, total_tokens: total })
]);

test('read Claude: picks the newest transcript of the workspace directory only and reports its mtime', (t) => {
  environment(t);
  const where = claudeFile('/work/app one');
  write(where('old.jsonl'), claudeLog(10), '2026-10-01T00:00:00Z');
  write(where('new.jsonl'), claudeLog(20), '2026-10-05T00:00:00Z');
  write(where('notes.txt'), 'not a transcript', '2026-10-09T00:00:00Z');
  write(claudeFile('/work/other')('newest.jsonl'), claudeLog(999), '2026-10-10T00:00:00Z');
  write(where('sub/ignored.jsonl'), claudeLog(777), '2026-10-10T00:00:00Z');
  const usage = readCurrentSessionTokens('claude', ['/work/app one']);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.updatedAt.toISOString(), '2026-10-05T00:00:00.000Z');
});

test('read Claude: several workspaces compete by mtime; no matching directory gives undefined', (t) => {
  environment(t);
  write(claudeFile('/w/a')('a.jsonl'), claudeLog(1), '2026-10-01T00:00:00Z');
  write(claudeFile('/w/b')('b.jsonl'), claudeLog(2), '2026-10-02T00:00:00Z');
  assert.equal(readCurrentSessionTokens('claude', ['/w/a', '/w/b']).outputTokens, 2);
  assert.equal(readCurrentSessionTokens('claude', ['/w/a']).outputTokens, 1);
  assert.equal(readCurrentSessionTokens('claude', ['/w/missing']), undefined);
});

test('read Claude: with no workspace every project directory is searched recursively', (t) => {
  environment(t);
  write(claudeFile('/w/a')('a.jsonl'), claudeLog(1), '2026-10-01T00:00:00Z');
  write(claudeFile('/w/b')('deep/b.jsonl'), claudeLog(5), '2026-10-03T00:00:00Z');
  assert.equal(readCurrentSessionTokens('claude', []).outputTokens, 5);
});

test('read Claude: an unparsable newest transcript yields undefined instead of falling back to an older one', (t) => {
  environment(t);
  const where = claudeFile('/w/a');
  write(where('old.jsonl'), claudeLog(1), '2026-10-01T00:00:00Z');
  write(where('new.jsonl'), 'garbage only\n', '2026-10-02T00:00:00Z');
  assert.equal(readCurrentSessionTokens('claude', ['/w/a']), undefined);
  write(where('empty.jsonl'), '', '2026-10-03T00:00:00Z');
  assert.equal(readCurrentSessionTokens('claude', ['/w/a']), undefined);
});

test('read Codex: matches the session_meta cwd on the first line, ignoring newer sessions of other workspaces', (t) => {
  const root = environment(t);
  const sessions = path.join(root, 'codex', 'sessions', '2026', '10');
  write(path.join(sessions, 'mine-old.jsonl'), codexLog('/work/app', 10, 'mine-old'), '2026-10-01T00:00:00Z');
  write(path.join(sessions, 'mine-new.jsonl'), codexLog('/work/app/', 20, 'mine-new'), '2026-10-03T00:00:00Z');
  write(path.join(sessions, 'other.jsonl'), codexLog('/work/other', 999, 'other'), '2026-10-05T00:00:00Z');
  write(path.join(sessions, 'nometa.jsonl'), codexTotal({ input_tokens: 5 }) && JSON.stringify(codexTotal({ input_tokens: 5 })), '2026-10-06T00:00:00Z');
  write(path.join(sessions, 'badfirst.jsonl'), 'junk\n' + codexLog('/work/app', 5000), '2026-10-07T00:00:00Z');
  const usage = readCurrentSessionTokens('codex', ['/work/elsewhere', '/work/app']);
  assert.equal(usage.sessionId, 'mine-new');
  assert.equal(usage.inputTokens, 20);
  assert.equal(usage.updatedAt.toISOString(), '2026-10-03T00:00:00.000Z');
});

test('read Codex: without workspaces the newest session overall is used; no sessions gives undefined', (t) => {
  const root = environment(t);
  assert.equal(readCurrentSessionTokens('codex', []), undefined);
  const sessions = path.join(root, 'codex', 'sessions');
  write(path.join(sessions, 'a.jsonl'), codexLog('/a', 1, 'a'), '2026-10-01T00:00:00Z');
  write(path.join(sessions, 'b', 'c', 'b.jsonl'), codexLog('/b', 2, 'b'), '2026-10-02T00:00:00Z');
  assert.equal(readCurrentSessionTokens('codex', []).sessionId, 'b');
  assert.equal(readCurrentSessionTokens('codex', ['/nowhere']), undefined);
});

test('read: an unchanged file is served from the cache; a changed size or mtime is re-read', (t) => {
  const root = environment(t);
  const file = path.join(root, 'claude', 'projects', '-w-cache', 'a.jsonl');
  const mtime = '2026-10-01T00:00:00Z';
  write(file, claudeLog(11), mtime);
  assert.equal(readCurrentSessionTokens('claude', ['/w/cache']).outputTokens, 11);
  // Same size and mtime, different content: the cache is trusted.
  write(file, claudeLog(22), mtime);
  assert.equal(readCurrentSessionTokens('claude', ['/w/cache']).outputTokens, 11);
  // A new mtime invalidates it.
  fs.utimesSync(file, new Date('2026-10-02T00:00:00Z'), new Date('2026-10-02T00:00:00Z'));
  assert.equal(readCurrentSessionTokens('claude', ['/w/cache']).outputTokens, 22);
  // So does growth.
  write(file, claudeLog(22) + '\n' + claudeLog(100, 'second'), '2026-10-02T00:00:00Z');
  assert.equal(readCurrentSessionTokens('claude', ['/w/cache']).outputTokens, 122);
});
