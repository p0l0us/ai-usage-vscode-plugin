import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceClient } from './client';
import { installDir, launcherDir, processAlive, readServiceInfo } from './paths';
import { compareVersions } from './version';

/**
 * Installs the service package under the service home, registers it to start at login, and starts, stops and
 * removes it. Used by the VS Code extension (which bundles the package) and by `ai-usage service …`. Every
 * platform-specific step reports what it did or why it could not, so a caller can tell the user.
 */

export const MIN_NODE_MAJOR = 20;
const SYSTEMD_UNIT = 'ai-usage.service';
const LAUNCHD_LABEL = 'com.p0l0us.ai-usage';
const WINDOWS_RUN_VALUE = 'AIUsageAccountService';

export type NodeChoice = {
  command: string;
  args: string[];
  /** Extra environment the command needs, such as `ELECTRON_RUN_AS_NODE` for VS Code's own binary. */
  env: Record<string, string>;
  version: string;
  /** Where it was found, for the log. */
  source: string;
};

export type AutostartKind = 'systemd' | 'launchd' | 'windows' | 'none';
export type StepResult = { ok: boolean; detail: string };

export type InstallOptions = {
  home: string;
  /** The service package to install: its package.json, bin/ and out/. */
  sourceDir: string;
  node: NodeChoice;
  /** Register the service to start at login (default true). */
  autostart?: boolean;
  log?: (message: string) => void;
};

export type InstallResult = {
  version: string;
  dir: string;
  launcher: string;
  autostart: { kind: AutostartKind } & StepResult;
};

export type CurrentInstall = {
  version: string;
  dir: string;
  node: Pick<NodeChoice, 'command' | 'args' | 'env'>;
  installedAt: string;
};

export type ServiceStatus = {
  home: string;
  installed?: CurrentInstall;
  running: boolean;
  pid?: number;
  runningVersion?: string;
  autostart: { kind: AutostartKind; registered: boolean; detail?: string };
  launcher?: string;
};

const currentFile = (home: string): string => path.join(installDir(home), 'current.json');
const launchScript = (home: string): string => path.join(installDir(home), 'launch.js');
const hiddenLauncher = (home: string): string => path.join(installDir(home), 'launch-hidden.vbs');
const systemdUnitFile = (): string => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', SYSTEMD_UNIT);
const launchdPlist = (): string => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

export function launcherPath(home: string): string {
  return path.join(launcherDir(home), process.platform === 'win32' ? 'ai-usage.cmd' : 'ai-usage');
}

export function readCurrentInstall(home: string): CurrentInstall | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(currentFile(home), 'utf8')) as Partial<CurrentInstall>;
    if (typeof parsed.version !== 'string' || typeof parsed.dir !== 'string' || !parsed.node) { return undefined; }
    if (!fs.existsSync(path.join(parsed.dir, 'bin', 'ai-usage.js'))) { return undefined; }
    return parsed as CurrentInstall;
  } catch { return undefined; }
}

function run(command: string, args: string[], env?: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, timeout: 20_000 });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? (result.error?.message ?? '') };
}

