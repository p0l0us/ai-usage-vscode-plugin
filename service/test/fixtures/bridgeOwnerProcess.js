const { BridgeRuntime } = require('../../out/bridgeRuntime');
const { defaultConfig } = require('../../out/configStore');
const config = defaultConfig();
config.bridge.url = `http://127.0.0.1:${process.argv[2]}`;
config.bridge.tokenFile = process.argv[3];
config.bridge.autoStart = true;
if (process.argv[5]) { config.bridge.codex.executable = process.argv[5]; config.bridge.codex.persistSessions = true; }
const runtime = new BridgeRuntime(() => config);
(async () => {
  await runtime.ensure({ folders: [process.argv[4]] });
  const health = await runtime.request('/health');
  process.send({ bridgePid: runtime.child.pid, owner: health.owner });
})().catch(error => { process.send?.({ error: error.message }); process.exitCode = 1; });
