require('../../test/helpers/fixtureNetwork');
const assert = require('node:assert/strict');
const test = require('node:test');
const { projectResetCredits, projectQuota, RESET_CREDIT_FRESHNESS_MS } = require('../out/statusProjection');
const now = Date.UTC(2026, 9, 9);
const credit = (availableCount, age = 0, extra = {}) => ({ fetchedAt: new Date(now - age), resetCredits: { availableCount, ...extra } });
const quota = windows => ({ provider: 'codex', title: 'Codex', fetchedAt: new Date(now).toISOString(), windows });

test('reset credit projection distinguishes known zero, unknown and stale without quota reset coupling', () => {
  assert.equal(projectResetCredits(credit(0), now).availableCount, 0);
  assert.equal(projectResetCredits(undefined, now).state, 'unknown');
  const stale = projectResetCredits(credit(3, RESET_CREDIT_FRESHNESS_MS), now);
  assert.equal(stale.state, 'stale'); assert.equal(stale.lastReportedAvailableCount, 3); assert.equal(stale.availableCount, undefined);
  const reading = { ...credit(2), windows: [{ label: '5h', usedPercent: 100, resetsAt: new Date(now - 1) }] };
  assert.equal(projectResetCredits(reading, now).state, 'known');
});

test('newest credit report wins including invalid/stale records; no older-known resurrection', () => {
  assert.equal(projectResetCredits(credit(1, 1000), now, credit(4)).availableCount, 4);
  assert.equal(projectResetCredits(credit(-1), now, credit(4, 1000)).state, 'unknown');
  assert.equal(projectResetCredits(credit(2, 0, { earliestExpiresAt: (now - 1) / 1000 }), now, credit(4, 1000)).state, 'stale');
  assert.equal(projectResetCredits({ fetchedAt: 'invalid', resetCredits: { availableCount: 1 } }, now, credit(4)).state, 'unknown');
});

for (const expiry of [NaN, Infinity, -1, 0, 1e308]) test(`malformed credit expiry ${expiry} stays unknown`, () => {
  assert.equal(projectResetCredits(credit(1, 0, { earliestExpiresAt: expiry }), now).state, 'unknown');
});

test('credit expiry and local TTL bound validity, future timestamps and invalid counts stay unknown', () => {
  const known = projectResetCredits(credit(0, 0, { earliestExpiresAt: (now + 60000) / 1000, totalCount: 5 }), now);
  assert.equal(Date.parse(known.validUntil), now + 60000); assert.equal(known.totalCount, 5);
  for (const value of [-1, 1.5, NaN, Infinity]) assert.equal(projectResetCredits(credit(value), now).state, 'unknown');
  assert.equal(projectResetCredits(credit(1, -1), now).state, 'unknown');
});

test('status quota retains raw decimal and same whole display, with separate general/model facts', () => {
  const result = projectQuota(quota([{ label: '5h', usedPercent: 99.49 }, { label: '7d Fable', usedPercent: 100 }]), now, 60000);
  assert.equal(result.windows[0].usedPercent, 99.49); assert.equal(result.windows[0].displayUsedPercent, 99);
  assert.equal(result.availability, 'model-limited'); assert.equal(result.accountAttributed, true);
  assert.equal(projectQuota(quota([{ label: '7d Fable', usedPercent: 20 }]), now, 60000).availability, 'unknown');
  assert.equal(projectQuota(quota([{ label: '5h', usedPercent: 100 }]), now, 60000).availability, 'general-exhausted');
});

test('quota clock/reset expiry makes overall availability unknown without erasing reported facts', () => {
  const reading = quota([{ label: '5h', usedPercent: 35.6, resetsAt: new Date(now + 100).toISOString() }]);
  const stale = projectQuota(reading, now + 100, 60000, false);
  assert.equal(stale.state, 'stale'); assert.equal(stale.availability, 'unknown'); assert.equal(stale.windows[0].displayUsedPercent, 36);
  assert.equal(stale.accountAttributed, false);
});


test('malformed report timestamp and quota shape remain unknown', () => {
  assert.equal(projectResetCredits({ fetchedAt: 0, resetCredits: { availableCount: 1 } }, now).state, 'unknown');
  assert.equal(projectQuota({ fetchedAt: new Date(now).toISOString() }, now, 60000).state, 'unknown');
  assert.equal(projectQuota(quota([null]), now, 60000).state, 'unknown');
});
