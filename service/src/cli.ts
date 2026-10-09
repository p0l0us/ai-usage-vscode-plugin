import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { AuthProvider } from './authFiles';
import { readableProblem } from './accountProbe';
import { ServiceClient, ServiceUnavailableError, connectService } from './client';
import { GLOBAL_SETTINGS, SETTINGS, listConfig } from './configStore';
import { runDaemon } from './daemon';
import { findNode, installService, launcherPath, readCurrentInstall, restartService, serviceStatus, startService, stopService, uninstallService, serviceManuallyStopped } from './installer';
import { Logger } from './logger';
import { runMcpStdio } from './mcp';
import { logFile, serviceHome } from './paths';
import { PROVIDERS, TITLES } from './profileStore';
import type { ProfileView, ProviderView, ServiceEvent, Snapshot } from './protocol';
import { formatResetRemaining } from './live';
import { runTop } from './tui';
import { servicePackageDir, serviceVersion } from './version';

/**
 * The `ai-usage` command: everything the VS Code Accounts menus can do, from arguments or from the live view
 * (`ai-usage top`), plus the service itself (`ai-usage service …`). Talks to the running service; starts it when
 * it is installed but not running.
 */

const USAGE = `ai-usage – Claude Code and Codex account profiles, keep-alives and rotation

Usage: ai-usage <command> [arguments] [--json] [--home <dir>]

Accounts
  status                          Active accounts, their usage and the service state (default without a TTY)
  top                             Live view: navigate, switch, keep-alive, rotate (default with a TTY)
  list [claude|codex]             Saved profiles with their last readings
  use <service> <profile>         Activate a profile (name, number or id); aliases: switch, activate
  save <service> [name]           Save the login the CLI currently uses as a new profile
      --update <profile>          …or into an existing profile, which becomes active
      --allow-duplicate           Save even when the login is already saved under another profile
      --project[=<dir>]           Keep it in the project folder's profile file (the current directory by default)
  import <service> <file> --name <name> [--project[=<dir>]]
                                  Import a credential JSON file as a profile without activating it
  rename <service> <profile> <new name>
  move <service> <profile> up|down   Move a saved profile one place in its list
  delete <service> <profile> [-y]
  login <service> <profile> [-y]  Sign in again with the vendor CLI (isolated home) and store the new login
  keepalive <service> [<profile>|--all]
                                  Send the keep-alive prompt now and refresh the usage reading
  rotate <service>                Run a rotation sweep now, whatever the schedule and the rotation switch say
  export [file] [--provider <service>]
                                  Write the saved profiles, logins included, to a JSON file (default ~/ai-usage-profiles.json; - for stdout)
  import-profiles <file> [--replace] [-y]
                                  Import a profile export made elsewhere; --replace also replaces differing logins

History
  history [--days <n>|--all]      Summary of the usage history (the last 30 days by default) as Markdown
  history export readings|events|jsonl [file]
                                  Readings or the other events as CSV, or every kept line as JSON Lines
  history path                    Where the history files are

Settings
  usage [claude|codex|copilot]      Read current native-login usage (no saved profile required)
  rotation-weights <service>      Explain scores and current account selection
  config                          List every setting with its value
  config <key>                    Show one value, e.g. claude.autoRotate.strategy
  config <key> <value>            Change it, e.g. claude.autoRotate.enabled true

AI agents (experimental)
  mcp                             Serve the MCP tools on stdin/stdout for an agent (list_accounts, refresh_usage,
                                  switch_account, rotate_account); off until "config mcp.enabled true"

Service
  service status                  Whether the service is installed, running and registered to start at login
  service install [--no-autostart]
                                  Install this package under the service home and register it to start at login
  service uninstall               Stop, unregister and remove the installed package (profiles and settings stay)
  service start | stop | restart
  service run                     Run the service in the foreground (what the autostart runs as "daemon")
  log [-n <lines>] [-f]           Show the service log; -f follows it live

Options
  --project[=<dir>]               Also list the project profiles of that folder (the current directory when its
                                  profile file exists); with save and import, where to keep the new profile
  --json                          Machine-readable output where it applies
  --home <dir>                    Service home (default ~/.ai-usage, or $AI_USAGE_HOME)
  -y, --yes                       Answer confirmations with yes
  -h, --help, -v, --version
`;

type Flags = { [name: string]: string | boolean | undefined };
type Parsed = { positional: string[]; flags: Flags };

