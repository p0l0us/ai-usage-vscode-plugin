const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { UsageCoordinator, usageAccountKey } = require('../out/usageCoordinator');
const { SharedCache } = require('../out/cache');
const { projectResetCredits } = require('../out/statusProjection');
const { RequestDiagnostics, traceRequests, countRequest } = require('../out/requestDiagnostics');
const jwt = claims => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
const login = (user, workspace, token = 'first') => ({ tokens: { account_id: workspace, access_token: token,
  id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: user, chatgpt_account_id: workspace } }) } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-admission-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.now(); const metrics = [];
  const make = () => new UsageCoordinator(path.join(dir, 'admission.json'), () => now, (...args) => metrics.push(args));
  return { dir, make, coordinator: make(), metrics, now: () => now, advance: ms => { now += ms; },
    result: () => ({ kind: 'ok', usage: { provider: 'codex', title: 'Codex', source: 'api', fetchedAt: new Date(now), windows: [{ label: '5h', usedPercent: 20 }] } }) };
}
test('account keys survive token refresh but separate users, workspaces and unknown profiles', () => {
  const key = usageAccountKey('codex', login('u1', 'w1'));
  assert.equal(key, usageAccountKey('codex', login('u1', 'w1', 'refreshed')));
  assert.notEqual(key, usageAccountKey('codex', login('u2', 'w1')));
  assert.notEqual(key, usageAccountKey('codex', login('u1', 'w2')));
  assert.notEqual(usageAccountKey('codex', {}, 'a'), usageAccountKey('codex', {}, 'b'));
  assert.equal(usageAccountKey('codex', { tokens: { access_token: 'old' } }, 'a'), usageAccountKey('codex', { tokens: { access_token: 'new' } }, 'a'));
  const { isSameCredentialOwner } = require('../out/authFiles');
  assert.equal(isSameCredentialOwner('codex', login('u1', 'w1'), login('u2', 'w1')), false);
  assert.equal(isSameCredentialOwner('codex', login('u1', 'w1'), login('u1', 'w1', 'refreshed')), true);
});
test('full Retry-After survives manual requests, local observations, token refresh and restart', async t => {
  const f = fixture(t); const key = usageAccountKey('codex', login('u', 'w')); let calls = 0;
  const request = async () => { calls++; return { kind: 'error', provider: 'codex', title: 'Codex', status: 429, transient: true, retryAfterMs: 3_600_000, message: 'slow down' }; };
  await f.coordinator.read('codex', key, request);
  f.coordinator.observe(key, { kind: 'ok', usage: { ...f.result().usage, source: 'sessionLog' } });
  f.advance(31 * 60_000);
  const blocked = await f.make().read('codex', usageAccountKey('codex', login('u', 'w', 'new')), request, { manual: true });
  assert.equal(calls, 1); assert.equal(blocked.retryAfterMs, 29 * 60_000);
  f.advance(29 * 60_000); await f.make().read('codex', key, request); assert.equal(calls, 2);
});
test('concurrent status/automation reads coalesce and recent authoritative results are reused', async t => {
  const f = fixture(t); let calls = 0, release;
  const request = async () => { calls++; await new Promise(resolve => { release = resolve; }); return f.result(); };
  const a = f.coordinator.read('codex', 'account', request), b = f.coordinator.read('codex', 'account', request);
  release(); assert.deepEqual(await a, await b);
  await f.make().read('codex', 'account', request);
  assert.equal(calls, 1);
});

test('an account switch discards completed quota before it can enter the shared cache', async t => {
  const f = fixture(t); let current = true, calls = 0;
  const old = await f.coordinator.read('codex', 'account', async () => { current = false; return f.result(); }, { isCurrent: () => current });
  assert.equal(old.kind, 'unavailable');
  await f.make().read('codex', 'account', async () => { calls++; return f.result(); });
  assert.equal(calls, 1, 'the old result was not cached under any new credential generation');
});
test('terminal credential errors stop automatic attempts until replacement; plain 401 is not revocation', async t => {
  const f = fixture(t); let calls = 0;
  const request = async () => { calls++; return { kind: 'error', provider: 'codex', title: 'Codex', status: 401, message: 'Your refresh token has been revoked. Please sign in again.' }; };
  await f.coordinator.read('codex', 'account', request, { generation: 'old' });
  await f.make().read('codex', 'account', request, { generation: 'old' }); assert.equal(calls, 1);
  await f.make().read('codex', 'account', request, { generation: 'new' }); assert.equal(calls, 2);
});
test('cache caps local exponential retry but never server delays, and cannot shorten an existing deadline', t => {
  const f = fixture(t), cache = new SharedCache(path.join(f.dir, 'cache.json'));
  assert.equal(cache.recordBackoff('a', '429', 3_600_000, f.now()), f.now() + 3_600_000);
  assert.equal(cache.recordBackoff('a', 'later failure', 1000, f.now()), f.now() + 3_600_000);
  for (let i = 0; i < 20; i++) cache.recordBackoff('b', 'network', undefined, f.now());
  assert.equal(cache.read('b').nextAllowedAt, f.now() + 30 * 60_000);
});
test('fresh quota does not refresh the independent credit observation timestamp', () => {
  const now = Date.now();
  const reading = { fetchedAt: new Date(now), resetCredits: { availableCount: 2 }, creditsObservedAt: now - 20 * 60_000 };
  assert.equal(projectResetCredits(reading, now).state, 'stale');
  assert.equal(projectResetCredits({ ...reading, creditsObservedAt: now }, now).state, 'known');
});
test('diagnostics keep distinct observable counts and at most 72 hourly buckets', async t => {
  const f = fixture(t), file = path.join(f.dir, 'counts.json');
  const diagnostics = new RequestDiagnostics(file, f.now);
  await traceRequests(metric => diagnostics.record('codex', metric), async () => { countRequest('http'); await Promise.resolve(); countRequest('rpc'); countRequest('model'); });
  assert.match(diagnostics.summary('codex'), /1 direct HTTP, 1 RPC, 0 CLI starts, 1 model attempts/);
  for (let i = 0; i < 80; i++) { f.advance(3_600_000); diagnostics.record('codex', 'blocked'); }
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file))).length, 72);
});
