require('./fixtureNetwork');
const fs = require('node:fs');
const path = require('node:path');
const { hostOptions } = require('./runtimeHostOptions');
const { fetchAutoUsage } = require('../../service/out/live');
exports.options = (home, mode) => {
  const options = hostOptions(home, mode);
  options.engineOptions.fetchUsage = async (provider, context, known) => {
    const state = JSON.parse(fs.readFileSync(path.join(home, 'fixture.json'), 'utf8'));
    const request = require('node:crypto').randomUUID();
    const spacing = { nextAllowedAt: () => 0, reserve: () => true };
    return fetchAutoUsage({ provider, known, now: () => state.now, intervalMs: 30 * 60000,
      apiSpacing: spacing, cliSpacing: spacing, ...Object.fromEntries(['local', 'api', 'cli'].map(source => [source, async () => {
        fs.appendFileSync(path.join(home, 'source-reads.jsonl'), JSON.stringify({ provider, source, request }) + '\n');
        const scenario = state.sources?.[source] || 'unavailable';
        if (scenario === 'error' || scenario === '429') return { kind: 'error', provider, title: provider, message: 'fixture failure', transient: true, ...(scenario === '429' ? { status: 429 } : {}) };
        if (scenario === 'unavailable') return { kind: 'unavailable', provider };
        return { kind: 'ok', usage: { provider, title: provider, fetchedAt: new Date(state.now - (scenario === 'stale' ? 31 * 60000 : 1000)), windows: [{ label: '5h', usedPercent: 37, resetsAt: new Date(state.now + 3600000) }] } };
      }])) });
  };
  return options;
};
if (require.main === module) {
  const { startServiceHost } = require('../../service/out');
  startServiceHost(exports.options(process.env.AI_USAGE_HOME, 'background')).then(host => {
    process.send({ ready: true });
    process.on('message', async message => { if (message === 'stop') { await host.stop(); process.exit(0); } });
  }).catch(error => { process.send({ error: error.message }); process.exit(1); });
}
