import type { StatusFilter, StatusRead } from './statusProjection';
import { UsageContext, UsageStateView } from './usageMonitor';
import { ProviderId } from './live';
import { EventEmitter } from 'events';
import { SERVICE_PROTOCOL_VERSION } from './protocol';
import { RpcClient, RpcError } from './rpc';
import { readServiceInfo, readToken, socketPath, processAlive } from './paths';
import type { AuthProvider } from './authFiles';
import type { ServiceConfig } from './configStore';
import type { ProfileMetadata } from './profileStore';
import type {
  ResetConfirmation, ResetResolution, ConfigState, RequestOptions, ActivationResult, EventName, ExportResult, HelloResult, ImportPlanView, ImportSummary, KeepAliveResult, ProviderView, SaveNativeResult,
  CheckWait, HistoryExportKind, HistoryInfo, HistorySummaryResult, KeepAliveAllResult, SerializedUsage, ServiceEvent, ServiceInfo, SignInPreparation,
  SignInResult, Snapshot, UsageReadResult, CliPreparation, ServiceCommands
} from './protocol';

type OptionalParamsCommand = {
  [K in keyof ServiceCommands]: undefined extends ServiceCommands[K]['params'] ? K : never
}[keyof ServiceCommands];

/** Why a connection could not be made, so a caller can install, start or just report. */
export type UnavailableReason = 'not-installed' | 'not-running' | 'refused';

export class ServiceUnavailableError extends Error {
  constructor(message: string, readonly reason: UnavailableReason) { super(message); }
}

export type ClientOptions = {
  home: string;
  /** Who is connecting, for the service log: `vscode`, `cli`. */
  client: string;
  version?: string;
  subscribe?: EventName[] | 'all';
  /** Project folders open at the client, whose profile files the service lists while the client is connected. */
  folders?: string[];
  timeoutMs?: number;
  requiredCapabilities?: readonly string[];
};

/**
 * Typed access to a running service. Emits `event` with every pushed `ServiceEvent` the connection subscribed to,
 * and `close` once the connection is gone. Shared by the VS Code extension and the `ai-usage` command.
 */
export class ServiceClient extends EventEmitter {
  private constructor(private readonly rpc: Pick<RpcClient, 'isClosed' | 'close' | 'call'> & Pick<EventEmitter, 'on'>, readonly info: ServiceInfo, readonly capabilities: readonly string[], readonly protocolVersion: number) {
    super();
    rpc.on('event', (event: ServiceEvent) => this.emit('event', event));
    rpc.on('close', () => this.emit('close'));
    rpc.on('error', () => { /* Surfaces as close. */ });
  }

  static async connect(options: ClientOptions): Promise<ServiceClient> {
    const token = readToken(options.home);
    if (!token) { throw new ServiceUnavailableError('The account service has never run here: no service token was found.', 'not-installed'); }
    try {
      const { client, hello } = await RpcClient.connect({ socketPath: socketPath(options.home), token, client: options.client, version: options.version,
        subscribe: options.subscribe, folders: options.folders, timeoutMs: options.timeoutMs, requiredCapabilities: options.requiredCapabilities ?? ['engine', 'config-revision', 'request-cancellation'] });
      const result = hello as HelloResult;
      return new ServiceClient(client, result.service, result.capabilities ?? [], result.protocolVersion ?? SERVICE_PROTOCOL_VERSION);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') { throw new ServiceUnavailableError('The account service is not running.', 'not-running'); }
      if (error instanceof RpcError) { throw new ServiceUnavailableError(`The account service refused the connection: ${error.message}`, 'refused'); }
      throw error;
    }
  }

  liveUsage(provider: ProviderId, force = false, options?: RequestOptions): Promise<UsageStateView> { return this.call('usage.live', { provider, force }, options); }
  usageContext(context: UsageContext): Promise<unknown> { return this.call('usage.context', context); }
  get connected(): boolean { return !this.rpc.isClosed; }

  close(): void { this.rpc.close(); }

  supports(capability: string): boolean { return this.capabilities.includes(capability); }

  call<K extends OptionalParamsCommand>(method: K, params?: ServiceCommands[K]['params'], options?: number | RequestOptions): Promise<ServiceCommands[K]['result']>;
  call<K extends keyof ServiceCommands>(method: K, params: ServiceCommands[K]['params'], options?: number | RequestOptions): Promise<ServiceCommands[K]['result']>;
  call(method: keyof ServiceCommands, params?: unknown, options?: number | RequestOptions): Promise<unknown> {
    return this.rpc.call(method, params, options);
  }

