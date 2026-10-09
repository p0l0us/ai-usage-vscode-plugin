import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  AuthProvider,
  StoredCredential,
  extractCredential,
  isSameCredentialOwner,
  nativeCredentialPath,
  readNativeCredential,
  writeJsonAtomically,
  writeNativeCredential,
  writeTextAtomically
} from './authFiles';
import { claudeAccountFile, CredentialIdentity, resolveCredentialIdentity } from './accountIdentity';
import { ExportedProfile, ImportKind, ImportPlan, parseProfileExport, planImport, serializeProfileExport, uniqueName } from './profileTransfer';

/**
 * The saved profiles of both services, logins included: private ones in one mode-0600 file inside the service home,
 * project ones in the profile file of each project folder a connected client declared (`.ai-usage.profiles.json`
 * by default, the format of a profile export). This is the store behind every client: the VS Code Accounts menus
 * and the `ai-usage` command both go through the service, which is the only writer. Ported from the extension's
 * SecretStorage-backed manager, without its UI.
 */

export const MAX_PROFILES = 20;
/** Default path of a project's profile file, inside the project folder; `projectProfiles.file` changes it. */
export const DEFAULT_PROJECT_PROFILES_FILE = '.ai-usage.profiles.json';
export const PROVIDERS: AuthProvider[] = ['claude', 'codex'];
export const TITLES: Record<AuthProvider, string> = { claude: 'Claude', codex: 'Codex' };
const MAX_NAME_LENGTH = 60;

export type ProfileMetadata = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Login email behind the credential, shown beside the name so duplicate accounts are visible. */
  email?: string;
  /** Stable vendor account id; Claude Team members can share an organization but never this id. */
  accountId?: string;
  /** The project folder a project profile lives in; a private profile has none. Never written to profiles.json. */
  folder?: string;
};

export type StoredProfile = ProfileMetadata & { credential?: StoredCredential };

/**
 * Where the private profiles and their logins are kept. The service keeps them in `profiles.json` in its home; a
 * host may keep them elsewhere, such as the VS Code extension in its own SecretStorage when no background service
 * is used. Reads and writes are synchronous; a backend over asynchronous storage keeps a copy in memory.
 */
export type PrivateProfileBackend = {
  /** What the clients are told: `service` for profiles.json, `vscode` for VS Code's storage. */
  readonly kind: 'service' | 'vscode';
  read(): Partial<ProfileFile> | undefined;
  write(state: ProfileFile): void;
};

/** The private profiles in a profiles.json file, mode 0600. */
export function fileProfileBackend(file: string): PrivateProfileBackend {
  return {
    kind: 'service',
    read: () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProfileFile>; } catch { return undefined; } },
    write: (state) => writeJsonAtomically(file, state)
  };
}

export type ProfileStoreOptions = {
  /** The project profile file, relative to each folder; absolute paths are used as they are. */
  projectFileName?: () => string;
  projectProfilesEnabled?: () => boolean;
  privateProfilesEnabled?: () => boolean;
  /** Told about things worth a notification, such as a .gitignore that was edited. */
  notice?: (message: string) => void;
  /** Where the private profiles are kept; profiles.json at the store's file by default. */
  privateProfiles?: PrivateProfileBackend;
};

/** Where a new profile may be kept, as the clients ask before saving one. */
export type ProfileScopes = { privateEnabled: boolean; projectEnabled: boolean; folders: string[] };

/** A project entry as the file and the merged list both see it, so an unchanged file is not written again. */
function projectEntryKey(entry: ExportedProfile): string {
  return JSON.stringify([entry.provider, entry.id, entry.name, entry.createdAt, entry.updatedAt, entry.email, entry.accountId, entry.credential]);
}

function toEntry(provider: AuthProvider, profile: StoredProfile, credential: StoredCredential): ExportedProfile {
  return { provider, id: profile.id, name: profile.name, createdAt: profile.createdAt, updatedAt: profile.updatedAt,
    ...(profile.email ? { email: profile.email } : {}), ...(profile.accountId ? { accountId: profile.accountId } : {}), credential };
}
export type ProviderState = { profiles: StoredProfile[]; activeProfileId?: string };
export type ProfileFile = { version: 1; claude: ProviderState; codex: ProviderState };

/**
 * What an `afterActivate` hook is reacting to. Only a real account change invalidates already-running vendor
 * processes, so re-saving or re-selecting the login that is already active must not be reported as a switch.
 */
export type ActivationChange = { kind: 'activated' | 'saved'; accountChanged: boolean };

/** Outcome of checking, after the native file was written, which login the vendor tool now reports. */
export type ActivationVerification = {
  status: 'match' | 'mismatch' | 'unverified';
  detail: string;
  email?: string;
  accountId?: string;
};
/** `expected` is what the saved profile claims to hold, so a verifier can fall back to it when the vendor is silent. */
export type ActivationVerifier = (provider: AuthProvider, credential: StoredCredential, expected: CredentialIdentity) => Promise<ActivationVerification | undefined>;

