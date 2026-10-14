const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const live = require('../out/live');
const { temporary, fakeCli } = require('./fixtures/live/helpers');

const NOW = new Date('2026-10-11T12:00:00Z');
const after = (ms) => new Date(NOW.getTime() + ms);

test('formatResetRemaining uses only the largest whole unit and never goes negative', () => {
  const cases = [
    [undefined, ''], [after(-60_000), '0m'], [after(0), '0m'], [after(1), '1m'], [after(59 * 60_000), '59m'],
    [after(60 * 60_000), '1h'], [after(60 * 60_000 + 1), '1h'], [after(23 * 3600_000 + 59 * 60_000), '23h'],
    [after(24 * 3600_000), '1d'], [after(4 * 86400_000 + 5 * 3600_000), '4d']
  ];
  for (const [date, label] of cases) {
    assert.equal(live.formatResetRemaining(date, NOW), label, String(date?.toISOString()));
  }
});

test('formatResetIn is empty without a reset and phrased otherwise', () => {
  assert.equal(live.formatResetIn(undefined, NOW), '');
  assert.equal(live.formatResetIn(after(2 * 3600_000), NOW), 'resets in 2h');
});

test('resolveCli finds a bare command on PATH, skips non-executables and returns undefined when absent', (t) => {
  const root = temporary(t);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const cli = fakeCli(bin, '', 'ai-usage-fake-tool');
  fs.writeFileSync(path.join(bin, 'plain-file'), 'x', { mode: 0o600 });
  const saved = process.env.PATH;
  process.env.PATH = `${path.join(root, 'nowhere')}${path.delimiter}${bin}`;
  t.after(() => { process.env.PATH = saved; });
  assert.equal(live.resolveCli('ai-usage-fake-tool'), cli);
  assert.equal(live.resolveCli('plain-file'), undefined, 'a file without the execute bit is not a CLI');
  assert.equal(live.resolveCli('ai-usage-missing-tool'), undefined);
  // A command containing a path separator is used as given, never searched for.
  assert.equal(live.resolveCli(cli), cli);
  assert.equal(live.resolveCli(path.join(bin, 'plain-file')), undefined);
});
