import { configFromSettings } from './configSync';
import { readServiceUsage, rotationTooltipLines } from './usageClient';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { configureBridgeService, registerBridgeIntegration } from './bridgeIntegration';
import { registerBridgeModels } from './bridgeModels';
import {
  RotationDiagnostics,
  configKeys,
  projectResetCredits,
  usageSettings,
  ActivationChange,
  AuthProvider,
  GitHubAccount,
  KeepAliveAllResult,
  KeepAliveResult,
  LiveResult,
  LiveUsage,
  ProviderId,
  ServiceEvent,
  activationMessage,
  deserializeUsage,
  formatResetIn,
  formatResetRemaining,
  formatEarnedResets,
  needsSignIn,
  readableProblem,
} from '../service/out';
import { AccountsMenu } from './accountsMenu';
import { signInWithTerminal } from './accountLogin';
import { registerMcpProvider } from './mcpProvider';
import { MCP_SERVER_NAME } from './mcpRegistration';
import { ServiceManager } from './serviceManager';
import { openAiUsageSettings } from './settingsLink';
import { compactTokenCount, SessionTokenUsage } from './sessionTokens';
import { formatUsagePercent, formatEarnedResetCount } from './usageFormatting';
import { CODEX_EARNED_RESETS_SETTING, codexUsageSettingsChanged } from './statusBarSettings';

type BillingPeriod = 'daily' | 'weekly' | 'monthly';

type AccountUsage = {
  name: string;
  period: BillingPeriod;
  usedTokens: number;
  tokenLimit: number;
  usedBudget: number;
  budgetLimit: number;
};

const WARNING_PERCENT = 80;
const ERROR_PERCENT = 95;

/** Prefix of the chat chip commands generated into package.json (see scripts/generate-manifest.js). */
const CHIP_COMMAND_PREFIX = 'aiUsage.chip.';
const CHAT_TOKEN_COMMAND_PREFIX = 'aiUsage.chatTokens.chip.';
/** Window labels with generated rich-mode chip commands per provider (keep in sync with the generator). */
const CHIP_WINDOWS: Record<ProviderId, string[]> = { claude: ['5h', '7d'], codex: ['5h', '7d'], copilot: [] };

/** What precedes the figures: nothing, the service name, the vendor icon, or both. */
type LabelStyle = 'none' | 'nameOnly' | 'iconOnly' | 'iconAndName';
/** `simple`: the most used window; `rich`: every window. Parentheses show time until reset. */
type UsageStyle = 'simple' | 'rich';

function statusBarStyle(): { labels: LabelStyle; usage: UsageStyle } {
  const config = vscode.workspace.getConfiguration();
  return {
    labels: config.get<LabelStyle>('aiUsage.statusBar.labels', 'iconOnly'),
    usage: config.get<UsageStyle>('aiUsage.statusBar.usage', 'rich')
  };
}

function chipStyle(): { named: boolean; usage: UsageStyle } {
  const config = vscode.workspace.getConfiguration();
  return {
    named: config.get<string>('aiUsage.chatChips.labels', 'name') === 'name',
    usage: config.get<UsageStyle>('aiUsage.chatChips.usage', 'rich')
  };
}
/** Scope sets Copilot itself signs in with; any of them is enough to read the quota endpoint. */
const GITHUB_SCOPE_CANDIDATES: string[][] = [
  ['read:user', 'user:email', 'repo', 'workflow'],
  ['user:email'],
  ['read:user']
];

/**
 * Status bar placement. VS Code's own Copilot entry sits immediately right of the language-mode
 * item (priority 100.1, right aligned); these priorities land just left of that pair.
 */
const STATUS_ALIGNMENT = vscode.StatusBarAlignment.Right;
const STATUS_PRIORITY = { manual: 100.19, claude: 100.18, codex: 100.17, copilot: 100.16 };

type LiveProvider = {
  id: ProviderId;
  icon: string;
  settingKey: string;
  status: vscode.StatusBarItem;
  diagnostics?: RotationDiagnostics;
  readingIdentity?: string;
  /** Name of the service-managed authentication profile currently selected for this provider. */
  activeProfileName?: () => string | undefined;
  /** The Accounts row of the menu: the active profile, or how many are saved when none is active. */
  accountsSummary?: () => string;
  /** "#2" for the second saved profile, when there are several and the setting shows it. */
  accountNumber?: () => string | undefined;
  activeProfileId?: () => string | undefined;
  activeProfileUsage?: () => LiveUsage | undefined;

  last?: LiveResult;
  /** Most recent successful reading, kept so errors do not blank the item. */
  lastGood?: LiveUsage;
  /** The saved account to which `last` and `lastGood` belong. */
  readingProfileId?: string;
  /** In-flight refresh for this provider only; failures elsewhere never wait on it. */
  inFlight?: Promise<void>;
};

/** Data source per provider, selected with `aiUsage.<provider>.source`. */
type SourceId = 'auto' | 'api' | 'cli' | 'sessionLog' | 'accountFile' | 'both';
const SOURCE_LABELS: Record<SourceId, string> = {
  auto: 'automatic source selection', api: 'service API', cli: 'local CLI', sessionLog: 'local session log', accountFile: 'local account file',
  both: 'local file, service API when stale'
};
function settingsFor(provider: ProviderId) { return usageSettings(configFromSettings(), provider); }

/** How often every window re-reads the shared cache and redraws (`aiUsage.updateIntervalMinutes`). */
function updateIntervalMs(): number {
  return Math.max(0.25, vscode.workspace.getConfiguration().get<number>('aiUsage.updateIntervalMinutes', 1)) * 60_000;
}

function formatInterval(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
}

/** After this long, a reading shown in place of a failed refresh is greyed out. */
const STALE_AFTER_MS = 15 * 60_000;
const GITHUB_ACCESS_REQUESTED_KEY = 'aiUsage.githubAccessRequested';
/** Last Codex profile switch, shared by every window so each can check its own Codex process (non-secret). */
const CODEX_SWITCH_KEY = 'aiUsage.codexSwitch.v1';
/** `switchedAt` of the switch this window has already warned about; at most one warning per switch per window. */
const CODEX_SWITCH_NOTIFIED_KEY = 'aiUsage.codexSwitchNotified.v1';
type CodexSwitchRecord = { switchedAt: number; profileName: string };
/** Scopes used when asking the user to grant access; Copilot itself signs in with these. */
const GITHUB_CONNECT_SCOPES = ['user:email'];

