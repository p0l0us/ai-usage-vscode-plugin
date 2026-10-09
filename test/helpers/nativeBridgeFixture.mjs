#!/usr/bin/env node
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
if (process.argv.includes('--version')) {
  console.log('2.1.273');
} else if (process.argv.includes('auth')) {
  send({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
} else if (process.argv.includes('app-server')) {
  let cwd;
  const notify = (method, params) => send({ method, params });
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line); const answer = result => send({ id: request.id, result });
    switch (request.method) {
      case 'initialize': answer({}); break;
      case 'initialized': break;
      case 'account/read': answer({ account: { type: 'chatgpt' } }); break;
      case 'config/read': answer({ config: {} }); break;
      case 'model/list': answer({ data: [{ model: 'parity', inputModalities: ['text'] }] }); break;
      case 'thread/start':
        assert.equal(request.params.approvalPolicy, 'never');
        assert.equal(request.params.sandbox, 'read-only');
        assert.deepEqual(request.params.dynamicTools, []);
        cwd = request.params.cwd; answer({ thread: { id: randomUUID() } }); break;
      case 'turn/start':
        answer({ turn: { id: randomUUID() } });
        // Keep A and B children alive together to expose context bleed.
        setTimeout(() => {
          notify('item/agentMessage/delta', { delta: cwd });
          notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
          notify('turn/completed', { turn: { status: 'completed' } });
        }, 75);
        break;
      default: if (request.id !== undefined) answer({});
    }
  });
} else {
  assert.ok(process.argv.includes('--restricted'));
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const input = JSON.parse(line);
    if (input.type === 'control_request') {
      send({ type: 'control_response', response: { request_id: input.request_id, subtype: 'success', response: { models: [{ value: 'parity', displayName: 'Parity fixture' }] } } });
    } else {
      assert.equal(input.type, 'user');
      assert.equal(process.argv[process.argv.indexOf('--tools') + 1], '');
      send({ type: 'system', subtype: 'init', session_id: randomUUID(), tools: [] });
      setTimeout(() => {
        send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: process.cwd() } } });
        send({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 2 } });
      }, 75);
    }
  });
}
