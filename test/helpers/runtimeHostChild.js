require('./fixtureNetwork');
const { startServiceHost } = require('../../service/out');
const { hostOptions } = require('./runtimeHostOptions');

(async () => {
  const home = process.env.AI_USAGE_HOME;
  const mode = process.argv[2];
  try {
    const host = await startServiceHost(hostOptions(home, mode));
    process.send?.({ ready: true, pid: process.pid, instanceId: host.instanceId });
    process.on('message', message => { if (message === 'stop') void host.stop(); });
    process.once('SIGTERM', () => void host.stop());
    await host.stopped;
    process.disconnect?.();
  } catch (error) {
    process.send?.({ error: error.message, code: error.code });
    process.exitCode = 1;
    process.disconnect?.();
  }
})();
