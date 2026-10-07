import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import {
  AuthProvider,
  StoredCredential,
  isSameCredentialOwner,
  nativeCredentialPath,
  parseCredentialJson,
  readNativeCredential,
  writeNativeCredential,
  writeTextAtomically
} from './authFiles';
import { claudeAccountFile, CredentialIdentity, resolveCredentialIdentity } from './accountIdentity';
import { explainAccountProblem } from './accountProbe';
import { openAiUsageSettings } from './settingsLink';
import { ExportedProfile, ImportKind, ImportPlan, parseProfileExport, planImport, serializeProfileExport, uniqueName } from './profileTransfer';
import type { ProfileLimitState } from './accountAutomation';

const STATE_KEY = 'aiUsage.authProfiles.v1';
const AUTOMATION_STATE_KEY = 'aiUsage.accountAutomation.v1';
const SECRET_PREFIX = 'aiUsage.authProfile.v1';
const MAX_PROFILES = 20;
const PROVIDERS: AuthProvider[] = ['claude', 'codex'];
/** Default path of a project's profile file, inside the workspace folder; `aiUsage.projectProfiles.file` changes it. */
export const DEFAULT_PROJECT_PROFILES_FILE = '.ai-usage.profiles.json';

export type ProfileMetadata = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Login email behind the credential, shown beside the name so duplicate accounts are visible. */
  email?: string;
  /** Stable vendor account id; Claude Team members can share an organization but never this id. */
  accountId?: string;
  /** The workspace folder a project profile lives in; a private profile has none. Never stored in global state. */
  folder?: string;
};

/** Menu description: the account email, the project for a project profile, a duplicate marker, then the active marker. */
function profileDescription(profile: ProfileMetadata, active: boolean, siblings: ProfileMetadata[] = []): string | undefined {
  const twin = profile.email ? siblings.find((other) => other.id !== profile.id && other.email === profile.email) : undefined;
  return [profile.email, profile.folder ? `project ${path.basename(profile.folder)}` : undefined,
    twin ? `duplicate of “${twin.name}”` : undefined, active ? 'Active' : undefined].filter(Boolean).join(' · ') || undefined;
}

/** A project entry as the file and the merged list both see it, so an unchanged file is not written again. */
function projectEntryKey(entry: ExportedProfile): string {
  return JSON.stringify([entry.provider, entry.id, entry.name, entry.createdAt, entry.updatedAt, entry.email, entry.accountId, entry.credential]);
}

/**
 * Two saved copies of one login are dangerous, not just untidy: both vendors rotate the refresh token on every
 * refresh, and refreshing the second copy reuses a rotated token, which revokes the whole login server-side.
 */
function duplicateWarning(provider: AuthProvider, twin: ProfileMetadata): string {
  return `This ${TITLES[provider]} login is already saved as “${twin.name}”. Two saved copies of one account refresh independently and get the account's tokens revoked; keep a single profile per login.`;
}

type ProviderState = {
  profiles: ProfileMetadata[];
  activeProfileId?: string;
};

type ProfileState = Record<AuthProvider, ProviderState>;
export type AccountAutomationFeature = 'keepAlive' | 'autoRotate';
type AutomationState = Record<AuthProvider, Record<AccountAutomationFeature, boolean>>;

/** Both switches are ordinary settings, so a profile, Settings Sync or a policy can carry them. */
function automationKey(provider: AuthProvider, feature: AccountAutomationFeature): string {
  return `aiUsage.${provider}.${feature}.enabled`;
}

type ProfileItem = vscode.QuickPickItem & {
  profile?: ProfileMetadata;
  /** Set when the profile has nothing left in any window; selecting it is a no-op warning, not an activation. */
  readOnly?: boolean;
  /** The login error of the profile's last check; selecting it offers to renew the login, check it again or activate it anyway. */
  loginProblem?: string;
  action?: 'save' | 'import' | 'transfer' | 'signIn' | 'rename' | 'reorder' | 'delete' | 'keepAliveNow' | 'settings' | 'serviceSettings' | 'back';
};

/**
 * What the `afterActivate` hook is reacting to. Only a real account change invalidates already-running vendor
 * processes, so re-saving or re-selecting the login that is already active must not be reported as a switch.
 */
export type ActivationChange = { kind: 'activated' | 'saved'; accountChanged: boolean };

type ProfileHooks = {
  beforeActivate?: (provider: AuthProvider) => Promise<void>;
  afterActivate?: (provider: AuthProvider, change: ActivationChange) => Promise<void>;
  /** One chosen account, or every saved account in order when "All accounts" was picked. */
  sendKeepAlive?: (provider: AuthProvider, profiles: ProfileMetadata[]) => Promise<void>;
  /** Signs in again for a saved profile with the vendor CLI and stores the new login in it. */
  signIn?: (provider: AuthProvider, profile: ProfileMetadata) => Promise<void>;
  /** Where the menu's Back item leads, the AI Usage menu of every service; no Back item without it. */
  back?: (provider: AuthProvider) => Promise<void>;
};

const TITLES: Record<AuthProvider, string> = { claude: 'Claude', codex: 'Codex' };

/** Outcome of checking, after the native file was written, which login the vendor tool now reports. */
export type ActivationVerification = {
  status: 'match' | 'mismatch' | 'unverified';
  detail: string;
  email?: string;
  accountId?: string;
};
/** `expected` is what the saved profile claims to hold, so a verifier can fall back to it when the vendor is silent. */
export type ActivationVerifier = (provider: AuthProvider, credential: StoredCredential, expected: CredentialIdentity) => Promise<ActivationVerification | undefined>;

/**
 * A running Codex process keeps its login in memory, so without the account proxy the Codex extension needs an
 * extension-host restart; with the proxy, every chat routed through it uses the new login from its next turn.
 */
function activationMessage(provider: AuthProvider, name: string, automatic: boolean, codexChatsFollow: boolean): string {
  if (provider === 'codex') {
    const followUp = codexChatsFollow
      ? 'Codex chats and new CLI sessions use it from their next turn.'
      : 'New Codex CLI sessions use it now; the Codex extension needs an extension restart.';
    return automatic ? `AI Usage: Codex automatically rotated to account “${name}”. ${followUp}` : `Codex switched to “${name}”. ${followUp}`;
  }
  // Claude Code reads its credential file per turn, so open chats and CLI sessions adopt a switch without a restart
  // (verified 2026-09-18 against 2.1.276: a chat started before the switch reported the new account 15s after it).
  return automatic
    ? `AI Usage: Claude automatically rotated to account “${name}”. Chats and CLI sessions use it from their next turn.`
    : `Claude switched to “${name}”. Chats and CLI sessions use it from their next turn.`;
}

