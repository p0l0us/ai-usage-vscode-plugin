import * as readline from 'readline';
import { readableProblem } from './accountProbe';
import type { ServiceClient } from './client';
import { formatResetRemaining } from './live';
import { PROVIDERS, TITLES } from './profileStore';
import type { ProviderView, ServiceEvent, Snapshot } from './protocol';
import type { AuthProvider } from './authFiles';

/**
 * `ai-usage top`: a small full-screen view of both services that follows the service's events. Deliberately
 * plain: one table per view, a few keys, no dependencies.
 */

const REFRESH_MS = 5_000;

const esc = (code: string) => `\x1b[${code}`;
const style = (code: string, text: string) => `${esc(`${code}m`)}${text}${esc('0m')}`;
const bold = (text: string) => style('1', text);
const dim = (text: string) => style('2', text);
const inverse = (text: string) => style('7', text);
const green = (text: string) => style('32', text);
const yellow = (text: string) => style('33', text);
const red = (text: string) => style('31', text);
const width = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '').length;

function percent(window: { usedPercent: number; resetsAt?: string }, now: Date): string {
  const reset = formatResetRemaining(window.resetsAt ? new Date(window.resetsAt) : undefined, now);
  const text = `${Math.round(window.usedPercent)}%${reset ? ` (${reset})` : ''}`;
  return window.usedPercent >= 95 ? red(text) : window.usedPercent >= 80 ? yellow(text) : text;
}

function clock(iso?: string): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

function pad(text: string, length: number): string {
  const missing = length - width(text);
  return missing > 0 ? text + ' '.repeat(missing) : text;
}

function truncate(text: string, length: number): string {
  if (width(text) <= length) { return text; }
  // Cut plain text only; styled cells are short.
  return `${text.slice(0, Math.max(0, length - 1))}…`;
}

export function renderRows(view: ProviderView, selected: number, now: Date): string[] {
  const labels = ['5h', '7d'];
  const header = ['#', 'Profile', 'Email', ...labels, 'Other', 'Checked', 'Problem'];
  const rows = view.profiles.map((profile) => {
    const windows = profile.usage?.windows ?? [];
    const cells = labels.map((label) => { const window = windows.find((candidate) => candidate.label === label); return window ? percent(window, now) : dim('–'); });
    const other = windows.filter((window) => !labels.includes(window.label)).map((window) => `${window.label} ${percent(window, now)}`).join(' ');
    const problem = profile.loginProblem ? yellow(readableProblem(profile.loginProblem).split('. ')[0])
      : profile.limit.readOnly ? red('at its limit') : profile.problems[0] ? yellow(profile.problems[0].label) : '';
    return [String(profile.number), `${profile.active ? green('● ') : '  '}${profile.active ? bold(profile.name) : profile.name}`, profile.email ?? dim('–'), ...cells, other, clock(profile.checkedAt), problem];
  });
  const all = [header, ...rows];
  const widths = header.map((_, column) => Math.min(40, Math.max(...all.map((row) => width(row[column] ?? '')))));
  const line = (row: string[]) => row.map((cell, column) => pad(truncate(cell, widths[column]), widths[column])).join('  ');
  return [dim(line(header)), ...rows.map((row, index) => (index === selected ? inverse(line(row)) : line(row)))];
}

export type TopOptions = {
  connect: () => Promise<ServiceClient>;
  /** Injected by tests; defaults to the real terminal. */
  io?: { write(text: string): void; columns(): number; rows(): number };
};

