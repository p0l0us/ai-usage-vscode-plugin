const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The hosts below would write native CLI settings: keep every home of this file temporary.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-daemon-'));
for (const [name, dir] of [['HOME', 'home'], ['AI_USAGE_HOME', 'aiu'], ['CODEX_HOME', 'codex'], ['CLAUDE_CONFIG_DIR', 'claude']]) {
  process.env[name] = path.join(sandbox, dir);
  fs.mkdirSync(process.env[name], { recursive: true });
}
process.on('exit', () => fs.rmSync(sandbox, { recursive: true, force: true }));
const { startServiceHost } = require('../out/daemon');
const { connectService } = require('../out/client');
const { infoFile, readServiceInfo, socketPath } = require('../out/paths');

test('an embedded host serves the socket, refuses a second host, and another can take over once it stops', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-host-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude: { enabled: false }, codex: { enabled: false, autoReset: { enabled: false } }, copilot: { enabled: false }, bridge: { autoStart: false } }));

  const host = await startServiceHost({ home, version: '9.9.9', embedded: true });
  t.after(() => host.stop());
  assert.equal(readServiceInfo(home).embedded, true);
  assert.equal(readServiceInfo(home).pid, process.pid);

  const client = await connectService({ home, client: 'test', version: '1' });
  assert.equal(client.info.version, '9.9.9');
  assert.deepEqual((await client.list('codex')).profiles, []);

  await assert.rejects(startServiceHost({ home, embedded: true }), /already running/);

  const closed = new Promise((resolve) => client.on('close', resolve));
  await host.stop();
  await closed;
  await host.stopped;
  assert.equal(fs.existsSync(infoFile(home)), false);
  if (process.platform !== 'win32') { assert.equal(fs.existsSync(socketPath(home)), false); }

  const next = await startServiceHost({ home, version: '9.9.10', embedded: true });
  t.after(() => next.stop());
  const again = await connectService({ home, client: 'test', version: '1' });
  assert.equal(again.info.version, '9.9.10');
  again.close();
});

test('a client asking the embedded host to shut down stops it like the daemon', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-host-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude: { enabled: false }, codex: { enabled: false, autoReset: { enabled: false } }, copilot: { enabled: false }, bridge: { autoStart: false } }));
  const host = await startServiceHost({ home, embedded: true });
  t.after(() => host.stop());
  const client = await connectService({ home, client: 'test', version: '1' });
  await client.shutdown();
  await host.stopped;
  assert.equal(readServiceInfo(home), undefined);
  client.close();
});
