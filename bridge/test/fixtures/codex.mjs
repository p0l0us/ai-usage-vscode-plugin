#!/usr/bin/env node
import readline from 'node:readline';
import assert from 'node:assert/strict';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const answer = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
let tool;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === 'tool-request') {
    assert.equal(m.result.success, true);
    notify('item/agentMessage/delta', { delta: m.result.contentItems[0].text });
    notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
    notify('turn/completed', { turn: { status: 'completed' } }); return;
  }
  switch (m.method) {
    case 'initialize': assert.equal(m.params.capabilities.experimentalApi, true); if (!process.env.BYOK_TEST_PAUSE_INIT) answer(m.id, {}); break;
    case 'initialized': break;
    case 'account/read': answer(m.id, { account: { type: process.env.BYOK_TEST_ACCOUNT || 'chatgpt' } }); break;
    case 'config/read': answer(m.id, { config: { mcp_servers: { inherited: {} } } }); break;
    case 'model/list': answer(m.id, { data: [{ model: 'fixture' }] }); break;
    case 'thread/start':
      assert.deepEqual(m.params.environments, []);
      assert.equal(m.params.config['mcp_servers."inherited".enabled'], false);
      assert.equal(m.params.ephemeral, true);
      assert.equal(m.params.approvalPolicy, 'never');
      assert.ok(process.argv.includes('features.shell_tool=false'));
      assert.ok(process.argv.includes('features.hooks=false'));
      tool = m.params.dynamicTools[0]; answer(m.id, { thread: { id: 'thread-test' } }); break;
    case 'thread/inject_items':
      assert.ok(m.params.items.some(i => i.type === 'message' && i.role === 'assistant'));
      answer(m.id, {}); break;
    case 'turn/start':
      answer(m.id, { turn: { id: 'turn-test' } });
      if (m.params.input[0].text === 'unexpected-tool') {
        send({ id: 'unexpected', method: 'item/commandExecution/requestApproval', params: {} });
      } else if (tool) {
        send({ id: 'tool-request', method: 'item/tool/call', params: { threadId: 'thread-test', turnId: 'turn-test', callId: 'backend-call', tool: tool.name, arguments: { value: 'fixture' } } });
      } else {
        notify('item/agentMessage/delta', { delta: 'fixture reply' });
        notify('turn/completed', { turn: { status: 'completed' } });
      }
      break;
    default: answer(m.id, {});
  }
});
