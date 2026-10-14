import type { ActivationChange, AuthProvider } from '../service/out';

/** Last Codex profile switch, shared by every window so each can check its own Codex process (non-secret). */
export const CODEX_SWITCH_KEY = 'aiUsage.codexSwitch.v1';
/** `switchedAt` of the switch this window has already warned about; at most one warning per switch per window. */
export const CODEX_SWITCH_NOTIFIED_KEY = 'aiUsage.codexSwitchNotified.v1';
export type CodexSwitchRecord = { switchedAt: number; profileName: string };

/**
 * Claude Code re-reads its credential file, so a switch reaches open chats by itself. Codex's app-server does
 * not, and only a real account change may reset the baseline its stale-process check measures against: saving
 * or re-selecting the active login starts nothing on a new account and would flag processes that are fine.
 */
export function recordsCodexSwitch(provider: AuthProvider, change: ActivationChange): boolean {
  return provider === 'codex' && change.accountChanged;
}

export function codexSwitchRecord(profileName: string | undefined, now: number): CodexSwitchRecord {
  return { switchedAt: now, profileName: profileName ?? 'the selected profile' };
}

export function staleCodexMessage(profileName: string): string {
  return `Codex switched to “${profileName}”, but this window's Codex extension started before the switch and keeps the previous login; its chats will fail until extensions restart. Restart extensions to use the new login in Codex here.`;
}

/** What the stale-process warning needs from its window; tests pass fakes. */
export type StaleCodexHost = {
  /** `aiUsage.codex.switchRestartHint` */
  hintEnabled: () => boolean;
  /** The account proxy is active: chats follow a switch by themselves. */
  proxyActive: () => boolean;
  record: () => CodexSwitchRecord | undefined;
  notified: () => number | undefined;
  markNotified: (switchedAt: number) => PromiseLike<void>;
  /** The Codex processes of this window started before the switch. */
  findStale: (record: CodexSwitchRecord) => Promise<Array<{ pid: number }>>;
  log: (message: string) => void;
  warn: (message: string, ...actions: string[]) => PromiseLike<string | undefined>;
  restartExtensionHost: () => PromiseLike<unknown>;
};

/**
 * Codex re-reads auth.json when a turn starts, so running chats follow a switch by themselves. A Codex
 * `app-server` started before the switch may still hold revoked tokens in its background paths, and the Codex
 * extension never respawns it; offer an extension-host restart once per switch in each affected window. The offer
 * is opt-in (`aiUsage.codex.switchRestartHint`) because the warning interrupts every window holding such a process.
 */
export async function warnAboutStaleCodexProcesses(host: StaleCodexHost): Promise<void> {
  // Verified against Codex 0.154.0: a running app-server keeps its login in memory. When auth.json changes
  // underneath it, its next turn fails with "signed in to another account" instead of adopting the new login,
  // and the Codex extension never respawns the process. Restarting the extension host is the only repair.
  if (!host.hintEnabled()) {
    return;
  }
  // With the account proxy, chats follow the switch on their next turn; a restart would repair nothing.
  if (host.proxyActive()) {
    return;
  }
  const record = host.record();
  if (!record || host.notified() === record.switchedAt) {
    return;
  }
  const stale = await host.findStale(record);
  if (!stale.length || host.notified() === record.switchedAt) {
    return;
  }
  await host.markNotified(record.switchedAt);
  host.log(`codex: app-server pid ${stale.map((process) => process.pid).join(', ')} started before the switch to "${record.profileName}"`);
  const choice = await host.warn(staleCodexMessage(record.profileName), 'Restart extensions', 'Later');
  if (choice === 'Restart extensions') {
    await host.restartExtensionHost();
  }
}