let output: vscode.OutputChannel | undefined;
let activeServices: ServiceManager | undefined;
function log(message: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('AI Usage');
  context.subscriptions.push(output);
  // Saved profiles, keep-alives and rotation live in the account service, a background process this extension
  // installs and manages; see serviceManager.ts. The Accounts menus and the status bar are its clients.
  const services = new ServiceManager(context, log);
  activeServices = services;
  context.subscriptions.push(services);
  configureBridgeService(async () => { const client = await services.ensure(); if (!client) throw new Error('The AI Usage service is unavailable.'); return client; });
  registerBridgeIntegration(context);
  registerBridgeModels(context);
  // Offers the service's MCP server to the agents of this window while aiUsage.mcp.enabled is on (experimental).
  registerMcpProvider(context, services, log);
  const accountsMenu = new AccountsMenu(services, log);
  const status = vscode.window.createStatusBarItem(STATUS_ALIGNMENT, STATUS_PRIORITY.manual);
  status.command = 'aiUsage.showDetails';
  status.name = 'AI Usage';
  context.subscriptions.push(status);
  const liveProviders: LiveProvider[] = (['claude', 'codex', 'copilot'] as const).map(id => ({
    id, icon: id === 'claude' ? 'claude' : id === 'codex' ? 'openai' : 'copilot', settingKey: `aiUsage.${id}.enabled`,
    status: vscode.window.createStatusBarItem(STATUS_ALIGNMENT, STATUS_PRIORITY[id]),
    ...(id === 'copilot' ? {} : {
      activeProfileName: () => activeProfileName(services, id), accountsSummary: () => accountsSummary(services, id),
      activeProfileId: () => services.views[id]?.activeProfileId,
      activeProfileUsage: () => accountUsage(services, id), accountNumber: () => accountNumberLabel(services, id)
    })
  }));
  const sessionTokens = new Map<'claude' | 'codex', SessionTokenUsage>();
  for (const provider of liveProviders) {
    provider.status.command = clickCommand(provider);
    provider.status.name = `AI Usage: ${provider.id}`;
    context.subscriptions.push(provider.status);
  }

  const refreshManual = () => {
    const accounts = getAccountUsage();
    const summary = summarize(accounts);
    status.text = `$(hubot) AI ${summary.remainingPercent}%`;
    status.tooltip = summary.lines.join('\n');
    // The manual item only makes sense once the user has entered their own figures;
    // the sample defaults would otherwise sit next to the live items.
    if (hasUserConfiguredAccounts() && statusBarVisible()) {
      status.show();
    } else {
      status.hide();
    }
  };


  /** Clients request and display service readings. They never fall back to a vendor request on disconnect. */
  const refreshProvider = (provider: LiveProvider, force: boolean, _afterRotation = false): Promise<void> => {
    if (provider.inFlight) return provider.inFlight;
    provider.inFlight = (async () => {
      const config = vscode.workspace.getConfiguration();
      if (!config.get<boolean>(provider.settingKey, true)) {
        provider.status.hide(); await updateChipContext(provider, false); return;
      }
      try {
        const client = await services.ensure();
        if (!client) throw new Error('The account service is unavailable; waiting to reconnect.');
        if (provider.id === 'copilot') await client.usageContext({ accounts: await getGitHubAccounts(), workspaceOwners: await getWorkspaceOwners() });
        const state = await readServiceUsage(client, provider.id, force, config.get<boolean>(`aiUsage.${provider.id}.advanced.rotationDiagnostics`, false));
        if (provider.readingIdentity !== state.identity) { provider.last = undefined; provider.lastGood = undefined; }
        provider.readingIdentity = state.identity;
        provider.last = state.result;
        provider.lastGood = state.lastGood;
        if (provider.id !== 'copilot') {
          await services.refreshViews(provider.id);
          provider.readingProfileId = state.profileId;
          provider.diagnostics = state.diagnostics;
        }
        services.runtimeStatus = await client.call('runtime.status');
      } catch (error) {
        provider.last = { kind: 'error', provider: provider.id, title: PROVIDER_TITLES[provider.id],
          message: error instanceof Error ? error.message : String(error), transient: true };
      }
      renderLive(provider);
      await updateChipContext(provider, config.get<boolean>('aiUsage.chatChips.enabled', true));
    })().finally(() => { provider.inFlight = undefined; });
    return provider.inFlight;
  };

  const refreshLive = async (force = false): Promise<void> => {
    await Promise.all(liveProviders.map((provider) => refreshProvider(provider, force)));
  };

  /** Manual refresh: bypass cache freshness but still respect a shared backoff. */
  const refreshAll = async () => {
    refreshManual();
    await refreshLive(true);
  };

  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.showDetails', (providerId?: unknown) =>
    showDetailsPanel(liveProviders, refreshAll, (provider) => refreshProvider(provider, true),
      typeof providerId === 'string' ? (providerId as ProviderId) : undefined, () => services.summary())
  ));

  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.refresh', refreshAll));
  /**
   * Codex re-reads auth.json when a turn starts, so running chats follow a switch by themselves. A Codex
   * `app-server` started before the switch may still hold revoked tokens in its background paths, and the Codex
   * extension never respawns it; offer an extension-host restart once per switch in each affected window. The offer
   * is opt-in (`aiUsage.codex.switchRestartHint`) because the warning interrupts every window holding such a process.
   */
  const warnAboutStaleCodexProcesses = async (): Promise<void> => {
    // Verified against Codex 0.154.0: a running app-server keeps its login in memory. When auth.json changes
    // underneath it, its next turn fails with "signed in to another account" instead of adopting the new login,
    // and the Codex extension never respawns the process. Restarting the extension host is the only repair.
    if (!vscode.workspace.getConfiguration().get<boolean>('aiUsage.codex.switchRestartHint', false)) {
      return;
    }
    // With the account proxy, chats follow the switch on their next turn; a restart would repair nothing.
    if (services.runtimeStatus.codexProxyActive) {
      return;
    }
    const record = context.globalState.get<CodexSwitchRecord>(CODEX_SWITCH_KEY);
    if (!record || context.workspaceState.get<number>(CODEX_SWITCH_NOTIFIED_KEY) === record.switchedAt) {
      return;
    }
    const stale = await services.require().call('runtime.staleCodex', { switchedAt: record.switchedAt, parentPid: process.pid });
    if (!stale.length || context.workspaceState.get<number>(CODEX_SWITCH_NOTIFIED_KEY) === record.switchedAt) {
      return;
    }
    await context.workspaceState.update(CODEX_SWITCH_NOTIFIED_KEY, record.switchedAt);
    log(`codex: app-server pid ${stale.map((process) => process.pid).join(', ')} started before the switch to "${record.profileName}"`);
    const choice = await vscode.window.showWarningMessage(
      `Codex switched to “${record.profileName}”, but this window's Codex extension started before the switch and keeps the previous login; its chats will fail until extensions restart. Restart extensions to use the new login in Codex here.`,
      'Restart extensions', 'Later');
    if (choice === 'Restart extensions') {
      await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
    }
  };
  const afterProfileActivated = async (provider: AuthProvider, change: ActivationChange = { kind: 'activated', accountChanged: true }) => {
    const live = liveProviders.find((candidate) => candidate.id === provider)!;
    await live.inFlight;
    live.last = undefined;
    live.lastGood = undefined;
    live.readingProfileId = undefined;
    renderLive(live);
    await updateChipContext(live, vscode.workspace.getConfiguration().get<boolean>('aiUsage.chatChips.enabled', true));
    // Claude Code re-reads its credential file, so a switch reaches open chats by itself. Codex's app-server does
    // not, and only a real account change may reset the baseline its stale-process check measures against: saving
    // or re-selecting the active login starts nothing on a new account and would flag processes that are fine.
    if (provider === 'codex' && change.accountChanged) {
      const record: CodexSwitchRecord = { switchedAt: Date.now(), profileName: activeProfileName(services, 'codex') ?? 'the selected profile' };
      await context.globalState.update(CODEX_SWITCH_KEY, record);
      void warnAboutStaleCodexProcesses();
    }
    await refreshProvider(live, true, true);
  };
  /**
   * Runs the vendor's login in a terminal with the isolated home the service prepared and stores the result in the
   * saved profile, replacing the native login too when that profile is active. Resolves to whether the profile's
   * login was replaced; every outcome is reported to the user here.
   */
  const signInAgain = async (provider: AuthProvider, id: string): Promise<boolean> => {
    const title = provider === 'claude' ? 'Claude' : 'Codex';
    let client;
    try { client = services.require(); } catch (error) { void vscode.window.showErrorMessage(`AI Usage: ${error instanceof Error ? error.message : String(error)}`); return false; }
    const profile = (services.views[provider] ?? await client.list(provider)).profiles.find((candidate) => candidate.id === id);
    if (!profile) { return false; }
    const who = `“${profile.name}”${profile.email ? ` (${profile.email})` : ''}`;
    try {
      const result = await signInWithTerminal(client, provider, id, `${title} ${who}`, async (message) =>
        (await vscode.window.showWarningMessage(`${message} Replace its login anyway?`, { modal: true }, 'Replace')) === 'Replace');
      if (!result || result.status !== 'replaced') {
        void vscode.window.showWarningMessage(`AI Usage: sign-in for the ${title} account ${who} was not completed; the profile is unchanged.`);
        return false;
      }
      if (result.active) { await afterProfileActivated(provider, { kind: 'saved', accountChanged: false }); }
      void vscode.window.showInformationMessage(`AI Usage: ${result.message}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`${provider}: signing in again for "${profile.name}" failed: ${message}`);
      void vscode.window.showErrorMessage(`AI Usage: could not sign in again for the ${title} account ${who}: ${message}`);
      return false;
    }
  };
  /** A broken saved login is reported by name and email; one that needs a new sign-in is offered it right away. */
  const reportAccountProblem = async (event: Extract<ServiceEvent, { event: 'accountProblem' }>) => {
    const title = event.provider === 'claude' ? 'Claude' : 'Codex';
    const who = `“${event.name}”${event.email ? ` (${event.email})` : ''}`;
    if (!event.revoked) {
      void vscode.window.showWarningMessage(`AI Usage: automatic rotation will not switch to the ${title} account ${who}: its keep-alive failed. ${event.readable}`);
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `AI Usage: the saved ${title} login for ${who} no longer works and cannot be used or rotated to: ${event.readable}`,
      'Sign in again', 'Skip');
    if (choice === 'Sign in again') { await signInAgain(event.provider, event.id); }
  };
  // What the service announces, whoever asked for it (this window, another one, or the ai-usage command).
  context.subscriptions.push(services.onEvent((event) => {
    switch (event.event) {
      case 'usageChanged': {
        const provider = liveProviders.find(p => p.id === event.provider);
        if (provider) void refreshProvider(provider, false);
        break;
      }
      case 'activated': {
        const message = event.level === 'info'
          ? activationMessage(event.provider, event.name, event.automatic, event.provider === 'codex' && services.runtimeStatus.codexProxyActive)
          : event.message;
        if (event.level === 'error') { void vscode.window.showErrorMessage(`AI Usage: ${message}`); }
        else if (event.level === 'warning') { void vscode.window.showWarningMessage(`AI Usage: ${message}`); }
        else { void vscode.window.showInformationMessage(`AI Usage: ${message}`); }
        void afterProfileActivated(event.provider, { kind: 'activated', accountChanged: event.accountChanged });
        break;
      }
      case 'resetConfirmation': {
        const client = services.connected;
        if (!client?.supports('reset-confirmation')) break;
        void (async () => {
          const decision = await client.claimReset(event.decision.id);
          if (!decision || !client.connected || services.connected !== client) return;
          const windows = decision.windows.map(window => `${window.label}: ${window.usedPercent}% used`).join(', ');
          const choice = await vscode.window.showWarningMessage(
            `AI Usage: use earned Codex resets for “${decision.accountName}”?`,
            { modal: true, detail: `The engine plans to use ${decision.plannedCredits} reset credit(s). Current quota: ${windows}. ${decision.availableCredits} credit(s) are available. Reason: ${decision.reason}. This decision expires at ${new Date(decision.expiresAt).toLocaleTimeString()}.` },
            'Use earned resets');
          if (!client.connected || services.connected !== client) return;
          const result = await client.resolveReset(decision.id, choice === 'Use earned resets');
          if (result.status === 'stale') void vscode.window.showInformationMessage('AI Usage: the reset decision changed or expired. No reset was approved.');
        })().catch(error => log(`reset confirmation: ${String(error)}`));
        break;
      }
      case 'accountProblem': void reportAccountProblem(event); break;
      case 'noCandidate': {
        const title = event.provider === 'claude' ? 'Claude' : 'Codex';
        void vscode.window.showWarningMessage(`AI Usage: not rotating ${title}: ${event.detail}.`, 'Accounts', 'Settings').then((choice) => {
          if (choice === 'Accounts') { void vscode.commands.executeCommand('aiUsage.manageAuthProfiles', event.provider); }
          if (choice === 'Settings') { void openAiUsageSettings(`aiUsage.${event.provider}.autoRotate`); }
        });
        break;
      }
      case 'notice': {
        const show = event.level === 'error' ? vscode.window.showErrorMessage : event.level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        void show(`AI Usage: ${event.message}`);
        break;
      }
      default: break;
    }
  }));
  // A refreshed view changes the account number and name the status bar shows.
  context.subscriptions.push(services.onStateChanged(() => { for (const provider of liveProviders) { renderLive(provider); } }));
  const accountTimer = setInterval(() => {
    services.tick();
    void warnAboutStaleCodexProcesses();
  }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(accountTimer) });
  /**
   * Registers the service's MCP server with the provider's CLI through the CLI's own `mcp add`, so Claude Code or
   * Codex in a terminal gets the account tools. Offered by the Accounts menu while aiUsage.mcp.enabled is on; when
   * the CLI already runs this launcher, the same item offers to register again or to remove the entry.
   */
  const registerMcpWithCli = async (provider: AuthProvider): Promise<void> => {
    const title = provider === 'claude' ? 'Claude' : 'Codex';
    const client = services.require();
    const { launcher, command, cli, reason, registration: before } = await client.call('mcp.registration', { provider });
    const displayedCommand = [command?.command ?? launcher, ...(command?.args ?? ['mcp'])]
      .map((part) => /[\s"]/.test(part) ? JSON.stringify(part) : part).join(' ');
    if (!fs.existsSync(launcher)) {
      void vscode.window.showWarningMessage(`AI Usage: the MCP command is unavailable: ${displayedCommand}. Check Account service… before registering it with the ${title} CLI.`);
      return;
    }
    if (!cli) { void vscode.window.showErrorMessage(`AI Usage: ${reason}`); return; }
    const where = provider === 'claude' ? 'in its user scope, for every project' : 'in its config.toml';
    if (before.current) {
      const choice = await vscode.window.showInformationMessage(
        `AI Usage: the ${title} CLI already runs the “${MCP_SERVER_NAME}” MCP server from ${displayedCommand} ${where}.`, 'Register again', 'Remove');
      if (!choice) { return; }
      if (choice === 'Remove') {
        const removed = await client.call('mcp.unregister', { provider });
        log(`${provider}: ${path.basename(cli)} mcp remove ${MCP_SERVER_NAME}: ${removed.ok ? 'removed' : 'failed'}: ${removed.detail}`);
        if (removed.ok) { void vscode.window.showInformationMessage(`AI Usage: the “${MCP_SERVER_NAME}” MCP server was removed from the ${title} CLI.`); }
        else { void vscode.window.showErrorMessage(`AI Usage: could not remove the “${MCP_SERVER_NAME}” MCP server from the ${title} CLI: ${removed.detail}`); }
        return;
      }
    } else if (before.registered) {
      const current = [before.command, ...(before.args ?? [])].filter(Boolean).join(' ') || 'another command';
      const choice = await vscode.window.showWarningMessage(
        `The ${title} CLI already has an MCP server named “${MCP_SERVER_NAME}” that runs ${current}. Replace it with ${displayedCommand}?`, { modal: true }, 'Replace');
      if (choice !== 'Replace') { return; }
    }
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `AI Usage: registering the MCP server with the ${title} CLI…` },
      () => client.call('mcp.register', { provider }));
    log(`${provider}: registering the MCP server with ${cli}: ${result.ok ? 'registered' : 'failed'}: ${result.detail}`);
    if (!result.ok) {
      void vscode.window.showErrorMessage(`AI Usage: could not register the MCP server with the ${title} CLI: ${result.detail}`);
      return;
    }
    const switching = services.config?.mcp.switching ?? true;
    void vscode.window.showInformationMessage(
      `AI Usage: the ${title} CLI now has the “${MCP_SERVER_NAME}” MCP server ${where}. New ${title} sessions can list the saved accounts with their usage${switching ? ' and switch between them' : ''}; the tools answer while aiUsage.mcp.enabled is on.`);
  };
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.setupMcp', async () => {
    while (true) {
      const client = services.connected;
      const enabled = services.config?.mcp.enabled ?? false;
      const items: Array<vscode.QuickPickItem & { action: 'connect' | 'enable' | 'claude' | 'codex' | 'settings' }> = [];
      if (!client) {
        items.push({ label: '$(debug-start) Connect to the account service…', detail: 'Connects to the shared engine and reads its MCP settings.', action: 'connect' });
      } else if (!enabled) {
        items.push({ label: '$(plug) Enable the MCP server…', detail: 'Makes account tools available to agents in this VS Code window and allows CLI registration.', action: 'enable' });
      } else {
        for (const provider of ['claude', 'codex'] as const) {
          const { registration } = await client.call('mcp.registration', { provider });
          items.push({
            label: `$(plug) Register with ${provider === 'claude' ? 'Claude' : 'Codex'} CLI…`,
            description: registration.current ? 'Registered' : registration.registered ? 'Registered with another command' : 'Not registered',
            detail: `Adds the ${MCP_SERVER_NAME} MCP server to ${provider === 'claude' ? 'Claude Code' : 'Codex'} in terminal sessions.`,
            action: provider
          });
        }
      }
      items.push({ label: '$(gear) MCP settings…', description: enabled ? 'Enabled' : 'Disabled', action: 'settings' });
      const picked = await vscode.window.showQuickPick(items, { title: 'AI Usage · MCP server setup', matchOnDetail: true });
      if (!picked) { return; }
      if (picked.action === 'connect') {
        if (!await services.ensure()) { await services.showMenu(); return; }
      } else if (picked.action === 'enable') {
        try {
          const current = await client!.getConfigState();
          const result = await client!.patchConfig({ 'mcp.enabled': true }, current.revision);
          services.config = result.config;
          await services.configSync.pull(result.config);
        } catch (error) {
          void vscode.window.showErrorMessage(`AI Usage: could not enable the MCP server: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      } else if (picked.action === 'claude' || picked.action === 'codex') {
        await registerMcpWithCli(picked.action);
      } else {
        await openAiUsageSettings('aiUsage.mcp');
        return;
      }
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.manageAuthProfiles', async (value?: unknown) => {
    const initial = value === 'claude' || value === 'codex' ? value as AuthProvider : undefined;
    await accountsMenu.show(initial, {
      activeUsage: (provider, id) => {
        const live = liveProviders.find((candidate) => candidate.id === provider);
        return live && services.views[provider]?.activeProfileId === id ? visibleUsage(live) : undefined;
      },
      beforeActivate: async (provider) => {
        await liveProviders.find((candidate) => candidate.id === provider)?.inFlight;
      },
      afterSaved: (provider) => afterProfileActivated(provider, { kind: 'saved', accountChanged: false }),
      back: async (provider) => { log(`${provider}: Accounts menu → Back to the AI Usage menu`); await vscode.commands.executeCommand('aiUsage.showDetails'); },
      signIn: async (provider, profile) => { await signInAgain(provider, profile.id); },
      mcpRegistration: async (provider) => (await services.require().call('mcp.registration', { provider })).registration,
      registerMcp: registerMcpWithCli,
      sendKeepAlive: async (provider, profiles) => {
        const client = services.require();
        const title = provider === 'claude' ? 'Claude' : 'Codex';
        if (profiles.length === 1) {
          const [profile] = profiles;
          // This one notification reports the outcome, a dead login included, so the service must not announce
          // the same failure a second time; it only records the login as reported.
          const token = `vscode-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          let result: KeepAliveResult;
          let cancelled = false;
          try {
            result = await vscode.window.withProgress({
              location: vscode.ProgressLocation.Notification,
              title: `AI Usage: sending ${title} keep-alive for “${profile.name}”…`,
              cancellable: true
            }, async (progress, cancel) => {
              cancel.onCancellationRequested(() => { cancelled = true; void client.cancel(token).catch(() => undefined); });
              // A check running in the service (a periodic sweep) is waited for; the progress says so.
              const waiting = services.onEvent((event) => {
                if (event.event === 'waiting' && event.token === token) { progress.report({ message: `waiting for a running ${title} account check…` }); }
              });
              try { return await client.keepAliveNow(provider, profile.id, { callerReports: true, token }); } finally { waiting.dispose(); }
            });
          } catch (error) {
            if (cancelled) { return; }
            void vscode.window.showWarningMessage(`AI Usage: ${title} keep-alive for “${profile.name}” not sent: ${readableProblem(error instanceof Error ? error.message : String(error))}`);
            return;
          }
          // Revoked, or expired and not refreshable, found by the keep-alive or by the usage read: only a new sign-in helps.
          const dead = [result.keepAliveError, result.usageError].find(needsSignIn);
          let message: string;
          let succeeded = false;
          if (result.keepAliveError) {
            const suffix = result.usage ? ' Usage statistics were still updated.'
              : dead && dead !== result.keepAliveError ? ` Usage statistics could not be updated either: ${readableProblem(dead)}` : '';
            message = `AI Usage: ${title} keep-alive failed for “${profile.name}”: ${readableProblem(result.keepAliveError)}${suffix}`;
          } else if (result.usage) {
            succeeded = true;
            message = `AI Usage: ${title} keep-alive completed for “${profile.name}”. Usage statistics updated.`;
          } else {
            message = `AI Usage: ${title} keep-alive completed for “${profile.name}”, but usage statistics could not be updated${result.usageError ? `: ${readableProblem(result.usageError)}` : '.'}`;
          }
          if (dead) {
            const choice = await vscode.window.showWarningMessage(message, 'Sign in again', 'Skip');
            if (choice === 'Sign in again') { await signInAgain(provider, profile.id); }
          } else if (succeeded) {
            void vscode.window.showInformationMessage(message);
          } else {
            void vscode.window.showWarningMessage(message);
          }
          return;
        }
        // One sweep in the service, under one lock, so a periodic check cannot cut in between two accounts; the
        // service spaces the accounts and reports progress through events.
        const token = `vscode-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `AI Usage: sending ${title} keep-alives`,
          cancellable: true
        }, async (progress, cancel) => {
          cancel.onCancellationRequested(() => { void client.cancel(token).catch(() => undefined); });
          const listener = services.onEvent((event) => {
            if (event.event === 'waiting' && event.token === token) { progress.report({ message: `waiting for a running ${title} account check…` }); }
            if (event.event === 'keepAliveProgress' && event.token === token) {
              progress.report({ message: `${event.index + 1}/${event.total}: “${event.name}”…`, increment: event.index ? 100 / event.total : 0 });
            }
          });
          let sweep: KeepAliveAllResult;
          try { sweep = await client.keepAliveAll(provider, profiles.map((profile) => profile.id), { token }); } finally { listener.dispose(); }
          const failed: string[] = [];
          for (const result of sweep.results) {
            const problem = result.error ?? result.keepAliveError ?? (result.usage ? undefined : result.usageError ?? 'usage statistics could not be updated');
            if (problem) { failed.push(`“${result.name}”: ${readableProblem(problem)}`); }
          }
          const skipped = sweep.total - sweep.done;
          const summary = `AI Usage: ${title} keep-alive sent to ${sweep.done - failed.length} of ${sweep.total} accounts${skipped ? ` (${skipped} ${sweep.cancelled ? 'cancelled' : `not sent: ${sweep.blocked ?? 'the sweep stopped'}`})` : ''}.`;
          if (failed.length) {
            void vscode.window.showWarningMessage(`${summary} Problems: ${failed.join('; ')}`);
          } else {
            void vscode.window.showInformationMessage(`${summary} Usage statistics updated.`);
          }
        });
      }
    });
  }));
  const reportMenuError = (error: unknown) => { void vscode.window.showErrorMessage(`AI Usage: ${error instanceof Error ? error.message : String(error)}`); };
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.exportAuthProfiles', () => accountsMenu.exportProfiles().catch(reportMenuError)));
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.importAuthProfiles', () => accountsMenu.importProfiles().catch(reportMenuError)));
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.installAccountService', () => services.install()));
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.accountService', () => services.showMenu()));
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.openLog', () => output?.show(true)));
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.showUsageHistory', () => showUsageHistory(services)
    .catch((error: unknown) => vscode.window.showErrorMessage(`AI Usage: could not show the usage history: ${error instanceof Error ? error.message : String(error)}`))));
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.openAgentsWindowSetup', () =>
    vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#${AGENTS_WINDOW_WALKTHROUGH}`, false)
  ));
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.enableAgentsWindow', () => enableAgentsWindow(context)));

  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.connectGitHub', async () => {
    await context.globalState.update(GITHUB_ACCESS_REQUESTED_KEY, true);
    const granted = await connectGitHub();
    if (granted) {
      await refreshLive();
    }
  }));

  // Ask once for access to the GitHub account VS Code already has. Silent lookups return
  // nothing until the user has allowed this extension to use the account.
  const copilotProvider = liveProviders.find((provider) => provider.id === 'copilot');
  const maybeRequestGitHubAccess = async () => {
    if (!copilotProvider || context.globalState.get<boolean>(GITHUB_ACCESS_REQUESTED_KEY)) {
      return;
    }
    const result = copilotProvider.last;
    if (result?.kind !== 'unavailable' || !result.reason?.includes('No GitHub sign-in')) {
      return;
    }
    if (!(await vscode.authentication.getAccounts('github')).length) {
      return;
    }
    await context.globalState.update(GITHUB_ACCESS_REQUESTED_KEY, true);
    if (await connectGitHub()) {
      await refreshLive();
    }
  };

  // Every generated chat chip command (aiUsage.chip.<provider>.<item>..., see
  // scripts/generate-manifest.js) opens the details of that provider; the debug chip opens all. The list is read from
  // the manifest so the two stay in sync.
  const manifestCommands = (context.extension.packageJSON as { contributes?: { commands?: Array<{ command: string }> } })
    .contributes?.commands ?? [];
  const providerIds = new Set<string>(liveProviders.map((provider) => provider.id));
  for (const { command } of manifestCommands) {
    if (!command.startsWith(CHIP_COMMAND_PREFIX)) {
      continue;
    }
    const providerId = command.slice(CHIP_COMMAND_PREFIX.length).split('.')[0];
    const target = providerIds.has(providerId) ? (providerId as ProviderId) : undefined;
    context.subscriptions.push(vscode.commands.registerCommand(command, () =>
      vscode.commands.executeCommand('aiUsage.showDetails', target)
    ));
  }

  // A chat input status item has a static manifest title. The generated commands select a compact
  // token label through a context key, while this command provides the exact breakdown on click.
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.showChatTokens', (providerId?: unknown) => {
    if (providerId !== 'claude' && providerId !== 'codex') {
      return;
    }
    const usage = sessionTokens.get(providerId);
    if (!usage) {
      void vscode.window.showInformationMessage(`AI Usage: no ${providerId === 'claude' ? 'Claude' : 'Codex'} token data was found for this workspace.`);
      return;
    }
    const cached = usage.cachedInputTokens
      ? ` (${usage.cachedInputTokens.toLocaleString()} cached)`
      : '';
    void vscode.window.showInformationMessage(
      `${providerId === 'claude' ? 'Claude' : 'Codex'} chat: ${usage.totalTokens.toLocaleString()} tokens · ` +
      `${usage.inputTokens.toLocaleString()} input${cached} · ${usage.outputTokens.toLocaleString()} output`
    );
  }));
  for (const { command } of manifestCommands) {
    if (!command.startsWith(CHAT_TOKEN_COMMAND_PREFIX)) {
      continue;
    }
    const providerId = command.slice(CHAT_TOKEN_COMMAND_PREFIX.length).split('.')[0];
    if (providerId === 'claude' || providerId === 'codex') {
      context.subscriptions.push(vscode.commands.registerCommand(command, () =>
        vscode.commands.executeCommand('aiUsage.showChatTokens', providerId)
      ));
    }
  }

  const updateSessionTokens = async () => {
    const config = vscode.workspace.getConfiguration();
    const enabled = config.get<boolean>('aiUsage.chatChips.enabled', true) &&
      config.get<boolean>('aiUsage.chatTokens.enabled', true);
    await Promise.all((['claude', 'codex'] as const).map(async (provider) => {
      const client = enabled ? await services.ensure() : undefined;
      const raw = client ? await client.call('usage.sessionTokens', { provider }).catch(() => null) : null;
      const usage = raw ? { ...raw, updatedAt: new Date(raw.updatedAt) } : undefined;
      if (usage) {
        sessionTokens.set(provider, usage);
      } else {
        sessionTokens.delete(provider);
      }
      await vscode.commands.executeCommand(
        'setContext',
        `aiUsage.chatTokens.${provider}`,
        usage ? compactTokenCount(usage.totalTokens) : undefined
      );
    }));
  };
  void updateSessionTokens();
  const sessionTokenTimer = setInterval(() => void updateSessionTokens(), 10_000);
  context.subscriptions.push({ dispose: () => clearInterval(sessionTokenTimer) });
  const updateDebugChip = () =>
    vscode.commands.executeCommand(
      'setContext',
      `${CHIP_COMMAND_PREFIX}debug`,
      vscode.workspace.getConfiguration().get<boolean>('aiUsage.chatChips.debug', false)
    );
  void updateDebugChip();
  const updateAgentsWindowChip = () =>
    vscode.commands.executeCommand(
      'setContext',
      `${CHIP_COMMAND_PREFIX}agentsWindow`,
      vscode.workspace.getConfiguration().get<boolean>('aiUsage.chatChips.agentsWindow', true)
    );
  void updateAgentsWindowChip();

  // Chip visibility in a regular VS Code window.
  const updateChipPresentation = async () => {
    const config = vscode.workspace.getConfiguration();
    const mode = config.get<string>('aiUsage.chatChips.workbench', 'whenNoStatusBar');
    const chipsEnabled = config.get<boolean>('aiUsage.chatChips.enabled', true);
    const inWorkbench = chipsEnabled && (mode === 'always' || (mode === 'whenNoStatusBar' && !statusBarVisible()));
    await Promise.all([
      vscode.commands.executeCommand('setContext', `${CHIP_COMMAND_PREFIX}workbench`, inWorkbench),
      vscode.commands.executeCommand('setContext', `${CHIP_COMMAND_PREFIX}named`, chipStyle().named)
    ]);
  };
  void updateChipPresentation();
  log(`host: ${vscode.env.appName} · uiKind=${vscode.env.uiKind === vscode.UIKind.Desktop ? 'desktop' : 'web'} · remote=${vscode.env.remoteName ?? 'none'} · extensionKind=${context.extension.extensionKind === vscode.ExtensionKind.UI ? 'ui' : 'workspace'}`);

  // The workspace's repositories decide which Copilot account/organization applies.
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshLive()));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void updateSessionTokens()));
  // The folders' project profile files are listed by the service while this window has them open.
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void services.declareFolders()));

  // Refresh live data when the GitHub sign-in state changes (affects Copilot).
  context.subscriptions.push(vscode.authentication.onDidChangeSessions((event) => {
    if (event.provider.id === 'github') {
      void refreshLive();
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('aiUsage.accounts')) {
      refreshManual();
    }

    if (event.affectsConfiguration('aiUsage')) { void services.pushSettings(event); }
    if (event.affectsConfiguration('aiUsage.accountService')) {
      void services.ensure({ promptInstall: true });
    }
    if (
      event.affectsConfiguration('aiUsage.claude') ||
      (event.affectsConfiguration('aiUsage.codex') && codexUsageSettingsChanged(key => event.affectsConfiguration(key), configKeys())) ||
      event.affectsConfiguration('aiUsage.copilot') ||
      event.affectsConfiguration('aiUsage.chatChips')
    ) {
      void refreshLive();
    }
    if (event.affectsConfiguration('aiUsage.chatChips.debug')) {
      void updateDebugChip();
    }
    if (event.affectsConfiguration('aiUsage.chatChips.agentsWindow')) {
      void updateAgentsWindowChip();
    }
    if (event.affectsConfiguration('aiUsage.updateIntervalMinutes')) {
      scheduleTimer();
    }
    if (
      event.affectsConfiguration('aiUsage.chatTokens.enabled') ||
      event.affectsConfiguration('aiUsage.chatChips.enabled')
    ) {
      void updateSessionTokens();
    }
    if (event.affectsConfiguration('aiUsage.statusBar') || event.affectsConfiguration('aiUsage.claude.statusBar') ||
      event.affectsConfiguration('aiUsage.codex.statusBar')) {
      refreshManual();
      for (const provider of liveProviders) {
        renderLive(provider);
      }
    }
    if (
      event.affectsConfiguration('aiUsage.statusBar') ||
      event.affectsConfiguration('aiUsage.chatChips') ||
      event.affectsConfiguration('workbench.statusBar.visible')
    ) {
      void updateChipPresentation();
    }
  }));

  // On focus, pick up whatever other windows have fetched; the network is only used if stale.
  context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      void refreshLive();
    }
  }));

  // Re-read the shared cache on the update interval; refreshProvider decides per provider whether
  // the reading is older than that provider's check interval and only then calls its source.
  let timer: NodeJS.Timeout | undefined;
  const scheduleTimer = () => {
    if (timer) {
      clearInterval(timer);
    }
    timer = setInterval(() => void refreshLive(), updateIntervalMs());
  };
  scheduleTimer();
  context.subscriptions.push({ dispose: () => timer && clearInterval(timer) });

  void services.ensure({ promptInstall: true }).then(() => refreshLive());
  void refreshAll().then(maybeRequestGitHubAccess).then(() => maybeOfferAgentsWindowSetup(context));
}

