import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SharedCache, deserializeUsage } from './cache';
import {
  GitHubAccount,
  LiveResult,
  LiveUsage,
  ProviderId,
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchCodexUsageCli,
  fetchCodexUsageFromSessionLog,
  fetchCopilotUsage,
  formatResetIn
} from './live';

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
  fetch: () => Promise<LiveResult>;
  /** Distinguishes cache entries when the result depends on the workspace (Copilot org). */
  cacheDiscriminator?: () => Promise<string | undefined>;
  last?: LiveResult;
  /** Most recent successful reading, kept so errors do not blank the item. */
  lastGood?: LiveUsage;
  /** In-flight refresh for this provider only; failures elsewhere never wait on it. */
  inFlight?: Promise<void>;
};

/** Data source per provider, selected with `aiUsage.<provider>.source`. */
type SourceId = 'api' | 'cli' | 'sessionLog';
const SOURCE_LABELS: Record<SourceId, string> = { api: 'service API', cli: 'local CLI', sessionLog: 'local session log' };
const DEFAULT_CHECK_MINUTES: Record<ProviderId, number> = { claude: 10, codex: 5, copilot: 5 };

function settingsFor(provider: ProviderId) {
  const config = vscode.workspace.getConfiguration();
  const legacy = config.get<number>('aiUsage.refreshIntervalMinutes');
  const check = config.get<number>(`aiUsage.${provider}.checkIntervalMinutes`);
  const source = config.get<string>(`aiUsage.${provider}.source`, 'api') as SourceId;
  return {
    source,
    /** How often the source is called and the result stored in the shared cache. */
    checkIntervalMs: Math.max(1, check ?? legacy ?? DEFAULT_CHECK_MINUTES[provider]) * 60_000
  };
}

/** How often every window re-reads the shared cache and redraws (`aiUsage.updateIntervalMinutes`). */
function updateIntervalMs(): number {
  return Math.max(0.25, vscode.workspace.getConfiguration().get<number>('aiUsage.updateIntervalMinutes', 1)) * 60_000;
}

/** After this long, a reading shown in place of a failed refresh is greyed out. */
const STALE_AFTER_MS = 15 * 60_000;
const GITHUB_ACCESS_REQUESTED_KEY = 'aiUsage.githubAccessRequested';
/** Scopes used when asking the user to grant access; Copilot itself signs in with these. */
const GITHUB_CONNECT_SCOPES = ['user:email'];

