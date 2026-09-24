import * as fs from 'fs';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import {
  AuthProvider,
  StoredCredential,
  isSameCredentialOwner,
  nativeCredentialPath,
  parseCredentialJson,
  readNativeCredential,
  writeNativeCredential
} from './authFiles';
import { claudeAccountFile, CredentialIdentity, resolveCredentialIdentity } from './accountIdentity';
import { openAiUsageSettings } from './settingsLink';

const STATE_KEY = 'aiUsage.authProfiles.v1';
const AUTOMATION_STATE_KEY = 'aiUsage.accountAutomation.v1';
const SECRET_PREFIX = 'aiUsage.authProfile.v1';
const MAX_PROFILES = 20;

export type ProfileMetadata = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Login email behind the credential, shown beside the name so duplicate accounts are visible. */
  email?: string;
  /** Stable vendor account id; Claude Team members can share an organization but never this id. */
  accountId?: string;
};

/** Menu description: the account email, a duplicate marker, then the active marker. */
function profileDescription(profile: ProfileMetadata, active: boolean, siblings: ProfileMetadata[] = []): string | undefined {
  const twin = profile.email ? siblings.find((other) => other.id !== profile.id && other.email === profile.email) : undefined;
  return [profile.email, twin ? `duplicate of “${twin.name}”` : undefined, active ? 'Active' : undefined].filter(Boolean).join(' · ') || undefined;
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
  action?: 'save' | 'import' | 'rename' | 'delete' | 'keepAliveNow' | 'settings' | 'serviceSettings' | 'back';
};

/**
 * What the `afterActivate` hook is reacting to. Only a real account change invalidates already-running vendor
 * processes, so re-saving or re-selecting the login that is already active must not be reported as a switch.
 */
export type ActivationChange = { kind: 'activated' | 'saved'; accountChanged: boolean };

type ProfileHooks = {
  beforeActivate?: (provider: AuthProvider) => Promise<void>;
  afterActivate?: (provider: AuthProvider, change: ActivationChange) => Promise<void>;
  sendKeepAlive?: (provider: AuthProvider, profile: ProfileMetadata) => Promise<void>;
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
          const profile = await this.pickSaved(provider, `Send a ${TITLES[provider]} keep-alive now`);
          if (profile) { await hooks?.sendKeepAlive?.(provider, profile); }
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
        } else if (item.action === 'rename') {
          await this.rename(provider);
        } else if (item.action === 'delete') {
          await this.delete(provider);
        }
      } catch (error) {
        this.log(`${provider}: authentication profile operation failed: ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(`AI Usage: authentication profile operation failed: ${errorMessage(error)}`);
      }
    }
  }

  private state(): ProfileState {
    const stored = this.context.globalState.get<Partial<ProfileState>>(STATE_KEY);
    const fallback = emptyState();
    for (const provider of ['claude', 'codex'] as const) {
      const value = stored?.[provider];
      if (!value || !Array.isArray(value.profiles)) {
        continue;
      }
      fallback[provider] = {
        profiles: value.profiles.filter((profile) =>
          profile && typeof profile.id === 'string' && typeof profile.name === 'string'
        ).slice(0, MAX_PROFILES),
        activeProfileId: typeof value.activeProfileId === 'string' ? value.activeProfileId : undefined
      };
    }
    return fallback;
  }

  private async updateState(state: ProfileState): Promise<void> {
    await this.context.globalState.update(STATE_KEY, state);
    // A saved, renamed or activated profile can change who owns the native login; check again next time.
    this.nativeChecked = {};
  }

  private secretKey(provider: AuthProvider, id: string): string {
    return `${SECRET_PREFIX}.${provider}.${id}`;
  }

  private async readSecret(provider: AuthProvider, id: string): Promise<StoredCredential | undefined> {
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
    const items: ProfileItem[] = providerState.profiles.map((profile) => ({
      label: `${profile.id === providerState.activeProfileId ? '$(check)' : '$(key)'} ${profile.name}`,
      description: profileDescription(profile, profile.id === providerState.activeProfileId, providerState.profiles),
      detail: this.usageDetail?.(provider, profile.id) ?? `Saved ${new Date(profile.updatedAt).toLocaleString()} · Usage not checked yet`,
      profile
    }));
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
    if (providerState.profiles.length) {
      items.push({ label: '$(edit) Rename a profile…', action: 'rename' });
      items.push({ label: '$(trash) Delete a saved profile…', action: 'delete' });
    }
    const keepAlive = this.automationEnabled(provider, 'keepAlive');
    const autoRotate = this.automationEnabled(provider, 'autoRotate');
    const config = vscode.workspace.getConfiguration();
    const threshold = config.get<number>(`aiUsage.${provider}.autoRotate.thresholdPercent`, 99.5);
    // Only Claude contributes a strategy and trigger; Codex always rotates in saved order at its limit.
    const strategy = provider === 'claude'
      ? `${config.get<string>('aiUsage.claude.autoRotate.strategy', 'soonestReset')}, ${config.get<string>('aiUsage.claude.autoRotate.trigger', 'limit')}`
      : `at ${threshold}%`;
    items.push({ label: 'Account features', kind: vscode.QuickPickItemKind.Separator });
    if (providerState.profiles.length) {
      items.push({
        label: '$(play) Send keep-alive now…',
        detail: 'Choose a saved account, send its configured keep-alive prompt immediately, and refresh its usage statistics.',
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

  private async saveProfile(provider: AuthProvider, name: string, credential: StoredCredential, active: boolean): Promise<void> {
    const state = this.state();
    const providerState = state[provider];
    if (providerState.profiles.length >= MAX_PROFILES) {
      void vscode.window.showWarningMessage(`${TITLES[provider]} already has the maximum of ${MAX_PROFILES} saved profiles.`);
      return;
    }
    const now = new Date().toISOString();
    const profile: ProfileMetadata = { id: randomUUID(), name, createdAt: now, updatedAt: now };
    await this.storeSecret(provider, profile.id, credential);
    providerState.profiles.push(profile);
    if (active) {
      providerState.activeProfileId = profile.id;
    }
    await this.updateState(state);
    await this.recordIdentity(provider, profile.id, credential);
    this.log(`${provider}: saved authentication profile "${name}"${active ? ' (active)' : ''}`);
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
    await this.saveProfile(provider, name, credential, true);
    void vscode.window.showInformationMessage(`${TITLES[provider]} login saved as “${name}”.`);
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
    await this.saveProfile(provider, name, credential, false);
    void vscode.window.showInformationMessage(`${TITLES[provider]} credential imported as “${name}”. Choose it from the profile menu to activate it.`);
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
    state[provider].activeProfileId = profile.id;
    await this.updateState(state);
    this.log(`${provider}: activated authentication profile "${profile.name}"`);
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
      description: profileDescription(profile, profile.id === this.activeProfileId(provider)),
      profile
    }));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(arrow-left) Back', description: `${TITLES[provider]} accounts` });
    const picked = await vscode.window.showQuickPick(items, { title });
    return picked?.profile;
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
    await this.context.secrets.delete(this.secretKey(provider, profile.id));
    const state = this.state();
    state[provider].profiles = state[provider].profiles.filter((candidate) => candidate.id !== profile.id);
    if (state[provider].activeProfileId === profile.id) {
      state[provider].activeProfileId = undefined;
    }
    await this.updateState(state);
    this.log(`${provider}: deleted authentication profile "${profile.name}"`);
  }
}
