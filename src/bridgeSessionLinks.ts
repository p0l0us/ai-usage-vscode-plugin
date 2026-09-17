import * as vscode from 'vscode';
import { Session } from './bridgeIntegration';
import { sessionLink } from './bridgeAgents';

// Strip presentation controls before forwarding assistant history, including
// legacy footers from builds that used HTML comments (rendered literally by Copilot).
export function stripSessionFooter(text: string): string {
  return text.replace(/\n\n<!-- ai-usage-session:[a-f0-9-]{36} -->\n[\s\S]*?\n<!-- \/ai-usage-session -->\s*$/, '')
    .replace(/^\*\*CLI session\*\*\n\n[\s\S]*?\n\n---\n\n/, '')
    .replace(/\n\n\*\*Subagent:\*\* \[[^\n]*\]\([^\n]*(?:\/sessions\/|%2Fsessions%2F)[a-f0-9-]{36}(?:\/agent\/|%2Fagent%2F)[a-zA-Z0-9_-]+[^\n]*\) · [^\n]*\n\n/g, '');
}

export function resumeCommand(cli: NonNullable<Session['launch']>['cli'], platform = process.platform): string {
  if (!cli) return '';
  if ([cli.cwd, cli.command, ...cli.args].some(value => /[\r\n\0]/.test(value))) return '';
  if (platform === 'win32') {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    return `Set-Location -LiteralPath ${quote(cli.cwd)}; if ($?) { & ${[cli.command, ...cli.args].map(quote).join(' ')} }`;
  }
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const arg = (value: string) => /^[-a-zA-Z0-9_./:]+$/.test(value) ? value : quote(value);
  return `cd -- ${quote(cli.cwd)} && ${[cli.command, ...cli.args].map(arg).join(' ')}`;
}

export async function sessionHeader(session: Session, model: string, token: vscode.CancellationToken): Promise<string> {
  const backend = model.split('/')[0];
  if (!/^[a-f0-9-]{36}$/.test(session.id) || !['codex', 'claude'].includes(backend) ||
    session.backend !== backend || session.model !== model || !session.persisted || !session.cwd ||
    !/^[a-zA-Z0-9_-]+$/.test(session.native_session_id || '') || token.isCancellationRequested) return '';
  const config = vscode.workspace.getConfiguration('aiUsage.bridge');
  const parts: string[] = [];
  const link = (target: 'cli' | 'extension') => sessionLink(session.id, target);
  if (config.get(`${backend}.openInCli`, false)) {
    const cli = session.launch?.cli || {
      command: session.cli_executable?.file || config.get<string>(`${backend}.executable`, backend),
      args: [...(session.cli_executable?.args || []), backend === 'claude' ? '--resume' : 'resume', session.native_session_id!],
      cwd: session.cwd
    };
    const command = resumeCommand(cli);
    if (command) {
      const fence = '`'.repeat(Math.max(3, ...Array.from(command.matchAll(/`+/g), match => match[0].length + 1)));
      parts.push(`[Open in CLI](${await link('cli')})\n\n${fence}${process.platform === 'win32' ? 'powershell' : 'sh'}\n${command}\n${fence}`);
    }
  }
  if (config.get(`${backend}.openInExtension`, false)) {
    parts.push(`[Open in ${backend === 'claude' ? 'Claude Code' : 'Codex'} chat](${await link('extension')})`);
  }
  if (parts.length) parts.push(`[Agent map](${await sessionLink(session.id, 'agents')})`);
  return parts.length && !token.isCancellationRequested ? `**CLI session**\n\n${parts.join('\n\n')}\n\n---\n\n` : '';
}
