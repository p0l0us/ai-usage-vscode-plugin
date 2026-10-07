const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ApiCallBudget, MAX_ADVERTISED_INTERVAL_MS } = require('../out/apiBudget');
const { parseRateLimitHeaders } = require('../out/live');

function fixture(t, minIntervalMs = 30_000) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-budget-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'budget.json');
  let now = 1_000_000;
  const make = () => new ApiCallBudget(file, () => minIntervalMs, () => now);
  return { file, make, budget: make(), advance: ms => { now += ms; }, at: () => now };
}

test('calls are spaced by the configured minimum, whichever window makes them', async t => {
  const f = fixture(t);
  assert.equal(f.budget.reserve(), true);
  assert.equal(f.budget.reserve(), false);
  // Another window shares the ledger on disk, so it waits for the same slot.
  assert.equal(f.make().reserve(), false);
  f.advance(29_000);
  assert.equal(f.budget.reserve(), false);
  f.advance(1_000);
  assert.equal(f.make().reserve(), true);
});

test('a zero minimum leaves only what the service itself reports', async t => {
  const f = fixture(t, 0);
  assert.equal(f.budget.reserve(), true);
  assert.equal(f.budget.reserve(), true);
  f.budget.observe({ remaining: 0, resetAt: f.at() + 120_000 });
  assert.equal(f.budget.reserve(), false);
  assert.equal(f.budget.nextAllowedAt(), f.at() + 120_000);
  f.advance(120_000);
  assert.equal(f.budget.reserve(), true);
});

test('remaining quota is spread over the rest of the advertised window', async t => {
  const f = fixture(t, 1_000);
  // Four calls left with a minute to go: one every 15s, not four in a row.
  f.budget.observe({ remaining: 4, resetAt: f.at() + 60_000 });
  assert.equal(f.budget.reserve(), true);
  f.advance(14_000);
  assert.equal(f.budget.reserve(), false);
  f.advance(1_000);
  assert.equal(f.budget.reserve(), true);
});

test('Retry-After blocks calls and a stale ledger cannot block them forever', async t => {
  const f = fixture(t, 0);
  f.budget.observe({ retryAfterMs: 90_000 });
  assert.equal(f.budget.reserve(), false);
  f.advance(90_000);
  assert.equal(f.budget.reserve(), true);

  fs.writeFileSync(f.file, JSON.stringify({ version: 1, blockedUntil: f.at() + 5 * 24 * 3_600_000 }));
  assert.equal(f.budget.nextAllowedAt(), f.at() + MAX_ADVERTISED_INTERVAL_MS);
});

test('waitForSlot claims the slot once free and gives up beyond the deadline', async t => {
  const f = fixture(t, 40);
  assert.equal(await f.budget.waitForSlot(1_000), true);
  const controller = new AbortController();
  // The injected clock does not move on its own, so an exhausted budget can only time out.
  assert.equal(await f.budget.waitForSlot(0), false);
  controller.abort();
  assert.equal(await f.budget.waitForSlot(1_000, controller.signal), false);
});

test('rate-limit headers are read as either a timestamp or epoch seconds', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  assert.deepEqual(parseRateLimitHeaders(new Headers({
    'anthropic-ratelimit-requests-remaining': '7',
    'anthropic-ratelimit-requests-reset': '2026-09-17T12:01:00Z'
  }), now), { remaining: 7, resetAt: now + 60_000, retryAfterMs: undefined });
  assert.deepEqual(parseRateLimitHeaders(new Headers({
    'anthropic-ratelimit-requests-remaining': '0',
    'anthropic-ratelimit-requests-reset': String(Math.floor(now / 1000) + 30)
  }), now), { remaining: 0, resetAt: now + 30_000, retryAfterMs: undefined });
  assert.deepEqual(parseRateLimitHeaders(new Headers({ 'retry-after': '12' }), now),
    { remaining: undefined, resetAt: undefined, retryAfterMs: 12_000 });
  // A response without any of them must not look like an exhausted quota.
  assert.equal(parseRateLimitHeaders(new Headers({ 'content-type': 'application/json' }), now), undefined);
  assert.equal(parseRateLimitHeaders(new Headers({ 'anthropic-ratelimit-requests-remaining': '' }), now), undefined);
});

test('a missing or corrupt ledger allows the next call', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'not json');
  assert.equal(f.budget.reserve(), true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f.file, 'utf8'))).sort(), ['lastCallAt', 'version']);
});
