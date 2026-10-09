require('./helpers/fixtureNetwork');
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { startServiceHost, ServiceClient } = require('../service/out');
const { isolateHomes, seedFixture, setFixture, eventually } = require('./helpers/runtimeHost');
const { options } = require('./helpers/resetConfirmationHostChild');

async function fixture(t, mode) {
  const f = isolateHomes(t); seedFixture(f.home, f.env);
  const base = Date.now(); setFixture(f.home, { now: base, base });
  if (mode === 'embedded') {
    f.host = await startServiceHost(options(f.home, mode)); f.cleanups.push(() => f.host.stop());
  } else {
    const child = fork(path.join(__dirname, 'helpers/resetConfirmationHostChild.js'), [], { env: f.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    f.cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.send('stop', () => {});
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      }
    });
    const [message] = await once(child, 'message'); if (message.error) throw new Error(message.error);
  }
  f.connect = async name => {
    const client = await ServiceClient.connect({ home: f.home, client: name, subscribe: 'all' });
    f.cleanups.push(() => client.close()); return client;
  };
  f.a = await f.connect('reset-window-a'); f.b = await f.connect('reset-window-b');
  const initialConfig = await f.a.getConfigState();
  await f.a.patchConfig({ 'codex.cliPath': path.join(f.home, 'native-cli-forbidden'), 'claude.cliPath': path.join(f.home, 'native-cli-forbidden') }, initialConfig.revision);
  const saved = await f.a.saveNative('codex', { name: 'Synthetic reset account' });
  await f.a.activate('codex', saved.profile.id);
  const config = await f.a.getConfigState();
  await f.a.patchConfig({ 'codex.autoReset.confirmationRequired': true, 'codex.autoReset.enabled': true }, config.revision);
  let decision;
  await eventually(async () => { [decision] = await f.a.resetConfirmations(); return !!decision; });
  f.decision = decision;
  f.spent = () => fs.existsSync(path.join(f.home, 'redemptions.jsonl')) ? fs.readFileSync(path.join(f.home, 'redemptions.jsonl'), 'utf8').trim().split('\n').length : 0;
  f.change = values => { const current = JSON.parse(fs.readFileSync(path.join(f.home, 'fixture.json'))); setFixture(f.home, { ...current, ...values }); };
  return f;
}

for (const mode of ['background', 'embedded']) {
  for (const scenario of ['approve', 'cancel', 'noUI', 'credit', 'account', 'expiry', 'disconnect', 'shutdown', 'request-cancel']) {
    test(`${mode}: reset confirmation ${scenario} across real socket windows`, async t => {
      const f = await fixture(t, mode); const id = f.decision.id;
      assert.equal(f.spent(), 0); assert.equal(f.decision.plannedCredits, 1);
      if (scenario !== 'noUI') {
        assert.equal((await f.a.claimReset(id)).id, id);
        assert.equal(await f.b.claimReset(id), null);
        assert.equal((await f.b.resolveReset(id, true)).status, 'stale');
      }
      if (scenario === 'approve') {
        const outcomes = await Promise.all([f.a.resolveReset(id, true), f.a.resolveReset(id, true)]);
        assert.equal(outcomes.filter(result => result.status === 'completed').length, 1, JSON.stringify(outcomes));
        assert.equal(f.spent(), 1, JSON.stringify(outcomes)); assert.equal((await f.a.resolveReset(id, true)).status, 'stale');
        return;
      }
      if (scenario === 'cancel') assert.equal((await f.b.resolveReset(id, false)).status, 'cancelled');
      if (scenario === 'credit') { f.change({ credits: 0 }); await f.a.call('usage.read', { provider: 'codex', id: f.decision.accountId }); }
      if (scenario === 'account') await f.a.delete('codex', f.decision.accountId);
      if (scenario === 'expiry' || scenario === 'noUI') {
        const current = JSON.parse(fs.readFileSync(path.join(f.home, 'fixture.json')));
        f.change({ now: current.now + 5 * 60_000 + 1 });
      }
      if (scenario === 'disconnect') {
        f.a.close(); await eventually(async () => (await f.b.resetConfirmations()).length === 0);
      }
      if (scenario === 'request-cancel') {
        f.change({ delayMs: 300 });
        const blocker = f.a.call('usage.read', { provider: 'codex', id: f.decision.accountId });
        await eventually(() => fs.existsSync(path.join(f.home, 'probe-waiting')));
        const controller = new AbortController();
        const approval = f.a.resolveReset(id, true, { signal: controller.signal });
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(approval, error => error.code === 'cancelled');
        await blocker; assert.equal(f.spent(), 0);
        assert.equal((await f.a.resolveReset(id, true)).status, 'stale'); return;
      }
      if (scenario === 'shutdown') { await f.b.call('service.shutdown'); assert.equal(f.spent(), 0); return; }
      const caller = scenario === 'disconnect' ? f.b : f.a;
      assert.equal((await caller.resolveReset(id, true)).status, 'stale');
      assert.equal(f.spent(), 0);
    });
  }
}
