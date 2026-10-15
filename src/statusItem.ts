import type * as vscode from 'vscode';
import { formatEarnedResets, formatResetIn, projectResetCredits } from '../service/out';
import type { LiveResult, LiveUsage, ProviderId, RotationDiagnostics } from '../service/out';
import { rotationTooltipLines } from './usageClient';
import { formatEarnedResetCount, formatUsagePercent } from './usageFormatting';
import {
  ERROR_PERCENT, LabelStyle, PROVIDER_TITLES, STALE_AFTER_MS, UsageStyle, WARNING_PERCENT,
  formatUsageLabel, statusText, visibleUsageOf, windowName, worstPercent
} from './usageLabels';

/** One live status bar item: the provider's last readings and the callbacks that read the account service's views. */
export type LiveProvider = {
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
  /** True while a refresh runs: the item keeps its figures and shows a spinner after them. */
  refreshing?: boolean;
  /** The figures shown before an account switch cleared the readings, kept until the new account's first reading. */
  previous?: LiveUsage;
  /** Which rotated frame of the logo a loading item shows; advanced by a timer in `renderLive`. */
  spinFrame?: number;
};

export function visibleUsage(provider: LiveProvider): LiveUsage | undefined {
  return visibleUsageOf(provider.last, provider.lastGood);
}

/** Claude and Codex items open that service's accounts; Copilot, which has none, opens the usage details. */
export function clickCommand(providerId: ProviderId): vscode.Command {
  return providerId === 'copilot'
    ? { command: 'aiUsage.showDetails', title: 'Show usage details' }
    : { command: `aiUsage.manageAuthProfiles.${providerId}`, title: 'Manage accounts' };
}

/** Tooltip content before it becomes a `vscode.MarkdownString`. */
export type TooltipModel =
  | { kind: 'text'; text: string }
  | { kind: 'rotation'; diagnostics: RotationDiagnostics }
  | { kind: 'usage'; usage: LiveUsage; refreshError?: string; activeProfile?: string; diagnostics?: RotationDiagnostics };

/** What `renderLive` puts on the item. `undefined` fields leave the item's property as it was. */
export type StatusItemModel =
  | { visible: false }
  | {
    visible: true;
    text: string;
    tooltip: TooltipModel;
    command?: string;
    /** `null` clears the background; absent keeps it. */
    background?: 'warning' | 'error' | null;
    greyed?: boolean;
  };

/** Everything the item's state depends on besides the provider's readings. */
export type StatusInputs = {
  barVisible: boolean;
  labels: LabelStyle;
  usageStyle: UsageStyle;
  earnedResetsEnabled: boolean;
  now: Date;
  /** Why the account service cannot be reached; `undefined` while connected. */
  serviceProblem?: string;
};

/** Shown after the figures while loading when no logo is shown (name-only labels). */
const SPINNER = '$(sync~spin)';

/**
 * VS Code animates `~spin` only on a few built-in icons, so a loading logo is drawn as one of SPIN_FRAMES rotated copies
 * from media/spin-icons.ttf (scripts/generate-spin-icons.js, whose FRAMES must match) that the caller cycles.
 */
export const SPIN_FRAMES = 24;
const SPIN_ICONS: Record<string, string> = { claude: 'ai-usage-spin-claude', openai: 'ai-usage-spin-openai', copilot: 'ai-usage-spin-copilot' };

/** Whether the item text shows a rotating-logo frame, which a timer must keep advancing. */
export function showsSpinFrame(model: StatusItemModel): boolean {
  return model.visible && model.text.includes('$(ai-usage-spin-');
}

type ModelProvider = Pick<LiveProvider, 'id' | 'icon' | 'last' | 'lastGood' | 'diagnostics' | 'accountNumber' | 'activeProfileName' | 'refreshing' | 'previous' | 'spinFrame'>;

/**
 * Decides what a provider's status bar item shows: the pure part of `renderLive`. A refresh never blanks it: the
 * figures stay and the logo rotates, and after an account switch the previous figures stay until the new
 * account's first reading arrives.
 */
export function statusItemModel(provider: ModelProvider, inputs: StatusInputs): StatusItemModel {
  const waiting = !provider.last && !visibleUsageOf(provider.last, provider.lastGood);
  if (provider.previous && waiting && !inputs.serviceProblem && inputs.barVisible) {
    const title = PROVIDER_TITLES[provider.id];
    const carried = baseModel({ ...provider, last: { kind: 'ok', usage: provider.previous }, lastGood: provider.previous }, inputs, true);
    return carried.visible ? { ...carried, tooltip: { kind: 'text', text: `${title}\nReading the usage of the active account…` } } : carried;
  }
  return baseModel(provider, inputs, Boolean(provider.refreshing));
}

