require('./helpers/fixtureNetwork');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { ServiceClient, startServiceHost, loadConfig, saveConfig, configFileOf } = require('../service/out');
const { isolateHomes, seedFixture, setFixture } = require('./helpers/runtimeHost');
const { options } = require('./helpers/sourceAutoHost');
for (const mode of ['background', 'embedded']) {
  test(`${mode}: auto source fallback, cache reuse and provider retry stop share the real engine`, async t => {
    const f = isolateHomes(t); seedFixture(f.home, f.env);
    const config = loadConfig(configFileOf(f.home)); config.claude.source = config.codex.source = 'auto';
    config.claude.checkIntervalMinutes = config.codex.checkIntervalMinutes = 30; saveConfig(configFileOf(f.home), config);
    if (mode === 'embedded') {
      const host = await startServiceHost(options(f.home, mode)); f.cleanups.push(() => host.stop());
    } else {
      const child = fork(path.join(__dirname, 'helpers/sourceAutoHost.js'), [], { env: f.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const exited = once(child, 'exit');
      f.cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
      const [ready] = await once(child, 'message'); assert.equal(ready.ready, true, ready.error);
    }
    const client = await ServiceClient.connect({ home: f.home, client: 'source-auto-parity' }); f.cleanups.push(() => client.close());
    const file = path.join(f.home, 'source-reads.jsonl');
    for (const provider of ['claude', 'codex']) {
      for (const scenario of [
        { sources: { local: 'fresh', api: 'fresh', cli: 'fresh' }, attempts: ['local'], source: provider === 'claude' ? 'accountFile' : 'sessionLog' },
        { sources: { local: 'stale', api: 'fresh', cli: 'fresh' }, attempts: ['local', 'api'], source: 'api' },
        { sources: { local: 'error', api: 'unavailable', cli: 'fresh' }, attempts: ['local', 'api', 'cli'], source: 'cli' },
        { sources: { local: 'unavailable', api: '429', cli: 'fresh' }, attempts: ['local', 'api'] }
      ]) {
        // A policy revision isolates each scenario's identity-keyed cached reading.
        setFixture(f.home, { sources: scenario.sources }); fs.writeFileSync(file, '');
        await client.setConfig({ [`${provider}.cliPath`]: 'synthetic-' + scenario.attempts.join('-') + (scenario.source || '-rate') });
        const view = await client.liveUsage(provider, true);
        const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.provider === provider);
        const attempts = rows.map(row => row.source);
        assert.ok(rows.length > 0);
        for (const request of new Set(rows.map(row => row.request))) {
          assert.deepEqual(rows.filter(row => row.request === request).map(row => row.source), scenario.attempts);
        }
        if (scenario.source) {
          assert.equal(view.result.kind, 'ok'); assert.equal(view.result.usage.source, scenario.source);
          assert.equal(Date.parse(view.result.usage.fetchedAt), JSON.parse(fs.readFileSync(path.join(f.home, 'fixture.json'), 'utf8')).now - 1000);
          await client.liveUsage(provider, true);
          const after = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.provider === provider);
          assert.equal(after.length, attempts.length, 'fresh engine cache avoids all source calls');
        } else { assert.equal(view.result.kind, 'error'); assert.equal(view.result.status, 429); }
      }
    }
  });
}
