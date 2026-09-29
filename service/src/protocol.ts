import type { AuthProvider } from './authFiles';
import type { ActivationVerification } from './profileStore';
import type { ServiceConfig } from './configStore';
import type { ExportedProfile, ImportKind } from './profileTransfer';
import type { KeepAliveNowResult } from './accountAutomation';
import type { ProviderId } from './live';

/**
 * What travels between the service and its clients (the VS Code extension and the `ai-usage` command): plain JSON
 * with ISO dates. Requests are `{ id, method, params }`, answers `{ id, result }` or `{ id, error }`, and the
 * service pushes `{ event, data }` messages to subscribed clients.
 */

export type SerializedWindow = { label: string; usedPercent: number; resetsAt?: string };
export type SerializedUsage = { provider: ProviderId; title: string; plan?: string; subtitle?: string; windows: SerializedWindow[]; details?: string[]; fetchedAt: string };

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
};

export type ServiceInfo = {
  version: string;
  pid: number;
  startedAt: string;
  home: string;
  node: string;
  socket: string;
  clients: number;
};

export type Snapshot = {
  service: ServiceInfo;
  providers: Record<AuthProvider, ProviderView>;
  config: ServiceConfig;
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

export type SignInPreparation = {
  cli: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Where the vendor CLI writes the login inside the isolated home. */
  file: string;
};

export type SignInResult =
  | { status: 'replaced'; active: boolean; identity: { email?: string; accountId?: string }; message: string }
  /** The sign-in belongs to another account than the profile holds; call again with `allowOtherAccount`. */
  | { status: 'otherAccount'; identity: { email?: string; accountId?: string }; message: string };

export type ServiceEvent =
  | { event: 'activated'; provider: AuthProvider; id: string; name: string; email?: string; automatic: boolean; accountChanged: boolean; level: 'info' | 'warning' | 'error'; message: string }
  | { event: 'accountProblem'; provider: AuthProvider; id: string; name: string; email?: string; reason: string; readable: string; revoked: boolean }
  | { event: 'noCandidate'; provider: AuthProvider; detail: string }
  | { event: 'notice'; level: 'info' | 'warning' | 'error'; message: string; provider?: AuthProvider }
  | { event: 'stateChanged'; provider?: AuthProvider }
  | { event: 'configChanged'; config: ServiceConfig }
  | { event: 'log'; line: string };

export type EventName = ServiceEvent['event'];

export type HelloParams = { token: string; client: string; version?: string; subscribe?: EventName[] | 'all' };
export type HelloResult = { ok: true; service: ServiceInfo };

export type KeepAliveResult = { usage?: SerializedUsage; keepAliveError?: string; usageError?: string };

export function serializeKeepAlive(result: KeepAliveNowResult): KeepAliveResult {
  return {
    usage: result.usage ? { ...result.usage, fetchedAt: result.usage.fetchedAt.toISOString(),
      windows: result.usage.windows.map((window) => ({ label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt?.toISOString() })) } : undefined,
    keepAliveError: result.keepAliveError,
    usageError: result.usageError
  };
}
