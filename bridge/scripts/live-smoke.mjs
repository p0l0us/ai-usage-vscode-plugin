// Explicit opt-in: consumes the selected CLI subscription's allowance.
// Acts as the external agent/client. All fixture IO occurs here, never in an adapter.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CodexAdapter } from '../src/codex.mjs';
import { ClaudeAdapter } from '../src/claude.mjs';
import { BridgeEngine } from '../src/engine.mjs';
import { createBridgeServer } from '../src/server.mjs';

const { values } = parseArgs({ options: { backend: { type: 'string', default: 'codex' }, model: { type: 'string' } } });
assert.ok(['codex', 'claude'].includes(values.backend), '--backend must be codex or claude');
const adapter = values.backend === 'codex' ? new CodexAdapter() : new ClaudeAdapter();
const engine = new BridgeEngine({ [values.backend]: adapter });
const token = randomBytes(32).toString('hex');
const server = createBridgeServer(engine, { token });
const directory = await mkdtemp(path.join(os.tmpdir(), 'byok-live-client-'));
const fixture = path.join(directory, 'fixture.txt');
const toolSchema = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const tools = [
  toolSchema('read_fixture', 'Read the fixture text through the external client.'),
  toolSchema('write_fixture', 'Replace the fixture text through the external client.', { content: { type: 'string' } }, ['content']),
  toolSchema('test_fixture', 'Test whether the external fixture now contains exactly blue followed by a newline.')
];
const calls = [];
try {
  await writeFile(fixture, 'red\n');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const models = await engine.models();
  const model = values.model || (values.backend === 'claude' ? 'claude/haiku' : models[0].id);
  console.log(`Live subscription test: ${model}`);
  const messages = [
    { role: 'system', content: 'You are testing an external agent tool bridge. Use only the provided tools. Read the fixture, write the requested replacement, and test it, in that order. Never fabricate tool results. Once the test passes, reply with BRIDGE_OK and stop.' },
    { role: 'user', content: 'Read the fixture, replace red with blue keeping the newline, then run the fixture test.' }
  ];
  let completed = false;
  for (let step = 0; step < 8; step++) {
    const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ model, messages, tools, stream: true, max_tokens: 2048 }), signal: AbortSignal.timeout(180000) });
    assert.equal(response.status, 200, await (response.ok ? Promise.resolve('') : response.text()));
    const frames = (await response.text()).split('\n\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    assert.equal(frames.at(-1), '[DONE]');
    const message = { role: 'assistant', content: '' }; let finish;
    for (const frame of frames.slice(0, -1)) {
      const chunk = JSON.parse(frame); assert.equal(chunk.error, undefined, chunk.error?.message);
      const choice = chunk.choices[0]; if (!choice) continue;
      message.content += choice.delta.content || '';
      if (choice.delta.tool_calls) message.tool_calls = choice.delta.tool_calls.map(({ index, ...call }) => call);
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    messages.push(message);
    if (finish === 'stop') { assert.match(message.content, /BRIDGE_OK/); completed = true; break; }
    assert.equal(finish, 'tool_calls');
    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments); let result;
      calls.push(call.function.name); console.log(`Client executes ${call.function.name}`);
      switch (call.function.name) {
        case 'read_fixture': result = await readFile(fixture, 'utf8'); break;
        case 'write_fixture': assert.equal(typeof args.content, 'string'); await writeFile(fixture, args.content); result = 'Written.'; break;
        case 'test_fixture': result = (await readFile(fixture, 'utf8')) === 'blue\n' ? 'PASS' : 'FAIL'; break;
        default: throw new Error('Unexpected tool');
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  assert.ok(completed, 'Backend failed to complete within 8 requests');
  assert.deepEqual(calls, ['read_fixture', 'write_fixture', 'test_fixture']);
  assert.equal(await readFile(fixture, 'utf8'), 'blue\n');
  assert.equal(engine.sessions.size, 0);
  console.log('PASS: HTTP SSE → external read → external edit → external test → final answer');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await engine.close(); await rm(directory, { recursive: true, force: true });
}
