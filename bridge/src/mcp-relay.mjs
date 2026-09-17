// Private stdio MCP server launched by Claude. It forwards tool calls to the
// owning adapter, which waits for the external client's actual tool result.
import readline from 'node:readline';
import http from 'node:http';
const url = process.env.BYOK_RELAY_URL;
const token = process.env.BYOK_RELAY_TOKEN;
if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || !token) process.exit(1);
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
async function relay(route, body) {
  // A tool can remain pending while Copilot runs a long task. Node fetch's
  // header deadline is shorter than that; the owning worker controls expiry.
  return new Promise((resolve, reject) => {
    const request = http.request(url + route, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; if (text.length > 8 * 1024 * 1024) request.destroy(new Error('Tool result too large.')); });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error('Bridge relay unavailable.')); return; }
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject); request.end(JSON.stringify(body));
  });
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
