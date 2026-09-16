import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, EventQueue, resolveCommand } from './common.mjs';
import { RpcProcess } from './rpc.mjs';
import { instructions, toolInstructions } from './request.mjs';

const disabledFeatures = ['shell_tool', 'unified_exec', 'code_mode', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'hooks', 'browser_use', 'computer_use', 'image_generation', 'goals', 'memories', 'view_image', 'skill_search'];

export function codexArguments() {
  return ['app-server', ...disabledFeatures.flatMap(f => ['-c', `features.${f}=false`]),
    '-c', 'features.skip_host_skill_discovery=true', '-c', 'features.code_mode_host=true', '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0', '-c', 'model_provider="openai"'];
}

async function connect(command, cwd, signal) {
  if (['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_CHATGPT_BASE_URL'].some(k => process.env[k])) throw new BridgeError('Codex subscription mode cannot run with API-key or custom endpoint environment overrides. Start the bridge without those overrides.', 503, 'subscription_required');
  const rpc = new RpcProcess(await resolveCommand(command), codexArguments(), { cwd, signal });
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
    return { rpc, config };
  } catch (error) { await rpc.close(); throw error; }
}

export function historyItems(messages) {
  const items = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') continue;
    if (m.role === 'tool') items.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
    else {
      if (m.content) items.push({ type: 'message', role: m.role, content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }] });
      for (const call of m.tool_calls || []) items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  return items;
}

export class CodexAdapter {
  constructor({ command = 'codex' } = {}) { this.command = command; }
  async models() {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'byok-models-'));
    let rpc;
    try {
      ({ rpc } = await connect(this.command, directory));
      const result = await rpc.call('model/list', {});
      return (result.data || []).map(m => ({ id: `codex/${m.model}`, object: 'model', created: 0, owned_by: 'codex-cli', bridge: { tool_calling: true, image_input: false, experimental: true } }));
    } finally { await rpc?.close(); await rm(directory, { recursive: true, force: true }); }
  }
  async start(request, signal) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'byok-codex-'));
    let rpc;
    try {
      ({ rpc } = await connect(this.command, directory, signal));
      if (signal.aborted) throw new BridgeError('Request cancelled.', 499);
      const { config } = await rpc.call('config/read', { includeLayers: false });
      const overrides = Object.fromEntries(Object.keys(config.mcp_servers || {}).map(name => [`mcp_servers.${JSON.stringify(name)}.enabled`, false]));
      const session = new CodexSession(rpc, directory, request);
      signal.addEventListener('abort', () => { void session.close(); }, { once: true });
      const { thread } = await rpc.call('thread/start', {
        model: request.model.slice('codex/'.length), modelProvider: 'openai',
        cwd: directory, environments: [], ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
        baseInstructions: `${instructions(request)}\n\n${toolInstructions(request)}`,
        developerInstructions: '', config: overrides,
        dynamicTools: request.activeTools.map(t => ({ type: 'function', ...t }))
      });
      session.threadId = thread.id;
      const history = historyItems(request.messages.slice(0, -1));
      if (history.length) await rpc.call('thread/inject_items', { threadId: thread.id, items: history });
      await rpc.call('turn/start', { threadId: thread.id, environments: [], input: [{ type: 'text', text: request.messages.at(-1).content }], ...(request.reasoning ? { effort: request.reasoning } : {}) });
      return session;
    } catch (error) { await rpc?.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  }
}

class CodexSession {
  events = new EventQueue(); closed = false; pending = new Map(); usage = undefined;
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
      if (method === 'item/agentMessage/delta') this.events.push({ type: 'text', text: p.delta });
      if (method === 'thread/tokenUsage/updated') {
        const u = p.tokenUsage?.last;
        if (u) this.usage = { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.totalTokens,
          prompt_tokens_details: { cached_tokens: u.cachedInputTokens || 0 }, completion_tokens_details: { reasoning_tokens: u.reasoningOutputTokens || 0 } };
      }
      if (method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageGeneration', 'collabAgentToolCall'].includes(p.item?.type)) {
        this.events.push({ type: 'error', error: new BridgeError('Codex attempted an internal tool despite tool isolation. Update the adapter before continuing.') });
        void this.close();
      }
      if (method === 'turn/completed') {
        if (p.turn.status === 'completed') this.events.push({ type: 'done', usage: this.usage });
        else this.events.push({ type: 'error', error: new BridgeError(`Codex turn ${p.turn.status || 'failed'}. Check subscription limits and model availability.`) });
      }
      if (method === 'error' && !p.willRetry) this.events.push({ type: 'error', error: new BridgeError('Codex inference failed. Check subscription limits and model access.') });
    });
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