/**
 * `loading` is true while a refresh runs: the logo then rotates beside the figures. Idle items, and every error or
 * disconnect state, keep a still logo, so the rotation means data is being read.
 */
function baseModel(provider: ModelProvider, inputs: StatusInputs, loading = false): StatusItemModel {
  const result = provider.last;
  const usage = visibleUsageOf(provider.last, provider.lastGood);
  const showsLogo = inputs.labels === 'iconOnly' || inputs.labels === 'iconAndName';
  const spinIcon = showsLogo ? SPIN_ICONS[provider.icon] : undefined;
  const text = (body: string, title?: string, spinning = false) => {
    const icon = spinning && spinIcon ? `${spinIcon}-${(provider.spinFrame ?? 0) % SPIN_FRAMES}` : provider.icon;
    const base = statusText(inputs.labels, icon, provider.accountNumber?.(), body, title);
    return spinning && !spinIcon ? `${base} ${SPINNER}`.trimStart() : base;
  };
  if (!inputs.barVisible) {
    return { visible: false };
  }
  const title = PROVIDER_TITLES[provider.id];
  // An enabled provider keeps its item: without the service it shows the last reading greyed, or why there is none.
  if (inputs.serviceProblem && !usage) {
    return {
      visible: true,
      text: text('$(debug-disconnect)', title),
      tooltip: { kind: 'text', text: `${title}: the account service is not reachable.\n${inputs.serviceProblem}` },
      command: 'aiUsage.accountService',
      background: 'warning'
    };
  }

  if ((!result || result.kind === 'unavailable') && !usage) {
    if (result?.reason && provider.id === 'copilot') {
      const needsAccess = result.reason.includes('No GitHub sign-in');
      return {
        visible: true,
        text: text(needsAccess ? 'connect' : 'n/a', 'Copilot'),
        tooltip: {
          kind: 'text',
          text: needsAccess
            ? 'Copilot\nClick to allow AI Usage to read your GitHub Copilot quota with the account VS Code is signed in to.'
            : `Copilot\n${result.reason}\nSee Output → AI Usage for details.`
        },
        command: needsAccess ? 'aiUsage.connectGitHub' : 'aiUsage.showDetails',
        background: null
      };
    }
    if (provider.diagnostics) {
      return { visible: true, text: text('$(clock)', title), tooltip: { kind: 'rotation', diagnostics: provider.diagnostics } };
    }
    if (!result) {
      return { visible: true, text: text('', title, loading), tooltip: { kind: 'text', text: `${title}\nWaiting for the first usage reading from the account service.` }, background: null };
    }
    return {
      visible: true,
      text: text('$(circle-slash)', title),
      tooltip: { kind: 'text', text: `${title}\n${result.reason ?? 'No usage reading is available, for example because no login was found on this machine.'}\nSee Output → AI Usage for details.` },
      command: 'aiUsage.showDetails',
      background: null
    };
  }

  if (result?.kind === 'error' && !usage) {
    return {
      visible: true,
      text: text('$(warning)', result.title),
      tooltip: { kind: 'text', text: `${result.title}\n${result.message}${provider.diagnostics ? '\n\n' + rotationTooltipLines(provider.diagnostics).join('\n') : ''}` },
      background: 'warning'
    };
  }
  if (!usage) {
    const title = result?.kind === 'ok' ? result.usage.title : result?.kind === 'error' ? result.title : PROVIDER_TITLES[provider.id];
    return {
      visible: true,
      text: text('$(clock)', title),
      tooltip: { kind: 'text', text: `${title}\nWaiting for a reading from the new quota window.` },
      background: null
    };
  }
  const credits = provider.id === 'codex' ? projectResetCredits(usage, inputs.now.getTime()) : undefined;
  const resetCount = formatEarnedResetCount(credits?.state === 'known' ? credits.availableCount : undefined,
    provider.id === 'codex' && inputs.earnedResetsEnabled);
  const usageLabel = formatUsageLabel(usage, false, inputs.usageStyle, inputs.now);
  const worst = worstPercent(usage);
  return {
    visible: true,
    text: text(`${usageLabel}${resetCount ? ` ${resetCount}` : ''}`, usage.title, loading),
    tooltip: { kind: 'usage', usage, refreshError: inputs.serviceProblem ?? (result?.kind === 'error' ? result.message : undefined),
      activeProfile: provider.activeProfileName?.(), diagnostics: provider.diagnostics },
    greyed: Boolean(inputs.serviceProblem) || inputs.now.getTime() - usage.fetchedAt.getTime() >= STALE_AFTER_MS,
    background: worst >= ERROR_PERCENT ? 'error' : worst >= WARNING_PERCENT ? 'warning' : null
  };
}

