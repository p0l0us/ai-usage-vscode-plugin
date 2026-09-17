import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { SessionRecords } from '../src/session-records.mjs';
import { BridgeEngine } from '../src/engine.mjs';
import { EventQueue } from '../src/common.mjs';
import { normalizeRequest } from '../src/request.mjs';

test('saved links retain their exact native session after a bridge restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-records-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sessions.json');
  const nativeId = randomUUID();
  const adapter = { start: async () => {
    const events = new EventQueue(); events.push({ type: 'done' });
    return { threadId: nativeId, cwd: directory, events, launchCommand: { file: 'claude', args: [] }, close: async () => events.end() };
  } };
  const engine = new BridgeEngine({ claude: adapter }, { sessionRecordsFile: file });
  await engine.loadSessionRecords();
  await engine.sessionSettings.update({ claude: { persistSessions: true, openInExtension: true } });
  await engine.complete(normalizeRequest({ model: 'claude/haiku', messages: [{ role: 'user', content: 'private prompt' }] }));
  const id = engine.inspect()[0].id;
  await engine.close();
  const restarted = new BridgeEngine({}, { sessionRecordsFile: file });
  await restarted.loadSessionRecords();
  assert.equal(restarted.sessions.size, 0);
  assert.equal(restarted.inspect(id)[0].native_session_id, nativeId);
  assert.deepEqual(restarted.inspect(id)[0].launch, {});
  await restarted.sessionSettings.update({ claude: { openInExtension: true, openInCli: true } });
  assert.equal(restarted.inspect(id)[0].launch.extension_url, `vscode://anthropic.claude-code/open?session=${nativeId}`);
  assert.deepEqual(restarted.inspect(id)[0].launch.cli.args, ['--resume', nativeId]);
  assert.doesNotMatch(await readFile(file, 'utf8'), /private prompt/);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  await restarted.close();
});

test('record storage excludes live/unsaved sessions and private fields, serializes writes, and bounds retention', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-records-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionRecords(path.join(directory, 'sessions.json'));
  const record = () => ({ id: randomUUID(), backend: 'claude', native_session_id: randomUUID(), cwd: directory,
    persisted: true, released: true, account: 'private account', messages: ['private prompt'], token: 'private credential' });
  const records = Array.from({ length: 1005 }, record);
  await Promise.all([store.save([record()]), store.save([...records, { ...record(), released: false }, { ...record(), persisted: false }])]);
  const loaded = await store.load();
  assert.equal(loaded.length, 1000);
  assert.deepEqual(loaded.map(r => r.id), records.slice(-1000).map(r => r.id));
  assert.doesNotMatch(await readFile(store.file, 'utf8'), /private/);
  const active = loaded.at(-1);
  await store.save([{ ...active, released: false }, record()]);
  assert.ok((await store.load()).some(r => r.id === active.id && r.released), 'Another chat finishing retains the running chat’s previous saved checkpoint');
});
