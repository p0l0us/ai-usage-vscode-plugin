#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { redImage, blueImage } from './images.mjs';
if (process.argv.includes('--version')) { console.log('2.1.273'); process.exit(0); }
const args = process.argv.slice(2);
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: process.env.BYOK_TEST_CLAUDE_AUTH || 'claude.ai', apiProvider: 'firstParty' }));
} else {
  assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
  const lines = readline.createInterface({ input: process.stdin });
  const [line] = await new Promise(resolve => lines.once('line', line => resolve([line])));
  const input = JSON.parse(line);
  if (input.type === 'control_request') {
    assert.equal(input.request.subtype, 'initialize');
    assert.ok(args.includes('--no-session-persistence'));
    assert.ok(args.includes('--restricted'));
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
    const models = [
      { value: 'sonnet', displayName: 'Sonnet Native', resolvedModel: 'claude-sonnet-fixture', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
      { value: 'opus', displayName: 'Opus Native', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
      { value: 'haiku', displayName: 'Haiku Native' },
      { value: 'native-future-model[1m]', displayName: 'Future model (1M)', supportsEffort: true, supportedEffortLevels: ['high', 'xhigh', 'max'] }
    ];
    console.log(JSON.stringify({ type: 'control_response', response: { request_id: input.request_id, subtype: 'success', response: { models } } }));
    // No user prompt is ever needed for discovery; leave stdin open until cleanup.
    lines.on('line', () => { throw new Error('Discovery must not send a user prompt'); });
    await new Promise(() => {});
  }
  assert.equal(args.includes('--no-session-persistence'), !process.env.BYOK_TEST_SESSION_DIRECTORY);
  if (process.env.BYOK_TEST_SESSION_DIRECTORY) {
    assert.equal(process.cwd(), process.env.BYOK_TEST_SESSION_DIRECTORY);
    assert.equal(process.env.CLAUDE_CODE_ENTRYPOINT, 'ai-usage-copilot');
  }
  assert.equal(input.type, 'user'); assert.equal(input.message.role, 'user');
  assert.equal(input.parent_tool_use_id, null);
  const content = input.message.content;
  assert.ok(Array.isArray(content));
  const resumed = args.includes('--resume');
  if (resumed) {
    assert.equal(args[args.indexOf('--resume') + 1], 'claude-fixture-session');
    assert.ok(!content[0].text.startsWith('Continue the external conversation'));
  }
  const images = content.filter(p => p.type === 'image');
  if (resumed && images.length) {
    assert.equal(content[0].text, 'Follow-up image');
    assert.equal(images[0].source.data, redImage.split(',')[1]);
  } else if (images.length) {
    assert.deepEqual(images.map(p => p.source), [blueImage, redImage, blueImage].map(url => ({ type: 'base64', media_type: 'image/png', data: url.split(',')[1] })));
    assert.ok(content[0].text.includes('"attachment":"image_1"'));
    assert.ok(!content[0].text.includes('base64'));
    assert.match(content[1].text, /image_1.*message 1/);
    assert.match(content[3].text, /image_2.*message 3/);
    assert.match(content[5].text, /image_3.*message 3/);
  }
  assert.equal(args[args.indexOf('--tools') + 1], process.env.BYOK_TEST_SUBAGENTS ? 'Agent,TaskOutput,TaskStop' : '');
  assert.ok(args.includes('--restricted'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--bare'));
  const config = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1], 'utf8'));
  const relay = config.mcpServers.bridge;
  const child = spawn(relay.command, relay.args, { env: { ...process.env, ...relay.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const send = m => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const output = m => console.log(JSON.stringify(m));
  const done = text => {
    output({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    output({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 3 } });
  };
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line);
    if (m.id === 1) send({ id: 2, method: 'tools/list' });
    if (m.id === 2) {
      const tools = m.result.tools;
      output({ type: 'system', subtype: 'init', session_id: args.includes('--fork-session') ? 'claude-fixture-fork' : 'claude-fixture-session', tools: tools.map(t => `mcp__bridge__${t.name}`) });
      if (process.env.BYOK_TEST_SUBAGENTS) output({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agent-call', name: 'Agent', input: { subagent_type: 'bridge-worker' } }] } });
      if (!tools.length) done('fixture reply');
      else send({ id: 3, method: 'tools/call', params: { name: tools[0].name, arguments: { value: 'fixture' } } });
    }
    if (m.id === 3) {
      if (process.env.BYOK_TEST_SUBAGENTS) {
        output({ type: 'stream_event', parent_tool_use_id: 'agent-call', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'CHILD_NOISE' } } });
        output({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: 'agentId: child-claude' }] } });
      }
      done(m.result.content[0].text);
    }
  });
  lines.on('line', line => { const message = JSON.parse(line); done('next: ' + message.message.content[0].text); });
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  process.stdin.resume();
}
