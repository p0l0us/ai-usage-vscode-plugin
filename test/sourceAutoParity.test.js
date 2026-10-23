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
        // A provider's background poll must not consume the other provider's scenario or inherit its 429.
        // Clear before publishing the new scenario so a concurrent poll's new evidence cannot be erased.
        const scenarioId = `${provider}:${scenario.attempts.join('-')}:${scenario.source || 'rate'}`;
        fs.writeFileSync(file, ''); setFixture(f.home, { sources: { [provider]: scenario.sources }, scenarioId });
        await client.setConfig({ [`${provider}.cliPath`]: 'synthetic-' + scenario.attempts.join('-') + (scenario.source || '-rate') });
        const view = await client.liveUsage(provider, true);
        const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.provider === provider && row.scenarioId === scenarioId);
        const attempts = rows.map(row => row.source);
        assert.ok(rows.length > 0);
        // The forced read walks the sources in cost order; background polls only re-read the free local source.
        const requests = [...new Set(rows.map(row => row.request))].map(request => rows.filter(row => row.request === request).map(row => row.source));
        assert.deepEqual(requests[0], scenario.attempts);
        for (const later of requests.slice(1)) assert.ok([JSON.stringify(scenario.attempts), '["local"]'].includes(JSON.stringify(later)), JSON.stringify(later));
        if (scenario.source) {
          assert.equal(view.result.kind, 'ok'); assert.equal(view.result.usage.source, scenario.source);
          assert.equal(Date.parse(view.result.usage.fetchedAt), JSON.parse(fs.readFileSync(path.join(f.home, 'fixture.json'), 'utf8')).now - 1000);
          await client.liveUsage(provider, true);
          const after = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.provider === provider && row.scenarioId === scenarioId);
          assert.deepEqual([...new Set(after.slice(attempts.length).map(row => row.source))].filter(source => source !== 'local'), [],
            'fresh engine cache avoids every endpoint and CLI call');
        } else { assert.equal(view.result.kind, 'error'); assert.equal(view.result.status, 429); }
      }
    }
  });
}
