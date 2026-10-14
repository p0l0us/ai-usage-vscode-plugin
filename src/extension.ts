import { configFromSettings } from './configSync';
import { readServiceUsage } from './usageClient';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { configureBridgeService, registerBridgeIntegration } from './bridgeIntegration';
import { registerBridgeModels } from './bridgeModels';
import {
  configKeys,
  usageSettings,
  ActivationChange,
  AuthProvider,
  KeepAliveResult,
  KeepAliveAllResult,
  ProviderId,
  ServiceEvent,
  activationMessage,
} from '../service/out';
import { AccountsMenu } from './accountsMenu';
import { signInWithTerminal } from './accountLogin';
import { registerMcpProvider } from './mcpProvider';
import { MCP_SERVER_NAME } from './mcpRegistration';
import { ServiceManager } from './serviceManager';
import { openAiUsageSettings } from './settingsLink';
import { compactTokenCount, SessionTokenUsage } from './sessionTokens';
import { CODEX_EARNED_RESETS_SETTING, codexUsageSettingsChanged } from './statusBarSettings';
import { accountNumberLabel, accountsSummary, accountUsage, activeProfileName } from './accountViews';
import {
  AGENTS_WINDOW_HINT_KEY, AGENTS_WINDOW_SETTING, AGENTS_WINDOW_WALKTHROUGH, AgentsWindowHost,
  enableAgentsWindow as enableAgentsWindowWith, maybeOfferAgentsWindowSetup as maybeOfferAgentsWindowSetupWith
} from './agentsWindow';
import {
  CODEX_SWITCH_KEY, CODEX_SWITCH_NOTIFIED_KEY, CodexSwitchRecord, codexSwitchRecord, recordsCodexSwitch, warnAboutStaleCodexProcesses as warnAboutStaleCodexProcessesWith
} from './codexSwitch';
import { buildDetailItems, DetailItem, DetailsEnv, hostDescription, titleFor } from './detailsItems';
import {
  GITHUB_ACCESS_REQUESTED_KEY, connectGitHub as connectGitHubWith, getGitHubAccounts as getGitHubAccountsWith, ownersFromRemoteUrls,
  remoteUrlsFromGitConfig
} from './githubAccess';
import { historyExportName, historyItems, historyPlaceholder } from './historyMenu';
import { AccountUsage, hasUserConfiguredAccounts as hasUserConfiguredAccountsIn, manualStatus, validAccounts } from './manualAccounts';
import {
  accountProblemMessage, keepAliveNotSentMessage, keepAliveOutcome, keepAliveSweepOutcome, noCandidateMessage, providerTitle,
  accountLabel, resetConfirmationDetail
} from './accountMessages';
import { displayedMcpCommand, mcpSetupItems, mcpWhere } from './mcpSetupItems';
import { applyStatusItem, clickCommand, LiveProvider, statusItemModel, visibleUsage } from './statusItem';
import {
  CHIP_COMMAND_PREFIX, PROVIDER_TITLES, chatTokenChipCommands, chatTokensMessage, chipCommands, chipContextValues, chipStyle,
  chipsInWorkbench, statusBarStyle, statusBarVisible as statusBarVisibleIn, updateIntervalMs as updateIntervalMsIn
} from './usageLabels';

/**
 * Status bar placement. VS Code's own Copilot entry sits immediately right of the language-mode
 * item (priority 100.1, right aligned); these priorities land just left of that pair.
 */
const STATUS_ALIGNMENT = vscode.StatusBarAlignment.Right;
const STATUS_PRIORITY = { manual: 100.19, claude: 100.18, codex: 100.17, copilot: 100.16 };

function settingsFor(provider: ProviderId) { return usageSettings(configFromSettings(), provider); }

