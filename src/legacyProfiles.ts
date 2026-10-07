import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AuthProvider, ExportedProfile, ServiceClient, parseCredentialJson, stateDir } from '../service/out';

/**
 * Versions before the account service kept the profile list in the extension's global state and each login in
 * SecretStorage. On the first connection to the service those are moved over, once, and removed here so a login
 * is never refreshed from two places.
 */

const STATE_KEY = 'aiUsage.authProfiles.v1';
const SECRET_PREFIX = 'aiUsage.authProfile.v1';
const MIGRATED_KEY = 'aiUsage.authProfilesMigrated.v1';
const PROVIDERS: AuthProvider[] = ['claude', 'codex'];

type LegacyProfile = { id: string; name: string; createdAt?: string; updatedAt?: string; email?: string; accountId?: string };
type LegacyState = Partial<Record<AuthProvider, { profiles?: LegacyProfile[]; activeProfileId?: string }>>;

export type LegacyCollection = { entries: ExportedProfile[]; withoutLogin: string[]; activeIds: Partial<Record<AuthProvider, string>> };

/** Reads what the previous storage holds, as import entries; profiles whose login is gone are named separately. */
export async function collectLegacyProfiles(globalState: Pick<vscode.Memento, 'get'>, secrets: Pick<vscode.SecretStorage, 'get'>): Promise<LegacyCollection> {
  const state = globalState.get<LegacyState>(STATE_KEY) ?? {};
  const entries: ExportedProfile[] = [];
  const withoutLogin: string[] = [];
  const activeIds: Partial<Record<AuthProvider, string>> = {};
  for (const provider of PROVIDERS) {
    const block = state[provider];
    if (!block || !Array.isArray(block.profiles)) { continue; }
    if (typeof block.activeProfileId === 'string') { activeIds[provider] = block.activeProfileId; }
    for (const profile of block.profiles) {
      if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string') { continue; }
      const raw = await secrets.get(`${SECRET_PREFIX}.${provider}.${profile.id}`);
      let credential;
      try { credential = raw ? parseCredentialJson(provider, raw) : undefined; } catch { credential = undefined; }
      if (!credential) { withoutLogin.push(`${provider === 'claude' ? 'Claude' : 'Codex'} “${profile.name}”`); continue; }
      const now = new Date().toISOString();
      entries.push({ provider, id: profile.id, name: profile.name, email: profile.email, accountId: profile.accountId,
        createdAt: profile.createdAt ?? now, updatedAt: profile.updatedAt ?? now, credential });
    }
  }
  return { entries, withoutLogin, activeIds };
}

/** Copies the per-account readings the extension collected so the service's lists are not empty at first. */
export function copyLegacyReadings(globalStorage: string, home: string, log: (message: string) => void): number {
  const source = path.join(globalStorage, 'account-usage');
  const target = path.join(stateDir(home), 'account-usage');
  let copied = 0;
  try {
    for (const name of fs.readdirSync(source)) {
      if (!name.endsWith('.json') || name.endsWith('.lock')) { continue; }
      const to = path.join(target, name);
      if (fs.existsSync(to)) { continue; }
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(source, name), to);
      copied++;
    }
  } catch { /* No readings to carry over. */ }
  if (copied) { log(`moved ${copied} account readings to the account service`); }
  return copied;
}

export type MigrationResult = { moved: number; withoutLogin: string[] } | undefined;

/**
 * Moves the profiles of the previous storage into the service, once. Profiles the service already holds with the
 * same login are left alone; those it holds with another login are not replaced. The previous copies are then
 * removed, so a login exists in one place only.
 */
export async function migrateLegacyProfiles(context: vscode.ExtensionContext, client: ServiceClient, home: string, log: (message: string) => void): Promise<MigrationResult> {
  if (context.globalState.get<boolean>(MIGRATED_KEY)) { return undefined; }
  const collected = await collectLegacyProfiles(context.globalState, context.secrets);
  if (!collected.entries.length && !collected.withoutLogin.length) {
    await context.globalState.update(MIGRATED_KEY, true);
    return undefined;
  }
  let moved = 0;
  if (collected.entries.length) {
    const summary = await client.applyImportEntries(collected.entries);
    moved = summary.counts.new + summary.counts.restore;
    log(`moved ${collected.entries.length} saved profiles to the account service: ${summary.summary}`);
  }
  copyLegacyReadings(context.globalStorageUri.fsPath, home, log);
  // The service follows the native login, so the active profile is recognized without being told.
  for (const entry of collected.entries) {
    await context.secrets.delete(`${SECRET_PREFIX}.${entry.provider}.${entry.id}`);
  }
  await context.globalState.update(STATE_KEY, undefined);
  await context.globalState.update(MIGRATED_KEY, true);
  return { moved, withoutLogin: collected.withoutLogin };
}