let output: vscode.OutputChannel | undefined;
function log(message: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('AI Usage');
  context.subscriptions.push(output);
  // Status bar items carry their figures in the tooltip and have no click action: VS Code only
  // lets its own entries open the tooltip on click, and a quick pick would duplicate the hover.
  const status = vscode.window.createStatusBarItem(STATUS_ALIGNMENT, STATUS_PRIORITY.manual);
  status.name = 'AI Usage';
  context.subscriptions.push(status);

  const liveProviders: LiveProvider[] = [
    {
      id: 'claude',
      // Built-in codicons for the vendor logos (VS Code 1.130+).
      icon: 'claude',
      settingKey: 'aiUsage.claude.enabled',
      status: vscode.window.createStatusBarItem(STATUS_ALIGNMENT, STATUS_PRIORITY.claude),
      fetch: fetchClaudeUsage
    },
    {
      id: 'codex',
      icon: 'openai',
      settingKey: 'aiUsage.codex.enabled',
      status: vscode.window.createStatusBarItem(STATUS_ALIGNMENT, STATUS_PRIORITY.codex),
      fetch: async () => {
        const { source } = settingsFor('codex');
        if (source === 'cli') {
          return fetchCodexUsageCli(vscode.workspace.getConfiguration().get<string>('aiUsage.codex.cliPath') || 'codex');
        }
        if (source === 'sessionLog') {
          return fetchCodexUsageFromSessionLog();
        }
        return fetchCodexUsage();
      }
    },
    {
      id: 'copilot',
      icon: 'copilot',
      settingKey: 'aiUsage.copilot.enabled',
      status: vscode.window.createStatusBarItem(STATUS_ALIGNMENT, STATUS_PRIORITY.copilot),
      fetch: async () =>
        fetchCopilotUsage(getGitHubAccounts, {
          workspaceOwners: await getWorkspaceOwners(),
          preferredLogin: vscode.workspace.getConfiguration().get<string>('aiUsage.copilot.account') || undefined,
          log
        }),
      cacheDiscriminator: async () => {
        const owners = (await getWorkspaceOwners()).map((owner) => owner.toLowerCase()).sort();
        const login = vscode.workspace.getConfiguration().get<string>('aiUsage.copilot.account') || '';
        return `${login}|${owners.join(',')}`;
      }
    }
  ];

  const cache = new SharedCache(path.join(context.globalStorageUri.fsPath, 'usage-cache.json'));
  log(`cache: ${path.join(context.globalStorageUri.fsPath, 'usage-cache.json')}`);
  for (const provider of liveProviders) {
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


  /**
   * Refreshes one provider. Order of preference: a fresh reading from the shared cache (another
   * window fetched it), then the network unless the shared backoff or another window's in-flight
   * fetch says to wait. Providers never wait on each other.
   */
  const refreshProvider = (provider: LiveProvider, force: boolean): Promise<void> => {
    if (provider.inFlight) {
      return provider.inFlight;
    }
    provider.inFlight = (async () => {
      const config = vscode.workspace.getConfiguration();
      if (!config.get<boolean>(provider.settingKey, true)) {
        provider.last = { kind: 'unavailable', provider: provider.id };
        provider.status.hide();
        await updateChipContext(provider, false);
        return;
      }

      // Show the chat chip right away; until the first reading arrives a click says it is waiting.
      await updateChipContext(provider, config.get<boolean>('aiUsage.chatChips.enabled', true));

      const { source, checkIntervalMs } = settingsFor(provider.id);
      // Each source has its own cache entry so switching sources never shows another source's reading.
      const key = SharedCache.key(provider.id, [source, await provider.cacheDiscriminator?.()].filter(Boolean).join('|'));
      const now = Date.now();
      const entry = cache.read(key);
      const cached = deserializeUsage(entry);
      if (cached && (!provider.lastGood || cached.fetchedAt > provider.lastGood.fetchedAt)) {
        provider.lastGood = cached;
      }
      const cachedAge = cached ? now - cached.fetchedAt.getTime() : Number.POSITIVE_INFINITY;
      let result: LiveResult | undefined;

      if (!force && cached && cachedAge < checkIntervalMs) {
        result = { kind: 'ok', usage: cached };
        if (provider.last?.kind !== 'ok' || provider.last.usage.fetchedAt.getTime() !== cached.fetchedAt.getTime()) {
          log(`${provider.id}: using shared cache (${Math.round(cachedAge / 1000)}s old)`);
        }
      } else if (entry?.nextAllowedAt && entry.nextAllowedAt > now) {
        const waitMinutes = Math.ceil((entry.nextAllowedAt - now) / 60_000);
        result = {
          kind: 'error',
          provider: provider.id,
          title: titleFor(provider),
          message: `${entry.lastError ?? 'Earlier request failed'} — retrying in ${waitMinutes} min`,
          transient: true
        };
      } else if (!cache.tryLock(key, now)) {
        // Another window is fetching right now; its result will show up in the cache shortly.
        log(`${provider.id}: another window is fetching, waiting for the shared cache`);
        result = provider.last ?? (cached ? { kind: 'ok', usage: cached } : undefined);
      } else {
        // Fetch in the background: keep whatever is currently shown (previous reading or nothing
        // on first load) until the new result arrives.
        try {
          result = await provider.fetch();
        } catch (error) {
          result = { kind: 'error', provider: provider.id, title: titleFor(provider), message: String(error), transient: true };
        }
        if (result.kind === 'ok') {
          cache.recordSuccess(key, result.usage);
        } else if (result.kind === 'error' && result.transient) {
          const until = cache.recordBackoff(key, result.message, result.retryAfterMs, Date.now());
          log(`${provider.id}: backing off until ${new Date(until).toLocaleTimeString()}${result.retryAfterMs ? ' (Retry-After)' : ''}`);
        } else if (result.kind === 'error') {
          cache.recordFailure(key, result.message);
        } else {
          cache.release(key);
        }
        log(`${provider.id} [${SOURCE_LABELS[source] ?? source}]: ${summarizeResult(result)}`);
      }

      if (result) {
        provider.last = result;
        if (result.kind === 'ok') {
          provider.lastGood = result.usage;
        }
      }
      renderLive(provider);
      await updateChipContext(provider, config.get<boolean>('aiUsage.chatChips.enabled', true));
    })().finally(() => {
      provider.inFlight = undefined;
    });
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
    showDetailsDialog(liveProviders, refreshAll, typeof providerId === 'string' ? (providerId as ProviderId) : undefined)
  ));

  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.refresh', refreshAll));
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.openLog', () => output?.show(true)));
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

  // Every generated chat chip command (aiUsage.chip.<provider>.<state>, see
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
    await vscode.commands.executeCommand('setContext', `${CHIP_COMMAND_PREFIX}workbench`, inWorkbench);
  };
  void updateChipPresentation();
  log(`host: ${vscode.env.appName} · uiKind=${vscode.env.uiKind === vscode.UIKind.Desktop ? 'desktop' : 'web'} · remote=${vscode.env.remoteName ?? 'none'} · extensionKind=${context.extension.extensionKind === vscode.ExtensionKind.UI ? 'ui' : 'workspace'}`);

  // The workspace's repositories decide which Copilot account/organization applies.
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshLive()));

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
    if (
      event.affectsConfiguration('aiUsage.claude') ||
      event.affectsConfiguration('aiUsage.codex') ||
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
    if (event.affectsConfiguration('aiUsage.statusBar')) {
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

  void refreshAll().then(maybeRequestGitHubAccess).then(() => maybeOfferAgentsWindowSetup(context));
}

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
 * Publishes the state of the provider's chip beneath the chat input as the `aiUsage.chip.<provider>`
 * context key, matched by the generated `chat/input/status` menu items in package.json. Each state is
 * a separate text command whose title is the chip ("Claude 17%"): the percent of the most used window
 * (the one that colours the status bar), or `unavailable`, `error` and `pending`. Unset hides the chip.
 */
async function updateChipContext(provider: LiveProvider, enabled: boolean): Promise<void> {
  const result = provider.last;
  let state: string | undefined;
  if (enabled) {
    const usage = result?.kind === 'ok' ? result.usage : result?.kind === 'error' ? provider.lastGood : undefined;
    if (usage?.windows.length) {
      state = String(Math.max(...usage.windows.map((window) => window.usedPercent)));
    } else if (!result) {
      state = 'pending';
    } else {
      state = result.kind === 'error' ? 'error' : 'unavailable';
    }
  }
  await vscode.commands.executeCommand('setContext', `${CHIP_COMMAND_PREFIX}${provider.id}`, state);
}

function renderLive(provider: LiveProvider): void {
  const result = provider.last;
  const item = provider.status;
  item.color = undefined;
  item.command = undefined;
  if (!statusBarVisible()) {
    item.hide();
    return;
  }

  if (!result || result.kind === 'unavailable') {
    if (result?.reason && provider.id === 'copilot') {
      const needsAccess = result.reason.includes('No GitHub sign-in');
      item.text = statusText(provider, needsAccess ? 'connect' : 'n/a', 'Copilot');
      item.tooltip = needsAccess
        ? 'Copilot\nClick to allow AI Usage to read your GitHub Copilot quota with the account VS Code is signed in to.'
        : `Copilot\n${result.reason}\nSee Output → AI Usage for details.`;
      item.command = needsAccess ? 'aiUsage.connectGitHub' : undefined;
      item.backgroundColor = undefined;
      item.show();
    } else {
      item.hide();
    }
    return;
  }

  if (result.kind === 'error') {
    const previous = provider.lastGood;
    if (!previous) {
      item.text = statusText(provider, '$(warning)', result.title);
      item.tooltip = `${result.title}\n${result.message}`;
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      item.show();
      return;
    }
    // Keep the last reading visible; grey it out once it is old enough to mislead.
    const ageMs = Date.now() - previous.fetchedAt.getTime();
    item.text = statusText(provider, formatUsageLabel(previous, false), previous.title);
    item.tooltip = buildTooltip(previous, result.message);
    item.backgroundColor = undefined;
    item.color = ageMs >= STALE_AFTER_MS ? new vscode.ThemeColor('disabledForeground') : undefined;
    item.show();
    return;
  }

  const usage = result.usage;
  item.text = statusText(provider, formatUsageLabel(usage, false), usage.title);
  item.tooltip = buildTooltip(usage);

  const worst = Math.max(...usage.windows.map((window) => window.usedPercent));
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

/** Whether status bar items show the service name next to the icon (`aiUsage.statusBar.labels`). */
function showServiceLabels(): boolean {
  return vscode.workspace.getConfiguration().get<string>('aiUsage.statusBar.labels', 'iconOnly') === 'iconAndName';
}

/** True when this extension's status bar items can be seen: enabled here and VS Code's status bar is visible. */
function statusBarVisible(): boolean {
  const config = vscode.workspace.getConfiguration();
  return config.get<boolean>('aiUsage.statusBar.enabled', true) && config.get<boolean>('workbench.statusBar.visible', true) !== false;
}

/** "Claude 17% (5h) 25% (7d)", "Codex 37% (7d)", "Copilot 75%" (Copilot has a single monthly window). */
function formatUsageLabel(usage: LiveUsage, withTitle = true): string {
  const primary = usage.windows.slice(0, 2);
  const parts = primary.map((window) =>
    usage.provider === 'copilot' ? `${window.usedPercent}%` : `${window.usedPercent}% (${window.label})`
  );
  return withTitle ? `${usage.title} ${parts.join(' ')}` : parts.join(' ');
}

/** Status bar text: vendor icon, optional service name, then the figures. */
function statusText(provider: LiveProvider, body: string, title?: string): string {
  const name = showServiceLabels() && title ? `${title} ` : '';
  return `$(${provider.icon}) ${name}${body}`.trimEnd();
}

/** Text of a reading. The status bar tooltip and the details dialog are both rendered from it. */
type UsageText = {
  /** "Copilot · CircleHash" */
  heading: string;
  plan?: string;
  /** "(reason). Showing the reading from N min ago." when shown in place of a failed refresh. */
  refreshFailed?: string;
  /** "50% used · resets in 19d 6h" per window. */
  windows: Array<{ label: string; text: string }>;
  details: string[];
  updated: string;
};

function describeUsage(usage: LiveUsage, refreshError?: string): UsageText {
  const minutes = Math.round((Date.now() - usage.fetchedAt.getTime()) / 60_000);
  return {
    heading: usage.subtitle ? `${usage.title} · ${usage.subtitle}` : usage.title,
    plan: usage.plan,
    refreshFailed: refreshError ? `(${refreshError}). Showing the reading from ${minutes} min ago.` : undefined,
    windows: usage.windows.map((window) => {
      const reset = formatResetIn(window.resetsAt);
      return { label: window.label, text: `${window.usedPercent}% used${reset ? ` · ${reset}` : ''}` };
    }),
    details: usage.details ?? [],
    updated: `Updated ${usage.fetchedAt.toLocaleTimeString()}`
  };
}

function buildTooltip(usage: LiveUsage, refreshError?: string): vscode.MarkdownString {
  const text = describeUsage(usage, refreshError);
  const md = new vscode.MarkdownString(undefined, true);
  if (text.refreshFailed) {
    md.appendMarkdown(`$(warning) **Refresh failed** ${text.refreshFailed}\n\n`);
  }
  md.appendMarkdown(`**${text.heading}**${text.plan ? ` · ${text.plan}` : ''}\n\n`);
  for (const window of text.windows) {
    md.appendMarkdown(`- **${window.label}**: ${window.text}\n`);
  }
  if (text.details.length) {
    md.appendMarkdown('\n');
    for (const line of text.details) {
      md.appendMarkdown(`${line}  \n`);
    }
  }
  md.appendMarkdown(`\n_${text.updated}_`);
  return md;
}

/** The tooltip's lines as plain text, for the details dialog. */
function plainText(text: UsageText): { heading: string; lines: string[] } {
  const lines: string[] = [];
  if (text.refreshFailed) {
    lines.push(`Refresh failed ${text.refreshFailed}`, '');
  }
  lines.push(...text.windows.map((window) => `${window.label}: ${window.text}`));
  if (text.details.length) {
    lines.push('', ...text.details);
  }
  lines.push('', text.updated);
  return { heading: text.plan ? `${text.heading} · ${text.plan}` : text.heading, lines };
}

type DetailsAction = 'connect' | 'refresh' | 'log';
const ACTION_LABELS: Record<DetailsAction, string> = {
  connect: 'Connect GitHub account',
  refresh: 'Refresh',
  log: 'Open log'
};

/** One provider's part of the details dialog: heading, body lines and the buttons that make sense. */
function providerText(provider: LiveProvider): { heading: string; lines: string[]; actions: DetailsAction[] } {
  const result = provider.last;
  const title = PROVIDER_TITLES[provider.id];
  if (!vscode.workspace.getConfiguration().get<boolean>(provider.settingKey, true)) {
    return { heading: title, lines: [`Disabled by the ${provider.settingKey} setting.`], actions: [] };
  }
  if (!result) {
    return { heading: title, lines: ['Waiting for the first reading…'], actions: ['refresh'] };
  }
  if (result.kind === 'unavailable') {
    if (provider.id === 'copilot' && result.reason?.includes('No GitHub sign-in')) {
      return {
        heading: title,
        lines: ['Allow AI Usage to read your GitHub Copilot quota with the account VS Code is signed in to.'],
        actions: ['connect', 'refresh']
      };
    }
    return {
      heading: title,
      lines: [
        `Not available: ${result.reason ?? `not installed or not signed in ${hostDescription()}`}`,
        '',
        `The extension reads ${title} where it runs (${hostDescription()}). In the Agents window that is always your local computer, even for remote sessions. Sign in there with the same account (${SIGN_IN_HINTS[provider.id]}); limits are per account, so the figures match.`
      ],
      actions: ['refresh', 'log']
    };
  }
  if (result.kind === 'error') {
    const previous = provider.lastGood;
    if (!previous) {
      return { heading: result.title, lines: [`Refresh failed: ${result.message}`], actions: ['refresh', 'log'] };
    }
    return { ...plainText(describeUsage(previous, result.message)), actions: ['refresh', 'log'] };
  }
  return { ...plainText(describeUsage(result.usage)), actions: ['refresh'] };
}

/**
 * Details dialog with the same text as the status bar tooltips. With `focus` set (a chat chip was
 * clicked) only that provider is shown; without it (AI Usage: Show Details) every enabled provider
 * is listed. VS Code offers extensions no anchored popup, so this is a modal message with the
 * figures as its detail text.
 */
async function showDetailsDialog(providers: LiveProvider[], refreshAll: () => Promise<void>, focus?: ProviderId): Promise<void> {
  const shown = focus
    ? providers.filter((provider) => provider.id === focus)
    : providers.filter((provider) => vscode.workspace.getConfiguration().get<boolean>(provider.settingKey, true));
  const texts = shown.map(providerText);

  let message: string;
  let detail: string;
  if (texts.length === 1) {
    message = texts[0].heading;
    detail = texts[0].lines.join('\n');
  } else {
    message = 'AI Usage';
    const sections = texts.map((text) => [text.heading, ...text.lines].join('\n'));
    if (hasUserConfiguredAccounts()) {
      sections.push(['Configured accounts', ...summarize(getAccountUsage()).lines].join('\n'));
    }
    detail = sections.length
      ? sections.join('\n\n')
      : 'No service is enabled. Turn on aiUsage.claude.enabled, aiUsage.codex.enabled or aiUsage.copilot.enabled.';
  }

  const actions = (['connect', 'refresh', 'log'] as DetailsAction[]).filter((action) => texts.some((text) => text.actions.includes(action)));
  const choice = await vscode.window.showInformationMessage(message, { modal: true, detail: detail.trim() }, ...actions.map((action) => ACTION_LABELS[action]));
  const action = actions.find((candidate) => ACTION_LABELS[candidate] === choice);
  if (action === 'refresh') {
    await refreshAll();
    return showDetailsDialog(providers, refreshAll, focus);
  }
  if (action === 'connect') {
    await vscode.commands.executeCommand('aiUsage.connectGitHub');
    return showDetailsDialog(providers, refreshAll, focus);
  }
  if (action === 'log') {
    output?.show(true);
  }
}

function summarizeResult(result: LiveResult): string {
  if (result.kind === 'ok') {
    return `ok ${formatUsageLabel(result.usage)}`;
  }
  return result.kind === 'error' ? `error: ${result.message}` : `unavailable${result.reason ? `: ${result.reason}` : ''}`;
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

export function deactivate(): void {
  // noop
}