const HISTORY_PERIODS: Array<{ label: string; days?: number }> = [
  { label: 'Summary of the last 7 days', days: 7 },
  { label: 'Summary of the last 30 days', days: 30 },
  { label: 'Summary of the last 90 days', days: 90 },
  { label: 'Summary of everything kept' }
];

/** The usage history menu: a summary of a period as a Markdown document, exports, the files and the settings; all from the service. */
async function showUsageHistory(services: ServiceManager): Promise<void> {
  const client = services.require();
  const info = await client.historyInfo();
  type Item = vscode.QuickPickItem & { action?: 'summary' | 'readings' | 'events' | 'jsonl' | 'file' | 'settings'; days?: number };
  const items: Item[] = [
    { label: 'Summary', kind: vscode.QuickPickItemKind.Separator },
    ...HISTORY_PERIODS.map((period): Item => ({ label: `$(graph) ${period.label}`, action: 'summary', days: period.days })),
    { label: 'Export', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(export) Readings as CSV…', description: 'one row per account, reading and window', action: 'readings' },
    { label: '$(export) Switches, sweeps and check failures as CSV…', action: 'events' },
    { label: '$(json) Everything as JSON Lines…', description: 'the kept month files in one', action: 'jsonl' },
    { label: 'Files', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(file) Open the newest month file', description: info.location, action: 'file' },
    { label: '$(gear) History settings', description: `aiUsage.history.* · ${info.enabled ? `on, kept ${info.retentionDays} days` : 'off'}`, action: 'settings' }
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'AI Usage · Usage history', matchOnDescription: true,
    placeHolder: `${info.files.length} month file${info.files.length === 1 ? '' : 's'} in ${info.location}`
  });
  if (!picked?.action) { return; }
  if (picked.action === 'summary') {
    const result = await client.historySummary(picked.days);
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: result.markdown });
    try { await vscode.commands.executeCommand('markdown.showPreview', document.uri); }
    catch { await vscode.window.showTextDocument(document); }
    return;
  }
  if (picked.action === 'file') {
    const newest = info.files[info.files.length - 1];
    if (!newest) { void vscode.window.showInformationMessage('AI Usage: no usage history has been recorded yet.'); return; }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(newest)));
    return;
  }
  if (picked.action === 'settings') { await openAiUsageSettings('aiUsage.history'); return; }
  const kind = picked.action;
  const exported = await client.historyExport(kind);
  const target = await vscode.window.showSaveDialog({
    title: 'Export usage history',
    defaultUri: vscode.Uri.file(path.join(os.homedir(), `ai-usage-${kind}-${new Date().toISOString().slice(0, 10)}.${exported.extension}`)),
    filters: kind === 'jsonl' ? { 'JSON Lines': ['jsonl'] } : { CSV: ['csv'] }
  });
  if (!target) { return; }
  await vscode.workspace.fs.writeFile(target, Buffer.from(exported.text, 'utf8'));
  const choice = await vscode.window.showInformationMessage(`AI Usage: usage history exported to ${target.fsPath}.`, 'Open');
  if (choice === 'Open') { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target)); }
}

