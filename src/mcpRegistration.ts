import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AuthProvider, claudeAccountFile, codexHomeDir, launcherPath, resolveCli } from '../service/out';
import { codexConfigPath } from './codexConfig';

/**
 * Registers the account service's MCP server (`ai-usage mcp`, service/src/mcp.ts) with the Claude Code and Codex
 * CLIs, so an agent running in a terminal gets the account tools without editing a configuration file by hand.
 * Each CLI is driven through its own `mcp add` and `mcp remove` commands, never by writing its files; the command
 * registered is the installed launcher, which sets the service home itself and keeps working across service
 * upgrades. A stdio server needs no credentials from the CLI: the server talks to the service over its local
 * socket with the token kept in the service home.
 */

/** The name both CLIs know the server by; also what the server reports as its name at `initialize`. */
export const MCP_SERVER_NAME = 'ai-usage';
const CLI_TIMEOUT_MS = 60_000;

/** What a CLI's configuration holds for the server. */
export type McpRegistration = {
  /** A server of that name is configured, whatever it runs. */
  registered: boolean;
  command?: string;
  args?: string[];
  /** The configured command is this launcher with `mcp`, so the CLI runs the installed service. */
  current: boolean;
};

/** The file each CLI keeps its servers in: Claude Code's `.claude.json` (user scope) and Codex's `config.toml`. */
export function mcpConfigFile(provider: AuthProvider): string {
  return provider === 'claude' ? claudeAccountFile() : codexConfigPath(codexHomeDir());
}

/** The launcher the CLI is told to run; it sets the service home itself, so no `--home` is needed. */
export function mcpLauncher(home: string): string {
  return launcherPath(home);
}

/** The CLI to drive: the configured path resolved as the keep-alive resolves it, or why there is none. */
export function mcpCli(provider: AuthProvider, configured: string | undefined): { cli?: string; reason?: string } {
  const command = configured?.trim() || provider;
  const cli = resolveCli(command);
  return cli ? { cli } : { reason: `${command} was not found. Check the ${provider === 'claude' ? 'Claude' : 'Codex'} CLI path setting.` };
}

function unescapeToml(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

/** The server's table in Codex's TOML, read without a TOML library: the header, then its `command` and `args` lines. */
function readCodexEntry(text: string): { command?: string; args?: string[] } | undefined {
  const header = new RegExp(`^\\[mcp_servers\\.(?:${MCP_SERVER_NAME}|"${MCP_SERVER_NAME}")\\]\\s*$`, 'm');
  const start = text.search(header);
  if (start < 0) { return undefined; }
  const lineEnd = text.indexOf('\n', start);
  const body = lineEnd < 0 ? '' : text.slice(lineEnd + 1);
  const next = body.search(/^\s*\[/m);
  const table = next < 0 ? body : body.slice(0, next);
  const command = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(table)?.[1];
  const args = /^\s*args\s*=\s*\[([^\]]*)\]/m.exec(table)?.[1];
  return {
    command: command === undefined ? undefined : unescapeToml(command),
    args: args === undefined ? undefined : [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => unescapeToml(match[1]))
  };
}

/** What the provider's CLI has registered under the server's name, read from its configuration file. */
export function readMcpRegistration(provider: AuthProvider, launcher: string): McpRegistration {
  let entry: { command?: string; args?: string[] } | undefined;
  try {
    const text = fs.readFileSync(mcpConfigFile(provider), 'utf8');
    if (provider === 'claude') {
      const parsed = JSON.parse(text) as { mcpServers?: Record<string, { command?: unknown; args?: unknown } | undefined> };
      const server = parsed.mcpServers?.[MCP_SERVER_NAME];
      entry = server ? {
        command: typeof server.command === 'string' ? server.command : undefined,
        args: Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === 'string') : undefined
      } : undefined;
    } else {
      entry = readCodexEntry(text);
    }
  } catch { entry = undefined; }
  if (!entry) { return { registered: false, current: false }; }
  const current = entry.command !== undefined && path.resolve(entry.command) === path.resolve(launcher) && (entry.args ?? []).join(' ') === 'mcp';
  return { registered: true, command: entry.command, args: entry.args, current };
}

