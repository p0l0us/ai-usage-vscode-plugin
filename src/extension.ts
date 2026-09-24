import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ApiCallBudget } from './apiBudget';
import { registerBridgeIntegration } from './bridgeIntegration';
import { registerBridgeModels } from './bridgeModels';
import { AuthProvider, readNativeCredential } from './authFiles';
import { ActivationChange, AuthProfileManager } from './authProfiles';
import { activateClaudeAccountMetadata, claudeAccountFileConfirms } from './accountIdentity';
import { AccountAutomation, AutomationSettings, modelWindowFilter, RotationStrategy, RotationTrigger } from './accountAutomation';
import { signInIsolated } from './accountLogin';
import { explainAccountProblem, probeAccount } from './accountProbe';
import { SharedCache, deserializeUsage } from './cache';
import { codexConfigPath } from './codexConfig';
import { findStaleCodexProcesses } from './codexProcesses';
import { CodexProxyRuntime } from './codexProxyRuntime';
import { applyCodexSettingsToFile, readCodexSettingAssignments } from './codexSettings';
import { applyClaudeSettingsToFile, readClaudeSettingAssignments } from './claudeSettings';
import { openAiUsageSettings } from './settingsLink';
import {
  GitHubAccount,
  LiveResult,
  LiveUsage,
  ProviderId,
  claudeConfigDir,
  codexHomeDir,
  fetchClaudeUsage,
  fetchClaudeUsageCli,
  fetchClaudeUsageFromAccountFile,
  fetchCodexUsage,
  fetchCodexUsageCli,
  fetchCodexUsageFromSessionLog,
  fetchCopilotUsage,
  fetchLocalThenApi,
  formatResetIn,
  formatResetRemaining,
  refreshCodexNativeLogin,
  verifyCodexNativeAccount
} from './live';
import { compactTokenCount, readCurrentSessionTokens, SessionTokenUsage } from './sessionTokens';

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
  /** `known` is the newest reading this window already has, so a source that falls back between a
   *  local file and the service can tell whether anything newer is worth fetching. */
  fetch: (known?: LiveUsage) => Promise<LiveResult>;
  /** Distinguishes cache entries when the result depends on the workspace (Copilot org). */
  cacheDiscriminator?: () => Promise<string | undefined>;
  /** Name of the extension-managed authentication profile currently selected for this provider. */
  activeProfileName?: () => string | undefined;
  /** "#2" for the second saved profile, when there are several and the setting shows it. */
  accountNumber?: () => string | undefined;
  /** Shared call spacing for providers read through a rate-limited service endpoint, when the
   *  currently selected source uses one (a local source needs no spacing). */
  budget?: () => ApiCallBudget | undefined;
  last?: LiveResult;
  /** Most recent successful reading, kept so errors do not blank the item. */
  lastGood?: LiveUsage;
  /** In-flight refresh for this provider only; failures elsewhere never wait on it. */
  inFlight?: Promise<void>;
};

/** Data source per provider, selected with `aiUsage.<provider>.source`. */
type SourceId = 'api' | 'cli' | 'sessionLog' | 'accountFile' | 'both';
const SOURCE_LABELS: Record<SourceId, string> = {
  api: 'service API', cli: 'local CLI', sessionLog: 'local session log', accountFile: 'local account file',
  both: 'local file, service API when stale'
};
const DEFAULT_CHECK_MINUTES: Record<ProviderId, number> = { claude: 10, codex: 5, copilot: 5 };
/** Default and floor for `aiUsage.claude.accountFile.checkIntervalSeconds`; this source is a plain
 *  local file read, so it can be polled far more often than the rate-limited API. */
const ACCOUNT_FILE_DEFAULT_SECONDS = 15;
const ACCOUNT_FILE_MIN_SECONDS = 5;

function settingsFor(provider: ProviderId) {
  const config = vscode.workspace.getConfiguration();
  const source = config.get<string>(`aiUsage.${provider}.source`, 'api') as SourceId;
  const legacy = config.get<number>('aiUsage.refreshIntervalMinutes');
  const check = config.get<number>(`aiUsage.${provider}.checkIntervalMinutes`);
  /** How often the service endpoint may be called, and the spacing `both` gives its fallback. */
  const apiCheckIntervalMs = Math.max(1, check ?? legacy ?? DEFAULT_CHECK_MINUTES[provider]) * 60_000;
  if (provider === 'claude' && (source === 'accountFile' || source === 'both')) {
    const seconds = config.get<number>('aiUsage.claude.accountFile.checkIntervalSeconds', ACCOUNT_FILE_DEFAULT_SECONDS);
    return {
      source,
      apiCheckIntervalMs,
      checkIntervalMs: Math.max(ACCOUNT_FILE_MIN_SECONDS, Number.isFinite(seconds) ? seconds : ACCOUNT_FILE_DEFAULT_SECONDS) * 1000
    };
  }
  return {
    source,
    apiCheckIntervalMs,
    /** How often the source is called and the result stored in the shared cache. */
    checkIntervalMs: apiCheckIntervalMs
  };
}

