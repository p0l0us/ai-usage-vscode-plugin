const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchLocalThenApi } = require('../out/live');

const CHECK_INTERVAL_MS = 10 * 60_000;

function reading(label, fetchedAt) {
  return { provider: 'claude', title: label, windows: [{ label: '5h', usedPercent: 1 }], fetchedAt };
}

function fixture(overrides = {}) {
  let now = 1_000_000_000;
  const calls = { local: 0, api: 0 };
  const spacing = (intervalMs) => {
    let lastCallAt;
    return {
      nextAllowedAt: () => (lastCallAt === undefined ? 0 : lastCallAt + intervalMs),
      reserve: (at = now) => {
        if (lastCallAt !== undefined && lastCallAt + intervalMs > at) { return false; }
        lastCallAt = at;
        return true;
      }
    };
  };
  const state = {
    calls,
    fallback: spacing(CHECK_INTERVAL_MS),
    advance: (ms) => { now += ms; },
    at: () => now,
    local: () => ({ kind: 'unavailable', provider: 'claude' }),
    api: () => ({ kind: 'ok', usage: reading('api', new Date(now)) }),
    ...overrides
  };
  state.run = (known) => fetchLocalThenApi({
    known,
    apiCheckIntervalMs: CHECK_INTERVAL_MS,
    fallback: state.fallback,
    budget: state.budget,
    now: () => now,
    local: async () => { calls.local += 1; return state.local(); },
    api: async () => { calls.api += 1; return state.api(); }
  });
  return state;
}

test('a local reading inside the check interval is served without calling the service', async () => {
  const f = fixture();
  f.local = () => ({ kind: 'ok', usage: reading('local', new Date(f.at() - 60_000)) });

  const result = await f.run();

  assert.equal(result.kind, 'ok');
  assert.equal(result.usage.title, 'local');
  assert.deepEqual(f.calls, { local: 1, api: 0 });
});

test('the service fills the gap once the local reading falls behind the check interval', async () => {
  const f = fixture();
  f.local = () => ({ kind: 'ok', usage: reading('local', new Date(f.at() - CHECK_INTERVAL_MS)) });

  const result = await f.run();

  assert.equal(result.usage.title, 'api');
  assert.equal(f.calls.api, 1);
});

test('the service is called when there is no local reading at all', async () => {
  const f = fixture();

  const result = await f.run();

  assert.equal(result.usage.title, 'api');
  assert.equal(f.calls.api, 1);
});

test('fallback calls are spaced by the check interval, and the newest reading is kept meanwhile', async () => {
  const f = fixture();
  const stale = () => ({ kind: 'ok', usage: reading('local', new Date(f.at() - 3 * CHECK_INTERVAL_MS)) });
  f.local = stale;

  const first = await f.run();
  assert.equal(first.usage.title, 'api');
  const fromApi = first.usage;

  // The local file is still behind, but the service is not due again: the fresher service reading
  // stays, rather than the older local one replacing it.
  f.advance(15_000);
  const second = await f.run(fromApi);
  assert.equal(second.usage.title, 'api');
  assert.equal(second.usage.fetchedAt.getTime(), fromApi.fetchedAt.getTime());
  assert.equal(f.calls.api, 1);
  assert.equal(f.calls.local, 2);

  // Once the kept reading is itself older than the interval, the service is called again.
  f.advance(CHECK_INTERVAL_MS);
  const third = await f.run(fromApi);
  assert.equal(f.calls.api, 2);
  assert.ok(third.usage.fetchedAt > fromApi.fetchedAt);
});

test('a local reading that overtakes the service reading is used and costs no call', async () => {
  const f = fixture();
  const known = reading('api', new Date(f.at() - 2 * CHECK_INTERVAL_MS));
  f.local = () => ({ kind: 'ok', usage: reading('local', new Date(f.at() - 30_000)) });

  const result = await f.run(known);

  assert.equal(result.usage.title, 'local');
  assert.equal(f.calls.api, 0);
});

test('the service budget is honoured, and its refusal does not spend the fallback slot', async () => {
  const f = fixture();
  let allowed = false;
  f.budget = { nextAllowedAt: () => (allowed ? 0 : f.at() + 30_000), reserve: () => allowed };

  const blocked = await f.run();
  assert.equal(blocked.kind, 'unavailable');
  assert.equal(f.calls.api, 0);

  allowed = true;
  const served = await f.run();
  assert.equal(served.usage.title, 'api');
  assert.equal(f.calls.api, 1);
});

test('the local error is reported when nothing has ever been read and the service cannot be called', async () => {
  const f = fixture();
  f.local = () => ({ kind: 'error', provider: 'claude', title: 'Claude', message: 'nothing cached yet', transient: true });
  f.budget = { nextAllowedAt: () => f.at() + 30_000, reserve: () => false };

  const result = await f.run();

  assert.equal(result.kind, 'error');
  assert.equal(result.message, 'nothing cached yet');
});

test('a failed service call is reported rather than hidden behind a stale reading', async () => {
  const f = fixture();
  const known = reading('api', new Date(f.at() - 2 * CHECK_INTERVAL_MS));
  f.api = () => ({ kind: 'error', provider: 'claude', title: 'Claude', message: 'rate limited', transient: true });

  const result = await f.run(known);

  assert.equal(result.kind, 'error');
  assert.equal(result.message, 'rate limited');
});
