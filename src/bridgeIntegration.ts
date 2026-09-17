import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { agentMap, openAgentMap, sessionLink, agentKey } from './bridgeAgents';

export type Subagent = { id: string; tool_call_id?: string; native_session_id?: string; parent_native_session_id?: string; status: string; label?: string; summary?: string; updated_at?: number };

export type Session = {
  id: string; model: string; backend: string; account: string | null; native_session_id: string | null;
  parent_id: string | null; child_ids: string[]; status: string; elapsed_ms: number;
  phases: { phase: string; at: number }[]; usage: unknown; usage_scope: string; error_code?: string;
  subagents?: Subagent[]; persisted?: boolean; released?: boolean; cwd?: string; continued?: boolean;
  cli_executable?: { file: string; args?: string[] };
  launch?: { extension_url?: string; cli?: { command: string; args: string[]; cwd: string } };
};
type Catalog = { id: string; bridge?: { cli_version?: string; image_input?: boolean; reasoning_efforts?: string[] } };
type Diagnosis = { backend: string; status: string; models?: Catalog[]; code?: string; message?: string };

// Credentials stay on this host. Never follow redirects or send the local token
// to a workspace-configured remote endpoint.
export async function bridgeGet<T>(route: string, cancellation?: vscode.CancellationToken): Promise<T> {
  return bridgeRequest<T>(route, 'GET', undefined, cancellation);
}

export async function bridgeConnection(): Promise<{ endpoint: URL; token: string }> {
  const config = vscode.workspace.getConfiguration('aiUsage.bridge');
  const endpoint = new URL(config.get<string>('url', 'http://127.0.0.1:3210'));
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
    throw new Error('The CLI bridge URL must be a loopback HTTP address.');
  }
  const tokenFile = config.get<string>('tokenFile', '') || path.join(os.homedir(), '.cli-byok-bridge', 'token');
  let token: string;
  try { token = (await fs.readFile(tokenFile, 'utf8')).trim(); }
  catch { throw new Error('Bridge token file is unavailable on this extension host. Start the CLI bridge here or configure aiUsage.bridge.tokenFile.'); }
  return { endpoint, token };
}

async function bridgeRequest<T>(route: string, method: 'GET' | 'PUT', body?: unknown, cancellation?: vscode.CancellationToken): Promise<T> {
  const { endpoint, token } = await bridgeConnection();
  if (cancellation?.isCancellationRequested) throw new vscode.CancellationError();
  return new Promise<T>((resolve, reject) => {
    const request = http.request(new URL(route, endpoint), { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        data += chunk;
        if (data.length > 2 * 1024 * 1024) request.destroy(new Error('Bridge metadata response is too large.'));
      });
      response.on('error', () => reject(new Error('Bridge metadata response was interrupted.')));
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error(`Bridge returned HTTP ${response.statusCode}. Check the token, server version, and backend login.`)); return; }
        try { resolve(JSON.parse(data) as T); } catch { reject(new Error('Bridge returned invalid metadata.')); }
      });
    });
    const subscription = cancellation?.onCancellationRequested(() => request.destroy(new vscode.CancellationError()));
    const timer = setTimeout(() => request.destroy(new Error('Bridge check timed out. Confirm it is running on this host.')), 20000);
    request.on('close', () => { clearTimeout(timer); subscription?.dispose(); });
    request.on('error', error => reject(error instanceof vscode.CancellationError ? error : new Error('Could not reach the CLI bridge. Check its address, token, and extension host.')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export async function syncSessionSettings(): Promise<void> {
  const config = vscode.workspace.getConfiguration('aiUsage.bridge');
  const folders = vscode.workspace.workspaceFolders;
  const workspaceDirectory = folders?.length === 1 ? folders[0].uri.fsPath : '';
  const settings = Object.fromEntries(['codex', 'claude'].map(provider => [provider, {
    persistSessions: config.get(`${provider}.persistSessions`, false),
    openInCli: config.get(`${provider}.openInCli`, false),
    openInExtension: config.get(`${provider}.openInExtension`, false),
    subagentsEnabled: config.get(`${provider}.subagentsEnabled`, true),
    requestTimeoutMinutes: config.get(`${provider}.requestTimeoutMinutes`, 60),
    toolTimeoutMinutes: config.get(`${provider}.toolTimeoutMinutes`, 60),
    sessionDirectory: config.get(`${provider}.sessionDirectory`, '') || workspaceDirectory
  }]));
  await bridgeRequest('/v1/session-settings', 'PUT', settings);
}

function registerSessionSettings(context: vscode.ExtensionContext): void {
  let disposed = false;
  let pending: Promise<void> | undefined;
  const sync = () => {
    if (disposed || pending) return;
    pending = syncSessionSettings().catch(() => { /* A standalone bridge may not be running yet. Retry below. */ }).finally(() => { pending = undefined; });
  };
  const timer = setInterval(sync, 15000); timer.unref();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('aiUsage.bridge')) {
      // Queue after an in-flight update so a rapid toggle cannot leave stale settings.
      void (pending || Promise.resolve()).then(sync);
    }
  }), { dispose() { disposed = true; clearInterval(timer); } });
  sync();
}