export type ActivationOutcome = {
  profile: ProfileMetadata;
  verification?: ActivationVerification;
  level: 'info' | 'warning' | 'error';
  message: string;
  accountChanged: boolean;
};

export type SaveOutcome =
  | { status: 'saved' | 'updated'; profile: ProfileMetadata }
  | { status: 'duplicate'; twin: ProfileMetadata; warning: string };

export type ImportOutcome = { imported: number; counts: Record<ImportKind, number>; summary: string };

/** Undefined when the name is fine, otherwise what is wrong with it. */
export function validateName(value: string): string | undefined {
  const name = value.trim();
  if (!name) { return 'Enter a profile name.'; }
  if (name.length > MAX_NAME_LENGTH) { return `Use ${MAX_NAME_LENGTH} characters or fewer.`; }
  return undefined;
}

/**
 * Two saved copies of one login are dangerous, not just untidy: both vendors rotate the refresh token on every
 * refresh, and refreshing the second copy reuses a rotated token, which revokes the whole login server-side.
 */
export function duplicateWarning(provider: AuthProvider, twin: ProfileMetadata): string {
  return `This ${TITLES[provider]} login is already saved as “${twin.name}”. Two saved copies of one account refresh independently and get the account's tokens revoked; keep a single profile per login.`;
}

/**
 * A running Codex process keeps its login in memory, so without the account proxy the Codex extension needs an
 * extension-host restart; with the proxy, every chat routed through it uses the new login from its next turn.
 */
export function activationMessage(provider: AuthProvider, name: string, automatic: boolean, codexChatsFollow = false): string {
  if (provider === 'codex') {
    const followUp = codexChatsFollow
      ? 'Codex chats and new CLI sessions use it from their next turn.'
      : 'New Codex CLI sessions use it now; the Codex VS Code extension needs an extension restart.';
    return automatic ? `Codex automatically rotated to account “${name}”. ${followUp}` : `Codex switched to “${name}”. ${followUp}`;
  }
  // Claude Code reads its credential file per turn, so open chats and CLI sessions adopt a switch without a restart.
  return automatic
    ? `Claude automatically rotated to account “${name}”. Chats and CLI sessions use it from their next turn.`
    : `Claude switched to “${name}”. Chats and CLI sessions use it from their next turn.`;
}

