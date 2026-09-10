import * as vscode from 'vscode';

type BillingPeriod = 'daily' | 'weekly' | 'monthly';

type AccountUsage = {
  name: string;
  period: BillingPeriod;
  usedTokens: number;
  tokenLimit: number;
  usedBudget: number;
  budgetLimit: number;
};

type SessionUsage = {
  session: string;
  account: string;
  usedTokens: number;
  remainingTokens: number;
};

class ChatSessionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const sessions = getSessionUsage();
    return sessions.map((session) => {
      const item = new vscode.TreeItem(session.session, vscode.TreeItemCollapsibleState.None);
      item.description = `${session.remainingTokens.toLocaleString()} left`;
      item.tooltip = `${session.account}\nUsed: ${session.usedTokens.toLocaleString()}\nRemaining: ${session.remainingTokens.toLocaleString()}`;
      item.contextValue = 'aiUsageSession';
      return item;
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
  status.command = 'aiUsage.showDetails';
  context.subscriptions.push(status);

  const sessionsProvider = new ChatSessionsProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('aiUsage.chatSessions', sessionsProvider));

  const refresh = () => {
    const accounts = getAccountUsage();
    const summary = summarize(accounts);
    status.text = `$(hubot) AI ${summary.remainingPercent}%`;
    status.tooltip = summary.lines.join('\n');
    status.show();
    sessionsProvider.refresh();
  };

  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.showDetails', () => {
    const details = summarize(getAccountUsage()).lines.join('\n');
    return vscode.window.showInformationMessage(details);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('aiUsage.refresh', refresh));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('aiUsage.accounts') || event.affectsConfiguration('aiUsage.chatSessions')) {
      refresh();
    }
  }));

  refresh();
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

function getSessionUsage(): SessionUsage[] {
  const configured = vscode.workspace.getConfiguration().get<SessionUsage[]>('aiUsage.chatSessions', []);
  return configured.filter((entry) =>
    Boolean(entry?.session) &&
    Boolean(entry?.account) &&
    Number.isFinite(entry?.usedTokens) &&
    Number.isFinite(entry?.remainingTokens)
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