export function sessionActions(session: Session): string[] {
  const actions = ['Show details', 'Copy bridge session ID', 'Copy native session ID', 'Copy metadata'];
  const config = vscode.workspace.getConfiguration('aiUsage.bridge');
  if (session.persisted && session.released && session.native_session_id) {
    if (session.launch?.cli && config.get(`${session.backend}.openInCli`, false)) actions.push('Open in CLI');
    if (session.launch?.extension_url && config.get(`${session.backend}.openInExtension`, false)) actions.push('Open in VS Code Extension', 'Copy VS Code Extension Link');
  }
  return actions;
}

export async function openSession(id: string, target: 'cli' | 'extension' | 'copyLink', childKey?: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid bridge session ID.');
  await syncSessionSettings();
  const session = await bridgeGet<Session>(`/v1/sessions/${id}`);
  if (session.id !== id) throw new Error('The bridge returned a different session.');
  if (session.persisted && !session.released) throw new Error('This session is still running. Open it after Copilot finishes the response.');
  if (childKey !== undefined) {
    const child = session.subagents?.find(agent => agentKey(agent) === childKey);
    if (session.backend !== 'codex' || !session.persisted || !session.released ||
      !child || !/^[a-f0-9-]{36}$/.test(child.native_session_id || '') || ['running', 'pendingInit'].includes(child.status)) {
      throw new Error('This native child thread cannot be opened. Use its agent details in Copilot.');
    }
    session.native_session_id = child.native_session_id!;
    const cli = session.launch?.cli;
    session.launch = {
      extension_url: `vscode://openai.chatgpt/local/${child.native_session_id}`,
      ...(cli ? { cli: { ...cli, args: [...(session.cli_executable?.args || []), 'resume', child.native_session_id!] } } : {})
    };
  }
  const action = target === 'cli' ? 'Open in CLI' : target === 'copyLink' ? 'Copy VS Code Extension Link' : 'Open in VS Code Extension';
  if (!sessionActions(session).includes(action)) throw new Error('This session cannot be opened. Enable persistence before starting it, enable the opening action in AI Usage settings, and wait for the bridge to release it.');
  if (target === 'cli') {
    const cli = session.launch!.cli!;
    // Pass arguments directly: neither session IDs nor directories become shell input.
    const terminal = vscode.window.createTerminal({ name: `${session.backend} session`, shellPath: cli.command, shellArgs: cli.args, cwd: cli.cwd });
    terminal.show();
    return;
  }
  const uri = vscode.Uri.parse(session.launch!.extension_url!).with({ scheme: vscode.env.uriScheme });
  if (target === 'copyLink') { await vscode.env.clipboard.writeText(uri.toString(true)); return; }
  const extension = vscode.extensions.getExtension(uri.authority);
  if (!extension) throw new Error(`Install the ${session.backend === 'claude' ? 'Claude Code' : 'Codex'} extension on this host to open this session.`);
  await extension.activate();
  if (session.backend === 'claude') {
    const matches = await Promise.all((vscode.workspace.workspaceFolders || []).map(async folder => {
      try { return await fs.realpath(folder.uri.fsPath) === await fs.realpath(session.cwd!); } catch { return false; }
    }));
    if (!matches.some(Boolean)) throw new Error(`Open the session folder (${session.cwd}) in this VS Code window first. Claude resumes sessions only in their workspace. You can also set AI Usage > Bridge > Claude: Session Directory to your project for future sessions.`);
    // The public Claude URI always invokes primaryEditor.open. The installed
    // extension's programmatic route preserves the exact ID and honors sidebar
    // placement (or focuses an existing editor for that same session).
    const claudeConfig = vscode.workspace.getConfiguration('claudeCode');
    if (claudeConfig.get('preferredLocation') !== 'sidebar') {
      // Claude's sidebar command starts this update without awaiting it. Wait
      // here so editor.open cannot race it and choose a new editor tab.
      await claudeConfig.update('preferredLocation', 'sidebar', vscode.ConfigurationTarget.Global);
    }
    await vscode.commands.executeCommand('claude-vscode.sidebar.open');
    await vscode.commands.executeCommand('claude-vscode.editor.open', session.native_session_id,
      undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' });
    return;
  }
  await vscode.commands.executeCommand('chatgpt.openSidebar');
  if (!await vscode.env.openExternal(uri)) throw new Error('VS Code could not open the session link.');
}

export async function handleSessionUri(uri: vscode.Uri): Promise<void> {
  if (uri.authority !== 'p0l0us.ai-usage-vscode-plugin') throw new Error('Invalid session link.');
  const child = /^\/sessions\/([a-f0-9-]{36})\/agent\/([a-zA-Z0-9_-]{1,200})\/(cli|extension)$/.exec(uri.path);
  if (child) { await openSession(child[1], child[3] as 'cli' | 'extension', child[2]); return; }
  const map = /^\/sessions\/([a-f0-9-]{36})\/(?:agents|agent\/([a-zA-Z0-9_-]{1,200}))$/.exec(uri.path);
  if (map) { await openAgentMap(map[1], map[2]); return; }
  const match = /^\/sessions\/([a-f0-9-]{36})\/(cli|extension)$/.exec(uri.path);
  if (!match) throw new Error('Invalid session link.');
  await openSession(match[1], match[2] as 'cli' | 'extension');
}

export async function integrationReport(token?: vscode.CancellationToken): Promise<string> {
  const config = vscode.workspace.getConfiguration();
  // A provider can stall its own picker discovery. Keep the diagnostic command
  // bounded even when another extension never resolves selectChatModels.
  const visibleModels = new Promise<vscode.LanguageModelChat[]>((resolve, reject) => {
    let subscription: vscode.Disposable | undefined;
    const finish = (value?: vscode.LanguageModelChat[], error?: Error) => {
      clearTimeout(timer); subscription?.dispose();
      if (error) reject(error); else resolve(value || []);
    };
    const timer = setTimeout(() => finish(undefined, new Error('Model picker discovery timed out.')), 10000);
    subscription = token?.onCancellationRequested(() => finish(undefined, new vscode.CancellationError()));
    if (token?.isCancellationRequested) finish(undefined, new vscode.CancellationError());
    else Promise.resolve(vscode.lm.selectChatModels({})).then(value => finish(value), error => finish(undefined, error));
  });
  const [diagnosis, models] = await Promise.allSettled([
    bridgeGet<{ backends: Diagnosis[] }>('/v1/diagnostics', token), visibleModels
  ]);
  const lines = ['AI Usage: Copilot integration check', '',
    `VS Code: ${vscode.version}; extension host: ${vscode.env.remoteName || 'local'} (${process.platform})`,
    `Copilot Chat extension: ${vscode.extensions.getExtension('GitHub.copilot-chat') ? 'installed' : 'not found on this host'}`,
    `Agent Host BYOK: ${config.get('chat.agentHost.byokModels.enabled', false) ? 'enabled' : 'disabled (only needed for Agent Host)'}`];
  const available = models.status === 'fulfilled' ? models.value : [];
  lines.push(`Visible chat models: ${available.length}`);
  for (const key of ['chat.utilityModel', 'chat.utilitySmallModel']) {
    const value = config.get<unknown>(key);
    const id = typeof value === 'string' ? value : (value as { id?: string } | undefined)?.id;
    const match = id && available.some(m => m.id === id || `${m.vendor}/${m.id}` === id);
    lines.push(`${key}: ${JSON.stringify(value ?? 'default')} — ${!id ? 'default; built-in utility models require Copilot login, or configure a BYOK utility model' : match ? 'available' : 'not found in visible models; review this selection'}`);
  }
  lines.push(`chat.byokUtilityModelDefault: ${JSON.stringify(config.get('chat.byokUtilityModelDefault', 'default'))}`);
  if (models.status === 'rejected') lines.push('Model picker discovery failed. Check Copilot and organization model policy.');
  if (diagnosis.status === 'fulfilled') {
    for (const backend of diagnosis.value.backends) {
      lines.push('', `${backend.backend}: ${backend.status}`);
      if (backend.message) lines.push(`${backend.code}: ${backend.message}`);
      for (const m of backend.models || []) {
        lines.push(`  ${m.id}; CLI ${m.bridge?.cli_version || 'unknown'}; images ${m.bridge?.image_input ? 'yes' : 'no'}; reasoning ${(m.bridge?.reasoning_efforts || []).join(', ') || 'not advertised'}`);
        if (!available.some(visible => visible.id === m.id || visible.id.endsWith('/' + m.id))) lines.push('    Not visible to Copilot: enable AI Usage Bridge models, then run AI Usage: Refresh Bridge Models.');
      }
    }
  } else lines.push('', diagnosis.reason instanceof Error ? diagnosis.reason.message : 'Bridge diagnostics failed.');
  lines.push('', 'This checks configuration, discovery, CLI compatibility, and subscription status without running inference.',
    'The bridge must run where this extension host can reach it. Review organization BYOK policy if models remain unavailable.');
  return lines.join('\n');
}

async function inspectSessions(): Promise<void> {
  await syncSessionSettings();
  const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { session?: Session }>();
  picker.title = 'CLI Session Inspector'; picker.placeholder = 'Select a session to inspect or copy its IDs and usage';
  let disposed = false; let refreshing = false;
  const refresh = async () => {
    if (refreshing) return; refreshing = true;
    try {
      const { data } = await bridgeGet<{ data: Session[] }>('/v1/sessions');
      if (!disposed) picker.items = data.reverse().map(session => ({ label: `${session.model} · ${session.status}`,
        description: `${Math.round(session.elapsed_ms / 1000)}s · ${session.account || 'account not reported'}`,
        detail: `${session.id} · native ${session.native_session_id || 'starting'} · usage ${session.usage ? JSON.stringify(session.usage) : 'not reported'}`, session }));
      if (!disposed && !data.length) picker.placeholder = 'No bridge sessions yet. Run a request with a CLI model.';
    } catch (error) { if (!disposed) picker.placeholder = error instanceof Error ? error.message : 'Could not load sessions'; }
    finally { refreshing = false; }
  };
  const timer = setInterval(() => void refresh(), 2000);
  picker.onDidHide(() => { disposed = true; clearInterval(timer); picker.dispose(); });
  picker.onDidAccept(() => {
    const session = picker.selectedItems[0]?.session;
    if (!session) return;
    picker.hide();
    void (async () => {
      const action = await vscode.window.showQuickPick(sessionActions(session), { title: session.id });
      if (action === 'Show details') await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: JSON.stringify(session, null, 2), language: 'json' }));
      if (action === 'Copy bridge session ID') await vscode.env.clipboard.writeText(session.id);
      if (action === 'Copy native session ID' && session.native_session_id) await vscode.env.clipboard.writeText(session.native_session_id);
      if (action === 'Copy metadata') await vscode.env.clipboard.writeText(JSON.stringify(session, null, 2));
      if (action === 'Open in CLI') await openSession(session.id, 'cli');
      if (action === 'Open in VS Code Extension') await openSession(session.id, 'extension');
      if (action === 'Copy VS Code Extension Link') await openSession(session.id, 'copyLink');
    })().catch(error => vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not open session.'));
  });
  picker.show(); void refresh();
}

