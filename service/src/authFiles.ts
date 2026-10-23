import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';

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

/**
 * The macOS Keychain, where Claude Code keeps its login instead of `.credentials.json` (it reads that file only when
 * the Keychain holds no login). `read` returns undefined when there is no such item.
 */
export type ClaudeKeychain = {
  read(service: string, account: string): string | undefined;
  write(service: string, account: string, text: string): void;
};

/** `security` exits with this when the item does not exist. */
const SECURITY_ITEM_NOT_FOUND = 44;
const SECURITY_TIMEOUT_MS = 5000;
/** Longest `security -i` command line; Claude Code passes longer ones as arguments. */
const SECURITY_STDIN_LIMIT = 4032;

const macKeychain: ClaudeKeychain = {
  read(service, account) {
    const result = spawnSync('security', ['find-generic-password', '-a', account, '-w', '-s', service], { encoding: 'utf8', timeout: SECURITY_TIMEOUT_MS });
    if (result.status === SECURITY_ITEM_NOT_FOUND) { return undefined; }
    if (result.status !== 0 || result.error) {
      throw new Error(`security find-generic-password failed (${result.error?.message ?? `exit ${result.status}`}${result.stderr ? `: ${result.stderr.trim()}` : ''})`);
    }
    const text = result.stdout.trim();
    // `security -w` prints a value that is not plain text as hex.
    return /^[0-9a-f]+$/i.test(text) && text.length % 2 === 0 ? Buffer.from(text, 'hex').toString('utf8') : text;
  },
  write(service, account, text) {
    // Like Claude Code: the secret goes through stdin rather than the process arguments when it fits.
    const hex = Buffer.from(text, 'utf8').toString('hex');
    const command = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
    const result = command.length <= SECURITY_STDIN_LIMIT
      ? spawnSync('security', ['-i'], { input: command, encoding: 'utf8', timeout: SECURITY_TIMEOUT_MS })
      : spawnSync('security', ['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex], { encoding: 'utf8', timeout: SECURITY_TIMEOUT_MS });
    if (result.status !== 0 || result.error) {
      throw new Error(`security add-generic-password failed (${result.error?.message ?? `exit ${result.status}`}${result.stderr ? `: ${result.stderr.trim()}` : ''})`);
    }
  }
};

let keychainOverride: ClaudeKeychain | null | undefined;

/** Replaces the macOS Keychain (tests); null turns it off, undefined restores the platform default. */
export function setClaudeKeychain(keychain: ClaudeKeychain | null | undefined): void {
  keychainOverride = keychain;
}

function claudeKeychain(): ClaudeKeychain | undefined {
  if (keychainOverride !== undefined) { return keychainOverride ?? undefined; }
  // The test runner turns it off so no test can read or change the developer's real login.
  return process.platform === 'darwin' && process.env.AI_USAGE_CLAUDE_KEYCHAIN !== 'off' ? macKeychain : undefined;
}

/**
 * The Keychain item Claude Code uses for the native login: `Claude Code-credentials`, with the first 8 hex digits
 * of the SHA-256 of the config directory appended when `CLAUDE_CONFIG_DIR` (or `CLAUDE_SECURESTORAGE_CONFIG_DIR`)
 * is set. The account is the user name, as Claude Code writes it.
 */
export function claudeKeychainItem(): { service: string; account: string } {
  const storage = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const defaultDir = storage !== undefined ? !storage : !process.env.CLAUDE_CONFIG_DIR;
  const dir = (storage !== undefined ? storage : path.dirname(nativeCredentialPath('claude'))).normalize('NFC');
  const suffix = defaultDir ? '' : `-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
  let account: string;
  try { account = process.env.USER || os.userInfo().username; } catch { account = 'claude-code-user'; }
  if (!/^[a-zA-Z0-9._-]+$/.test(account)) { account = 'claude-code-user'; }
  return { service: `Claude Code-credentials${suffix}`, account };
}

/** The native Claude login in the Keychain: its text, or undefined when there is none; `error` when unreadable. */
function readClaudeKeychain(): { text?: string; error?: string; label: string } | undefined {
  const keychain = claudeKeychain();
  if (!keychain) { return undefined; }
  const item = claudeKeychainItem();
  const label = `the macOS Keychain (${item.service})`;
  try { return { text: keychain.read(item.service, item.account), label }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error), label }; }
}

/** Where the native login of a provider is read from, for messages. */
export function nativeCredentialLocation(provider: AuthProvider): string {
  const file = nativeCredentialPath(provider);
  if (provider !== 'claude') { return file; }
  const keychain = readClaudeKeychain();
  if (!keychain) { return file; }
  return keychain.text !== undefined ? keychain.label : `${keychain.label} or ${file}`;
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
  // Claude Code on macOS keeps its login in the Keychain and reads the file only when the Keychain has none.
  const keychain = provider === 'claude' ? readClaudeKeychain() : undefined;
  if (keychain?.text !== undefined) {
    try {
      return parseCredentialJson(provider, keychain.text);
    } catch (error) {
      throw new Error(`${keychain.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      if (keychain) {
        throw new Error(`No Claude login was found in ${keychain.label} or at ${file}.${keychain.error ? ` The Keychain could not be read: ${keychain.error}` : ''}`);
      }
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
    // Claude Code ignores the file while the macOS Keychain holds its login, so a switch goes where it reads.
    const keychain = readClaudeKeychain();
    if (keychain?.error && !fs.existsSync(file)) {
      throw new Error(`Could not read the Claude login in ${keychain.label}: ${keychain.error}`);
    }
    if (keychain?.text !== undefined) {
      let document: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(keychain.text);
        if (isObject(parsed)) { document = parsed; }
      } catch { /* An unreadable item is replaced as a whole. */ }
      const item = claudeKeychainItem();
      claudeKeychain()!.write(item.service, item.account, JSON.stringify(withClaudeLogin(document, checked)));
      return;
    }
    writeJsonAtomically(file, withClaudeLogin(readJsonObjectIfPresent(file), checked));
    return;
  }
  writeJsonAtomically(file, checked);
}

/** Claude also keeps MCP OAuth entries beside its login. Never replace those when switching accounts. */
function withClaudeLogin(document: Record<string, unknown>, checked: StoredCredential): Record<string, unknown> {
  document.claudeAiOauth = checked.claudeAiOauth;
  if (nonEmptyString(checked.organizationUuid)) {
    document.organizationUuid = checked.organizationUuid;
  } else {
    // Do not leave the previously selected account's organization attached to the new OAuth token.
    delete document.organizationUuid;
  }
  return document;
}

function nestedString(value: StoredCredential, objectKey: string, key: string): string | undefined {
  const nested = value[objectKey];
  return isObject(nested) && nonEmptyString(nested[key]) ? nested[key] : undefined;
}

/** Distinguishes ChatGPT users sharing a workspace when both logins expose the user claim. */
export function codexUsersConflict(stored: StoredCredential, native: StoredCredential): boolean {
  const user = (credential: StoredCredential): string | undefined => {
    try {
      const token = nestedString(credential, 'tokens', 'id_token');
      const claims = token && JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      const id = claims?.['https://api.openai.com/auth']?.chatgpt_user_id;
      return typeof id === 'string' && id ? id : undefined;
    } catch { return undefined; }
  };
  const a = user(stored), b = user(native);
  return Boolean(a && b && a !== b);
}

/**
 * True when a native credential can safely refresh the stored copy of the active profile.
 * Codex exposes a stable account id. Claude credentials do not carry a user id, and an organization id is not
 * an account id (several Team users share it), so only an unchanged refresh token is decisive here. Callers that
 * need to recognize a rotated Claude token must compare the OAuth profile's stable account UUID.
 */
export function isSameCredentialOwner(provider: AuthProvider, stored: StoredCredential, native: StoredCredential): boolean {
  if (JSON.stringify(stored) === JSON.stringify(native)) {
    return true;
  }
  if (provider === 'codex') {
    if (codexUsersConflict(stored, native)) return false;
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
  return false;
}
