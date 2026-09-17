import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, EventQueue, resolveCommand, accountFingerprint } from './common.mjs';
import { RpcProcess } from './rpc.mjs';
import { contentParts, instructions, toolInstructions } from './request.mjs';
import { sessionWorkingDirectory } from './session-settings.mjs';

const disabledFeatures = ['shell_tool', 'unified_exec', 'code_mode', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'hooks', 'browser_use', 'computer_use', 'image_generation', 'goals', 'memories', 'view_image', 'skill_search'];

export function codexArguments(subagentsEnabled = false) {
  return ['app-server', ...disabledFeatures.flatMap(f => ['-c', `features.${f}=${subagentsEnabled && ['multi_agent', 'multi_agent_v2'].includes(f) ? 'true' : 'false'}`]),
    '-c', 'agents.max_threads=4', '-c', 'agents.max_depth=1',
    '-c', 'features.skip_host_skill_discovery=true', '-c', 'features.code_mode_host=true', '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0', '-c', 'model_provider="openai"'];
}

async function connect(command, cwd, signal, subagentsEnabled = false) {
  if (['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_CHATGPT_BASE_URL'].some(k => process.env[k])) throw new BridgeError('Codex subscription mode cannot run with API-key or custom endpoint environment overrides. Start the bridge without those overrides.', 503, 'subscription_required');
  const executable = await resolveCommand(command);
  const rpc = new RpcProcess(executable, codexArguments(subagentsEnabled), { cwd, signal });
  // Install an early listener before the session installs its event consumer.
  rpc.on('failure', () => {});
  try {
    await rpc.call('initialize', { clientInfo: { name: 'cli-byok-bridge', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized' });
    const { account } = await rpc.call('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw new BridgeError('Codex subscription login required. Run codex login using ChatGPT; API-key accounts are not supported.', 503, 'subscription_required');
    const { config } = await rpc.call('config/read', { includeLayers: false });
    // A custom provider named openai could redirect authentication elsewhere.
    if (config.model_providers?.openai?.base_url || config.model_providers?.openai?.env_key) throw new BridgeError('Custom OpenAI provider overrides are not supported in subscription mode.', 503);
    return { rpc, config, account, executable };
  } catch (error) { await rpc.close(); throw error; }
}

export function historyItems(messages) {
  const items = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') continue;
    if (m.role === 'tool') items.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
    else {
      if (m.content) items.push({ type: 'message', role: m.role, content: contentParts(m.content).map(p => p.type === 'text'
        ? { type: m.role === 'assistant' ? 'output_text' : 'input_text', text: p.text }
        : { type: 'input_image', image_url: p.image_url.url, detail: p.image_url.detail }) });
      for (const call of m.tool_calls || []) items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  return items;
}

export class CodexAdapter {
  constructor({ command = 'codex' } = {}) { this.command = command; }
  async models(signal) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'byok-models-'));
    let rpc;
    try {
      ({ rpc } = await connect(this.command, directory, signal));
      const models = []; let cursor;
      do {
        const result = await rpc.call('model/list', { includeHidden: true, ...(cursor ? { cursor } : {}) });
        models.push(...(result.data || [])); cursor = result.nextCursor;
      } while (cursor);
      return models.map(m => ({ id: `codex/${m.model}`, object: 'model', created: 0, owned_by: 'codex-cli', bridge: { display_name: m.displayName || m.model, description: m.description, hidden: m.hidden === true, discovery: 'native_model_list', tool_calling: true, image_input: (m.inputModalities ?? ['text', 'image']).includes('image'), reasoning_efforts: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort), experimental: true } }));
    } finally { await rpc?.close(); await rm(directory, { recursive: true, force: true }); }
  }
  async start(request, signal, onPhase = () => {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'byok-codex-'));
    let rpc;
    try {
      const cwd = await sessionWorkingDirectory(request, 'codex', directory);
      const connection = await connect(this.command, directory, signal, request.subagentsEnabled);
      rpc = connection.rpc;
      if (request.expectedAccount && request.expectedAccount !== accountFingerprint(JSON.stringify(connection.account))) throw new BridgeError('Codex account changed. Switch back to the account that owns this session.', 409, 'account_changed');
      if (signal.aborted) throw new BridgeError('Request cancelled.', 499);
      const { config } = await rpc.call('config/read', { includeLayers: false });
      const overrides = Object.fromEntries(Object.keys(config.mcp_servers || {}).map(name => [`mcp_servers.${JSON.stringify(name)}.enabled`, false]));
      const session = new CodexSession(rpc, directory, request);
      session.cwd = cwd;
      session.launchCommand = connection.executable;
      session.account = connection.account.email || 'ChatGPT subscription';
      session.accountIdentity = JSON.stringify(connection.account);
      onPhase('startup');
      signal.addEventListener('abort', () => { void session.close(); }, { once: true });
      const { thread } = await rpc.call(request.forkNativeId ? 'thread/fork' : request.resumeNativeId ? 'thread/resume' : 'thread/start', {
        model: request.model.slice('codex/'.length), modelProvider: 'openai',
        cwd, sandbox: 'read-only', approvalPolicy: 'never',
        baseInstructions: `${instructions(request)}\n\n${toolInstructions(request)}`,
        developerInstructions: '', config: overrides,
        ...(request.forkNativeId ? { threadId: request.forkNativeId, ephemeral: false } : request.resumeNativeId ? { threadId: request.resumeNativeId } : {
          environments: [], ephemeral: !request.saveSession,
          dynamicTools: request.activeTools.map(t => ({ type: 'function', ...t }))
        })
      });
      if (request.resumeNativeId && thread.id !== request.resumeNativeId) throw new BridgeError('Codex did not resume the requested native session.', 409, 'continuation_mismatch');
      if (request.forkNativeId && thread.id === request.forkNativeId) throw new BridgeError('Codex did not create a separate fork.', 409, 'invalid_fork');
      session.threadId = thread.id;
      const history = historyItems(request.messages.slice(0, -1));
      if (!request.resumeNativeId && !request.forkNativeId && history.length) await rpc.call('thread/inject_items', { threadId: thread.id, items: history });
      await session.nextTurn(request);
      return session;
    } catch (error) { await rpc?.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  }
}

class CodexSession {
  events = new EventQueue(); closed = false; pending = new Map(); usage = undefined;
  children = new Map(); pendingDone;
  constructor(rpc, directory, request) {
    this.rpc = rpc; this.directory = directory;
    const allowed = new Set(request.activeTools.map(t => t.name));
    rpc.on('failure', error => this.events.push({ type: 'error', error }));
    rpc.on('request', message => {
      if (message.method !== 'item/tool/call' || !allowed.has(message.params.tool)) {
        this.events.push({ type: 'error', error: new BridgeError('Codex requested an unexpected tool or approval. The bridge refused to execute it.') });
        void this.close(); return;
      }
      const { callId, tool, arguments: args } = message.params;
      this.pending.set(callId, message.id);
      this.events.push({ type: 'tool', key: callId, name: tool, arguments: args });
    });
    rpc.on('notification', ({ method, params: p }) => {
      if (method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageGeneration', ...(request.subagentsEnabled ? [] : ['collabAgentToolCall', 'subAgentActivity'])].includes(p.item?.type)) {
        this.events.push({ type: 'error', error: new BridgeError('Codex attempted an internal tool despite tool isolation. Update the adapter before continuing.') });
        void this.close(); return;
      }
      if (request.subagentsEnabled) {
        const spawned = p.thread?.source?.subAgent?.thread_spawn;
        if (method === 'thread/started' && spawned) this.childState(p.thread.id, 'running', spawned.parent_thread_id, { label: p.thread.agentNickname || spawned.agent_nickname || p.thread.agentRole || spawned.agent_role });
        if (p.item?.type === 'subAgentActivity') {
          const status = { started: 'running', interacted: 'running', interrupted: 'interrupted', completed: 'completed' }[p.item.kind];
          if (status) this.childState(p.item.agentThreadId, status, p.threadId, { label: p.item.agentPath });
        }
        if (p.item?.type === 'collabAgentToolCall') {
          for (const id of p.item.receiverThreadIds || []) this.childState(id, p.item.agentsStates?.[id]?.status || 'running', p.item.senderThreadId, { summary: p.item.agentsStates?.[id]?.message });
        }
        if (p.threadId && this.threadId && p.threadId !== this.threadId) {
          if (method === 'item/completed' && p.item?.type === 'agentMessage') this.childState(p.threadId, this.children.get(p.threadId) || 'running', undefined, { summary: p.item.text });
          if (method === 'turn/completed') this.childState(p.threadId, p.turn?.status === 'completed' ? 'completed' : 'failed');
          return; // Child text, usage and completion must not finish the parent.
        }
      }
      if (method === 'item/agentMessage/delta') this.events.push({ type: 'text', text: p.delta });
      if (method === 'thread/tokenUsage/updated') {
        const u = p.tokenUsage?.last;
        if (u) this.usage = { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.totalTokens,
          prompt_tokens_details: { cached_tokens: u.cachedInputTokens || 0 }, completion_tokens_details: { reasoning_tokens: u.reasoningOutputTokens || 0 } };
        if (u) this.events.push({ type: 'usage', usage: this.usage });
      }
      if (method === 'turn/completed') {
        if (p.turn.status === 'completed') { this.pendingDone = { type: 'done', usage: this.usage }; this.finishWhenChildrenDone(); }
        else this.events.push({ type: 'error', error: new BridgeError(`Codex turn ${p.turn.status || 'failed'}. Check subscription limits and model availability.`) });
      }
      if (method === 'error' && !p.willRetry) this.events.push({ type: 'error', error: new BridgeError('Codex inference failed. Check subscription limits and model access.') });
    });
  }
  childState(id, status, parent, details = {}) {
    if (!id || id === this.threadId) return;
    this.children.set(id, status);
    this.events.push({ type: 'subagent', id, native_session_id: id, parent_native_session_id: parent || this.threadId, status, ...details });
    this.finishWhenChildrenDone();
  }
  finishWhenChildrenDone() {
    if (this.pendingDone && ![...this.children.values()].some(status => ['running', 'pendingInit'].includes(status))) {
      this.events.push(this.pendingDone); this.pendingDone = undefined;
    }
  }
  async validateAccount() {
    const { account } = await this.rpc.call('account/read', { refreshToken: false });
    if (JSON.stringify(account) !== this.accountIdentity) throw new BridgeError('Codex account changed. Start a fresh conversation.', 409, 'account_changed');
  }
  async nextTurn(request) {
    this.usage = undefined;
    const input = contentParts(request.messages.at(-1).content).map(p => p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image', url: p.image_url.url, detail: p.image_url.detail });
    await this.rpc.call('turn/start', { threadId: this.threadId, environments: [], input, ...(request.reasoning ? { effort: request.reasoning } : {}) });
  }
  reply(key, content) {
    const id = this.pending.get(key);
    if (id == null) throw new BridgeError('Unknown backend tool call.', 409);
    this.pending.delete(key);
    this.rpc.respond(id, { contentItems: [{ type: 'inputText', text: content }], success: true });
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true; this.events.end();
    this.closing = (async () => {
      await this.rpc.close(); await rm(this.directory, { recursive: true, force: true, maxRetries: 3 });
    })();
    return this.closing;
  }
}
