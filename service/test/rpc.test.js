const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RpcServer, RpcClient, RpcError } = require('../out/rpc');
const { runDaemon } = require('../out/daemon');
const { ServiceClient, ServiceUnavailableError, connectService, pingService } = require('../out/client');
const { socketPath, readServiceInfo } = require('../out/paths');

function temporaryHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-rpc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('the server refuses anything before a hello with the token, answers calls and pushes events to subscribers', async (t) => {
  const home = temporaryHome(t);
  const socket = socketPath(home);
  const server = new RpcServer({ socketPath: socket, token: 'secret', handle: async (method, params) => {
    if (method === 'echo') return { params };
    if (method === 'boom') throw new Error('kaboom');
    throw new Error(`unknown ${method}`);
  } });
  await server.listen();
  t.after(() => server.close());
  await assert.rejects(RpcClient.connect({ socketPath: socket, token: 'wrong', client: 'test' }), (error) => error instanceof RpcError && /unauthorized/.test(error.message));
  const { client: a } = await RpcClient.connect({ socketPath: socket, token: 'secret', client: 'a', subscribe: ['ping'] });
  const { client: b } = await RpcClient.connect({ socketPath: socket, token: 'secret', client: 'b' });
  assert.deepEqual(await a.call('echo', { x: 1 }), { params: { x: 1 } });
  await assert.rejects(a.call('boom'), /kaboom/);
  const received = [];
  a.on('event', (event) => received.push(event));
  b.on('event', (event) => received.push(['b', event]));
  server.broadcast({ event: 'ping', n: 1 });
  server.broadcast({ event: 'other', n: 2 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(received, [{ event: 'ping', n: 1 }]);
  assert.equal(server.clientCount, 2);
  a.close(); b.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(server.clientCount, 0);
});

test('a daemon serves the typed client, reports itself, and stops on request', async (t) => {
  const home = temporaryHome(t);
  const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  process.env.CODEX_HOME = path.join(home, 'codex');
  t.after(() => { for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  await assert.rejects(ServiceClient.connect({ home, client: 'test' }), (error) => error instanceof ServiceUnavailableError && error.reason === 'not-installed');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude: { enabled: false }, codex: { enabled: false, autoReset: { enabled: false } }, copilot: { enabled: false }, bridge: { autoStart: false } }));
  const daemon = runDaemon({ home, version: '9.9.9' });
  const client = await connectService({ home, client: 'test', subscribe: 'all', start: () => undefined, waitMs: 5_000 });
  assert.equal(client.info.version, '9.9.9');
  assert.equal(client.info.pid, process.pid);
  const info = readServiceInfo(home);
  assert.equal(info.version, '9.9.9');
  const snapshot = await client.snapshot();
  assert.deepEqual(Object.keys(snapshot.providers), ['claude', 'codex']);
  assert.equal(snapshot.providers.claude.profiles.length, 0);
  assert.equal(snapshot.service.clients, 1);
  const events = [];
  client.on('event', (event) => events.push(event));
  await client.setConfig({ 'codex.autoRotate.enabled': true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(events.some((event) => event.event === 'configChanged' && event.config.codex.autoRotate.enabled));
  assert.ok(events.some((event) => event.event === 'log' && /config: changed codex.autoRotate.enabled = true/.test(event.line)));
  assert.ok((await client.tailLog(10)).some((line) => /account service 9.9.9 started/.test(line)));
  assert.equal((await pingService(home)).version, '9.9.9');
  await assert.rejects(runDaemon({ home }), /already running/);
  await client.shutdown();
  await daemon;
  assert.equal(readServiceInfo(home), undefined);
  assert.equal(await pingService(home), undefined);
  await assert.rejects(ServiceClient.connect({ home, client: 'test' }), (error) => error instanceof ServiceUnavailableError && error.reason === 'not-running');
});