function nodeVersion(command: string, env: Record<string, string> = {}): string | undefined {
  const result = run(command, ['--version'], env);
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(result.stdout.trim());
  return result.status === 0 && match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

function isFile(candidate: string): boolean {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

/** Newest first: `~/.nvm/versions/node/v24.1.0/bin/node`, … */
function nvmNodes(): string[] {
  const root = path.join(process.env.NVM_DIR || path.join(os.homedir(), '.nvm'), 'versions', 'node');
  try {
    return fs.readdirSync(root).filter((name) => /^v\d+/.test(name))
      .sort((a, b) => compareVersions(b.slice(1), a.slice(1)))
      .map((name) => path.join(root, name, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'));
  } catch { return []; }
}

/**
 * A Node.js of at least version 20 to run the service with: `AI_USAGE_NODE`, `node` on PATH, then common install
 * locations, then the `fallback`, which is how the extension offers VS Code's own runtime when nothing else exists.
 */
export function findNode(options: { fallback?: { execPath: string; electron: boolean }; minMajor?: number } = {}): NodeChoice | undefined {
  const minMajor = options.minMajor ?? MIN_NODE_MAJOR;
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates: Array<{ command: string; env?: Record<string, string>; source: string }> = [];
  if (process.env.AI_USAGE_NODE) { candidates.push({ command: process.env.AI_USAGE_NODE, source: 'AI_USAGE_NODE' }); }
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, exe);
    if (isFile(candidate)) { candidates.push({ command: candidate, source: 'PATH' }); }
  }
  for (const candidate of nvmNodes()) { candidates.push({ command: candidate, source: 'nvm' }); }
  const home = os.homedir();
  for (const candidate of [
    path.join(home, '.volta', 'bin', exe), path.join(home, '.local', 'bin', exe), path.join(home, '.fnm', 'aliases', 'default', 'bin', exe),
    '/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node',
    'C:\\Program Files\\nodejs\\node.exe', path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'nodejs', 'node.exe')
  ]) {
    if (candidate && isFile(candidate)) { candidates.push({ command: candidate, source: 'known location' }); }
  }
  if (options.fallback) {
    candidates.push(options.fallback.electron
      ? { command: options.fallback.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, source: 'the VS Code runtime' }
      : { command: options.fallback.execPath, source: 'the VS Code server runtime' });
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.command}|${candidate.env ? 'electron' : ''}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    const version = nodeVersion(candidate.command, candidate.env);
    if (version && Number(version.split('.')[0]) >= minMajor) {
      return { command: candidate.command, args: [], env: candidate.env ?? {}, version, source: candidate.source };
    }
  }
  return undefined;
}

function copyDir(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) { copyDir(from, to); }
    else if (entry.isFile()) { fs.copyFileSync(from, to); }
  }
}

