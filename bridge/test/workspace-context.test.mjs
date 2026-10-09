import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { BridgeEngine } from '../src/engine.mjs';
import { EventQueue } from '../src/common.mjs';
import { normalizeRequest } from '../src/request.mjs';
import { createBridgeServer } from '../src/server.mjs';

const token = 'fixture-workspace-secret-at-least-24-characters';
function context(directories, expiresAt = Date.now() + 60000) {
  return { directories, expiresAt, signature: createHmac('sha256', token).update(JSON.stringify({ directories, expiresAt })).digest('hex') };
}
const messages = [{ role: 'user', content: 'workspace fixture' }];
const body = { model: 'codex/fixture', messages };

function setup(t) {
  const started = [];
  const adapter = { async start(request) {
    started.push(request.sessionDirectory);
    const events = new EventQueue(); events.push({ type: 'text', text: request.sessionDirectory }); events.push({ type: 'done' });
    return { events, threadId: randomUUID(), cwd: request.sessionDirectory, close: async () => events.end() };
  } };
  const engine = new BridgeEngine({ codex: adapter });
  t.after(() => engine.close());
  return { engine, started };
}

test('workspace context rejects untrusted paths, tampering and expiry', () => {
  const signed = context({ codex: os.tmpdir() });
  assert.equal(normalizeRequest({ ...body, bridge_workspace_context: signed }, token).workspaceDirectories.codex, os.tmpdir());
  assert.throws(() => normalizeRequest({ ...body, bridge_workspace_context: signed }), /workspace context/);
  assert.throws(() => normalizeRequest({ ...body, bridge_workspace_context: { ...signed, directories: { codex: path.join(os.tmpdir(), 'tampered') } } }, token), /signature/);
  assert.throws(() => normalizeRequest({ ...body, bridge_workspace_context: context({}, Date.now() - 1000) }, token), /expired/);
  assert.throws(() => normalizeRequest({ ...body, bridge_workspace_context: context({ codex: 'relative' }) }, token), /context/);
  assert.throws(() => normalizeRequest({ ...body, bridge_workspace_directory: '/untrusted' }, token), /Unsupported/);
});

test('concurrent HTTP requests use independent signed workspace directories and leave global policy unchanged', async t => {
  const { engine, started } = setup(t);
  const server = createBridgeServer(engine, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const directories = ['a', 'b'].map(name => path.join(os.tmpdir(), 'bridge-workspace-' + name));
  const responses = await Promise.all(directories.map(directory => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, bridge_workspace_context: context({ codex: directory }) })
  })));
  const results = await Promise.all(responses.map(async response => { assert.equal(response.status, 200); return response.json(); }));
  assert.deepEqual(results.map(result => result.choices[0].message.content), directories);
  assert.deepEqual(started.sort(), directories.sort());
  assert.equal(engine.sessionSettings.value.codex.sessionDirectory, '');
});

for (const foreign of ['different workspace', 'empty workspace', 'multiple unresolved folders']) {
  test(`${foreign} cannot resume or fork a saved session from another workspace`, async t => {
    const { engine, started } = setup(t);
    await engine.sessionSettings.update({ codex: { persistSessions: true } });
    const directory = path.join(os.tmpdir(), 'bridge-workspace-a');
    const ownContext = context({ codex: directory });
    await engine.complete(normalizeRequest({ ...body, bridge_workspace_context: ownContext }, token));
    const record = engine.inspect()[0];
    assert.equal(record.released, true);
    const foreignContext = context(foreign === 'different workspace' ? { codex: path.join(os.tmpdir(), 'bridge-workspace-b') } : {});
    for (const link of ['bridge_resume_session_id', 'bridge_fork_session_id']) {
      await assert.rejects(engine.complete(normalizeRequest({ ...body, [link]: record.id, bridge_workspace_context: foreignContext }, token)), error => error.code === 'continuation_mismatch');
    }
    assert.equal(started.length, 1, 'rejection occurs before backend startup');
    await engine.complete(normalizeRequest({ ...body, bridge_fork_session_id: record.id, bridge_workspace_context: context({ codex: directory }) }, token));
    assert.equal(started.length, 2, 'own workspace can fork the released session');
  });
}
