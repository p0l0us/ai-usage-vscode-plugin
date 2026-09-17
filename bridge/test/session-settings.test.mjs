import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionSettings } from '../src/session-settings.mjs';
import { BridgeEngine } from '../src/engine.mjs';
import { CodexAdapter } from '../src/codex.mjs';
import { ClaudeAdapter } from '../src/claude.mjs';
import { normalizeRequest } from '../src/request.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { EventQueue } from '../src/common.mjs';

test('SSE announces a native session before the backend produces its first answer', async t => {
  const events = new EventQueue();
  const engine = new BridgeEngine({ codex: { start: async () => ({
    threadId: 'native-started', cwd: os.tmpdir(), launchCommand: { file: 'codex', args: [] }, events,
    close: async () => events.end()
  }) } });
  await engine.sessionSettings.update({ codex: { persistSessions: true, openInCli: true, openInExtension: true } });
  const token = 'test-token-at-least-24-characters';
  const server = createBridgeServer(engine, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await engine.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'codex/test', messages: [{ role: 'user', content: 'hello' }], stream: true }),
    signal: AbortSignal.timeout(3000)
  });
  const reader = response.body.getReader(); let initial = '';
  while (!initial.includes('bridge_session')) initial += new TextDecoder().decode((await reader.read()).value);
  const frame = initial.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(frame => frame.bridge_session);
  assert.equal(frame.bridge_session.id, response.headers.get('x-cli-bridge-session-id'));
  assert.equal(frame.bridge_session.native_session_id, 'native-started');
  assert.equal(frame.bridge_session.released, false);
  assert.equal(frame.bridge_session.launch.cli.command, 'codex');
  assert.deepEqual(engine.inspect()[0].launch, {}); // Preview is not permission to open the live worker.
  events.push({ type: 'text', text: 'answer' }); events.push({ type: 'done' });
  let rest = ''; for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
  assert.match(rest, /answer/); assert.match(rest, /\[DONE\]/);
  assert.equal(engine.inspect()[0].released, true);
});

test('session settings survive restart, validate atomically and stay private', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  const settings = new SessionSettings(file); await settings.load();
  assert.equal(settings.value.codex.persistSessions, false);
  await settings.update({ codex: { persistSessions: true, openInExtension: true } });
  const reloaded = new SessionSettings(file); await reloaded.load();
  assert.deepEqual(reloaded.value, settings.value);
  assert.equal(reloaded.value.claude.persistSessions, false);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  for (const input of [null, [], { codex: { persistSessions: 'true' } }, { claude: { sessionDirectory: 'relative' } }, { codex: { openInCli: null } }, { unknown: {} }]) {
    await assert.rejects(settings.update(input), e => e.code === 'invalid_request_error');
  }
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), reloaded.value);
});

for (const [provider, Adapter] of [['codex', CodexAdapter], ['claude', ClaudeAdapter]]) {
  test(`${provider} saves native sessions in a stable workspace and gates opening independently`, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge saved workspace '));
    const previous = process.env.BYOK_TEST_SESSION_DIRECTORY;
    process.env.BYOK_TEST_SESSION_DIRECTORY = directory;
    const command = fileURLToPath(new URL(`./fixtures/${provider}.mjs`, import.meta.url));
    const engine = new BridgeEngine({ [provider]: new Adapter({ command }) });
    t.after(async () => {
      await engine.close(); await rm(directory, { recursive: true, force: true });
      if (previous === undefined) delete process.env.BYOK_TEST_SESSION_DIRECTORY; else process.env.BYOK_TEST_SESSION_DIRECTORY = previous;
    });
    await writeFile(path.join(directory, 'keep.txt'), 'workspace file');
    const settings = { persistSessions: true, openInCli: true, openInExtension: true, sessionDirectory: directory };
    await engine.sessionSettings.update({ [provider]: settings });
    const body = { model: provider === 'codex' ? 'codex/fixture' : 'claude/sonnet', bridge_persist: true, messages: [{ role: 'user', content: 'hello' }] };
    let id;
    await engine.complete(normalizeRequest(body), { onSession: value => { id = value; } });
    const worker = [...engine.sessions][0];
    const temporary = worker.backend.directory;
    assert.equal(engine.inspect(id)[0].persisted, true);
    assert.deepEqual(engine.inspect(id)[0].launch, {}); // No opening while a worker still owns the session.
    await engine.dispose(worker);
    const record = engine.inspect(id)[0];
    assert.equal(record.cwd, directory);
    assert.equal(record.launch.cli.command, process.execPath); // Respect configured JS/Windows launcher wrappers.
    assert.deepEqual(record.launch.cli.args, [command, provider === 'codex' ? 'resume' : '--resume', record.native_session_id]);
    assert.equal(record.launch.extension_url, provider === 'codex' ? `vscode://openai.chatgpt/local/${record.native_session_id}` : `vscode://anthropic.claude-code/open?session=${record.native_session_id}`);
    assert.equal(await readFile(path.join(directory, 'keep.txt'), 'utf8'), 'workspace file');
    await assert.rejects(stat(temporary), { code: 'ENOENT' });
    await engine.sessionSettings.update({ [provider]: { ...settings, openInCli: false } });
    assert.equal(engine.inspect(id)[0].launch.cli, undefined);
    assert.ok(engine.inspect(id)[0].launch.extension_url);
    await engine.sessionSettings.update({ [provider]: { ...settings, persistSessions: false, openInExtension: false } });
    assert.equal(engine.inspect(id)[0].launch.extension_url, undefined);
    assert.ok(engine.inspect(id)[0].launch.cli); // Disabling storage does not delete old saved sessions.
    delete process.env.BYOK_TEST_SESSION_DIRECTORY;
    await engine.complete(normalizeRequest({ ...body, bridge_persist: false }));
    const unsaved = engine.inspect().at(-1);
    assert.equal(unsaved.persisted, false); assert.deepEqual(unsaved.launch, {});
  });
}

test('session settings endpoint requires local authentication and rejects invalid updates', async t => {
  const engine = new BridgeEngine({});
  const token = 'local-token-at-least-24-characters';
  const server = createBridgeServer(engine, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await engine.close(); });
  const url = `http://127.0.0.1:${server.address().port}/v1/session-settings`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(url, { method: 'PUT', headers: { ...headers, origin: 'https://example.com' }, body: '{}' })).status, 403);
  assert.equal((await fetch(url, { method: 'PUT', headers, body: '{' })).status, 400);
  assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ claude: { sessionDirectory: '../bad' } }) })).status, 400);
  const response = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ claude: { persistSessions: true, openInExtension: true } }) });
  assert.equal(response.status, 200);
  const settings = await (await fetch(url, { headers })).json();
  assert.equal(settings.claude.persistSessions, true); assert.equal(settings.codex.persistSessions, false);
});
