require('./fixtureNetwork');
const { startServiceHost } = require('../../service/out');
const { hostOptions } = require('./runtimeHostOptions');
exports.options = (home, mode) => {
  const options = hostOptions(home, mode);
  return { ...options, engineOptions: { ...options.engineOptions,
    identityOf: async (provider, credential) => ({ accountId: provider === 'codex' ? credential.tokens?.account_id : credential.claudeAiOauth?.accessToken }),
    fetchUsage: async (provider, context) => {
      const result = await options.engineOptions.fetchUsage(provider, context);
      if (result.kind === 'ok' && provider === 'codex') return { ...result, usage: { ...result.usage, source: 'api', resetCredits: { availableCount: 0 } } };
      return result;
    },
    reset: async () => { throw new Error('Reset forbidden in cached-status fixture'); }
  } };
};
if (require.main === module) (async () => {
  const host = await startServiceHost(exports.options(process.env.AI_USAGE_HOME, 'background'));
  process.send?.({ ready: true });
  process.on('message', message => { if (message === 'stop') void host.stop(); });
  await host.stopped; process.disconnect?.();
})().catch(error => { process.send?.({ error: error.message }); process.exitCode = 1; });
