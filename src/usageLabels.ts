import { formatResetRemaining } from '../service/out';
import type { LiveResult, LiveUsage, ProviderId } from '../service/out';
import { formatUsagePercent } from './usageFormatting';

/** The slice of `vscode.WorkspaceConfiguration` the display logic reads; tests pass a fake. */
export type ConfigReader = { get<T>(section: string, defaultValue: T): T };

export const WARNING_PERCENT = 80;
export const ERROR_PERCENT = 95;
/** After this long, a reading shown in place of a failed refresh is greyed out. */
export const STALE_AFTER_MS = 15 * 60_000;

/** Prefix of the chat chip commands generated into package.json (see scripts/generate-manifest.js). */
export const CHIP_COMMAND_PREFIX = 'aiUsage.chip.';
export const CHAT_TOKEN_COMMAND_PREFIX = 'aiUsage.chatTokens.chip.';
/** Window labels with generated rich-mode chip commands per provider (keep in sync with the generator). */
export const CHIP_WINDOWS: Record<ProviderId, string[]> = { claude: ['5h', '7d'], codex: ['5h', '7d'], copilot: [] };

/** What precedes the figures: nothing, the service name, the vendor icon, or both. */
export type LabelStyle = 'none' | 'nameOnly' | 'iconOnly' | 'iconAndName';
/** `simple`: the most used window; `rich`: every window. Parentheses show time until reset. */
export type UsageStyle = 'simple' | 'rich';

export function statusBarStyle(config: ConfigReader): { labels: LabelStyle; usage: UsageStyle } {
  return {
    labels: config.get<LabelStyle>('aiUsage.statusBar.labels', 'iconOnly'),
    usage: config.get<UsageStyle>('aiUsage.statusBar.usage', 'rich')
  };
}

export function chipStyle(config: ConfigReader): { named: boolean; usage: UsageStyle } {
  return {
    named: config.get<string>('aiUsage.chatChips.labels', 'name') === 'name',
    usage: config.get<UsageStyle>('aiUsage.chatChips.usage', 'rich')
  };
}

/** True when this extension's status bar items can be seen: enabled here and VS Code's status bar is visible. */
export function statusBarVisible(config: ConfigReader): boolean {
  return config.get<boolean>('aiUsage.statusBar.enabled', true) && config.get<boolean>('workbench.statusBar.visible', true) !== false;
}

/** How often every window re-reads the shared cache and redraws (`aiUsage.updateIntervalMinutes`). */
export function updateIntervalMs(config: ConfigReader): number {
  return Math.max(0.25, config.get<number>('aiUsage.updateIntervalMinutes', 1)) * 60_000;
}

export function formatInterval(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
}

/** Data source per provider, selected with `aiUsage.<provider>.source`. */
export type SourceId = 'auto' | 'api' | 'cli' | 'sessionLog' | 'accountFile' | 'both';
export const SOURCE_LABELS: Record<SourceId, string> = {
  auto: 'automatic source selection', api: 'service API', cli: 'local CLI', sessionLog: 'local session log', accountFile: 'local account file',
  both: 'local file, service API when stale'
};

export const PROVIDER_TITLES: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' };
export const SIGN_IN_HINTS: Record<ProviderId, string> = {
  claude: 'run `claude` once and log in',
  codex: 'run `codex login`',
  copilot: 'sign in to GitHub in VS Code'
};

const WINDOW_NAMES: Record<string, string> = {
  '5h': '5-hour window',
  '7d': '7-day window',
  month: 'Premium requests (month)',
  chat: 'Chat',
  completions: 'Completions'
};

export function windowName(label: string): string {
  if (WINDOW_NAMES[label]) {
    return WINDOW_NAMES[label];
  }
  const scoped = /^7d (.+)$/.exec(label);
  return scoped ? `7-day window · ${scoped[1]}` : label;
}

export function usageIcon(percent: number): string {
  if (percent >= ERROR_PERCENT) {
    return '$(error)';
  }
  if (percent >= WARNING_PERCENT) {
    return '$(warning)';
  }
  return '$(pass)';
}

/** The most used window's percentage: the figure of simple mode and of the status bar colouring. */
export function worstPercent(usage: LiveUsage): number {
  return Math.round(Math.max(...usage.windows.map((window) => window.usedPercent)));
}

export function usagePart(window: LiveUsage['windows'][number], now: Date): string {
  const reset = formatResetRemaining(window.resetsAt, now);
  return `${formatUsagePercent(window.usedPercent)}${reset ? ` (${reset})` : ''}`;
}

/**
 * Parentheses are a compact reset countdown, never the fixed window length. Rich shows up to two
 * windows, e.g. "Claude 17% (3h) 25% (3d)". Simple shows only the most-used window.
 */
export function formatUsageLabel(usage: LiveUsage, withTitle = true, style: UsageStyle = 'rich', now = new Date()): string {
  const worst = usage.windows.reduce((selected, window) =>
    window.usedPercent > selected.usedPercent ? window : selected
  );
  const parts = style === 'simple'
    ? [usagePart(worst, now)]
    : usage.windows.slice(0, 2).map((window) => usagePart(window, now));
  return withTitle ? `${usage.title} ${parts.join(' ')}` : parts.join(' ');
}

