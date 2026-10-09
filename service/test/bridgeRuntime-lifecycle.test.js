const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultConfig } = require('../out/configStore');

const children = [];
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'child_process') return { spawn() {
    const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
    child.pid = 900000 + children.length;
    child.closed = false; child.kill = signal => {
      child.killedWith = signal;
      setTimeout(() => { child.closed = true; child.signalCode = signal; child.emit('close', null, signal); }, 40);
      return true;
    };
    children.push(child); return child;
  } };
  return load.call(this, id, ...args);
};
const { BridgeRuntime } = require('../out/bridgeRuntime');
Module._load = load;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-owner-test-'));
  const config = defaultConfig(); config.bridge.tokenFile = path.join(directory, 'token');
  fs.writeFileSync(config.bridge.tokenFile, 'test-token-more-than-24-characters');
  const runtime = new BridgeRuntime(() => config);
  t.after(async () => { await runtime.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { runtime, config };
}

test('bridge restart waits for previous child close before health probing or attaching', async t => {
  children.length = 0;
  const { runtime, config } = fixture(t);
  const probes = [];
  runtime.request = async route => {
    if (route === '/health') {
      probes.push(children.map(child => child.closed));
      if (!children.length || children.at(-1).closed) throw new Error('offline');
    }
    return route === '/health' ? { capabilities: ['workspace_context', 'image_input'], owner: { id: runtime.ownerId, bridgePid: children.at(-1).pid } } : {};
  };
  await Promise.all([runtime.ensure(), runtime.ensure()]);
  assert.equal(children.length, 1, 'concurrent startup is coalesced');
  config.bridge.codex.executable = 'changed-fixture-executable';
  await runtime.ensure();
  assert.equal(children.length, 2, 'restart starts replacement rather than attaching to closing child');
  assert.equal(children[0].closed, true);
  assert.ok(probes.some(states => states.length === 1 && states[0] === true));
  await runtime.dispose();
  assert.equal(children[1].closed, true, 'dispose resolves after child exits');
  await assert.rejects(runtime.ensure(), /closed/);
});

test('disposal while a restart awaits old child prevents replacement spawn', async t => {
  children.length = 0;
  const { runtime, config } = fixture(t);
  runtime.request = async route => { if (!children.length) throw new Error('offline'); return route === '/health' ? { capabilities: ['workspace_context', 'image_input'], owner: { id: runtime.ownerId, bridgePid: children.at(-1).pid } } : {}; };
  await runtime.ensure();
  config.bridge.claude.executable = 'replacement';
  const restarting = runtime.ensure();
  const rejected = assert.rejects(restarting, /closed/);
  await runtime.dispose(); await rejected;
  assert.equal(children.length, 1);
  assert.equal(children[0].closed, true);
});

test('service policy synchronization does not write a clients folder to global session settings', async t => {
  const { runtime } = fixture(t);
  let body;
  runtime.request = async (route, method, input) => { assert.equal(route, '/v1/session-settings'); body = input; };
  await runtime.syncSettings({ folders: ['/client-a'] });
  assert.equal(body.codex.sessionDirectory, '');
  assert.equal(body.claude.sessionDirectory, '');
  assert.equal(runtime.connection({ folders: ['/client-a'] }).workspaceContext.directories.codex, '/client-a');
  assert.equal(runtime.connection({ folders: ['/client-b'] }).workspaceContext.directories.codex, '/client-b');
});


test('bridge requests reject absolute foreign routes before sending a token', async t => {
  const { runtime } = fixture(t);
  await assert.rejects(runtime.request('http://example.com/health'), /local endpoint/);
});

test('an older unmanaged bridge cannot silently accept requests requiring workspace context and images', async t => {
  children.length = 0;
  const { runtime } = fixture(t);
  runtime.request = async route => {
    assert.equal(route, '/health');
    return { status: 'ok', active_sessions: 0 };
  };
  await assert.rejects(runtime.ensure({ folders: ['/workspace'] }), /outdated.*workspace context or images/);
  assert.equal(children.length, 0, 'do not attach to or replace an unknown process');
});


test('malformed or nonregular managed ownership fails closed before health probing or spawn', async t => {
  const { runtime, config } = fixture(t);
  const ownerFile = config.bridge.tokenFile + '.owner.json';
  runtime.request = async () => { throw new Error('must not probe health with unknown ownership'); };
  fs.writeFileSync(ownerFile, '{partial');
  await assert.rejects(runtime.ensure(), /owner record.*invalid/);
  fs.unlinkSync(ownerFile);
  fs.symlinkSync(config.bridge.tokenFile, ownerFile);
  await assert.rejects(runtime.ensure(), /owner record.*invalid/);
});

test('a live foreign managed child blocks replacement when its HTTP listener is absent', async t => {
  const { runtime, config } = fixture(t);
  fs.writeFileSync(config.bridge.tokenFile + '.owner.json', JSON.stringify({
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pid: process.pid, parentPid: process.ppid
  }));
  let probed = false; runtime.request = async () => { probed = true; throw new Error('offline'); };
  await assert.rejects(runtime.ensure(), /another running engine/);
  assert.equal(probed, false, 'listener absence cannot authorize replacement');
});
