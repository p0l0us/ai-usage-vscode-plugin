const { BridgeRuntime } = require('../../service/out/bridgeRuntime');
const { defaultConfig, setConfigValue, resolveKey } = require('../../service/out/configStore');
/** Run the real shared service bridge controller behind the extension's RPC boundary. */
exports.bridgeService = (test, integration, settings, vscode) => {
  test.beforeEach(t => {
    const runtime = new BridgeRuntime(() => {
      let config = defaultConfig();
      for (const [key, value] of settings) {
        const dotted = key.replace(/^aiUsage\./, '');
        try { resolveKey(dotted); } catch { continue; }
        config = setConfigValue(config, dotted, value);
      }
      return config;
    }, () => (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath));
    integration.configureBridgeService(async () => ({ call: async method => {
      if (method === 'bridge.ensure') return runtime.ensure();
      if (method === 'bridge.connection') return runtime.connection();
      if (method === 'bridge.sync') return runtime.syncSettings();
      throw new Error(`Unexpected method ${method}`);
    } }));
    t.after(() => runtime.dispose());
  });
};