/** A reading as the service takes it: ISO dates, nothing else changed. */


const AGENTS_WINDOW_WALKTHROUGH = 'aiUsage.agentsWindow';
const AGENTS_WINDOW_SETTING = 'extensions.supportAgentsWindow';
const AGENTS_WINDOW_HINT_KEY = 'aiUsage.agentsWindowHintShown';

function isAllowedInAgentsWindow(context: vscode.ExtensionContext): boolean {
  const map = vscode.workspace.getConfiguration().get<Record<string, boolean>>(AGENTS_WINDOW_SETTING) ?? {};
  return Object.entries(map).some(([id, allowed]) => allowed && id.toLowerCase() === context.extension.id.toLowerCase());
}

/** Adds this extension to `extensions.supportAgentsWindow` in user settings, keeping other entries. */
async function enableAgentsWindow(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const current = config.inspect<Record<string, boolean>>(AGENTS_WINDOW_SETTING)?.globalValue ?? {};
  try {
    await config.update(AGENTS_WINDOW_SETTING, { ...current, [context.extension.id]: true }, vscode.ConfigurationTarget.Global);
  } catch (error) {
    void vscode.window.showErrorMessage(`AI Usage: could not update ${AGENTS_WINDOW_SETTING}: ${String(error)}`);
    return;
  }
  log(`agents window: ${context.extension.id} added to ${AGENTS_WINDOW_SETTING}`);
  const remote = Boolean(vscode.env.remoteName);
  const message = remote
    ? 'AI Usage is now allowed in the Agents window. Because this window is remote, also install the extension on your local computer, then reload the Agents window.'
    : 'AI Usage is now allowed in the Agents window. Reload the Agents window to see the chips.';
  const choice = await vscode.window.showInformationMessage(message, 'Setup guide', 'Open settings.json');
  if (choice === 'Setup guide') {
    await vscode.commands.executeCommand('aiUsage.openAgentsWindowSetup');
  } else if (choice === 'Open settings.json') {
    await vscode.commands.executeCommand('workbench.action.openSettingsJson');
  }
}