/**
 * Whether a source spends Anthropic's usage quota on every check. `cli` does: `/usage` costs no
 * model tokens, but Claude Code answers it by calling the same endpoint `api` calls, so it claims
 * the same slot. `accountFile` reads a file, and `both` claims a slot only when it falls back.
 */
function claudeSpendsEndpointQuota(source: SourceId): boolean {
  return source === 'api' || source === 'cli';
}

/** Command or path of the Claude CLI, shared by the `cli` source and account keep-alives. */
function claudeCliPath(): string {
  return vscode.workspace.getConfiguration().get<string>('aiUsage.claude.cliPath') || 'claude';
}

/**
 * Smallest gap between two calls to Anthropic's usage endpoint, counted across every window, every
 * saved account and manual refreshes (`aiUsage.claude.api.minIntervalSeconds`).
 */
function claudeMinIntervalMs(): number {
  const seconds = vscode.workspace.getConfiguration().get<number>('aiUsage.claude.api.minIntervalSeconds', 30);
  return Math.min(600, Math.max(0, Number.isFinite(seconds) ? seconds : 30)) * 1000;
}

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
/** Shortest gap between background attempts to confirm the activated Claude login. */
const CLAUDE_METADATA_RETRY_MS = 60_000;
/** Attempts before the background identity sync gives up until the next switch. */
const CLAUDE_METADATA_RETRY_LIMIT = 10;
/** Scopes used when asking the user to grant access; Copilot itself signs in with these. */
const GITHUB_CONNECT_SCOPES = ['user:email'];

