import * as vscode from 'vscode';
import {
  AuthProvider, ExportedProfile, PrivateProfileBackend, ProfileFile, ProfileStore, ServiceClient, StoredCredential, parseCredentialJson, profilesFile
} from '../service/out';

/**
 * The private profiles kept by VS Code, as the extension always kept them before the account service: the list in
 * global state, each login in SecretStorage, under the same keys, so older versions read them too. When no background
 * service is used, the service hosted inside VS Code keeps its private profiles here; with the background service
 * they are in its profiles.json. Profiles move between the two only when the user asks (`transferProfiles`).
 */

export const STATE_KEY = 'aiUsage.authProfiles.v1';
const SECRET_PREFIX = 'aiUsage.authProfile.v1';
const PROVIDERS: AuthProvider[] = ['claude', 'codex'];

export type ProfileStoreKind = 'service' | 'vscode';
export const STORE_TITLES: Record<ProfileStoreKind, string> = { service: 'the account service', vscode: 'VS Code' };

type StoredMetadata = { id: string; name: string; createdAt?: string; updatedAt?: string; email?: string; accountId?: string };
type StoredState = Partial<Record<AuthProvider, { profiles?: StoredMetadata[]; activeProfileId?: string }>>;

export type VscodeProfileBackend = PrivateProfileBackend & {
  /** Resolves once every write so far is in global state and SecretStorage. */
  flush(): Promise<void>;
};

function secretKey(provider: AuthProvider, id: string): string { return `${SECRET_PREFIX}.${provider}.${id}`; }

/**
 * Loads the VS Code profiles into memory and returns a backend over them. Reads are served from memory; each write
 * replaces it at once and is then saved in order: the list to global state, changed logins to SecretStorage, the
 * logins of removed profiles deleted.
 */
export async function vscodeProfileBackend(
  context: Pick<vscode.ExtensionContext, 'globalState' | 'secrets'>,
  log: (message: string) => void
): Promise<VscodeProfileBackend> {
  const stored = context.globalState.get<StoredState>(STATE_KEY) ?? {};
  const memory: ProfileFile = { version: 1, claude: { profiles: [] }, codex: { profiles: [] } };
  const saved = new Map<string, string>();
  for (const provider of PROVIDERS) {
    const block = stored[provider];
    if (typeof block?.activeProfileId === 'string') { memory[provider].activeProfileId = block.activeProfileId; }
    for (const profile of Array.isArray(block?.profiles) ? block!.profiles! : []) {
      if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string') { continue; }
      const raw = await context.secrets.get(secretKey(provider, profile.id));
      let credential: StoredCredential | undefined;
      try { credential = raw ? parseCredentialJson(provider, raw) : undefined; } catch { credential = undefined; }
      if (raw && credential) { saved.set(secretKey(provider, profile.id), JSON.stringify(credential)); }
      const now = new Date().toISOString();
      memory[provider].profiles.push({ ...profile, createdAt: profile.createdAt ?? now, updatedAt: profile.updatedAt ?? now, ...(credential ? { credential } : {}) });
    }
  }
  let current = structuredClone(memory);
  let queue: Promise<void> = Promise.resolve();
  const persist = async (state: ProfileFile): Promise<void> => {
    const list: StoredState = {};
    const wanted = new Map<string, string>();
    for (const provider of PROVIDERS) {
      list[provider] = {
        profiles: state[provider].profiles.map(({ credential, folder: _folder, ...metadata }) => {
          if (credential) { wanted.set(secretKey(provider, metadata.id), JSON.stringify(credential)); }
          return metadata;
        }),
        ...(state[provider].activeProfileId ? { activeProfileId: state[provider].activeProfileId } : {})
      };
    }
    await context.globalState.update(STATE_KEY, list);
    for (const [key, value] of wanted) {
      if (saved.get(key) !== value) { await context.secrets.store(key, value); saved.set(key, value); }
    }
    for (const key of [...saved.keys()]) {
      if (!wanted.has(key)) { await context.secrets.delete(key); saved.delete(key); }
    }
  };
  return {
    kind: 'vscode',
    read: () => structuredClone(current),
    write: (state) => {
      current = structuredClone(state);
      const snapshot = structuredClone(state);
      queue = queue.then(() => persist(snapshot)).catch((error) => log(`profiles: could not save to VS Code storage: ${error instanceof Error ? error.message : String(error)}`));
    },
    flush: () => queue
  };
}

/** How many private profiles VS Code keeps, without loading their logins. */
export function vscodeProfileCount(context: Pick<vscode.ExtensionContext, 'globalState'>): number {
  const stored = context.globalState.get<StoredState>(STATE_KEY) ?? {};
  return PROVIDERS.reduce((sum, provider) => sum + (Array.isArray(stored[provider]?.profiles) ? stored[provider]!.profiles!.length : 0), 0);
}

/** Reads, adds and removes the private profiles of one store. */
export type ProfileAccess = {
  list(): Promise<ExportedProfile[]>;
  add(entries: ExportedProfile[]): Promise<string>;
  remove(entries: Array<{ provider: AuthProvider; id: string }>): Promise<void>;
};

/** The store a running service serves, through its client, so the service's own copy stays the only one in use. */
export function clientAccess(client: ServiceClient): ProfileAccess {
  return {
    list: async () => {
      const privateIds = new Set<string>();
      for (const provider of PROVIDERS) {
        for (const profile of (await client.list(provider)).profiles) {
          if (!profile.folder) { privateIds.add(`${provider}:${profile.id}`); }
        }
      }
      return (await client.exportProfiles()).entries.filter((entry) => privateIds.has(`${entry.provider}:${entry.id}`));
    },
    add: async (entries) => (await client.applyImportEntries(entries)).summary,
    remove: async (entries) => { for (const entry of entries) { await client.delete(entry.provider, entry.id); } }
  };
}

/** A store no running service uses, opened directly; project profiles are left out. */
export async function directAccess(
  kind: ProfileStoreKind,
  home: string,
  context: Pick<vscode.ExtensionContext, 'globalState' | 'secrets'>,
  log: (message: string) => void
): Promise<ProfileAccess> {
  const backend = kind === 'vscode' ? await vscodeProfileBackend(context, log) : undefined;
  // The entries carry their email and account id already; no login is sent anywhere to look them up again.
  const store = new ProfileStore(profilesFile(home), log, async () => ({}), { projectProfilesEnabled: () => false, ...(backend ? { privateProfiles: backend } : {}) });
  return {
    list: async () => store.exportEntries().entries,
    add: async (entries) => {
      const outcome = await store.applyImport(store.planImport(entries));
      await backend?.flush();
      return outcome.summary;
    },
    remove: async (entries) => {
      for (const entry of entries) { store.delete(entry.provider, entry.id); }
      await backend?.flush();
    }
  };
}

/**
 * Copies or moves the chosen private profiles from one store to the other. Moving removes each profile from the
 * source only after the target holds it, so a failure leaves it where it was.
 */
export async function transferProfiles(source: ProfileAccess, target: ProfileAccess, chosen: ExportedProfile[], move: boolean): Promise<string> {
  const summary = await target.add(chosen);
  if (move) {
    const present = new Set((await target.list()).map((entry) => `${entry.provider}:${entry.id}`));
    await source.remove(chosen.filter((entry) => present.has(`${entry.provider}:${entry.id}`)));
  }
  return summary;
}
