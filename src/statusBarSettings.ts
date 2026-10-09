export const CODEX_EARNED_RESETS_SETTING = 'aiUsage.codex.statusBar.earnedResets';

/** A display-only toggle must not request another usage reading; other Codex changes still do. */
export function codexUsageSettingsChanged(affectsConfiguration: (key: string) => boolean, configKeys: string[]): boolean {
  return configKeys.some(key => key.startsWith('codex.') && `aiUsage.${key}` !== CODEX_EARNED_RESETS_SETTING &&
    affectsConfiguration(`aiUsage.${key}`));
}
