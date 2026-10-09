import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { readCurrentInstall } from '../service/out';
import type { ServiceManager } from './serviceManager';
import { mcpCommand } from './mcpRegistration';

/**
 * Offers the account service's MCP server (`ai-usage mcp`) to the agents of this VS Code window, the way the
 * editor's own MCP server list does: Copilot agent mode and every other consumer of the `vscode.lm` MCP servers
 * see it as "AI Usage accounts" while `aiUsage.mcp.enabled` is on; the bundled adapter connects to either engine host. Experimental; the
 * tools themselves live in service/src/mcp.ts, and the service checks the setting again on every call.
 */

export const MCP_PROVIDER_ID = 'aiUsage.accounts';
const MCP_SERVER_LABEL = 'AI Usage accounts';
const ENABLED_SETTING = 'aiUsage.mcp.enabled';

export function mcpEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(ENABLED_SETTING, false);
}

/** Thin editor definition: the service owns adapter selection and all MCP behavior. */
export function mcpServerDefinition(home: string, extensionPath = path.resolve(__dirname, '..')): { server?: vscode.McpStdioServerDefinition; reason?: string } {
  if (!mcpEnabled()) { return { reason: `${ENABLED_SETTING} is off` }; }
  const installed = readCurrentInstall(home);
  const bundledPackageDir = path.join(extensionPath, 'service');
  if (!installed && !fs.existsSync(path.join(bundledPackageDir, 'bin', 'ai-usage.js'))) { return { reason: 'the bundled MCP adapter is missing' }; }
  const command = mcpCommand(home, { bundledPackageDir,
    runtime: { command: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } } });
  const server = new vscode.McpStdioServerDefinition(MCP_SERVER_LABEL, command.command, command.args,
    { ...command.env, AI_USAGE_HOME: home }, installed?.version);
  server.cwd = vscode.Uri.file(home);
  return { server };
}

export function registerMcpProvider(context: vscode.ExtensionContext, services: ServiceManager, log: (message: string) => void): void {
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(changed);
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      const { server, reason } = mcpServerDefinition(services.home, context.extensionPath);
      if (!server && mcpEnabled()) { log(`mcp: no server is offered to agents: ${reason}`); }
      return server ? [server] : [];
    },
    resolveMcpServerDefinition: async (server) => {
      // An agent is about to start the server: make sure the service it talks to is running first.
      await services.ensure();
      return server;
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('aiUsage.mcp') || event.affectsConfiguration('aiUsage.accountService')) { changed.fire(); }
  }));
  // Installing or upgrading the service changes the command the server runs with.
  context.subscriptions.push(services.onDidInstall(() => changed.fire()));
}
