require('./fixtureNetwork');
const fs = require('node:fs');
const path = require('node:path');
const { startServiceHost } = require('../../service/out');
const { hostOptions } = require('./runtimeHostOptions');

exports.options = (home, mode) => {
  const options = hostOptions(home, mode);
  options.seedConfig['codex.cliPath'] = path.join(home, 'native-cli-forbidden');
  options.seedConfig['claude.cliPath'] = path.join(home, 'native-cli-forbidden');
  const state = () => JSON.parse(fs.readFileSync(path.join(home, 'fixture.json'), 'utf8'));
  const usage = () => {
    const data = state();
    return { provider: 'codex', title: 'Codex', fetchedAt: new Date(data.now),
      windows: [{ label: '5h', usedPercent: data.used ?? 100, resetsAt: new Date(data.base + 3_600_000) }],
      resetCredits: { availableCount: data.credits ?? 1 } };
  };
  return { ...options, engineOptions: { ...options.engineOptions,
    fetchUsage: async (provider, context) => provider === 'codex' ? { kind: 'ok', usage: usage() } : options.engineOptions.fetchUsage(provider, context),
    probe: async (provider, credential) => {
      if (state().delayMs) {
        fs.writeFileSync(path.join(home, 'probe-waiting'), 'waiting');
        await new Promise(resolve => setTimeout(resolve, state().delayMs));
      }
      if (provider !== 'codex') throw new Error('Unexpected Claude probe');
      return { credential, result: { kind: 'ok', usage: usage() } };
    },
    reset: async credential => {
      fs.appendFileSync(path.join(home, 'redemptions.jsonl'), 'reset\n');
      const data = state(); fs.writeFileSync(path.join(home, 'fixture.json'), JSON.stringify({ ...data, used: 0, credits: 0 }));
      return { credential, outcome: 'reset', result: { kind: 'ok', usage: usage() } };
    }
  } };
};
if (require.main === module) (async () => {
  const host = await startServiceHost(exports.options(process.env.AI_USAGE_HOME, 'background'));
  process.send?.({ ready: true });
  process.on('message', message => { if (message === 'stop') void host.stop(); });
  await host.stopped; process.disconnect?.();
})().catch(error => { process.send?.({ error: error.message }); process.exitCode = 1; });