  resetConfirmations(): Promise<ResetConfirmation[]> { return this.call('reset.confirmations'); }
  claimReset(id: string): Promise<ResetConfirmation | null> { return this.call('reset.claim', { id }); }
  resolveReset(id: string, approve: boolean, options?: RequestOptions): Promise<ResetResolution> { return this.call('reset.resolve', { id, approve }, options); }

  statusSnapshot(filter?: StatusFilter, options?: RequestOptions): Promise<StatusRead> { return this.call('status.snapshot', filter, options); }

  serviceInfo(): Promise<ServiceInfo> { return this.call('service.info'); }
  snapshot(): Promise<Snapshot> { return this.call('snapshot'); }
  list(provider: AuthProvider, options?: RequestOptions): Promise<ProviderView> { return this.call('profiles.list', { provider }, options); }
  /** `target` is an id, or `{ ref }` with a name, 1-based number or id. */
  activate(provider: AuthProvider, target: string | { ref: string }, options?: RequestOptions): Promise<ActivationResult> {
    return this.call('profiles.activate', { provider, ...(typeof target === 'string' ? { id: target } : target) }, options);
  }
  /** `folder`: keep the new profile in that declared project folder's file instead of privately. */
  saveNative(provider: AuthProvider, options: { name?: string; id?: string; allowDuplicate?: boolean; folder?: string }): Promise<SaveNativeResult> {
    return this.call('profiles.saveNative', { provider, ...options });
  }
  importCredential(provider: AuthProvider, name: string, credential: unknown, allowDuplicate = false, folder?: string): Promise<SaveNativeResult> {
    return this.call('profiles.importCredential', { provider, name, credential, allowDuplicate, folder });
  }
  /** Replaces the project folders this connection declared; their profile files are listed while it stays connected. */
  setFolders(folders: string[]): Promise<unknown> { return this.call('session.folders', { folders }); }
  rename(provider: AuthProvider, target: string | { ref: string }, name: string): Promise<{ id: string; name: string }> {
    return this.call('profiles.rename', { provider, ...(typeof target === 'string' ? { id: target } : target), name });
  }
  reorder(provider: AuthProvider, id: string, step: -1 | 1): Promise<ProfileMetadata[]> {
    return this.call('profiles.reorder', { provider, id, step });
  }
  delete(provider: AuthProvider, target: string | { ref: string }): Promise<{ profile: { id: string; name: string }; wasActive: boolean }> {
    return this.call('profiles.delete', { provider, ...(typeof target === 'string' ? { id: target } : target) });
  }
  exportProfiles(selection?: Array<{ provider: AuthProvider; id: string }>): Promise<ExportResult> {
    return this.call('profiles.export', { selection });
  }
  planImport(text: string): Promise<ImportPlanView[]> { return this.call('profiles.planImport', { text }); }
  applyImport(text: string, chosen?: Array<{ provider: AuthProvider; id: string }>): Promise<ImportSummary> {
    return this.call('profiles.applyImport', { text, chosen });
  }
  /** Imports already-parsed entries, as the extension does when it moves its own saved profiles over. */
  applyImportEntries(entries: unknown[], chosen?: Array<{ provider: AuthProvider; id: string }>): Promise<ImportSummary> {
    return this.call('profiles.applyImport', { entries, chosen });
  }
  prepareSignIn(provider: AuthProvider, target?: string | { ref: string }): Promise<SignInPreparation> {
    return this.call('profiles.signIn.prepare', { provider, ...(typeof target === 'string' ? { id: target } : target) });
  }
  prepareCli(provider: AuthProvider, target: string | { ref: string }, options?: RequestOptions): Promise<CliPreparation> {
    return this.call('profiles.cli.prepare', { provider, ...(typeof target === 'string' ? { id: target } : target) },
      options ?? { timeoutMs: 195_000 });
  }
  finishSignIn(provider: AuthProvider, target: string | { ref: string }, allowOtherAccount = false): Promise<SignInResult> {
    return this.call('profiles.signIn.finish', { provider, ...(typeof target === 'string' ? { id: target } : target), allowOtherAccount });
  }
  cancelSignIn(provider: AuthProvider): Promise<unknown> { return this.call('profiles.signIn.cancel', { provider }); }
  keepAliveNow(provider: AuthProvider, target: string | { ref: string }, options: boolean | ({ callerReports?: boolean } & CheckWait) = false): Promise<KeepAliveResult> {
    const settings = typeof options === 'boolean' ? { callerReports: options } : options;
    return this.call('automation.keepAliveNow', { provider, ...(typeof target === 'string' ? { id: target } : target), ...settings });
  }
  /** One sweep over `ids` (every saved profile when omitted) under one lock; progress arrives as `keepAliveProgress` events. */
  keepAliveAll(provider: AuthProvider, ids?: string[], wait: CheckWait = {}): Promise<KeepAliveAllResult> {
    return this.call('automation.keepAliveAll', { provider, ids, ...wait });
  }
  /** Stops the wait, or the sweep, that was requested with `token`. */
  cancel(token: string): Promise<unknown> { return this.call('automation.cancel', { token }, 5_000); }
  rotateNow(provider: AuthProvider, wait: CheckWait = {}, options?: RequestOptions): Promise<{ switched: boolean; reason?: string; activeProfileId?: string; activeProfileName?: string }> {
    return this.call('automation.rotateNow', { provider, ...wait }, options);
  }
  tick(): Promise<unknown> { return this.call('automation.tick'); }
  /** Reads a profile's usage from the vendor now, without a keep-alive prompt. */
  readUsage(provider: AuthProvider, target: string | { ref: string }, options?: RequestOptions): Promise<UsageReadResult> {
    return this.call('usage.read', { provider, ...(typeof target === 'string' ? { id: target } : target) }, options);
  }
  observe(provider: AuthProvider, id: string, usage: SerializedUsage): Promise<unknown> { return this.call('usage.observe', { provider, id, usage }); }
  hintLimit(provider: AuthProvider, usage: SerializedUsage): Promise<unknown> { return this.call('usage.hintLimit', { provider, usage }); }
  getConfigState(): Promise<ConfigState> { return this.call('config.read'); }
  patchConfig(values: Record<string, unknown>, expectedRevision: number): Promise<ConfigState> {
    return this.call('config.patch', { values, baseRevision: expectedRevision });
  }
  getConfig(options?: RequestOptions): Promise<ServiceConfig> { return this.call('config.get', undefined, options); }
  setConfig(values: Record<string, unknown>): Promise<ServiceConfig> { return this.call('config.set', { values }); }
  tailLog(lines: number): Promise<string[]> { return this.call('log.tail', { lines }); }
  historyInfo(): Promise<HistoryInfo> { return this.call('history.info'); }
  /** The last `days` days, or everything kept when `days` is omitted. */
  historySummary(days?: number): Promise<HistorySummaryResult> { return this.call('history.summary', { days }); }
  /** Readings or the other events as CSV, or every kept line as JSON Lines. */
  historyExport(kind: HistoryExportKind): Promise<{ text: string; extension: string }> { return this.call('history.export', { kind }, 60_000); }
  shutdown(): Promise<unknown> { return this.call('service.shutdown', undefined, 5_000); }
}

