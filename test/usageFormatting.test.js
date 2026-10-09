const assert = require('node:assert/strict');
const test = require('node:test');
const { formatUsagePercent } = require('../out/usageFormatting');

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
