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
import { resolveCredentialEmail } from './accountIdentity';

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
};

/** Menu description: the account email, then the active marker. */
function profileDescription(profile: ProfileMetadata, active: boolean): string | undefined {
  return [profile.email, active ? 'Active' : undefined].filter(Boolean).join(' · ') || undefined;
}

type ProviderState = {
  profiles: ProfileMetadata[];
  activeProfileId?: string;
};

type ProfileState = Record<AuthProvider, ProviderState>;
export type AccountAutomationFeature = 'keepAlive' | 'autoRotate';
type AutomationState = Record<AuthProvider, Record<AccountAutomationFeature, boolean>>;

type ProfileItem = vscode.QuickPickItem & {
  profile?: ProfileMetadata;
  action?: 'save' | 'import' | 'rename' | 'delete' | 'keepAliveNow' | AccountAutomationFeature;
};

type ProfileHooks = {
  beforeActivate?: (provider: AuthProvider) => Promise<void>;
  afterActivate?: (provider: AuthProvider) => Promise<void>;
  sendKeepAlive?: (provider: AuthProvider, profile: ProfileMetadata) => Promise<void>;
};

const TITLES: Record<AuthProvider, string> = { claude: 'Claude', codex: 'Codex' };

/** Outcome of checking, after the native file was written, which login the vendor tool now reports. */
export type ActivationVerification = {
  status: 'match' | 'mismatch' | 'unverified';
  detail: string;
};
export type ActivationVerifier = (provider: AuthProvider, credential: StoredCredential) => Promise<ActivationVerification | undefined>;