/** Runs until `q`; resolves with the exit code. */
export async function runTop(options: TopOptions): Promise<number> {
  const out = options.io ?? { write: (text: string) => { process.stdout.write(text); }, columns: () => process.stdout.columns || 100, rows: () => process.stdout.rows || 30 };
  let client = await options.connect();
  let snapshot: Snapshot | undefined;
  let provider: AuthProvider = 'claude';
  const selected: Record<AuthProvider, number> = { claude: 0, codex: 0 };
  const events: string[] = [];
  let message = '';
  let busy = false;
  let stopped = false;
  let refreshTimer: NodeJS.Timeout | undefined;
  let pendingRefresh: NodeJS.Timeout | undefined;

  const note = (text: string) => {
    events.push(`${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}  ${text}`);
    if (events.length > 8) { events.shift(); }
  };

  const draw = () => {
    if (stopped) { return; }
    const now = new Date();
    const lines: string[] = [];
    const columns = out.columns();
    const rows = out.rows();
    if (!snapshot) {
      lines.push(bold('AI Usage'), '', dim('waiting for the service…'));
    } else {
      const service = snapshot.service;
      const tabs = PROVIDERS.map((key, index) => (key === provider ? inverse(` ${index + 1} ${TITLES[key]} `) : dim(` ${index + 1} ${TITLES[key]} `))).join(' ');
      lines.push(`${bold('AI Usage')} ${dim(`service ${service.version} · pid ${service.pid} · ${service.clients} client${service.clients === 1 ? '' : 's'}`)}  ${tabs}  ${dim(now.toLocaleTimeString())}`);
      const view = snapshot.providers[provider];
      const active = view.profiles.find((profile) => profile.active);
      lines.push(`${bold(view.title)}  active: ${active ? `${bold(active.name)}${active.email ? ` (${active.email})` : ''}` : dim('none')}${view.nativeUnsaved ? yellow('  native login not saved') : ''}  ·  keep-alive ${view.keepAlive ? green('on') : dim('off')}  ·  rotation ${view.autoRotate ? green(`on (${view.strategySummary})`) : dim('off')}${view.checkingActive ? dim('  · checking the active account') : ''}`);
      lines.push('');
      if (view.profiles.length) { lines.push(...renderRows(view, selected[provider], now)); }
      else { lines.push(dim('  no saved profiles – save one with: ai-usage save ' + provider + ' <name>')); }
      lines.push('');
      if (events.length) { lines.push(dim('Events')); lines.push(...events.map((event) => `  ${event}`)); lines.push(''); }
    }
    const footer = `${busy ? yellow('working… ') : ''}${message}`;
    const keys = dim('↑↓ select · Enter switch · k keep-alive · K all · r rotate now · e keep-alive on/off · o rotation on/off · 1/2 service · q quit');
    while (lines.length < rows - 2) { lines.push(''); }
    const body = lines.slice(0, Math.max(0, rows - 2));
    out.write(esc('H') + [...body, footer, keys].map((line) => truncate(line, columns) + esc('K')).join('\n') + esc('J'));
  };

  const refresh = async () => {
    try {
      snapshot = await client.snapshot();
      for (const key of PROVIDERS) { selected[key] = Math.min(selected[key], Math.max(0, snapshot.providers[key].profiles.length - 1)); }
    } catch (error) {
      message = red(error instanceof Error ? error.message : String(error));
    }
    draw();
  };
  const scheduleRefresh = () => {
    if (pendingRefresh) { return; }
    pendingRefresh = setTimeout(() => { pendingRefresh = undefined; void refresh(); }, 150);
  };

  const attach = (target: ServiceClient) => {
    target.on('event', (event: ServiceEvent) => {
      switch (event.event) {
        case 'activated': note(`${TITLES[event.provider]}: ${event.automatic ? 'rotated' : 'switched'} to “${event.name}”${event.level !== 'info' ? ` – ${event.message}` : ''}`); scheduleRefresh(); break;
        case 'accountProblem': note(`${TITLES[event.provider]}: “${event.name}” ${event.revoked ? 'needs a new sign-in' : 'failed its keep-alive'}: ${event.readable}`); scheduleRefresh(); break;
        case 'noCandidate': note(`${TITLES[event.provider]}: not rotating, ${event.detail}`); break;
        case 'notice': note(event.message); break;
        case 'stateChanged': case 'configChanged': scheduleRefresh(); break;
        default: break;
      }
    });
    target.on('close', () => {
      if (stopped) { return; }
      message = yellow('the service connection closed; reconnecting…');
      draw();
      const retry = async () => {
        while (!stopped) {
          try { client = await options.connect(); attach(client); message = ''; await refresh(); return; }
          catch { await new Promise((resolve) => setTimeout(resolve, 2_000)); }
        }
      };
      void retry();
    });
  };
  attach(client);

  const act = async (label: string, action: () => Promise<string>) => {
    if (busy) { return; }
    busy = true;
    message = dim(label);
    draw();
    try { message = await action(); }
    catch (error) { message = red(error instanceof Error ? error.message : String(error)); }
    busy = false;
    await refresh();
  };

  const current = () => snapshot?.providers[provider].profiles[selected[provider]];

  const onKey = (_text: string | undefined, key: readline.Key) => {
    if (!key) { return; }
    if (key.name === 'q' || (key.ctrl && key.name === 'c') || key.name === 'escape') { finish(); return; }
    const view = snapshot?.providers[provider];
    const count = view?.profiles.length ?? 0;
    if (key.name === '1' || key.name === '2' || key.name === 'tab' || key.name === 'left' || key.name === 'right') {
      provider = key.name === '1' ? 'claude' : key.name === '2' ? 'codex' : provider === 'claude' ? 'codex' : 'claude';
      draw(); return;
    }
    if (key.name === 'up') { selected[provider] = Math.max(0, selected[provider] - 1); draw(); return; }
    if (key.name === 'down') { selected[provider] = Math.min(Math.max(0, count - 1), selected[provider] + 1); draw(); return; }
    const profile = current();
    if (key.name === 'return' && profile) {
      void act(`switching ${TITLES[provider]} to “${profile.name}”…`, async () => {
        const result = await client.activate(provider, profile.id);
        return result.level === 'info' ? green(result.message) : yellow(result.message);
      });
      return;
    }
    if (key.sequence === 'k' && profile) {
      void act(`sending the ${TITLES[provider]} keep-alive to “${profile.name}”…`, async () => {
        const result = await client.keepAliveNow(provider, profile.id);
        if (result.keepAliveError) { return yellow(`keep-alive failed for “${profile.name}”: ${readableProblem(result.keepAliveError)}`); }
        return result.usage ? green(`keep-alive completed for “${profile.name}”`) : yellow(`keep-alive completed for “${profile.name}”, usage not read${result.usageError ? `: ${readableProblem(result.usageError)}` : ''}`);
      });
      return;
    }
    if (key.sequence === 'K' && view) {
      void act(`sending the ${TITLES[provider]} keep-alive to all ${view.profiles.length} accounts…`, async () => {
        let failed = 0;
        for (const [index, target] of view.profiles.entries()) {
          if (index > 0) { await new Promise((resolve) => setTimeout(resolve, 3_000)); }
          message = dim(`keep-alive ${index + 1}/${view.profiles.length}: “${target.name}”…`); draw();
          const result = await client.keepAliveNow(provider, target.id).catch(() => ({ keepAliveError: 'failed' }));
          if (result.keepAliveError || !('usage' in result && result.usage)) { failed++; }
        }
        return failed ? yellow(`keep-alives sent, ${failed} of ${view.profiles.length} reported a problem`) : green(`keep-alives sent to ${view.profiles.length} accounts`);
      });
      return;
    }
    if (key.sequence === 'r') {
      void act(`running a ${TITLES[provider]} rotation sweep…`, async () => {
        const result = await client.rotateNow(provider);
        return result.switched ? green(`rotated to “${result.activeProfileName}”`) : yellow(`not rotated: ${result.reason}`);
      });
      return;
    }
    if ((key.sequence === 'e' || key.sequence === 'o') && snapshot) {
      const setting = key.sequence === 'e' ? 'keepAlive.enabled' : 'autoRotate.enabled';
      const value = !(key.sequence === 'e' ? snapshot.config[provider].keepAlive.enabled : snapshot.config[provider].autoRotate.enabled);
      void act(`turning ${TITLES[provider]} ${key.sequence === 'e' ? 'keep-alive' : 'rotation'} ${value ? 'on' : 'off'}…`, async () => {
        await client.setConfig({ [`${provider}.${setting}`]: value });
        return green(`${TITLES[provider]} ${key.sequence === 'e' ? 'keep-alive' : 'rotation'} ${value ? 'on' : 'off'}`);
      });
    }
  };

  let finish: () => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    finish = () => {
      if (stopped) { return; }
      stopped = true;
      if (refreshTimer) { clearInterval(refreshTimer); }
      if (pendingRefresh) { clearTimeout(pendingRefresh); }
      process.stdin.off('keypress', onKey);
      if (process.stdin.isTTY) { process.stdin.setRawMode(false); }
      process.stdin.pause();
      out.write(esc('?25h') + esc('?1049l'));
      client.close();
      resolve(0);
    };
  });

  out.write(esc('?1049h') + esc('?25l') + esc('2J'));
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) { process.stdin.setRawMode(true); }
  process.stdin.resume();
  process.stdin.on('keypress', onKey);
  process.stdout.on('resize', draw);
  refreshTimer = setInterval(() => void refresh(), REFRESH_MS);
  await refresh();
  return done;
}
