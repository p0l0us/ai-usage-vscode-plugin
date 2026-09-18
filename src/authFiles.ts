import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type AuthProvider = 'claude' | 'codex';
export type StoredCredential = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function nativeCredentialPath(provider: AuthProvider): string {
  if (provider === 'claude') {
    return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  }
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
}

/** Extracts and validates the provider-owned authentication part of a credentials document. */
export function extractCredential(provider: AuthProvider, document: unknown): StoredCredential {
  if (!isObject(document)) {
    throw new Error('The credential file must contain a JSON object.');
  }

  if (provider === 'claude') {
    const oauth = isObject(document.claudeAiOauth) ? document.claudeAiOauth : document;
    if (!nonEmptyString(oauth.accessToken)) {
      throw new Error('No Claude OAuth accessToken was found.');
    }
    const credential: StoredCredential = { claudeAiOauth: structuredClone(oauth) };
    // Claude Code may keep this account-scoped value beside claudeAiOauth rather than inside it.
    if (isObject(document.claudeAiOauth) && nonEmptyString(document.organizationUuid)) {
      credential.organizationUuid = document.organizationUuid;
    }
    return credential;
  }

  const tokens = isObject(document.tokens) ? document.tokens : undefined;
  if (!nonEmptyString(document.OPENAI_API_KEY) && !nonEmptyString(tokens?.access_token)) {
    throw new Error('No Codex OPENAI_API_KEY or OAuth access_token was found.');
  }
  return structuredClone(document);
}

export function parseCredentialJson(provider: AuthProvider, text: string): StoredCredential {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }
  return extractCredential(provider, document);
}

export function readNativeCredential(provider: AuthProvider): StoredCredential {
  const file = nativeCredentialPath(provider);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`No ${provider === 'claude' ? 'Claude' : 'Codex'} login was found at ${file}.`);
    }
    throw new Error(`Could not read ${file}: ${String(error)}`);
  }
  try {
    return parseCredentialJson(provider, text);
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readJsonObjectIfPresent(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObject(value)) {
      throw new Error('root value is not an object');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`Could not preserve the existing ${file}: ${String(error)}`);
  }
}

/** Writes a complete document through a mode-0600 temporary file, then atomically replaces the target. */
export function writeJsonAtomically(file: string, document: Record<string, unknown>): void {
  writeTextAtomically(file, `${JSON.stringify(document, null, 2)}\n`);
}

/** Writes text through a mode-0600 temporary file in the target's directory, then atomically replaces the target. */
export function writeTextAtomically(file: string, text: string): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.ai-usage-${process.pid}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    fs.renameSync(temporary, file);
    // Windows uses inherited ACLs and only implements a small subset of chmod. On POSIX, ensure
    // replacing an existing file also tightens permissions rather than retaining a broader mode.
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o600);
    }
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The rename may already have consumed the temporary file.
    }
    throw error;
  }
}

/** Activates a credential in the native store used by both the vendor CLI and VS Code extension. */
export function writeNativeCredential(provider: AuthProvider, credential: StoredCredential): void {
  const checked = extractCredential(provider, credential);
  const file = nativeCredentialPath(provider);
  if (provider === 'claude') {
    // Claude also keeps MCP OAuth entries in this file. Never replace those when switching accounts.
    const document = readJsonObjectIfPresent(file);
    document.claudeAiOauth = checked.claudeAiOauth;
    if (nonEmptyString(checked.organizationUuid)) {
      document.organizationUuid = checked.organizationUuid;
    } else {
      // Do not leave the previously selected account's organization attached to the new OAuth token.
      delete document.organizationUuid;
    }
    writeJsonAtomically(file, document);
    return;
  }
  writeJsonAtomically(file, checked);
}

function nestedString(value: StoredCredential, objectKey: string, key: string): string | undefined {
  const nested = value[objectKey];
  return isObject(nested) && nonEmptyString(nested[key]) ? nested[key] : undefined;
}

/**
 * True when a native credential can safely refresh the stored copy of the active profile.
 * Codex exposes a stable account id. Claude Code rotates the refresh token on every token refresh,
 * so a refreshed Claude login is recognised by the root `organizationUuid` it keeps beside the OAuth
 * object; the refresh token is only compared when either document lacks that id.
 */
export function isSameCredentialOwner(provider: AuthProvider, stored: StoredCredential, native: StoredCredential): boolean {
  if (JSON.stringify(stored) === JSON.stringify(native)) {
    return true;
  }
  if (provider === 'codex') {
    const storedAccount = nestedString(stored, 'tokens', 'account_id');
    const nativeAccount = nestedString(native, 'tokens', 'account_id');
    if (storedAccount && nativeAccount) {
      return storedAccount === nativeAccount;
    }
    const storedRefresh = nestedString(stored, 'tokens', 'refresh_token');
    const nativeRefresh = nestedString(native, 'tokens', 'refresh_token');
    return Boolean(storedRefresh && nativeRefresh && storedRefresh === nativeRefresh);
  }
  const storedRefresh = nestedString(stored, 'claudeAiOauth', 'refreshToken');
  const nativeRefresh = nestedString(native, 'claudeAiOauth', 'refreshToken');
  if (storedRefresh && nativeRefresh && storedRefresh === nativeRefresh) {
    return true;
  }
  const storedOrganization = stored.organizationUuid;
  const nativeOrganization = native.organizationUuid;
  return nonEmptyString(storedOrganization) && nonEmptyString(nativeOrganization) && storedOrganization === nativeOrganization;
}
