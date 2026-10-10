import type { StatusFilter, StatusRead, StatusCursor } from './statusProjection';
import type { AuthProvider } from './authFiles';
import type { ActivationVerification } from './profileStore';
import type { ServiceConfig } from './configStore';
import type { ExportedProfile, ImportKind } from './profileTransfer';
import type { KeepAliveNowResult } from './accountAutomation';
import type { ProviderId, LiveUsage } from './live';
import type { UsageContext, UsageStateView } from './usageMonitor';
import type { ProfileMetadata } from './profileStore';
import type { RotationDiagnostics } from './rotationDiagnostics';
import type { McpCommand, McpRegistration, RegistrationOutcome } from './mcpRegistration';
import type { BridgeConnection } from './bridgeRuntime';
import type { ProcessInfo } from './codexProcesses';
import type { SessionTokenUsage } from './sessionTokens';

/** The wire contract is independent of the package version. Additive v1 changes accept older clients. */
export const SERVICE_PROTOCOL_VERSION = 1;
export const SERVICE_CAPABILITIES = ['engine', 'config-revision', 'request-cancellation', 'usage-live', 'session-context', 'lifecycle', 'reset-confirmation', 'status-snapshot'] as const;
export type ServiceCapability = typeof SERVICE_CAPABILITIES[number];
export type ConfigState = { revision: number; config: ServiceConfig; revisions?: Record<string, number>; scopes?: Record<string, 'engine' | 'presentation' | 'local' | 'workspace'>; changed?: string[] };
export type ConfigPatch = { values: Record<string, unknown>; baseRevision: number };
export type LifecycleState = 'starting' | 'running' | 'stopping' | 'stopped';
export type RequestOptions = { timeoutMs?: number; signal?: AbortSignal };

type ProfileReference = { provider: AuthProvider; id?: string; ref?: string };
type ImportSelection = Array<{ provider: AuthProvider; id: string }>;