/** One-time hint, in ordinary windows only, that the Agents window needs a short setup. */
async function maybeOfferAgentsWindowSetup(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(AGENTS_WINDOW_HINT_KEY) || isAllowedInAgentsWindow(context)) {
    return;
  }
  if (!vscode.workspace.getConfiguration().get<boolean>('aiUsage.chatChips.agentsWindow', true)) {
    return;
  }
  await context.globalState.update(AGENTS_WINDOW_HINT_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    'AI Usage can also show usage chips in the Agents window. It needs a one-time setup.',
    'Set up',
    'Not now'
  );
  if (choice === 'Set up') {
    await vscode.commands.executeCommand('aiUsage.openAgentsWindowSetup');
  }
}

/** Requests access to the signed-in GitHub account (shows VS Code's Allow dialog). */
async function connectGitHub(): Promise<boolean> {
  try {
    const accounts = await vscode.authentication.getAccounts('github');
    const preferred = vscode.workspace.getConfiguration().get<string>('aiUsage.copilot.account') || undefined;
    const account = accounts.find((candidate) => candidate.label.toLowerCase() === preferred?.toLowerCase()) ?? accounts[0];
    const session = await vscode.authentication.getSession('github', GITHUB_CONNECT_SCOPES, { createIfNone: true, account });
    log(`github: access ${session ? `granted for ${session.account.label}` : 'not granted'}`);
    return Boolean(session);
  } catch (error) {
    log(`github: access request failed: ${String(error)}`);
    return false;
  }
}

