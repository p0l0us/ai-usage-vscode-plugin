import type * as vscode from 'vscode';
import { MCP_SERVER_NAME } from './mcpRegistration';
import { providerTitle } from './accountMessages';
import type { AuthProvider } from '../service/out';

export type McpSetupItem = vscode.QuickPickItem & { action: 'connect' | 'enable' | 'claude' | 'codex' | 'settings' };
export type McpRegistrationState = { current?: boolean; registered?: boolean };

/** The MCP setup menu: connect, then enable, then register with each CLI; the settings row is always last. */
export function mcpSetupItems(connected: boolean, enabled: boolean, registrations: Record<'claude' | 'codex', McpRegistrationState> | undefined): McpSetupItem[] {
  const items: McpSetupItem[] = [];
  if (!connected) {
    items.push({ label: '$(debug-start) Connect to the account service…', detail: 'Connects to the shared engine and reads its MCP settings.', action: 'connect' });
  } else if (!enabled) {
    items.push({ label: '$(plug) Enable the MCP server…', detail: 'Makes account tools available to agents in this VS Code window and allows CLI registration.', action: 'enable' });
  } else {
    for (const provider of ['claude', 'codex'] as const) {
      const registration = registrations?.[provider] ?? {};
      items.push({
        label: `$(plug) Register with ${providerTitle(provider)} CLI…`,
        description: registration.current ? 'Registered' : registration.registered ? 'Registered with another command' : 'Not registered',
        detail: `Adds the ${MCP_SERVER_NAME} MCP server to ${provider === 'claude' ? 'Claude Code' : 'Codex'} in terminal sessions.`,
        action: provider
      });
    }
  }
  items.push({ label: '$(gear) MCP settings…', description: enabled ? 'Enabled' : 'Disabled', action: 'settings' });
  return items;
}

/** A command line as the registration notices display it: parts with spaces or quotes are JSON-quoted. */
export function displayedMcpCommand(launcher: string, command?: { command?: string; args?: string[] }): string {
  return [command?.command ?? launcher, ...(command?.args ?? ['mcp'])]
    .map((part) => /[\s"]/.test(part) ? JSON.stringify(part) : part).join(' ');
}

export function mcpWhere(provider: AuthProvider): string {
  return provider === 'claude' ? 'in its user scope, for every project' : 'in its config.toml';
}
