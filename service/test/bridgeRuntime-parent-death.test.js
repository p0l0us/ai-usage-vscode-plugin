const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { fork } = require('node:child_process');
const { BridgeRuntime } = require('../out/bridgeRuntime');
const { defaultConfig } = require('../out/configStore');

function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux' && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch { return false; }
}
async function until(condition, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Bridge did not exit after owner death.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

for (const active of [false, true]) test(`owner SIGKILL ${active ? 'during delayed native inference' : 'while idle'} awaits child exit before replacement spawn`, { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-parent-death-'));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const tokenFile = path.join(root, 'token');
  const owner = fork(path.join(__dirname, 'fixtures', 'bridgeOwnerProcess.js'), [String(port), tokenFile, root, ...(active ? [path.join(__dirname, 'fixtures', 'delayedCodex.mjs')] : [])], {
    env: { ...process.env, HOME: root, AI_USAGE_HOME: path.join(root, 'usage'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), BRIDGE_DRAIN_FIXTURE_ROOT: root },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  const ownerExited = new Promise(resolve => owner.once('exit', resolve));
  let replacement;
  let bridgePid;
  let nativePid;
  let inference;
  let reader;
  t.after(async () => {
    owner.kill('SIGKILL'); await ownerExited;
    await replacement?.dispose();
    if (bridgePid && alive(bridgePid)) process.kill(bridgePid, 'SIGKILL');
    if (nativePid && alive(nativePid)) process.kill(nativePid, 'SIGKILL');
    await inference;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Managed bridge startup timed out.')), 15000);
    owner.once('error', error => { clearTimeout(timer); reject(error); });
    owner.once('message', message => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message); });
  });
  bridgePid = ready.bridgePid;
  assert.equal(ready.owner.pid, owner.pid);
  assert.ok(alive(bridgePid));
  if (active) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${fs.readFileSync(tokenFile, 'utf8').trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex/delayed', messages: [{ role: 'user', content: 'hold synthetic inference until cancellation' }], stream: true })
    });
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    inference = (async () => { try { while (!(await reader.read()).done) {} } catch { /* Owner death interrupts the stream. */ } })();
    await until(() => fs.existsSync(path.join(root, 'active-native.json')));
    nativePid = JSON.parse(fs.readFileSync(path.join(root, 'active-native.json'), 'utf8')).pid;
    assert.ok(alive(nativePid));
  }
  owner.kill('SIGKILL'); await ownerExited;
  if (active) {
    await until(() => fs.existsSync(path.join(root, `draining-${nativePid}`)));
    assert.ok(alive(bridgePid), 'bridge still drains after listener closes');
    assert.ok(alive(nativePid), 'native process deliberately delays cancellation');
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${fs.readFileSync(tokenFile, 'utf8').trim()}` } }));
  }
  const config = defaultConfig(); config.bridge.autoStart = true;
  config.bridge.url = `http://127.0.0.1:${port}`; config.bridge.tokenFile = tokenFile;
  replacement = new BridgeRuntime(() => config);
  const processes = require('node:child_process');
  const spawn = processes.spawn;
  let spawnObserved = false;
  processes.spawn = function (...args) {
    if (args[1]?.[0]?.endsWith('cli.mjs')) {
      spawnObserved = true;
      assert.equal(alive(bridgePid), false, 'old bridge must already have exited when replacement spawn begins');
      if (active) {
        assert.equal(alive(nativePid), false, 'old native process must exit before replacement begins');
        assert.ok(fs.existsSync(path.join(root, `drained-${nativePid}`)), 'native drain completed gracefully');
      }
    }
    return spawn.apply(this, args);
  };
  try { await replacement.ensure({ folders: [root] }); }
  finally { processes.spawn = spawn; }
  assert.equal(spawnObserved, true);
  const health = await replacement.request('/health');
  assert.equal(health.owner.pid, process.pid);
  assert.notEqual(health.owner.id, ready.owner.id);
  assert.notEqual(replacement.child.pid, bridgePid, 'takeover owns a replacement child rather than attaching the orphan');
  await until(() => !alive(bridgePid));
  await replacement.dispose();
});
