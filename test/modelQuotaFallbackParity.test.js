require('./helpers/fixtureNetwork');
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { startServiceHost, ServiceClient } = require('../service/out');
const { isolateHomes, seedFixture, setFixture } = require('./helpers/runtimeHost');
const { options } = require('./helpers/modelQuotaFallbackHostChild');
const screenshot = {
  a: [['5h', 0], ['7d', 65], ['7d Fable', 100]],
  b: [['5h', 0], ['7d', 85], ['7d Fable', 100]],
  c: [['5h', 0], ['7d', 100], ['7d Fable', 100]],
  d: [['5h', 100], ['7d', 80], ['7d Fable', 62]],
  e: [['5h', 100], ['7d', 70], ['7d Fable', 79]]
};
async function fixture(t, mode, scenario) {
  const f = isolateHomes(t); seedFixture(f.home, f.env);
  const accounts = structuredClone(screenshot);
  if (scenario === 'prefer') accounts.b[2][1] = 30;
  if (scenario === 'verify') accounts.b = structuredClone(accounts.c);
  setFixture(f.home, { accounts, ...(scenario === 'verify' ? { exhaustOnVerify: 'a' } : {}) });
  if (mode === 'embedded') {
    f.host = await startServiceHost(options(f.home, mode)); f.cleanups.push(() => f.host.stop());
  } else {
    const child = fork(path.join(__dirname, 'helpers/modelQuotaFallbackHostChild.js'), [], { env: f.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
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
  f.client = await ServiceClient.connect({ home: f.home, client: 'model-fallback-window', subscribe: 'all' });
  f.cleanups.push(() => f.client.close());
  const config = await f.client.getConfigState();
  await f.client.patchConfig({ 'claude.cliPath': path.join(f.home, 'native-cli-forbidden'), 'codex.cliPath': path.join(f.home, 'native-cli-forbidden'), 'claude.autoRotate.modelLimits': 'always' }, config.revision);
  f.ids = {};
  for (const key of Object.keys(accounts)) {
    const saved = await f.client.importCredential('claude', `Claude ${key}`, { claudeAiOauth: { accessToken: key, expiresAt: Date.now() + 86_400_000 } });
    f.ids[key] = saved.profile.id;
  }
  await f.client.activate('claude', f.ids[scenario === 'stay' ? 'a' : 'c']);
  for (const id of Object.values(f.ids)) await f.client.call('usage.read', { provider: 'claude', id });
  return f;
}
for (const mode of ['background', 'embedded']) {
  for (const scenario of ['fallback', 'prefer', 'stay', 'verify', 'manual']) {
    test(`${mode}: Claude model quota ${scenario} keeps general quota hard and limitation truthful`, async t => {
      const f = await fixture(t, mode, scenario);
      if (scenario === 'manual') {
        await f.client.activate('claude', f.ids.a);
      } else {
        const config = await f.client.getConfigState();
        await f.client.patchConfig({ 'claude.autoRotate.enabled': true }, config.revision);
        await f.client.call('automation.tick');
      }
      const view = await f.client.list('claude');
      const selected = view.profiles.find(profile => profile.active);
      if (scenario === 'prefer') assert.equal(selected.id, f.ids.b);
      else if (scenario === 'verify') assert.equal(selected.id, f.ids.c);
      else assert.equal(selected.id, f.ids.a);
      if (scenario !== 'prefer' && scenario !== 'verify') {
        assert.deepEqual(selected.limit, { readOnly: false, dimmed: true });
        assert.equal(selected.usage.windows.find(window => window.label === '7d Fable').usedPercent, 100);
      }
      for (const key of ['d', 'e']) assert.equal(view.profiles.find(profile => profile.id === f.ids[key]).limit.readOnly, true);
      const updated = await f.client.getConfig(); assert.equal(updated.claude.keepAlive.model, 'haiku');
      if (scenario === 'stay') {
        await f.client.call('automation.tick');
        assert.equal((await f.client.list('claude')).profiles.find(profile => profile.active).id, f.ids.a);
      }
    });
  }
}