/** Codex reloads auth.json on its request path, so open chats follow a switch without a restart. */
function activationMessage(provider: AuthProvider, name: string, automatic: boolean): string {
  if (provider === 'codex') {
    const followUp = 'Open chats use this login from their next turn.';
    return automatic ? `AI Usage: Codex automatically rotated to account “${name}”. ${followUp}` : `Codex switched to “${name}”. ${followUp}`;
  }
  return automatic
    ? `AI Usage: ${TITLES[provider]} automatically rotated to account “${name}”.`
    : `${TITLES[provider]} switched to “${name}”. New requests will use this login.`;
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

export class AuthProfileManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    private readonly usageDetail?: (provider: AuthProvider, id: string) => string | undefined,
    private readonly verifyActivation?: ActivationVerifier,
    private readonly emailOf: (provider: AuthProvider, credential: StoredCredential) => Promise<string | undefined> = resolveCredentialEmail
  ) {}

  profiles(provider: AuthProvider): ProfileMetadata[] {
    return this.state()[provider].profiles;
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
    await this.recordEmail(provider, id, after);
  }

  /** Stores the credential's email in the profile metadata when it is still unknown or has changed. */
  private async recordEmail(provider: AuthProvider, id: string, credential: StoredCredential): Promise<void> {
    let email: string | undefined;
    try { email = await this.emailOf(provider, credential); } catch { return; }
    if (!email) { return; }
    const state = this.state();
    const profile = state[provider].profiles.find((candidate) => candidate.id === id);
    if (!profile || profile.email === email) { return; }
    profile.email = email;
    await this.updateState(state);
  }

  /** Resolves emails for saved profiles that were created before emails were recorded. */
  private async backfillEmails(provider: AuthProvider): Promise<void> {
    const missing = this.state()[provider].profiles.filter((profile) => !profile.email);
    await Promise.all(missing.map(async (profile) => {
      const credential = await this.readSecret(provider, profile.id);
      if (credential) { await this.recordEmail(provider, profile.id, credential); }
    }));
  }

  async matchesNative(provider: AuthProvider, id: string): Promise<boolean> {
    const stored = await this.readSecret(provider, id);
    try { return Boolean(stored && isSameCredentialOwner(provider, stored, readNativeCredential(provider))); }
    catch { return false; }
  }

  async activateProfile(provider: AuthProvider, id: string, automatic = false): Promise<boolean> {
    const profile = this.profiles(provider).find((candidate) => candidate.id === id);
    return profile ? this.activate(provider, profile, automatic) : false;
  }

  automationEnabled(provider: AuthProvider, feature: AccountAutomationFeature): boolean {
    const stored = this.context.globalState.get<Partial<AutomationState>>(AUTOMATION_STATE_KEY);
    const value = stored?.[provider]?.[feature];
    if (typeof value === 'boolean') {
      return value;
    }
    // Preserve the effective value for users upgrading from versions that exposed these as settings.
    return vscode.workspace.getConfiguration().get<boolean>(`aiUsage.${provider}.${feature}.enabled`, false);
  }

  async setAutomationEnabled(provider: AuthProvider, feature: AccountAutomationFeature, enabled: boolean): Promise<void> {
    const stored = this.context.globalState.get<Partial<AutomationState>>(AUTOMATION_STATE_KEY);
    const state: AutomationState = {
      claude: {
        keepAlive: stored?.claude?.keepAlive ?? this.automationEnabled('claude', 'keepAlive'),
        autoRotate: stored?.claude?.autoRotate ?? this.automationEnabled('claude', 'autoRotate')
      },
      codex: {
        keepAlive: stored?.codex?.keepAlive ?? this.automationEnabled('codex', 'keepAlive'),
        autoRotate: stored?.codex?.autoRotate ?? this.automationEnabled('codex', 'autoRotate')
      }
    };
    state[provider][feature] = enabled;
    await this.context.globalState.update(AUTOMATION_STATE_KEY, state);
    this.log(`${provider}: ${feature === 'keepAlive' ? 'account keep-alive' : 'automatic account rotation'} ${enabled ? 'enabled' : 'disabled'}`);
  }

  activeProfileId(provider: AuthProvider): string | undefined {
    return this.state()[provider].activeProfileId;
  }

  activeProfileName(provider: AuthProvider): string | undefined {
    const providerState = this.state()[provider];
    return providerState.profiles.find((profile) => profile.id === providerState.activeProfileId)?.name;
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
    // Management actions return to the list. Choosing a profile activates it and closes the menu.
    while (true) {
      const item = await vscode.window.showQuickPick(this.items(provider), {
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
          await hooks?.beforeActivate?.(provider);
          if (await this.activate(provider, item.profile)) {
            await hooks?.afterActivate?.(provider);
          }
          return;
        }
        if (item.action === 'keepAliveNow') {
          const profile = await this.pickSaved(provider, `Send a ${TITLES[provider]} keep-alive now`);
          if (profile) { await hooks?.sendKeepAlive?.(provider, profile); }
        } else if (item.action === 'keepAlive' || item.action === 'autoRotate') {
          await this.setAutomationEnabled(provider, item.action, !this.automationEnabled(provider, item.action));
        } else if (item.action === 'save') {
          if (await this.saveCurrent(provider)) {
            await hooks?.afterActivate?.(provider);
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

  private items(provider: AuthProvider): ProfileItem[] {
    const providerState = this.state()[provider];
    const items: ProfileItem[] = providerState.profiles.map((profile) => ({
      label: `${profile.id === providerState.activeProfileId ? '$(check)' : '$(key)'} ${profile.name}`,
      description: profileDescription(profile, profile.id === providerState.activeProfileId),
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
    const threshold = vscode.workspace.getConfiguration().get<number>(`aiUsage.${provider}.autoRotate.thresholdPercent`, 99.5);
    items.push({ label: 'Account features', kind: vscode.QuickPickItemKind.Separator });
    if (providerState.profiles.length) {
      items.push({
        label: '$(play) Send keep-alive now…',
        detail: 'Choose a saved account, send its configured keep-alive prompt immediately, and refresh its usage statistics.',
        action: 'keepAliveNow'
      });
    }
    items.push({
      label: `${keepAlive ? '$(check)' : '$(pulse)'} Account keep-alive and usage collection`,
      description: keepAlive ? 'On' : 'Off',
      detail: 'Periodically checks every saved account, including inactive accounts. Configure the period, model and dedicated home in Settings.',
      action: 'keepAlive'
    });
    items.push({
      label: `${autoRotate ? '$(check)' : '$(sync)'} Automatic account rotation`,
      description: autoRotate ? `On · rotate at ${threshold}%` : `Off · enable rotation at ${threshold}%`,
      detail: `Switch to the next saved account below ${threshold}% in every usage window. Configure the threshold in Settings. Requires at least two saved accounts.`,
      action: 'autoRotate'
    });
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
    await this.recordEmail(provider, profile.id, credential);
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
        await this.recordEmail(provider, target.id, credential);
        this.log(`${provider}: updated authentication profile "${target.name}" from the current login`);
        void vscode.window.showInformationMessage(`${TITLES[provider]} profile “${target.name}” updated from the current login.`);
        return true;
      }
    }
    if (providerState.profiles.length >= MAX_PROFILES) {
      void vscode.window.showWarningMessage(`${TITLES[provider]} already has the maximum of ${MAX_PROFILES} saved profiles.`);
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
      verification = await this.verifyActivation?.(provider, credential);
    } catch (error) {
      verification = { status: 'unverified', detail: errorMessage(error) };
    }
    if (verification) {
      this.log(`${provider}: activation ${verification.status} — ${verification.detail}`);
    }
    if (verification?.status === 'mismatch') {
      void vscode.window.showErrorMessage(
        `AI Usage: ${TITLES[provider]} was switched to “${profile.name}”, but ${TITLES[provider]} reports a different login. ${verification.detail}`);
    } else {
      void vscode.window.showInformationMessage(activationMessage(provider, profile.name, automatic));
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
      if (!isSameCredentialOwner(provider, stored, native)) {
        return;
      }
      await this.storeSecret(provider, active.id, native);
      active.updatedAt = new Date().toISOString();
      await this.updateState(state);
      this.log(`${provider}: captured refreshed tokens for profile "${active.name}"`);
      if (!active.email) { await this.recordEmail(provider, active.id, native); }
    } catch {
      // A missing or temporarily incomplete native file must not prevent activating another profile.
    }
  }

  private async pickSaved(provider: AuthProvider, title: string): Promise<ProfileMetadata | undefined> {
    const picked = await vscode.window.showQuickPick(this.state()[provider].profiles.map((profile) => ({
      label: profile.name,
      description: profileDescription(profile, profile.id === this.activeProfileId(provider)),
      profile
    })), { title });
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
