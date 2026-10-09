const { startServiceHost, ServiceClient } = require('../../service/out');
const { resolveKey } = require('../../service/out/configStore');
const { isolateHomes } = require('./runtimeHost');

/** Run the shared socket host behind the extension's real RPC boundary. */
exports.bridgeService = (test, integration, settings, vscode) => {
  test.beforeEach(t => {
    const fixture = isolateHomes(t);
    let host, client, starting;
    const connect = async () => {
      if (!starting) starting = (async () => {
        host = await startServiceHost({ home: fixture.home, mode: 'embedded', embedded: true,
          seedConfig: { 'claude.enabled': false, 'codex.enabled': false, 'copilot.enabled': false,
            'bridge.autoStart': false, 'codex.autoReset.enabled': false } });
        client = await ServiceClient.connect({ home: fixture.home, client: 'bridge-plugin-test' });
      })();
      await starting;
      const values = {};
      for (const [key, value] of settings) {
        const dotted = key.replace(/^aiUsage\./, '');
        if (!dotted.startsWith('bridge.') || /^bridge\.(codex|claude)\.sessionDirectory$/.test(dotted)) continue;
        try { resolveKey(dotted); } catch { continue; }
        values[dotted] = value;
      }
      // Deleting a mocked editor setting must restore its manifest default.
      const { defaultConfig, getConfigValue } = require('../../service/out/configStore');
      const current = await client.getConfig();
      for (const provider of ['codex', 'claude']) for (const key of Object.keys(current.bridge[provider])) {
        const dotted = `bridge.${provider}.${key}`;
        if (!(dotted in values)) values[dotted] = getConfigValue(defaultConfig(), dotted);
      }
      await client.setConfig(values);
      const sessionDirectory = Object.fromEntries(['codex', 'claude'].map(provider => [provider, settings.get(`aiUsage.bridge.${provider}.sessionDirectory`) || '']));
      await client.call('workspace.context', { sessionDirectory, folders: (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath) });
      return client;
    };
    integration.configureBridgeService(connect);
    fixture.cleanups.push(async () => { if (starting) await starting; client?.close(); await host?.stop(); });
  });
};