const VALUE_FLAGS = new Set(['home', 'name', 'provider', 'lines', 'n', 'update', 'days']);
/** Flags that may stand alone or carry a value with "=", such as `--project` and `--project=/path`. */
const OPTIONAL_VALUE_FLAGS = new Set(['project']);
const ALIASES: Record<string, string> = { y: 'yes', h: 'help', v: 'version', f: 'follow', n: 'lines' };

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { positional.push(...argv.slice(index + 1)); break; }
    if (arg.startsWith('--')) {
      const [rawName, inline] = arg.slice(2).split(/=(.*)/s);
      const name = ALIASES[rawName] ?? rawName;
      if (rawName.startsWith('no-')) { flags[rawName.slice(3)] = false; continue; }
      if (VALUE_FLAGS.has(name)) { flags[name] = inline ?? argv[++index]; }
      else if (OPTIONAL_VALUE_FLAGS.has(name)) { flags[name] = inline ?? true; }
      else { flags[name] = inline ?? true; }
    } else if (/^-[a-zA-Z]$/.test(arg)) {
      const name = ALIASES[arg[1]] ?? arg[1];
      if (VALUE_FLAGS.has(name)) { flags[name] = argv[++index]; } else { flags[name] = true; }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

class UsageError extends Error {}

function provider(value: string | undefined): AuthProvider {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'claude' || normalized === 'codex') { return normalized; }
  throw new UsageError(`Name the service: claude or codex${value ? `, not "${value}"` : ''}.`);
}

const useColor = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, text: string): string => (useColor() ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (text: string) => paint('1', text);
const dim = (text: string) => paint('2', text);
const green = (text: string) => paint('32', text);
const yellow = (text: string) => paint('33', text);
const red = (text: string) => paint('31', text);

/** Strips ANSI sequences for width calculations. */
const visible = (text: string): number => text.replace(/\x1b\[[0-9;]*m/g, '').length;

export function table(rows: string[][], options: { header?: boolean; indent?: string } = {}): string {
  if (!rows.length) { return ''; }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => visible(row[column] ?? ''))));
  const indent = options.indent ?? '  ';
  return rows.map((row, index) => {
    const line = row.map((cell, column) => column === row.length - 1 ? cell : cell + ' '.repeat(widths[column] - visible(cell))).join('  ');
    return indent + (options.header !== false && index === 0 ? dim(line) : line);
  }).join('\n');
}

export function percentText(window: { usedPercent: number; resetsAt?: string }, now = new Date()): string {
  const reset = formatResetRemaining(window.resetsAt ? new Date(window.resetsAt) : undefined, now);
  const text = `${Math.round(window.usedPercent)}%${reset ? ` (${reset})` : ''}`;
  return window.usedPercent >= 95 ? red(text) : window.usedPercent >= 80 ? yellow(text) : text;
}