/** All GitHub accounts VS Code is signed in to, with a token for each (silent, never prompts). */
async function getGitHubAccounts(): Promise<GitHubAccount[]> {
  let accounts: readonly vscode.AuthenticationSessionAccountInformation[] = [];
  try {
    accounts = await vscode.authentication.getAccounts('github');
  } catch (error) {
    log(`github: getAccounts failed: ${String(error)}`);
    accounts = [];
  }
  log(`github: ${accounts.length} account(s) signed in: ${accounts.map((account) => account.label).join(', ') || '-'}`);

  const result: GitHubAccount[] = [];
  const sessionFor = async (account?: vscode.AuthenticationSessionAccountInformation) => {
    for (const scopes of GITHUB_SCOPE_CANDIDATES) {
      try {
        const session = await vscode.authentication.getSession('github', scopes, { silent: true, account });
        if (session?.accessToken) {
          return session;
        }
      } catch (error) {
        log(`github: getSession(${scopes.join(' ')}) for ${account?.label ?? 'default'} failed: ${String(error)}`);
      }
    }
    log(`github: no silent session for ${account?.label ?? 'default account'} with any known Copilot scope set`);
    return undefined;
  };

  if (accounts.length) {
    await Promise.all(
      accounts.map(async (account) => {
        const session = await sessionFor(account);
        if (session) {
          result.push({ login: session.account.label || account.label, token: session.accessToken });
        }
      })
    );
  } else {
    const session = await sessionFor();
    if (session) {
      result.push({ login: session.account.label, token: session.accessToken });
    }
  }
  return result;
}

type GitApi = {
  repositories: Array<{ state: { remotes: Array<{ fetchUrl?: string; pushUrl?: string }> } }>;
};

/** GitHub owners (users/orgs) of the repositories open in this workspace. */
async function getWorkspaceOwners(): Promise<string[]> {
  const urls = new Set<string>();

  try {
    const gitExtension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
    const exports = gitExtension?.isActive ? gitExtension.exports : await gitExtension?.activate();
    for (const repo of exports?.getAPI(1).repositories ?? []) {
      for (const remote of repo.state.remotes) {
        for (const url of [remote.fetchUrl, remote.pushUrl]) {
          if (url) {
            urls.add(url);
          }
        }
      }
    }
  } catch {
    // Git extension unavailable; fall back to reading .git/config directly.
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') {
      continue;
    }
    try {
      const config = fs.readFileSync(path.join(folder.uri.fsPath, '.git', 'config'), 'utf8');
      for (const match of config.matchAll(/^\s*url\s*=\s*(.+)$/gm)) {
        urls.add(match[1].trim());
      }
    } catch {
      // Not a git repository or unreadable.
    }
  }

  const owners = new Set<string>();
  for (const url of urls) {
    const match = /github\.com[/:]([^/]+)\//i.exec(url);
    if (match) {
      owners.add(match[1]);
    }
  }
  return [...owners];
}

/**
 * Publishes the provider's chips beneath the chat input as context keys matched by the generated
 * `chat/input/status` menu items in package.json. `aiUsage.chip.<provider>.simple` selects the
 * single-figure item (most used window) or a state (`pending`, `unavailable`, `error`); in rich mode
 * `aiUsage.chip.<provider>.<window>` selects one item per window instead. All unset hides the chips.
 */
async function updateChipContext(provider: LiveProvider, enabled: boolean): Promise<void> {
  const keys = new Map<string, string | undefined>([['simple', undefined]]);
  for (const window of CHIP_WINDOWS[provider.id]) {
    keys.set(window, undefined);
  }
  if (enabled) {
    const result = provider.last;
    const usage = visibleUsage(provider);
    if (usage?.windows.length) {
      const rich = chipStyle().usage === 'rich'
        ? usage.windows.filter((window) => CHIP_WINDOWS[provider.id].includes(window.label))
        : [];
      if (rich.length) {
        for (const window of rich) {
          keys.set(window.label, String(Math.round(window.usedPercent)));
        }
      } else {
        keys.set('simple', String(worstPercent(usage)));
      }
    } else if (!result) {
      keys.set('simple', 'pending');
    } else {
      keys.set('simple', result.kind === 'error' ? 'error' : 'unavailable');
    }
  }
  await Promise.all(
    [...keys].map(([key, value]) => vscode.commands.executeCommand('setContext', `${CHIP_COMMAND_PREFIX}${provider.id}.${key}`, value))
  );
}

/** Claude and Codex items open that service's accounts; Copilot, which has none, opens the usage details. */
function clickCommand(provider: LiveProvider): vscode.Command {
  return provider.id === 'copilot'
    ? { command: 'aiUsage.showDetails', title: 'Show usage details' }
    : { command: 'aiUsage.manageAuthProfiles', title: 'Manage accounts', arguments: [provider.id] };
}

function visibleUsage(provider: LiveProvider): LiveUsage | undefined {
  return provider.last?.kind === 'ok' ? provider.last.usage : provider.lastGood;
}

