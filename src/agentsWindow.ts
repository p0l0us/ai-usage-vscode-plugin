export const AGENTS_WINDOW_WALKTHROUGH = 'aiUsage.agentsWindow';
export const AGENTS_WINDOW_SETTING = 'extensions.supportAgentsWindow';
export const AGENTS_WINDOW_HINT_KEY = 'aiUsage.agentsWindowHintShown';

/** Whether `extensions.supportAgentsWindow` lists this extension (id compared case-insensitively) as allowed. */
export function isAllowedInAgentsWindow(map: Record<string, boolean> | undefined, extensionId: string): boolean {
  return Object.entries(map ?? {}).some(([id, allowed]) => allowed && id.toLowerCase() === extensionId.toLowerCase());
}

/** The user-settings value after allowing this extension, keeping the other entries. */
export function withAgentsWindowEntry(current: Record<string, boolean> | undefined, extensionId: string): Record<string, boolean> {
  return { ...(current ?? {}), [extensionId]: true };
}

export function agentsWindowEnabledMessage(remote: boolean): string {
  return remote
    ? 'AI Usage is now allowed in the Agents window. Because this window is remote, also install the extension on your local computer, then reload the Agents window.'
    : 'AI Usage is now allowed in the Agents window. Reload the Agents window to see the chips.';
}

export const AGENTS_WINDOW_HINT_MESSAGE = 'AI Usage can also show usage chips in the Agents window. It needs a one-time setup.';

/** What the window offers `enableAgentsWindow` and the one-time hint need; tests pass fakes. */
export type AgentsWindowHost = {
  extensionId: string;
  /** `extensions.supportAgentsWindow` as the user's settings see it. */
  effectiveSetting: () => Record<string, boolean> | undefined;
  /** The same setting at the user (global) level only. */
  globalSetting: () => Record<string, boolean> | undefined;
  updateGlobalSetting: (value: Record<string, boolean>) => PromiseLike<void>;
  chipsEnabled: () => boolean;
  hintShown: () => boolean | undefined;
  markHintShown: () => PromiseLike<void>;
  remote: () => boolean;
  info: (message: string, ...actions: string[]) => PromiseLike<string | undefined>;
  error: (message: string) => void;
  log: (message: string) => void;
  run: (command: string, ...args: unknown[]) => PromiseLike<unknown>;
};

/** Adds this extension to `extensions.supportAgentsWindow` in user settings, keeping other entries. */
export async function enableAgentsWindow(host: AgentsWindowHost): Promise<void> {
  const current = host.globalSetting() ?? {};
  try {
    await host.updateGlobalSetting(withAgentsWindowEntry(current, host.extensionId));
  } catch (error) {
    host.error(`AI Usage: could not update ${AGENTS_WINDOW_SETTING}: ${String(error)}`);
    return;
  }
  host.log(`agents window: ${host.extensionId} added to ${AGENTS_WINDOW_SETTING}`);
  const choice = await host.info(agentsWindowEnabledMessage(host.remote()), 'Setup guide', 'Open settings.json');
  if (choice === 'Setup guide') {
    await host.run('aiUsage.openAgentsWindowSetup');
  } else if (choice === 'Open settings.json') {
    await host.run('workbench.action.openSettingsJson');
  }
}

/** One-time hint, in ordinary windows only, that the Agents window needs a short setup. */
export async function maybeOfferAgentsWindowSetup(host: AgentsWindowHost): Promise<void> {
  if (host.hintShown() || isAllowedInAgentsWindow(host.effectiveSetting(), host.extensionId)) {
    return;
  }
  if (!host.chipsEnabled()) {
    return;
  }
  await host.markHintShown();
  const choice = await host.info(AGENTS_WINDOW_HINT_MESSAGE, 'Set up', 'Not now');
  if (choice === 'Set up') {
    await host.run('aiUsage.openAgentsWindowSetup');
  }
}
