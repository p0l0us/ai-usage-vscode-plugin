import { execFile } from 'child_process';

/**
 * Detection of Codex `app-server` processes that were started before an AI Usage profile switch.
 *
 * The Codex VS Code extension spawns one `codex … app-server` per extension host from `activate()` and never
 * respawns it. Codex reloads `auth.json` on the request path, so open chats follow a switch on their next turn,
 * but a process that predates the switch may keep failing in its background paths with revoked tokens. Such a
 * process is recognised purely by its start time; nothing here reads Codex's databases or kills anything.
 */

export type ProcessInfo = {
  pid: number;
  ppid: number;
  /** Start time in milliseconds since the epoch, derived from the elapsed time the OS reports. */
  startedAt: number;
  command: string;
};

/** Process start is only known to the second; a process started this close to the switch is treated as fresh. */
const START_TIME_GRACE_MS = 2_000;

/** `ps` elapsed time: `[[dd-]hh:]mm:ss`. */
export function parseElapsedSeconds(value: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/** Parses `ps -eo pid=,ppid=,etime=,args=` output. */
export function parsePsListing(text: string, now = Date.now()): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const elapsed = parseElapsedSeconds(match[3]);
    if (elapsed === undefined) {
      continue;
    }
    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), startedAt: now - elapsed * 1000, command: match[4].trim() });
  }
  return processes;
}

type WindowsProcess = { ProcessId?: number; ParentProcessId?: number; CreationDate?: string | null; CommandLine?: string | null };

/** Parses the JSON produced by the PowerShell query in `listProcesses` (a single object or an array). */
export function parseWindowsListing(json: string): ProcessInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as WindowsProcess[];
  const processes: ProcessInfo[] = [];
  for (const row of rows) {
    if (!row || typeof row.ProcessId !== 'number' || typeof row.ParentProcessId !== 'number' || !row.CreationDate) {
      continue;
    }
    const startedAt = Date.parse(row.CreationDate);
    if (Number.isNaN(startedAt)) {
      continue;
    }
    processes.push({ pid: row.ProcessId, ppid: row.ParentProcessId, startedAt, command: row.CommandLine ?? '' });
  }
  return processes;
}

/**
 * True for a Codex extension's long-running `app-server`. AI Usage's own short-lived servers (usage checks,
 * keep-alive probes, switch verification) pass `cli_auth_credentials_store` on the command line and are excluded.
 */
export function isCodexAppServer(command: string): boolean {
  return /(^|[\\/\s"'])codex(\.exe|\.cmd)?["']?(\s|$)/i.test(command) && /(^|\s)app-server(\s|$)/.test(command) && !command.includes('cli_auth_credentials_store');
}

/** Codex app-servers owned by `parentPid` that were already running when the switch happened. */
export function staleCodexProcesses(processes: ProcessInfo[], parentPid: number, switchedAt: number): ProcessInfo[] {
  return processes.filter((process) =>
    process.ppid === parentPid && isCodexAppServer(process.command) && process.startedAt < switchedAt - START_TIME_GRACE_MS);
}

/**
 * A per-window app-server a VS Code extension host started from the extension's own directory. The extension never
 * respawns it, so ending it would break that window's Codex chat; the restart hint covers those.
 */
export function isExtensionOwnedCodexAppServer(command: string): boolean {
  return /[\\/]extensions[\\/][^\\/]+[\\/]/i.test(command);
}

/** The code-mode host a Codex app-server daemon starts beside itself; it goes with the daemon. */
export function isCodexDaemonHelper(command: string): boolean {
  return /(^|[\\/\s"'])codex-code-mode-host(\.exe)?["']?(\s|$)/i.test(command);
}

/**
 * Codex app-servers of this user that outlived a login change at `changedAt` and that Codex starts again by itself
 * with the current login: the shared `app-server daemon`, its code-mode host, and the VS Code agent host's SDK
 * server. Extension-owned servers and AI Usage's own short-lived ones are left out.
 */
export function staleCodexDaemons(processes: ProcessInfo[], changedAt: number, ownPid = process.pid): ProcessInfo[] {
  return processes.filter((process) => process.pid !== ownPid && process.startedAt < changedAt - START_TIME_GRACE_MS &&
    ((isCodexAppServer(process.command) && !isExtensionOwnedCodexAppServer(process.command)) || isCodexDaemonHelper(process.command)));
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(String(stdout));
      }
    });
  });
}

/** Lists processes with their parent and start time; POSIX via `ps`, Windows via CIM. */
export async function listProcesses(now = Date.now()): Promise<ProcessInfo[]> {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,' +
      "@{n='CreationDate';e={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } }} | ConvertTo-Json -Compress";
    return parseWindowsListing(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
  }
  return parsePsListing(await run('ps', ['-eo', 'pid=,ppid=,etime=,args=']), now);
}

/** This user's processes on POSIX (`ps -u`); on Windows every process the query can see. */
export async function listOwnProcesses(now = Date.now()): Promise<ProcessInfo[]> {
  if (process.platform === 'win32') { return listProcesses(now); }
  const uid = process.getuid?.();
  return parsePsListing(await run('ps', uid === undefined ? ['-eo', 'pid=,ppid=,etime=,args='] : ['-u', String(uid), '-o', 'pid=,ppid=,etime=,args=']), now);
}

export type Signaller = (pid: number, signal: NodeJS.Signals | 0) => void;

/**
 * Ends a process: TERM, then KILL once `graceMs` has passed and it is still there. Resolves to whether it is gone;
 * a process that is not ours (EPERM) stays and reports false, one already gone reports true.
 */
export async function terminateProcess(pid: number, graceMs = 3_000, signal: Signaller = (target, sig) => { process.kill(target, sig); },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<boolean> {
  const alive = () => { try { signal(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
  if (process.platform === 'win32') {
    try { await run('taskkill', ['/PID', String(pid), '/T', '/F']); } catch { /* Gone already, or not ours. */ }
    return !alive();
  }
  try { signal(pid, 'SIGTERM'); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!alive()) return true;
    await sleep(100);
  }
  if (alive()) {
    try { signal(pid, 'SIGKILL'); } catch { /* Raced with its exit. */ }
    await sleep(100);
  }
  return !alive();
}

export type StaleDaemonSweep = { ended: ProcessInfo[]; kept: ProcessInfo[] };

/** Finds this user's stale Codex daemons (see `staleCodexDaemons`) and ends them; `kept` names those that would not go. */
export async function terminateStaleCodexDaemons(changedAt: number,
  deps: { list?: () => Promise<ProcessInfo[]>; terminate?: (pid: number) => Promise<boolean> } = {}): Promise<StaleDaemonSweep> {
  let processes: ProcessInfo[];
  try { processes = await (deps.list ?? listOwnProcesses)(); } catch { return { ended: [], kept: [] }; }
  const ended: ProcessInfo[] = [], kept: ProcessInfo[] = [];
  for (const stale of staleCodexDaemons(processes, changedAt)) {
    (await (deps.terminate ?? terminateProcess)(stale.pid) ? ended : kept).push(stale);
  }
  return { ended, kept };
}

/**
 * Codex app-servers of this extension host (extensions run inside it, so its pid is `process.pid`) that started
 * before `switchedAt`. Enumeration failures are reported as an empty list; the caller treats that as "unknown".
 */
export async function findStaleCodexProcesses(switchedAt: number, parentPid = process.pid): Promise<ProcessInfo[]> {
  try {
    return staleCodexProcesses(await listProcesses(), parentPid, switchedAt);
  } catch {
    return [];
  }
}
