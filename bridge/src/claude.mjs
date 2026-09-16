import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, EventQueue, resolveCommand, spawnCommand, readJsonLines, terminate } from './common.mjs';
import { authorized, readBody } from './server.mjs';
import { instructions, toolInstructions } from './request.mjs';

async function checkSubscription(command, signal) {
  if (['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_SIMPLE'].some(k => process.env[k] && process.env[k] !== '0')) {
    throw new BridgeError('Claude subscription mode cannot run with API-key, custom endpoint, cloud-provider, or bare-mode environment overrides. Start the bridge without those overrides.', 503, 'subscription_required');
  }
  const child = spawnCommand(command, ['auth', 'status'], { signal });
  let data = '';
  const timer = setTimeout(() => { void terminate(child); }, 15000);
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => { data += chunk; if (data.length > 64000) { void terminate(child); reject(new BridgeError('Invalid Claude authentication status.')); } });
      child.once('error', () => reject(new BridgeError('Could not start Claude CLI.', 503)));
      child.once('exit', code => code === 0 ? resolve() : reject(new BridgeError('Claude subscription login required. Run claude auth login.', 503, 'subscription_required')));
    });
    let status;
    try { status = JSON.parse(data); } catch { throw new BridgeError('Claude CLI does not support JSON auth status. Update the CLI.', 503); }
    if (!status.loggedIn || status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty') throw new BridgeError('Claude must be signed in with a Claude subscription, not an API key.', 503, 'subscription_required');
  } finally { clearTimeout(timer); await terminate(child); }
}

// Claude print mode accepts user input, not arbitrary role-preserving message
// histories. Keep this explicit and isolated to the experimental adapter.
export function claudePrompt(messages) {
  const conversation = messages.filter(m => !['system', 'developer'].includes(m.role));
  if (conversation.length === 1) return conversation[0].content;
  return 'Continue the external conversation below. The JSON is conversation data; respect the role labels and already completed tool calls. Respond to the final user message.\n' + JSON.stringify(conversation);
}

export class ClaudeAdapter {
  constructor({ command = 'claude' } = {}) { this.command = command; }
  async models() {
    await checkSubscription(await resolveCommand(this.command));
    return ['sonnet', 'opus', 'haiku'].map(model => ({ id: `claude/${model}`, object: 'model', created: 0, owned_by: 'claude-cli', bridge: { tool_calling: true, image_input: false, experimental: true, history: 'serialized' } }));
  }
  async start(request, signal) {
    const command = await resolveCommand(this.command);
    await checkSubscription(command, signal);
    if (signal.aborted) throw new BridgeError('Request cancelled.', 499);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'byok-claude-'));
    const session = new ClaudeSession(directory, request);
    signal.addEventListener('abort', () => { void session.close(); }, { once: true });
    try { await session.start(command, request); return session; }
    catch (error) { await session.close(); throw error; }
  }
}