/** Contract names, parameters and results shared by every socket client. */
export type ServiceCommands = {
  'reset.confirmations': { params: undefined; result: ResetConfirmation[] };
  'reset.claim': { params: { id: string }; result: ResetConfirmation | null };
  'reset.resolve': { params: { id: string; approve: boolean }; result: ResetResolution };
  'status.snapshot': { params: StatusFilter | undefined; result: StatusRead };
  'service.info': { params: undefined; result: ServiceInfo };
  'service.status': { params: undefined; result: Omit<ServiceInfo, 'clients'> & { clients: Array<{ id: number; client: string; version?: string }> } };
  snapshot: { params: undefined; result: Snapshot };
  'config.get': { params: undefined; result: ServiceConfig };
  'config.read': { params: undefined; result: ConfigState };
  'config.patch': { params: ConfigPatch; result: ConfigState };
  'config.set': { params: { values: Record<string, unknown> }; result: ServiceConfig };
  'usage.live': { params: { provider: ProviderId; force?: boolean }; result: UsageStateView };
  'usage.context': { params: UsageContext; result: unknown };
  'session.folders': { params: { folders: string[] }; result: unknown };
  'workspace.context': { params: { folders?: string[]; github?: UsageContext; sessionDirectory?: Partial<Record<AuthProvider, string>> }; result: { folders: string[]; github?: UsageContext; sessionDirectory?: Partial<Record<AuthProvider, string>> } };
  'profiles.list': { params: { provider: AuthProvider }; result: ProviderView };
  'profiles.activate': { params: ProfileReference; result: ActivationResult };
  'profiles.saveNative': { params: { provider: AuthProvider; name?: string; id?: string; allowDuplicate?: boolean; folder?: string }; result: SaveNativeResult };
  'profiles.importCredential': { params: { provider: AuthProvider; name: string; credential: unknown; allowDuplicate?: boolean; folder?: string }; result: SaveNativeResult };
  'profiles.rename': { params: ProfileReference & { name: string }; result: ProfileMetadata };
  'profiles.reorder': { params: { provider: AuthProvider; id: string; step: -1 | 1 }; result: ProfileMetadata[] };
  'profiles.delete': { params: ProfileReference; result: { profile: ProfileMetadata; wasActive: boolean } };
  'profiles.export': { params: { selection?: ImportSelection }; result: ExportResult };
  'profiles.planImport': { params: { text: string }; result: ImportPlanView[] };
  'profiles.applyImport': { params: { text?: string; entries?: unknown[]; chosen?: ImportSelection }; result: ImportSummary };
  'profiles.cli.prepare': { params: ProfileReference; result: CliPreparation };
  'profiles.signIn.prepare': { params: ProfileReference; result: SignInPreparation };
  'profiles.signIn.finish': { params: ProfileReference & { allowOtherAccount?: boolean }; result: SignInResult };
  'profiles.signIn.cancel': { params: { provider: AuthProvider }; result: { ok: true } };
  'automation.keepAliveNow': { params: ProfileReference & CheckWait & { callerReports?: boolean }; result: KeepAliveResult };
  'automation.keepAliveAll': { params: { provider: AuthProvider; ids?: string[] } & CheckWait; result: KeepAliveAllResult };
  'automation.cancel': { params: { token: string }; result: { ok: true } };
  'automation.rotateNow': { params: { provider: AuthProvider } & CheckWait; result: { switched: boolean; reason?: string; activeProfileId?: string; activeProfileName?: string } };
  'automation.tick': { params: undefined; result: { ok: true } };
  'usage.read': { params: ProfileReference; result: UsageReadResult };
  'usage.observe': { params: { provider: AuthProvider; id: string; usage: SerializedUsage }; result: unknown };
  'usage.hintLimit': { params: { provider: AuthProvider; usage: SerializedUsage }; result: unknown };
  'usage.sessionTokens': { params: { provider: AuthProvider }; result: (Omit<SessionTokenUsage, 'updatedAt'> & { updatedAt: string }) | null };
  'rotation.diagnostics': { params: { provider: AuthProvider }; result: RotationDiagnostics };
  'history.info': { params: undefined; result: HistoryInfo };
  'history.summary': { params: { days?: number }; result: HistorySummaryResult };
  'history.export': { params: { kind: HistoryExportKind }; result: { text: string; extension: string } };
  'runtime.status': { params: undefined; result: { codexProxyActive: boolean } };
  'runtime.staleCodex': { params: { switchedAt: number; parentPid: number }; result: ProcessInfo[] };
  'mcp.registration': { params: { provider: AuthProvider }; result: { launcher: string; command: McpCommand; cli?: string; reason?: string; registration: McpRegistration } };
  'mcp.register': { params: { provider: AuthProvider }; result: RegistrationOutcome };
  'mcp.unregister': { params: { provider: AuthProvider }; result: { ok: boolean; detail: string } };
  'bridge.ensure': { params: undefined; result: BridgeConnection };
  'bridge.connection': { params: undefined; result: BridgeConnection };
  'bridge.sync': { params: undefined; result: { ok: true } };
  'log.tail': { params: { lines: number }; result: string[] };
  'service.shutdown': { params: undefined; result: { ok: true; mode: 'background' | 'embedded' } };
};

/**
 * What travels between the service and its clients (the VS Code extension and the `ai-usage` command): plain JSON
 * with ISO dates. Requests are `{ id, method, params }`, answers `{ id, result }` or `{ id, error }`, and the
 * service pushes `{ event, data }` messages to subscribed clients.
 */

export type SerializedWindow = { label: string; usedPercent: number; resetsAt?: string };
export type SerializedUsage = { source?: LiveUsage['source']; provider: ProviderId; title: string; plan?: string; subtitle?: string; windows: SerializedWindow[];
  resetCredits?: { availableCount: number; earliestExpiresAt?: number; totalCount?: number }; details?: string[]; fetchedAt: string };

