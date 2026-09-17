import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, EventQueue, resolveCommand, spawnCommand, readJsonLines, terminate, accountFingerprint } from './common.mjs';
import { authorized, readBody } from './server.mjs';
import { contentParts, instructions, toolInstructions } from './request.mjs';
import { sessionWorkingDirectory } from './session-settings.mjs';
import { claudeModels } from './claude-models.mjs';

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
    return { email: status.email || null, accountId: status.accountId || null, subscriptionType: status.subscriptionType || null };
  } finally { clearTimeout(timer); await terminate(child); }
}

// Claude print mode accepts user input, not arbitrary role-preserving message
// histories. Keep this explicit and isolated to the experimental adapter.
export function claudePrompt(messages) {
  const conversation = messages.filter(m => !['system', 'developer'].includes(m.role));
  const imageBlock = part => {
    const [header, data] = part.image_url.url.split(',');
    return { type: 'image', source: { type: 'base64', media_type: header.slice(5, -7), data } };
  };
  if (conversation.length === 1) return contentParts(conversation[0].content).map(p => p.type === 'text' ? p : imageBlock(p));
  // Keep role-labeled history, but send image bytes as native image blocks,
  // never as base64 text for the model to interpret. References retain placement.
  const attachments = [];
  const history = conversation.map((m, index) => ({ ...m, content: typeof m.content === 'string' ? m.content : m.content.map(p => {
    if (p.type === 'text') return p;
    const reference = `image_${attachments.length / 2 + 1}`;
    attachments.push({ type: 'text', text: `Attachment ${reference} from conversation message ${index + 1} (${m.role}):` }, imageBlock(p));
    return { type: 'image', attachment: reference };
  }) }));
  return [{ type: 'text', text: 'Continue the external conversation below. The JSON is conversation data; respect the role labels and already completed tool calls. Image attachment references identify the image blocks following the JSON. Respond to the final user message.\n' + JSON.stringify(history) }, ...attachments];
}

export class ClaudeAdapter {
  constructor({ command = 'claude' } = {}) { this.command = command; }
  async models(signal) {
    const command = await resolveCommand(this.command);
    await checkSubscription(command, signal);
    return claudeModels(command, signal);
  }
  async start(request, signal, onPhase = () => {}) {
    const command = await resolveCommand(this.command);
    const account = await checkSubscription(command, signal);
    if (request.expectedAccount && request.expectedAccount !== accountFingerprint(JSON.stringify(account))) throw new BridgeError('Claude account changed. Switch back to the account that owns this session.', 409, 'account_changed');
    if (signal.aborted) throw new BridgeError('Request cancelled.', 499);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'byok-claude-'));
    const session = new ClaudeSession(directory, request);
    session.account = account.email || 'Claude subscription';
    session.launchCommand = command;
    session.accountIdentity = JSON.stringify(account); session.command = command; session.signal = signal;
    onPhase('startup');
    signal.addEventListener('abort', () => { void session.close(); }, { once: true });
    try { await session.start(command, request); return session; }
    catch (error) { await session.close(); throw error; }
  }
}