/** Cheap check from the info file: a daemon wrote it and its process still exists. */
export function daemonAppearsRunning(home: string): boolean {
  const info = readServiceInfo(home);
  return Boolean(info && processAlive(info.pid));
}

/** Connects, says hello and disconnects; undefined when nothing answers. */
export async function pingService(home: string, timeoutMs = 2_000): Promise<ServiceInfo | undefined> {
  try {
    const client = await ServiceClient.connect({ home, client: 'ping', timeoutMs });
    const info = client.info;
    client.close();
    return info;
  } catch { return undefined; }
}

export type ConnectOptions = ClientOptions & {
  /** Starts the daemon when nothing answers; the connection is retried for `waitMs` afterwards. */
  start?: () => Promise<void> | void;
  waitMs?: number;
};

/** Connects to the service, starting it first when it is not running and a starter is given. */
export async function connectService(options: ConnectOptions): Promise<ServiceClient> {
  try {
    return await ServiceClient.connect(options);
  } catch (error) {
    if (!(error instanceof ServiceUnavailableError) || !options.start || error.reason === 'refused') { throw error; }
    await options.start();
    const deadline = Date.now() + (options.waitMs ?? 8_000);
    let last: unknown = error;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try { return await ServiceClient.connect(options); }
      catch (retryError) {
        last = retryError;
        if (retryError instanceof ServiceUnavailableError && retryError.reason === 'refused') { throw retryError; }
      }
    }
    throw last instanceof Error ? last : new ServiceUnavailableError('The account service did not start.', 'not-running');
  }
}