function emptyState(): ProfileState {
  return { claude: { profiles: [] }, codex: { profiles: [] } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** What importing an entry would do, for its row in the import picker. */
function importOutcome(plan: ImportPlan<ProfileMetadata>): string {
  const renamed = plan.target && plan.target.name !== plan.entry.name;
  switch (plan.kind) {
    case 'new': return 'new profile';
    case 'restore': return `restores the missing login${renamed ? ` of “${plan.target!.name}”` : ''}`;
    case 'replace': return `replaces the saved login${renamed ? ` of “${plan.target!.name}”` : ''}`;
    case 'same': return `already saved${renamed ? ` as “${plan.target!.name}”` : ''}`;
  }
}

function validName(value: string): string | undefined {
  const name = value.trim();
  if (!name) {
    return 'Enter a profile name.';
  }
  if (name.length > 60) {
    return 'Use 60 characters or fewer.';
  }
  return undefined;
}

/** Stable account id of a native login, read locally: Codex's token field, Claude's account file. */
function nativeAccountId(provider: AuthProvider, native: StoredCredential): string | undefined {
  if (provider === 'codex') {
    const tokens = native.tokens;
    const id = typeof tokens === 'object' && tokens !== null ? (tokens as Record<string, unknown>).account_id : undefined;
    return typeof id === 'string' && id ? id : undefined;
  }
  try {
    const account = JSON.parse(fs.readFileSync(claudeAccountFile(), 'utf8'))?.oauthAccount;
    return typeof account?.accountUuid === 'string' && account.accountUuid ? account.accountUuid : undefined;
  } catch {
    return undefined;
  }
}

export class AuthProfileManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    private readonly usageDetail?: (provider: AuthProvider, id: string) => string | undefined,
    private readonly verifyActivation?: ActivationVerifier,
    private readonly identityOf: (provider: AuthProvider, credential: StoredCredential) => Promise<CredentialIdentity> = resolveCredentialIdentity
  ) {}

  /** The native login `followNative` last looked at, per provider, so an unchanged file is not checked again. */
  private nativeChecked: Partial<Record<AuthProvider, string>> = {};
  /** Whether that native login belongs to no saved profile. */
  private nativeUnsaved: Partial<Record<AuthProvider, boolean>> = {};

  /** Set by extension.ts: true while the Codex account proxy routes Codex chats, so a switch needs no restart. */
  codexChatsFollowSwitch: () => boolean = () => false;

  /** Set by extension.ts: a profile's usage limit state, so the accounts list can block or dim exhausted ones. */
  limitState: (provider: AuthProvider, id: string) => ProfileLimitState | undefined = () => undefined;

  /** Set by extension.ts: the login error of a profile's last check, so the list marks it and re-checks it on click. */
  loginProblem: (provider: AuthProvider, id: string) => string | undefined = () => undefined;

  /**
   * Set by extension.ts: told after the active profile changed, by an activation here (by hand, or `automatic` by
   * rotation) or by following a switch made outside this window (`external`: another window or the vendor CLI).
   */
  onActivated?: (provider: AuthProvider, change: { previous?: ProfileMetadata; profile: ProfileMetadata; automatic: boolean; external: boolean }) => void;

  /** Each project profile file as last read, by path, so an unchanged file is neither parsed nor written again. */
  private readonly projectFiles = new Map<string, { mtimeMs: number; entries: ExportedProfile[]; error?: string }>();
  /** The folder of every listed project profile and its login, by `provider:id`; rebuilt whenever the files are read. */
  private readonly projectFolderOf = new Map<string, string>();
  private readonly projectCredentials = new Map<string, StoredCredential>();

  private key(provider: AuthProvider, id: string): string { return `${provider}:${id}`; }

  /** The configured project profile path, relative to each workspace folder; an absolute path is used as it is. */
  private projectFileName(): string {
    const configured = vscode.workspace.getConfiguration().get<string>('aiUsage.projectProfiles.file', DEFAULT_PROJECT_PROFILES_FILE);
    return (typeof configured === 'string' && configured.trim()) || DEFAULT_PROJECT_PROFILES_FILE;
  }

  private projectFile(folder: string): string { return path.resolve(folder, this.projectFileName()); }

  /** The open workspace folders that may hold project profiles: local folders, while project profiles are enabled. */
  private projectFolders(): string[] {
    if (!vscode.workspace.getConfiguration().get<boolean>('aiUsage.projectProfiles.enabled', true)) { return []; }
    return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);
  }

  /**
   * Reads every open folder's profile file, once per change of the file, and rebuilds the index of project profiles
   * from them. The profiles of every folder open in the window are merged into one list: the extension is one per
   * window, so a project can be used with another open project's profiles; that is a known limitation.
   */
  private loadProjectProfiles(): Record<AuthProvider, ProfileMetadata[]> {
    const loaded: Record<AuthProvider, ProfileMetadata[]> = { claude: [], codex: [] };
    this.projectFolderOf.clear();
    this.projectCredentials.clear();
    for (const folder of this.projectFolders()) {
      const file = this.projectFile(folder);
      let mtimeMs: number;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { this.projectFiles.delete(file); continue; }
      let cached = this.projectFiles.get(file);
      if (!cached || cached.mtimeMs !== mtimeMs) {
        try {
          cached = { mtimeMs, entries: parseProfileExport(fs.readFileSync(file, 'utf8')) };
        } catch (error) {
          cached = { mtimeMs, entries: [], error: errorMessage(error) };
          this.log(`project profiles in ${file} were not loaded: ${cached.error}`);
        }
        this.projectFiles.set(file, cached);
      }
      for (const entry of cached.entries) {
        const key = this.key(entry.provider, entry.id);
        // A profile listed in two folders is taken from the first one.
        if (this.projectFolderOf.has(key)) { continue; }
        this.projectFolderOf.set(key, folder);
        this.projectCredentials.set(key, entry.credential);
        loaded[entry.provider].push({ id: entry.id, name: entry.name, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
          ...(entry.email ? { email: entry.email } : {}), ...(entry.accountId ? { accountId: entry.accountId } : {}), folder });
      }
    }
    return loaded;
  }

  /** Writes a folder's project profiles, unless the file already holds exactly them or could not be read. */
  private writeProjectFile(folder: string, entries: ExportedProfile[], force = false): void {
    const file = this.projectFile(folder);
    const cached = this.projectFiles.get(file);
    // A file that could not be read is never overwritten: the user has to fix or remove it.
    if (cached?.error) { return; }
    if (!force && cached && cached.entries.length === entries.length &&
      cached.entries.every((entry, index) => projectEntryKey(entry) === projectEntryKey(entries[index]))) { return; }
    writeTextAtomically(file, serializeProfileExport(entries));
    this.projectFiles.set(file, { mtimeMs: fs.statSync(file).mtimeMs, entries });
    this.log(`wrote ${entries.length} project profiles to ${file}`);
    if (!cached) { this.ignoreInGit(folder); }
  }

  /** Project profiles hold login tokens in plain text; a Git repository must not commit them. */
  private ignoreInGit(folder: string): void {
    if (!fs.existsSync(path.join(folder, '.git'))) { return; }
    const relative = path.relative(folder, this.projectFile(folder)).split(path.sep).join('/');
    // A file outside the folder is not the repository's to ignore.
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { return; }
    const ignoreFile = path.join(folder, '.gitignore');
    let text = '';
    try { text = fs.readFileSync(ignoreFile, 'utf8'); } catch { /* No .gitignore yet. */ }
    // The file itself, or any directory above it, may be ignored already.
    const covered = new Set<string>();
    const parts = relative.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const candidate = parts.slice(0, depth).join('/');
      for (const form of depth < parts.length ? [candidate, `${candidate}/`] : [candidate]) { covered.add(form); covered.add(`/${form}`); }
    }
    if (text.split(/\r?\n/).some((line) => covered.has(line.trim()))) { return; }
    fs.appendFileSync(ignoreFile, `${text && !text.endsWith('\n') ? '\n' : ''}# AI Usage project profiles hold login tokens\n${relative}\n`);
    this.log(`added ${relative} to ${ignoreFile}`);
    void vscode.window.showInformationMessage(
      `AI Usage: added ${relative} to ${path.basename(folder)}/.gitignore, because project profiles hold login tokens in plain text.`);
  }

  /**
   * Where a new profile is kept: private, in this VS Code client's SecretStorage, or in an open project's folder.
   * Asked only when both kinds are enabled and a local folder is open; otherwise the only possible kind is used.
   * Undefined when cancelled.
   */
  async pickScope(): Promise<{ folder?: string } | undefined> {
    const privateEnabled = vscode.workspace.getConfiguration().get<boolean>('aiUsage.privateProfiles.enabled', true);
    const folders = this.projectFolders();
    if (!folders.length) { return {}; }
    if (!privateEnabled && folders.length === 1) { return { folder: folders[0] }; }
    const items: Array<vscode.QuickPickItem & { folder?: string }> = [];
    if (privateEnabled) {
      items.push({ label: '$(account) Private profile', detail: 'Kept in this VS Code client\'s SecretStorage and listed in every window, as before.' });
    }
    items.push(...folders.map((folder) => ({
      label: `$(root-folder) Project profile${folders.length > 1 ? ` in ${path.basename(folder)}` : ''}`,
      detail: `Kept, login included, in ${this.projectFile(folder)} and listed whenever that folder is open.`,
      folder
    })));
    const picked = await vscode.window.showQuickPick(items, { title: 'AI Usage · Where to keep the profile', placeHolder: 'Private, or in a project folder' });
    return picked ? { folder: picked.folder } : undefined;
  }

  profiles(provider: AuthProvider): ProfileMetadata[] {
    return this.state()[provider].profiles;
  }

  profile(provider: AuthProvider, id: string): ProfileMetadata | undefined {
    return this.profiles(provider).find((profile) => profile.id === id);
  }

  /** Which login a credential belongs to; empty when the vendor cannot be asked. */
  async identity(provider: AuthProvider, credential: StoredCredential): Promise<CredentialIdentity> {
    try { return await this.identityOf(provider, credential); } catch { return {}; }
  }

  /**
   * Stores a fresh sign-in for an existing profile, for example after its tokens were revoked. When the profile is
   * active its native login is dead too, so the new one replaces it there as well. Returns whether it was active.
   */
  async replaceCredential(provider: AuthProvider, id: string, credential: StoredCredential): Promise<boolean> {
    const profile = this.profile(provider, id);
    if (!profile) { throw new Error('The profile no longer exists.'); }
    const active = this.activeProfileId(provider) === id;
    if (active) { writeNativeCredential(provider, credential); }
    await this.storeSecret(provider, id, credential);
    const state = this.state();
    const target = state[provider].profiles.find((candidate) => candidate.id === id);
    if (target) {
      target.updatedAt = new Date().toISOString();
      await this.updateState(state);
    }
    await this.recordIdentity(provider, id, credential);
    this.log(`${provider}: replaced the login of profile "${profile.name}" with a new sign-in${active ? ' (active)' : ''}`);
    return active;
  }

  async credential(provider: AuthProvider, id: string): Promise<StoredCredential | undefined> {
    if (!this.profiles(provider).some((profile) => profile.id === id)) { return undefined; }
    if (this.activeProfileId(provider) === id) { await this.syncActiveProfile(provider); }
    return this.readSecret(provider, id);
  }

  /** Only write back if neither another window nor a manual switch replaced these tokens. */
  async refreshedCredential(provider: AuthProvider, id: string, before: StoredCredential, after: StoredCredential): Promise<void> {
    if (JSON.stringify(before) === JSON.stringify(after)) { return; }
    if (!this.profiles(provider).some((profile) => profile.id === id)) { return; }
    const stored = await this.readSecret(provider, id);
    if (JSON.stringify(stored) !== JSON.stringify(before)) { return; }
    if (this.activeProfileId(provider) === id) {
      try {
        if (JSON.stringify(readNativeCredential(provider)) !== JSON.stringify(before)) { return; }
        writeNativeCredential(provider, after);
      } catch { return; /* Native login may have been removed externally. */ }
    }
    await this.storeSecret(provider, id, after);
    await this.recordIdentity(provider, id, after);
  }

  /** Stores stable identity beside the profile so same-organization Claude users remain distinct. */
  private async recordIdentity(provider: AuthProvider, id: string, credential: StoredCredential): Promise<void> {
    let identity: CredentialIdentity;
    try { identity = await this.identityOf(provider, credential); } catch { return; }
    if (!identity.email && !identity.accountId) { return; }
    const state = this.state();
    const profile = state[provider].profiles.find((candidate) => candidate.id === id);
    if (!profile || (profile.email === identity.email && profile.accountId === identity.accountId)) { return; }
    if (identity.email) { profile.email = identity.email; }
    if (identity.accountId) { profile.accountId = identity.accountId; }
    await this.updateState(state);
  }

  /** Resolves identities for saved profiles that predate account UUID tracking. */
  private async backfillEmails(provider: AuthProvider): Promise<void> {
    const missing = this.state()[provider].profiles.filter((profile) => !profile.email || (provider === 'claude' && !profile.accountId));
    // Each update reads and replaces globalState, so serialize them to avoid one profile erasing another's result.
    for (const profile of missing) {
      const credential = await this.readSecret(provider, profile.id);
      if (credential) { await this.recordIdentity(provider, profile.id, credential); }
    }
  }

  async matchesNative(provider: AuthProvider, id: string): Promise<boolean> {
    const profile = this.profiles(provider).find((candidate) => candidate.id === id);
    const stored = await this.readSecret(provider, id);
    try { return Boolean(profile && stored && await this.sameCredentialOwner(provider, profile, stored, readNativeCredential(provider))); }
    catch { return false; }
  }

  async activateProfile(provider: AuthProvider, id: string, automatic = false): Promise<boolean> {
    const profile = this.profiles(provider).find((candidate) => candidate.id === id);
    return profile ? this.activate(provider, profile, automatic) : false;
  }

  automationEnabled(provider: AuthProvider, feature: AccountAutomationFeature): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(automationKey(provider, feature), false);
  }

  async setAutomationEnabled(provider: AuthProvider, feature: AccountAutomationFeature, enabled: boolean): Promise<void> {
    await vscode.workspace.getConfiguration().update(automationKey(provider, feature), enabled, vscode.ConfigurationTarget.Global);
    this.log(`${provider}: ${feature === 'keepAlive' ? 'account keep-alive' : 'automatic account rotation'} ${enabled ? 'enabled' : 'disabled'}`);
  }

  /** Both switches used to be menu toggles kept in extension state; carry those over to the settings once. */
  async migrateAutomationSettings(): Promise<void> {
    const stored = this.context.globalState.get<Partial<AutomationState>>(AUTOMATION_STATE_KEY);
    if (!stored) {
      return;
    }
    for (const provider of ['claude', 'codex'] as const) {
      for (const feature of ['keepAlive', 'autoRotate'] as const) {
        const key = automationKey(provider, feature);
        const configured = vscode.workspace.getConfiguration().inspect<boolean>(key);
        const set = configured?.globalValue ?? configured?.workspaceValue ?? configured?.workspaceFolderValue;
        // Only a switch someone turned on is worth carrying: off is the setting's own default.
        if (stored[provider]?.[feature] === true && set === undefined) {
          await this.setAutomationEnabled(provider, feature, true);
          this.log(`${provider}: moved ${feature} from extension state to ${key}`);
        }
      }
    }
    await this.context.globalState.update(AUTOMATION_STATE_KEY, undefined);
  }

  activeProfileId(provider: AuthProvider): string | undefined {
    return this.state()[provider].activeProfileId;
  }

  /**
   * Makes the active profile the one that owns the native login, when that changed outside this window (another
   * window's switch or rotation, or a sign-in with the vendor CLI). Only local data is used: a matching token, then
   * the account id (Codex `tokens.account_id`, Claude's `oauthAccount.accountUuid` in its account file). When no
   * saved profile owns the native login, the active profile is kept but not numbered in the status bar.
   */
  async followNative(provider: AuthProvider): Promise<void> {
    let native: StoredCredential;
    try { native = readNativeCredential(provider); } catch { return; }
    const nativeKey = JSON.stringify(native);
    if (this.nativeChecked[provider] === nativeKey) { return; }
    const state = this.state();
    const providerState = state[provider];
    const owners: ProfileMetadata[] = [];
    for (const profile of providerState.profiles) {
      const stored = await this.readSecret(provider, profile.id);
      if (stored && isSameCredentialOwner(provider, stored, native)) { owners.push(profile); }
    }
    if (!owners.length) {
      const accountId = nativeAccountId(provider, native);
      if (accountId) { owners.push(...providerState.profiles.filter((profile) => profile.accountId === accountId)); }
    }
    const owner = owners.length === 1 ? owners[0] : owners.find((profile) => profile.id === providerState.activeProfileId);
    if (!owner) {
      if (!this.nativeUnsaved[provider]) {
        this.log(`${provider}: the native login is not one of the saved profiles; the status bar shows no profile number until it is`);
      }
    } else if (owner.id !== providerState.activeProfileId) {
      const previous = providerState.profiles.find((profile) => profile.id === providerState.activeProfileId);
      providerState.activeProfileId = owner.id;
      await this.updateState(state);
      this.log(`${provider}: the native login was switched outside this window to profile "${owner.name}"${previous ? ` (was "${previous.name}")` : ''}; following it`);
      this.onActivated?.(provider, { previous, profile: owner, automatic: false, external: true });
    }
    // Set after updateState, which forgets the last check.
    this.nativeChecked[provider] = nativeKey;
    this.nativeUnsaved[provider] = !owner;
  }

  /** 1-based position of the active profile in the saved list, as the Accounts menu orders it. */
  activeProfileNumber(provider: AuthProvider): number | undefined {
    if (this.nativeUnsaved[provider]) { return undefined; }
    const { profiles, activeProfileId } = this.state()[provider];
    const index = profiles.findIndex((profile) => profile.id === activeProfileId);
    return index < 0 ? undefined : index + 1;
  }

  /** Number of saved profiles for the provider. */
  profileCount(provider: AuthProvider): number {
    return this.state()[provider].profiles.length;
  }

  activeProfileName(provider: AuthProvider): string | undefined {
    const providerState = this.state()[provider];
    return providerState.profiles.find((profile) => profile.id === providerState.activeProfileId)?.name;
  }

  /** What the active profile claims to hold, used to correct vendor metadata when the vendor cannot be asked. */
  activeIdentity(provider: AuthProvider): CredentialIdentity {
    const providerState = this.state()[provider];
    const active = providerState.profiles.find((profile) => profile.id === providerState.activeProfileId);
    return { email: active?.email, accountId: active?.accountId };
  }

  /** A non-secret cache suffix prevents usage from one account appearing after switching to another. */
  cacheDiscriminator(provider: AuthProvider): string | undefined {
    const id = this.activeProfileId(provider);
    return id ? `auth-profile:${id}` : undefined;
  }

  async show(
    initialProvider?: AuthProvider,
    hooks?: ProfileHooks
  ): Promise<void> {
    const provider = initialProvider ?? await this.pickProvider();
    if (!provider) {
      return;
    }

    await this.backfillEmails(provider);
    await this.followNative(provider);
    // Management actions return to the list. Choosing a profile activates it and closes the menu.
    while (true) {
      const item = await vscode.window.showQuickPick(this.items(provider, Boolean(hooks?.back)), {
        title: `AI Usage · ${TITLES[provider]} accounts`,
        placeHolder: 'Choose a profile to activate, or manage saved profiles',
        matchOnDescription: true,
        matchOnDetail: true
      });
      if (!item) {
        return;
      }
      try {
        if (item.profile) {
          if (item.readOnly) {
            void vscode.window.showWarningMessage(`“${item.profile.name}” is at its usage limit and can't be activated until it resets.`);
            continue;
          }
          if (item.loginProblem) {
            // A login whose last check failed to authenticate is not activated right away; the user chooses between
            // renewing it with a new sign-in, checking it again with a keep-alive, which refreshes an expired
            // token, and activating it as it is.
            const choice = await this.loginProblemMenu(provider, item.profile, item.loginProblem);
            if (choice === 'renew') { await hooks?.signIn?.(provider, item.profile); continue; }
            if (choice === 'keepAlive') { await hooks?.sendKeepAlive?.(provider, [item.profile]); continue; }
            if (choice !== 'select') { continue; }
          }
          // Re-selecting the login that is already active and already written changes nothing for running processes.
          const unchanged = this.activeProfileId(provider) === item.profile.id && await this.matchesNative(provider, item.profile.id);
          await hooks?.beforeActivate?.(provider);
          if (await this.activate(provider, item.profile)) {
            await hooks?.afterActivate?.(provider, { kind: 'activated', accountChanged: !unchanged });
          }
          return;
        }
        if (item.action === 'back') {
          await hooks?.back?.(provider);
          return;
        }
        if (item.action === 'keepAliveNow') {
          const profiles = await this.pickKeepAliveTargets(provider);
          if (profiles.length) { await hooks?.sendKeepAlive?.(provider, profiles); }
        } else if (item.action === 'settings' || item.action === 'serviceSettings') {
          await openAiUsageSettings(`aiUsage.${provider}`);
          return;
        } else if (item.action === 'save') {
          // Saving copies the login that is already active into a profile; no process starts using a new account.
          if (await this.saveCurrent(provider)) {
            await hooks?.afterActivate?.(provider, { kind: 'saved', accountChanged: false });
          }
        } else if (item.action === 'import') {
          await this.importFile(provider);
        } else if (item.action === 'transfer') {
          await this.transferMenu(provider);
        } else if (item.action === 'signIn') {
          const profile = await this.pickSaved(provider, `Sign in again for a ${TITLES[provider]} profile`);
          if (profile) { await hooks?.signIn?.(provider, profile); }
        } else if (item.action === 'rename') {
          await this.rename(provider);
        } else if (item.action === 'reorder') {
          await this.reorder(provider);
        } else if (item.action === 'delete') {
          await this.delete(provider);
        }
      } catch (error) {
        this.log(`${provider}: authentication profile operation failed: ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(`AI Usage: authentication profile operation failed: ${errorMessage(error)}`);
      }
    }
  }

  /** The private profiles from global state, then the project profiles of every open folder. */
  private state(): ProfileState {
    const stored = this.context.globalState.get<Partial<ProfileState>>(STATE_KEY);
    const fallback = emptyState();
    const project = this.loadProjectProfiles();
    for (const provider of PROVIDERS) {
      const value = stored?.[provider];
      const own = value && Array.isArray(value.profiles)
        ? value.profiles.filter((profile) => profile && typeof profile.id === 'string' && typeof profile.name === 'string').slice(0, MAX_PROFILES)
        : [];
      const ids = new Set(own.map((profile) => profile.id));
      fallback[provider] = {
        profiles: [...own, ...project[provider].filter((profile) => !ids.has(profile.id))],
        activeProfileId: value && typeof value.activeProfileId === 'string' ? value.activeProfileId : undefined
      };
    }
    return fallback;
  }

  /** Private profiles go to global state; project profiles go back to their folders' files, logins included. */
  private async updateState(state: ProfileState): Promise<void> {
    const stored = emptyState();
    const perFolder = new Map<string, ExportedProfile[]>();
    for (const provider of PROVIDERS) {
      stored[provider] = { profiles: state[provider].profiles.filter((profile) => !profile.folder), activeProfileId: state[provider].activeProfileId };
      for (const profile of state[provider].profiles) {
        if (!profile.folder) { continue; }
        const credential = this.projectCredentials.get(this.key(provider, profile.id))
          ?? this.projectFiles.get(this.projectFile(profile.folder))?.entries.find((entry) => entry.provider === provider && entry.id === profile.id)?.credential;
        if (!credential) { continue; }
        const entries = perFolder.get(profile.folder) ?? [];
        entries.push({ provider, id: profile.id, name: profile.name, createdAt: profile.createdAt, updatedAt: profile.updatedAt,
          ...(profile.email ? { email: profile.email } : {}), ...(profile.accountId ? { accountId: profile.accountId } : {}), credential });
        perFolder.set(profile.folder, entries);
      }
    }
    await this.context.globalState.update(STATE_KEY, stored);
    // A folder whose file exists but has no profile left gets an empty list, so a deleted profile is gone from it.
    for (const folder of new Set([...perFolder.keys(), ...this.projectFolders()])) {
      const entries = perFolder.get(folder) ?? [];
      if (entries.length || this.projectFiles.has(this.projectFile(folder))) { this.writeProjectFile(folder, entries); }
    }
    // A saved, renamed or activated profile can change who owns the native login; check again next time.
    this.nativeChecked = {};
  }

  private secretKey(provider: AuthProvider, id: string): string {
    return `${SECRET_PREFIX}.${provider}.${id}`;
  }

  private async readSecret(provider: AuthProvider, id: string): Promise<StoredCredential | undefined> {
    if (this.projectFolderOf.has(this.key(provider, id))) { return this.projectCredentials.get(this.key(provider, id)); }
    const value = await this.context.secrets.get(this.secretKey(provider, id));
    if (!value) {
      return undefined;
    }
    try {
      return parseCredentialJson(provider, value);
    } catch {
      return undefined;
    }
  }

  private async storeSecret(provider: AuthProvider, id: string, credential: StoredCredential): Promise<void> {
    const folder = this.projectFolderOf.get(this.key(provider, id));
    if (folder) {
      // A project profile's login lives in its folder's file; the file is rewritten with the new one right away.
      this.projectCredentials.set(this.key(provider, id), credential);
      const entries = (this.projectFiles.get(this.projectFile(folder))?.entries ?? [])
        .map((entry) => entry.provider === provider && entry.id === id ? { ...entry, credential } : entry);
      this.writeProjectFile(folder, entries, true);
      return;
    }
    await this.context.secrets.store(this.secretKey(provider, id), JSON.stringify(credential));
  }

  private async pickProvider(): Promise<AuthProvider | undefined> {
    const picked = await vscode.window.showQuickPick([
      { label: '$(claude) Claude', description: `${this.state().claude.profiles.length}/${MAX_PROFILES} profiles`, provider: 'claude' as const },
      { label: '$(openai) Codex', description: `${this.state().codex.profiles.length}/${MAX_PROFILES} profiles`, provider: 'codex' as const }
    ], {
      title: 'AI Usage · Authentication profiles',
      placeHolder: 'Choose a service'
    });
    return picked?.provider;
  }

  private items(provider: AuthProvider, withBack = false): ProfileItem[] {
    const providerState = this.state()[provider];
    const items: ProfileItem[] = providerState.profiles.map((profile) => {
      const active = profile.id === providerState.activeProfileId;
      const limits = this.limitState(provider, profile.id);
      // An exhausted account cannot be activated anyway, so its login trouble waits until the window resets.
      const loginProblem = limits?.readOnly ? undefined : this.loginProblem(provider, profile.id);
      const icon = active ? 'check' : 'key';
      return {
        label: limits?.readOnly ? `$(circle-slash) ${profile.name}` : limits?.dimmed || loginProblem ? profile.name : `$(${icon}) ${profile.name}`,
        iconPath: loginProblem ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'))
          : limits?.dimmed ? new vscode.ThemeIcon(icon, new vscode.ThemeColor('disabledForeground')) : undefined,
        description: [profileDescription(profile, active, providerState.profiles),
          limits?.readOnly ? 'At its usage limit' : limits?.dimmed ? 'Fable limit reached' : undefined,
          loginProblem ? 'Login problem' : undefined].filter(Boolean).join(' · ') || undefined,
        detail: this.usageDetail?.(provider, profile.id) ?? `Saved ${new Date(profile.updatedAt).toLocaleString()} · Usage not checked yet`,
        profile,
        readOnly: limits?.readOnly,
        loginProblem
      };
    });
    if (!items.length) {
      items.push({ label: 'No profiles saved yet', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({ label: 'Manage', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: '$(save) Save current login…',
      detail: `Create a profile or replace an existing profile from ${nativeCredentialPath(provider)}.`,
      action: 'save'
    });
    items.push({
      label: '$(file-code) Import credential JSON…',
      detail: 'Imports a credential file into VS Code SecretStorage without activating it.',
      action: 'import'
    });
    items.push({
      label: '$(arrow-swap) Export or import saved profiles…',
      detail: 'Moves the saved Claude and Codex profiles, logins included, to or from another computer through a JSON file.',
      action: 'transfer'
    });
    if (providerState.profiles.length) {
      items.push({
        label: '$(sign-in) Sign in again…',
        detail: `Runs the ${TITLES[provider]} CLI login in a terminal with a separate home and stores the new login in a saved profile. The active login is replaced only when that profile is the active one.`,
        action: 'signIn'
      });
      items.push({ label: '$(edit) Rename a profile…', action: 'rename' });
      if (providerState.profiles.length > 1) {
        items.push({ label: '$(list-ordered) Move a profile up or down…', detail: 'Changes the order of the saved profiles in this menu and in rotation.', action: 'reorder' });
      }
      items.push({ label: '$(trash) Delete a saved profile…', action: 'delete' });
    }
    const keepAlive = this.automationEnabled(provider, 'keepAlive');
    const autoRotate = this.automationEnabled(provider, 'autoRotate');
    const config = vscode.workspace.getConfiguration();
    // Only Claude contributes a strategy and trigger; Codex always rotates in saved order at its limit.
    const strategy = provider === 'claude'
      ? `${config.get<string>('aiUsage.claude.autoRotate.strategy', 'soonestReset')}, ${config.get<string>('aiUsage.claude.autoRotate.trigger', 'limit')}, ` +
        `5h ≥ ${config.get<number>('aiUsage.claude.autoRotate.fiveHourThresholdPercent', 95)}%, 7d ≥ ${config.get<number>('aiUsage.claude.autoRotate.weeklyThresholdPercent', 99.5)}%`
      : `7d ≥ ${config.get<number>('aiUsage.codex.autoRotate.weeklyThresholdPercent', 99)}%`;
    items.push({ label: 'Account features', kind: vscode.QuickPickItemKind.Separator });
    if (providerState.profiles.length) {
      items.push({
        label: '$(play) Send keep-alive now…',
        detail: 'Choose a saved account, or all of them, send the configured keep-alive prompt immediately, and refresh usage statistics.',
        action: 'keepAliveNow'
      });
    }
    items.push({
      label: '$(gear) Keep-alive and rotation settings…',
      description: `Keep-alive ${keepAlive ? 'on' : 'off'} · rotation ${autoRotate ? `on (${strategy})` : 'off'}`,
      detail: `Opens Settings: turn periodic checks of every saved ${TITLES[provider]} account and automatic rotation on or off, and set the period, model, rotation strategy and thresholds, and dedicated home.`,
      action: 'settings'
    });
    items.push({
      label: `$(settings-gear) ${TITLES[provider]} settings…`,
      description: `aiUsage.${provider}.*`,
      detail: `Opens Settings on every ${TITLES[provider]} setting, including the ${TITLES[provider]} config section.`,
      action: 'serviceSettings'
    });
    if (withBack) {
      // Last, so the active profile stays the first, preselected item.
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: '$(arrow-left) Back', description: 'AI Usage menu of all services', action: 'back' });
    }
    return items;
  }

  private async askName(provider: AuthProvider, prompt: string, current?: string): Promise<string | undefined> {
    const names = this.state()[provider].profiles
      .filter((profile) => profile.name !== current)
      .map((profile) => profile.name.toLowerCase());
    const value = await vscode.window.showInputBox({
      title: `${TITLES[provider]} authentication profile`,
      prompt,
      value: current,
      ignoreFocusOut: true,
      validateInput: (input) => validName(input) ?? (names.includes(input.trim().toLowerCase()) ? 'That profile name already exists.' : undefined)
    });
    return value?.trim() || undefined;
  }

  /** `folder`: the project to keep the profile in; without it the profile is private. */
  private async saveProfile(provider: AuthProvider, name: string, credential: StoredCredential, active: boolean, folder?: string): Promise<void> {
    const state = this.state();
    const providerState = state[provider];
    if (providerState.profiles.length >= MAX_PROFILES) {
      void vscode.window.showWarningMessage(`${TITLES[provider]} already has the maximum of ${MAX_PROFILES} saved profiles.`);
      return;
    }
    const now = new Date().toISOString();
    const profile: ProfileMetadata = { id: randomUUID(), name, createdAt: now, updatedAt: now, ...(folder ? { folder } : {}) };
    if (folder) {
      // The login is written together with the profile when the state is saved below.
      this.projectFolderOf.set(this.key(provider, profile.id), folder);
      this.projectCredentials.set(this.key(provider, profile.id), credential);
    } else {
      await this.storeSecret(provider, profile.id, credential);
    }
    providerState.profiles.push(profile);
    if (active) {
      providerState.activeProfileId = profile.id;
    }
    await this.updateState(state);
    await this.recordIdentity(provider, profile.id, credential);
    this.log(`${provider}: saved authentication profile "${name}"${active ? ' (active)' : ''}${folder ? ` in project ${folder}` : ''}`);
  }

  private async saveCurrent(provider: AuthProvider): Promise<boolean> {
    let credential: StoredCredential;
    try {
      credential = readNativeCredential(provider);
    } catch (error) {
      void vscode.window.showErrorMessage(`AI Usage: ${errorMessage(error)}`);
      return false;
    }
    const providerState = this.state()[provider];
    if (providerState.profiles.length) {
      const canCreate = providerState.profiles.length < MAX_PROFILES;
      const picked = await vscode.window.showQuickPick([
        ...(canCreate ? [{
          label: '$(add) Create a new profile…',
          detail: 'Save the current native login under a new name.',
          create: true as const
        }] : []),
        { label: 'Update an existing profile', kind: vscode.QuickPickItemKind.Separator },
        ...providerState.profiles.map((profile) => ({
          label: `$(save) ${profile.name}`,
          description: profileDescription(profile, profile.id === providerState.activeProfileId),
          detail: 'Replace this profile with the current native login.',
          profile
        }))
      ], {
        title: `${TITLES[provider]} · Save current login`,
        placeHolder: canCreate ? 'Create a profile or update an existing one' : `Choose a profile to update (${MAX_PROFILES}/${MAX_PROFILES})`
      });
      if (!picked) { return false; }
      if ('profile' in picked && picked.profile) {
        await this.storeSecret(provider, picked.profile.id, credential);
        const state = this.state();
        const target = state[provider].profiles.find((profile) => profile.id === picked.profile?.id);
        if (!target) { throw new Error('The selected profile no longer exists.'); }
        target.updatedAt = new Date().toISOString();
        state[provider].activeProfileId = target.id;
        await this.updateState(state);
        await this.recordIdentity(provider, target.id, credential);
        this.log(`${provider}: updated authentication profile "${target.name}" from the current login`);
        void vscode.window.showInformationMessage(`${TITLES[provider]} profile “${target.name}” updated from the current login.`);
        return true;
      }
    }
    if (providerState.profiles.length >= MAX_PROFILES) {
      void vscode.window.showWarningMessage(`${TITLES[provider]} already has the maximum of ${MAX_PROFILES} saved profiles.`);
      return false;
    }
    if (!await this.confirmNotDuplicate(provider, credential)) {
      return false;
    }
    const name = await this.askName(provider, 'Name the login that is currently active.');
    if (!name) {
      return false;
    }
    const scope = await this.pickScope();
    if (!scope) {
      return false;
    }
    await this.saveProfile(provider, name, credential, true, scope.folder);
    void vscode.window.showInformationMessage(`${TITLES[provider]} login saved as “${name}”${scope.folder ? ` in project ${path.basename(scope.folder)}` : ''}.`);
    return true;
  }

  /** Warns when a credential's login is already saved; returns false when the user declines to add a copy. */
  private async confirmNotDuplicate(provider: AuthProvider, credential: StoredCredential): Promise<boolean> {
    let email: string | undefined;
    try { email = (await this.identityOf(provider, credential)).email; } catch { return true; }
    const twin = email ? this.state()[provider].profiles.find((profile) => profile.email === email) : undefined;
    if (!twin) {
      return true;
    }
    this.log(`${provider}: login ${email} is already saved as "${twin.name}"`);
    const choice = await vscode.window.showWarningMessage(duplicateWarning(provider, twin), { modal: true }, 'Save a copy anyway');
    return choice === 'Save a copy anyway';
  }

  private async importFile(provider: AuthProvider): Promise<void> {
    if (this.state()[provider].profiles.length >= MAX_PROFILES) {
      void vscode.window.showWarningMessage(`${TITLES[provider]} already has the maximum of ${MAX_PROFILES} saved profiles.`);
      return;
    }
    const selected = await vscode.window.showOpenDialog({
      title: `Import ${TITLES[provider]} credential JSON`,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ['json'] },
      openLabel: 'Import'
    });
    if (!selected?.[0]) {
      return;
    }
    let credential: StoredCredential;
    try {
      const bytes = await vscode.workspace.fs.readFile(selected[0]);
      credential = parseCredentialJson(provider, Buffer.from(bytes).toString('utf8'));
    } catch (error) {
      void vscode.window.showErrorMessage(`AI Usage: could not import the credential: ${errorMessage(error)}`);
      return;
    }
    if (!await this.confirmNotDuplicate(provider, credential)) {
      return;
    }
    const name = await this.askName(provider, 'Name the imported login.');
    if (!name) {
      return;
    }
    const scope = await this.pickScope();
    if (!scope) {
      return;
    }
    await this.saveProfile(provider, name, credential, false, scope.folder);
    void vscode.window.showInformationMessage(`${TITLES[provider]} credential imported as “${name}”${scope.folder ? ` in project ${path.basename(scope.folder)}` : ''}. Choose it from the profile menu to activate it.`);
  }

  /** The export and the import behind one Accounts menu item; Back and cancel return to the accounts list. */
  private async transferMenu(provider: AuthProvider): Promise<void> {
    const items: Array<vscode.QuickPickItem & { action?: 'export' | 'import' }> = [];
    if (PROVIDERS.some((candidate) => this.state()[candidate].profiles.length)) {
      items.push({
        label: '$(export) Export saved profiles…',
        detail: 'Writes the saved Claude and Codex profiles, logins included, to a JSON file for AI Usage on another computer.',
        action: 'export'
      });
    }
    items.push({
      label: '$(cloud-download) Import saved profiles…',
      detail: 'Adds the profiles from a file exported by AI Usage elsewhere, and restores the logins of profiles saved here that have none.',
      action: 'import'
    });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(arrow-left) Back', description: `${TITLES[provider]} accounts` });
    const picked = await vscode.window.showQuickPick(items, { title: 'AI Usage · Export or import saved profiles', matchOnDetail: true });
    if (picked?.action === 'export') { await this.exportProfiles(); }
    if (picked?.action === 'import') { await this.importProfiles(); }
  }

  /**
   * Writes the chosen saved profiles of both services, logins included, to a JSON file for AI Usage on another
   * computer. Profiles whose login is not in this VS Code client's SecretStorage cannot be exported and are named.
   */
  async exportProfiles(): Promise<boolean> {
    const state = this.state();
    const items: Array<vscode.QuickPickItem & { entry?: ExportedProfile }> = [];
    const missing: string[] = [];
    for (const provider of PROVIDERS) {
      const profiles = state[provider].profiles;
      if (!profiles.length) { continue; }
      items.push({ label: TITLES[provider], kind: vscode.QuickPickItemKind.Separator });
      for (const profile of profiles) {
        const credential = await this.readSecret(provider, profile.id);
        if (!credential) {
          missing.push(`${TITLES[provider]} “${profile.name}”`);
          continue;
        }
        items.push({
          label: profile.name,
          description: profileDescription(profile, profile.id === state[provider].activeProfileId, profiles),
          picked: true,
          entry: { provider, id: profile.id, name: profile.name, email: profile.email, accountId: profile.accountId,
            createdAt: profile.createdAt, updatedAt: profile.updatedAt, credential }
        });
      }
    }
    if (!items.some((item) => item.entry)) {
      void vscode.window.showInformationMessage(missing.length
        ? `AI Usage: no saved profile has its login on this computer, so there is nothing to export: ${missing.join(', ')}.`
        : 'AI Usage: no Claude or Codex profiles are saved yet, so there is nothing to export.');
      return false;
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: 'AI Usage · Export saved profiles',
      placeHolder: 'The chosen profiles are written with their logins; deselect any to leave out',
      canPickMany: true,
      matchOnDescription: true
    });
    const entries = picked?.flatMap((item) => item.entry ? [item.entry] : []) ?? [];
    if (!entries.length) { return false; }
    const target = await vscode.window.showSaveDialog({
      title: 'Export saved AI Usage profiles',
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'ai-usage-profiles.json')),
      filters: { JSON: ['json'] },
      saveLabel: 'Export'
    });
    if (!target) { return false; }
    await vscode.workspace.fs.writeFile(target, Buffer.from(serializeProfileExport(entries), 'utf8'));
    if (target.scheme === 'file' && process.platform !== 'win32') {
      try { fs.chmodSync(target.fsPath, 0o600); } catch { /* A file system without modes, such as some mounts. */ }
    }
    this.log(`exported ${entries.length} authentication profiles to ${target.toString()}`);
    // Opened right away, so the content can be checked or copied to the other computer from the editor.
    try { await vscode.window.showTextDocument(target, { preview: false }); } catch (error) { this.log(`could not open the export: ${errorMessage(error)}`); }
    void vscode.window.showWarningMessage(
      `AI Usage: exported ${plural(entries.length, 'profile')} to ${target.fsPath}. The file holds their login tokens in plain text: import it on the other computer, then delete it.` +
      (missing.length ? ` Skipped, no login on this computer: ${missing.join(', ')}.` : ''));
    return true;
  }

  /**
   * Reads an export made elsewhere and shows what each entry would do before anything is written: a profile not
   * saved here is added with its id, name and identity; one saved here without a login (its SecretStorage was
   * cleared) gets it restored; one whose login differs is replaced only when chosen. Nothing is activated.
   */
  async importProfiles(): Promise<boolean> {
    const selected = await vscode.window.showOpenDialog({
      title: 'Import saved AI Usage profiles',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ['json'] },
      openLabel: 'Import'
    });
    if (!selected?.[0]) { return false; }
    let entries: ExportedProfile[];
    try {
      const bytes = await vscode.workspace.fs.readFile(selected[0]);
      entries = parseProfileExport(Buffer.from(bytes).toString('utf8'));
    } catch (error) {
      void vscode.window.showErrorMessage(`AI Usage: could not import the profiles: ${errorMessage(error)}`);
      return false;
    }
    if (!entries.length) {
      void vscode.window.showInformationMessage('AI Usage: the export holds no profiles.');
      return false;
    }
    const state = this.state();
    const logins = new Map<string, StoredCredential | undefined>();
    for (const provider of PROVIDERS) {
      for (const profile of state[provider].profiles) {
        logins.set(`${provider}:${profile.id}`, await this.readSecret(provider, profile.id));
      }
    }
    const plans = planImport(entries, (provider) => state[provider].profiles, (provider, id) => logins.get(`${provider}:${id}`));
    const items: Array<vscode.QuickPickItem & { plan?: ImportPlan<ProfileMetadata> }> = [];
    for (const provider of PROVIDERS) {
      const own = plans.filter((plan) => plan.entry.provider === provider);
      if (!own.length) { continue; }
      items.push({ label: TITLES[provider], kind: vscode.QuickPickItemKind.Separator });
      items.push(...own.map((plan) => ({
        label: plan.entry.name,
        description: [plan.entry.email, importOutcome(plan)].filter(Boolean).join(' · '),
        picked: plan.kind === 'new' || plan.kind === 'restore',
        plan
      })));
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: 'AI Usage · Import saved profiles',
      placeHolder: 'Choose the profiles to add or restore; nothing is activated',
      canPickMany: true,
      matchOnDescription: true
    });
    const chosen = picked?.flatMap((item) => item.plan ? [item.plan] : []) ?? [];
    if (!chosen.length) { return false; }
    for (const provider of PROVIDERS) {
      const added = chosen.filter((plan) => plan.entry.provider === provider && plan.kind === 'new').length;
      const room = MAX_PROFILES - state[provider].profiles.length;
      if (added > room) {
        void vscode.window.showWarningMessage(
          `AI Usage: ${TITLES[provider]} has room for ${plural(room, 'more profile')} (${MAX_PROFILES} at most), but ${added} new ones were chosen. Deselect some and import again.`);
        return false;
      }
    }
    const counts: Record<ImportKind, number> = { new: 0, restore: 0, replace: 0, same: 0 };
    const identify: Array<[AuthProvider, string, StoredCredential]> = [];
    const now = new Date().toISOString();
    for (const plan of chosen) {
      const { entry, target } = plan;
      let profile: ProfileMetadata;
      if (target) {
        // `target` is the object inside `state`, so the change below lands in the one write at the end.
        profile = target;
        if (plan.kind !== 'same') {
          await this.storeSecret(entry.provider, profile.id, entry.credential);
          profile.updatedAt = now;
        }
        profile.email ??= entry.email;
        profile.accountId ??= entry.accountId;
      } else {
        const profiles = state[entry.provider].profiles;
        profile = { id: entry.id, name: uniqueName(entry.name, profiles.map((saved) => saved.name)), createdAt: entry.createdAt, updatedAt: now,
          email: entry.email, accountId: entry.accountId };
        await this.storeSecret(entry.provider, profile.id, entry.credential);
        profiles.push(profile);
      }
      if (!profile.email || !profile.accountId) { identify.push([entry.provider, profile.id, entry.credential]); }
      counts[plan.kind]++;
      this.log(`${entry.provider}: imported profile "${profile.name}" (${plan.kind})`);
    }
    await this.updateState(state);
    // Exported metadata already names most logins; only the rest are asked about, one vendor call each.
    for (const [provider, id, credential] of identify) { await this.recordIdentity(provider, id, credential); }
    const summary = [
      counts.new ? `${counts.new} added` : '',
      counts.restore ? `${plural(counts.restore, 'login')} restored` : '',
      counts.replace ? `${plural(counts.replace, 'login')} replaced` : '',
      counts.same ? `${counts.same} already saved` : ''
    ].filter(Boolean).join(', ');
    void vscode.window.showInformationMessage(
      `AI Usage: imported ${plural(chosen.length, 'profile')}: ${summary}. Nothing was activated; choose a profile from its Accounts menu to use it.`);
    return true;
  }

  private async activate(provider: AuthProvider, profile: ProfileMetadata, automatic = false): Promise<boolean> {
    await this.syncActiveProfile(provider);
    const credential = await this.readSecret(provider, profile.id);
    if (!credential) {
      void vscode.window.showErrorMessage(`AI Usage: the secret for “${profile.name}” is missing or invalid. Delete and add the profile again.`);
      return false;
    }
    try {
      writeNativeCredential(provider, credential);
    } catch (error) {
      void vscode.window.showErrorMessage(`AI Usage: could not activate “${profile.name}”: ${errorMessage(error)}`);
      return false;
    }
    const state = this.state();
    const previous = state[provider].profiles.find((candidate) => candidate.id === state[provider].activeProfileId);
    state[provider].activeProfileId = profile.id;
    await this.updateState(state);
    this.log(`${provider}: activated authentication profile "${profile.name}"`);
    this.onActivated?.(provider, { previous, profile, automatic, external: false });
    // The file is written and the profile is active either way; verification only decides what to tell the user.
    let verification: ActivationVerification | undefined;
    try {
      verification = await this.verifyActivation?.(provider, credential, { email: profile.email, accountId: profile.accountId });
    } catch (error) {
      verification = { status: 'unverified', detail: errorMessage(error) };
    }
    // The verifier reports the exact native token it checked. A stored account UUID is authoritative; legacy
    // email-only metadata is upgraded because older versions could copy the wrong same-Team email offline.
    if (provider === 'claude' && verification?.status === 'match') {
      const accountMismatch = profile.accountId && verification.accountId && profile.accountId !== verification.accountId;
      if (accountMismatch) {
        verification = {
          ...verification,
          status: 'mismatch',
          detail: `Claude token belongs to ${verification.email ?? verification.accountId}, but profile “${profile.name}” was saved for ${profile.email ?? profile.accountId}.`
        };
      } else if ((!profile.accountId && verification.accountId) || (verification.email && profile.email !== verification.email)) {
        const verifiedState = this.state();
        const verifiedProfile = verifiedState[provider].profiles.find((candidate) => candidate.id === profile.id);
        if (verifiedProfile) {
          verifiedProfile.accountId = verification.accountId ?? verifiedProfile.accountId;
          verifiedProfile.email = verification.email ?? verifiedProfile.email;
          await this.updateState(verifiedState);
        }
      }
    }
    if (verification) {
      this.log(`${provider}: activation ${verification.status} — ${verification.detail}`);
    }
    if (verification?.status === 'mismatch') {
      void vscode.window.showErrorMessage(
        `AI Usage: ${TITLES[provider]} was switched to “${profile.name}”, but ${TITLES[provider]} reports a different login. ${verification.detail}`);
    } else if (verification?.status === 'unverified') {
      // The credential file is switched, but the vendor could not confirm which login it holds. Say so rather
      // than reporting a clean switch the user cannot see in the vendor's own status output.
      void vscode.window.showWarningMessage(
        `AI Usage: ${TITLES[provider]} switched to “${profile.name}”, but the login could not be confirmed: ${verification.detail}`);
    } else {
      void vscode.window.showInformationMessage(activationMessage(provider, profile.name, automatic, this.codexChatsFollowSwitch()));
    }
    return true;
  }

  /** Preserve tokens refreshed by the vendor CLI/extension before switching away. */
  private async syncActiveProfile(provider: AuthProvider): Promise<void> {
    const state = this.state();
    const active = state[provider].profiles.find((profile) => profile.id === state[provider].activeProfileId);
    if (!active) {
      return;
    }
    const stored = await this.readSecret(provider, active.id);
    if (!stored) {
      return;
    }
    try {
      const native = readNativeCredential(provider);
      if (!await this.sameCredentialOwner(provider, active, stored, native)) {
        return;
      }
      await this.storeSecret(provider, active.id, native);
      active.updatedAt = new Date().toISOString();
      await this.updateState(state);
      this.log(`${provider}: captured refreshed tokens for profile "${active.name}"`);
      if (!active.email || !active.accountId) { await this.recordIdentity(provider, active.id, native); }
    } catch {
      // A missing or temporarily incomplete native file must not prevent activating another profile.
    }
  }

  /** Strong Claude fallback for rotated refresh tokens: compare the token's user, never its shared Team org. */
  private async sameCredentialOwner(provider: AuthProvider, profile: ProfileMetadata,
    stored: StoredCredential, native: StoredCredential): Promise<boolean> {
    if (isSameCredentialOwner(provider, stored, native)) {
      return true;
    }
    if (provider !== 'claude' || (!profile.accountId && !profile.email)) {
      return false;
    }
    const identity = await this.identityOf(provider, native);
    if (profile.accountId && identity.accountId) {
      return profile.accountId === identity.accountId;
    }
    return Boolean(profile.email && identity.email && profile.email.toLowerCase() === identity.email.toLowerCase());
  }

  /** Undefined when cancelled or on Back, which both return to the accounts list. */
  private async pickSaved(provider: AuthProvider, title: string): Promise<ProfileMetadata | undefined> {
    const items: Array<vscode.QuickPickItem & { profile?: ProfileMetadata }> = this.state()[provider].profiles.map((profile) => ({
      label: profile.name,
      description: [profileDescription(profile, profile.id === this.activeProfileId(provider)),
        this.loginProblem(provider, profile.id) ? 'Login problem' : undefined].filter(Boolean).join(' · ') || undefined,
      profile
    }));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(arrow-left) Back', description: `${TITLES[provider]} accounts` });
    const picked = await vscode.window.showQuickPick(items, { title });
    return picked?.profile;
  }

  /**
   * What to do about a profile whose last check failed to authenticate: renew the login by signing in again in a
   * folder inside the keep-alive home, send a keep-alive to check it again, activate it as it is, or go back to
   * the accounts list. Undefined on Back or when the menu was dismissed.
   */
  private async loginProblemMenu(provider: AuthProvider, profile: ProfileMetadata, problem: string): Promise<'renew' | 'keepAlive' | 'select' | undefined> {
    const explained = explainAccountProblem(problem);
    const items: Array<vscode.QuickPickItem & { choice?: 'renew' | 'keepAlive' | 'select' }> = [
      {
        label: '$(sign-in) Renew the login…',
        detail: `Runs the ${TITLES[provider]} CLI login in a terminal with a separate home inside the keep-alive home and stores the new login in “${profile.name}”. The active login is replaced only when this profile is the active one.`,
        choice: 'renew'
      },
      {
        label: '$(play) Try a keep-alive',
        detail: 'Sends the configured keep-alive prompt now and refreshes usage statistics. An expired token is refreshed when it still can be; a dead login is reported with a sign-in offer.',
        choice: 'keepAlive'
      },
      {
        label: '$(check) Select anyway',
        detail: `Makes “${profile.name}” the active ${TITLES[provider]} login as it is. Its last check failed to authenticate, so the CLI may refuse it until the login is renewed.`,
        choice: 'select'
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(arrow-left) Back', description: `${TITLES[provider]} accounts` }
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `AI Usage · ${TITLES[provider]} account “${profile.name}” · Login problem`,
      placeHolder: explained.advice ? `${explained.label}. ${explained.advice}` : explained.label
    });
    return picked?.choice;
  }

  /** Like `pickSaved`, with an extra "All accounts" entry on top; empty when nothing was picked. */
  private async pickKeepAliveTargets(provider: AuthProvider): Promise<ProfileMetadata[]> {
    const profiles = this.state()[provider].profiles;
    const items: Array<vscode.QuickPickItem & { profiles?: ProfileMetadata[] }> = [];
    if (profiles.length > 1) {
      items.push({ label: '$(run-all) All accounts', description: `${profiles.length} saved accounts, one by one`, profiles });
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push(...profiles.map((profile) => ({
      label: profile.name,
      description: profileDescription(profile, profile.id === this.activeProfileId(provider)),
      profiles: [profile]
    })));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(arrow-left) Back', description: `${TITLES[provider]} accounts` });
    const picked = await vscode.window.showQuickPick(items, { title: `Send a ${TITLES[provider]} keep-alive now` });
    return picked?.profiles ?? [];
  }

  private async rename(provider: AuthProvider): Promise<void> {
    const profile = await this.pickSaved(provider, `Rename a ${TITLES[provider]} profile`);
    if (!profile) {
      return;
    }
    const name = await this.askName(provider, 'Enter the new profile name.', profile.name);
    if (!name || name === profile.name) {
      return;
    }
    const state = this.state();
    const target = state[provider].profiles.find((candidate) => candidate.id === profile.id);
    if (target) {
      target.name = name;
      target.updatedAt = new Date().toISOString();
      await this.updateState(state);
      this.log(`${provider}: renamed authentication profile to "${name}"`);
    }
  }

  /**
   * Moves one profile up or down, one step per pick, until Done. Private profiles and each folder's project
   * profiles are stored apart, so a profile only trades places with the nearest one stored with it.
   */
  private async reorder(provider: AuthProvider): Promise<void> {
    const profile = await this.pickSaved(provider, `Move a ${TITLES[provider]} profile`);
    if (!profile) {
      return;
    }
    for (;;) {
      const state = this.state();
      const profiles = state[provider].profiles;
      const peers = profiles.flatMap((candidate, index) => candidate.folder === profile.folder ? [index] : []);
      const at = peers.findIndex((index) => profiles[index].id === profile.id);
      if (at < 0) {
        return;
      }
      const items: Array<vscode.QuickPickItem & { step?: -1 | 1 }> = [];
      if (at > 0) {
        items.push({ label: '$(arrow-up) Move up', description: `above “${profiles[peers[at - 1]].name}”`, step: -1 });
      }
      if (at < peers.length - 1) {
        items.push({ label: '$(arrow-down) Move down', description: `below “${profiles[peers[at + 1]].name}”`, step: 1 });
      }
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: '$(check) Done', description: `${TITLES[provider]} accounts` });
      const picked = await vscode.window.showQuickPick(items, {
        title: `AI Usage · Move “${profile.name}”`,
        placeHolder: `Position ${at + 1} of ${peers.length}: ${peers.map((index) => profiles[index].name).join(', ')}`
      });
      if (!picked?.step) {
        return;
      }
      const from = peers[at];
      const to = peers[at + picked.step];
      [profiles[from], profiles[to]] = [profiles[to], profiles[from]];
      await this.updateState(state);
      this.log(`${provider}: moved authentication profile "${profile.name}" ${picked.step < 0 ? 'up' : 'down'}`);
    }
  }

  private async delete(provider: AuthProvider): Promise<void> {
    const profile = await this.pickSaved(provider, `Delete a saved ${TITLES[provider]} profile`);
    if (!profile) {
      return;
    }
    const active = profile.id === this.activeProfileId(provider);
    const choice = await vscode.window.showWarningMessage(
      `Delete the saved profile “${profile.name}”?${active ? ' The native login remains active until you switch or sign out.' : ''}`,
      { modal: true },
      'Delete'
    );
    if (choice !== 'Delete') {
      return;
    }
    // A project profile's login goes with its entry when the file is written without it below.
    if (!profile.folder) { await this.context.secrets.delete(this.secretKey(provider, profile.id)); }
    const state = this.state();
    state[provider].profiles = state[provider].profiles.filter((candidate) => candidate.id !== profile.id);
    if (state[provider].activeProfileId === profile.id) {
      state[provider].activeProfileId = undefined;
    }
    await this.updateState(state);
    this.log(`${provider}: deleted authentication profile "${profile.name}"`);
  }
}
