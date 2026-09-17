import * as vscode from 'vscode';
import { bridgeGet, Session, Subagent } from './bridgeIntegration';

const sessionId = /^[a-f0-9-]{36}$/;
const agentId = /^[a-zA-Z0-9_-]{1,200}$/;
export const agentKey = (agent: Subagent): string => agent.tool_call_id || agent.id;
const plain = (value: string): string => value.replace(/[\r\n\t]+/g, ' ').slice(0, 200);
const md = (value: string): string => plain(value).replace(/[\\`*_{}\[\]()<>|!#]/g, '\\$&');

export async function sessionLink(id: string, target: string): Promise<string> {
  if (!sessionId.test(id) || !/^(cli|extension|agents|agent\/[a-zA-Z0-9_-]{1,200}(?:\/(?:cli|extension))?)$/.test(target)) throw new Error('Invalid session link.');
  const uri = vscode.Uri.parse(`${vscode.env.uriScheme}://p0l0us.ai-usage-vscode-plugin/sessions/${id}/${target}`);
  return (await vscode.env.asExternalUri(uri)).toString(true);
}

export async function subagentNotice(id: string, agent: Subagent): Promise<string> {
  if (!sessionId.test(id) || !agentId.test(agentKey(agent))) return '';
  // A single reserved presentation line is removable from model history without HTML markers.
  return `\n\n**Subagent:** [${md(agent.label || agent.id)}](${await sessionLink(id, `agent/${agentKey(agent)}`)}) · ${md(agent.status)}\n\n`;
}

export async function openAgentMap(id: string, child?: string): Promise<void> {
  if (!sessionId.test(id) || child !== undefined && !agentId.test(child)) throw new Error('Invalid session link.');
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query: `@aiusage /agents ${id}${child ? ` ${child}` : ''}`, preserveInput: true
  });
}

export async function agentMap(prompt: string, token: vscode.CancellationToken): Promise<string> {
  const [id, selected, extra] = prompt.trim().split(/\s+/);
  if (!sessionId.test(id || '') || selected && !agentId.test(selected) || extra) {
    return 'Open **Agent map** from a CLI session in chat, or use `@aiusage /agents <bridge-session-id>`.';
  }
  const root = await bridgeGet<Session>(`/v1/sessions/${id}`, token);
  if (root.id !== id) throw new Error('The bridge returned a different session.');
  const actions = async (session: Session) => {
    const config = vscode.workspace.getConfiguration('aiUsage.bridge');
    const links = [`[Agent map](${await sessionLink(session.id, 'agents')})`];
    if (session.persisted && session.released) {
      if (config.get(`${session.backend}.openInCli`, false)) links.push(`[Open in CLI](${await sessionLink(session.id, 'cli')})`);
      if (config.get(`${session.backend}.openInExtension`, false)) links.push(`[Open in ${session.backend === 'claude' ? 'Claude Code' : 'Codex'} chat](${await sessionLink(session.id, 'extension')})`);
    }
    return links.join(' · ');
  };
  if (selected) {
    const agent = root.subagents?.find(child => agentKey(child) === selected || child.id === selected);
    if (!agent) throw new Error('This subagent is no longer available in the bridge records.');
    const lines = [`**Subagent: ${md(agent.label || agent.id)}**`,
      `Status: **${md(agent.status)}** · Backend: ${md(root.backend)}`,
      `Native agent ID: ${md(agent.native_session_id || 'not reported yet')}`, await actions(root)];
    if (agent.summary) {
      const fence = '`'.repeat(Math.max(3, ...Array.from(agent.summary.matchAll(/`+/g), match => match[0].length + 1)));
      lines.push(`Reported result (up to 4,000 characters):\n\n${fence}text\n${agent.summary.slice(0, 4000)}\n${fence}`);
    }
    if (root.backend === 'claude' && agent.native_session_id && agentId.test(agent.native_session_id)) {
      lines.push(`To continue this agent, return to its original Copilot conversation and ask: “Resume agent ${agent.native_session_id} and …”. Claude resumes subagents through their parent session; the native chat link above opens that parent.`);
    }
    if (root.backend === 'codex' && agent.native_session_id) {
      if (root.persisted && root.released && sessionId.test(agent.native_session_id) && !['running', 'pendingInit'].includes(agent.status)) {
        const config = vscode.workspace.getConfiguration('aiUsage.bridge');
        if (config.get('codex.openInExtension', false)) lines.push(`[Open this subagent in Codex chat](${await sessionLink(id, `agent/${agentKey(agent)}/extension`)})`);
        if (config.get('codex.openInCli', false)) lines.push(`[Open this subagent in CLI](${await sessionLink(id, `agent/${agentKey(agent)}/cli`)})`);
      }

    }
    return lines.join('\n\n');
  }
  const { data = [], truncated } = await bridgeGet<{ data: Session[]; truncated?: boolean }>(`/v1/sessions/${id}/graph`, token);
  const rows: string[] = []; const tree: string[] = []; const visited = new Set<string>();
  const walk = async (session: Session, depth: number): Promise<void> => {
    if (visited.has(session.id) || rows.length >= 200) return;
    visited.add(session.id);
    const name = `${depth ? 'Branch' : 'Session'} ${session.id.slice(0, 8)}`;
    tree.push(`${'  '.repeat(depth)}${depth ? '└─ ' : ''}${name} · ${plain(session.status)}`);
    rows.push(`| [${name}](${await sessionLink(session.id, 'agents')}) | ${md(session.model)} | ${md(session.status)} | ${session.parent_id ? session.parent_id.slice(0, 8) : '—'} |`);
    for (const agent of (session.subagents || []).slice(0, 100)) {
      if (rows.length >= 200) break;
      if (!agentId.test(agentKey(agent))) continue;
      const label = agent.label || agent.id;
      tree.push(`${'  '.repeat(depth + 1)}├─ ${plain(label)} · ${plain(agent.status)}`);
      const nativeParent = session.subagents?.find(parent => parent.native_session_id === agent.parent_native_session_id);
      rows.push(`| [${md(label)}](${await sessionLink(session.id, `agent/${agentKey(agent)}`)}) | Subagent | ${md(agent.status)} | ${md(nativeParent?.label || nativeParent?.id || session.id.slice(0, 8))} |`);
    }
    for (const child of data.filter(child => child.parent_id === session.id)) await walk(child, depth + 1);
  };
  await walk(root, 0);
  const fence = '`'.repeat(Math.max(3, ...Array.from(tree.join('\n').matchAll(/`+/g), match => match[0].length + 1)));
  return [`**Agent map** · ${md(root.backend)}`, await actions(root),
    root.parent_id ? `[Parent branch](${await sessionLink(root.parent_id, 'agents')})` : '',
    `${fence}text\n${tree.join('\n')}\n${fence}`,
    '| Agent | Model / type | Status | Parent |\n| --- | --- | --- | --- |\n' + rows.join('\n'),
    truncated ? 'This tree exceeds 200 entries. Open a branch map to see more.' : '',
    'Select an agent for its reported result and resume information. Select **Agent map** again to refresh this snapshot. Saved branches can be created with Copilot’s `#fork_cli_session` tool after the parent finishes.'].filter(Boolean).join('\n\n');
}