/** The VS Code classes a status item needs; tests pass fakes. */
export type StatusItemApi = {
  ThemeColor: new (id: string) => vscode.ThemeColor;
  MarkdownString: new (value?: string, supportThemeIcons?: boolean) => vscode.MarkdownString;
};

/** Applies a model to the item in the order `renderLive` always did: colour, command, then text, tooltip, background, show. */
export function applyStatusItem(item: vscode.StatusBarItem, model: StatusItemModel, command: vscode.Command,
  api: StatusItemApi, now: Date): void {
  item.color = undefined;
  item.command = command;
  if (!model.visible) {
    item.hide();
    return;
  }
  item.text = model.text;
  const tooltip = model.tooltip;
  if (tooltip.kind === 'text') {
    item.tooltip = tooltip.text;
  } else if (tooltip.kind === 'rotation') {
    const markdown = new api.MarkdownString();
    for (const line of rotationTooltipLines(tooltip.diagnostics)) { markdown.appendText(line); markdown.appendMarkdown('\n\n'); }
    item.tooltip = markdown;
  } else {
    item.tooltip = buildTooltip(new api.MarkdownString(undefined, true), tooltip.usage, now, tooltip.refreshError,
      tooltip.activeProfile, tooltip.diagnostics);
  }
  if (model.command) {
    item.command = model.command;
  }
  if (model.greyed) {
    item.color = new api.ThemeColor('disabledForeground');
  }
  if (model.background !== undefined) {
    item.backgroundColor = model.background === null ? undefined
      : new api.ThemeColor(model.background === 'error' ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground');
  }
  item.show();
}

/** Fills the (empty) markdown string with the hover of a service: every window with its exact reset, details, account, rotation. */
export function buildTooltip(md: vscode.MarkdownString, usage: LiveUsage, now: Date, refreshError?: string, activeProfile?: string,
  diagnostics?: RotationDiagnostics): vscode.MarkdownString {
  if (refreshError) {
    const minutes = Math.round((now.getTime() - usage.fetchedAt.getTime()) / 60_000);
    md.appendMarkdown(`$(warning) **Refresh failed** (${refreshError}). Showing the reading from ${minutes} min ago.\n\n`);
  }
  const heading = usage.subtitle ? `${usage.title} · ${usage.subtitle}` : usage.title;
  md.appendMarkdown(`**${heading}**${usage.plan ? ` · ${usage.plan}` : ''}\n\n`);
  // The details panel shows one compact row per service, so the full window names and exact reset
  // times live here.
  for (const window of usage.windows) {
    const reset = formatResetIn(window.resetsAt, now);
    const at = reset && window.resetsAt ? ` (${window.resetsAt.toLocaleString()})` : '';
    md.appendMarkdown(`- **${windowName(window.label)}**: ${formatUsagePercent(window.usedPercent)} used${reset ? ` · ${reset}${at}` : ''}\n`);
  }
  if (usage.provider === 'codex') {
    const credits = projectResetCredits(usage, now.getTime());
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

/** Collects what `buildTooltip` writes, for a plain-text copy. */
class PlainMarkdown {
  value = '';
  appendMarkdown(text: string): this { this.value += text; return this; }
  appendText(text: string): this { this.value += text; return this; }
}

/**
 * The status bar hover of a reading as plain text, for places that cannot render Markdown (a quick pick button's
 * tooltip, a dialog): the same windows, exact resets, earned resets, details, update time and profile.
 */
export function tooltipPlainText(usage: LiveUsage, now: Date, activeProfile?: string): string {
  const md = new PlainMarkdown();
  buildTooltip(md as unknown as vscode.MarkdownString, usage, now, undefined, activeProfile);
  return md.value
    .replace(/\$\([a-z-~]+\)\s*/g, '')
    .replace(/\*\*/g, '')
    .replace(/(^|\n)_(.*)_(?=\n|$)/g, '$1$2')
    .replace(/ {2}\n/g, '\n')
    .replace(/^- /gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