/** Status bar text: the figures behind whatever `aiUsage.statusBar.labels` puts in front of them, and the account number. */
export function statusText(labels: LabelStyle, icon: string, accountNumber: string | undefined, body: string, title?: string): string {
  const iconPart = labels === 'iconOnly' || labels === 'iconAndName' ? `$(${icon}) ` : '';
  const name = (labels === 'nameOnly' || labels === 'iconAndName') && title ? `${title} ` : '';
  return `${iconPart}${name}${accountNumber ? `${accountNumber} ` : ''}${body}`.trimEnd();
}

/** The most recent reading worth showing: the live one, or the last good one when the refresh failed. */
export function visibleUsageOf(last: LiveResult | undefined, lastGood: LiveUsage | undefined): LiveUsage | undefined {
  return last?.kind === 'ok' ? last.usage : lastGood;
}

/**
 * Context-key values of a provider's chat chips: `simple` selects the single-figure item (most used window) or a
 * state (`pending`, `unavailable`, `error`); in rich mode one key per window of CHIP_WINDOWS. All undefined hides them.
 */
export function chipContextValues(providerId: ProviderId, enabled: boolean, last: LiveResult | undefined,
  usage: LiveUsage | undefined, richStyle: boolean): Map<string, string | undefined> {
  const keys = new Map<string, string | undefined>([['simple', undefined]]);
  for (const window of CHIP_WINDOWS[providerId]) {
    keys.set(window, undefined);
  }
  if (enabled) {
    if (usage?.windows.length) {
      const rich = richStyle
        ? usage.windows.filter((window) => CHIP_WINDOWS[providerId].includes(window.label))
        : [];
      if (rich.length) {
        for (const window of rich) {
          keys.set(window.label, String(Math.round(window.usedPercent)));
        }
      } else {
        keys.set('simple', String(worstPercent(usage)));
      }
    } else if (!last) {
      keys.set('simple', 'pending');
    } else {
      keys.set('simple', last.kind === 'error' ? 'error' : 'unavailable');
    }
  }
  return keys;
}

/** Whether the chat chips show in a regular VS Code window (`aiUsage.chatChips.workbench`). */
export function chipsInWorkbench(mode: string, chipsEnabled: boolean, statusBarIsVisible: boolean): boolean {
  return chipsEnabled && (mode === 'always' || (mode === 'whenNoStatusBar' && !statusBarIsVisible));
}

/**
 * Every generated chat chip command (aiUsage.chip.<provider>.<item>..., see scripts/generate-manifest.js) opens the
 * details of that provider; the debug chip (no provider) opens all.
 */
export function chipCommands(manifestCommands: Array<{ command: string }>, providerIds: ReadonlySet<string>):
  Array<{ command: string; target: ProviderId | undefined }> {
  const result: Array<{ command: string; target: ProviderId | undefined }> = [];
  for (const { command } of manifestCommands) {
    if (!command.startsWith(CHIP_COMMAND_PREFIX)) {
      continue;
    }
    const providerId = command.slice(CHIP_COMMAND_PREFIX.length).split('.')[0];
    result.push({ command, target: providerIds.has(providerId) ? (providerId as ProviderId) : undefined });
  }
  return result;
}

/** The generated token chip commands, each opening the exact token breakdown of its Claude or Codex chat. */
export function chatTokenChipCommands(manifestCommands: Array<{ command: string }>):
  Array<{ command: string; providerId: 'claude' | 'codex' }> {
  const result: Array<{ command: string; providerId: 'claude' | 'codex' }> = [];
  for (const { command } of manifestCommands) {
    if (!command.startsWith(CHAT_TOKEN_COMMAND_PREFIX)) {
      continue;
    }
    const providerId = command.slice(CHAT_TOKEN_COMMAND_PREFIX.length).split('.')[0];
    if (providerId === 'claude' || providerId === 'codex') {
      result.push({ command, providerId });
    }
  }
  return result;
}

export type ChatTokenTotals = { totalTokens: number; inputTokens: number; cachedInputTokens?: number; outputTokens: number };

/** The message of `aiUsage.showChatTokens`; without data it says none was found for this workspace. */
export function chatTokensMessage(providerId: 'claude' | 'codex', usage: ChatTokenTotals | undefined): string {
  const title = providerId === 'claude' ? 'Claude' : 'Codex';
  if (!usage) {
    return `AI Usage: no ${title} token data was found for this workspace.`;
  }
  const cached = usage.cachedInputTokens
    ? ` (${usage.cachedInputTokens.toLocaleString()} cached)`
    : '';
  return `${title} chat: ${usage.totalTokens.toLocaleString()} tokens · ` +
    `${usage.inputTokens.toLocaleString()} input${cached} · ${usage.outputTokens.toLocaleString()} output`;
}