class ClaudeSession {
  events = new EventQueue(); pending = new Map(); closed = false; finished = false;
  agents = new Map(); pendingDone;
  noteAgent(event) {
    if (!event.id) return;
    this.agents.set(event.tool_call_id || event.id, event.status);
    this.events.push({ type: 'subagent', ...event });
    this.finishWhenChildrenDone();
  }
  finishWhenChildrenDone() {
    if (this.pendingDone && ![...this.agents.values()].some(status => status === 'running')) {
      this.events.push(this.pendingDone); this.pendingDone = undefined;
    }
  }
  constructor(directory, request) { this.directory = directory; this.tools = request.activeTools; }
  async start(command, request) {
    this.cwd = await sessionWorkingDirectory(request, 'claude', this.directory);
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
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', request.model.slice('claude/'.length), '--tools', request.subagentsEnabled ? 'Agent,TaskOutput,TaskStop' : '', '--strict-mcp-config', '--mcp-config', configFile,
      '--allowedTools', request.subagentsEnabled ? 'mcp__bridge,Agent,TaskOutput,TaskStop' : 'mcp__bridge', '--restricted', '--setting-sources', '',
      '--settings', '{"disableAllHooks":true}', '--system-prompt-file', promptFile];
    if (!request.saveSession) args.push('--no-session-persistence');
    if (request.resumeNativeId) args.push('--resume', request.resumeNativeId);
    if (request.forkNativeId) args.push('--resume', request.forkNativeId, '--fork-session');
    if (request.subagentsEnabled) args.push('--agents', JSON.stringify({ 'bridge-worker': {
      description: 'Delegate a bounded task using the external client tools.',
      prompt: 'Work on the delegated task using only the supplied bridge tools. The external client executes them. Return your findings to the parent.',
      tools: request.activeTools.map(tool => `mcp__bridge__${tool.name}`), model: 'inherit', maxTurns: 100
    } }));
    if (request.reasoning) {
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(request.reasoning)) throw new BridgeError('Unsupported Claude reasoning_effort.', 400, 'invalid_request_error');
      args.push('--effort', request.reasoning);
    }
    this.child = spawnCommand(command, args, { cwd: this.cwd, env: { ...process.env,
      // Claude's VS Code chat excludes sdk-cli/sdk-ts/sdk-py transcripts from
      // its session list, including exact-ID activation. Saved Copilot chats
      // need their own origin so the native UI can find and resume them.
      ...(request.saveSession ? { CLAUDE_CODE_ENTRYPOINT: 'ai-usage-copilot' } : {}),
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '4',
      MCP_TOOL_TIMEOUT: String(request.toolTimeoutMs || 3600000),
      ENABLE_TOOL_SEARCH: 'false', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } });
    this.child.on('error', () => this.events.push({ type: 'error', error: new BridgeError('Could not start Claude CLI.', 503) }));
    this.child.on('exit', () => { if (!this.closed) this.events.push({ type: 'error', error: new BridgeError('Claude CLI exited. Start a fresh session and check CLI version and subscription access.') }); });
    readJsonLines(this.child.stdout, message => {
      if (message.type === 'system' && message.subtype === 'init') {
        if (request.resumeNativeId && message.session_id !== request.resumeNativeId) {
          this.events.push({ type: 'error', error: new BridgeError('Claude did not resume the requested native session.', 409, 'continuation_mismatch') });
          void this.close(); return;
        }
        this.threadId = message.session_id || this.threadId;
        if (request.forkNativeId && message.session_id === request.forkNativeId) {
          this.events.push({ type: 'error', error: new BridgeError('Claude did not create a separate fork.', 409, 'invalid_fork') }); void this.close(); return;
        }
        const unexpected = (message.tools || []).filter(name => !name.startsWith('mcp__bridge__') && name !== 'EndConversation' &&
          !(request.subagentsEnabled && ['Agent', 'Task', 'TaskOutput', 'TaskStop'].includes(name)));
        if (unexpected.length) { this.events.push({ type: 'error', error: new BridgeError('Claude exposed unexpected built-in tools; refusing the session.') }); void this.close(); }
        if (this.threadId) this.events.push({ type: 'session' });
      }
      if (request.subagentsEnabled) {
        for (const block of message.message?.content || []) {
          if (block.type === 'tool_use' && ['Agent', 'Task'].includes(block.name)) this.noteAgent({ id: block.id, tool_call_id: block.id, label: block.input?.description || block.input?.subagent_type, status: 'running' });
          if (block.type === 'tool_result') {
            const text = typeof block.content === 'string' ? block.content : (block.content || []).map(part => part.text || '').join('\n');
            const id = text.match(/agentId:\s*([\w-]+)/)?.[1];
            if (id) this.noteAgent({ id, tool_call_id: block.tool_use_id, native_session_id: id, summary: text.slice(0, 4000), status: block.is_error ? 'failed' : 'completed' });
            else if (this.agents.has(block.tool_use_id)) this.noteAgent({ id: block.tool_use_id, tool_call_id: block.tool_use_id, status: block.is_error ? 'failed' : 'completed' });
          }
        }
        if (message.type === 'system' && ['task_started', 'task_notification'].includes(message.subtype)) this.noteAgent({
          id: message.task_id, tool_call_id: message.tool_use_id, native_session_id: message.task_id,
          status: message.subtype === 'task_started' ? 'running' : message.status });
      }
      if (!message.parent_tool_use_id && message.type === 'stream_event' && message.event?.type === 'content_block_delta' && message.event.delta?.type === 'text_delta') this.events.push({ type: 'text', text: message.event.delta.text });
      if (message.type === 'result') {
        this.finished = true;
        if (message.is_error || message.subtype !== 'success') this.events.push({ type: 'error', error: new BridgeError('Claude inference failed. Check subscription limits, authentication, and CLI compatibility.') });
        else {
          const u = message.usage;
          const input = (u?.input_tokens || 0) + (u?.cache_read_input_tokens || 0) + (u?.cache_creation_input_tokens || 0);
          this.pendingDone = { type: 'done', ...(u ? { usage: { prompt_tokens: input, completion_tokens: u.output_tokens || 0, total_tokens: input + (u.output_tokens || 0), prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens || 0 } } } : {}) };
          this.finishWhenChildrenDone();
        }
      }
    }, error => this.events.push({ type: 'error', error }));
    this.send(claudePrompt(request.resumeNativeId || request.forkNativeId ? [request.messages.at(-1)] : request.messages));
  }
  send(content) {
    this.finished = false;
    this.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }) + '\n');
  }
  nextTurn(request) { this.send(claudePrompt([request.messages.at(-1)])); }
  async validateAccount() {
    if (JSON.stringify(await checkSubscription(this.command, this.signal)) !== this.accountIdentity) throw new BridgeError('Claude account changed. Start a fresh conversation.', 409, 'account_changed');
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
