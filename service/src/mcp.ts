import type { Readable, Writable } from 'stream';
import type { AuthProvider } from './authFiles';
import { readableProblem } from './accountProbe';
import type { ServiceClient } from './client';
import { formatResetRemaining } from './live';
import { PROVIDERS, TITLES } from './profileStore';
import type { ProfileView, ProviderView, SerializedWindow } from './protocol';

/**
 * The MCP server behind `ai-usage mcp`: JSON-RPC 2.0 over stdin and stdout, one message per line, with the tools
 * an AI agent needs to read every saved profile's usage and, when allowed, switch the active account. Experimental,
 * and off until the `mcp.enabled` setting is on; every tool call checks the setting again, so turning it off takes
 * effect at once for a server that is already running. Written without an MCP SDK: the handful of methods used here
 * is small, and the service package has no dependencies.
 */

export const MCP_SERVER_NAME = 'ai-usage';
/** Newest first; a client's choice is echoed when it is one of these, otherwise the newest is offered. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type JsonRpcId = number | string | null;
type JsonRpcRequest = { jsonrpc?: string; id?: JsonRpcId; method?: unknown; params?: unknown };
export type JsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcId; result?: unknown; error?: { code: number; message: string } };

/** A protocol-level failure: the request itself was wrong. A failed tool is a tool result with `isError` instead. */
class McpError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

const INSTRUCTIONS = [
  'Tools of the AI Usage account service for Claude Code and Codex subscriptions.',
  'Start with list_accounts: every saved profile with its last usage reading. usedPercent is what is used, not what is left; a',
  'window at or above its threshold (the strategy line shows them) blocks the account, and "usable" says whether the service would',
  'switch to it. Readings are the stored ones; refresh_usage reads one profile from the vendor now, at the cost of an endpoint',
  'call, so use it for a candidate you are about to decide on. switch_account makes a profile the login that CLI uses for every',
  'new command (running sessions keep their account until their next turn); rotate_account runs the configured rotation once.',
  'Switch only when it helps, and say which account you switched to.'
].join(' ');

const SERVICE_PARAM = { type: 'string', enum: ['claude', 'codex'], description: 'The subscription: claude (Claude Code) or codex.' };
const PROFILE_PARAM = { type: 'string', description: 'The saved profile: its name, 1-based number, id or login email, as list_accounts shows them.' };

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  /** Offered and allowed only while `mcp.switching` is on. */
  switching?: boolean;
};

