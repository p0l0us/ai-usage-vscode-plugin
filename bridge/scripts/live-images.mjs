// Explicit opt-in: consumes subscription allowance; sends only synthetic images.
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CodexAdapter } from '../src/codex.mjs';
import { ClaudeAdapter } from '../src/claude.mjs';
import { BridgeEngine } from '../src/engine.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { redImage, blueImage, imagePart } from '../test/fixtures/images.mjs';

const { values } = parseArgs({ options: { backend: { type: 'string', default: 'codex' }, model: { type: 'string' } } });
assert.ok(['codex', 'claude'].includes(values.backend), '--backend must be codex or claude');
const adapter = values.backend === 'codex' ? new CodexAdapter() : new ClaudeAdapter();
const engine = new BridgeEngine({ [values.backend]: adapter });
const token = randomBytes(32).toString('hex');
const server = createBridgeServer(engine, { token });
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = values.model || (values.backend === 'claude' ? 'claude/haiku' : (await engine.models()).find(m => m.bridge.image_input).id);
  console.log(`Live image subscription test: ${model}`);
  const post = async body => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, ...body }), signal: AbortSignal.timeout(180000)
    });
    assert.equal(response.status, 200, await (response.ok ? Promise.resolve('') : response.text()));
    return (await response.json()).choices[0];
  };
  const images = randomInt(2) ? [[redImage, 'red'], [blueImage, 'blue']] : [[blueImage, 'blue'], [redImage, 'red']];
  const messages = [
    { role: 'system', content: 'Follow the user instructions exactly. Use only the supplied external tools when asked.' },
    { role: 'user', content: [{ type: 'text', text: 'What single solid color is this image? Reply with only the color name.' }, imagePart(images[0][0])] }
  ];
  const first = await post({ messages });
  assert.equal(first.finish_reason, 'stop');
  assert.equal(first.message.content.trim().toLowerCase().replace(/[.!]$/, ''), images[0][1]);
  // Replace the answer with a neutral acknowledgement so the next request must
  // inspect the historical image, not copy the color from an assistant answer.
  messages.push({ role: 'assistant', content: 'Image received.' }, {
    role: 'user', content: [{ type: 'text', text: 'Call record_colors with the solid color of the earlier image as first and this new image as second. After the tool result, reply IMAGE_OK.' }, imagePart(images[1][0])]
  });
  const tools = [{ type: 'function', function: { name: 'record_colors', description: 'Record the colors of the two images in conversation order.', parameters: { type: 'object', properties: { first: { type: 'string' }, second: { type: 'string' } }, required: ['first', 'second'] } } }];
  const second = await post({ messages, tools });
  assert.equal(second.finish_reason, 'tool_calls');
  const call = second.message.tool_calls[0];
  assert.equal(call.function.name, 'record_colors');
  const colors = JSON.parse(call.function.arguments);
  assert.equal(colors.first.toLowerCase(), images[0][1]); assert.equal(colors.second.toLowerCase(), images[1][1]);
  messages.push(second.message, { role: 'tool', tool_call_id: call.id, content: 'Colors recorded successfully.' });
  const final = await post({ messages, tools });
  assert.equal(final.finish_reason, 'stop'); assert.match(final.message.content, /IMAGE_OK/);
  assert.equal(engine.sessions.size, 0);
  console.log('PASS: image recognition → historical and new images → external tool → final answer');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await engine.close();
}
