import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { bridgeGet, Session } from './bridgeIntegration';
import { BridgeRuntime } from './bridgeRuntime';
import { streamBridge } from './bridgeTransport';
import { agentKey, subagentNotice } from './bridgeAgents';
import { sessionHeader, stripSessionFooter } from './bridgeSessionLinks';
import { Backend, Catalogs, MODEL_CACHE_KEY, ModelCacheStorage, modelCacheSource, readModelCache } from './bridgeModelCache';

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type BridgeMessage = { role: string; content: string | ContentPart[]; tool_calls?: ToolCall[]; tool_call_id?: string };
type Catalog = { id: string; bridge?: { cli_version?: string; tool_calling?: boolean; image_input?: boolean; display_name?: string; resolved_model?: string; description?: string; hidden?: boolean } };
type Discovery = { backends: { backend: string; status: string; models?: Catalog[]; code?: string; message?: string }[] };

function textPart(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) return part.value;
  if (part instanceof vscode.LanguageModelDataPart && (part.mimeType.startsWith('text/') || part.mimeType === 'application/json')) return Buffer.from(part.data).toString('utf8');
  throw new Error('This CLI bridge supports text tool results. This tool returned an unsupported content type.');
}

export function bridgeMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): BridgeMessage[] {
  const result: BridgeMessage[] = [];
  for (const message of messages) {
    const role = Number(message.role) === 0 ? 'system' : message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
    const content: ContentPart[] = []; const calls: ToolCall[] = []; const results: BridgeMessage[] = [];
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        if (role !== 'assistant') throw new Error('Tool calls must be assistant messages.');
        calls.push({ id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        if (role !== 'user') throw new Error('Tool results must be user messages.');
        results.push({ role: 'tool', tool_call_id: part.callId, content: part.content.map(textPart).join('\n') });
      } else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
        content.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}` } });
      } else content.push({ type: 'text', text: textPart(part) });
    }
    if (results.length) {
      if (content.length || calls.length) throw new Error('Mixed tool results and new user content cannot resume a bridge tool call.');
      result.push(...results);
    } else {
      const text = content.every(p => p.type === 'text') ? content.map(p => (p as { text: string }).text).join('') : undefined;
      result.push({ role, content: text === undefined ? content : role === 'assistant' ? stripSessionFooter(text) : text,
        ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  return result;
}

export class BridgeModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;
  private models: vscode.LanguageModelChatInformation[] = [];
  private catalogs: Catalogs = {};
  private cached = new Set<Backend>();
  private source = '';
  private refreshing?: Promise<void>;
  private disposed = false;
  private readonly presentedAgents = new Set<string>();
  private readonly presentedSessions = new Set<string>();
  constructor(private readonly runtime: Pick<BridgeRuntime, 'ensure'>, private readonly log: Pick<vscode.OutputChannel, 'appendLine'>,
    private readonly storage?: ModelCacheStorage) { this.useSource(); }

  private enabled(): boolean { return vscode.workspace.getConfiguration('aiUsage.bridge').get('modelsEnabled', true); }

  private useSource(): string {
    const source = modelCacheSource();
    if (source !== this.source) {
      this.source = source;
      this.catalogs = readModelCache(this.storage, source);
      this.cached = new Set(Object.keys(this.catalogs) as Backend[]);
    }
    this.publish();
    return source;
  }

  private publish(): void {
    if (this.disposed) return;
    const models = this.enabled() ? (['codex', 'claude'] as const).flatMap(backend => {
      const catalog = this.catalogs[backend];
      return (catalog?.models || []).map(model => this.cached.has(backend) ? {
        ...model, detail: `${model.detail || 'CLI'} · cached`,
        tooltip: `${model.tooltip || ''} Cached catalog from ${new Date(catalog!.savedAt).toISOString()}; awaiting live discovery. Requests still check CLI login and model availability.`
      } : model);
    }) : [];
    if (JSON.stringify(models) !== JSON.stringify(this.models)) { this.models = models; this.changed.fire(); }
  }

  private async save(source: string): Promise<void> {
    if (this.disposed || source !== this.source) return;
    try { await this.storage?.update(MODEL_CACHE_KEY, { version: 1, source, catalogs: this.catalogs }); }
    catch { this.log.appendLine('Could not save the bridge model catalog. Models remain available for this window.'); }
  }

  refresh(): Promise<void> {
    const source = this.useSource();
    if (!this.refreshing) this.refreshing = this.discover(source).finally(() => {
      this.refreshing = undefined;
      if (!this.disposed && modelCacheSource() !== source) void this.refresh().catch(() => {});
    });
    return this.refreshing;
  }

  private async discover(source: string): Promise<void> {
    if (this.disposed) return;
    try {
      if (this.enabled()) {
        await this.runtime.ensure();
        // /v1/models intentionally returns the first available backend. It can
        // omit a cached catalog while its identity is being checked, so it is
        // not a complete replacement snapshot for VS Code's model picker.
        const catalog = await bridgeGet<Discovery>('/v1/diagnostics');
        if (this.disposed || !this.enabled() || modelCacheSource() !== source) return;
        const ready = catalog.backends.filter(backend => backend.status === 'ready');
        for (const name of ['codex', 'claude'] as const) {
          const backend = catalog.backends.find(entry => entry.backend === name);
          if (!backend || (backend.status !== 'ready' && ['subscription_required', 'cli_not_found', 'cli_incompatible', 'model_not_found'].includes(backend.code || ''))) {
            delete this.catalogs[name]; this.cached.delete(name);
          } else if (backend.status !== 'ready') this.cached.add(name);
          else {
            const complete = [...new Map((backend.models || []).filter(model => model.id.startsWith(name + '/')).map(model => [model.id, model])).values()];
            this.catalogs[name] = { savedAt: Date.now(), models: complete.map(model => ({ id: model.id,
          name: `${model.id.startsWith('codex/') ? 'Codex' : 'Claude'} CLI · ${model.bridge?.display_name || model.id.split('/')[1]}`,
          family: model.id, version: model.bridge?.cli_version || '1',
          detail: model.bridge?.hidden ? 'CLI · hidden in native picker' : 'CLI subscription',
          tooltip: [model.bridge?.description, model.bridge?.resolved_model ? `Resolves to ${model.bridge.resolved_model}.` : '', 'Uses your native CLI login and billing rules. Context budgets and token counts are conservative estimates.'].filter(Boolean).join(' '),
          maxInputTokens: 32000, maxOutputTokens: 4096,
          capabilities: { toolCalling: model.bridge?.tool_calling === true, imageInput: model.bridge?.image_input === true }
            })) };
            this.cached.delete(name);
          }
          if (backend && backend.status !== 'ready') this.log.appendLine(`${name}: ${backend.message || backend.code || 'Model discovery failed.'}`);
        }
        this.publish(); await this.save(source);
        if (!ready.length) throw new Error('No CLI models could be verified. Cached suggestions may remain available. Run AI Usage: Check Copilot Integration for details.');
      }
    } catch (error) {
      this.log.appendLine(error instanceof Error ? error.message : 'Bridge model discovery failed.');
      if (!this.disposed && modelCacheSource() === source) {
        this.cached = new Set(Object.keys(this.catalogs) as Backend[]); this.publish();
      }
      throw error;
    }
  }

  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    this.useSource();
    if (!this.enabled()) return [];
    // The local snapshot is immediately usable for the picker, even while a
    // shared startup/discovery request is pending. Inference remains live.
    if (this.models.length) {
      void this.refresh().catch(() => {});
      return this.models;
    }
    try { await this.refresh(); } catch (error) { if (!options.silent) throw error; }
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    return this.models;
  }

  async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
    if (!vscode.workspace.getConfiguration('aiUsage.bridge').get('modelsEnabled', true)) throw new Error('AI Usage bridge models are disabled in settings.');
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const converted = bridgeMessages(messages);
    // Copilot forwards this stable ID through modelOptions, including after
    // compaction. Never correlate unrelated chats by their prompt text.
    const conversationId = options.modelOptions?._conversationId;
    const conversationKey = typeof conversationId === 'string' && conversationId.length > 0
      ? createHash('sha256').update(JSON.stringify([modelCacheSource(),
        vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()), model.id.split('/')[0], conversationId])).digest('hex') : undefined;
    // Existing chats and clients without Copilot's ID can use an explicit link
    // already present in assistant history. Do not infer IDs from user content.
    let resumeId: string | undefined;
    for (const message of messages) if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      const text = message.content.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => (part as vscode.LanguageModelTextPart).value).join('');
      if (text.startsWith('**CLI session**')) {
        resumeId = text.match(/(?:\/sessions\/|%2Fsessions%2F)([a-f0-9-]{36})(?:\/|%2F)/)?.[1] || resumeId;
      }
    }
    await this.runtime.ensure();
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let headerHandled = false;
    const showSession = async (id?: string, snapshot?: Session) => {
      if (headerHandled || !id) return;
      headerHandled = true;
      if (snapshot?.continued) return;
      const backend = model.id.split('/')[0];
      const config = vscode.workspace.getConfiguration('aiUsage.bridge');
      if (!config.get(`${backend}.openInCli`, false) && !config.get(`${backend}.openInExtension`, false)) return;
      if (this.presentedSessions.has(id)) return;
      // A tool continuation can outlive this provider instance. The existing
      // header's routed link identifies it without adding hidden markers.
      if (messages.some(message => message.role === vscode.LanguageModelChatMessageRole.Assistant &&
        message.content.some(part => part instanceof vscode.LanguageModelTextPart && part.value.startsWith('**CLI session**') &&
          (part.value.includes(`/sessions/${id}/`) || part.value.includes(`%2Fsessions%2F${id}%2F`))))) return;
      try {
        const session = snapshot || await bridgeGet<Session>(`/v1/sessions/${id}`, token);
        if (session.id !== id) return;
        const header = await sessionHeader(session, model.id, token);
        if (header && !token.isCancellationRequested) {
          progress.report(new vscode.LanguageModelTextPart(header));
          this.presentedSessions.add(id);
          if (this.presentedSessions.size > 200) this.presentedSessions.delete(this.presentedSessions.values().next().value!);
        }
      } catch (error) {
        this.log.appendLine(`Could not add CLI session links: ${error instanceof Error ? error.message : 'metadata unavailable'}`);
      }
    };
    await streamBridge({ model: model.id, messages: converted, stream: true,
      ...(conversationKey ? { bridge_conversation_id: conversationKey } : {}),
      ...(options.modelOptions?.bridge_fork_session_id ? { bridge_fork_session_id: options.modelOptions.bridge_fork_session_id } : resumeId ? { bridge_resume_session_id: resumeId } : {}),
      tools: (options.tools || []).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
      ...(options.modelOptions?.reasoning_effort ? { reasoning_effort: options.modelOptions.reasoning_effort } : {})
    }, async (frame, sessionId) => {
      if (frame.bridge_session && frame.bridge_session.id === sessionId) await showSession(sessionId, frame.bridge_session);
      if (frame.bridge_subagent && frame.bridge_subagent.session_id === sessionId && sessionId) {
        const agent = frame.bridge_subagent.agent;
        const key = `${sessionId}/${agentKey(agent)}`;
        const known = messages.some(message => message.role === vscode.LanguageModelChatMessageRole.Assistant &&
          message.content.some(part => part instanceof vscode.LanguageModelTextPart &&
            (part.value.includes(`/sessions/${sessionId}/agent/${agentKey(agent)}`) ||
             part.value.includes(`%2Fsessions%2F${sessionId}%2Fagent%2F${agentKey(agent)}`))));
        if (!known && !this.presentedAgents.has(key)) {
          const notice = await subagentNotice(sessionId, agent);
          if (notice && !token.isCancellationRequested) {
            progress.report(new vscode.LanguageModelTextPart(notice)); this.presentedAgents.add(key);
            if (this.presentedAgents.size > 2000) this.presentedAgents.delete(this.presentedAgents.values().next().value!);
          }
        }
      }
      for (const choice of frame.choices || []) {
        // Compatibility with an already-running bridge from an older build:
        // fetch its metadata before forwarding the first answer token/tool call.
        if (choice.delta?.content || choice.delta?.tool_calls?.length) await showSession(sessionId);
        if (choice.delta?.content) progress.report(new vscode.LanguageModelTextPart(choice.delta.content));
        for (const part of choice.delta?.tool_calls || []) {
          const call = calls.get(part.index) || { id: '', name: '', arguments: '' };
          call.id += part.id || ''; call.name += part.function?.name || ''; call.arguments += part.function?.arguments || '';
          calls.set(part.index, call);
        }
      }
    }, token);
    for (const call of calls.values()) {
      if (!call.id || !call.name) throw new Error('Bridge returned an incomplete tool call.');
      progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, JSON.parse(call.arguments)));
    }
  }

  async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Promise<number> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (typeof text === 'string') return Math.ceil(Buffer.byteLength(text) / 3);
    return 8 + text.content.reduce<number>((count, part) => {
      if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) return count + 4096;
      return count + Math.ceil(Buffer.byteLength(JSON.stringify(part) || '') / 3);
    }, 0);
  }

  dispose(): void { this.disposed = true; this.changed.dispose(); }
}

export function registerBridgeModels(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('AI Usage CLI Bridge');
  const runtime = new BridgeRuntime(context.extensionPath);
  const provider = new BridgeModelProvider(runtime, log, context.globalState);
  const refresh = () => { void provider.refresh().catch(() => {}); };
  const timer = setInterval(refresh, 30000); timer.unref();
  context.subscriptions.push(log, runtime, provider, vscode.lm.registerLanguageModelChatProvider('ai-usage-cli', provider),
    vscode.commands.registerCommand('aiUsage.refreshBridgeModels', async () => {
      try { await provider.refresh(); vscode.window.showInformationMessage('CLI bridge models refreshed. Open the Copilot model picker → AI Usage CLI Bridge.'); }
      catch (error) { vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Bridge discovery failed.'); log.show(); }
    }),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('aiUsage.bridge')) refresh(); }),
    { dispose() { clearInterval(timer); } });
  refresh();
}