/** What importing an entry would do, for its row in a list. */
export function importOutcome(plan: ImportPlan<ProfileMetadata>): string {
  const renamed = plan.target && plan.target.name !== plan.entry.name;
  switch (plan.kind) {
    case 'new': return 'new profile';
    case 'restore': return `restores the missing login${renamed ? ` of “${plan.target!.name}”` : ''}`;
    case 'replace': return `replaces the saved login${renamed ? ` of “${plan.target!.name}”` : ''}`;
    case 'same': return `already saved${renamed ? ` as “${plan.target!.name}”` : ''}`;
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function strip(profile: StoredProfile): ProfileMetadata {
  const { credential: _credential, ...metadata } = profile;
  return metadata;
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

function emptyState(): ProfileFile {
  return { version: 1, claude: { profiles: [] }, codex: { profiles: [] } };
}

export class ProfileStore {
  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void,
    private readonly identityOf: (provider: AuthProvider, credential: StoredCredential) => Promise<CredentialIdentity> = resolveCredentialIdentity,
    private readonly options: ProfileStoreOptions = {}
  ) {}

  /** New-profile validation includes asynchronous identity lookup; keep its read and commit together. */
  private saveQueue: Promise<void> = Promise.resolve();

  private async serializedSave<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.saveQueue;
    let release!: () => void;
    this.saveQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  /** The project folders connected clients declared, in the order they were first declared. */
  private projectFolders: string[] = [];
  /** Each project profile file as last read, by path, so an unchanged file is neither parsed nor written again. */
  private readonly projectFiles = new Map<string, { mtimeMs: number; entries: ExportedProfile[]; error?: string }>();

  /** Set by the service: checks, after the native file was written, which login the vendor tool reports. */
  verifyActivation?: ActivationVerifier;

  /** The native login `followNative` last looked at, per provider, so an unchanged file is not checked again. */
  private nativeChecked: Partial<Record<AuthProvider, string>> = {};
  /** Whether that native login belongs to no saved profile. */
  private nativeUnsaved: Partial<Record<AuthProvider, boolean>> = {};

  // --- project folders ---------------------------------------------------------------------------------------

  /** Replaces the declared project folders; returns whether the set changed. */
  setProjectFolders(folders: string[]): boolean {
    const next = [...new Set(folders.map((folder) => path.resolve(folder)))];
    if (next.length === this.projectFolders.length && next.every((folder, index) => folder === this.projectFolders[index])) { return false; }
    this.projectFolders = next;
    this.nativeChecked = {};
    return true;
  }

  private projectFileName(): string {
    const configured = this.options.projectFileName?.();
    return (typeof configured === 'string' && configured.trim()) || DEFAULT_PROJECT_PROFILES_FILE;
  }

  projectFile(folder: string): string { return path.resolve(folder, this.projectFileName()); }

  /** The declared folders whose profile files are read: all of them while project profiles are enabled. */
  private activeProjectFolders(): string[] {
    return this.options.projectProfilesEnabled?.() === false ? [] : this.projectFolders;
  }

  scopes(): ProfileScopes {
    return { privateEnabled: this.options.privateProfilesEnabled?.() !== false, projectEnabled: this.options.projectProfilesEnabled?.() !== false, folders: this.activeProjectFolders() };
  }

  /**
   * Reads every declared folder's profile file, once per change of the file. The profiles of every folder are
   * merged into one list: the service is one per host, so a project can be used with another open project's
   * profiles; that is a known limitation. A profile listed in two folders is taken from the first one.
   */
  private loadProjectProfiles(): Record<AuthProvider, StoredProfile[]> {
    const loaded: Record<AuthProvider, StoredProfile[]> = { claude: [], codex: [] };
    const seen = new Set<string>();
    for (const folder of this.activeProjectFolders()) {
      const file = this.projectFile(folder);
      let mtimeMs: number;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { this.projectFiles.delete(file); continue; }
      let cached = this.projectFiles.get(file);
      if (!cached || cached.mtimeMs !== mtimeMs) {
        try {
          cached = { mtimeMs, entries: parseProfileExport(fs.readFileSync(file, 'utf8')) };
        } catch (error) {
          cached = { mtimeMs, entries: [], error: error instanceof Error ? error.message : String(error) };
          this.log(`project profiles in ${file} were not loaded: ${cached.error}`);
        }
        this.projectFiles.set(file, cached);
      }
      for (const entry of cached.entries) {
        const key = `${entry.provider}:${entry.id}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        loaded[entry.provider].push({ id: entry.id, name: entry.name, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
          ...(entry.email ? { email: entry.email } : {}), ...(entry.accountId ? { accountId: entry.accountId } : {}), folder, credential: entry.credential });
      }
    }
    return loaded;
  }

  /** Writes a folder's project profiles, unless the file already holds exactly them or could not be read. */
  private writeProjectFile(folder: string, entries: ExportedProfile[]): void {
    const file = this.projectFile(folder);
    const cached = this.projectFiles.get(file);
    // A file that could not be read is never overwritten: the user has to fix or remove it.
    if (cached?.error) { return; }
    if (cached && cached.entries.length === entries.length &&
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
    this.options.notice?.(`Added ${relative} to ${path.basename(folder)}/.gitignore, because project profiles hold login tokens in plain text.`);
  }

  // --- the merged state --------------------------------------------------------------------------------------

  /** Where the private profiles are kept. */
  get privateBackend(): PrivateProfileBackend {
    this.backend ??= this.options.privateProfiles ?? fileProfileBackend(this.file);
    return this.backend;
  }
  private backend?: PrivateProfileBackend;

  /** The private profiles from their backend, then the project profiles of every declared folder. */
  private state(): ProfileFile {
    const stored = this.privateBackend.read();
    const fallback = emptyState();
    const project = this.loadProjectProfiles();
    for (const provider of PROVIDERS) {
      const value = stored?.[provider];
      const own = value && Array.isArray(value.profiles)
        ? value.profiles.filter((profile) => profile && typeof profile.id === 'string' && typeof profile.name === 'string')
          .map(({ folder: _folder, ...profile }) => profile).slice(0, MAX_PROFILES)
        : [];
      const ids = new Set(own.map((profile) => profile.id));
      fallback[provider] = {
        profiles: [...own, ...project[provider].filter((profile) => !ids.has(profile.id))],
        activeProfileId: value && typeof value.activeProfileId === 'string' ? value.activeProfileId : undefined
      };
    }
    return fallback;
  }

  /** Private profiles go to their backend; project profiles go back to their folders' files, logins included. */
  private updateState(state: ProfileFile): void {
    const stored = emptyState();
    const perFolder = new Map<string, ExportedProfile[]>();
    for (const provider of PROVIDERS) {
      stored[provider] = { profiles: state[provider].profiles.filter((profile) => !profile.folder), activeProfileId: state[provider].activeProfileId };
      for (const profile of state[provider].profiles) {
        if (!profile.folder || !profile.credential) { continue; }
        const entries = perFolder.get(profile.folder) ?? [];
        entries.push(toEntry(provider, profile, profile.credential));
        perFolder.set(profile.folder, entries);
      }
    }
    this.privateBackend.write(stored);
    // A folder whose file exists but has no profile left gets an empty list, so a deleted profile is gone from it.
    for (const folder of new Set([...perFolder.keys(), ...this.activeProjectFolders()])) {
      const entries = perFolder.get(folder) ?? [];
      if (entries.length || this.projectFiles.has(this.projectFile(folder))) { this.writeProjectFile(folder, entries); }
    }
    // A saved, renamed or activated profile can change who owns the native login; check again next time.
    this.nativeChecked = {};
  }

  private find(state: ProfileFile, provider: AuthProvider, id: string): StoredProfile | undefined {
    return state[provider].profiles.find((profile) => profile.id === id);
  }

  profiles(provider: AuthProvider): ProfileMetadata[] {
    return this.state()[provider].profiles.map(strip);
  }

  profile(provider: AuthProvider, id: string): ProfileMetadata | undefined {
    const found = this.find(this.state(), provider, id);
    return found ? strip(found) : undefined;
  }

  /** Name, 1-based number or id, case-insensitively; undefined when nothing matches. */
  resolve(provider: AuthProvider, reference: string): ProfileMetadata | undefined {
    const profiles = this.profiles(provider);
    const wanted = reference.trim().toLowerCase();
    const number = /^#?(\d+)$/.exec(wanted);
    return profiles.find((profile) => profile.id === reference)
      ?? profiles.find((profile) => profile.name.toLowerCase() === wanted)
      ?? (number ? profiles[Number(number[1]) - 1] : undefined)
      ?? profiles.find((profile) => profile.email?.toLowerCase() === wanted);
  }

  profileCount(provider: AuthProvider): number {
    return this.state()[provider].profiles.length;
  }

  activeProfileId(provider: AuthProvider): string | undefined {
    return this.state()[provider].activeProfileId;
  }

  activeProfileName(provider: AuthProvider): string | undefined {
    const state = this.state()[provider];
    return state.profiles.find((profile) => profile.id === state.activeProfileId)?.name;
  }

  /** 1-based position of the active profile in the saved list; undefined while the native login is unsaved. */
  activeProfileNumber(provider: AuthProvider): number | undefined {
    if (this.nativeUnsaved[provider]) { return undefined; }
    const { profiles, activeProfileId } = this.state()[provider];
    const index = profiles.findIndex((profile) => profile.id === activeProfileId);
    return index < 0 ? undefined : index + 1;
  }

  nativeIsUnsaved(provider: AuthProvider): boolean {
    return Boolean(this.nativeUnsaved[provider]);
  }

  /** What the active profile claims to hold, used to correct vendor metadata when the vendor cannot be asked. */
  activeIdentity(provider: AuthProvider): CredentialIdentity {
    const state = this.state()[provider];
    const active = state.profiles.find((profile) => profile.id === state.activeProfileId);
    return { email: active?.email, accountId: active?.accountId };
  }

  hasCredential(provider: AuthProvider, id: string): boolean {
    return this.readSecret(provider, id) !== undefined;
  }

  private readSecret(provider: AuthProvider, id: string, state = this.state()): StoredCredential | undefined {
    const credential = this.find(state, provider, id)?.credential;
    if (!credential) { return undefined; }
    try { return extractCredential(provider, credential); } catch { return undefined; }
  }

  /** Which login a credential belongs to; empty when the vendor cannot be asked. Never throws. */
  async identity(provider: AuthProvider, credential: StoredCredential): Promise<CredentialIdentity> {
    try { return await this.identityOf(provider, credential); } catch { return {}; }
  }

  /** The saved profile that already holds this login, by identity or matching credential. */
  async duplicateOf(provider: AuthProvider, credential: StoredCredential): Promise<ProfileMetadata | undefined> {
    const identity = await this.identity(provider, credential);
    const twin = this.duplicateProfile(provider, credential, identity, this.state());
    if (twin) { this.log(`${provider}: login is already saved as "${twin.name}"`); }
    return twin ? strip(twin) : undefined;
  }

  private duplicateProfile(provider: AuthProvider, credential: StoredCredential, identity: CredentialIdentity, state: ProfileFile): StoredProfile | undefined {
    return state[provider].profiles.find((profile) =>
      Boolean((identity.email && profile.email === identity.email) || (identity.accountId && profile.accountId === identity.accountId) ||
        (profile.credential && isSameCredentialOwner(provider, profile.credential, credential))));
  }

  async credential(provider: AuthProvider, id: string): Promise<StoredCredential | undefined> {
    if (!this.profiles(provider).some((profile) => profile.id === id)) { return undefined; }
    if (this.activeProfileId(provider) === id) { await this.syncActiveProfile(provider); }
    return this.readSecret(provider, id);
  }

  /** Only write back if neither another client nor a manual switch replaced these tokens. */
  async refreshedCredential(provider: AuthProvider, id: string, before: StoredCredential, after: StoredCredential): Promise<void> {
    if (JSON.stringify(before) === JSON.stringify(after)) { return; }
    const state = this.state();
    const target = this.find(state, provider, id);
    if (!target) { return; }
    if (JSON.stringify(this.readSecret(provider, id, state)) !== JSON.stringify(before)) { return; }
    if (state[provider].activeProfileId === id) {
      try {
        if (JSON.stringify(readNativeCredential(provider)) !== JSON.stringify(before)) { return; }
        writeNativeCredential(provider, after);
      } catch { return; /* Native login may have been removed externally. */ }
    }
    target.credential = after;
    this.updateState(state);
    await this.recordIdentity(provider, id, after);
  }

  /** Stores stable identity beside the profile so same-organization Claude users remain distinct. */
  private async recordIdentity(provider: AuthProvider, id: string, credential: StoredCredential): Promise<void> {
    let identity: CredentialIdentity;
    try { identity = await this.identityOf(provider, credential); } catch { return; }
    if (!identity.email && !identity.accountId) { return; }
    const state = this.state();
    const profile = this.find(state, provider, id);
    if (!profile || (profile.email === identity.email && profile.accountId === identity.accountId)) { return; }
    if (identity.email) { profile.email = identity.email; }
    if (identity.accountId) { profile.accountId = identity.accountId; }
    this.updateState(state);
  }

  /** Resolves identities for saved profiles that predate account UUID tracking. */
  async backfillEmails(provider: AuthProvider): Promise<void> {
    const missing = this.state()[provider].profiles.filter((profile) => !profile.email || (provider === 'claude' && !profile.accountId));
    for (const profile of missing) {
      const credential = this.readSecret(provider, profile.id);
      if (credential) { await this.recordIdentity(provider, profile.id, credential); }
    }
  }

  async matchesNative(provider: AuthProvider, id: string): Promise<boolean> {
    const profile = this.profile(provider, id);
    const stored = this.readSecret(provider, id);
    try { return Boolean(profile && stored && await this.sameCredentialOwner(provider, profile, stored, readNativeCredential(provider))); }
    catch { return false; }
  }

  /**
   * Makes the active profile the one that owns the native login, when that changed outside the service (a sign-in
   * with the vendor CLI, or a hand-edited file). Only local data is used: a matching token, then the account id
   * (Codex `tokens.account_id`, Claude's `oauthAccount.accountUuid` in its account file). When no saved profile
   * owns the native login, the active profile is kept but not numbered. Returns whether the active profile changed.
   */
  async followNative(provider: AuthProvider): Promise<boolean> {
    let native: StoredCredential;
    try { native = readNativeCredential(provider); } catch { return false; }
    const nativeKey = JSON.stringify(native);
    if (this.nativeChecked[provider] === nativeKey) { return false; }
    const state = this.state();
    const providerState = state[provider];
    const owners: StoredProfile[] = [];
    for (const profile of providerState.profiles) {
      const stored = this.readSecret(provider, profile.id, state);
      if (stored && isSameCredentialOwner(provider, stored, native)) { owners.push(profile); }
    }
    if (!owners.length) {
      const accountId = nativeAccountId(provider, native);
      if (accountId) { owners.push(...providerState.profiles.filter((profile) => profile.accountId === accountId)); }
    }
    const owner = owners.length === 1 ? owners[0] : owners.find((profile) => profile.id === providerState.activeProfileId);
    let changed = false;
    if (!owner) {
      if (!this.nativeUnsaved[provider]) {
        this.log(`${provider}: the native login is not one of the saved profiles; no profile number is shown until it is`);
      }
    } else if (owner.id !== providerState.activeProfileId) {
      const previous = providerState.profiles.find((profile) => profile.id === providerState.activeProfileId);
      providerState.activeProfileId = owner.id;
      this.updateState(state);
      changed = true;
      this.log(`${provider}: the native login was switched outside the service to profile "${owner.name}"${previous ? ` (was "${previous.name}")` : ''}; following it`);
    }
    // Set after updateState, which forgets the last check.
    this.nativeChecked[provider] = nativeKey;
    this.nativeUnsaved[provider] = !owner;
    return changed;
  }

  /**
   * Stores a fresh sign-in for an existing profile, for example after its tokens were revoked. When the profile is
   * active its native login is dead too, so the new one replaces it there as well. Returns whether it was active.
   */
  async replaceCredential(provider: AuthProvider, id: string, credential: StoredCredential): Promise<boolean> {
    const checked = extractCredential(provider, credential);
    const state = this.state();
    const target = this.find(state, provider, id);
    if (!target) { throw new Error('The profile no longer exists.'); }
    const active = state[provider].activeProfileId === id;
    if (active) { writeNativeCredential(provider, checked); }
    target.credential = checked;
    target.updatedAt = new Date().toISOString();
    this.updateState(state);
    await this.recordIdentity(provider, id, checked);
    this.log(`${provider}: replaced the login of profile "${target.name}" with a new sign-in${active ? ' (active)' : ''}`);
    return active;
  }

  /**
   * Saves the login that is currently active in the native file: as a new profile named `name`, or into the
   * existing profile `id`, which then becomes the active one. A new profile whose login is already saved is
   * refused unless `allowDuplicate` is set.
   */
  async saveNative(provider: AuthProvider, options: { name?: string; id?: string; allowDuplicate?: boolean; folder?: string }): Promise<SaveOutcome> {
    const credential = readNativeCredential(provider);
    if (options.id) {
      const state = this.state();
      const target = this.find(state, provider, options.id);
      if (!target) { throw new Error('The selected profile no longer exists.'); }
      target.credential = credential;
      target.updatedAt = new Date().toISOString();
      state[provider].activeProfileId = target.id;
      this.updateState(state);
      await this.recordIdentity(provider, target.id, credential);
      this.log(`${provider}: updated authentication profile "${target.name}" from the current login`);
      return { status: 'updated', profile: this.profile(provider, target.id)! };
    }
    return this.saveNew(provider, options.name ?? '', credential, true, options.allowDuplicate, options.folder);
  }

  /** Imports a credential document as a profile that is saved but not activated; in `folder`'s file when given. */
  async importCredential(provider: AuthProvider, name: string, document: unknown, allowDuplicate = false, folder?: string): Promise<SaveOutcome> {
    return this.saveNew(provider, name, extractCredential(provider, document), false, allowDuplicate, folder);
  }

  /** The declared folder a new project profile may go to, or why not. */
  private resolveScope(folder: string | undefined): string | undefined {
    const scopes = this.scopes();
    if (!folder) {
      if (!scopes.privateEnabled) { throw new Error('Private profiles are turned off; choose a project folder for the profile.'); }
      return undefined;
    }
    if (!scopes.projectEnabled) { throw new Error('Project profiles are turned off.'); }
    const resolved = path.resolve(folder);
    if (!scopes.folders.includes(resolved)) { throw new Error(`${resolved} is not an open project folder of a connected client.`); }
    return resolved;
  }

  private async saveNew(provider: AuthProvider, rawName: string, credential: StoredCredential, active: boolean, allowDuplicate = false, folderOption?: string): Promise<SaveOutcome> {
    return this.serializedSave(async () => {
      const invalid = validateName(rawName);
      if (invalid) { throw new Error(invalid); }
      const name = rawName.trim();
      const folder = this.resolveScope(folderOption);
      const state = this.state();
      const providerState = state[provider];
      if (providerState.profiles.length >= MAX_PROFILES) {
        throw new Error(`${TITLES[provider]} already has the maximum of ${MAX_PROFILES} saved profiles.`);
      }
      if (providerState.profiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`A ${TITLES[provider]} profile named “${name}” already exists.`);
      }
      const identity = allowDuplicate ? undefined : await this.identity(provider, credential);
      const now = new Date().toISOString();
      const profile: StoredProfile = { id: randomUUID(), name, createdAt: now, updatedAt: now, ...(folder ? { folder } : {}), credential };
      // Re-read: an unrelated synchronous mutation may have run during the identity lookup.
      const fresh = this.state();
      if (fresh[provider].profiles.length >= MAX_PROFILES) {
        throw new Error(`${TITLES[provider]} already has the maximum of ${MAX_PROFILES} saved profiles.`);
      }
      if (fresh[provider].profiles.some((existing) => existing.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`A ${TITLES[provider]} profile named “${name}” already exists.`);
      }
      const twin = !allowDuplicate ? this.duplicateProfile(provider, credential, identity ?? {}, fresh) : undefined;
      if (twin) {
        this.log(`${provider}: login is already saved as "${twin.name}"`);
        const metadata = strip(twin);
        return { status: 'duplicate', twin: metadata, warning: duplicateWarning(provider, metadata) };
      }
      fresh[provider].profiles.push(profile);
      if (active) { fresh[provider].activeProfileId = profile.id; }
      this.updateState(fresh);
      await this.recordIdentity(provider, profile.id, credential);
      this.log(`${provider}: saved authentication profile "${name}"${active ? ' (active)' : ''}${folder ? ` in project ${folder}` : ''}`);
      return { status: 'saved', profile: this.profile(provider, profile.id)! };
    });
  }

  rename(provider: AuthProvider, id: string, rawName: string): ProfileMetadata {
    const invalid = validateName(rawName);
    if (invalid) { throw new Error(invalid); }
    const name = rawName.trim();
    const state = this.state();
    const target = this.find(state, provider, id);
    if (!target) { throw new Error('The profile no longer exists.'); }
    if (state[provider].profiles.some((profile) => profile.id !== id && profile.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`A ${TITLES[provider]} profile named “${name}” already exists.`);
    }
    if (target.name !== name) {
      target.name = name;
      target.updatedAt = new Date().toISOString();
      this.updateState(state);
      this.log(`${provider}: renamed authentication profile to "${name}"`);
    }
    return strip(target);
  }

  /** Move a profile one place within private profiles or its own project folder. */
  reorder(provider: AuthProvider, id: string, step: -1 | 1): ProfileMetadata[] {
    const state = this.state();
    const profiles = state[provider].profiles;
    const target = profiles.find((profile) => profile.id === id);
    if (!target) { throw new Error('The profile no longer exists.'); }
    const peers = profiles.flatMap((profile, index) => profile.folder === target.folder ? [index] : []);
    const at = peers.findIndex((index) => profiles[index].id === id);
    const next = at + step;
    if (next < 0 || next >= peers.length) { throw new Error('The profile cannot move further in that direction.'); }
    [profiles[peers[at]], profiles[peers[next]]] = [profiles[peers[next]], profiles[peers[at]]];
    this.updateState(state);
    this.log(`${provider}: moved authentication profile "${target.name}" ${step < 0 ? 'up' : 'down'}`);
    return this.profiles(provider);
  }

  /** Removes the profile; an active one leaves the native login in place until the next switch or sign-out. */
  delete(provider: AuthProvider, id: string): { profile: ProfileMetadata; wasActive: boolean } {
    const state = this.state();
    const target = this.find(state, provider, id);
    if (!target) { throw new Error('The profile no longer exists.'); }
    const wasActive = state[provider].activeProfileId === id;
    state[provider].profiles = state[provider].profiles.filter((profile) => profile.id !== id);
    if (wasActive) { state[provider].activeProfileId = undefined; }
    this.updateState(state);
    this.log(`${provider}: deleted authentication profile "${target.name}"`);
    return { profile: strip(target), wasActive };
  }

  /**
   * The saved profiles, logins included, for a transfer to another computer; every profile of both services
   * unless `selection` names some. Profiles without a login cannot be exported and are named in `missing`.
   */
  exportEntries(selection?: Array<{ provider: AuthProvider; id: string }>): { entries: ExportedProfile[]; missing: string[] } {
    const state = this.state();
    const entries: ExportedProfile[] = [];
    const missing: string[] = [];
    for (const provider of PROVIDERS) {
      for (const profile of state[provider].profiles) {
        if (selection && !selection.some((wanted) => wanted.provider === provider && wanted.id === profile.id)) { continue; }
        const credential = this.readSecret(provider, profile.id, state);
        if (!credential) { missing.push(`${TITLES[provider]} “${profile.name}”`); continue; }
        entries.push({ provider, id: profile.id, name: profile.name, email: profile.email, accountId: profile.accountId,
          createdAt: profile.createdAt, updatedAt: profile.updatedAt, credential });
      }
    }
    return { entries, missing };
  }

  /** Pairs each entry with the saved profile it stands for; see `planImport` in profileTransfer. */
  planImport(entries: ExportedProfile[]): Array<ImportPlan<ProfileMetadata>> {
    const state = this.state();
    return planImport(entries, (provider) => state[provider].profiles.map(strip), (provider, id) => this.readSecret(provider, id, state));
  }

  /**
   * Applies the chosen plans: a profile not saved here is added with its id, name and identity; one saved here
   * without a login gets it restored; one whose login differs is replaced. Nothing is activated.
   */
  async applyImport(plans: Array<ImportPlan<ProfileMetadata>>): Promise<ImportOutcome> {
    const state = this.state();
    for (const provider of PROVIDERS) {
      const added = plans.filter((plan) => plan.entry.provider === provider && plan.kind === 'new').length;
      const room = MAX_PROFILES - state[provider].profiles.length;
      if (added > room) {
        throw new Error(`${TITLES[provider]} has room for ${plural(room, 'more profile')} (${MAX_PROFILES} at most), but ${added} new ones were chosen.`);
      }
    }
    const counts: Record<ImportKind, number> = { new: 0, restore: 0, replace: 0, same: 0 };
    const identify: Array<[AuthProvider, string, StoredCredential]> = [];
    const now = new Date().toISOString();
    for (const plan of plans) {
      const { entry } = plan;
      let profile: StoredProfile;
      const target = plan.target ? this.find(state, entry.provider, plan.target.id) : undefined;
      if (target) {
        profile = target;
        if (plan.kind !== 'same') {
          profile.credential = entry.credential;
          profile.updatedAt = now;
        }
        profile.email ??= entry.email;
        profile.accountId ??= entry.accountId;
      } else {
        const profiles = state[entry.provider].profiles;
        profile = { id: entry.id, name: uniqueName(entry.name, profiles.map((saved) => saved.name)), createdAt: entry.createdAt, updatedAt: now,
          email: entry.email, accountId: entry.accountId, credential: entry.credential };
        profiles.push(profile);
      }
      if (!profile.email || !profile.accountId) { identify.push([entry.provider, profile.id, entry.credential]); }
      counts[plan.kind]++;
      this.log(`${entry.provider}: imported profile "${profile.name}" (${plan.kind})`);
    }
    this.updateState(state);
    // Exported metadata already names most logins; only the rest are asked about, one vendor call each.
    for (const [provider, id, credential] of identify) { await this.recordIdentity(provider, id, credential); }
    const summary = [
      counts.new ? `${counts.new} added` : '',
      counts.restore ? `${plural(counts.restore, 'login')} restored` : '',
      counts.replace ? `${plural(counts.replace, 'login')} replaced` : '',
      counts.same ? `${counts.same} already saved` : ''
    ].filter(Boolean).join(', ');
    return { imported: plans.length, counts, summary };
  }

  /** Writes the profile's login to the native file and makes it the active profile; throws when that fails. */
  async activateProfile(provider: AuthProvider, id: string, automatic = false): Promise<ActivationOutcome> {
    const found = this.profile(provider, id);
    if (!found) { throw new Error('The profile no longer exists.'); }
    // Re-selecting the login that is already active and already written changes nothing for running processes.
    const unchanged = this.activeProfileId(provider) === id && await this.matchesNative(provider, id);
    await this.syncActiveProfile(provider);
    const credential = this.readSecret(provider, id);
    if (!credential) {
      throw new Error(`The login of “${found.name}” is missing or invalid. Sign in again for the profile, or delete and add it again.`);
    }
    try {
      writeNativeCredential(provider, credential);
    } catch (error) {
      throw new Error(`Could not activate “${found.name}”: ${error instanceof Error ? error.message : String(error)}`);
    }
    const state = this.state();
    state[provider].activeProfileId = id;
    this.updateState(state);
    this.log(`${provider}: activated authentication profile "${found.name}"${automatic ? ' (automatic)' : ''}`);
    // The file is written and the profile is active either way; verification only decides what to tell the user.
    let verification: ActivationVerification | undefined;
    try {
      verification = await this.verifyActivation?.(provider, credential, { email: found.email, accountId: found.accountId });
    } catch (error) {
      verification = { status: 'unverified', detail: error instanceof Error ? error.message : String(error) };
    }
    // The verifier reports the exact native token it checked. A stored account UUID is authoritative; legacy
    // email-only metadata is upgraded because older versions could copy the wrong same-Team email offline.
    if (provider === 'claude' && verification?.status === 'match') {
      const accountMismatch = found.accountId && verification.accountId && found.accountId !== verification.accountId;
      if (accountMismatch) {
        verification = {
          ...verification,
          status: 'mismatch',
          detail: `Claude token belongs to ${verification.email ?? verification.accountId}, but profile “${found.name}” was saved for ${found.email ?? found.accountId}.`
        };
      } else if ((!found.accountId && verification.accountId) || (verification.email && found.email !== verification.email)) {
        const verifiedState = this.state();
        const verifiedProfile = this.find(verifiedState, provider, id);
        if (verifiedProfile) {
          verifiedProfile.accountId = verification.accountId ?? verifiedProfile.accountId;
          verifiedProfile.email = verification.email ?? verifiedProfile.email;
          this.updateState(verifiedState);
        }
      }
    }
    if (verification) { this.log(`${provider}: activation ${verification.status} — ${verification.detail}`); }
    const profile = this.profile(provider, id) ?? found;
    if (verification?.status === 'mismatch') {
      return { profile, verification, level: 'error', accountChanged: !unchanged,
        message: `${TITLES[provider]} was switched to “${profile.name}”, but ${TITLES[provider]} reports a different login. ${verification.detail}` };
    }
    if (verification?.status === 'unverified') {
      // The credential file is switched, but the vendor could not confirm which login it holds. Say so rather
      // than reporting a clean switch the user cannot see in the vendor's own status output.
      return { profile, verification, level: 'warning', accountChanged: !unchanged,
        message: `${TITLES[provider]} switched to “${profile.name}”, but the login could not be confirmed: ${verification.detail}` };
    }
    return { profile, verification, level: 'info', accountChanged: !unchanged, message: activationMessage(provider, profile.name, automatic) };
  }

  /** Preserve tokens refreshed by the vendor CLI/extension before switching away. */
  private async syncActiveProfile(provider: AuthProvider): Promise<void> {
    const state = this.state();
    const active = state[provider].profiles.find((profile) => profile.id === state[provider].activeProfileId);
    if (!active) { return; }
    const stored = this.readSecret(provider, active.id, state);
    if (!stored) { return; }
    try {
      const native = readNativeCredential(provider);
      if (JSON.stringify(native) === JSON.stringify(stored)) { return; }
      if (!await this.sameCredentialOwner(provider, active, stored, native)) { return; }
      active.credential = native;
      active.updatedAt = new Date().toISOString();
      this.updateState(state);
      this.log(`${provider}: captured refreshed tokens for profile "${active.name}"`);
      if (!active.email || !active.accountId) { await this.recordIdentity(provider, active.id, native); }
    } catch {
      // A missing or temporarily incomplete native file must not prevent activating another profile.
    }
  }

  /** Strong Claude fallback for rotated refresh tokens: compare the token's user, never its shared Team org. */
  private async sameCredentialOwner(provider: AuthProvider, profile: ProfileMetadata, stored: StoredCredential, native: StoredCredential): Promise<boolean> {
    if (isSameCredentialOwner(provider, stored, native)) { return true; }
    if (provider !== 'claude' || (!profile.accountId && !profile.email)) { return false; }
    const identity = await this.identityOf(provider, native);
    if (profile.accountId && identity.accountId) { return profile.accountId === identity.accountId; }
    return Boolean(profile.email && identity.email && profile.email.toLowerCase() === identity.email.toLowerCase());
  }

  /** Where the native login of a provider lives, for messages. */
  static nativePath(provider: AuthProvider): string {
    return nativeCredentialPath(provider);
  }
}
