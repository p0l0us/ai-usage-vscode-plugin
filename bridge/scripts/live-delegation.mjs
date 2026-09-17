// Explicit live check: native delegation, external tools, and a saved fork.
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
const { values } = parseArgs({ options: { backend: { type: 'string', default: 'claude' } } });
const backend = values.backend; assert.ok(['claude', 'codex'].includes(backend));
const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-live-delegation-'));
const engine = new BridgeEngine({ [backend]: backend === 'claude' ? new ClaudeAdapter() : new CodexAdapter() }, { requestMs: 120000 });
const secret = randomBytes(8).toString('hex');
const model = backend === 'claude' ? 'claude/haiku' : 'codex/gpt-5.6-sol';
const agentEvents = [];
const tools = [{ type: 'function', function: { name: 'external_echo', description: 'Return the supplied value.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }];
const run = async (prompt, fork) => {
  const messages = [{ role: 'user', content: prompt }]; let id; let calls = 0;
  for (let i = 0; i < 8; i++) {
    const result = await engine.complete(normalizeRequest({ model, tools, messages,
      ...(i === 0 && fork ? { bridge_fork_session_id: fork } : {}) }), { onSession: value => { id = value; }, onSubagent: event => agentEvents.push(event) });
    messages.push(result.message);
    if (result.finish_reason === 'stop') return { id, text: result.message.content, calls };
    for (const call of result.message.tool_calls) {
      assert.equal(call.function.name, 'external_echo'); calls++;
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.parse(call.function.arguments).value });
    }
  }
  throw new Error('Too many external tool rounds');
};
try {
  await engine.sessionSettings.update({ [backend]: { persistSessions: true, subagentsEnabled: true, sessionDirectory: directory } });
  const result = await run(`Remember secret ${secret}. Explicitly spawn exactly one native ${backend === 'claude' ? 'bridge-worker subagent' : 'subagent with inherited context/tools (fork_turns all)'}. Have that child call external_echo with value CHILD_OK and return the result. Wait for it and reply CHILD_OK. You must actually delegate and the child must use the external tool.`);
  assert.ok(result.calls > 0, 'Child must call the external tool');
  const parent = engine.inspect(result.id)[0];
  assert.ok(parent.subagents?.length > 0, 'Native child metadata must be tracked');
  assert.equal(parent.released, true);
  assert.ok(agentEvents.some(event => event.session_id === parent.id && event.agent.status === 'running'));
  assert.ok(agentEvents.some(event => event.session_id === parent.id && event.agent.status === 'completed'));
  assert.ok(parent.subagents.some(agent => agent.label || agent.summary), 'Agent details must have a native label or result');
  console.log(`${backend}: native delegation and external tool relay passed; tracked children ${parent.subagents.length}`);
  const child = await run('This is a new branch. Call external_echo with value BRANCH_OK, then repeat the secret from the parent conversation.', parent.id);
  assert.ok(child.text.includes(secret), 'Native fork must inherit the parent history');
  const branch = engine.inspect(child.id)[0];
  assert.equal(branch.parent_id, parent.id);
  assert.notEqual(branch.native_session_id, parent.native_session_id);
  assert.ok(engine.inspect(parent.id)[0].child_ids.includes(branch.id));
  console.log(`PASS ${backend}: native fork has a distinct session and retained parent context`);
} finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
