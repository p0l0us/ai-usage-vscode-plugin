import { needsSignIn, readableProblem } from '../service/out';
import type { AuthProvider, KeepAliveAllResult, KeepAliveResult } from '../service/out';

export function providerTitle(provider: AuthProvider): string {
  return provider === 'claude' ? 'Claude' : 'Codex';
}

/** “Name” (email) as notifications name an account. */
export function accountLabel(name: string, email?: string): string {
  return `“${name}”${email ? ` (${email})` : ''}`;
}

/** A keep-alive for one account: the notification text, how to show it, and whether a new sign-in is the only fix. */
export type KeepAliveOutcome = { message: string; severity: 'info' | 'warning'; dead: boolean };

export function keepAliveOutcome(provider: AuthProvider, name: string, result: KeepAliveResult): KeepAliveOutcome {
  const title = providerTitle(provider);
  // Revoked, or expired and not refreshable, found by the keep-alive or by the usage read: only a new sign-in helps.
  const dead = [result.keepAliveError, result.usageError].find(needsSignIn);
  let message: string;
  let succeeded = false;
  if (result.keepAliveError) {
    const suffix = result.usage ? ' Usage statistics were still updated.'
      : dead && dead !== result.keepAliveError ? ` Usage statistics could not be updated either: ${readableProblem(dead)}` : '';
    message = `AI Usage: ${title} keep-alive failed for “${name}”: ${readableProblem(result.keepAliveError)}${suffix}`;
  } else if (result.usage) {
    succeeded = true;
    message = `AI Usage: ${title} keep-alive completed for “${name}”. Usage statistics updated.`;
  } else {
    message = `AI Usage: ${title} keep-alive completed for “${name}”, but usage statistics could not be updated${result.usageError ? `: ${readableProblem(result.usageError)}` : '.'}`;
  }
  return { message, severity: succeeded && !dead ? 'info' : 'warning', dead: Boolean(dead) };
}

export function keepAliveNotSentMessage(provider: AuthProvider, name: string, error: unknown): string {
  return `AI Usage: ${providerTitle(provider)} keep-alive for “${name}” not sent: ${readableProblem(error instanceof Error ? error.message : String(error))}`;
}

/** The notification after a sweep over several accounts: warning when any problem was found. */
export function keepAliveSweepOutcome(provider: AuthProvider, sweep: KeepAliveAllResult): { message: string; severity: 'info' | 'warning' } {
  const title = providerTitle(provider);
  const failed: string[] = [];
  for (const result of sweep.results) {
    const problem = result.error ?? result.keepAliveError ?? (result.usage ? undefined : result.usageError ?? 'usage statistics could not be updated');
    if (problem) { failed.push(`“${result.name}”: ${readableProblem(problem)}`); }
  }
  const skipped = sweep.total - sweep.done;
  const summary = `AI Usage: ${title} keep-alive sent to ${sweep.done - failed.length} of ${sweep.total} accounts${skipped ? ` (${skipped} ${sweep.cancelled ? 'cancelled' : `not sent: ${sweep.blocked ?? 'the sweep stopped'}`})` : ''}.`;
  return failed.length
    ? { message: `${summary} Problems: ${failed.join('; ')}`, severity: 'warning' }
    : { message: `${summary} Usage statistics updated.`, severity: 'info' };
}

/** A broken saved login is reported by name and email; one that needs a new sign-in is offered it right away. */
export function accountProblemMessage(event: { provider: AuthProvider; name: string; email?: string; revoked?: boolean; readable: string }): string {
  const title = providerTitle(event.provider);
  const who = accountLabel(event.name, event.email);
  return event.revoked
    ? `AI Usage: the saved ${title} login for ${who} no longer works and cannot be used or rotated to: ${event.readable}`
    : `AI Usage: automatic rotation will not switch to the ${title} account ${who}: its keep-alive failed. ${event.readable}`;
}

export function noCandidateMessage(provider: AuthProvider, detail: string): string {
  return `AI Usage: not rotating ${providerTitle(provider)}: ${detail}.`;
}

/** The modal's detail of an earned-reset confirmation the engine asks the user to approve. */
export function resetConfirmationDetail(decision: { windows: Array<{ label: string; usedPercent: number }>; plannedCredits: number;
  availableCredits: number; reason: string; expiresAt: string | number | Date }): string {
  const windows = decision.windows.map(window => `${window.label}: ${window.usedPercent}% used`).join(', ');
  return `The engine plans to use ${decision.plannedCredits} reset credit(s). Current quota: ${windows}. ${decision.availableCredits} credit(s) are available. Reason: ${decision.reason}. This decision expires at ${new Date(decision.expiresAt).toLocaleTimeString()}.`;
}