const workspaceConfig = () => vscode.workspace.getConfiguration();
const statusBarVisible = () => statusBarVisibleIn(workspaceConfig());
const updateIntervalMs = () => updateIntervalMsIn(workspaceConfig());
const hasUserConfiguredAccounts = () => hasUserConfiguredAccountsIn(workspaceConfig().inspect<AccountUsage[]>('aiUsage.accounts'));
const getAccountUsage = (): AccountUsage[] => validAccounts(workspaceConfig().get<AccountUsage[]>('aiUsage.accounts', []));


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
  serviceState = { problem: () => services.problem(), hasView: (id) => Boolean(services.views[id as AuthProvider]) };
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
      activeProfileUsage: () => accountUsage(services, id), accountNumber: () => accountNumberLabel(services, id, workspaceConfig())
    })
  }));
  const sessionTokens = new Map<'claude' | 'codex', SessionTokenUsage>();
  for (const provider of liveProviders) {
    provider.status.command = clickCommand(provider.id);
    provider.status.name = `AI Usage: ${provider.id}`;
    context.subscriptions.push(provider.status);
  }

  const refreshManual = () => {
    const manual = manualStatus(getAccountUsage());
    status.text = manual.text;
    status.tooltip = manual.tooltip;
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
        if (!client) throw new Error(services.problem() ?? 'The account service is unavailable; waiting to reconnect.');
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
  const warnAboutStaleCodexProcesses = (): Promise<void> => warnAboutStaleCodexProcessesWith({
    hintEnabled: () => workspaceConfig().get<boolean>('aiUsage.codex.switchRestartHint', false),
    proxyActive: () => Boolean(services.runtimeStatus.codexProxyActive),
    record: () => context.globalState.get<CodexSwitchRecord>(CODEX_SWITCH_KEY),
    notified: () => context.workspaceState.get<number>(CODEX_SWITCH_NOTIFIED_KEY),
    markNotified: (switchedAt) => context.workspaceState.update(CODEX_SWITCH_NOTIFIED_KEY, switchedAt),
    findStale: (record) => services.require().call('runtime.staleCodex', { switchedAt: record.switchedAt, parentPid: process.pid }),
    log,
    warn: (message, ...actions) => vscode.window.showWarningMessage(message, ...actions),
    restartExtensionHost: () => vscode.commands.executeCommand('workbench.action.restartExtensionHost')
  });
  const afterProfileActivated = async (provider: AuthProvider, change: ActivationChange = { kind: 'activated', accountChanged: true }) => {
    const live = liveProviders.find((candidate) => candidate.id === provider)!;
    await live.inFlight;
    live.last = undefined;
    live.lastGood = undefined;
    live.readingProfileId = undefined;
    renderLive(live);
    await updateChipContext(live, vscode.workspace.getConfiguration().get<boolean>('aiUsage.chatChips.enabled', true));
    // Claude Code and Codex differ in how a switch reaches open chats; see recordsCodexSwitch.
    if (recordsCodexSwitch(provider, change)) {
      const record = codexSwitchRecord(activeProfileName(services, 'codex'), Date.now());
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
    const title = providerTitle(provider);
    let client;
    try { client = services.require(); } catch (error) { void vscode.window.showErrorMessage(`AI Usage: ${error instanceof Error ? error.message : String(error)}`); return false; }
    const profile = (services.views[provider] ?? await client.list(provider)).profiles.find((candidate) => candidate.id === id);
    if (!profile) { return false; }
    const who = accountLabel(profile.name, profile.email);
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
    if (!event.revoked) {
      void vscode.window.showWarningMessage(accountProblemMessage(event));
      return;
    }
    const choice = await vscode.window.showWarningMessage(accountProblemMessage(event), 'Sign in again', 'Skip');
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
          const choice = await vscode.window.showWarningMessage(
            `AI Usage: use earned Codex resets for “${decision.accountName}”?`,
            { modal: true, detail: resetConfirmationDetail(decision) },
            'Use earned resets');
          if (!client.connected || services.connected !== client) return;
          const result = await client.resolveReset(decision.id, choice === 'Use earned resets');
          if (result.status === 'stale') void vscode.window.showInformationMessage('AI Usage: the reset decision changed or expired. No reset was approved.');
        })().catch(error => log(`reset confirmation: ${String(error)}`));
        break;
      }
      case 'accountProblem': void reportAccountProblem(event); break;
      case 'noCandidate': {
        void vscode.window.showWarningMessage(noCandidateMessage(event.provider, event.detail), 'Accounts', 'Settings').then((choice) => {
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
    const title = providerTitle(provider);
    const client = services.require();
    const { launcher, command, cli, reason, registration: before } = await client.call('mcp.registration', { provider });
    const displayedCommand = displayedMcpCommand(launcher, command);
    if (!fs.existsSync(launcher)) {
      void vscode.window.showWarningMessage(`AI Usage: the MCP command is unavailable: ${displayedCommand}. Check Account service… before registering it with the ${title} CLI.`);
      return;
    }
    if (!cli) { void vscode.window.showErrorMessage(`AI Usage: ${reason}`); return; }
    const where = mcpWhere(provider);
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
      const registrations = client && enabled ? {
        claude: (await client.call('mcp.registration', { provider: 'claude' })).registration,
        codex: (await client.call('mcp.registration', { provider: 'codex' })).registration
      } : undefined;
      const items = mcpSetupItems(Boolean(client), enabled, registrations);
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
        const title = providerTitle(provider);
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
            void vscode.window.showWarningMessage(keepAliveNotSentMessage(provider, profile.name, error));
            return;
          }
          const outcome = keepAliveOutcome(provider, profile.name, result);
          if (outcome.dead) {
            const choice = await vscode.window.showWarningMessage(outcome.message, 'Sign in again', 'Skip');
            if (choice === 'Sign in again') { await signInAgain(provider, profile.id); }
          } else if (outcome.severity === 'info') {
            void vscode.window.showInformationMessage(outcome.message);
          } else {
            void vscode.window.showWarningMessage(outcome.message);
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
          const outcome = keepAliveSweepOutcome(provider, sweep);
          if (outcome.severity === 'warning') {
            void vscode.window.showWarningMessage(outcome.message);
          } else {
            void vscode.window.showInformationMessage(outcome.message);
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
  for (const { command, target } of chipCommands(manifestCommands, providerIds)) {
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
    void vscode.window.showInformationMessage(chatTokensMessage(providerId, sessionTokens.get(providerId)));
  }));
  for (const { command, providerId } of chatTokenChipCommands(manifestCommands)) {
    context.subscriptions.push(vscode.commands.registerCommand(command, () =>
      vscode.commands.executeCommand('aiUsage.showChatTokens', providerId)
    ));
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
    const inWorkbench = chipsInWorkbench(mode, chipsEnabled, statusBarVisible());
    await Promise.all([
      vscode.commands.executeCommand('setContext', `${CHIP_COMMAND_PREFIX}workbench`, inWorkbench),
      vscode.commands.executeCommand('setContext', `${CHIP_COMMAND_PREFIX}named`, chipStyle(workspaceConfig()).named)
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

/** The usage history menu: a summary of a period as a Markdown document, exports, the files and the settings; all from the service. */
async function showUsageHistory(services: ServiceManager): Promise<void> {
  const client = services.require();
  const info = await client.historyInfo();
  const picked = await vscode.window.showQuickPick(historyItems(info, vscode.QuickPickItemKind.Separator), {
    title: 'AI Usage · Usage history', matchOnDescription: true,
    placeHolder: historyPlaceholder(info)
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
    defaultUri: vscode.Uri.file(path.join(os.homedir(), historyExportName(kind, exported.extension, new Date()))),
    filters: kind === 'jsonl' ? { 'JSON Lines': ['jsonl'] } : { CSV: ['csv'] }
  });
  if (!target) { return; }
  await vscode.workspace.fs.writeFile(target, Buffer.from(exported.text, 'utf8'));
  const choice = await vscode.window.showInformationMessage(`AI Usage: usage history exported to ${target.fsPath}.`, 'Open');
  if (choice === 'Open') { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target)); }
}

/** What the Agents window setup offers read from and write to this window. */
function agentsWindowHost(context: vscode.ExtensionContext): AgentsWindowHost {
  return {
    extensionId: context.extension.id,
    effectiveSetting: () => workspaceConfig().get<Record<string, boolean>>(AGENTS_WINDOW_SETTING),
    globalSetting: () => workspaceConfig().inspect<Record<string, boolean>>(AGENTS_WINDOW_SETTING)?.globalValue,
    updateGlobalSetting: (value) => workspaceConfig().update(AGENTS_WINDOW_SETTING, value, vscode.ConfigurationTarget.Global),
    chipsEnabled: () => workspaceConfig().get<boolean>('aiUsage.chatChips.agentsWindow', true),
    hintShown: () => context.globalState.get<boolean>(AGENTS_WINDOW_HINT_KEY),
    markHintShown: () => context.globalState.update(AGENTS_WINDOW_HINT_KEY, true),
    remote: () => Boolean(vscode.env.remoteName),
    info: (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
    error: (message) => { void vscode.window.showErrorMessage(message); },
    log,
    run: (command, ...args) => vscode.commands.executeCommand(command, ...args)
  };
}
const enableAgentsWindow = (context: vscode.ExtensionContext) => enableAgentsWindowWith(agentsWindowHost(context));
const maybeOfferAgentsWindowSetup = (context: vscode.ExtensionContext) => maybeOfferAgentsWindowSetupWith(agentsWindowHost(context));

const connectGitHub = () => connectGitHubWith(vscode.authentication, workspaceConfig().get<string>('aiUsage.copilot.account'), log);
const getGitHubAccounts = () => getGitHubAccountsWith(vscode.authentication, log);

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
      for (const url of remoteUrlsFromGitConfig(config)) {
        urls.add(url);
      }
    } catch {
      // Not a git repository or unreadable.
    }
  }

  return ownersFromRemoteUrls(urls);
}

/**
 * Publishes the provider's chips beneath the chat input as context keys matched by the generated
 * `chat/input/status` menu items in package.json (see chipContextValues).
 */
async function updateChipContext(provider: LiveProvider, enabled: boolean): Promise<void> {
  const keys = chipContextValues(provider.id, enabled, provider.last, visibleUsage(provider), chipStyle(workspaceConfig()).usage === 'rich');
  await Promise.all(
    [...keys].map(([key, value]) => vscode.commands.executeCommand('setContext', `${CHIP_COMMAND_PREFIX}${provider.id}.${key}`, value))
  );
}

/** The account service connection as `renderLive` needs it; set on activation. */
let serviceState: { problem(): string | undefined; hasView(id: ProviderId): boolean } = { problem: () => undefined, hasView: () => false };

function renderLive(provider: LiveProvider): void {
  const serviceProblem = serviceState.problem();
  // Only a connected service's view can say the active account changed; a lost connection keeps the last readings.
  if (!serviceProblem && provider.activeProfileId && serviceState.hasView(provider.id) && provider.readingProfileId !== provider.activeProfileId()) {
    provider.last = undefined;
    provider.lastGood = undefined;
  }
  const now = new Date();
  const model = statusItemModel(provider, {
    barVisible: statusBarVisible(),
    labels: statusBarStyle(workspaceConfig()).labels,
    usageStyle: statusBarStyle(workspaceConfig()).usage,
    earnedResetsEnabled: workspaceConfig().get<boolean>(CODEX_EARNED_RESETS_SETTING, true),
    now,
    serviceProblem
  });
  applyStatusItem(provider.status, model, clickCommand(provider.id), vscode, now);
}

/**
 * Details panel. With `focus` set (a chat chip was clicked) only that provider is shown, with
 * an action to expand to all providers; without it every provider is listed.
 */
async function showDetailsPanel(providers: LiveProvider[], refreshAll: () => Promise<void>,
  refreshOne: (provider: LiveProvider) => Promise<void>, focus?: ProviderId, serviceSummary?: () => string): Promise<void> {
  let focused: LiveProvider | undefined = providers.find((provider) => provider.id === focus);
  const build = (): DetailItem[] => {
    const env: DetailsEnv = {
      separator: vscode.QuickPickItemKind.Separator, now: new Date(), host: hostDescription(vscode.env.remoteName),
      settingsFor, updateIntervalMs: updateIntervalMs()
    };
    return buildDetailItems(providers, focused, env, { configured: !focused && hasUserConfiguredAccounts(), usage: getAccountUsage }, serviceSummary);
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

export async function deactivate(): Promise<void> {
  await activeServices?.stop();
  activeServices = undefined;
}