function quoteSystemd(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function systemdUnitText(home: string, node: Pick<NodeChoice, 'command' | 'args' | 'env'>): string {
  const exec = [node.command, ...node.args, launchScript(home), 'daemon'].map(quoteSystemd).join(' ');
  const environment = Object.entries({ ...node.env, AI_USAGE_HOME: home }).map(([key, value]) => `Environment=${quoteSystemd(`${key}=${value}`)}`).join('\n');
  return [
    '[Unit]', 'Description=AI Usage account service (Claude Code and Codex profiles, keep-alives and rotation)', 'After=network-online.target', '',
    '[Service]', 'Type=simple', `ExecStart=${exec}`, 'Restart=on-failure', 'RestartSec=5', environment, '',
    '[Install]', 'WantedBy=default.target', ''
  ].join('\n');
}

export function launchdPlistText(home: string, node: Pick<NodeChoice, 'command' | 'args' | 'env'>): string {
  const args = [node.command, ...node.args, launchScript(home), 'daemon'].map((value) => `    <string>${xml(value)}</string>`).join('\n');
  const env = Object.entries({ ...node.env, AI_USAGE_HOME: home, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' })
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', '<dict>',
    `  <key>Label</key>\n  <string>${LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>\n  <array>\n${args}\n  </array>`,
    `  <key>EnvironmentVariables</key>\n  <dict>\n${env}\n  </dict>`,
    '  <key>RunAtLoad</key>\n  <true/>',
    // Restart after a crash, but stay stopped after `ai-usage service stop` (a clean exit).
    '  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>',
    `  <key>StandardOutPath</key>\n  <string>${xml(path.join(home, 'launchd.log'))}</string>`,
    `  <key>StandardErrorPath</key>\n  <string>${xml(path.join(home, 'launchd.log'))}</string>`,
    '</dict>', '</plist>', ''
  ].join('\n');
}

/** A VBScript that starts the daemon without a console window; the Run registry key points at it. */
export function windowsLauncherText(home: string, node: Pick<NodeChoice, 'command' | 'args' | 'env'>): string {
  const vb = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const command = [node.command, ...node.args, launchScript(home), 'daemon'].map((value) => (/\s/.test(value) || value.endsWith('.js') ? `"${value.replace(/"/g, '')}"` : value)).join(' ');
  const env = Object.entries({ ...node.env, AI_USAGE_HOME: home }).map(([key, value]) => `env(${vb(key)}) = ${vb(value)}`).join('\r\n');
  return ['Set shell = CreateObject("WScript.Shell")', 'Set env = shell.Environment("PROCESS")', env, `shell.Run ${vb(command)}, 0, False`, ''].join('\r\n');
}

export function launchScriptText(): string {
  return [
    '// Starts the installed AI Usage service package named in current.json; `ai-usage service install` replaces both.',
    "'use strict';",
    "const path = require('path');",
    "const current = require('./current.json');",
    "require(path.join(current.dir, 'bin', 'ai-usage.js'));",
    ''
  ].join('\n');
}

export function autostartKind(): AutostartKind {
  if (process.platform === 'linux') { return systemdUserAvailable() ? 'systemd' : 'none'; }
  if (process.platform === 'darwin') { return 'launchd'; }
  if (process.platform === 'win32') { return 'windows'; }
  return 'none';
}

let systemdChecked: boolean | undefined;
function systemdUserAvailable(): boolean {
  if (systemdChecked === undefined) {
    const result = run('systemctl', ['--user', 'show-environment']);
    systemdChecked = result.status === 0;
  }
  return systemdChecked;
}

function autostartFileMatches(file: string, home: string): boolean {
  try { return fs.readFileSync(file, 'utf8').includes(launchScript(home)); }
  catch { return false; }
}

function systemdRegistered(home: string): boolean {
  return autostartFileMatches(systemdUnitFile(), home);
}

function launchdRegistered(home: string): boolean {
  return autostartFileMatches(launchdPlist(), home);
}

function windowsRegistered(home: string): boolean {
  if (process.platform !== 'win32') { return false; }
  const result = run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', WINDOWS_RUN_VALUE]);
  return result.status === 0 && result.stdout.toLowerCase().includes(hiddenLauncher(home).toLowerCase());
}

/** Registers the installed service to start at login. */
export function registerAutostart(home: string, node: Pick<NodeChoice, 'command' | 'args' | 'env'>, log: (message: string) => void = () => undefined): { kind: AutostartKind } & StepResult {
  const kind = autostartKind();
  try {
    if (kind === 'systemd') {
      const unit = systemdUnitFile();
      fs.mkdirSync(path.dirname(unit), { recursive: true });
      fs.writeFileSync(unit, systemdUnitText(home, node));
      const reload = run('systemctl', ['--user', 'daemon-reload']);
      if (reload.status !== 0) { return { kind, ok: false, detail: `systemctl --user daemon-reload failed: ${reload.stderr.trim()}` }; }
      const enable = run('systemctl', ['--user', 'enable', SYSTEMD_UNIT]);
      if (enable.status !== 0) { return { kind, ok: false, detail: `systemctl --user enable failed: ${enable.stderr.trim()}` }; }
      // Without lingering, the user's services stop with the last login session; best effort, it may need a password.
      const linger = run('loginctl', ['enable-linger']);
      log(`autostart: systemd user unit ${unit} enabled${linger.status === 0 ? ', lingering enabled' : ` (loginctl enable-linger failed: ${linger.stderr.trim() || 'not permitted'}; the service then runs only while you are logged in)`}`);
      return { kind, ok: true, detail: `systemd user unit ${SYSTEMD_UNIT}${linger.status === 0 ? '' : '; run "loginctl enable-linger" to keep it running after you log out'}` };
    }
    if (kind === 'launchd') {
      const plist = launchdPlist();
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`]);
      fs.writeFileSync(plist, launchdPlistText(home, node));
      const bootstrap = run('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, plist]);
      if (bootstrap.status !== 0) {
        const load = run('launchctl', ['load', '-w', plist]);
        if (load.status !== 0) { return { kind, ok: false, detail: `launchctl could not load ${plist}: ${(bootstrap.stderr || load.stderr).trim()}` }; }
      }
      log(`autostart: launchd agent ${plist} loaded`);
      return { kind, ok: true, detail: `launchd agent ${LAUNCHD_LABEL}` };
    }
    if (kind === 'windows') {
      const vbs = hiddenLauncher(home);
      fs.writeFileSync(vbs, windowsLauncherText(home, node));
      const add = run('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', WINDOWS_RUN_VALUE, '/t', 'REG_SZ', '/d', `wscript.exe //B "${vbs}"`, '/f']);
      if (add.status !== 0) { return { kind, ok: false, detail: `could not add the Run registry value: ${add.stderr.trim()}` }; }
      log(`autostart: Run registry value ${WINDOWS_RUN_VALUE} points at ${vbs}`);
      return { kind, ok: true, detail: 'Run registry key (starts at sign-in)' };
    }
    return { kind, ok: false, detail: process.platform === 'linux' ? 'no systemd user manager is available; the service is started by the extension and by the ai-usage command when needed' : 'no autostart mechanism for this platform' };
  } catch (error) {
    return { kind, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function unregisterAutostart(home: string, log: (message: string) => void = () => undefined): StepResult {
  try {
    if (process.platform === 'linux' && systemdRegistered(home)) {
      run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
      fs.rmSync(systemdUnitFile(), { force: true });
      run('systemctl', ['--user', 'daemon-reload']);
      log('autostart: systemd user unit removed');
      return { ok: true, detail: 'systemd user unit removed' };
    }
    if (process.platform === 'darwin' && launchdRegistered(home)) {
      run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`]);
      fs.rmSync(launchdPlist(), { force: true });
      log('autostart: launchd agent removed');
      return { ok: true, detail: 'launchd agent removed' };
    }
    if (process.platform === 'win32') {
      run('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', WINDOWS_RUN_VALUE, '/f']);
      fs.rmSync(hiddenLauncher(home), { force: true });
      log('autostart: Run registry value removed');
      return { ok: true, detail: 'Run registry value removed' };
    }
    return { ok: true, detail: 'nothing was registered' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Copies the package to `<home>/service/<version>`, points `current.json` and the launchers at it, and registers
 * autostart. The running daemon, if any, keeps running the old files; call `restartService` afterwards.
 */
export function installService(options: InstallOptions): InstallResult {
  const log = options.log ?? (() => undefined);
  const pkg = JSON.parse(fs.readFileSync(path.join(options.sourceDir, 'package.json'), 'utf8')) as { version?: string };
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  const root = installDir(options.home);
  const dir = path.join(root, version);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['package.json', 'README.md']) {
    const file = path.join(options.sourceDir, name);
    if (fs.existsSync(file)) { fs.copyFileSync(file, path.join(dir, name)); }
  }
  for (const name of ['bin', 'out']) { copyDir(path.join(options.sourceDir, name), path.join(dir, name)); }
  fs.writeFileSync(launchScript(options.home), launchScriptText());
  const current: CurrentInstall = { version, dir, node: { command: options.node.command, args: options.node.args, env: options.node.env }, installedAt: new Date().toISOString() };
  fs.writeFileSync(currentFile(options.home), `${JSON.stringify(current, null, 2)}\n`);
  const launcher = writeLauncher(options.home, current.node);
  log(`installed the account service ${version} to ${dir} (node ${options.node.version} from ${options.node.source}); launcher ${launcher}`);
  // Older installed versions are left behind only while a daemon may still run from them; the restart cleans up.
  const autostart = options.autostart === false ? { kind: 'none' as AutostartKind, ok: false, detail: 'not requested' } : registerAutostart(options.home, current.node, log);
  return { version, dir, launcher, autostart };
}

function writeLauncher(home: string, node: Pick<NodeChoice, 'command' | 'args' | 'env'>): string {
  fs.mkdirSync(launcherDir(home), { recursive: true, mode: 0o700 });
  const launcher = launcherPath(home);
  if (process.platform === 'win32') {
    const env = Object.entries({ ...node.env, AI_USAGE_HOME: home }).map(([key, value]) => `set "${key}=${value}"`).join('\r\n');
    const command = [node.command, ...node.args, launchScript(home)].map((value) => `"${value}"`).join(' ');
    fs.writeFileSync(launcher, ['@echo off', 'setlocal', env, `${command} %*`, ''].join('\r\n'));
  } else {
    const env = Object.entries({ ...node.env, AI_USAGE_HOME: home }).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('\n');
    const command = [node.command, ...node.args, launchScript(home)].map(shellQuote).join(' ');
    fs.writeFileSync(launcher, ['#!/bin/sh', env, `exec ${command} "$@"`, ''].join('\n'), { mode: 0o755 });
  }
  return launcher;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Removes versions of the installed package other than the current one; safe once the daemon was restarted. */
export function pruneOldInstalls(home: string): void {
  const current = readCurrentInstall(home);
  const root = installDir(home);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    if (entry.isDirectory() && dir !== current?.dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* In use; next time. */ }
    }
  }
}

function spawnDetached(command: string, args: string[], env: Record<string, string>): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', env: { ...process.env, ...env }, windowsHide: true });
  child.unref();
}

/** Starts the installed daemon through the registered autostart, or detached when there is none. */
export function startService(home: string): StepResult {
  const current = readCurrentInstall(home);
  if (!current) { return { ok: false, detail: 'the account service is not installed' }; }
  const env = { ...current.node.env, AI_USAGE_HOME: home };
  if (process.platform === 'linux' && systemdRegistered(home) && systemdUserAvailable()) {
    const result = run('systemctl', ['--user', 'start', SYSTEMD_UNIT]);
    if (result.status === 0) { return { ok: true, detail: 'started through systemd' }; }
  }
  if (process.platform === 'darwin' && launchdRegistered(home)) {
    const result = run('launchctl', ['kickstart', `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`]);
    if (result.status === 0) { return { ok: true, detail: 'started through launchd' }; }
  }
  if (process.platform === 'win32' && fs.existsSync(hiddenLauncher(home))) {
    spawnDetached('wscript.exe', ['//B', hiddenLauncher(home)], env);
    return { ok: true, detail: 'started hidden' };
  }
  spawnDetached(current.node.command, [...current.node.args, launchScript(home), 'daemon'], env);
  return { ok: true, detail: 'started detached' };
}

/** Asks the running daemon to stop, then waits for its process to go; a stubborn one gets SIGTERM. */
export async function stopService(home: string, waitMs = 8_000): Promise<StepResult> {
  const info = readServiceInfo(home);
  const alive = info ? processAlive(info.pid) : false;
  let asked = false;
  try {
    const client = await ServiceClient.connect({ home, client: 'installer', timeoutMs: 2_000 });
    await client.shutdown().catch(() => undefined);
    client.close();
    asked = true;
  } catch { /* Not answering; fall through to the service manager and the pid. */ }
  if (process.platform === 'linux' && systemdRegistered(home) && systemdUserAvailable()) { run('systemctl', ['--user', 'stop', SYSTEMD_UNIT]); }
  if (!info || !alive) { return { ok: true, detail: asked ? 'stopped' : 'was not running' }; }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!processAlive(info.pid)) { return { ok: true, detail: 'stopped' }; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  try { process.kill(info.pid, 'SIGTERM'); } catch { /* Gone meanwhile. */ }
  await new Promise((resolve) => setTimeout(resolve, 500));
  return processAlive(info.pid) ? { ok: false, detail: `process ${info.pid} did not stop` } : { ok: true, detail: 'stopped' };
}

export async function restartService(home: string): Promise<StepResult> {
  const stopped = await stopService(home);
  if (!stopped.ok) { return stopped; }
  const started = startService(home);
  if (started.ok) { pruneOldInstalls(home); }
  return started;
}

/** Stops and unregisters the service and removes the installed package and launcher; data files stay. */
export async function uninstallService(home: string, log: (message: string) => void = () => undefined): Promise<{ stopped: StepResult; autostart: StepResult }> {
  const stopped = await stopService(home);
  const autostart = unregisterAutostart(home, log);
  fs.rmSync(installDir(home), { recursive: true, force: true });
  fs.rmSync(launcherDir(home), { recursive: true, force: true });
  log('uninstalled the account service package and launcher; profiles, configuration and readings were kept');
  return { stopped, autostart };
}

export function serviceStatus(home: string): ServiceStatus {
  const installed = readCurrentInstall(home);
  const info = readServiceInfo(home);
  const running = Boolean(info && processAlive(info.pid));
  const kind = autostartKind();
  const registered = kind === 'systemd' ? systemdRegistered(home) : kind === 'launchd' ? launchdRegistered(home) : kind === 'windows' ? windowsRegistered(home) : false;
  return {
    home, installed, running, pid: running ? info?.pid : undefined, runningVersion: running ? info?.version : undefined,
    autostart: { kind, registered, detail: kind === 'none' && process.platform === 'linux' ? 'no systemd user manager' : undefined },
    launcher: installed ? launcherPath(home) : undefined
  };
}
