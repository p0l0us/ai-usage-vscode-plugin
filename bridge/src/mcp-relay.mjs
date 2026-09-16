// Private stdio MCP server launched by Claude. It forwards tool calls to the
// owning adapter, which waits for the external client's actual tool result.
import readline from 'node:readline';
const url = process.env.BYOK_RELAY_URL;
const token = process.env.BYOK_RELAY_TOKEN;
if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || !token) process.exit(1);
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
async function relay(route, body) {
  const response = await fetch(url + route, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('Bridge relay unavailable.');
  return response.json();
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
  let message;
  try { message = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
  if (message.id == null) return;
  try {
    let result;
    switch (message.method) {
      case 'initialize': result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cli-byok-bridge', version: '0.1.0' } }; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = await relay('/tools', {}); break;
      case 'tools/call': result = await relay('/call', message.params); break;
      case 'resources/list': result = { resources: [] }; break;
      case 'prompts/list': result = { prompts: [] }; break;
      default: send({ id: message.id, error: { code: -32601, message: 'Method not found' } }); return;
    }
    send({ id: message.id, result });
  } catch { send({ id: message.id, error: { code: -32603, message: 'Bridge relay failed' } }); }
});