function renderLive(provider: LiveProvider): void {
  if (provider.activeProfileId && provider.readingProfileId !== provider.activeProfileId()) {
    provider.last = undefined;
    provider.lastGood = undefined;
  }
  const result = provider.last;
  const usage = visibleUsage(provider);
  const item = provider.status;
  item.color = undefined;
  item.command = clickCommand(provider);
  if (!statusBarVisible()) {
    item.hide();
    return;
  }

  if ((!result || result.kind === 'unavailable') && !usage) {
    if (result?.reason && provider.id === 'copilot') {
      const needsAccess = result.reason.includes('No GitHub sign-in');
      item.text = statusText(provider, needsAccess ? 'connect' : 'n/a', 'Copilot');
      item.tooltip = needsAccess
        ? 'Copilot\nClick to allow AI Usage to read your GitHub Copilot quota with the account VS Code is signed in to.'
        : `Copilot\n${result.reason}\nSee Output → AI Usage for details.`;
      item.command = needsAccess ? 'aiUsage.connectGitHub' : 'aiUsage.showDetails';
      item.backgroundColor = undefined;
      item.show();
    } else if (provider.diagnostics) {
      item.text = statusText(provider, '$(clock)', PROVIDER_TITLES[provider.id]);
      const tooltip = new vscode.MarkdownString();
      for (const line of rotationTooltipLines(provider.diagnostics)) { tooltip.appendText(line); tooltip.appendMarkdown('\n\n'); }
      item.tooltip = tooltip; item.show();
    } else {
      item.hide();
    }
    return;
  }

  if (result?.kind === 'error' && !usage) {
    item.text = statusText(provider, '$(warning)', result.title);
    item.tooltip = `${result.title}\n${result.message}${provider.diagnostics ? '\n\n' + rotationTooltipLines(provider.diagnostics).join('\n') : ''}`;
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    item.show();
    return;
  }
  if (!usage) {
    const title = result?.kind === 'ok' ? result.usage.title : result?.kind === 'error' ? result.title : PROVIDER_TITLES[provider.id];
    item.text = statusText(provider, '$(clock)', title);
    item.tooltip = `${title}\nWaiting for a reading from the new quota window.`;
    item.backgroundColor = undefined;
    item.show();
    return;
  }
  const credits = provider.id === 'codex' ? projectResetCredits(usage) : undefined;
  const resetCount = formatEarnedResetCount(credits?.state === 'known' ? credits.availableCount : undefined,
    provider.id === 'codex' && vscode.workspace.getConfiguration().get<boolean>(CODEX_EARNED_RESETS_SETTING, true));
  const usageLabel = formatUsageLabel(usage, false, statusBarStyle().usage);
  item.text = statusText(provider, `${usageLabel}${resetCount ? ` ${resetCount}` : ''}`, usage.title);
  item.tooltip = buildTooltip(usage, result?.kind === 'error' ? result.message : undefined,
    provider.activeProfileName?.(), provider.diagnostics);
  item.color = Date.now() - usage.fetchedAt.getTime() >= STALE_AFTER_MS
    ? new vscode.ThemeColor('disabledForeground') : undefined;

  const worst = worstPercent(usage);
  if (worst >= ERROR_PERCENT) {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (worst >= WARNING_PERCENT) {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    item.backgroundColor = undefined;
  }
  item.show();
}

const PROVIDER_TITLES: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' };
const SIGN_IN_HINTS: Record<ProviderId, string> = {
  claude: 'run `claude` once and log in',
  codex: 'run `codex login`',
  copilot: 'sign in to GitHub in VS Code'
};

/** "this computer" or "the remote (ssh-remote)": where this extension host, and so the login it reads, lives. */
function hostDescription(): string {
  return vscode.env.remoteName ? `the remote (${vscode.env.remoteName})` : 'this computer';
}
function titleFor(provider: LiveProvider): string {
  return provider.lastGood?.title ?? PROVIDER_TITLES[provider.id];
}


/** True when this extension's status bar items can be seen: enabled here and VS Code's status bar is visible. */
function statusBarVisible(): boolean {
  const config = vscode.workspace.getConfiguration();
  return config.get<boolean>('aiUsage.statusBar.enabled', true) && config.get<boolean>('workbench.statusBar.visible', true) !== false;
}

/** The most used window's percentage: the figure of simple mode and of the status bar colouring. */
function worstPercent(usage: LiveUsage): number {
  return Math.round(Math.max(...usage.windows.map((window) => window.usedPercent)));
}

function usagePart(window: LiveUsage['windows'][number], now: Date): string {
  const reset = formatResetRemaining(window.resetsAt, now);
  return `${formatUsagePercent(window.usedPercent)}${reset ? ` (${reset})` : ''}`;
}

/**
 * Parentheses are a compact reset countdown, never the fixed window length. Rich shows up to two
 * windows, e.g. "Claude 17% (3h) 25% (3d)". Simple shows only the most-used window.
 */
function formatUsageLabel(usage: LiveUsage, withTitle = true, style: UsageStyle = 'rich'): string {
  const now = new Date();
  const worst = usage.windows.reduce((selected, window) =>
    window.usedPercent > selected.usedPercent ? window : selected
  );
  const parts = style === 'simple'
    ? [usagePart(worst, now)]
    : usage.windows.slice(0, 2).map((window) => usagePart(window, now));
  return withTitle ? `${usage.title} ${parts.join(' ')}` : parts.join(' ');
}

/** "#N" for the active saved profile when `aiUsage.<service>.statusBar.accountNumber` is on and several are saved. */
function accountNumberLabel(services: ServiceManager, provider: AuthProvider): string | undefined {
  const view = services.views[provider];
  if (!view || view.profiles.length < 2 || !vscode.workspace.getConfiguration().get<boolean>(`aiUsage.${provider}.statusBar.accountNumber`, true)) {
    return undefined;
  }
  return view.activeNumber === undefined ? undefined : `#${view.activeNumber}`;
}

function activeProfileName(services: ServiceManager, provider: AuthProvider): string | undefined {
  return services.views[provider]?.profiles.find((profile) => profile.active)?.name;
}

function accountsSummary(services: ServiceManager, provider: AuthProvider): string {
  const view = services.views[provider];
  if (!view) { return services.connected ? 'Loading…' : 'Account service not connected'; }
  const active = view.profiles.find((profile) => profile.active);
  if (active) { return active.name; }
  if (!view.profiles.length) { return 'None saved'; }
  return `${view.profiles.length} saved · ${view.nativeUnsaved ? 'current login not saved' : 'none active'}`;
}

function accountUsage(services: ServiceManager, provider: AuthProvider): LiveUsage | undefined {
  const view = services.views[provider];
  const reading = view?.activeNumber !== undefined ? view.profiles.find((profile) => profile.id === view.activeProfileId)?.usage : undefined;
  return reading ? deserializeUsage({ usage: reading }) : undefined;
}

/** A non-secret cache suffix prevents usage from one account appearing after switching to another. */


/** Status bar text: the figures behind whatever `aiUsage.statusBar.labels` puts in front of them, and the account number. */
function statusText(provider: LiveProvider, body: string, title?: string): string {
  const { labels } = statusBarStyle();
  const icon = labels === 'iconOnly' || labels === 'iconAndName' ? `$(${provider.icon}) ` : '';
  const name = (labels === 'nameOnly' || labels === 'iconAndName') && title ? `${title} ` : '';
  const account = provider.accountNumber?.();
  return `${icon}${name}${account ? `${account} ` : ''}${body}`.trimEnd();
}

function buildTooltip(usage: LiveUsage, refreshError?: string, activeProfile?: string, diagnostics?: RotationDiagnostics): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  if (refreshError) {
    const minutes = Math.round((Date.now() - usage.fetchedAt.getTime()) / 60_000);
    md.appendMarkdown(`$(warning) **Refresh failed** (${refreshError}). Showing the reading from ${minutes} min ago.\n\n`);
  }
  const heading = usage.subtitle ? `${usage.title} · ${usage.subtitle}` : usage.title;
  md.appendMarkdown(`**${heading}**${usage.plan ? ` · ${usage.plan}` : ''}\n\n`);
  // The details panel shows one compact row per service, so the full window names and exact reset
  // times live here.
  for (const window of usage.windows) {
    const reset = formatResetIn(window.resetsAt);
    const at = reset && window.resetsAt ? ` (${window.resetsAt.toLocaleString()})` : '';
    md.appendMarkdown(`- **${windowName(window.label)}**: ${formatUsagePercent(window.usedPercent)} used${reset ? ` · ${reset}${at}` : ''}\n`);
  }
  if (usage.provider === 'codex') {
    const credits = projectResetCredits(usage);
    if (credits.state === 'known') {
      const line = formatEarnedResets(credits);
      const expiry = credits.earliestExpiresAt ? ` · next credit expires ${new Date(credits.earliestExpiresAt * 1000).toLocaleString()}` : '';
      md.appendMarkdown(`\n- **Earned resets:** ${line}${expiry}\n`);
    } else if (credits.state === 'stale') {
      md.appendMarkdown(`\n- **Earned resets:** Availability stale · last reported ${credits.lastReportedAvailableCount}; current availability unknown.\n`);
    } else {
      md.appendMarkdown('\n- **Earned resets:** Availability unknown · not reported in the current account reading.\n');
    }
  }
  if (usage.details?.length) {
    md.appendMarkdown('\n');
    for (const line of usage.details) {
      md.appendMarkdown(`${line}  \n`);
    }
  }
  md.appendMarkdown(`\n_Updated ${usage.fetchedAt.toLocaleTimeString()}_`);
  if (usage.provider === 'claude' || usage.provider === 'codex') {
    md.appendMarkdown('\n\n$(key) ');
    md.appendText(activeProfile ? `Authentication profile: ${activeProfile}` : 'Manage authentication profiles');
  }
  if (diagnostics) {
    md.appendMarkdown('\n\n---\n\n**Rotation diagnostics**\n\n');
    for (const line of rotationTooltipLines(diagnostics)) {
      md.appendMarkdown('\n\n'); md.appendText(line);
    }
  }
  return md;
}

type DetailItem = vscode.QuickPickItem & {
  action?: 'refresh' | 'refreshProvider' | 'log' | 'history' | 'settings' | 'connect' | 'all' | 'profiles' | 'mcp' | 'service';
  providerId?: ProviderId;
};

const WINDOW_NAMES: Record<string, string> = {
  '5h': '5-hour window',
  '7d': '7-day window',
  month: 'Premium requests (month)',
  chat: 'Chat',
  completions: 'Completions'
};

function windowName(label: string): string {
  if (WINDOW_NAMES[label]) {
    return WINDOW_NAMES[label];
  }
  const scoped = /^7d (.+)$/.exec(label);
  return scoped ? `7-day window · ${scoped[1]}` : label;
}

function usageIcon(percent: number): string {
  if (percent >= ERROR_PERCENT) {
    return '$(error)';
  }
  if (percent >= WARNING_PERCENT) {
    return '$(warning)';
  }
  return '$(pass)';
}

