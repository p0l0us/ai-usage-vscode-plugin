// Explicit live validation: two tiny turns consume subscription allowance.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CodexAdapter } from '../src/codex.mjs';
import { ClaudeAdapter } from '../src/claude.mjs';
import { BridgeEngine } from '../src/engine.mjs';
import { normalizeRequest } from '../src/request.mjs';
const { values } = parseArgs({ options: { backend: { type: 'string', default: 'codex' }, model: { type: 'string' } } });
assert.ok(['codex', 'claude'].includes(values.backend));
const adapter = values.backend === 'codex' ? new CodexAdapter() : new ClaudeAdapter();
const engine = new BridgeEngine({ [values.backend]: adapter });
try {
  const model = values.model || (values.backend === 'claude' ? 'claude/haiku' : (await engine.models())[0].id);
  const secret = randomBytes(5).toString('hex');
  const messages = [{ role: 'user', content: `Remember this marker: ${secret}. Reply only READY.` }];
  let id;
  const first = await engine.complete(normalizeRequest({ model, messages, bridge_persist: true }), { onSession: value => { id = value; } });
  assert.equal(first.finish_reason, 'stop'); assert.match(first.message.content, /READY/);
  const backend = [...engine.sessions][0].backend;
  const nativeId = engine.inspect(id)[0].native_session_id;
  messages.push(first.message, { role: 'user', content: 'Reply only with the marker I asked you to remember.' });
  const second = await engine.complete(normalizeRequest({ model, messages, bridge_session_id: id }));
  assert.equal(second.finish_reason, 'stop'); assert.ok(second.message.content.includes(secret));
  assert.equal([...engine.sessions][0].backend, backend);
  assert.equal(engine.inspect(id)[0].native_session_id, nativeId);
  console.log(`PASS ${model}: two user turns, one native worker/thread, retained context, ${engine.inspect(id)[0].usage ? 'native usage' : 'no usage reported'}`);
} finally { await engine.close(); }
