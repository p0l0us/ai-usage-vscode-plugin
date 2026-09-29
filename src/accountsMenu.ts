import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AuthProvider, ImportPlanView, ProfileView, ProviderView, ServiceClient, ServiceConfig, explainAccountProblem, formatResetRemaining, nativeCredentialPath,
  parseCredentialJson, strategySummary
} from '../service/out';
import { ServiceManager } from './serviceManager';
import { openAiUsageSettings } from './settingsLink';

/**
 * The Accounts menus of both services, as before, but every action goes to the account service. The service
 * announces the outcome of switches and rotations through events, which the extension turns into notifications;
 * this class only reports failures of the action it asked for.
 */

const TITLES: Record<AuthProvider, string> = { claude: 'Claude', codex: 'Codex' };
const PROVIDERS: AuthProvider[] = ['claude', 'codex'];
const MAX_PROFILES = 20;

type ProfileItem = vscode.QuickPickItem & {
  profile?: ProfileView;
  /** Set when the profile has nothing left in any window; selecting it is a no-op warning, not an activation. */
  readOnly?: boolean;
  /** The login error of the profile's last check; selecting it sends a keep-alive instead of activating. */
  loginProblem?: string;
  action?: 'save' | 'import' | 'transfer' | 'signIn' | 'rename' | 'delete' | 'keepAliveNow' | 'settings' | 'serviceSettings' | 'service' | 'install' | 'back';
};

