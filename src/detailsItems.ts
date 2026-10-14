import type * as vscode from 'vscode';
import type { ProviderId } from '../service/out';
import { AccountUsage, accountDetailItem } from './manualAccounts';
import { LiveProvider, visibleUsage } from './statusItem';
import { PROVIDER_TITLES, SIGN_IN_HINTS, SOURCE_LABELS, SourceId, formatInterval, usageIcon, usagePart, worstPercent } from './usageLabels';

export type DetailItem = vscode.QuickPickItem & {
  action?: 'refresh' | 'refreshProvider' | 'log' | 'history' | 'settings' | 'connect' | 'all' | 'profiles' | 'mcp' | 'service';
  providerId?: ProviderId;
};

/** What the rows depend on besides the provider's readings; tests pass plain values. */
export type DetailsEnv = {
  separator: vscode.QuickPickItemKind;
  now: Date;
  /** "this computer" or "the remote (ssh-remote)". */
  host: string;
  /** The provider's configured source and check interval. */
  settingsFor: (id: ProviderId) => { source: string; checkIntervalMs: number };
  updateIntervalMs: number;
};

/** "this computer" or "the remote (ssh-remote)": where this extension host, and so the login it reads, lives. */
export function hostDescription(remoteName: string | undefined): string {
  return remoteName ? `the remote (${remoteName})` : 'this computer';
}

export function titleFor(provider: Pick<LiveProvider, 'id' | 'lastGood'>): string {
  return provider.lastGood?.title ?? PROVIDER_TITLES[provider.id];
}

export function providerItems(provider: LiveProvider, env: DetailsEnv): DetailItem[] {
  const result = provider.last;
  const usage = visibleUsage(provider);
  const items: DetailItem[] = [];
  const title = usage?.title ?? (result?.kind === 'error' ? result.title : provider.id);
  const plan = usage?.plan ? ` · ${usage.plan}` : '';
  const who = usage?.subtitle ? ` · ${usage.subtitle}` : '';
  items.push({ label: `${title}${who}${plan}`, kind: env.separator });
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
      detail: result.reason ?? `Not installed or not signed in ${env.host}.`
    });
    items.push({
      label: '$(info) Where the login has to be',
      detail: `The extension reads ${PROVIDER_TITLES[provider.id]} where it runs (${env.host}). In the Agents window that is always your local computer, even for remote sessions. Sign in there with the same account (${SIGN_IN_HINTS[provider.id]}); limits are per account, so the figures match.`
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
  const { source, checkIntervalMs } = env.settingsFor(provider.id);
  const throttledMs = 0;
  items.push({
    label: `${usageIcon(worstPercent(usage))} ${usage.windows.map((window) => `${window.label} ${usagePart(window, env.now)}`).join(' · ')}`,
    description: `Updated ${usage.fetchedAt.toLocaleTimeString()}`,
    detail: `Refresh now · ${SOURCE_LABELS[source as SourceId] ?? source} · checked every ${formatInterval(checkIntervalMs)} · ` +
      (throttledMs > 0
        ? `next call to the service allowed in ${Math.ceil(throttledMs / 1000)}s`
        : `display refreshed every ${Math.round(env.updateIntervalMs / 60_000)} min`),
    action: 'refreshProvider',
    providerId: provider.id
  });
  for (const line of usage.details ?? []) {
    const [key, ...rest] = line.split(': ');
    items.push(rest.length ? { label: `$(info) ${key}`, description: rest.join(': ') } : { label: `$(info) ${line}` });
  }
  return items;
}

/** The whole picker: `focused` limits it to one provider (a chip was clicked) with a way back to all. */
export function buildDetailItems(providers: LiveProvider[], focused: LiveProvider | undefined, env: DetailsEnv,
  accounts: { configured: boolean; usage: () => AccountUsage[] }, serviceSummary?: () => string): DetailItem[] {
  const items: DetailItem[] = [];
  for (const provider of focused ? [focused] : providers) {
    items.push(...providerItems(provider, env));
  }
  if (focused) {
    items.push({ label: 'Actions', kind: env.separator });
    items.push({ label: '$(list-flat) Show all providers', action: 'all' });
  }
  if (!focused && accounts.configured) {
    items.push({ label: 'Configured accounts', kind: env.separator });
    for (const account of accounts.usage()) {
      items.push(accountDetailItem(account));
    }
  }
  if (!focused) {
    items.push({ label: 'Actions', kind: env.separator });
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
}
