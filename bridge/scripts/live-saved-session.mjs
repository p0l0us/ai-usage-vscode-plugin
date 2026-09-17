// Live subscription check: two released turns, native resume, and external tools.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BridgeEngine } from '../src/engine.mjs';
import { ClaudeAdapter } from '../src/claude.mjs';
import { CodexAdapter } from '../src/codex.mjs';
import { normalizeRequest } from '../src/request.mjs';

const { values } = parseArgs({ options: { backend: { type: 'string', default: 'claude' }, model: { type: 'string' } } });
assert.ok(['claude', 'codex'].includes(values.backend));
const backend = values.backend;
const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-live-resume-'));
const adapters = { [backend]: backend === 'claude' ? new ClaudeAdapter() : new CodexAdapter() };
const config = { sessionRecordsFile: path.join(directory, 'records.json'), sessionSettingsFile: path.join(directory, 'settings.json') };
let engine = new BridgeEngine(adapters, config);
const conversationId = randomBytes(32).toString('hex');
const secret = randomBytes(8).toString('hex');
const model = values.model || (backend === 'claude' ? 'claude/haiku' : 'codex/gpt-5.6-sol');
const tools = [{ type: 'function', function: { name: 'external_echo', description: 'Return the provided value.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }];
const run = async prompt => {
  const messages = [{ role: 'user', content: prompt }]; let called = false;
  for (let i = 0; i < 5; i++) {
    const result = await engine.complete(normalizeRequest({ model, tools, messages, bridge_conversation_id: conversationId }));
    messages.push(result.message);
    if (result.finish_reason === 'stop') { assert.ok(called, 'External tool must run on each turn'); return result.message.content; }
    for (const call of result.message.tool_calls) {
      assert.equal(call.function.name, 'external_echo'); called = true;
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.parse(call.function.arguments).value });
    }
  }
  throw new Error('Too many tool rounds');
};
try {
  await engine.sessionSettings.update({ [backend]: { persistSessions: true, openInCli: true, openInExtension: true, sessionDirectory: directory } });
  await run(`Remember the secret ${secret}. Call external_echo with value FIRST, then say ready.`);
  const first = engine.inspect()[0];
  assert.equal(first.released, true); assert.equal(engine.sessions.size, 0);
  await engine.close();
  engine = new BridgeEngine(adapters, config);
  await engine.sessionSettings.load(); await engine.loadSessionRecords();
  const answer = await run('Call external_echo with value SECOND, then tell me the secret from our previous turn.');
  assert.ok(answer.includes(secret), 'Native history must retain the secret without resending it');
  assert.equal(engine.inspect().length, 1);
  assert.equal(engine.inspect()[0].id, first.id);
  assert.equal(engine.inspect()[0].native_session_id, first.native_session_id);
  assert.equal(engine.inspect()[0].released, true);
  console.log(`PASS ${backend}: same saved native session after restart, remembered history, external tools on both turns`);
} finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
