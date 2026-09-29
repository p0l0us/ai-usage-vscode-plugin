import { randomUUID } from 'crypto';
import { AuthProvider, StoredCredential, extractCredential } from './authFiles';

/** Version of the export document; bumped when its shape changes so an older AI Usage refuses a newer file plainly. */
export const PROFILE_EXPORT_FORMAT = 1;
const MAX_NAME_LENGTH = 60;

/** One saved profile as it travels between computers: its metadata and the login exactly as SecretStorage holds it. */
export type ExportedProfile = {
  provider: AuthProvider;
  id: string;
  name: string;
  email?: string;
  accountId?: string;
  createdAt: string;
  updatedAt: string;
  credential: StoredCredential;
};

/** What importing an entry does to the profiles already saved here. */
export type ImportKind = 'new' | 'restore' | 'replace' | 'same';

export type ImportPlan<P> = {
  entry: ExportedProfile;
  kind: ImportKind;
  /** The saved profile the entry stands for, when it is not new. */
  target?: P;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function serializeProfileExport(profiles: ExportedProfile[], exportedAt = new Date()): string {
  return `${JSON.stringify({ aiUsageProfiles: PROFILE_EXPORT_FORMAT, exportedAt: exportedAt.toISOString(), profiles }, null, 2)}\n`;
}

/** Reads an export back, checking every login the way a single credential import does; throws a message for the user. */
export function parseProfileExport(text: string): ExportedProfile[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }
  if (!isObject(document) || document.aiUsageProfiles === undefined) {
    throw new Error('The selected file is not an AI Usage profile export. Use Export saved profiles… on the other computer to create one.');
  }
  if (document.aiUsageProfiles !== PROFILE_EXPORT_FORMAT) {
    throw new Error(`The profile export has format ${String(document.aiUsageProfiles)}, which this version of AI Usage cannot read.`);
  }
  if (!Array.isArray(document.profiles)) {
    throw new Error('The profile export lists no profiles.');
  }
  return document.profiles.map((entry: unknown, index: number): ExportedProfile => {
    const where = `Profile ${index + 1} of the export`;
    if (!isObject(entry)) { throw new Error(`${where} is not an object.`); }
    const provider = entry.provider;
    if (provider !== 'claude' && provider !== 'codex') { throw new Error(`${where} names an unknown service: ${String(provider)}.`); }
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, MAX_NAME_LENGTH) : '';
    if (!name) { throw new Error(`${where} has no name.`); }
    let credential: StoredCredential;
    try {
      credential = extractCredential(provider, entry.credential);
    } catch (error) {
      throw new Error(`${where} (“${name}”): ${error instanceof Error ? error.message : String(error)}`);
    }
    const now = new Date().toISOString();
    const parsed: ExportedProfile = {
      provider,
      id: optionalString(entry.id) ?? randomUUID(),
      name,
      createdAt: optionalString(entry.createdAt) ?? now,
      updatedAt: optionalString(entry.updatedAt) ?? now,
      credential
    };
    // Optional identity is left out rather than set to undefined, like a saved profile that never recorded it.
    const email = optionalString(entry.email);
    const accountId = optionalString(entry.accountId);
    if (email) { parsed.email = email; }
    if (accountId) { parsed.accountId = accountId; }
    return parsed;
  });
}

/**
 * Pairs each exported entry with the saved profile it stands for: the same id first (an earlier import, or a
 * synced profile list), then the same account, then the same email. A matched profile without a login here (its
 * SecretStorage was cleared) gets it restored; one with a different login is only replaced on request; the same
 * login is nothing to do.
 */
export function planImport<P extends { id: string; name: string; email?: string; accountId?: string }>(
  entries: ExportedProfile[],
  existing: (provider: AuthProvider) => P[],
  loginOf: (provider: AuthProvider, id: string) => StoredCredential | undefined
): Array<ImportPlan<P>> {
  return entries.map((entry) => {
    const profiles = existing(entry.provider);
    const email = entry.email?.toLowerCase();
    const target = profiles.find((profile) => profile.id === entry.id)
      ?? (entry.accountId ? profiles.find((profile) => profile.accountId === entry.accountId) : undefined)
      ?? (email ? profiles.find((profile) => profile.email?.toLowerCase() === email) : undefined);
    if (!target) { return { entry, kind: 'new' }; }
    const login = loginOf(entry.provider, target.id);
    const kind: ImportKind = !login ? 'restore' : JSON.stringify(login) === JSON.stringify(entry.credential) ? 'same' : 'replace';
    return { entry, kind, target };
  });
}

/** The name itself when free, otherwise the first "name (n)" that is, within the profile name length. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (value) => value.toLowerCase()));
  if (!used.has(name.toLowerCase())) { return name; }
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) { return candidate; }
  }
}
