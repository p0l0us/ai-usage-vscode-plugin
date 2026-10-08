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
