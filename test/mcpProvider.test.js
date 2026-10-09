const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let enabled = true;
class Definition {
  constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); }
}
const originalLoad = Module._load;
Module._load = function(name, parent, isMain) {
  if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => enabled }) }, McpStdioServerDefinition: Definition, Uri: { file: value => value } };
  return originalLoad.call(this, name, parent, isMain);
};
const { mcpServerDefinition } = require('../out/mcpProvider');
Module._load = originalLoad;

test('the editor offers its bundled stdio adapter without service installation', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-mcp-provider-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  enabled = true;
  const { server, reason } = mcpServerDefinition(home, path.resolve(__dirname, '..'));
  assert.equal(reason, undefined);
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args.slice(-3), ['mcp', '--home', home]);
  assert.ok(fs.existsSync(server.args[0]));
  assert.equal(server.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(server.env.AI_USAGE_HOME, home);
  enabled = false;
  assert.equal(mcpServerDefinition(home).server, undefined);
});

const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { ServiceClient, configFileOf, defaultConfig, saveConfig } = require('../service/out');
const { mcpCommand } = require('../out/mcpRegistration');
const { isolateHomes, runtimeFixture, eventually } = require('./helpers/runtimeHost');

function stdioAdapter(fixture, command) {
  const child = spawn(command.command, command.args, { cwd: fixture.directory, env: { ...fixture.env, ...command.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const requests = new Map(); let next = 1; let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line); const request = requests.get(response.id);
    if (request) { clearTimeout(request.timer); requests.delete(response.id); request.resolve(response); }
  });
  fixture.cleanups.push(async () => {
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('Adapter fixture ended')); }
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
  });
  return { request(method, params) {
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('Adapter timeout: ' + stderr)); }, 5000);
      requests.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  } };
}

for (const mode of ['embedded', 'background']) test(`${mode}: the bundled service adapter uses the active engine without installing or starting one`, async t => {
  const fixture = await runtimeFixture(t, mode);
  await fixture.client.setConfig({ 'mcp.enabled': true, 'mcp.switching': false });
  assert.equal(fs.existsSync(path.join(fixture.home, 'service', 'current.json')), false);
  const command = mcpCommand(fixture.home);
  assert.deepEqual(command.args, [path.resolve(__dirname, '../service/bin/ai-usage.js'), 'mcp', '--home', fixture.home]);
  const adapter = stdioAdapter(fixture, command);
  assert.deepEqual((await adapter.request('tools/list')).result.tools.map(tool => tool.name), ['list_accounts', 'refresh_usage']);
  const usage = await adapter.request('tools/call', { name: 'list_accounts', arguments: { service: 'claude' } });
  assert.equal(usage.result.structuredContent.services[0].activeUsage.freshness.state, 'fresh');
  const pid = fixture.client.info.pid;
  const editorReader = await fixture.connect('mcp-editor-reader'); editorReader.close();
  assert.equal((await fixture.client.serviceInfo()).pid, pid, 'the adapter connected to the existing engine');
  await fixture.client.shutdown();
  await eventually(() => !fixture.client.connected);
  assert.deepEqual((await adapter.request('tools/list')).result.tools, []);
  assert.equal(fs.existsSync(path.join(fixture.home, 'service.sock')), false, 'the adapter did not replace the stopped engine');
});

test('the installed service adapter stays usable after the editor client closes and its package path is absent', async t => {
  const fixture = isolateHomes(t);
  const installedDir = path.join(fixture.home, 'service', 'fixture');
  // Copy compiled service files only into this disposable fixture; never call the installer or register autostart.
  fs.mkdirSync(installedDir, { recursive: true });
  for (const entry of ['bin', 'out', 'package.json']) fs.cpSync(path.resolve(__dirname, '../service', entry), path.join(installedDir, entry), { recursive: true });
  const node = { command: process.execPath, args: [], env: {} };
  fs.writeFileSync(path.join(fixture.home, 'service', 'current.json'), JSON.stringify({ version: 'fixture', dir: installedDir, node, installedAt: new Date().toISOString() }));
  const config = defaultConfig();
  config.claude.enabled = false; config.codex.enabled = false; config.copilot.enabled = false;
  config.codex.autoReset.enabled = false; config.bridge.autoStart = false; config.mcp.enabled = true;
  saveConfig(configFileOf(fixture.home), config);
  const daemon = spawn(node.command, [path.join(installedDir, 'bin', 'ai-usage.js'), 'daemon', '--home', fixture.home], { cwd: fixture.directory, env: fixture.env, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(daemon, 'exit'); let daemonErrors = '';
  daemon.stderr.on('data', chunk => { daemonErrors += chunk; });
  fixture.cleanups.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill('SIGTERM'); let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); clearTimeout(timer);
      if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGKILL'); await exited; }
    }
  });
  let editor;
  await eventually(async () => { try { editor = await ServiceClient.connect({ home: fixture.home, client: 'editor-fixture' }); return true; } catch { return false; } }, 'Installed fixture did not answer: ' + daemonErrors);
  fixture.cleanups.push(() => editor.close());
  const pid = editor.info.pid;
  const missingExtension = path.join(fixture.directory, 'editor-removed');
  enabled = true;
  const { server } = mcpServerDefinition(fixture.home, missingExtension);
  const command = mcpCommand(fixture.home, { bundledPackageDir: path.join(missingExtension, 'service') });
  assert.equal(server.command, node.command);
  assert.deepEqual(server.args, command.args);
  assert.equal(command.args[0], path.join(installedDir, 'bin', 'ai-usage.js'));
  assert.ok(!JSON.stringify(command).includes(missingExtension));
  editor.close();
  const adapter = stdioAdapter(fixture, command);
  assert.equal((await adapter.request('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'ai-usage');
  assert.equal((await adapter.request('tools/list')).result.tools.length, 4, 'installed adapter works without the editor');
  const observer = await ServiceClient.connect({ home: fixture.home, client: 'lifetime-observer' }); fixture.cleanups.push(() => observer.close());
  assert.equal((await observer.serviceInfo()).pid, pid);
  assert.equal(daemon.exitCode, null);
  await observer.shutdown(); await exited;
});