/** `claude mcp add --scope user ai-usage -- <launcher> mcp`, so every project sees it; Codex's servers are global anyway. */
export function mcpRegisterArgs(provider: AuthProvider, launcher: string): string[] {
  return provider === 'claude'
    ? ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', MCP_SERVER_NAME, '--', launcher, 'mcp']
    : ['mcp', 'add', MCP_SERVER_NAME, '--', launcher, 'mcp'];
}

export function mcpRemoveArgs(provider: AuthProvider): string[] {
  return provider === 'claude' ? ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME] : ['mcp', 'remove', MCP_SERVER_NAME];
}

export type CliRun = { code: number | null; stdout: string; stderr: string };
export type CliRunner = (cli: string, args: string[]) => Promise<CliRun>;

/** Runs the CLI without a terminal; a `.cmd` shim on Windows needs the shell, so arguments are quoted for it. */
export function runCli(cli: string, args: string[]): Promise<CliRun> {
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli);
  const quoted = shell ? args.map((arg) => /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg) : args;
  return new Promise((resolve) => {
    execFile(cli, quoted, { timeout: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, shell }, (error, stdout, stderr) => {
      const code = !error ? 0 : typeof error.code === 'number' ? error.code : null;
      // A CLI that could not start or ran out of time has no exit code; its error is the only explanation.
      const explanation = error && code === null ? [String(stderr).trim(), error.message].filter(Boolean).join('\n') : String(stderr);
      resolve({ code, stdout: String(stdout), stderr: explanation });
    });
  });
}

/** The most useful line of a CLI's output: the last non-empty line of stderr when it failed, else of stdout; Codex warns on stderr even when it succeeds. */
function lastLine(run: CliRun): string | undefined {
  for (const text of run.code === 0 ? [run.stdout, run.stderr] : [run.stderr, run.stdout]) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length) { return lines[lines.length - 1]; }
  }
  return undefined;
}

export type RegistrationOutcome = { ok: boolean; detail: string; registration: McpRegistration };

/**
 * Registers the launcher with the CLI. An entry of the same name is removed first: Claude Code refuses to add a
 * server that already exists, and Codex would keep whatever else the old table carried.
 */
export async function registerMcpServer(provider: AuthProvider, cli: string, launcher: string, run: CliRunner = runCli): Promise<RegistrationOutcome> {
  if (readMcpRegistration(provider, launcher).registered) {
    const removed = await run(cli, mcpRemoveArgs(provider));
    if (removed.code !== 0) {
      return { ok: false, detail: `the existing “${MCP_SERVER_NAME}” entry could not be removed: ${lastLine(removed) ?? `exit code ${removed.code}`}`,
        registration: readMcpRegistration(provider, launcher) };
    }
  }
  const added = await run(cli, mcpRegisterArgs(provider, launcher));
  const registration = readMcpRegistration(provider, launcher);
  if (added.code !== 0) { return { ok: false, detail: lastLine(added) ?? `exit code ${added.code}`, registration }; }
  const command = `${path.basename(cli)} ${mcpRegisterArgs(provider, launcher).join(' ')}`;
  return {
    ok: true,
    detail: registration.current ? command : `${command}: the CLI reported success, but ${mcpConfigFile(provider)} does not show the entry`,
    registration
  };
}

/** Removes the CLI's entry for the server. */
export async function unregisterMcpServer(provider: AuthProvider, cli: string, run: CliRunner = runCli): Promise<{ ok: boolean; detail: string }> {
  const removed = await run(cli, mcpRemoveArgs(provider));
  return { ok: removed.code === 0, detail: lastLine(removed) ?? `exit code ${removed.code}` };
}
