import { deserializeUsage } from '../service/out';
import type { AuthProvider, LiveUsage, ProviderView } from '../service/out';
import type { ConfigReader } from './usageLabels';

/** The part of ServiceManager the status bar reads: the cached provider views and the connection state. */
export type ServiceViews = {
  views: Partial<Record<AuthProvider, ProviderView>>;
  connected: unknown;
};

/** "#N" for the active saved profile when `aiUsage.<service>.statusBar.accountNumber` is on and several are saved. */
export function accountNumberLabel(services: Pick<ServiceViews, 'views'>, provider: AuthProvider, config: ConfigReader): string | undefined {
  const view = services.views[provider];
  if (!view || view.profiles.length < 2 || !config.get<boolean>(`aiUsage.${provider}.statusBar.accountNumber`, true)) {
    return undefined;
  }
  return view.activeNumber === undefined ? undefined : `#${view.activeNumber}`;
}

export function activeProfileName(services: Pick<ServiceViews, 'views'>, provider: AuthProvider): string | undefined {
  return services.views[provider]?.profiles.find((profile) => profile.active)?.name;
}

/** The Accounts row of the menu: the active profile, or how many are saved when none is active. */
export function accountsSummary(services: ServiceViews, provider: AuthProvider): string {
  const view = services.views[provider];
  if (!view) { return services.connected ? 'Loading…' : 'Account service not connected'; }
  const active = view.profiles.find((profile) => profile.active);
  if (active) { return active.name; }
  if (!view.profiles.length) { return 'None saved'; }
  return `${view.profiles.length} saved · ${view.nativeUnsaved ? 'current login not saved' : 'none active'}`;
}

export function accountUsage(services: Pick<ServiceViews, 'views'>, provider: AuthProvider): LiveUsage | undefined {
  const view = services.views[provider];
  const reading = view?.activeNumber !== undefined ? view.profiles.find((profile) => profile.id === view.activeProfileId)?.usage : undefined;
  return reading ? deserializeUsage({ usage: reading }) : undefined;
}
