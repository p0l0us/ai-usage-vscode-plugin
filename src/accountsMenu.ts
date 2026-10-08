import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AuthProvider, ImportPlanView, LiveUsage, ProfileView, ProviderView, ServiceClient, ServiceConfig, deserializeUsage,
  explainAccountProblem, formatEarnedResets, formatResetRemaining, nativeCredentialPath, newestValidUsage, parseCredentialJson, strategySummary
} from '../service/out';
import { MCP_SERVER_NAME, McpRegistration } from './mcpRegistration';
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
  /** The login error of the profile's last check; selecting it offers to renew the login or check it again instead of activating. */
  loginProblem?: string;
  action?: 'save' | 'manage' | 'keepAliveNow' | 'registerMcp' | 'settings' | 'serviceSettings' | 'service' | 'install' | 'back';
};

export type MenuHooks = {
  /** Current status bar reading for the selected account, when fresher than the service's reading. */
  activeUsage?: (provider: AuthProvider, id: string) => LiveUsage | undefined;
  beforeActivate?: (provider: AuthProvider) => Promise<void>;
  /** The current login was saved into a profile; nothing started on a new account. */
  afterSaved?: (provider: AuthProvider) => Promise<void>;
  /** One chosen account, or every saved account in order when "All accounts" was picked. */
  sendKeepAlive: (provider: AuthProvider, profiles: ProfileView[]) => Promise<void>;
  /** Signs in again for a saved profile with the vendor CLI and stores the new login in it. */
  signIn: (provider: AuthProvider, profile: ProfileView) => Promise<void>;
  /** Where the menu's Back item leads, the AI Usage menu of every service; no Back item without it. */
  back?: (provider: AuthProvider) => Promise<void>;
  /** What the provider's CLI has registered for the service's MCP server, shown beside the menu item. */
  mcpRegistration?: (provider: AuthProvider) => McpRegistration | undefined | Promise<McpRegistration | undefined>;
  /** Registers the service's MCP server with the provider's CLI; the item is offered only while `mcp.enabled` is on and this hook exists. */
  registerMcp?: (provider: AuthProvider) => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** Menu description: the account email, the project for a project profile, a duplicate marker, then the active marker. */
function profileDescription(profile: ProfileView, siblings: ProfileView[] = []): string | undefined {
  const twin = profile.email ? siblings.find((other) => other.id !== profile.id && other.email === profile.email) : undefined;
  return [profile.email, profile.folder ? `project ${path.basename(profile.folder)}` : undefined,
    twin ? `duplicate of “${twin.name}”` : undefined, profile.active ? 'Active' : undefined].filter(Boolean).join(' · ') || undefined;
}

/**
 * Where a new profile is kept: privately, in the service's profile file, or in one of the open project folders'
 * files. Asked only when both kinds are enabled and a local folder is open; otherwise the only possible kind is
 * used. Undefined when cancelled.
 */
export async function pickScope(view: ProviderView): Promise<{ folder?: string } | undefined> {
  const { privateEnabled, projectEnabled, folders } = view.scopes;
  const projects = projectEnabled ? folders : [];
  if (!projects.length) { return {}; }
  if (!privateEnabled && projects.length === 1) { return { folder: projects[0] }; }
  const items: Array<vscode.QuickPickItem & { folder?: string }> = [];
  if (privateEnabled) {
    items.push({ label: '$(account) Private profile', detail: 'Kept by the account service in ~/.ai-usage/profiles.json and listed in every window on this host.' });
  }
  items.push(...projects.map((folder) => ({
    label: `$(root-folder) Project profile${projects.length > 1 ? ` in ${path.basename(folder)}` : ''}`,
    detail: `Kept, login included, in the profile file of ${folder} and listed whenever that folder is open.`,
    folder
  })));
  const picked = await vscode.window.showQuickPick(items, { title: 'AI Usage · Where to keep the profile', placeHolder: 'Private, or in a project folder' });
  return picked ? { folder: picked.folder } : undefined;
}

/** "5h: 41% (2h) · 7d: 7% (5d) · Checked 12:30 · $(warning) Insufficient credits", as the list shows under a profile. */
export function usageDetail(profile: ProfileView, displayedUsage?: LiveUsage): string | undefined {
  const parts: string[] = [];
  const stored = profile.usage ? deserializeUsage({ usage: profile.usage }) : undefined;
  const usage = newestValidUsage(stored, displayedUsage);
  if (stored && !usage) { parts.push('Usage reset; waiting for a new reading'); }
  if (usage) {
    const now = new Date();
    parts.push(usage.windows.map((window) => {
      const reset = formatResetRemaining(window.resetsAt, now);
      return `${window.label}: ${window.usedPercent}%${reset ? ` (${reset})` : ''}`;
    }).join(' · '));
    if (usage.provider === 'codex') {
      const credits = usage.resetCredits ?? stored?.resetCredits;
      const line = formatEarnedResets(credits, stored?.resetCredits?.totalCount);
      if (line) {
        const expiry = credits?.earliestExpiresAt ? formatResetRemaining(new Date(credits.earliestExpiresAt * 1000), now) : '';
        parts.push(`Earned resets: ${line}${expiry ? ` (next expires in ${expiry})` : ''}`);
      }
    }
    parts.push(`Checked ${usage.fetchedAt.toLocaleString()}`);
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
      const mcp = config.mcp.enabled && hooks?.registerMcp ? { registration: await hooks.mcpRegistration?.(provider) } : undefined;
      const item = await vscode.window.showQuickPick(this.items(view, config, Boolean(hooks?.back), mcp, hooks?.activeUsage), {
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
            // A login whose last check failed to authenticate is not activated right away; the user chooses between
            // renewing it with a new sign-in, checking it again with a keep-alive, which refreshes an expired
            // token, and activating it as it is.
            const choice = await this.loginProblemMenu(provider, item.profile, item.loginProblem);
            if (choice === 'renew') { await hooks?.signIn(provider, item.profile); continue; }
            if (choice === 'keepAlive') { await hooks?.sendKeepAlive(provider, [item.profile]); continue; }
            if (choice !== 'select') { continue; }
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
          case 'registerMcp': await hooks?.registerMcp?.(provider); break;
          case 'settings': case 'serviceSettings': await openAiUsageSettings(`aiUsage.${provider}`); return;
          case 'service': await this.services.showMenu({ description: `${TITLES[provider]} accounts`, run: () => this.show(provider, hooks) }); return;
          case 'save':
            // Saving copies the login that is already active into a profile; no process starts using a new account.
            if (await this.saveCurrent(client, provider, view)) { await hooks?.afterSaved?.(provider); }
            break;
          case 'manage': await this.manageMenu(client, provider, hooks); break;
          default: break;
        }
      } catch (error) {
        this.log(`${provider}: authentication profile operation failed: ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(`AI Usage: authentication profile operation failed: ${errorMessage(error)}`);
      }
    }
  }

  /** The menu while accounts are turned off, or the service neither answers nor could be hosted in this window. */
  private async showUnavailable(provider: AuthProvider, hooks?: MenuHooks): Promise<void> {
    const items: ProfileItem[] = [];
    if (!this.services.enabled) {
      items.push({ label: '$(circle-slash) Accounts are turned off', detail: 'Saved profiles, keep-alives and rotation need the account service. Turn aiUsage.accountService.enabled on to use them.' });
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
      else if (!await this.services.ensure()) { await this.services.showMenu({ description: `${TITLES[provider]} accounts`, run: () => this.show(provider, hooks) }); return; }
      if (this.services.connected) { await this.show(provider, hooks); }
    } else if (picked?.action === 'service') {
      await this.services.showMenu({ description: `${TITLES[provider]} accounts`, run: () => this.show(provider, hooks) });
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

  /** `mcp` is given while the MCP server is on and the menu can register it with the CLI; it carries the CLI's current entry. */
  private items(view: ProviderView, config: ServiceConfig, withBack = false, mcp?: { registration?: McpRegistration }, activeUsage?: MenuHooks['activeUsage']): ProfileItem[] {
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
        detail: usageDetail(profile, profile.active ? activeUsage?.(provider, profile.id) : undefined) ?? `Saved ${new Date(profile.updatedAt).toLocaleString()} · Usage not checked yet`,
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
    items.push({ label: '$(tools) Manage saved profiles…', detail: 'Import, export, sign in again, rename, reorder, or delete profiles.', action: 'manage' });
    items.push({ label: 'Account features', kind: vscode.QuickPickItemKind.Separator });
    if (view.profiles.length) {
      items.push({ label: '$(play) Send keep-alive now…', detail: 'Choose a saved account, or all of them, send the configured keep-alive prompt immediately, and refresh usage statistics.', action: 'keepAliveNow' });
    }
    if (mcp) {
      const registration = mcp.registration;
      items.push({
        label: `$(plug) Register the MCP server with the ${TITLES[provider]} CLI…`,
        description: !registration ? undefined : registration.current ? 'Registered' : registration.registered ? 'Registered with another command' : 'Not registered',
        detail: `Runs “${provider} mcp add ${MCP_SERVER_NAME}” for the account service's launcher, so ${TITLES[provider]} in a terminal gets the “${MCP_SERVER_NAME}” tools: the saved accounts with their usage, a fresh reading, and a switch or rotation when agents may switch. Agents in this VS Code window see the server already.`,
        action: 'registerMcp'
      });
    }
    items.push({
      label: '$(gear) Keep-alive and rotation settings…',
      description: `Keep-alive ${view.keepAlive ? 'on' : 'off'} · rotation ${view.autoRotate ? `on (${strategySummary(config, provider)})` : 'off'}${provider === 'codex' ? ` · earned resets ${config.codex.autoReset.enabled ? 'on' : 'off'}` : ''}`,
      detail: `Opens Settings: turn periodic checks of every saved ${TITLES[provider]} account and automatic rotation on or off, and set the period, model, rotation strategy and thresholds${provider === 'codex' ? ', earned-reset redemption' : ''}, and dedicated home. The account service applies them, also while VS Code is closed.`,
      action: 'settings'
    });
    items.push({ label: `$(settings-gear) ${TITLES[provider]} settings…`, description: `aiUsage.${provider}.*`, detail: `Opens Settings on every ${TITLES[provider]} setting, including the ${TITLES[provider]} config section.`, action: 'serviceSettings' });
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
    const scope = await pickScope(view);
    if (!scope) { return false; }
    let result = await client.saveNative(provider, { name, folder: scope.folder });
    if (result.status === 'duplicate') {
      const choice = await vscode.window.showWarningMessage(result.warning, { modal: true }, 'Save a copy anyway');
      if (choice !== 'Save a copy anyway') { return false; }
      result = await client.saveNative(provider, { name, allowDuplicate: true, folder: scope.folder });
      if (result.status === 'duplicate') { return false; }
    }
    void vscode.window.showInformationMessage(`${TITLES[provider]} login saved as “${result.profile.name}”${scope.folder ? ` in project ${path.basename(scope.folder)}` : ''}.`);
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
    const scope = await pickScope(view);
    if (!scope) { return; }
    let result = await client.importCredential(provider, name, credential, false, scope.folder);
    if (result.status === 'duplicate') {
      const choice = await vscode.window.showWarningMessage(result.warning, { modal: true }, 'Save a copy anyway');
      if (choice !== 'Save a copy anyway') { return; }
      result = await client.importCredential(provider, name, credential, true, scope.folder);
      if (result.status === 'duplicate') { return; }
    }
    void vscode.window.showInformationMessage(`${TITLES[provider]} credential imported as “${result.profile.name}”${scope.folder ? ` in project ${path.basename(scope.folder)}` : ''}. Choose it from the profile menu to activate it.`);
  }

  /** Management actions return here; Back returns to the Accounts menu. */
  private async manageMenu(client: ServiceClient, provider: AuthProvider, hooks?: MenuHooks): Promise<void> {
    type Action = 'importCredential' | 'transfer' | 'signIn' | 'rename' | 'reorder' | 'delete';
    while (true) {
      const view = await this.view(client, provider);
      const items: Array<vscode.QuickPickItem & { action?: Action }> = [
        { label: '$(file-code) Import credential JSON…', detail: `Imports a credential file into the account service${view.scopes.projectEnabled && view.scopes.folders.length ? ', privately or into an open project,' : ''} without activating it.`, action: 'importCredential' },
        { label: '$(arrow-swap) Export or import saved profiles…', detail: 'Moves saved Claude and Codex profiles, logins included, through a JSON file.', action: 'transfer' }
      ];
      if (view.profiles.length) {
        items.push({ label: '$(sign-in) Sign in again…', detail: `Runs the ${TITLES[provider]} CLI login in a separate home and stores the new login in a saved profile.`, action: 'signIn' });
        items.push({ label: '$(edit) Rename a profile…', action: 'rename' });
        if (view.profiles.length > 1) {
          items.push({ label: '$(list-ordered) Move a profile up or down…', detail: 'Changes the order of saved profiles in the Accounts menu and in rotation.', action: 'reorder' });
        }
        items.push({ label: '$(trash) Delete a saved profile…', action: 'delete' });
      }
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: '$(arrow-left) Back', description: `${TITLES[provider]} accounts` });
      const picked = await vscode.window.showQuickPick(items, { title: `AI Usage · Manage saved ${TITLES[provider]} profiles`, matchOnDetail: true });
      if (!picked?.action) { return; }
      switch (picked.action) {
        case 'importCredential': await this.importFile(client, provider, view); break;
        case 'transfer': await this.transferMenu(provider); break;
        case 'signIn': {
          const profile = await this.pickSaved(view, `Sign in again for a ${TITLES[provider]} profile`);
          if (profile) { await hooks?.signIn(provider, profile); }
          break;
        }
        case 'rename': await this.rename(client, provider, view); break;
        case 'reorder': await this.reorder(client, provider, view); break;
        case 'delete': await this.delete(client, provider, view); break;
      }
    }
  }

  /** The export and the import behind one management item; Back and cancel return to management. */
  private async transferMenu(provider: AuthProvider): Promise<void> {
    const items: Array<vscode.QuickPickItem & { action?: 'export' | 'import' }> = [];
    if (PROVIDERS.some((candidate) => this.services.views[candidate]?.profiles.length)) {
      items.push({ label: '$(export) Export saved profiles…', detail: 'Writes the saved Claude and Codex profiles, logins included, to a JSON file for AI Usage on another computer.', action: 'export' });
    }
    items.push({ label: '$(cloud-download) Import saved profiles…', detail: 'Adds the profiles from a file exported by AI Usage elsewhere, and restores the logins of profiles saved here that have none.', action: 'import' });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(arrow-left) Back', description: 'Manage saved profiles' });
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

  /**
   * What to do about a profile whose last check failed to authenticate: renew the login by signing in again in a
   * folder inside the keep-alive home, send a keep-alive to check it again, activate it as it is, or go back to
   * the accounts list. Undefined on Back or when the menu was dismissed.
   */
  private async loginProblemMenu(provider: AuthProvider, profile: ProfileView, problem: string): Promise<'renew' | 'keepAlive' | 'select' | undefined> {
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

  private async reorder(client: ServiceClient, provider: AuthProvider, view: ProviderView): Promise<void> {
    const chosen = await this.pickSaved(view, `Move a ${TITLES[provider]} profile`);
    if (!chosen) { return; }
    while (true) {
      view = await this.view(client, provider);
      const peers = view.profiles.filter((profile) => profile.folder === chosen.folder);
      const at = peers.findIndex((profile) => profile.id === chosen.id);
      if (at < 0) { return; }
      const items: Array<vscode.QuickPickItem & { step?: -1 | 1 }> = [];
      if (at > 0) { items.push({ label: '$(arrow-up) Move up', description: `above “${peers[at - 1].name}”`, step: -1 }); }
      if (at < peers.length - 1) { items.push({ label: '$(arrow-down) Move down', description: `below “${peers[at + 1].name}”`, step: 1 }); }
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: '$(check) Done', description: `${TITLES[provider]} accounts` });
      const picked = await vscode.window.showQuickPick(items, {
        title: `AI Usage · Move “${chosen.name}”`,
        placeHolder: `Position ${at + 1} of ${peers.length}: ${peers.map((profile) => profile.name).join(', ')}`
      });
      if (!picked?.step) { return; }
      await client.reorder(provider, chosen.id, picked.step);
    }
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
