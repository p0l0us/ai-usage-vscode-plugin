import { usageIcon } from './usageLabels';

export type BillingPeriod = 'daily' | 'weekly' | 'monthly';

/** An entry of the `aiUsage.accounts` setting: figures the user maintains by hand. */
export type AccountUsage = {
  name: string;
  period: BillingPeriod;
  usedTokens: number;
  tokenLimit: number;
  usedBudget: number;
  budgetLimit: number;
};

/** What `WorkspaceConfiguration.inspect` returns for the setting; only the user-set layers matter. */
export type AccountsInspection = { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined;

/** True once the user set the setting themselves; the sample defaults do not count. */
export function hasUserConfiguredAccounts(info: AccountsInspection): boolean {
  return Boolean(info?.globalValue || info?.workspaceValue || info?.workspaceFolderValue);
}

/** The configured entries that can be shown: named, with finite figures and a positive token limit. */
export function validAccounts(configured: AccountUsage[]): AccountUsage[] {
  return configured.filter((entry) =>
    Boolean(entry?.name) &&
    Number.isFinite(entry?.usedTokens) &&
    Number.isFinite(entry?.tokenLimit) &&
    Number.isFinite(entry?.usedBudget) &&
    Number.isFinite(entry?.budgetLimit) &&
    entry.tokenLimit > 0
  );
}

export function summarize(accounts: AccountUsage[]): { remainingPercent: number; lines: string[] } {
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

/** The manual status bar item: text and tooltip, from the valid accounts. */
export function manualStatus(accounts: AccountUsage[]): { text: string; tooltip: string } {
  const summary = summarize(accounts);
  return { text: `$(hubot) AI ${summary.remainingPercent}%`, tooltip: summary.lines.join('\n') };
}

/** One row of the details panel's "Configured accounts" section. */
export function accountDetailItem(account: AccountUsage): { label: string; description: string; detail: string } {
  const usedPercent = Math.round((account.usedTokens / account.tokenLimit) * 100);
  return {
    label: `${usageIcon(usedPercent)} ${account.name}`,
    description: `${usedPercent}% used · ${Math.max(0, account.tokenLimit - account.usedTokens).toLocaleString()} tokens left`,
    detail: `${account.period} · budget ${Math.max(0, account.budgetLimit - account.usedBudget)}/${account.budgetLimit} left`
  };
}