let output: vscode.OutputChannel | undefined;
function log(message: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function activate(context: vscode.ExtensionContext): void {
  registerBridgeIntegration(context);
  registerBridgeModels(context);
  output = vscode.window.createOutputChannel('AI Usage');
  context.subscriptions.push(output);
  let automation: AccountAutomation;
  /** Set while a switched Claude login still has to be confirmed against the OAuth profile endpoint. */
  let claudeMetadataRetry: { nextAttemptAt: number; attempts: number } | undefined;
  const authProfiles = new AuthProfileManager(context, log, (provider, id) => automation?.usageDetail(provider, id),
    async (provider, credential, expected) => {
      if (provider === 'codex') {
        // A fresh app-server must see the login that was just written; report a mismatch instead of success.
        return verifyCodexNativeAccount(credential, vscode.workspace.getConfiguration().get<string>('aiUsage.codex.cliPath') || 'codex');
      }
      // Claude Code renders /status and /usage identity from its separate account file. Keep that metadata and its
      // account-bound caches aligned with the exact OAuth token that activation just wrote.
      const outcome = await activateClaudeAccountMetadata(credential, expected);
      if (outcome.status === 'synced') {
        claudeMetadataRetry = undefined;
        return { status: 'match' as const, detail: outcome.detail, ...outcome.identity };
      }
      // The identity is unconfirmed, usually because the endpoint is rate-limiting this account. Keep asking in the
      // background so /status and /usage stop lagging behind the switch without the user doing anything.
      claudeMetadataRetry = { nextAttemptAt: Date.now() + Math.max(outcome.retryAfterMs ?? 0, CLAUDE_METADATA_RETRY_MS), attempts: 0 };
      return { status: 'unverified' as const, detail: outcome.detail };
    });
  void authProfiles.migrateAutomationSettings().catch((error) =>
    log(`could not move the account feature switches to settings: ${error instanceof Error ? error.message : String(error)}`));
  // Routes the Codex extension's model calls through a local proxy that reads auth.json per request, so a profile
  // switch reaches open Codex chats on their next turn (aiUsage.codex.proxy.enabled). Opt-in; see codexProxy.ts.
  const codexProxy = new CodexProxyRuntime(context, log, codexHomeDir,
    () => refreshCodexNativeLogin(vscode.workspace.getConfiguration().get<string>('aiUsage.codex.cliPath') || 'codex'),
    String((context.extension.packageJSON as { version?: string }).version ?? '0'));
  context.subscriptions.push(codexProxy);
  authProfiles.codexChatsFollowSwitch = () => codexProxy.active;
  void codexProxy.sync();
  // Writes the aiUsage.codexConfig.* values that are set into Codex's config.toml; unset ones leave the file alone.
  const syncCodexSettings = () => {
    const file = codexConfigPath(codexHomeDir());
    const configuration = vscode.workspace.getConfiguration();
    const assignments = readCodexSettingAssignments((setting) => configuration.get(setting),
      (setting, value) => log(`codex config: ignoring ${setting.setting} = ${JSON.stringify(value)}; expected an integer of at least ${setting.minimum}`));
    try {
      if (applyCodexSettingsToFile(file, assignments,
        (assignment, error) => log(`codex config: could not set ${assignment.table}.${assignment.key}: ${error.message}`))) {
        log(`codex config: updated ${file} (${assignments.map((a) => `${a.table}.${a.key} = ${a.value}`).join(', ')}); new Codex chats use it`);
      }
    } catch (error) {
      log(`codex config: could not update ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  syncCodexSettings();
  // Writes the aiUsage.claudeConfig.* values that are set into the env of Claude Code's user settings.json.
  const syncClaudeSettings = () => {
    const file = path.join(claudeConfigDir(), 'settings.json');
    const configuration = vscode.workspace.getConfiguration();
    const assignments = readClaudeSettingAssignments((setting) => configuration.get(setting),
      (setting, value) => log(`claude config: ignoring ${setting.setting} = ${JSON.stringify(value)}; expected an integer from ${setting.minimum}${setting.maximum === undefined ? '' : ` to ${setting.maximum}`}`));
    try {
      if (applyClaudeSettingsToFile(file, assignments)) {
        log(`claude config: updated ${file} (${assignments.map((a) => `env.${a.env} = ${a.value}`).join(', ')}); new Claude Code sessions use it`);
      }
    } catch (error) {
      log(`claude config: could not update ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  syncClaudeSettings();
  const status = vscode.window.createStatusBarItem(STATUS_ALIGNMENT, STATUS_PRIORITY.manual);
  status.command = 'aiUsage.showDetails';
  status.name = 'AI Usage';
  context.subscriptions.push(status);
  const claudeBudget = new ApiCallBudget(
    path.join(context.globalStorageUri.fsPath, 'claude-api-budget.json'), claudeMinIntervalMs);
  // Spacing for the service call the `both` source falls back to: the provider's own check interval,
  // so the endpoint is called no more often than with the `api` source.
  const claudeFallbackBudget = new ApiCallBudget(
    path.join(context.globalStorageUri.fsPath, 'claude-fallback-budget.json'), () => settingsFor('claude').apiCheckIntervalMs);
  const codexFallbackBudget = new ApiCallBudget(
    path.join(context.globalStorageUri.fsPath, 'codex-fallback-budget.json'), () => settingsFor('codex').apiCheckIntervalMs);

  const liveProviders: LiveProvider[] = [
    {
      id: 'claude',
      // Built-in codicons for the vendor logos (VS Code 1.130+).
      icon: 'claude',
      settingKey: 'aiUsage.claude.enabled',
      status: vscode.window.createStatusBarItem(STATUS_ALIGNMENT, STATUS_PRIORITY.claude),
      fetch: (known) => {
        const { source, apiCheckIntervalMs } = settingsFor('claude');
        if (source === 'accountFile') {
          return fetchClaudeUsageFromAccountFile();
        }
        if (source === 'cli') {
          return fetchClaudeUsageCli(claudeCliPath());
        }
        if (source === 'both') {
          return fetchLocalThenApi({
            known, apiCheckIntervalMs, fallback: claudeFallbackBudget, budget: claudeBudget,
            local: () => fetchClaudeUsageFromAccountFile(),
            api: () => fetchClaudeUsage(undefined, claudeBudget)
          });
        }
        return fetchClaudeUsage(undefined, claudeBudget);
      },
      // "api" and "cli" both reach the rate-limited endpoint on every check; "accountFile" is a
      // local read with nothing to space out, and "both" claims its slot only when it falls back.
      budget: () => (claudeSpendsEndpointQuota(settingsFor('claude').source) ? claudeBudget : undefined),
      cacheDiscriminator: async () => authProfiles.cacheDiscriminator('claude'),
      activeProfileName: () => authProfiles.activeProfileName('claude'),
      accountNumber: () => accountNumberLabel(authProfiles, 'claude')
    },
    {
      id: 'codex',
      icon: 'openai',
      settingKey: 'aiUsage.codex.enabled',
      status: vscode.window.createStatusBarItem(STATUS_ALIGNMENT, STATUS_PRIORITY.codex),
      fetch: async (known) => {
        const { source, apiCheckIntervalMs } = settingsFor('codex');
        if (source === 'cli') {
          return fetchCodexUsageCli(vscode.workspace.getConfiguration().get<string>('aiUsage.codex.cliPath') || 'codex');
        }
        if (source === 'sessionLog') {
          return fetchCodexUsageFromSessionLog();
        }
        if (source === 'both') {
          return fetchLocalThenApi({
            known, apiCheckIntervalMs, fallback: codexFallbackBudget,
            local: () => fetchCodexUsageFromSessionLog(),
            api: () => fetchCodexUsage()
          });
        }
        return fetchCodexUsage();
      },
      cacheDiscriminator: async () => authProfiles.cacheDiscriminator('codex'),
      activeProfileName: () => authProfiles.activeProfileName('codex'),
      accountNumber: () => accountNumberLabel(authProfiles, 'codex')
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
  const sessionTokens = new Map<'claude' | 'codex', SessionTokenUsage>();
  log(`cache: ${path.join(context.globalStorageUri.fsPath, 'usage-cache.json')}`);
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


  /**
   * Refreshes one provider. Order of preference: a fresh reading from the shared cache (another
   * window fetched it), then the network unless the shared backoff or another window's in-flight
   * fetch says to wait. Providers never wait on each other.
   */
  const refreshProvider = (provider: LiveProvider, force: boolean, afterRotation = false): Promise<void> => {
    if (provider.inFlight) {
      return provider.inFlight;
    }
    if (provider.id !== 'copilot' && automation?.isCheckingActive(provider.id) && !afterRotation) {
      return Promise.resolve();
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

      // A switch made outside this window (another window, the vendor CLI) is followed before the reading is keyed.
      if (provider.id !== 'copilot') {
        await authProfiles.followNative(provider.id);
      }
      const profileId = provider.id === 'copilot' ? undefined : authProfiles.activeProfileId(provider.id);
      const { source, checkIntervalMs } = settingsFor(provider.id);
      const budget = provider.budget?.();
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
      } else if (budget && !budget.reserve(now)) {
        // The service endpoint is called for every account and on every manual refresh; a reading
        // that has to wait for its slot is shown from the cache instead of spending the quota.
        cache.release(key);
        const seconds = Math.ceil((budget.nextAllowedAt(now) - now) / 1000);
        log(`${provider.id}: usage endpoint call skipped, next call allowed in ${seconds}s`);
        result = provider.last ?? (cached ? { kind: 'ok', usage: cached } : undefined);
      } else {
        // Fetch in the background: keep whatever is currently shown (previous reading or nothing
        // on first load) until the new result arrives.
        try {
          result = await provider.fetch(provider.lastGood);
        } catch (error) {
          result = { kind: 'error', provider: provider.id, title: titleFor(provider), message: String(error), transient: true };
        }
        if (result.kind === 'ok') {
          cache.recordSuccess(key, result.usage);
        } else if (result.kind === 'error' && result.transient && (source === 'accountFile' || source === 'both')) {
          // A local file read has no rate limit to respect, so skip the network backoff (its 1-30 min
          // floor) and keep to the source's own regular check interval. "both" is included because
          // that backoff would also stall its free local read, and its fallback call is already
          // spaced by the provider's check interval and the service's own budget.
          cache.recordFailure(key, result.message);
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
          // Codex session-log records carry no account of their own, so they are never attributed to
          // the active profile — including as the local half of "both".
          const logSourced = source === 'sessionLog' || (provider.id === 'codex' && source === 'both');
          if (profileId && provider.id !== 'copilot' && !logSourced &&
            authProfiles.activeProfileId(provider.id) === profileId && await authProfiles.matchesNative(provider.id, profileId)) {
            automation.observe(provider.id, profileId, result.usage);
          } else if (logSourced && provider.id === 'codex') {
            // Session logs name no account, but a limit they show still starts a sweep that reads the active account.
            automation.hintLimit(provider.id, result.usage);
          }
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
    void automation.tick();
  };

  /** Manual refresh: bypass cache freshness but still respect a shared backoff. */
  const refreshAll = async () => {
    refreshManual();
    await refreshLive(true);
  };

  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.showDetails', (providerId?: unknown) =>
    showDetailsPanel(liveProviders, refreshAll, (provider) => refreshProvider(provider, true),
      typeof providerId === 'string' ? (providerId as ProviderId) : undefined)
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
    if (codexProxy.active) {
      return;
    }
    const record = context.globalState.get<CodexSwitchRecord>(CODEX_SWITCH_KEY);
    if (!record || context.workspaceState.get<number>(CODEX_SWITCH_NOTIFIED_KEY) === record.switchedAt) {
      return;
    }
    const stale = await findStaleCodexProcesses(record.switchedAt);
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
  /**
   * Retries the Claude identity sync for a switch whose profile lookup failed. The native credential is re-read every
   * attempt, so a token the CLI refreshed in the meantime is used, and a later switch simply retargets the retry.
   */
  const retryClaudeAccountMetadata = async (): Promise<void> => {
    const pending = claudeMetadataRetry;
    if (!pending || Date.now() < pending.nextAttemptAt) {
      return;
    }
    const expected = authProfiles.activeIdentity('claude');
    // Claude Code refreshes its own profile after a switch; once it has, there is nothing left to correct.
    if (claudeAccountFileConfirms(expected)) {
      claudeMetadataRetry = undefined;
      log(`claude: account metadata already names the activated login (${expected.email ?? expected.accountId})`);
      return;
    }
    let credential;
    try {
      credential = readNativeCredential('claude');
    } catch (error) {
      claudeMetadataRetry = undefined;
      log(`claude: stopped confirming the activated login, no readable native credential: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const outcome = await activateClaudeAccountMetadata(credential, expected);
    if (outcome.status === 'synced') {
      claudeMetadataRetry = undefined;
      log(`claude: account metadata confirmed on retry — ${outcome.detail}`);
      return;
    }
    pending.attempts += 1;
    if (pending.attempts >= CLAUDE_METADATA_RETRY_LIMIT) {
      claudeMetadataRetry = undefined;
      log(`claude: gave up confirming the activated login after ${pending.attempts} attempts — ${outcome.detail}`);
      return;
    }
    // Back off linearly, and never sooner than the endpoint asked for.
    pending.nextAttemptAt = Date.now() + Math.max(outcome.retryAfterMs ?? 0, CLAUDE_METADATA_RETRY_MS * Math.min(pending.attempts, 5));
    log(`claude: could not confirm the activated login (attempt ${pending.attempts}) — ${outcome.detail}`);
  };
  const afterProfileActivated = async (provider: AuthProvider, change: ActivationChange = { kind: 'activated', accountChanged: true }) => {
    const live = liveProviders.find((candidate) => candidate.id === provider)!;
    await live.inFlight;
    live.last = undefined;
    live.lastGood = undefined;
    renderLive(live);
    await updateChipContext(live, vscode.workspace.getConfiguration().get<boolean>('aiUsage.chatChips.enabled', true));
    // Claude Code re-reads its credential file, so a switch reaches open chats by itself. Codex's app-server does
    // not, and only a real account change may reset the baseline its stale-process check measures against: saving
    // or re-selecting the active login starts nothing on a new account and would flag processes that are fine.
    if (provider === 'codex' && change.accountChanged) {
      const record: CodexSwitchRecord = { switchedAt: Date.now(), profileName: authProfiles.activeProfileName('codex') ?? 'the selected profile' };
      await context.globalState.update(CODEX_SWITCH_KEY, record);
      void warnAboutStaleCodexProcesses();
    }
    await refreshProvider(live, true, true);
  };
  automation = new AccountAutomation(path.join(context.globalStorageUri.fsPath, 'account-usage'), authProfiles,
    (provider) => automationSettings(provider, authProfiles), afterProfileActivated, log, async (provider, credential, settings, keepAlive, signal) => {
      await liveProviders.find((candidate) => candidate.id === provider)?.inFlight;
      return probeAccount(provider, credential, settings, keepAlive, signal, provider === 'claude' ? claudeBudget : undefined);
    });
  context.subscriptions.push(automation);
  /** A broken saved login is reported by name and email; a revoked one can be signed in again in the keep-alive home. */
  const reportAccountProblem = async (provider: AuthProvider, id: string, reason: string, revoked: boolean) => {
    const profile = authProfiles.profile(provider, id);
    if (!profile) { return; }
    const title = provider === 'claude' ? 'Claude' : 'Codex';
    const who = `“${profile.name}”${profile.email ? ` (${profile.email})` : ''}`;
    if (!revoked) {
      void vscode.window.showWarningMessage(
        `AI Usage: automatic rotation will not switch to the ${title} account ${who}: its keep-alive failed. ${readableProblem(reason)}`);
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `AI Usage: the saved ${title} login for ${who} was revoked and no longer works, so it cannot be used or rotated to. Sign in again to keep using it.`,
      'Sign in again', 'Skip');
    if (choice !== 'Sign in again') { return; }
    try {
      const credential = await signInIsolated(provider, automationSettings(provider, authProfiles), `${title} ${who}`);
      if (!credential) {
        void vscode.window.showWarningMessage(`AI Usage: sign-in for the ${title} account ${who} was not completed; the profile is unchanged.`);
        return;
      }
      const identity = await authProfiles.identity(provider, credential);
      const current = authProfiles.profile(provider, id);
      if (!current) { return; }
      const otherAccount = (current.accountId && identity.accountId && current.accountId !== identity.accountId) ||
        (current.email && identity.email && current.email.toLowerCase() !== identity.email.toLowerCase());
      if (otherAccount) {
        const replace = await vscode.window.showWarningMessage(
          `You signed in as ${identity.email ?? identity.accountId}, but the profile “${current.name}” holds ${current.email ?? current.accountId}. Replace its login anyway?`,
          { modal: true }, 'Replace');
        if (replace !== 'Replace') { return; }
      }
      const active = await automation.withPaused(() => authProfiles.replaceCredential(provider, id, credential));
      if (active) { await afterProfileActivated(provider, { kind: 'saved', accountChanged: false }); }
      // The login is saved either way; a busy check elsewhere only delays the usage reading.
      const result = await automation.credentialReplaced(provider, id).catch((error: unknown) =>
        ({ usage: undefined, usageError: error instanceof Error ? error.message : String(error) }));
      const signedInAs = identity.email ? ` as ${identity.email}` : '';
      void vscode.window.showInformationMessage(`AI Usage: ${title} profile “${current.name}” signed in again${signedInAs}.${result.usage
        ? ' Usage statistics updated.' : result.usageError ? ` Usage could not be read yet: ${readableProblem(result.usageError)}` : ''}`);
      void automation.tick();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`${provider}: signing in again for "${profile.name}" failed: ${message}`);
      void vscode.window.showErrorMessage(`AI Usage: could not sign in again for the ${title} account ${who}: ${message}`);
    }
  };
  automation.onAccountProblem = (provider, id, reason, revoked) => { void reportAccountProblem(provider, id, reason, revoked); };
  automation.onNoCandidate = (provider, detail) => {
    const title = provider === 'claude' ? 'Claude' : 'Codex';
    void vscode.window.showWarningMessage(`AI Usage: not rotating ${title}: ${detail}.`, 'Accounts', 'Settings').then((choice) => {
      if (choice === 'Accounts') { void vscode.commands.executeCommand('aiUsage.manageAuthProfiles', provider); }
      if (choice === 'Settings') { void openAiUsageSettings(`aiUsage.${provider}.autoRotate`); }
    });
  };
  const accountTimer = setInterval(() => {
    void automation.tick();
    void warnAboutStaleCodexProcesses();
    void retryClaudeAccountMetadata();
    // Retries a blocked port and takes the proxy over when the window that served it has closed.
    void codexProxy.sync();
  }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(accountTimer) });
  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.manageAuthProfiles', async (value?: unknown) => {
    const initial = value === 'claude' || value === 'codex' ? value as AuthProvider : undefined;
    await automation.withPaused(() => authProfiles.show(initial, {
      beforeActivate: async (provider) => {
        await liveProviders.find((candidate) => candidate.id === provider)?.inFlight;
      },
      afterActivate: afterProfileActivated,
      back: async () => { await vscode.commands.executeCommand('aiUsage.showDetails'); },
      sendKeepAlive: async (provider, profile) => {
        const title = provider === 'claude' ? 'Claude' : 'Codex';
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `AI Usage: sending ${title} keep-alive for “${profile.name}”…`,
          cancellable: false
        }, async () => {
          const result = await automation.sendKeepAliveNow(provider, profile.id);
          if (result.keepAliveError) {
            const suffix = result.usage ? ' Usage statistics were still updated.' : '';
            void vscode.window.showWarningMessage(`AI Usage: ${title} keep-alive failed for “${profile.name}”: ${readableProblem(result.keepAliveError)}${suffix}`);
          } else if (result.usage) {
            void vscode.window.showInformationMessage(`AI Usage: ${title} keep-alive completed for “${profile.name}”. Usage statistics updated.`);
          } else {
            void vscode.window.showWarningMessage(`AI Usage: ${title} keep-alive completed for “${profile.name}”, but usage statistics could not be updated${result.usageError ? `: ${readableProblem(result.usageError)}` : '.'}`);
          }
        });
      }
    }));
    void automation.tick();
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
    const workspaces = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => folder.uri.fsPath);
    await Promise.all((['claude', 'codex'] as const).map(async (provider) => {
      const usage = enabled ? readCurrentSessionTokens(provider, workspaces) : undefined;
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
    if (event.affectsConfiguration('aiUsage.codex.proxy')) {
      void codexProxy.sync();
    }
    if (event.affectsConfiguration('aiUsage.codexConfig')) {
      syncCodexSettings();
    }
    if (event.affectsConfiguration('aiUsage.claudeConfig')) {
      syncClaudeSettings();
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

function renderLive(provider: LiveProvider): void {
  const result = provider.last;
  const item = provider.status;
  item.color = undefined;
  item.command = clickCommand(provider);
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
  return Math.round(Math.max(...usage.windows.map((window) => window.usedPercent)));
}

function usagePart(window: LiveUsage['windows'][number], now: Date): string {
  const reset = formatResetRemaining(window.resetsAt, now);
  return `${window.usedPercent}%${reset ? ` (${reset})` : ''}`;
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
function accountNumberLabel(authProfiles: AuthProfileManager, provider: AuthProvider): string | undefined {
  if (!vscode.workspace.getConfiguration().get<boolean>(`aiUsage.${provider}.statusBar.accountNumber`, true) ||
    authProfiles.profileCount(provider) < 2) {
    return undefined;
  }
  const number = authProfiles.activeProfileNumber(provider);
  return number === undefined ? undefined : `#${number}`;
}

/** Status bar text: the figures behind whatever `aiUsage.statusBar.labels` puts in front of them, and the account number. */
function statusText(provider: LiveProvider, body: string, title?: string): string {
  const { labels } = statusBarStyle();
  const icon = labels === 'iconOnly' || labels === 'iconAndName' ? `$(${provider.icon}) ` : '';
  const name = (labels === 'nameOnly' || labels === 'iconAndName') && title ? `${title} ` : '';
  const account = provider.accountNumber?.();
  return `${icon}${name}${account ? `${account} ` : ''}${body}`.trimEnd();
}

function buildTooltip(usage: LiveUsage, refreshError?: string, activeProfile?: string): vscode.MarkdownString {
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
    md.appendMarkdown(`- **${windowName(window.label)}**: ${window.usedPercent}% used${reset ? ` · ${reset}${at}` : ''}\n`);
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
  action?: 'refresh' | 'refreshProvider' | 'log' | 'settings' | 'connect' | 'all' | 'profiles';
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
  const items: DetailItem[] = [];
  const title = result?.kind === 'ok' ? result.usage.title : result?.kind === 'error' ? result.title : provider.id;
  const plan = result?.kind === 'ok' && result.usage.plan ? ` · ${result.usage.plan}` : '';
  const who = result?.kind === 'ok' && result.usage.subtitle ? ` · ${result.usage.subtitle}` : '';
  items.push({ label: `${title}${who}${plan}`, kind: vscode.QuickPickItemKind.Separator });
  if (provider.id === 'claude' || provider.id === 'codex') {
    const name = provider.activeProfileName?.();
    items.push({
      label: '$(key) Accounts',
      description: name ?? 'None saved',
      detail: 'Save, name, and switch logins, or configure automatic account rotation.',
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

  // One row per service: every window with its countdown, the age of the reading, and a refresh on
  // click. Window names and exact reset times stay one hover away in the status bar tooltip.
  const now = new Date();
  const { source, checkIntervalMs } = settingsFor(provider.id);
  const budget = provider.budget?.();
  const throttledMs = budget ? budget.nextAllowedAt(now.getTime()) - now.getTime() : 0;
  items.push({
    label: `${usageIcon(worstPercent(usage!))} ${usage!.windows.map((window) => `${window.label} ${usagePart(window, now)}`).join(' · ')}`,
    description: `Updated ${usage!.fetchedAt.toLocaleTimeString()}`,
    detail: `Refresh now · ${SOURCE_LABELS[source] ?? source} · checked every ${formatInterval(checkIntervalMs)} · ` +
      (throttledMs > 0
        ? `next call to the service allowed in ${Math.ceil(throttledMs / 1000)}s`
        : `display refreshed every ${Math.round(updateIntervalMs() / 60_000)} min`),
    action: 'refreshProvider',
    providerId: provider.id
  });
  for (const line of usage!.details ?? []) {
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
  refreshOne: (provider: LiveProvider) => Promise<void>, focus?: ProviderId): Promise<void> {
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
    } else {
      await openAiUsageSettings(picked.providerId && `aiUsage.${picked.providerId}`);
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

/** A keep-alive or usage-check error for a notification: "Insufficient credits. <what to do>", else the vendor's text. */
function readableProblem(raw: string): string {
  const problem = explainAccountProblem(raw);
  const text = problem.advice ? `${problem.label}. ${problem.advice}` : problem.label;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Machine-scoped account automation settings; intervals are bounded even for hand-edited JSON. */
function automationSettings(provider: AuthProvider, authProfiles: AuthProfileManager): AutomationSettings {
  const config = vscode.workspace.getConfiguration();
  const prefix = `aiUsage.${provider}`;
  const defaultHours = provider === 'claude' ? 2 : 6;
  const periodKey = `${prefix}.keepAlive.periodHours`;
  const period = config.inspect<number>(periodKey);
  const configuredPeriod = period?.workspaceFolderValue ?? period?.workspaceValue ?? period?.globalValue;
  // Versions before 0.0.12 called this intervalHours. Honor a hand-configured legacy value until
  // the user saves the newly named setting; it is intentionally no longer shown in Settings UI.
  const legacyPeriod = config.get<number>(`${prefix}.keepAlive.intervalHours`);
  const hours = configuredPeriod ?? legacyPeriod ?? config.get<number>(periodKey, defaultHours);
  const threshold = (key: string, fallback: number) => {
    const value = config.get<number | null>(`${prefix}.autoRotate.${key}`, fallback);
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(1, value)) : fallback;
  };
  const strategies: RotationStrategy[] = ['sequential', 'soonestReset', 'evenPace', 'leastWaste'];
  const strategy = config.get<RotationStrategy>(`${prefix}.autoRotate.strategy`, provider === 'claude' ? 'soonestReset' : 'sequential');
  const minStay = config.get<number>(`${prefix}.autoRotate.minStayMinutes`, 30);
  return {
    enabled: authProfiles.automationEnabled(provider, 'keepAlive'),
    autoRotate: authProfiles.automationEnabled(provider, 'autoRotate'),
    // Codex has no 5-hour setting: when it reports that window, only a used-up one (100%) rotates.
    fiveHourThresholdPercent: provider === 'claude' ? threshold('fiveHourThresholdPercent', 95) : 100,
    weeklyThresholdPercent: threshold('weeklyThresholdPercent', provider === 'claude' ? 99.5 : 99),
    countsWindow: modelWindowFilter(config.get<string>(`${prefix}.autoRotate.modelLimits`, 'auto'),
      provider === 'claude' ? claudeCodeModel() : undefined),
    strategy: strategies.includes(strategy) ? strategy : 'sequential',
    trigger: config.get<RotationTrigger>(`${prefix}.autoRotate.trigger`, 'limit') === 'proactive' ? 'proactive' : 'limit',
    minStayMs: (Number.isFinite(minStay) ? Math.max(5, minStay) : 30) * 60_000,
    intervalMs: (Number.isFinite(hours) ? Math.max(0.25, hours) : defaultHours) * 3_600_000,
    // Account probes always call the service endpoint, whatever source the status bar reads, so they
    // are spaced by the endpoint's own interval and never by a local file's.
    checkIntervalMs: settingsFor(provider).apiCheckIntervalMs,
    home: config.get<string>(`${prefix}.keepAlive.home`, `~/.${provider}-tmp`),
    cliPath: config.get<string>(`${prefix}.cliPath`, provider),
    model: config.get<string>(`${prefix}.keepAlive.model`, provider === 'claude' ? 'haiku' : 'gpt-5.6-luna')
  };
}

/** The model Claude Code is configured to use (its user settings `model`), or undefined when unset or unreadable. */
function claudeCodeModel(): string | undefined {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(), 'settings.json'), 'utf8'));
    return typeof settings?.model === 'string' && settings.model.trim() ? settings.model.trim() : undefined;
  } catch { return undefined; }
}
