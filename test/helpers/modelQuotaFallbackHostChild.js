require('./fixtureNetwork');
const fs = require('node:fs');
const path = require('node:path');
const { startServiceHost } = require('../../service/out');
const { hostOptions } = require('./runtimeHostOptions');
exports.options = (home, mode) => {
  const options = hostOptions(home, mode);
  const state = () => JSON.parse(fs.readFileSync(path.join(home, 'fixture.json'), 'utf8'));
  const usage = token => {
    const data = state(); const windows = data.accounts[token];
    if (!windows) return { kind: 'unavailable', provider: 'claude', reason: 'Unknown synthetic quota' };
    return { kind: 'ok', usage: { provider: 'claude', title: 'Claude', fetchedAt: new Date(data.now),
      windows: windows.map(([label, usedPercent]) => ({ label, usedPercent, resetsAt: new Date(data.now + 86_400_000) })) } };
  };
  return { ...options, engineOptions: { ...options.engineOptions,
    identityOf: async (provider, credential) => ({ accountId: credential.claudeAiOauth?.accessToken || 'codex', email: `${credential.claudeAiOauth?.accessToken || 'codex'}@example.test` }),
    syncClaudeMetadata: async () => ({ status: 'synced', detail: 'Synthetic identity verified' }),
    fetchUsage: async (provider, context) => {
      if (provider !== 'claude') return options.engineOptions.fetchUsage(provider, context);
      const credential = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), 'utf8'));
      return usage(credential.claudeAiOauth.accessToken);
    },
    probe: async (provider, credential, settings, keepAlive) => {
      if (provider !== 'claude') throw new Error('Unexpected non-Claude probe');
      const token = credential.claudeAiOauth.accessToken;
      fs.appendFileSync(path.join(home, 'probes.jsonl'), JSON.stringify({ token, keepAlive, model: settings.model }) + '\n');
      const data = state();
      if (keepAlive && data.exhaustOnVerify === token) {
        data.accounts[token] = [['5h', 100], ['7d', 65], ['7d Fable', 100]];
        fs.writeFileSync(path.join(home, 'fixture.json'), JSON.stringify(data));
      }
      return { credential, result: usage(token) };
    },
    reset: async () => { throw new Error('Reset is forbidden in model-fallback fixture'); }
  } };
};
if (require.main === module) (async () => {
  const host = await startServiceHost(exports.options(process.env.AI_USAGE_HOME, 'background'));
  process.send?.({ ready: true });
  process.on('message', message => { if (message === 'stop') void host.stop(); });
  await host.stopped; process.disconnect?.();
})().catch(error => { process.send?.({ error: error.message }); process.exitCode = 1; });