function clock(iso: string | undefined): string {
  if (!iso) { return ''; }
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function profileRows(view: ProviderView, now = new Date()): string[][] {
  const labels = ['5h', '7d'];
  const rows: string[][] = [['#', 'Profile', '', 'Email', ...labels, 'Other', 'Checked', 'Problem']];
  for (const profile of view.profiles) {
    const windows = profile.usage?.windows ?? [];
    const cells = labels.map((label) => { const window = windows.find((candidate) => candidate.label === label); return window ? percentText(window, now) : dim('–'); });
    const other = windows.filter((window) => !labels.includes(window.label)).map((window) => `${window.label} ${percentText(window, now)}`).join(' ');
    const problem = profile.loginProblem ? yellow(readableProblem(profile.loginProblem).split('. ')[0])
      : profile.limit.readOnly ? red('at its limit') : profile.problems[0] ? yellow(profile.problems[0].label) : '';
    const where = [profile.email ?? dim('–'), profile.folder ? dim(`project ${path.basename(profile.folder)}`) : ''].filter(Boolean).join(' · ');
    rows.push([String(profile.number), profile.active ? bold(profile.name) : profile.name, profile.active ? green('●') : '', where,
      ...cells, other, clock(profile.checkedAt), problem]);
  }
  return rows;
}

export function providerSummary(view: ProviderView): string {
  const active = view.profiles.find((profile) => profile.active);
  const activeText = active ? `${bold(active.name)}${active.email ? ` (${active.email})` : ''}${view.nativeUnsaved ? dim(' – the native login is not this profile') : ''}` : dim('none');
  return `${bold(view.title)}  active: ${activeText}  ·  keep-alive ${view.keepAlive ? green('on') : dim('off')}  ·  rotation ${view.autoRotate ? green(`on (${view.strategySummary})`) : dim('off')}`;
}

function uptime(startedAt: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function formatStatus(snapshot: Snapshot): string {
  const lines = [`${bold('AI Usage account service')} ${snapshot.service.version} · pid ${snapshot.service.pid} · up ${uptime(snapshot.service.startedAt)} · ${snapshot.service.clients} client${snapshot.service.clients === 1 ? '' : 's'} · ${snapshot.service.home}`, ''];
  for (const key of PROVIDERS) {
    const view = snapshot.providers[key];
    lines.push(providerSummary(view));
    lines.push(view.profiles.length ? table(profileRows(view)) : dim('  no saved profiles'));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

async function confirm(question: string, flags: Flags): Promise<boolean> {
  if (flags.yes) { return true; }
  if (!process.stdin.isTTY) { throw new UsageError(`${question} Pass -y to confirm without a prompt.`); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function startInstalledOrLocal(home: string): () => void {
  return () => {
    if (serviceManuallyStopped(home)) {
      throw new ServiceUnavailableError('The account service was stopped manually. Run "ai-usage service start" to resume it.', 'not-running');
    }
    const installed = readCurrentInstall(home);
    if (installed) {
      const started = startService(home);
      if (!started.ok) { throw new ServiceUnavailableError(started.detail, 'not-installed'); }
      err(dim(`Starting the account service (${started.detail})…\n`));
      return;
    }
    // Not installed: run this very package detached, so the command works from a checkout or an npm install.
    const child = spawn(process.execPath, [path.join(servicePackageDir(), 'bin', 'ai-usage.js'), 'daemon'],
      { detached: true, stdio: 'ignore', env: { ...process.env, AI_USAGE_HOME: home }, windowsHide: true });
    child.unref();
    err(dim('Starting the account service from this package…\n'));
  };
}

/** The project folder of this run: `--project=<dir>`, or the current directory with `--project` alone. */
function projectFolder(flags: Flags): string | undefined {
  if (typeof flags.project === 'string' && flags.project) { return path.resolve(flags.project); }
  return flags.project === true ? process.cwd() : undefined;
}

/**
 * Connects, declaring the project folder of this run so its profile file is listed: the one named with
 * `--project`, or the current directory when it holds a profile file.
 */
async function withClient<T>(home: string, subscribe: ServiceEvent['event'][] | 'all', action: (client: ServiceClient) => Promise<T>, flags: Flags = {}): Promise<T> {
  const client = await connectService({ home, client: 'cli', version: serviceVersion(), subscribe, start: startInstalledOrLocal(home) });
  try {
    let folder = projectFolder(flags);
    if (!folder) {
      const config = await client.getConfig();
      if (config.projectProfiles.enabled && fs.existsSync(path.resolve(process.cwd(), config.projectProfiles.file || '.ai-usage.profiles.json'))) { folder = process.cwd(); }
    }
    if (folder) { await client.setFolders([folder]); }
    return await action(client);
  } finally { client.close(); }
}

function printJson(value: unknown): void {
  out(`${JSON.stringify(value, null, 2)}\n`);
}

/** Prints one account's keep-alive outcome; true when the prompt went through and usage was read. */
function reportKeepAlive(service: AuthProvider, name: string, result: { usage?: { windows: Array<{ label: string; usedPercent: number; resetsAt?: string }> }; keepAliveError?: string; usageError?: string }): boolean {
  const title = TITLES[service];
  if (result.keepAliveError) {
    out(`${red('✗')} ${title} keep-alive failed for “${name}”: ${readableProblem(result.keepAliveError)}${result.usage ? ' Usage statistics were still updated.' : ''}\n`);
    return false;
  }
  if (result.usage) {
    out(`${green('✓')} ${title} keep-alive completed for “${name}”: ${result.usage.windows.map((window) => `${window.label} ${percentText(window)}`).join(' · ')}\n`);
    return true;
  }
  out(`${yellow('!')} ${title} keep-alive completed for “${name}”, but usage could not be read${result.usageError ? `: ${readableProblem(result.usageError)}` : '.'}\n`);
  return false;
}

async function keepAliveOne(client: ServiceClient, service: AuthProvider, profile: ProfileView | { name: string; id: string }, token?: string): Promise<boolean> {
  try {
    return reportKeepAlive(service, profile.name, await client.keepAliveNow(service, profile.id, { token }));
  } catch (error) {
    out(`${red('✗')} ${TITLES[service]} keep-alive for “${profile.name}” not sent: ${readableProblem(error instanceof Error ? error.message : String(error))}\n`);
    return false;
  }
}

export type CliOutput = { stdout: (text: string) => void; stderr: (text: string) => void };

/** Where the command writes; tests replace it, the real command line writes to the process streams. */
let out: (text: string) => void = (text) => { process.stdout.write(text); };
let err: (text: string) => void = (text) => { process.stderr.write(text); };

export async function main(argv: string[], io?: CliOutput): Promise<number> {
  out = io?.stdout ?? ((text) => { process.stdout.write(text); });
  err = io?.stderr ?? ((text) => { process.stderr.write(text); });
  const { positional, flags } = parseArgs(argv);
  const home = typeof flags.home === 'string' && flags.home ? path.resolve(flags.home) : serviceHome();
  const [command = process.stdout.isTTY ? 'top' : 'status', ...rest] = positional;
  const json = flags.json === true;
  const execute = async (): Promise<number> => {
    if (flags.version) { out(`${serviceVersion()}\n`); return 0; }
    if (flags.help || command === 'help') { out(USAGE); return 0; }
    switch (command) {
      case 'status': {
        return withClient(home, [], async (client) => {
          const snapshot = await client.snapshot();
          if (json) { printJson(snapshot); } else { out(`${formatStatus(snapshot)}\n`); }
          return 0;
        }, flags);
      }
      case 'top': case 'watch': case 'live': {
        if (!process.stdout.isTTY) { throw new UsageError('The live view needs a terminal; use "ai-usage status" instead.'); }
        return runTop({ connect: () => connectService({ home, client: 'cli-top', version: serviceVersion(), subscribe: 'all', start: startInstalledOrLocal(home) }) });
      }
      case 'list': case 'ls': {
        const services = rest[0] ? [provider(rest[0])] : PROVIDERS;
        return withClient(home, [], async (client) => {
          const views = await Promise.all(services.map((service) => client.list(service)));
          if (json) { printJson(views.length === 1 ? views[0] : views); return 0; }
          for (const view of views) {
            out(`${providerSummary(view)}\n${view.profiles.length ? table(profileRows(view)) : dim('  no saved profiles')}\n\n`);
          }
          return 0;
        }, flags);
      }
      case 'use': case 'switch': case 'activate': {
        const service = provider(rest[0]);
        if (!rest[1]) { throw new UsageError('Name the profile to activate: its name, number or id.'); }
        return withClient(home, [], async (client) => {
          const result = await client.activate(service, { ref: rest.slice(1).join(' ') });
          if (json) { printJson(result); return 0; }
          const mark = result.level === 'info' ? green('✓') : result.level === 'warning' ? yellow('!') : red('✗');
          out(`${mark} ${result.message}\n`);
          return result.level === 'error' ? 1 : 0;
        }, flags);
      }
      case 'save': {
        const service = provider(rest[0]);
        return withClient(home, [], async (client) => {
          const update = typeof flags.update === 'string' ? flags.update : undefined;
          const name = rest.slice(1).join(' ') || (typeof flags.name === 'string' ? flags.name : '');
          if (!update && !name) { throw new UsageError('Name the new profile, or pass --update <profile> to replace a saved one.'); }
          let target: string | undefined;
          if (update) { target = (await client.list(service)).profiles.find((candidate) => matches(candidate, update))?.id; if (!target) { throw new UsageError(`No ${TITLES[service]} profile matches "${update}".`); } }
          const folder = projectFolder(flags);
          let result = await client.saveNative(service, update ? { id: target } : { name, allowDuplicate: flags['allow-duplicate'] === true, folder });
          if (result.status === 'duplicate') {
            out(`${yellow('!')} ${result.warning}\n`);
            if (!await confirm('Save a copy anyway?', flags)) { return 1; }
            result = await client.saveNative(service, { name, allowDuplicate: true, folder });
            if (result.status === 'duplicate') { return 1; }
          }
          if (json) { printJson(result); return 0; }
          out(`${green('✓')} ${TITLES[service]} login ${result.status === 'saved' ? 'saved as' : 'stored into'} “${result.profile.name}”${result.profile.email ? ` (${result.profile.email})` : ''}${folder && result.status === 'saved' ? ` in project ${path.basename(folder)}` : ''}.\n`);
          return 0;
        }, flags);
      }
      case 'import': {
        const service = provider(rest[0]);
        const file = rest[1];
        if (!file) { throw new UsageError('Name the credential JSON file to import.'); }
        const name = typeof flags.name === 'string' ? flags.name : rest[2];
        if (!name) { throw new UsageError('Pass --name <profile name> for the imported login.'); }
        const document = JSON.parse(fs.readFileSync(file, 'utf8'));
        return withClient(home, [], async (client) => {
          const folder = projectFolder(flags);
          let result = await client.importCredential(service, name, document, flags['allow-duplicate'] === true, folder);
          if (result.status === 'duplicate') {
            out(`${yellow('!')} ${result.warning}\n`);
            if (!await confirm('Save a copy anyway?', flags)) { return 1; }
            result = await client.importCredential(service, name, document, true, folder);
            if (result.status === 'duplicate') { return 1; }
          }
          if (json) { printJson(result); return 0; }
          out(`${green('✓')} ${TITLES[service]} credential imported as “${result.profile.name}”${folder ? ` in project ${path.basename(folder)}` : ''}. Activate it with: ai-usage use ${service} "${result.profile.name}"\n`);
          return 0;
        }, flags);
      }
      case 'rename': {
        const service = provider(rest[0]);
        if (!rest[1] || !rest[2]) { throw new UsageError('Usage: ai-usage rename <service> <profile> <new name>'); }
        return withClient(home, [], async (client) => {
          const renamed = await client.rename(service, { ref: rest[1] }, rest.slice(2).join(' '));
          if (json) { printJson(renamed); } else { out(`${green('✓')} Renamed to “${renamed.name}”.\n`); }
          return 0;
        }, flags);
      }
      case 'move': {
        const service = provider(rest[0]);
        if (!rest[1] || (rest[2] !== 'up' && rest[2] !== 'down')) { throw new UsageError('Usage: ai-usage move <service> <profile> up|down'); }
        return withClient(home, [], async (client) => {
          const view = await client.list(service);
          const target = view.profiles.find((candidate) => matches(candidate, rest[1]));
          if (!target) { throw new UsageError(`No ${TITLES[service]} profile matches "${rest[1]}".`); }
          const profiles = await client.reorder(service, target.id, rest[2] === 'up' ? -1 : 1);
          if (json) { printJson(profiles); } else { out(`${green('✓')} Moved “${target.name}” ${rest[2]}.\n`); }
          return 0;
        }, flags);
      }
      case 'delete': case 'remove': case 'rm': {
        const service = provider(rest[0]);
        if (!rest[1]) { throw new UsageError('Name the profile to delete.'); }
        return withClient(home, [], async (client) => {
          const view = await client.list(service);
          const target = view.profiles.find((candidate) => matches(candidate, rest.slice(1).join(' ')));
          if (!target) { throw new UsageError(`No ${TITLES[service]} profile matches "${rest.slice(1).join(' ')}".`); }
          if (!await confirm(`Delete the saved ${TITLES[service]} profile “${target.name}”?${target.active ? ' The native login remains active until you switch or sign out.' : ''}`, flags)) { return 1; }
          const deleted = await client.delete(service, target.id);
          if (json) { printJson(deleted); } else { out(`${green('✓')} Deleted “${deleted.profile.name}”.\n`); }
          return 0;
        }, flags);
      }
      case 'login': case 'signin': case 'sign-in': {
        const service = provider(rest[0]);
        if (!rest[1]) { throw new UsageError('Name the profile to sign in for.'); }
        return withClient(home, [], async (client) => {
          const view = await client.list(service);
          const target = view.profiles.find((candidate) => matches(candidate, rest.slice(1).join(' ')));
          if (!target) { throw new UsageError(`No ${TITLES[service]} profile matches "${rest.slice(1).join(' ')}".`); }
          const prepared = await client.prepareSignIn(service, target.id);
          out(`Signing in for ${TITLES[service]} profile “${target.name}”${target.email ? ` (${target.email})` : ''} with a separate home; the active login is untouched until the profile is active.\n`);
          // Ctrl-C reaches the vendor CLI as well; surviving it here lets the cancel below lift the service's hold.
          const ignoreInterrupt = () => undefined;
          process.on('SIGINT', ignoreInterrupt);
          let code: number | null;
          try {
            code = await new Promise<number | null>((resolve, reject) => {
              const child = spawn(prepared.cli, prepared.args, { cwd: prepared.cwd, env: prepared.env, stdio: 'inherit', windowsHide: false });
              child.on('error', reject);
              child.on('close', (exit) => resolve(exit));
            });
          } finally { process.off('SIGINT', ignoreInterrupt); }
          if (!fs.existsSync(prepared.file)) {
            await client.cancelSignIn(service);
            out(`${yellow('!')} The sign-in was not completed (the CLI exited with ${code ?? 'a signal'}); the profile is unchanged.\n`);
            return 1;
          }
          let result = await client.finishSignIn(service, target.id, flags.yes === true);
          if (result.status === 'otherAccount') {
            out(`${yellow('!')} ${result.message}\n`);
            if (!await confirm('Replace the profile\'s login anyway?', flags)) { await client.cancelSignIn(service); return 1; }
            result = await client.finishSignIn(service, target.id, true);
            if (result.status === 'otherAccount') { return 1; }
          }
          if (json) { printJson(result); } else { out(`${green('✓')} ${result.message}\n`); }
          return 0;
        }, flags);
      }
      case 'keepalive': case 'keep-alive': case 'ka': {
        const service = provider(rest[0]);
        return withClient(home, [], async (client) => {
          const view = await client.list(service);
          const targets = flags.all || !rest[1] ? view.profiles : view.profiles.filter((candidate) => matches(candidate, rest.slice(1).join(' ')));
          if (!targets.length) { throw new UsageError(rest[1] ? `No ${TITLES[service]} profile matches "${rest.slice(1).join(' ')}".` : `No ${TITLES[service]} profiles are saved.`); }
          if (!rest[1] && !flags.all && targets.length > 1 && !await confirm(`Send the keep-alive to all ${targets.length} ${TITLES[service]} accounts?`, flags)) { return 1; }
          const token = `cli-${process.pid}-${Date.now()}`;
          const onInterrupt = () => { void client.cancel(token).catch(() => undefined); };
          process.once('SIGINT', onInterrupt);
          client.on('event', (event: ServiceEvent) => {
            if (event.event === 'waiting' && event.token === token) { err(dim(`waiting for a running ${TITLES[service]} account check…\n`)); }
            if (event.event === 'keepAliveProgress' && event.token === token) { err(dim(`${event.index + 1}/${event.total}: “${event.name}”…\n`)); }
          });
          try {
            if (targets.length === 1) { return await keepAliveOne(client, service, targets[0], token) ? 0 : 1; }
            const sweep = await client.keepAliveAll(service, targets.map((target) => target.id), { token });
            let failed = 0;
            for (const result of sweep.results) {
              if (result.error) { out(`${red('✗')} ${TITLES[service]} keep-alive for “${result.name}” not sent: ${readableProblem(result.error)}\n`); failed++; continue; }
              if (!reportKeepAlive(service, result.name, result)) { failed++; }
            }
            const notSent = sweep.total - sweep.done;
            if (notSent) { out(`${yellow('!')} ${notSent} of ${sweep.total} not sent: ${sweep.cancelled ? 'cancelled' : sweep.blocked ?? 'the sweep stopped'}.\n`); }
            return failed || notSent ? 1 : 0;
          } finally { process.off('SIGINT', onInterrupt); }
        }, flags);
      }
      case 'rotate': {
        const service = provider(rest[0]);
        return withClient(home, [], async (client) => {
          const result = await client.rotateNow(service);
          if (json) { printJson(result); return 0; }
          out(result.switched
            ? `${green('✓')} ${TITLES[service]} rotated to “${result.activeProfileName ?? result.activeProfileId}”.\n`
            : `${yellow('–')} ${TITLES[service]} not rotated: ${result.reason}.\n`);
          return 0;
        }, flags);
      }
      case 'export': {
        const target = rest[0] ?? path.join(os.homedir(), 'ai-usage-profiles.json');
        const only = typeof flags.provider === 'string' ? provider(flags.provider) : undefined;
        return withClient(home, [], async (client) => {
          const result = await client.exportProfiles(only ? (await client.list(only)).profiles.map((profile) => ({ provider: only, id: profile.id })) : undefined);
          if (!result.entries.length) { out(`${yellow('!')} Nothing to export${result.missing.length ? `; no login is saved for ${result.missing.join(', ')}` : ''}.\n`); return 1; }
          if (target === '-') { out(result.text); return 0; }
          fs.writeFileSync(target, result.text, { mode: 0o600 });
          if (process.platform !== 'win32') { try { fs.chmodSync(target, 0o600); } catch { /* A file system without modes. */ } }
          out(`${green('✓')} Exported ${result.entries.length} profile${result.entries.length === 1 ? '' : 's'} to ${target}. ${yellow('The file holds login tokens in plain text: import it on the other computer, then delete it.')}${result.missing.length ? ` Skipped, no login saved: ${result.missing.join(', ')}.` : ''}\n`);
          return 0;
        }, flags);
      }
      case 'import-profiles': {
        const file = rest[0];
        if (!file) { throw new UsageError('Name the profile export file to import.'); }
        const text = fs.readFileSync(file, 'utf8');
        return withClient(home, [], async (client) => {
          const plans = await client.planImport(text);
          const chosen = plans.filter((plan) => plan.suggested || (flags.replace === true && plan.kind === 'replace'));
          if (json && flags.yes !== true) { printJson(plans); return 0; }
          out(`${table([['Service', 'Profile', 'Email', 'Outcome', ''], ...plans.map((plan) => [TITLES[plan.provider], plan.name, plan.email ?? dim('–'), plan.outcome, chosen.includes(plan) ? green('import') : dim('skip')])])}\n`);
          if (!chosen.length) { out(`${yellow('!')} Nothing to import${plans.some((plan) => plan.kind === 'replace') ? ' (pass --replace to replace differing logins)' : ''}.\n`); return 1; }
          if (!await confirm(`Import ${chosen.length} profile${chosen.length === 1 ? '' : 's'}? Nothing is activated.`, flags)) { return 1; }
          const summary = await client.applyImport(text, chosen.map((plan) => ({ provider: plan.provider, id: plan.id })));
          if (json) { printJson(summary); } else { out(`${green('✓')} Imported ${summary.imported}: ${summary.summary}. Nothing was activated.\n`); }
          return 0;
        });
      }
      case 'usage': {
        const providers = rest[0] ? [rest[0]] : ['claude', 'codex', 'copilot'];
        if (providers.some(id => !['claude', 'codex', 'copilot'].includes(id))) throw new UsageError('Choose claude, codex or copilot.');
        return withClient(home, [], async client => {
          const result = await Promise.all(providers.map(id => client.liveUsage(id as 'claude' | 'codex' | 'copilot')));
          printJson(result.length === 1 ? result[0] : result); return 0;
        }, flags);
      }
      case 'rotation-weights': return withClient(home, [], async client => {
        printJson(await client.call('rotation.diagnostics', { provider: provider(rest[0]) })); return 0;
      }, flags);
      case 'config': case 'set': case 'get': {
        const args = command === 'config' ? rest : command === 'set' ? ['set', ...rest] : ['get', ...rest];
        const verb = args[0] === 'set' || args[0] === 'get' || args[0] === 'list' ? args.shift() : undefined;
        return withClient(home, [], async (client) => {
          if (!args[0] || verb === 'list') {
            const config = await client.getConfig();
            if (json) { printJson(config); return 0; }
            out(`${table([['Setting', 'Value', ''], ...listConfig(config).map((entry) => [entry.key, bold(typeof entry.value === 'object' ? JSON.stringify(entry.value) : String(entry.value)), dim(entry.schema.description)])])}\n`);
            return 0;
          }
          if (args.length < 2 || verb === 'get') {
            const config = await client.getConfig();
            const entry = listConfig(config).find((candidate) => candidate.key === args[0]);
            if (!entry) { throw new UsageError(`Unknown setting "${args[0]}". Settings: ${SETTINGS.map((setting) => setting.key).join(', ')} (prefixed with claude. or codex.), ${GLOBAL_SETTINGS.map((setting) => setting.key).join(', ')}.`); }
            out(json ? `${JSON.stringify(entry.value)}\n` : `${entry.key} = ${bold(typeof entry.value === 'object' ? JSON.stringify(entry.value) : String(entry.value))}\n`);
            return 0;
          }
          const state = await client.getConfigState();
          const { config } = await client.patchConfig({ [args[0]]: args.slice(1).join(' ') }, state.revision);
          const entry = listConfig(config).find((candidate) => candidate.key === args[0]);
          out(json ? `${JSON.stringify(entry?.value)}\n` : `${green('✓')} ${args[0]} = ${bold(String(entry?.value))}\n`);
          return 0;
        });
      }
      case 'mcp': {
        // Stdout carries the protocol; whatever else there is to say goes to stderr.
        const connect = () => ServiceClient.connect({ home, client: 'mcp', version: serviceVersion(), subscribe: ['statusChanged', 'configChanged'] });
        try {
          const probe = await connect();
          if (!probe.connected || !(await probe.getConfig()).mcp.enabled) {
            err('The AI Usage MCP server is turned off: its tools answer with that until "ai-usage config mcp.enabled true" (or aiUsage.mcp.enabled in VS Code) turns it on.\n');
          }
          probe.close();
        } catch (error) {
          // Served anyway: the service may come up later, and every tool call tries again and reports.
          err(`${error instanceof Error ? error.message : String(error)}\n`);
        }
        return runMcpStdio({ input: process.stdin, output: process.stdout, version: serviceVersion(), log: (message) => err(`${message}\n`), connect });
      }
      case 'history': {
        const action = rest[0];
        return withClient(home, [], async (client) => {
          if (action === 'path') {
            const info = await client.historyInfo();
            if (json) { printJson(info); return 0; }
            out(`${info.location}${info.enabled ? '' : dim(' (recording is off: history.enabled)')}\n`);
            out(dim(`${info.files.length} month file${info.files.length === 1 ? '' : 's'}, kept ${info.retentionDays} days${info.oldestAt ? `, oldest from ${info.oldestAt.slice(0, 7)}` : ''}\n`));
            return 0;
          }
          if (action === 'export') {
            const kind = rest[1];
            if (kind !== 'readings' && kind !== 'events' && kind !== 'jsonl') { throw new UsageError('Usage: ai-usage history export readings|events|jsonl [file]'); }
            const exported = await client.historyExport(kind);
            const target = rest[2] ?? path.join(os.homedir(), `ai-usage-${kind}-${new Date().toISOString().slice(0, 10)}.${exported.extension}`);
            if (target === '-') { out(exported.text); return 0; }
            fs.writeFileSync(target, exported.text);
            out(`${green('✓')} Exported the usage history ${kind} to ${target}.\n`);
            return 0;
          }
          if (action !== undefined && !/^\d+$/.test(action)) { throw new UsageError(`Unknown history action "${action}": use a number of days, --all, export or path.`); }
          const days = flags.all ? undefined : Number(flags.days ?? action ?? 30);
          if (days !== undefined && !(Number.isFinite(days) && days > 0)) { throw new UsageError('--days expects a positive number.'); }
          const result = await client.historySummary(days);
          if (json) { printJson(result.summary); return 0; }
          out(`${result.markdown}\n`);
          return 0;
        }, flags);
      }
      case 'service': return serviceCommand(home, rest, flags);
      case 'daemon': {
        // Started detached by the autostart or a client: a failure here has no terminal, so it goes to the log.
        if (serviceManuallyStopped(home)) { return 0; }
        try { await runDaemon({ home, foreground: flags.verbose === true }); return 0; }
        catch (error) { new Logger(logFile(home)).log(`fatal: ${error instanceof Error ? error.message : String(error)}`); throw error; }
      }
      case 'log': case 'logs': {
        const lines = Number(flags.lines ?? 50);
        for (const line of Logger.tail(logFile(home), Number.isFinite(lines) ? lines : 50)) { out(`${line}\n`); }
        if (!flags.follow) { return 0; }
        const client = await ServiceClient.connect({ home, client: 'cli-log', version: serviceVersion(), subscribe: ['log'] });
        await new Promise<void>((resolve) => {
          client.on('event', (event: ServiceEvent) => { if (event.event === 'log') { out(`${event.line}\n`); } });
          client.on('close', () => resolve());
          process.once('SIGINT', () => { client.close(); resolve(); });
        });
        return 0;
      }
      default:
        throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
    }
  };
  try {
    return await execute();
  } catch (error) {
    if (error instanceof UsageError) { err(`${error.message}\n`); return 2; }
    if (error instanceof ServiceUnavailableError) {
      err(`${red('✗')} ${error.message}${error.reason === 'not-installed' ? ' Run "ai-usage service install" (or let the VS Code extension install it), or "ai-usage service run" for a foreground service.' : ''}\n`);
      return 1;
    }
    err(`${red('✗')} ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function matches(profile: ProfileView, reference: string): boolean {
  const wanted = reference.trim().toLowerCase();
  const number = /^#?(\d+)$/.exec(wanted);
  return profile.id === reference || profile.name.toLowerCase() === wanted || (number !== null && profile.number === Number(number[1])) || profile.email?.toLowerCase() === wanted;
}

async function serviceCommand(home: string, rest: string[], flags: Flags): Promise<number> {
  const action = rest[0] ?? 'status';
  const log = (message: string) => out(`${dim(message)}\n`);
  switch (action) {
    case 'status': {
      const status = serviceStatus(home);
      if (flags.json) { printJson(status); return 0; }
      out([
        `Home:       ${status.home}`,
        `Installed:  ${status.installed ? `${status.installed.version} at ${status.installed.dir} (node: ${status.installed.node.command})` : 'no'}`,
        `Running:    ${status.running ? green(`yes (pid ${status.pid}, version ${status.runningVersion})`) : yellow('no')}`,
        `Autostart:  ${status.autostart.kind === 'none' ? yellow(`none${status.autostart.detail ? ` (${status.autostart.detail})` : ''}`) : `${status.autostart.kind}, ${status.autostart.registered ? green('registered') : yellow('not registered')}`}`,
        `Command:    ${status.launcher ?? 'not installed'}`,
        ''
      ].join('\n'));
      return 0;
    }
    case 'install': {
      const node = findNode({ fallback: { execPath: process.execPath, electron: Boolean(process.versions.electron) } });
      if (!node) { err(`${red('✗')} No Node.js ${20}+ was found to run the service with. Install Node.js or set AI_USAGE_NODE.\n`); return 1; }
      const result = installService({ home, sourceDir: servicePackageDir(), node, autostart: flags.autostart !== false, log });
      const restarted = await restartService(home);
      out(`${green('✓')} Installed the account service ${result.version} (${restarted.detail}). Autostart: ${result.autostart.ok ? result.autostart.detail : yellow(`not registered: ${result.autostart.detail}`)}.\n`);
      out(`  Command: ${result.launcher}${process.platform === 'win32' ? '' : `\n  Add ${path.dirname(result.launcher)} to your PATH to run "ai-usage" from anywhere.`}\n`);
      return 0;
    }
    case 'uninstall': {
      if (!await confirm('Stop the account service, unregister it and remove the installed package? Profiles and settings are kept.', flags)) { return 1; }
      const result = await uninstallService(home, log);
      out(`${green('✓')} Uninstalled (${result.stopped.detail}; ${result.autostart.detail}).\n`);
      return 0;
    }
    case 'start': { const result = startService(home); out(`${result.ok ? green('✓') : red('✗')} ${result.detail}\n`); return result.ok ? 0 : 1; }
    case 'stop': { const result = await stopService(home); out(`${result.ok ? green('✓') : red('✗')} ${result.detail}\n`); return result.ok ? 0 : 1; }
    case 'restart': { const result = await restartService(home); out(`${result.ok ? green('✓') : red('✗')} ${result.detail}\n`); return result.ok ? 0 : 1; }
    case 'run': {
      fs.rmSync(path.join(home, 'state', 'service-stopped'), { force: true });
      await runDaemon({ home, foreground: true }); return 0;
    }
    case 'path': out(`${launcherPath(home)}\n`); return 0;
    default:
      err(`Unknown service action "${action}": use status, install, uninstall, start, stop, restart or run.\n`);
      return 2;
  }
}
