#!/usr/bin/env node
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { redImage, blueImage } from './images.mjs';
if (process.argv.includes('--version')) { console.log('0.154.0'); process.exit(0); }
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const answer = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
let tool; let historyImages = []; let resumed = false; let threadId = 'thread-test';
const saved = () => path.join(process.env.BYOK_TEST_SESSION_DIRECTORY, 'fixture-codex-tools.json');
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
    case 'model/list':
      assert.equal(m.params.includeHidden, true);
      if (m.params.cursor === 'hidden-page') answer(m.id, { data: [{ model: 'hidden-fixture', displayName: 'Hidden Native Model', hidden: true, inputModalities: ['text'] }], nextCursor: null });
      else answer(m.id, { data: [{ model: 'fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], inputModalities: ['text', 'image'] }, { model: 'text-only', inputModalities: ['text'] }], nextCursor: 'hidden-page' });
      break;
    case 'thread/start':
      assert.deepEqual(m.params.environments, []);
      assert.equal(m.params.config['mcp_servers."inherited".enabled'], false);
      assert.equal(typeof m.params.ephemeral, 'boolean');
      if (process.env.BYOK_TEST_SESSION_DIRECTORY) {
        assert.equal(m.params.ephemeral, false);
        assert.equal(m.params.cwd, process.env.BYOK_TEST_SESSION_DIRECTORY);
      } else assert.equal(m.params.ephemeral, true);
      assert.equal(m.params.approvalPolicy, 'never');
      assert.ok(process.argv.includes('features.shell_tool=false'));
      assert.ok(process.argv.includes('features.hooks=false'));
      tool = m.params.dynamicTools[0];
      if (!m.params.ephemeral) writeFileSync(saved(), JSON.stringify(m.params.dynamicTools));
      answer(m.id, { thread: { id: 'thread-test' } }); break;
    case 'thread/fork':
    case 'thread/resume':
      assert.equal(m.params.threadId, 'thread-test');
      assert.equal(m.params.cwd, process.env.BYOK_TEST_SESSION_DIRECTORY);
      assert.equal(m.params.config['mcp_servers."inherited".enabled'], false);
      assert.equal(m.params.approvalPolicy, 'never');
      assert.equal(m.params.sandbox, 'read-only');
      resumed = true; tool = JSON.parse(readFileSync(saved(), 'utf8'))[0];
      if (m.method === 'thread/fork') threadId = 'thread-fork-test';
      answer(m.id, { thread: { id: threadId } }); break;
    case 'thread/inject_items':
      assert.equal(resumed, false, 'Resume must not inject duplicate history');
      assert.ok(m.params.items.some(i => i.type === 'message' && i.role === 'assistant'));
      historyImages = m.params.items.flatMap(i => i.content || []).filter(p => p.type === 'input_image');
      answer(m.id, {}); break;
    case 'turn/start':
      if (resumed && m.params.input.some(p => p.type === 'image')) {
        assert.equal(m.params.input[0].text, 'Follow-up image');
        assert.equal(m.params.input[1].url, redImage);
      } else if (m.params.input.some(p => p.type === 'image')) {
        assert.deepEqual(m.params.input, [
          { type: 'text', text: 'Inspect images' },
          { type: 'image', url: redImage, detail: 'low' },
          { type: 'text', text: 'Then this one' },
          { type: 'image', url: blueImage, detail: 'auto' }
        ]);
        assert.deepEqual(historyImages, [{ type: 'input_image', image_url: blueImage, detail: 'high' }]);
      }
      answer(m.id, { turn: { id: 'turn-test' } });
      if (m.params.input[0].text === 'unexpected-tool') {
        send({ id: 'unexpected', method: 'item/commandExecution/requestApproval', params: {} });
      } else if (tool) {
        if (process.env.BYOK_TEST_SUBAGENTS) {
          notify('item/started', { threadId, item: { type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-thread', agentPath: '/root/echo_child' } });
          notify('item/agentMessage/delta', { threadId: 'child-thread', delta: 'CHILD_NOISE' });
          notify('item/completed', { threadId: 'child-thread', item: { type: 'agentMessage', text: 'Child result' } });
          notify('turn/completed', { threadId: 'child-thread', turn: { status: 'completed' } });
        }
        send({ id: 'tool-request', method: 'item/tool/call', params: { threadId: 'thread-test', turnId: 'turn-test', callId: 'backend-call', tool: tool.name, arguments: { value: 'fixture' } } });
      } else {
        notify('item/agentMessage/delta', { delta: 'fixture reply' });
        notify('turn/completed', { turn: { status: 'completed' } });
      }
      break;
    default: answer(m.id, {});
  }
});
