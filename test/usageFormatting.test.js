const assert = require('node:assert/strict');
const test = require('node:test');
const { formatUsagePercent, formatEarnedResetCount, formatEarnedResetSummary } = require('../out/usageFormatting');
const { projectResetCredits } = require('../service/out');

test('usage percentages display whole numbers, including floating-point quota artifacts', () => {
  for (const [percent, expected] of [
    [0.0999999999999432, '0%'],
    [59.6, '60%'],
    [59.4, '59%'],
    [7, '7%'],
    [0, '0%'],
    [100, '100%']
  ]) {
    assert.equal(formatUsagePercent(percent), expected);
  }
});

test('earned reset toolbar counts default on, preserve known zero and omit unknown or disabled availability', () => {
  assert.equal(formatEarnedResetCount(2), '$(refresh) 2');
  assert.equal(formatEarnedResetCount(0), '$(refresh) 0');
  assert.equal(formatEarnedResetCount(undefined), '');
  assert.equal(formatEarnedResetCount(2, false), '');
});

test('the toolbar displays only availability known by the shared active-account credit projection', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const display = (primary, fallback) => {
    const credits = projectResetCredits(primary, now, fallback);
    return formatEarnedResetCount(credits.state === 'known' ? credits.availableCount : undefined);
  };
  const current = { fetchedAt: new Date(now), resetCredits: { availableCount: 2 } };
  const before = structuredClone(current);
  assert.equal(display(current), '$(refresh) 2');
  assert.equal(display({ ...current, windows: [{ label: '5h', usedPercent: 100,
    resetsAt: new Date(now - 1000) }] }), '$(refresh) 2', 'quota expiry does not expire still-fresh earned credits');
  assert.equal(display({ fetchedAt: new Date(now), resetCredits: { availableCount: 0 } }), '$(refresh) 0');
  assert.equal(display({ fetchedAt: new Date(now) }), '');
  assert.equal(display({ fetchedAt: new Date(now - 16 * 60_000), resetCredits: { availableCount: 2 } }), '');
  assert.equal(display({ fetchedAt: new Date(now), resetCredits: { availableCount: 2, earliestExpiresAt: now / 1000 - 1 } }), '');
  assert.equal(display({ fetchedAt: new Date(now - 10_000) }, current), '$(refresh) 2');
  assert.equal(display({ fetchedAt: new Date(now), resetCredits: { availableCount: 0 } },
    { fetchedAt: new Date(now - 10_000), resetCredits: { availableCount: 8 } }), '$(refresh) 0');
  assert.deepEqual(current, before);
});

test('menu reset balances use observed totals and credit expiry without inventing missing facts', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const reading = (availableCount, totalCount, expiresIn) => projectResetCredits({
    fetchedAt: now, resetCredits: { availableCount, totalCount,
      ...(expiresIn === undefined ? {} : { earliestExpiresAt: (now.getTime() + expiresIn) / 1000 }) }
  }, now.getTime());
  assert.equal(formatEarnedResetSummary(reading(2, 3, 10 * 86_400_000), now), '$(refresh) 2/3 (10d)');
  assert.equal(formatEarnedResetSummary(reading(0, 3), now), '$(refresh) 0/3');
  assert.equal(formatEarnedResetSummary(reading(1, undefined, 2 * 3_600_000), now), '$(refresh) 1/? (2h)');
  assert.equal(formatEarnedResetSummary(reading(0, 0), now), '$(refresh) 0/0');
  assert.equal(formatEarnedResetSummary({ state: 'unknown' }, now), '$(refresh) ?/?');
  const fresh = reading(2, 3, 10 * 86_400_000);
  assert.equal(formatEarnedResetSummary({ ...fresh, state: 'stale', lastReportedAvailableCount: 2 }, now),
    '$(refresh) 2/3 (10d) (stale)');
  assert.equal(formatEarnedResetSummary(reading(1, 3, -1000), now), '$(refresh) 1/3 (stale)');
});
