import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AuthProvider, StoredCredential } from './authFiles';

/**
 * Resolves the login email behind a saved credential so profiles can show which account they hold.
 * Codex carries it in the id token. Claude's credentials file has no identity, so the OAuth profile
 * endpoint is asked with the access token; the account file Claude Code keeps beside its config is the
 * offline fallback when its organization matches the credential.
 */

const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const PROFILE_TIMEOUT_MS = 8_000;

export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function emailString(value: unknown): string | undefined {
  return typeof value === 'string' && value.includes('@') ? value.trim() : undefined;
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** Codex: the `email` claim of the stored id token. */
export function codexCredentialEmail(credential: StoredCredential): string | undefined {
  const idToken = nested(credential.tokens, 'id_token');
  return typeof idToken === 'string' ? emailString(decodeJwtClaims(idToken)?.email) : undefined;
}

/** Claude Code's account file: `~/.claude.json` by default, or inside `CLAUDE_CONFIG_DIR` when that is set. */
export function claudeAccountFile(): string {
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

/** Claude, offline: the account file's email when it belongs to the credential's organization. */
export function claudeAccountFileEmail(credential: StoredCredential, file = claudeAccountFile()): string | undefined {
  try {
    const account = nested(JSON.parse(fs.readFileSync(file, 'utf8')), 'oauthAccount');
    const organization = nested(account, 'organizationUuid');
    if (typeof credential.organizationUuid === 'string' && organization !== credential.organizationUuid) {
      return undefined;
    }
    return emailString(nested(account, 'emailAddress'));
  } catch {
    return undefined;
  }
}

/** Claude, online: the OAuth profile of the access token. Read-only and not counted against usage. */
export async function fetchClaudeProfileEmail(credential: StoredCredential, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const accessToken = nested(credential.claudeAiOauth, 'accessToken');
  if (typeof accessToken !== 'string' || !accessToken) {
    return undefined;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(CLAUDE_PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      signal: controller.signal
    });
    if (response.status !== 200) {
      return undefined;
    }
    return emailString(nested(nested(await response.json(), 'account'), 'email'));
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Best available email for a credential; undefined when nothing identifies it. Never throws. */
export async function resolveCredentialEmail(provider: AuthProvider, credential: StoredCredential): Promise<string | undefined> {
  if (provider === 'codex') {
    return codexCredentialEmail(credential);
  }
  return await fetchClaudeProfileEmail(credential) ?? claudeAccountFileEmail(credential);
}