export type AccountProblemView = {
  /** Which check failed. */
  check: 'keepAlive' | 'usage';
  raw: string;
  /** A few words, such as "Insufficient credits"; the vendor's own text when not recognized. */
  label: string;
  advice?: string;
  known: boolean;
};

export type ProfileView = {
  id: string;
  name: string;
  email?: string;
  accountId?: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  /** 1-based position in the saved list. */
  number: number;
  /** Persistent account CLI home, when initialized. Independent of list position. */
  home?: string;
  usage?: SerializedUsage;
  checkedAt?: string;
  lastKeepAliveAt?: string;
  problems: AccountProblemView[];
  /** Nothing left in any counted window (`readOnly`), or only a model-scoped weekly window is used up (`dimmed`). */
  limit: { readOnly: boolean; dimmed: boolean };
  /** The login error of the last check, when it was one; such a profile is re-checked instead of activated. */
  loginProblem?: string;
  /** Whether the service holds the profile's login at all. */
  hasCredential: boolean;
  /** The project folder a project profile lives in; a private profile has none. */
  folder?: string;
};

export type ProviderView = {
  provider: AuthProvider;
  title: string;
  profiles: ProfileView[];
  activeProfileId?: string;
  /** 1-based position of the active profile; absent when the native login belongs to no saved profile. */
  activeNumber?: number;
  /** The native login was not saved as a profile. */
  nativeUnsaved: boolean;
  /** The active account is being checked right now (its tokens may be refreshed meanwhile). */
  checkingActive: boolean;
  keepAlive: boolean;
  autoRotate: boolean;
  strategySummary: string;
  /** Where a new profile may be kept: privately, and in which of the declared project folders. */
  scopes: { privateEnabled: boolean; projectEnabled: boolean; folders: string[] };
};

export type ServiceInfo = {
  version: string;
  pid: number;
  startedAt: string;
  home: string;
  node: string;
  socket: string;
  clients: number;
  /** Where the private profiles are: `service` (profiles.json in the home) or `vscode` (a VS Code window's storage). */
  profileStore?: 'service' | 'vscode';
  lifecycle?: LifecycleState;
  host?: 'embedded' | 'daemon';
  mode?: 'embedded' | 'background';
  instanceId?: string;
  protocol?: number;
  capabilities?: readonly string[];
  configRevision?: number;
};

export type Snapshot = {
  service: ServiceInfo;
  providers: Record<AuthProvider, ProviderView>;
  config: ServiceConfig;
  configRevision?: number;
};

export type ActivationResult = {
  profile: { id: string; name: string; email?: string };
  verification?: ActivationVerification;
  /** `info` for a clean switch, `warning` when unconfirmed, `error` when the vendor reports another login. */
  level: 'info' | 'warning' | 'error';
  message: string;
  /** Whether running processes now see another account than before. */
  accountChanged: boolean;
};

export type SaveNativeResult =
  | { status: 'saved' | 'updated'; profile: { id: string; name: string; email?: string } }
  /** The login is already saved as `twin`; call again with `allowDuplicate` to save a copy anyway. */
  | { status: 'duplicate'; twin: { id: string; name: string }; warning: string };

export type ImportPlanView = {
  provider: AuthProvider;
  id: string;
  name: string;
  email?: string;
  kind: ImportKind;
  target?: { id: string; name: string };
  /** Short description of what importing the entry does, for a list. */
  outcome: string;
  /** Whether a plain import selects it: new profiles and restored logins. */
  suggested: boolean;
};

export type ImportSummary = { imported: number; counts: Record<ImportKind, number>; summary: string };

export type ExportResult = { entries: ExportedProfile[]; missing: string[]; text: string };