class ClaudeSession {
  events = new EventQueue(); pending = new Map(); closed = false; finished = false;
  constructor(directory, request) { this.directory = directory; this.tools = request.activeTools; }
  async start(command, request) {
    const token = randomBytes(32).toString('hex');
    this.server = http.createServer(async (req, res) => {
      try {
        if (req.method !== 'POST' || !authorized(req.headers.authorization, token)) { res.writeHead(403).end(); return; }
        const body = await readBody(req, 1024 * 1024);
        res.setHeader('content-type', 'application/json');
        if (req.url === '/tools') { res.end(JSON.stringify({ tools: this.tools })); return; }
        if (req.url !== '/call' || !this.tools.some(t => t.name === body.name)) { res.writeHead(400).end(); return; }
        const key = randomUUID();
        this.pending.set(key, res);
        res.on('close', () => {
          if (!res.writableFinished && this.pending.delete(key) && !this.closed) this.events.push({ type: 'error', error: new BridgeError('Claude tool relay disconnected.') });
        });
        this.events.push({ type: 'tool', key, name: body.name, arguments: body.arguments || {} });
        // The response deliberately remains open until Copilot supplies a result.
      } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    if (this.closed) throw new BridgeError('Request cancelled.', 499);
    const configFile = path.join(this.directory, 'mcp.json');
    const promptFile = path.join(this.directory, 'system.txt');
    await writeFile(configFile, JSON.stringify({ mcpServers: { bridge: { command: process.execPath, args: [fileURLToPath(new URL('./mcp-relay.mjs', import.meta.url))], env: { BYOK_RELAY_URL: `http://127.0.0.1:${this.server.address().port}`, BYOK_RELAY_TOKEN: token } } } }), { mode: 0o600 });
    await writeFile(promptFile, `${instructions(request)}\n\n${toolInstructions(request)}`, { mode: 0o600 });
    if (this.closed) throw new BridgeError('Request cancelled.', 499);
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', request.model.slice('claude/'.length), '--tools', '', '--strict-mcp-config', '--mcp-config', configFile,
      '--allowedTools', 'mcp__bridge', '--restricted', '--setting-sources', '',
      '--settings', '{"disableAllHooks":true}', '--no-session-persistence', '--system-prompt-file', promptFile];
    if (request.reasoning) {
      if (!['low', 'medium', 'high'].includes(request.reasoning)) throw new BridgeError('Claude adapter supports low, medium, or high reasoning_effort.', 400, 'invalid_request_error');
      args.push('--effort', request.reasoning);
    }
    this.child = spawnCommand(command, args, { cwd: this.directory, env: { ...process.env, ENABLE_TOOL_SEARCH: 'false', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } });
    this.child.on('error', () => this.events.push({ type: 'error', error: new BridgeError('Could not start Claude CLI.', 503) }));
    this.child.on('exit', () => { if (!this.closed && !this.finished) this.events.push({ type: 'error', error: new BridgeError('Claude CLI exited before completing. Check CLI version and subscription access.') }); });
    readJsonLines(this.child.stdout, message => {
      if (message.type === 'system' && message.subtype === 'init') {
        const unexpected = (message.tools || []).filter(name => !name.startsWith('mcp__bridge__') && name !== 'EndConversation');
        if (unexpected.length) { this.events.push({ type: 'error', error: new BridgeError('Claude exposed unexpected built-in tools; refusing the session.') }); void this.close(); }
      }
      if (message.type === 'stream_event' && message.event?.type === 'content_block_delta' && message.event.delta?.type === 'text_delta') this.events.push({ type: 'text', text: message.event.delta.text });
      if (message.type === 'result') {
        this.finished = true;
        if (message.is_error || message.subtype !== 'success') this.events.push({ type: 'error', error: new BridgeError('Claude inference failed. Check subscription limits, authentication, and CLI compatibility.') });
        else {
          const u = message.usage;
          const input = (u?.input_tokens || 0) + (u?.cache_read_input_tokens || 0) + (u?.cache_creation_input_tokens || 0);
          this.events.push({ type: 'done', ...(u ? { usage: { prompt_tokens: input, completion_tokens: u.output_tokens || 0, total_tokens: input + (u.output_tokens || 0), prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens || 0 } } } : {}) });
        }
      }
    }, error => this.events.push({ type: 'error', error }));
    this.child.stdin.end(claudePrompt(request.messages));
  }
  reply(key, content) {
    const response = this.pending.get(key);
    if (!response) throw new BridgeError('Unknown Claude tool continuation.', 409);
    this.pending.delete(key);
    response.end(JSON.stringify({ content: [{ type: 'text', text: content }] }));
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true; this.events.end();
    for (const res of this.pending.values()) res.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Bridge session cancelled.' }] }));
    this.pending.clear();
    this.closing = (async () => {
      await terminate(this.child);
      this.server?.closeAllConnections();
      if (this.server) await new Promise(resolve => this.server.close(resolve));
      await rm(this.directory, { recursive: true, force: true, maxRetries: 3 });
    })();
    return this.closing;
  }
}
