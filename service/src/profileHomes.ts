import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { AuthProvider, StoredCredential, nativeCredentialPath, parseCredentialJson, writeJsonAtomically, writeTextAtomically } from './authFiles';
import { acquireAccountLock, isolatedHome, stagedCredentialPath } from './accountProbe';
import { removeCodexProxyProvider } from './codexConfig';
import { applyClaudeSettingsToFile, readClaudeSettingAssignments } from './claudeSettings';
import { applyCodexSettingsToFile, readCodexSettingAssignments, setCodexConfigValue } from './codexSettings';

type HomeMarker = { provider: AuthProvider; id: string; number: number; syncedHash?: string };
const MARKER = '.ai-usage-profile.json';
export const credentialHash = (credential: StoredCredential): string => createHash('sha256').update(JSON.stringify(credential)).digest('hex');

function readMarker(home: string): HomeMarker | undefined {
  try { return JSON.parse(fs.readFileSync(path.join(home, MARKER), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** A durable slot belongs to a profile UUID, independently of its position in the Accounts menu. */
export class ProfileHomes {
  private readonly file: string;
  private readonly slots: Record<string, number>;
  constructor(directory: string, private readonly getSetting: (key: string) => unknown) {
    this.file = path.join(directory, 'profile-homes.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !saved.slots || Object.values(saved.slots).some(n => !Number.isSafeInteger(n) || Number(n) < 1)) {
        throw new Error('Invalid account home registry.');
      }
      this.slots = saved.slots;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.slots = {};
    }
  }

  private candidate(provider: AuthProvider, configured: string, number: number): string {
    // Upgrade the former shared default. Custom old paths become numbered siblings.
    const template = !configured || configured === `~/.${provider}-tmp` ? `~/.${provider}-profile-{number}` : configured;
    const expanded = template.includes('{number}') ? template.replaceAll('{number}', String(number)) : `${template}-profile-${number}`;
    return path.resolve(os.homedir(), expanded.startsWith('~/') || expanded.startsWith('~\\') ? path.join(os.homedir(), expanded.slice(2)) : expanded);
  }

  /** Profile views expose an allocated path without creating any files or directories. */
  lookup(provider: AuthProvider, id: string, configured: string): string | undefined {
    const number = this.slots[`${provider}:${id}`];
    return number ? this.candidate(provider, configured, number) : undefined;
  }

  resolve(provider: AuthProvider, id: string, ids: string[], configured: string): string {
    if (!ids.includes(id)) throw new Error('The profile no longer exists.');
    // Reserve in saved order, even if the first operation targets an inactive account.
    for (const profileId of ids) {
      const key = `${provider}:${profileId}`;
      if (this.slots[key]) continue;
      const used = new Set(Object.entries(this.slots).filter(([k]) => k.startsWith(`${provider}:`)).map(([, n]) => n));
      let number = 1;
      for (;;) {
        const home = this.candidate(provider, configured, number);
        if (!used.has(number)) {
          if (!fs.existsSync(home)) break;
          const marker = readMarker(home);
          if (marker?.provider === provider && marker.id === profileId) break;
        }
        number++;
      }
      this.slots[key] = number;
      writeJsonAtomically(this.file, { version: 1, slots: this.slots });
    }
    const number = this.slots[`${provider}:${id}`];
    const candidate = this.candidate(provider, configured, number);
    const existed = fs.existsSync(candidate);
    const home = isolatedHome(provider, candidate);
    const marker = readMarker(home);
    if (marker && (marker.provider !== provider || marker.id !== id)) throw new Error('This account home belongs to another profile.');
    if (!marker) {
      if (existed && fs.readdirSync(home).length) throw new Error('The account home is not empty and has no profile ownership marker.');
      writeJsonAtomically(path.join(home, MARKER), { provider, id, number });
    }
    if (process.platform !== 'win32') fs.chmodSync(home, 0o700);
    this.settings(provider, home);
    return home;
  }

  private settings(provider: AuthProvider, home: string): void {
    const name = provider === 'claude' ? 'settings.json' : 'config.toml';
    const file = path.join(home, name);
    if (!fs.existsSync(file)) {
      let text = provider === 'claude' ? '{}\n' : '';
      try { text = fs.readFileSync(path.join(path.dirname(nativeCredentialPath(provider)), name), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (provider === 'codex') text = removeCodexProxyProvider(text);
      else {
        const settings = JSON.parse(text);
        // Do not seed a different account's API credentials or routing into this login.
        if (settings.env) for (const key of Object.keys(settings.env)) {
          if (/^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_CODE_OAUTH_TOKEN$)/.test(key)) delete settings.env[key];
        }
        text = JSON.stringify(settings, null, 2) + '\n';
      }
      writeTextAtomically(file, text);
    }
    if (provider === 'claude') applyClaudeSettingsToFile(file, readClaudeSettingAssignments(this.getSetting));
    else {
      // Keyring/auto storage can share a login across different CODEX_HOME directories.
      // Keep the home usable by a manually launched CLI as well as service probes.
      const before = fs.readFileSync(file, 'utf8');
      const after = setCodexConfigValue(before, '', 'cli_auth_credentials_store', 'file');
      if (after !== before) writeTextAtomically(file, after);
      applyCodexSettingsToFile(file, readCodexSettingAssignments(this.getSetting));
    }
  }

  /** Three-way reconciliation prevents restoring a refresh token that another CLI has already rotated. */
  async synchronize(provider: AuthProvider, home: string, stored: StoredCredential,
    adopt: (before: StoredCredential, after: StoredCredential) => Promise<StoredCredential | undefined>): Promise<StoredCredential> {
    const lock = acquireAccountLock(path.join(home, '.ai-usage.lock'));
    if (!lock) throw new Error('Another account check is using this profile home.');
    try {
      const marker = readMarker(home)!;
      const file = stagedCredentialPath(provider, home);
      let local: StoredCredential | undefined;
      try { local = parseCredentialJson(provider, fs.readFileSync(file, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const storedHash = credentialHash(stored);
      if (local && credentialHash(local) !== storedHash) {
        if (marker.syncedHash === storedHash) {
          const accepted = await adopt(stored, local);
          if (!accepted || credentialHash(accepted) !== credentialHash(local)) throw new Error('The saved login changed while synchronizing this profile home.');
          stored = accepted;
        } else if (marker.syncedHash !== credentialHash(local)) {
          throw new Error('The login changed in both the service and profile home. Sign in again for this profile.');
        }
      }
      if (!local || credentialHash(local) !== credentialHash(stored)) writeJsonAtomically(file, stored);
      writeJsonAtomically(path.join(home, MARKER), { ...marker, syncedHash: credentialHash(stored) });
      return stored;
    } finally { lock.release(); }
  }

  /** Explicit sign-in/import replacement is authoritative; ordinary checks use synchronize instead. */
  replace(provider: AuthProvider, home: string, credential: StoredCredential): void {
    const lock = acquireAccountLock(path.join(home, '.ai-usage.lock'));
    if (!lock) throw new Error('Another account check is using this profile home.');
    try {
      writeJsonAtomically(stagedCredentialPath(provider, home), credential);
      writeJsonAtomically(path.join(home, MARKER), { ...readMarker(home)!, syncedHash: credentialHash(credential) });
    } finally { lock.release(); }
  }

  /** Record the common baseline only when neither the file nor the store changed during the check. */
  acknowledge(provider: AuthProvider, home: string, stored: StoredCredential): void {
    const local = parseCredentialJson(provider, fs.readFileSync(stagedCredentialPath(provider, home), 'utf8'));
    if (credentialHash(local) === credentialHash(stored)) {
      writeJsonAtomically(path.join(home, MARKER), { ...readMarker(home)!, syncedHash: credentialHash(stored) });
    }
  }
}