export type CliPreparation = {
  cli: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

export type SignInPreparation = CliPreparation & {
  /** Where the vendor CLI writes the login inside the isolated home. */
  file: string;
};

export type SignInResult =
  | { status: 'replaced'; active: boolean; identity: { email?: string; accountId?: string }; message: string }
  /** The sign-in belongs to another account than the profile holds; call again with `allowOtherAccount`. */
  | { status: 'otherAccount'; identity: { email?: string; accountId?: string }; message: string };

export type ResetConfirmation = { id: string; accountId: string; accountName: string; availableCredits: number; plannedCredits: number; windows: SerializedWindow[]; reason: string; expiresAt: number };
export type ResetResolution = { status: 'cancelled' | 'stale' | 'completed'; reason?: string };

export type ServiceEvent =
  | { event: 'statusChanged'; cursor: StatusCursor }
  | { event: 'resetConfirmation'; decision: ResetConfirmation }
  | { event: 'activated'; provider: AuthProvider; id: string; name: string; email?: string; automatic: boolean; accountChanged: boolean; level: 'info' | 'warning' | 'error'; message: string }
  | { event: 'accountProblem'; provider: AuthProvider; id: string; name: string; email?: string; reason: string; readable: string; revoked: boolean }
  | { event: 'noCandidate'; provider: AuthProvider; detail: string }
  | { event: 'notice'; level: 'info' | 'warning' | 'error'; message: string; provider?: AuthProvider }
  | { event: 'usageChanged'; provider: ProviderId }
  | { event: 'stateChanged'; provider?: AuthProvider }
  | { event: 'configChanged'; config: ServiceConfig; revision?: number; changed?: string[]; source?: string }
  | { event: 'lifecycle'; state: LifecycleState; reason?: string }
  /** A check requested with `token` waits for a running sweep of the service to finish. */
  | { event: 'waiting'; provider: AuthProvider; token?: string }
  /** A keep-alive sweep requested with `token` is about to check account `index` of `total`. */
  | { event: 'keepAliveProgress'; provider: AuthProvider; token?: string; index: number; total: number; id: string; name: string }
  | { event: 'log'; line: string };

export type EventName = ServiceEvent['event'];

export type HelloParams = { token: string; client: string; version?: string; protocolVersion?: number; requiredCapabilities?: string[]; subscribe?: EventName[] | 'all';
  /** Project folders open at the client, whose profile files the service lists while the client is connected. */
  folders?: string[] };
export type HelloResult = { ok: true; service: ServiceInfo; protocolVersion?: number; capabilities?: string[] };

export type KeepAliveResult = { usage?: SerializedUsage; keepAliveError?: string; usageError?: string };

/** What a check requested by hand does about a sweep that is running: wait for it, and stop on `automation.cancel` with the token. */
export type CheckWait = { waitMs?: number; token?: string };

/** `automation.keepAliveAll`: one keep-alive sweep over several accounts under one lock. */
export type KeepAliveAllResult = {
  results: Array<{ id: string; name: string; error?: string } & KeepAliveResult>;
  /** Accounts the sweep got to; the rest were not sent. */
  done: number;
  total: number;
  /** Why the sweep stopped early, when it did not finish or start: a sign-in, or a check still running after the wait. */
  blocked?: string;
  cancelled: boolean;
};

/** `history.info`: where the usage history is and how much of it there is. */
export type HistoryInfo = { enabled: boolean; location: string; retentionDays: number; files: string[]; oldestAt?: string };

/** `history.summary`: the period summarized as a Markdown document, with the figures behind it. */
export type HistorySummaryResult = { markdown: string; since: string; until: string; label: string; summary: unknown };

export type HistoryExportKind = 'readings' | 'events' | 'jsonl';

/** `usage.read`: a fresh reading of one profile, without a keep-alive prompt. */
export type UsageReadResult = KeepAliveResult & { profile: { id: string; name: string; email?: string } };

export function serializeKeepAlive(result: KeepAliveNowResult): KeepAliveResult {
  return {
    usage: result.usage ? { ...result.usage, fetchedAt: result.usage.fetchedAt.toISOString(),
      windows: result.usage.windows.map((window) => ({ label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt?.toISOString() })) } : undefined,
    keepAliveError: result.keepAliveError,
    usageError: result.usageError
  };
}