export function registerBridgeIntegration(context: vscode.ExtensionContext): void {
  registerSessionSettings(context);
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: uri => handleSessionUri(uri)
    .catch(error => { vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not open session.'); }) }));
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.checkCopilotIntegration', async () => {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking Copilot integration', cancellable: true }, async (_, token) => {
      const content = await integrationReport(token);
      if (!token.isCancellationRequested) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content, language: 'plaintext' }));
    });
  }), vscode.commands.registerCommand('aiUsage.inspectCliSessions', () => inspectSessions().catch(error => vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not inspect sessions.'))));
  for (const [name, subagents] of [['aiUsage_get_cli_session_info', false], ['aiUsage_list_cli_subagents', true]] as const) {
    context.subscriptions.push(vscode.lm.registerTool<{ session_id: string }>(name, {
      async invoke(options, token) {
        if (!/^[a-f0-9-]{36}$/.test(options.input.session_id)) throw new Error('Provide an explicit bridge session ID from AI Usage: Inspect CLI Sessions.');
        const metadata = await bridgeGet(`/v1/sessions/${options.input.session_id}${subagents ? '/subagents' : ''}`, token);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(metadata))]);
      }
    }));
  }
  context.subscriptions.push(vscode.lm.registerTool<{ session_id: string; prompt: string }>('aiUsage_fork_cli_session', {
    async invoke(options, token) {
      const { session_id: id, prompt } = options.input;
      if (!/^[a-f0-9-]{36}$/.test(id) || typeof prompt !== 'string' || !prompt.trim()) throw new Error('Provide a saved bridge session ID and a branch task.');
      await syncSessionSettings();
      const parent = await bridgeGet<Session>(`/v1/sessions/${id}`, token);
      const { streamBridge } = await import('./bridgeTransport');
      let answer = ''; let branch: Session | undefined;
      await streamBridge({ model: parent.model, messages: [{ role: 'user', content: prompt }],
        bridge_fork_session_id: id, tool_choice: 'none', stream: true }, frame => {
        if (frame.bridge_session) branch = frame.bridge_session;
        for (const choice of frame.choices || []) answer += choice.delta?.content || '';
      }, token);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({
        session_id: branch?.id, native_session_id: branch?.native_session_id, parent_id: id,
        agent_map_url: branch ? await sessionLink(branch.id, 'agents') : undefined, answer
      }))]);
    }
  }));
  const participant = vscode.chat.createChatParticipant('aiUsage.bridge', async (request, _, stream, token) => {
    stream.progress('Reading CLI bridge metadata…');
    try {
      if (request.command === 'agents') { stream.markdown(await agentMap(request.prompt, token)); return; }
      if (request.command === 'diagnose') stream.markdown('```text\n' + (await integrationReport(token)).replace(/```/g, "'''") + '\n```');
      else {
        const route = request.command === 'sessions' ? '/v1/sessions' : '/health';
        stream.markdown('```json\n' + JSON.stringify(await bridgeGet(route, token), null, 2).replace(/```/g, "'''") + '\n```');
      }
      stream.button({ command: 'aiUsage.inspectCliSessions', title: 'Inspect CLI Sessions' });
      stream.button({ command: 'aiUsage.checkCopilotIntegration', title: 'Check Copilot integration' });
    } catch (error) { stream.markdown(error instanceof Error ? error.message : 'Bridge check failed.'); }
  });
  participant.iconPath = new vscode.ThemeIcon('pulse'); context.subscriptions.push(participant);
}
