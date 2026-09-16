#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: process.env.BYOK_TEST_CLAUDE_AUTH || 'claude.ai', apiProvider: 'firstParty' }));
} else {
  assert.equal(args[args.indexOf('--tools') + 1], '');
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
    child.kill();
  };
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line);
    if (m.id === 1) send({ id: 2, method: 'tools/list' });
    if (m.id === 2) {
      const tools = m.result.tools;
      output({ type: 'system', subtype: 'init', tools: tools.map(t => `mcp__bridge__${t.name}`) });
      if (!tools.length) done('fixture reply');
      else send({ id: 3, method: 'tools/call', params: { name: tools[0].name, arguments: { value: 'fixture' } } });
    }
    if (m.id === 3) done(m.result.content[0].text);
  });
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  process.stdin.resume();
}