export type MenuHooks = {
  beforeActivate?: (provider: AuthProvider) => Promise<void>;
  /** The current login was saved into a profile; nothing started on a new account. */
  afterSaved?: (provider: AuthProvider) => Promise<void>;
  /** One chosen account, or every saved account in order when "All accounts" was picked. */
  sendKeepAlive: (provider: AuthProvider, profiles: ProfileView[]) => Promise<void>;
  /** Signs in again for a saved profile with the vendor CLI and stores the new login in it. */
  signIn: (provider: AuthProvider, profile: ProfileView) => Promise<void>;
  /** Where the menu's Back item leads, the AI Usage menu of every service; no Back item without it. */
  back?: (provider: AuthProvider) => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** Menu description: the account email, a duplicate marker, then the active marker. */
function profileDescription(profile: ProfileView, siblings: ProfileView[] = []): string | undefined {
  const twin = profile.email ? siblings.find((other) => other.id !== profile.id && other.email === profile.email) : undefined;
  return [profile.email, twin ? `duplicate of “${twin.name}”` : undefined, profile.active ? 'Active' : undefined].filter(Boolean).join(' · ') || undefined;
}

/** "5h: 41% (2h) · 7d: 7% (5d) · Checked 12:30 · $(warning) Insufficient credits", as the list shows under a profile. */
export function usageDetail(profile: ProfileView): string | undefined {
  const parts: string[] = [];
  if (profile.usage) {
    const now = new Date();
    parts.push(profile.usage.windows.map((window) => {
      const reset = formatResetRemaining(window.resetsAt ? new Date(window.resetsAt) : undefined, now);
      return `${window.label}: ${window.usedPercent}%${reset ? ` (${reset})` : ''}`;
    }).join(' · '));
    parts.push(`Checked ${new Date(profile.usage.fetchedAt).toLocaleString()}`);
  }
  // Known errors read as a few words ("Insufficient credits"); the vendor's own text stays in the log.
  const problems = new Set<string>();
  for (const problem of profile.problems) {
    problems.add(problem.known ? problem.label : `${problem.check === 'keepAlive' ? 'Keep-alive' : 'Usage check'} failed: ${problem.label}`);
  }
  parts.push(...[...problems].map((problem) => `$(warning) ${problem}`));
  return parts.join(' · ') || undefined;
}

function validName(value: string): string | undefined {
  const name = value.trim();
  if (!name) { return 'Enter a profile name.'; }
  if (name.length > 60) { return 'Use 60 characters or fewer.'; }
  return undefined;
}

export class AccountsMenu {
  constructor(private readonly services: ServiceManager, private readonly log: (message: string) => void) {}

  private async view(client: ServiceClient, provider: AuthProvider): Promise<ProviderView> {
    const view = await client.list(provider);
    this.services.views[provider] = view;
    return view;
  }

  async show(initialProvider?: AuthProvider, hooks?: MenuHooks): Promise<void> {
    const provider = initialProvider ?? await this.pickProvider();
    if (!provider) { return; }
    const client = this.services.connected ?? await this.services.ensure({ promptInstall: true });
    if (!client) {
      await this.showUnavailable(provider, hooks);
      return;
    }
    // Management actions return to the list. Choosing a profile activates it and closes the menu.
    while (true) {
      let view: ProviderView;
      try { view = await this.view(client, provider); }
      catch (error) { void vscode.window.showErrorMessage(`AI Usage: could not read the ${TITLES[provider]} accounts: ${errorMessage(error)}`); return; }
      const config = this.services.config ?? await client.getConfig();
      const item = await vscode.window.showQuickPick(this.items(view, config, Boolean(hooks?.back)), {
        title: `AI Usage · ${TITLES[provider]} accounts`,
        placeHolder: 'Choose a profile to activate, or manage saved profiles',
        matchOnDescription: true,
        matchOnDetail: true
      });
      if (!item) { return; }
      try {
        if (item.profile) {
          if (item.readOnly) {
            void vscode.window.showWarningMessage(`“${item.profile.name}” is at its usage limit and can't be activated until it resets.`);
            continue;
          }
          if (item.loginProblem) {
            // A login whose last check failed to authenticate is checked again rather than activated: the keep-alive
            // refreshes an expired token, and when the login is dead the hook offers a new sign-in instead.
            await hooks?.sendKeepAlive(provider, [item.profile]);
            continue;
          }
          await hooks?.beforeActivate?.(provider);
          // The service announces the outcome through its `activated` event; only a failure is reported here.
          await client.activate(provider, item.profile.id);
          return;
        }
        switch (item.action) {
          case 'back': await hooks?.back?.(provider); return;
          case 'keepAliveNow': {
            const profiles = await this.pickKeepAliveTargets(view);
            if (profiles.length) { await hooks?.sendKeepAlive(provider, profiles); }
            break;
          }
          case 'settings': case 'serviceSettings': await openAiUsageSettings(`aiUsage.${provider}`); return;
          case 'service': await this.services.showMenu(); return;
          case 'save':
            // Saving copies the login that is already active into a profile; no process starts using a new account.
            if (await this.saveCurrent(client, provider, view)) { await hooks?.afterSaved?.(provider); }
            break;
          case 'import': await this.importFile(client, provider, view); break;
          case 'transfer': await this.transferMenu(provider); break;
          case 'signIn': {
            const profile = await this.pickSaved(view, `Sign in again for a ${TITLES[provider]} profile`);
            if (profile) { await hooks?.signIn(provider, profile); }
            break;
          }
          case 'rename': await this.rename(client, provider, view); break;
          case 'delete': await this.delete(client, provider, view); break;
          default: break;
        }
      } catch (error) {
        this.log(`${provider}: authentication profile operation failed: ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(`AI Usage: authentication profile operation failed: ${errorMessage(error)}`);
      }
    }
  }

  /** The menu while the service is off, not installed or not answering. */
  private async showUnavailable(provider: AuthProvider, hooks?: MenuHooks): Promise<void> {
    const items: ProfileItem[] = [];
    if (!this.services.enabled) {
      items.push({ label: '$(circle-slash) The account service is turned off', detail: 'Accounts, keep-alives and rotation need it. Turn aiUsage.accountService.enabled on to use them.' });
      items.push({ label: '$(gear) Open the setting', action: 'service' });
    } else if (!this.services.isInstalled()) {
      items.push({ label: '$(cloud-download) Install the account service…', detail: 'Saved profiles, keep-alives and rotation move to a background service that also runs while VS Code is closed, controlled here and by the ai-usage command.', action: 'install' });
    } else {
      items.push({ label: '$(debug-start) Connect to the account service…', detail: 'The service is installed but not answering; this starts it and connects.', action: 'install' });
      items.push({ label: '$(server-process) Account service status…', action: 'service' });
    }
    if (hooks?.back) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: '$(arrow-left) Back', description: 'AI Usage menu of all services', action: 'back' });
    }
    const picked = await vscode.window.showQuickPick(items, { title: `AI Usage · ${TITLES[provider]} accounts`, matchOnDetail: true });
    if (picked?.action === 'install') {
      if (!this.services.isInstalled()) { await this.services.install(); }
      else if (!await this.services.ensure()) { await this.services.showMenu(); return; }
      if (this.services.connected) { await this.show(provider, hooks); }
    } else if (picked?.action === 'service') {
      await this.services.showMenu();
    } else if (picked?.action === 'back') {
      await hooks?.back?.(provider);
    }
  }

  private async pickProvider(): Promise<AuthProvider | undefined> {
    const count = (provider: AuthProvider) => this.services.views[provider]?.profiles.length;
    const picked = await vscode.window.showQuickPick([
      { label: '$(claude) Claude', description: count('claude') === undefined ? undefined : `${count('claude')}/${MAX_PROFILES} profiles`, provider: 'claude' as const },
      { label: '$(openai) Codex', description: count('codex') === undefined ? undefined : `${count('codex')}/${MAX_PROFILES} profiles`, provider: 'codex' as const }
    ], { title: 'AI Usage · Authentication profiles', placeHolder: 'Choose a service' });
    return picked?.provider;
  }

  private items(view: ProviderView, config: ServiceConfig, withBack = false): ProfileItem[] {
    const provider = view.provider;
    const items: ProfileItem[] = view.profiles.map((profile) => {
      // An exhausted account cannot be activated anyway, so its login trouble waits until the window resets.
      const loginProblem = profile.limit.readOnly ? undefined : profile.loginProblem;
      const icon = profile.active ? 'check' : 'key';
      return {
        label: profile.limit.readOnly ? `$(circle-slash) ${profile.name}` : profile.limit.dimmed || loginProblem ? profile.name : `$(${icon}) ${profile.name}`,
        iconPath: loginProblem ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'))
          : profile.limit.dimmed ? new vscode.ThemeIcon(icon, new vscode.ThemeColor('disabledForeground')) : undefined,
        description: [profileDescription(profile, view.profiles),
          profile.limit.readOnly ? 'At its usage limit' : profile.limit.dimmed ? 'Fable limit reached' : undefined,
          loginProblem ? 'Login problem' : undefined].filter(Boolean).join(' · ') || undefined,
        detail: usageDetail(profile) ?? `Saved ${new Date(profile.updatedAt).toLocaleString()} · Usage not checked yet`,
        profile,
        readOnly: profile.limit.readOnly,
        loginProblem
      };
    });
    if (!items.length) {
      items.push({ label: 'No profiles saved yet', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({ label: 'Manage', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(save) Save current login…', detail: `Create a profile or replace an existing profile from ${nativeCredentialPath(provider)}.`, action: 'save' });
    items.push({ label: '$(file-code) Import credential JSON…', detail: 'Imports a credential file into the account service without activating it.', action: 'import' });
    items.push({ label: '$(arrow-swap) Export or import saved profiles…', detail: 'Moves the saved Claude and Codex profiles, logins included, to or from another computer through a JSON file.', action: 'transfer' });
    if (view.profiles.length) {
      items.push({ label: '$(sign-in) Sign in again…', detail: `Runs the ${TITLES[provider]} CLI login in a terminal with a separate home and stores the new login in a saved profile. The active login is replaced only when that profile is the active one.`, action: 'signIn' });
      items.push({ label: '$(edit) Rename a profile…', action: 'rename' });
      items.push({ label: '$(trash) Delete a saved profile…', action: 'delete' });
    }
    items.push({ label: 'Account features', kind: vscode.QuickPickItemKind.Separator });
    if (view.profiles.length) {
      items.push({ label: '$(play) Send keep-alive now…', detail: 'Choose a saved account, or all of them, send the configured keep-alive prompt immediately, and refresh usage statistics.', action: 'keepAliveNow' });
    }
    items.push({
      label: '$(gear) Keep-alive and rotation settings…',
      description: `Keep-alive ${view.keepAlive ? 'on' : 'off'} · rotation ${view.autoRotate ? `on (${strategySummary(config, provider)})` : 'off'}`,
      detail: `Opens Settings: turn periodic checks of every saved ${TITLES[provider]} account and automatic rotation on or off, and set the period, model, rotation strategy and thresholds, and dedicated home. The account service applies them, also while VS Code is closed.`,
      action: 'settings'
    });
    items.push({ label: `$(settings-gear) ${TITLES[provider]} settings…`, description: `aiUsage.${provider}.*`, detail: `Opens Settings on every ${TITLES[provider]} setting, including the ${TITLES[provider]} config section.`, action: 'serviceSettings' });
    items.push({ label: '$(server-process) Account service…', detail: `Status of the background service, its log and the ai-usage command. Version ${this.services.connected?.info.version ?? '?'}.`, action: 'service' });
    if (withBack) {
      // Last, so the active profile stays the first, preselected item.
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: '$(arrow-left) Back', description: 'AI Usage menu of all services', action: 'back' });
    }
    return items;
  }

  private async askName(view: ProviderView, prompt: string, current?: string): Promise<string | undefined> {
    const names = view.profiles.filter((profile) => profile.name !== current).map((profile) => profile.name.toLowerCase());
    const value = await vscode.window.showInputBox({
      title: `${TITLES[view.provider]} authentication profile`,
      prompt,
      value: current,
      ignoreFocusOut: true,
      validateInput: (input) => validName(input) ?? (names.includes(input.trim().toLowerCase()) ? 'That profile name already exists.' : undefined)
    });
    return value?.trim() || undefined;
  }

  private async saveCurrent(client: ServiceClient, provider: AuthProvider, view: ProviderView): Promise<boolean> {
    if (view.profiles.length) {
      const canCreate = view.profiles.length < MAX_PROFILES;
      const picked = await vscode.window.showQuickPick([
        ...(canCreate ? [{ label: '$(add) Create a new profile…', detail: 'Save the current native login under a new name.', create: true as const }] : []),
        { label: 'Update an existing profile', kind: vscode.QuickPickItemKind.Separator },
        ...view.profiles.map((profile) => ({ label: `$(save) ${profile.name}`, description: profileDescription(profile), detail: 'Replace this profile with the current native login.', profile }))
      ], {
        title: `${TITLES[provider]} · Save current login`,
        placeHolder: canCreate ? 'Create a profile or update an existing one' : `Choose a profile to update (${MAX_PROFILES}/${MAX_PROFILES})`
      });
      if (!picked) { return false; }
      if ('profile' in picked && picked.profile) {
        const result = await client.saveNative(provider, { id: picked.profile.id });
        if (result.status === 'duplicate') { return false; }
        void vscode.window.showInformationMessage(`${TITLES[provider]} profile “${result.profile.name}” updated from the current login.`);
        return true;
      }
    }
    if (view.profiles.length >= MAX_PROFILES) {
      void vscode.window.showWarningMessage(`${TITLES[provider]} already has the maximum of ${MAX_PROFILES} saved profiles.`);
      return false;
    }
    const name = await this.askName(view, 'Name the login that is currently active.');
    if (!name) { return false; }
    let result = await client.saveNative(provider, { name });
    if (result.status === 'duplicate') {
      const choice = await vscode.window.showWarningMessage(result.warning, { modal: true }, 'Save a copy anyway');
      if (choice !== 'Save a copy anyway') { return false; }
      result = await client.saveNative(provider, { name, allowDuplicate: true });
      if (result.status === 'duplicate') { return false; }
    }
    void vscode.window.showInformationMessage(`${TITLES[provider]} login saved as “${result.profile.name}”.`);
    return true;
  }

  private async importFile(client: ServiceClient, provider: AuthProvider, view: ProviderView): Promise<void> {
    if (view.profiles.length >= MAX_PROFILES) {
      void vscode.window.showWarningMessage(`${TITLES[provider]} already has the maximum of ${MAX_PROFILES} saved profiles.`);
      return;
    }
    const selected = await vscode.window.showOpenDialog({ title: `Import ${TITLES[provider]} credential JSON`, canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { JSON: ['json'] }, openLabel: 'Import' });
    if (!selected?.[0]) { return; }
    let credential;
    try {
      const bytes = await vscode.workspace.fs.readFile(selected[0]);
      credential = parseCredentialJson(provider, Buffer.from(bytes).toString('utf8'));
    } catch (error) {
      void vscode.window.showErrorMessage(`AI Usage: could not import the credential: ${errorMessage(error)}`);
      return;
    }
    const name = await this.askName(view, 'Name the imported login.');
    if (!name) { return; }
    let result = await client.importCredential(provider, name, credential);
    if (result.status === 'duplicate') {
      const choice = await vscode.window.showWarningMessage(result.warning, { modal: true }, 'Save a copy anyway');
      if (choice !== 'Save a copy anyway') { return; }
      result = await client.importCredential(provider, name, credential, true);
      if (result.status === 'duplicate') { return; }
    }
    void vscode.window.showInformationMessage(`${TITLES[provider]} credential imported as “${result.profile.name}”. Choose it from the profile menu to activate it.`);
  }

  /** The export and the import behind one Accounts menu item; Back and cancel return to the accounts list. */
  private async transferMenu(provider: AuthProvider): Promise<void> {
    const items: Array<vscode.QuickPickItem & { action?: 'export' | 'import' }> = [];
    if (PROVIDERS.some((candidate) => this.services.views[candidate]?.profiles.length)) {
      items.push({ label: '$(export) Export saved profiles…', detail: 'Writes the saved Claude and Codex profiles, logins included, to a JSON file for AI Usage on another computer.', action: 'export' });
    }
    items.push({ label: '$(cloud-download) Import saved profiles…', detail: 'Adds the profiles from a file exported by AI Usage elsewhere, and restores the logins of profiles saved here that have none.', action: 'import' });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(arrow-left) Back', description: `${TITLES[provider]} accounts` });
    const picked = await vscode.window.showQuickPick(items, { title: 'AI Usage · Export or import saved profiles', matchOnDetail: true });
    if (picked?.action === 'export') { await this.exportProfiles(); }
    if (picked?.action === 'import') { await this.importProfiles(); }
  }

  /** Writes the chosen saved profiles of both services, logins included, to a JSON file for AI Usage on another computer. */
  async exportProfiles(): Promise<boolean> {
    const client = this.services.require();
    const items: Array<vscode.QuickPickItem & { entry?: { provider: AuthProvider; id: string } }> = [];
    for (const provider of PROVIDERS) {
      const view = await this.view(client, provider);
      if (!view.profiles.length) { continue; }
      items.push({ label: TITLES[provider], kind: vscode.QuickPickItemKind.Separator });
      for (const profile of view.profiles) {
        items.push({ label: profile.name, description: profileDescription(profile, view.profiles), picked: profile.hasCredential, entry: { provider, id: profile.id } });
      }
    }
    if (!items.some((item) => item.entry)) {
      void vscode.window.showInformationMessage('AI Usage: no Claude or Codex profiles are saved yet, so there is nothing to export.');
      return false;
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: 'AI Usage · Export saved profiles',
      placeHolder: 'The chosen profiles are written with their logins; deselect any to leave out',
      canPickMany: true,
      matchOnDescription: true
    });
    const selection = picked?.flatMap((item) => item.entry ? [item.entry] : []) ?? [];
    if (!selection.length) { return false; }
    const target = await vscode.window.showSaveDialog({ title: 'Export saved AI Usage profiles', defaultUri: vscode.Uri.file(path.join(os.homedir(), 'ai-usage-profiles.json')), filters: { JSON: ['json'] }, saveLabel: 'Export' });
    if (!target) { return false; }
    const result = await client.exportProfiles(selection);
    if (!result.entries.length) {
      void vscode.window.showInformationMessage(`AI Usage: no login is saved for ${result.missing.join(', ')}, so there is nothing to export.`);
      return false;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(result.text, 'utf8'));
    if (target.scheme === 'file' && process.platform !== 'win32') {
      try { fs.chmodSync(target.fsPath, 0o600); } catch { /* A file system without modes, such as some mounts. */ }
    }
    this.log(`exported ${result.entries.length} authentication profiles to ${target.toString()}`);
    // Opened right away, so the content can be checked or copied to the other computer from the editor.
    try { await vscode.window.showTextDocument(target, { preview: false }); } catch (error) { this.log(`could not open the export: ${errorMessage(error)}`); }
    void vscode.window.showWarningMessage(
      `AI Usage: exported ${plural(result.entries.length, 'profile')} to ${target.fsPath}. The file holds their login tokens in plain text: import it on the other computer, then delete it.` +
      (result.missing.length ? ` Skipped, no login saved: ${result.missing.join(', ')}.` : ''));
    return true;
  }

  /** Reads an export made elsewhere and shows what each entry would do before anything is written. Nothing is activated. */
  async importProfiles(): Promise<boolean> {
    const client = this.services.require();
    const selected = await vscode.window.showOpenDialog({ title: 'Import saved AI Usage profiles', canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { JSON: ['json'] }, openLabel: 'Import' });
    if (!selected?.[0]) { return false; }
    let text: string;
    let plans: ImportPlanView[];
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(selected[0])).toString('utf8');
      plans = await client.planImport(text);
    } catch (error) {
      void vscode.window.showErrorMessage(`AI Usage: could not import the profiles: ${errorMessage(error)}`);
      return false;
    }
    if (!plans.length) {
      void vscode.window.showInformationMessage('AI Usage: the export holds no profiles.');
      return false;
    }
    const items: Array<vscode.QuickPickItem & { plan?: ImportPlanView }> = [];
    for (const provider of PROVIDERS) {
      const own = plans.filter((plan) => plan.provider === provider);
      if (!own.length) { continue; }
      items.push({ label: TITLES[provider], kind: vscode.QuickPickItemKind.Separator });
      items.push(...own.map((plan) => ({ label: plan.name, description: [plan.email, plan.outcome].filter(Boolean).join(' · '), picked: plan.suggested, plan })));
    }
    const picked = await vscode.window.showQuickPick(items, { title: 'AI Usage · Import saved profiles', placeHolder: 'Choose the profiles to add or restore; nothing is activated', canPickMany: true, matchOnDescription: true });
    const chosen = picked?.flatMap((item) => item.plan ? [item.plan] : []) ?? [];
    if (!chosen.length) { return false; }
    let summary;
    try {
      summary = await client.applyImport(text, chosen.map((plan) => ({ provider: plan.provider, id: plan.id })));
    } catch (error) {
      void vscode.window.showWarningMessage(`AI Usage: ${errorMessage(error)} Deselect some and import again.`);
      return false;
    }
    void vscode.window.showInformationMessage(`AI Usage: imported ${plural(summary.imported, 'profile')}: ${summary.summary}. Nothing was activated; choose a profile from its Accounts menu to use it.`);
    return true;
  }

  /** Undefined when cancelled or on Back, which both return to the accounts list. */
  private async pickSaved(view: ProviderView, title: string): Promise<ProfileView | undefined> {
    const items: Array<vscode.QuickPickItem & { profile?: ProfileView }> = view.profiles.map((profile) => ({
      label: profile.name,
      description: [profileDescription(profile), profile.loginProblem ? 'Login problem' : undefined].filter(Boolean).join(' · ') || undefined,
      profile
    }));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(arrow-left) Back', description: `${TITLES[view.provider]} accounts` });
    const picked = await vscode.window.showQuickPick(items, { title });
    return picked?.profile;
  }

  /** Like `pickSaved`, with an extra "All accounts" entry on top; empty when nothing was picked. */
  private async pickKeepAliveTargets(view: ProviderView): Promise<ProfileView[]> {
    const items: Array<vscode.QuickPickItem & { profiles?: ProfileView[] }> = [];
    if (view.profiles.length > 1) {
      items.push({ label: '$(run-all) All accounts', description: `${view.profiles.length} saved accounts, one by one`, profiles: view.profiles });
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push(...view.profiles.map((profile) => ({ label: profile.name, description: profileDescription(profile), profiles: [profile] })));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(arrow-left) Back', description: `${TITLES[view.provider]} accounts` });
    const picked = await vscode.window.showQuickPick(items, { title: `Send a ${TITLES[view.provider]} keep-alive now` });
    return picked?.profiles ?? [];
  }

  private async rename(client: ServiceClient, provider: AuthProvider, view: ProviderView): Promise<void> {
    const profile = await this.pickSaved(view, `Rename a ${TITLES[provider]} profile`);
    if (!profile) { return; }
    const name = await this.askName(view, 'Enter the new profile name.', profile.name);
    if (!name || name === profile.name) { return; }
    await client.rename(provider, profile.id, name);
  }

  private async delete(client: ServiceClient, provider: AuthProvider, view: ProviderView): Promise<void> {
    const profile = await this.pickSaved(view, `Delete a saved ${TITLES[provider]} profile`);
    if (!profile) { return; }
    const choice = await vscode.window.showWarningMessage(
      `Delete the saved profile “${profile.name}”?${profile.active ? ' The native login remains active until you switch or sign out.' : ''}`,
      { modal: true }, 'Delete');
    if (choice !== 'Delete') { return; }
    await client.delete(provider, profile.id);
  }
}

/** Short problem text for a menu row or notification. */
export function problemLabel(raw: string): string {
  return explainAccountProblem(raw).label;
}
