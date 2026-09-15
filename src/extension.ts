import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AuthProvider } from './authFiles';
import { AuthProfileManager } from './authProfiles';
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
/** Window labels with generated rich-mode chip commands per provider (keep in sync with the generator). */
const CHIP_WINDOWS: Record<ProviderId, string[]> = { claude: ['5h', '7d'], codex: ['5h', '7d'], copilot: [] };

/** What precedes the figures: nothing, the service name, the vendor icon, or both. */
type LabelStyle = 'none' | 'nameOnly' | 'iconOnly' | 'iconAndName';
/** `simple`: one figure, the most used window ("37%"); `rich`: every window ("4% (5h) 26% (7d)"). */
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
  fetch: () => Promise<LiveResult>;
  /** Distinguishes cache entries when the result depends on the workspace (Copilot org). */
  cacheDiscriminator?: () => Promise<string | undefined>;
  /** Name of the extension-managed authentication profile currently selected for this provider. */
  activeProfileName?: () => string | undefined;
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
  const authProfiles = new AuthProfileManager(context, log);
  const status = vscode.window.createStatusBarItem(STATUS_ALIGNMENT, STATUS_PRIORITY.manual);
  status.command = 'aiUsage.showDetails';
  status.name = 'AI Usage';
  context.subscriptions.push(status);

  const liveProviders: LiveProvider[] = [
    {
      id: 'claude',
      // Built-in codicons for the vendor logos (VS Code 1.130+).
      icon: 'claude',
      settingKey: 'aiUsage.claude.enabled',
      status: vscode.window.createStatusBarItem(STATUS_ALIGNMENT, STATUS_PRIORITY.claude),
      fetch: fetchClaudeUsage,
      cacheDiscriminator: async () => authProfiles.cacheDiscriminator('claude'),
      activeProfileName: () => authProfiles.activeProfileName('claude')
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
      },
      cacheDiscriminator: async () => authProfiles.cacheDiscriminator('codex'),
      activeProfileName: () => authProfiles.activeProfileName('codex')
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
    provider.status.command = 'aiUsage.showDetails';
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
    showDetailsPanel(liveProviders, refreshAll, typeof providerId === 'string' ? (providerId as ProviderId) : undefined)
  ));

  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.refresh', refreshAll));
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.manageAuthProfiles', async (value?: unknown) => {
    const initial = value === 'claude' || value === 'codex' ? value as AuthProvider : undefined;
    await authProfiles.show(initial, {
      beforeActivate: async (provider) => {
        await liveProviders.find((candidate) => candidate.id === provider)?.inFlight;
      },
      afterActivate: async (provider) => {
        const live = liveProviders.find((candidate) => candidate.id === provider);
        if (!live) {
          return;
        }
        live.last = undefined;
        live.lastGood = undefined;
        renderLive(live);
        await updateChipContext(live, vscode.workspace.getConfiguration().get<boolean>('aiUsage.chatChips.enabled', true));
        await refreshProvider(live, true);
      }
    });
  }));
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
    const usage = result?.kind === 'ok' ? result.usage : result?.kind === 'error' ? provider.lastGood : undefined;
    if (usage?.windows.length) {
      const rich = chipStyle().usage === 'rich'
        ? usage.windows.filter((window) => CHIP_WINDOWS[provider.id].includes(window.label))
        : [];
      if (rich.length) {
        for (const window of rich) {
          keys.set(window.label, String(window.usedPercent));
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

function renderLive(provider: LiveProvider): void {
  const result = provider.last;
  const item = provider.status;
  item.color = undefined;
  item.command = 'aiUsage.showDetails';
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
      item.command = needsAccess ? 'aiUsage.connectGitHub' : 'aiUsage.showDetails';
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
    item.text = statusText(provider, formatUsageLabel(previous, false, statusBarStyle().usage), previous.title);
    item.tooltip = buildTooltip(previous, result.message, provider.activeProfileName?.());
    item.backgroundColor = undefined;
    item.color = ageMs >= STALE_AFTER_MS ? new vscode.ThemeColor('disabledForeground') : undefined;
    item.show();
    return;
  }

  const usage = result.usage;
  item.text = statusText(provider, formatUsageLabel(usage, false, statusBarStyle().usage), usage.title);
  item.tooltip = buildTooltip(usage, undefined, provider.activeProfileName?.());

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
  return Math.max(...usage.windows.map((window) => window.usedPercent));
}

/**
 * Rich: "Claude 17% (5h) 25% (7d)", "Codex 37% (7d)", "Copilot 75%" (Copilot has a single monthly
 * window). Simple: only the most used window, "Claude 25%".
 */
function formatUsageLabel(usage: LiveUsage, withTitle = true, style: UsageStyle = 'rich'): string {
  const parts = style === 'simple'
    ? [`${worstPercent(usage)}%`]
    : usage.windows.slice(0, 2).map((window) =>
        usage.provider === 'copilot' ? `${window.usedPercent}%` : `${window.usedPercent}% (${window.label})`
      );
  return withTitle ? `${usage.title} ${parts.join(' ')}` : parts.join(' ');
}

/** Status bar text: the figures behind whatever `aiUsage.statusBar.labels` puts in front of them. */
function statusText(provider: LiveProvider, body: string, title?: string): string {
  const { labels } = statusBarStyle();
  const icon = labels === 'iconOnly' || labels === 'iconAndName' ? `$(${provider.icon}) ` : '';
  const name = (labels === 'nameOnly' || labels === 'iconAndName') && title ? `${title} ` : '';
  return `${icon}${name}${body}`.trimEnd();
}

function buildTooltip(usage: LiveUsage, refreshError?: string, activeProfile?: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  if (refreshError) {
    const minutes = Math.round((Date.now() - usage.fetchedAt.getTime()) / 60_000);
    md.appendMarkdown(`$(warning) **Refresh failed** (${refreshError}). Showing the reading from ${minutes} min ago.\n\n`);
  }
  const heading = usage.subtitle ? `${usage.title} · ${usage.subtitle}` : usage.title;
  md.appendMarkdown(`**${heading}**${usage.plan ? ` · ${usage.plan}` : ''}\n\n`);
  for (const window of usage.windows) {
    const reset = formatResetIn(window.resetsAt);
    md.appendMarkdown(`- **${window.label}**: ${window.usedPercent}% used${reset ? ` · ${reset}` : ''}\n`);
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
  return md;
}

type DetailItem = vscode.QuickPickItem & {
  action?: 'refresh' | 'log' | 'settings' | 'connect' | 'all' | 'profiles';
  providerId?: AuthProvider;
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
  const items: DetailItem[] = [];
  const title = result?.kind === 'ok' ? result.usage.title : result?.kind === 'error' ? result.title : provider.id;
  const plan = result?.kind === 'ok' && result.usage.plan ? ` · ${result.usage.plan}` : '';
  const who = result?.kind === 'ok' && result.usage.subtitle ? ` · ${result.usage.subtitle}` : '';
  items.push({ label: `${title}${who}${plan}`, kind: vscode.QuickPickItemKind.Separator });
  if (provider.id === 'claude' || provider.id === 'codex') {
    const name = provider.activeProfileName?.();
    items.push({
      label: '$(key) Authentication profile',
      description: name ?? 'None saved',
      detail: 'Save, name, and switch logins without leaving VS Code.',
      action: 'profiles',
      providerId: provider.id
    });
  }

  if (!result) {
    items.push({ label: '$(clock) Waiting for first reading…' });
    return items;
  }
  if (result.kind === 'unavailable') {
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
  const usage = result.kind === 'ok' ? result.usage : provider.lastGood;
  if (result.kind === 'error') {
    items.push({
      label: '$(warning) Last refresh failed',
      detail: usage ? `${result.message} — showing the reading from ${usage.fetchedAt.toLocaleTimeString()}.` : result.message
    });
    if (!usage) {
      return items;
    }
  }

  for (const window of usage!.windows) {
    const reset = formatResetIn(window.resetsAt);
    items.push({
      label: `${usageIcon(window.usedPercent)} ${windowName(window.label)}`,
      description: `${window.usedPercent}% used · ${100 - window.usedPercent}% left`,
      detail: reset ? `${reset[0].toUpperCase()}${reset.slice(1)}${window.resetsAt ? ` (${window.resetsAt.toLocaleString()})` : ''}` : undefined
    });
  }
  for (const line of usage!.details ?? []) {
    const [key, ...rest] = line.split(': ');
    items.push(rest.length ? { label: `$(info) ${key}`, description: rest.join(': ') } : { label: `$(info) ${line}` });
  }
  const { source, checkIntervalMs } = settingsFor(provider.id);
  items.push({
    label: '$(history) Updated',
    description: usage!.fetchedAt.toLocaleTimeString(),
    detail: `Source: ${SOURCE_LABELS[source] ?? source} · checked every ${Math.round(checkIntervalMs / 60_000)} min · display refreshed every ${Math.round(updateIntervalMs() / 60_000)} min`
  });
  return items;
}

/**
 * Details panel. With `focus` set (a chat chip was clicked) only that provider is shown, with
 * an action to expand to all providers; without it every provider is listed.
 */
async function showDetailsPanel(providers: LiveProvider[], refreshAll: () => Promise<void>, focus?: ProviderId): Promise<void> {
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
    items.push({ label: '$(gear) Settings', description: 'aiUsage.*', action: 'settings' });
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
    if (picked.action === 'refresh') {
      picker.busy = true;
      await refreshAll();
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
    } else {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:p0l0us.ai-usage-vscode-plugin');
    }
  });
  picker.onDidHide(() => picker.dispose());
  picker.show();
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