function providerItems(provider: LiveProvider): DetailItem[] {
  const result = provider.last;
  const usage = visibleUsage(provider);
  const items: DetailItem[] = [];
  const title = usage?.title ?? (result?.kind === 'error' ? result.title : provider.id);
  const plan = usage?.plan ? ` · ${usage.plan}` : '';
  const who = usage?.subtitle ? ` · ${usage.subtitle}` : '';
  items.push({ label: `${title}${who}${plan}`, kind: vscode.QuickPickItemKind.Separator });
  if (provider.id === 'claude' || provider.id === 'codex') {
    items.push({
      label: '$(key) Accounts',
      description: provider.accountsSummary?.() ?? provider.activeProfileName?.() ?? 'None saved',
      detail: 'Save, name, and switch logins, or configure automatic account rotation.',
      action: 'profiles',
      providerId: provider.id
    });
  }

  if (!result && !usage) {
    items.push({ label: '$(clock) Waiting for first reading…' });
    return items;
  }
  if (result?.kind === 'unavailable' && !usage) {
    if (provider.id === 'copilot' && result.reason?.includes('No GitHub sign-in')) {
      items.push({
        label: '$(github) Connect GitHub account',
        detail: 'Allow AI Usage to read Copilot quota with the account VS Code is signed in to.',
        action: 'connect'
      });
      return items;
    }
    items.push({
      label: '$(circle-slash) Not available',
      detail: result.reason ?? `Not installed or not signed in ${hostDescription()}.`
    });
    items.push({
      label: '$(info) Where the login has to be',
      detail: `The extension reads ${PROVIDER_TITLES[provider.id]} where it runs (${hostDescription()}). In the Agents window that is always your local computer, even for remote sessions. Sign in there with the same account (${SIGN_IN_HINTS[provider.id]}); limits are per account, so the figures match.`
    });
    return items;
  }
  if (result?.kind === 'error') {
    items.push({
      label: '$(warning) Last refresh failed',
      detail: usage ? `${result.message} — showing the reading from ${usage.fetchedAt.toLocaleTimeString()}.` : result.message
    });
    if (!usage) {
      return items;
    }
  }
  if (!usage) {
    items.push({ label: '$(clock) Waiting for usage after reset', detail: 'Refresh now to check the new quota window.', action: 'refreshProvider', providerId: provider.id });
    return items;
  }

  // One row per service: every window with its countdown, the age of the reading, and a refresh on
  // click. Window names and exact reset times stay one hover away in the status bar tooltip.
  const now = new Date();
  const { source, checkIntervalMs } = settingsFor(provider.id);
  const throttledMs = 0;
  items.push({
    label: `${usageIcon(worstPercent(usage))} ${usage.windows.map((window) => `${window.label} ${usagePart(window, now)}`).join(' · ')}`,
    description: `Updated ${usage.fetchedAt.toLocaleTimeString()}`,
    detail: `Refresh now · ${SOURCE_LABELS[source] ?? source} · checked every ${formatInterval(checkIntervalMs)} · ` +
      (throttledMs > 0
        ? `next call to the service allowed in ${Math.ceil(throttledMs / 1000)}s`
        : `display refreshed every ${Math.round(updateIntervalMs() / 60_000)} min`),
    action: 'refreshProvider',
    providerId: provider.id
  });
  for (const line of usage.details ?? []) {
    const [key, ...rest] = line.split(': ');
    items.push(rest.length ? { label: `$(info) ${key}`, description: rest.join(': ') } : { label: `$(info) ${line}` });
  }
  return items;
}

/**
 * Details panel. With `focus` set (a chat chip was clicked) only that provider is shown, with
 * an action to expand to all providers; without it every provider is listed.
 */
async function showDetailsPanel(providers: LiveProvider[], refreshAll: () => Promise<void>,
  refreshOne: (provider: LiveProvider) => Promise<void>, focus?: ProviderId, serviceSummary?: () => string): Promise<void> {
  let focused: LiveProvider | undefined = providers.find((provider) => provider.id === focus);
  const build = (): DetailItem[] => {
    const items: DetailItem[] = [];
    for (const provider of focused ? [focused] : providers) {
      items.push(...providerItems(provider));
    }
    if (focused) {
      items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: '$(list-flat) Show all providers', action: 'all' });
    }
    if (!focused && hasUserConfiguredAccounts()) {
      items.push({ label: 'Configured accounts', kind: vscode.QuickPickItemKind.Separator });
      for (const account of getAccountUsage()) {
        const usedPercent = Math.round((account.usedTokens / account.tokenLimit) * 100);
        items.push({
          label: `${usageIcon(usedPercent)} ${account.name}`,
          description: `${usedPercent}% used · ${Math.max(0, account.tokenLimit - account.usedTokens).toLocaleString()} tokens left`,
          detail: `${account.period} · budget ${Math.max(0, account.budgetLimit - account.usedBudget)}/${account.budgetLimit} left`
        });
      }
    }
    if (!focused) {
      items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({ label: '$(refresh) Refresh now', action: 'refresh' });
    items.push({ label: '$(output) Open log', description: 'Output → AI Usage', action: 'log' });
    items.push({ label: '$(history) Usage history', description: 'readings, switches, how well rotation works', action: 'history' });
    if (!focused) {
      items.push({ label: '$(plug) Set up MCP server…', description: 'Enable account tools and register them with Claude or Codex', action: 'mcp' });
      // One account service serves both Claude and Codex, so it is controlled here rather than in either Accounts menu.
      items.push({ label: '$(server-process) Account service…', description: serviceSummary?.(), detail: 'Status, log, start, stop, install or uninstall, and the ai-usage command.', action: 'service' });
    }
    items.push(focused
      ? { label: `$(gear) ${titleFor(focused)} settings`, description: `aiUsage.${focused.id}.*`, action: 'settings', providerId: focused.id }
      : { label: '$(gear) Settings', description: 'aiUsage.*', action: 'settings' });
    return items;
  };

  const picker = vscode.window.createQuickPick<DetailItem>();
  const setTitle = () => {
    picker.title = focused ? `AI Usage · ${titleFor(focused)}` : 'AI Usage';
    picker.placeholder = focused
      ? `${titleFor(focused)} usage. Pick an action or press Escape to close.`
      : 'Usage per provider. Pick an action or press Escape to close.';
  };
  setTitle();
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.items = build();

  picker.onDidAccept(async () => {
    const picked = picker.selectedItems[0];
    if (!picked?.action) {
      return;
    }
    if (picked.action === 'refresh' || picked.action === 'refreshProvider') {
      const target = providers.find((candidate) => candidate.id === picked.providerId);
      picker.busy = true;
      await (picked.action === 'refreshProvider' && target ? refreshOne(target) : refreshAll());
      picker.items = build();
      picker.busy = false;
      return;
    }
    if (picked.action === 'all') {
      focused = undefined;
      setTitle();
      picker.items = build();
      return;
    }
    if (picked.action === 'connect') {
      picker.busy = true;
      await vscode.commands.executeCommand('aiUsage.connectGitHub');
      picker.items = build();
      picker.busy = false;
      return;
    }
    picker.hide();
    if (picked.action === 'profiles') {
      await vscode.commands.executeCommand('aiUsage.manageAuthProfiles', picked.providerId);
    } else if (picked.action === 'log') {
      output?.show(true);
    } else if (picked.action === 'history') {
      await vscode.commands.executeCommand('aiUsage.showUsageHistory');
    } else if (picked.action === 'mcp') {
      await vscode.commands.executeCommand('aiUsage.setupMcp');
    } else if (picked.action === 'service') {
      await vscode.commands.executeCommand('aiUsage.accountService');
    } else {
      await openAiUsageSettings(picked.providerId && `aiUsage.${picked.providerId}`);
    }
  });
  picker.onDidHide(() => picker.dispose());
  picker.show();
}



function hasUserConfiguredAccounts(): boolean {
  const info = vscode.workspace.getConfiguration().inspect<AccountUsage[]>('aiUsage.accounts');
  return Boolean(info?.globalValue || info?.workspaceValue || info?.workspaceFolderValue);
}

function getAccountUsage(): AccountUsage[] {
  const configured = vscode.workspace.getConfiguration().get<AccountUsage[]>('aiUsage.accounts', []);
  return configured.filter((entry) =>
    Boolean(entry?.name) &&
    Number.isFinite(entry?.usedTokens) &&
    Number.isFinite(entry?.tokenLimit) &&
    Number.isFinite(entry?.usedBudget) &&
    Number.isFinite(entry?.budgetLimit) &&
    entry.tokenLimit > 0
  );
}

function summarize(accounts: AccountUsage[]): { remainingPercent: number; lines: string[] } {
  if (!accounts.length) {
    return {
      remainingPercent: 0,
      lines: ['No AI usage accounts configured. Set aiUsage.accounts in settings.']
    };
  }

  const tokenUsed = accounts.reduce((sum, account) => sum + account.usedTokens, 0);
  const tokenLimit = accounts.reduce((sum, account) => sum + account.tokenLimit, 0);
  const remainingPercent = Math.max(0, Math.round(((tokenLimit - tokenUsed) / tokenLimit) * 100));

  const lines = accounts.map((account) => {
    const remainingTokens = Math.max(0, account.tokenLimit - account.usedTokens);
    const remainingBudget = Math.max(0, account.budgetLimit - account.usedBudget);
    return `${account.name} (${account.period}) • ${remainingTokens.toLocaleString()} tokens left • ${remainingBudget}/${account.budgetLimit} budget left`;
  });

  return { remainingPercent, lines };
}

export async function deactivate(): Promise<void> {
  await activeServices?.stop();
  activeServices = undefined;
}
