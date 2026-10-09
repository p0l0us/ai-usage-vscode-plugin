import { deserializeUsageState, ProviderId, RotationDiagnostics, ServiceClient } from '../service/out';
/** UI adapter only: no files, provider credentials, network polling policy or score calculations. */
export async function readServiceUsage(client: Pick<ServiceClient, 'liveUsage' | 'call'>, provider: ProviderId, force: boolean, diagnostics: boolean) {
  const view = await client.liveUsage(provider, force);
  const rotation = diagnostics && provider !== 'copilot'
    ? await client.call('rotation.diagnostics', { provider }) : undefined;
  return { ...deserializeUsageState(view), profileId: view.profileId, diagnostics: rotation };
}
export function rotationTooltipLines(diagnostics: RotationDiagnostics): string[] {
  return [`${diagnostics.strategy} / ${diagnostics.trigger}. ${diagnostics.reason}`, diagnostics.scoreMeaning,
    ...diagnostics.candidates.map(candidate => `${candidate.active ? 'Current: ' : `#${candidate.rank ?? '—'}: `}${candidate.name} · score ${candidate.score === undefined ? 'n/a' : candidate.score.toFixed(3)} · ${candidate.reason}${candidate.fetchedAt ? ` Checked ${candidate.fetchedAt}.` : ''}`)];
}