export const TOOLS: ToolDefinition[] = [
  {
    name: 'list_accounts', title: 'List accounts',
    description: 'Every saved Claude Code and Codex profile with its last usage reading: the 5-hour and weekly windows as percent used with their reset times, when it was read, whether the profile is active, usable, at a limit or has a login problem, and whether keep-alive and rotation are on. Stored readings, no endpoint call; use refresh_usage for a fresh one. Pass service to limit the answer to one subscription.',
    inputSchema: { type: 'object', properties: { service: SERVICE_PARAM }, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'refresh_usage', title: 'Refresh usage',
    description: 'Reads one profile\'s usage from the vendor now and stores it, without sending a prompt. Costs an endpoint call, so call it only for a candidate you are about to decide on; the active profile\'s reading is already kept fresh while VS Code is open.',
    inputSchema: { type: 'object', properties: { service: SERVICE_PARAM, profile: PROFILE_PARAM }, required: ['service', 'profile'], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: 'switch_account', title: 'Switch account', switching: true,
    description: 'Makes a saved profile the active login of that CLI (Claude Code or Codex). Every new command of that CLI, and the extension\'s chats on their next turn, use the new account; running sessions keep their current one until then. Prefer a profile that list_accounts shows as usable with a recent reading. Returns the service\'s own message and whether the account in use actually changed.',
    inputSchema: { type: 'object', properties: { service: SERVICE_PARAM, profile: PROFILE_PARAM }, required: ['service', 'profile'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'rotate_account', title: 'Rotate account', switching: true,
    description: 'Runs the service\'s rotation sweep for one subscription now: it switches to the best candidate by the configured strategy only when the active account is at a threshold (or, with the proactive trigger, when a clearly better one exists). Nothing happens when the active account is fine; the answer says why.',
    inputSchema: { type: 'object', properties: { service: SERVICE_PARAM }, required: ['service'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }
];

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

export type WindowSummary = { label: string; usedPercent: number; resetsAt?: string; resetsIn?: string };
export type ProfileSummary = {
  number: number;
  id: string;
  name: string;
  email?: string;
  active: boolean;
  /** A login is stored, no window is used up and the last check found no login problem: the service would switch to it. */
  usable: boolean;
  atLimit: boolean;
  /** Only a model-scoped weekly window (such as 7d Fable) is used up; other models still work. */
  modelLimited: boolean;
  loginProblem?: string;
  problems: string[];
  checkedAt?: string;
  usage?: { fetchedAt: string; plan?: string; windows: WindowSummary[] };
};
export type ServiceSummary = {
  service: AuthProvider;
  title: string;
  activeProfile?: { id: string; name: string; number: number };
  /** The native login belongs to no saved profile. */
  nativeUnsaved: boolean;
  keepAlive: boolean;
  autoRotate: boolean;
  rotation: string;
  profiles: ProfileSummary[];
};

function windowSummary(window: SerializedWindow, now: Date): WindowSummary {
  const resetsIn = formatResetRemaining(window.resetsAt ? new Date(window.resetsAt) : undefined, now);
  return { label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt, resetsIn: resetsIn || undefined };
}

export function profileSummary(profile: ProfileView, now: Date): ProfileSummary {
  const usage = profile.usage;
  return {
    number: profile.number, id: profile.id, name: profile.name, email: profile.email, active: profile.active,
    usable: profile.hasCredential && !profile.loginProblem && !profile.limit.readOnly,
    atLimit: profile.limit.readOnly, modelLimited: profile.limit.dimmed,
    loginProblem: profile.loginProblem ? readableProblem(profile.loginProblem) : undefined,
    problems: profile.problems.map((problem) => problem.label),
    checkedAt: profile.checkedAt,
    usage: usage ? { fetchedAt: usage.fetchedAt, plan: usage.plan, windows: usage.windows.map((window) => windowSummary(window, now)) } : undefined
  };
}

export function serviceSummary(view: ProviderView, now: Date): ServiceSummary {
  const active = view.profiles.find((profile) => profile.active);
  return {
    service: view.provider, title: view.title,
    activeProfile: active ? { id: active.id, name: active.name, number: active.number } : undefined,
    nativeUnsaved: view.nativeUnsaved, keepAlive: view.keepAlive, autoRotate: view.autoRotate, rotation: view.strategySummary,
    profiles: view.profiles.map((profile) => profileSummary(profile, now))
  };
}

function windowsText(windows: WindowSummary[]): string {
  return windows.map((window) => `${window.label} ${Math.round(window.usedPercent)}%${window.resetsIn ? ` (resets in ${window.resetsIn})` : ''}`).join(' · ');
}

/** One line per profile, readable by a model that gets no structured content. */
export function summaryText(summary: ServiceSummary): string {
  const header = `${summary.title}: active ${summary.activeProfile ? `“${summary.activeProfile.name}” (#${summary.activeProfile.number})` : 'none'}${summary.nativeUnsaved ? ' (the current login is not a saved profile)' : ''} · keep-alive ${summary.keepAlive ? 'on' : 'off'} · rotation ${summary.autoRotate ? `on (${summary.rotation})` : `off (${summary.rotation})`}`;
  if (!summary.profiles.length) { return `${header}\n  no saved profiles`; }
  const lines = summary.profiles.map((profile) => {
    const state = [profile.active ? 'active' : undefined, profile.atLimit ? 'at its limit' : undefined, profile.modelLimited ? 'model window used up' : undefined,
      profile.loginProblem ? `login problem: ${profile.loginProblem}` : undefined, ...profile.problems.map((problem) => `problem: ${problem}`),
      !profile.usable && !profile.atLimit && !profile.loginProblem ? 'no login stored' : undefined].filter(Boolean).join(', ');
    const reading = profile.usage ? `${windowsText(profile.usage.windows)} · checked ${profile.checkedAt ?? profile.usage.fetchedAt}` : 'no reading yet';
    return `  #${profile.number} “${profile.name}”${profile.email ? ` ${profile.email}` : ''}${state ? ` [${state}]` : ''}: ${reading}`;
  });
  return [header, ...lines].join('\n');
}

function providerArg(value: unknown): AuthProvider {
  if (value === 'claude' || value === 'codex') { return value; }
  throw new McpError(INVALID_PARAMS, 'service must be "claude" or "codex".');
}

function profileArg(value: unknown): string {
  if (typeof value === 'string' && value.trim()) { return value.trim(); }
  throw new McpError(INVALID_PARAMS, 'profile must name a saved profile: its name, number, id or email.');
}

function text(message: string, structuredContent?: Record<string, unknown>, isError = false): ToolResult {
  return { content: [{ type: 'text', text: message }], ...(structuredContent ? { structuredContent } : {}), ...(isError ? { isError } : {}) };
}

export type McpServerOptions = {
  /** Connects to the account service; called again after the connection was lost. */
  connect: () => Promise<ServiceClient>;
  version: string;
  /** Diagnostics; never stdout, which carries the protocol. */
  log?: (message: string) => void;
  now?: () => Date;
};

export class McpServer {
  private client?: ServiceClient;
  private connecting?: Promise<ServiceClient>;

  constructor(private readonly options: McpServerOptions) {}

  close(): void {
    this.client?.close();
    this.client = undefined;
  }

  private service(): Promise<ServiceClient> {
    if (this.client?.connected) { return Promise.resolve(this.client); }
    if (!this.connecting) {
      this.connecting = this.options.connect()
        .then((client) => { this.client = client; return client; })
        .finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  /** Answers one message; undefined for a notification, which gets no answer even when it fails. */
  async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) { return failure(null, INVALID_REQUEST, 'Invalid request.'); }
    const request = message as JsonRpcRequest;
    const notification = request.id === undefined;
    const id = request.id ?? null;
    if (typeof request.method !== 'string') { return notification ? undefined : failure(id, INVALID_REQUEST, 'Invalid request: no method.'); }
    try {
      const result = await this.dispatch(request.method, request.params);
      return notification ? undefined : { jsonrpc: '2.0', id, result: result ?? {} };
    } catch (error) {
      if (notification) { return undefined; }
      if (error instanceof McpError) { return failure(id, error.code, error.message); }
      return failure(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        return {
          protocolVersion: typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: 'AI Usage accounts', version: this.options.version },
          instructions: INSTRUCTIONS
        };
      }
      case 'ping': return {};
      case 'tools/list': return { tools: (await this.offeredTools()).map(({ switching: _switching, ...tool }) => tool) };
      case 'tools/call': return this.callTool(params);
      default:
        if (method.startsWith('notifications/')) { return undefined; }
        throw new McpError(METHOD_NOT_FOUND, `Method not found: ${method}.`);
    }
  }

  /** The switching tools are left out while `mcp.switching` is off; the service's answer decides, not a stale list. */
  private async offeredTools(): Promise<ToolDefinition[]> {
    try {
      const config = await (await this.service()).getConfig();
      return config.mcp.switching ? TOOLS : TOOLS.filter((tool) => !tool.switching);
    } catch { return TOOLS; }
  }

  private async callTool(params: unknown): Promise<ToolResult> {
    const { name, arguments: args } = (typeof params === 'object' && params !== null ? params : {}) as { name?: unknown; arguments?: unknown };
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) { throw new McpError(INVALID_PARAMS, `Unknown tool: ${String(name)}.`); }
    const input = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
    try {
      const client = await this.service();
      const config = await client.getConfig();
      if (!config.mcp.enabled) {
        return text('The AI Usage MCP server is turned off. Turn on aiUsage.mcp.enabled in VS Code settings, or run: ai-usage config mcp.enabled true', undefined, true);
      }
      if (tool.switching && !config.mcp.switching) {
        return text('Switching accounts through MCP is turned off (aiUsage.mcp.switching in VS Code settings, mcp.switching for ai-usage config). Only the usage tools are available.', undefined, true);
      }
      return await this.run(client, tool.name, input);
    } catch (error) {
      if (error instanceof McpError) { throw error; }
      // Something the agent can act on (the service is not running, the profile does not exist) is a tool result.
      const message = error instanceof Error ? error.message : String(error);
      this.options.log?.(`${tool.name}: ${message}`);
      return text(message, undefined, true);
    }
  }

  private async run(client: ServiceClient, name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const now = this.options.now?.() ?? new Date();
    switch (name) {
      case 'list_accounts': {
        const services = input.service === undefined ? PROVIDERS : [providerArg(input.service)];
        const summaries = (await Promise.all(services.map((provider) => client.list(provider)))).map((view) => serviceSummary(view, now));
        return text(summaries.map(summaryText).join('\n\n'), { services: summaries });
      }
      case 'refresh_usage': {
        const provider = providerArg(input.service);
        const result = await client.readUsage(provider, { ref: profileArg(input.profile) });
        const name = `${TITLES[provider]} profile “${result.profile.name}”`;
        if (result.usage) {
          const windows = result.usage.windows.map((window) => windowSummary(window, now));
          return text(`${name}: ${windowsText(windows)} · read ${result.usage.fetchedAt}`,
            { service: provider, profile: result.profile, usage: { fetchedAt: result.usage.fetchedAt, plan: result.usage.plan, windows } });
        }
        const problem = result.usageError ? readableProblem(result.usageError) : 'the usage could not be read';
        return text(`${name}: ${problem}`, { service: provider, profile: result.profile, error: problem }, true);
      }
      case 'switch_account': {
        const provider = providerArg(input.service);
        const result = await client.activate(provider, { ref: profileArg(input.profile) });
        return text(`${result.message}${result.accountChanged ? '' : ' The account in use did not change.'}`,
          { service: provider, profile: result.profile, level: result.level, accountChanged: result.accountChanged, verification: result.verification ?? null, message: result.message },
          result.level === 'error');
      }
      case 'rotate_account': {
        const provider = providerArg(input.service);
        const result = await client.rotateNow(provider);
        return text(result.switched
          ? `${TITLES[provider]} rotated to “${result.activeProfileName ?? result.activeProfileId}”.`
          : `${TITLES[provider]} not rotated: ${result.reason ?? 'no reason given'}.`,
        { service: provider, switched: result.switched, reason: result.reason, activeProfileId: result.activeProfileId, activeProfileName: result.activeProfileName });
      }
      default: throw new McpError(INVALID_PARAMS, `Unknown tool: ${name}.`);
    }
  }
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export type McpStdioOptions = McpServerOptions & { input: Readable; output: Writable };

/**
 * Serves the protocol on the given streams until the input ends; every line is one message, answers go out as one
 * line each, and requests are answered as they finish, so a ping is not held up by a slow tool call.
 */
export async function runMcpStdio(options: McpStdioOptions): Promise<number> {
  const server = new McpServer(options);
  const pending = new Set<Promise<void>>();
  const write = (response: JsonRpcResponse | JsonRpcResponse[]) => { options.output.write(`${JSON.stringify(response)}\n`); };
  const answer = async (message: unknown) => {
    if (Array.isArray(message)) {
      if (!message.length) { write(failure(null, INVALID_REQUEST, 'Invalid request: empty batch.')); return; }
      const responses = (await Promise.all(message.map((entry) => server.handle(entry)))).filter((response): response is JsonRpcResponse => response !== undefined);
      if (responses.length) { write(responses); }
      return;
    }
    const response = await server.handle(message);
    if (response) { write(response); }
  };
  const receive = (line: string) => {
    let message: unknown;
    try { message = JSON.parse(line); } catch { write(failure(null, PARSE_ERROR, 'Parse error.')); return; }
    const task = answer(message).catch((error: unknown) => options.log?.(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`));
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  let buffer = '';
  await new Promise<void>((resolve) => {
    options.input.setEncoding('utf8');
    options.input.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line) { receive(line); }
      }
    });
    options.input.once('end', () => resolve());
    options.input.once('error', () => resolve());
  });
  if (buffer.trim()) { receive(buffer.trim()); }
  await Promise.all(pending);
  server.close();
  return 0;
}
