import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AuthProvider, StoredCredential, writeJsonAtomically } from './authFiles';

/**
 * Resolves the login email behind a saved credential so profiles can show which account they hold.
 * Codex carries it in the id token. Claude's credentials file has no identity, so the OAuth profile
 * endpoint is asked with the access token; the account file Claude Code keeps beside its config is the
 * offline fallback when its organization matches the credential.
 */

const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const PROFILE_TIMEOUT_MS = 8_000;

export type CredentialIdentity = {
  email?: string;
  /** Stable vendor account identifier. Unlike an organization id, this distinguishes team members. */
  accountId?: string;
};

type ClaudeProfile = {
  account: {
    uuid: string;
    email: string;
    full_name?: string;
    display_name?: string;
    created_at?: string;
  };
  organization?: {
    uuid?: string;
    name?: string;
    organization_type?: string;
    billing_type?: string;
    rate_limit_tier?: string;
    seat_tier?: string;
    has_extra_usage_enabled?: boolean;
    subscription_created_at?: string;
    cc_onboarding_flags?: Record<string, unknown>;
    claude_code_trial_ends_at?: unknown;
    claude_code_trial_duration_days?: unknown;
  };
};

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

/** Claude, offline: use cached identity only when a stable account UUID proves it belongs to the credential. */
export function claudeAccountFileEmail(credential: StoredCredential, file = claudeAccountFile()): string | undefined {
  try {
    const account = nested(JSON.parse(fs.readFileSync(file, 'utf8')), 'oauthAccount');
    const expected = credential.accountUuid;
    if (typeof expected !== 'string' || nested(account, 'accountUuid') !== expected) {
      return undefined;
    }
    return emailString(nested(account, 'emailAddress'));
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Why a profile lookup did not produce an identity, so a log line can tell 401 from 429 from an outage. */
export type ClaudeProfileResult = {
  profile?: ClaudeProfile;
  /** HTTP status when the endpoint answered at all. */
  status?: number;
  /** What the endpoint asked callers to wait, from `Retry-After`. */
  retryAfterMs?: number;
  /** Human-readable reason; undefined only when a profile was returned. */
  error?: string;
};

/** `Retry-After` is either a delay in seconds or an HTTP date. Anything else is ignored. */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Claude, online: the OAuth profile of the access token. Read-only and not counted against usage. */
export async function fetchClaudeProfileResult(credential: StoredCredential, fetchImpl: typeof fetch = fetch): Promise<ClaudeProfileResult> {
  const accessToken = nested(credential.claudeAiOauth, 'accessToken');
  if (typeof accessToken !== 'string' || !accessToken) {
    return { error: 'the credential carries no access token' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(CLAUDE_PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      signal: controller.signal
    });
    if (response.status !== 200) {
      // Test doubles and non-standard responses may omit headers; only ask for one when it is there.
      const headers = (response as Partial<Response>).headers;
      const retryAfterMs = typeof headers?.get === 'function' ? parseRetryAfterMs(headers.get('retry-after')) : undefined;
      return { status: response.status, retryAfterMs, error: `the profile endpoint answered HTTP ${response.status}` };
    }
    const body = objectValue(await response.json());
    const account = objectValue(body?.account);
    const organization = objectValue(body?.organization);
    const uuid = account?.uuid;
    const email = emailString(account?.email);
    if (typeof uuid !== 'string' || !uuid || !email) {
      return { status: 200, error: 'the profile response carried no account' };
    }
    return { profile: { account: { ...account, uuid, email } as ClaudeProfile['account'], organization: organization as ClaudeProfile['organization'] } };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return { error: aborted ? `the profile endpoint did not answer within ${PROFILE_TIMEOUT_MS / 1000}s` : `the profile endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchClaudeProfile(credential: StoredCredential, fetchImpl: typeof fetch = fetch): Promise<ClaudeProfile | undefined> {
  return (await fetchClaudeProfileResult(credential, fetchImpl)).profile;
}

export async function fetchClaudeProfileEmail(credential: StoredCredential, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  return (await fetchClaudeProfile(credential, fetchImpl))?.account.email;
}

/** Claude Code caches these per account; leaving them behind shows the previous account's usage and models. */
const ACCOUNT_BOUND_CACHE_KEYS = [
  'cachedUsageUtilization', 'cachedExtraUsageDisabledReason', 'hasAvailableSubscription',
  'clientDataCacheSlots', 'additionalModelOptionsCache', 'additionalModelOptionsAnsweredAt',
  'modelAccessCache', 'orgModelDefaultCache', 'autoCompactWindowsCache'
];

/**
 * Makes Claude Code's identity and usage UI agree with the OAuth credential that was activated. The account file
 * also contains user settings, so only `oauthAccount` is replaced and known account-bound caches are invalidated.
 */
export function syncClaudeAccountFile(profile: ClaudeProfile, file = claudeAccountFile(), now = Date.now()): void {
  let document: Record<string, unknown> = {};
  try {
    document = objectValue(JSON.parse(fs.readFileSync(file, 'utf8'))) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Could not preserve the existing ${file}: ${String(error)}`);
    }
  }
  const account = profile.account;
  const organization = profile.organization ?? {};
  const entries: Array<[string, unknown]> = [
    ['accountUuid', account.uuid],
    ['emailAddress', account.email],
    ['organizationUuid', organization.uuid],
    ['hasExtraUsageEnabled', organization.has_extra_usage_enabled],
    ['billingType', organization.billing_type],
    ['accountCreatedAt', account.created_at],
    ['subscriptionCreatedAt', organization.subscription_created_at],
    ['ccOnboardingFlags', organization.cc_onboarding_flags],
    ['claudeCodeTrialEndsAt', organization.claude_code_trial_ends_at],
    ['claudeCodeTrialDurationDays', organization.claude_code_trial_duration_days],
    ['seatTier', organization.seat_tier],
    ['displayName', account.display_name],
    ['fullName', account.full_name],
    ['profileFetchedAt', now],
    ['organizationName', organization.name],
    ['organizationType', organization.organization_type],
    ['organizationRateLimitTier', organization.rate_limit_tier]
  ];
  document.oauthAccount = Object.fromEntries(entries.filter(([, value]) => value !== undefined));
  for (const key of ACCOUNT_BOUND_CACHE_KEYS) {
    delete document[key];
  }
  writeJsonAtomically(file, document);
}

/**
 * Drops an account identity that belongs to a login other than `expected` so Claude Code cannot keep reporting the
 * previous account. What is known about the activated profile is written back; the rest is left for Claude Code to
 * fetch on its next start. Returns what happened, for the log line.
 */
export function replaceStaleClaudeAccount(expected: CredentialIdentity, file = claudeAccountFile()): 'replaced' | 'removed' | 'kept' {
  let document: Record<string, unknown>;
  try {
    document = objectValue(JSON.parse(fs.readFileSync(file, 'utf8'))) ?? {};
  } catch {
    // No account file means no stale identity; an unreadable one must not break the switch.
    return 'kept';
  }
  const account = objectValue(document.oauthAccount);
  if (!account) {
    return 'kept';
  }
  const uuid = account.accountUuid;
  const email = emailString(account.emailAddress);
  // Already the activated account: keep Claude Code's own (richer) metadata rather than trimming it.
  if ((expected.accountId && uuid === expected.accountId) || (!expected.accountId && expected.email && email === expected.email)) {
    return 'kept';
  }
  // Omit profileFetchedAt so Claude Code refreshes the rest of the metadata for itself.
  const identity = Object.fromEntries(([['accountUuid', expected.accountId], ['emailAddress', expected.email]] as Array<[string, unknown]>)
    .filter(([, value]) => value !== undefined));
  if (Object.keys(identity).length > 0) {
    document.oauthAccount = identity;
  } else {
    delete document.oauthAccount;
  }
  for (const key of ACCOUNT_BOUND_CACHE_KEYS) {
    delete document[key];
  }
  writeJsonAtomically(file, document);
  return Object.keys(identity).length > 0 ? 'replaced' : 'removed';
}

/**
 * True when Claude Code's account file already carries a fetched identity for `expected`, which happens once Claude
 * Code refreshes its own profile after a switch. A retry has nothing left to correct and can stop asking.
 */
export function claudeAccountFileConfirms(expected: CredentialIdentity, file = claudeAccountFile()): boolean {
  if (!expected.accountId) {
    return false;
  }
  try {
    const account = objectValue(nested(JSON.parse(fs.readFileSync(file, 'utf8')), 'oauthAccount'));
    return account?.accountUuid === expected.accountId && typeof account?.profileFetchedAt === 'number';
  } catch {
    return false;
  }
}

export type ClaudeAccountActivation = {
  /** `synced`: the live profile was written. Otherwise the identity is unconfirmed and worth retrying. */
  status: 'synced' | 'unconfirmed';
  identity?: CredentialIdentity;
  detail: string;
  /** Present when unconfirmed: what the endpoint asked callers to wait before trying again. */
  retryAfterMs?: number;
};

/**
 * Fetches the activated Claude token's identity and updates Claude Code's metadata, which is what `/status` and
 * `/usage` display. When the endpoint cannot be reached the previous account's identity is still removed, because
 * reporting the account that was just switched away from is worse than reporting an incomplete one.
 */
export async function activateClaudeAccountMetadata(
  credential: StoredCredential,
  expected: CredentialIdentity = {},
  fetchImpl: typeof fetch = fetch,
  file = claudeAccountFile()
): Promise<ClaudeAccountActivation> {
  const outcome = await fetchClaudeProfileResult(credential, fetchImpl);
  if (outcome.profile) {
    syncClaudeAccountFile(outcome.profile, file);
    const identity = { accountId: outcome.profile.account.uuid, email: outcome.profile.account.email };
    return { status: 'synced', identity, detail: `Claude reports login ${identity.email}.` };
  }
  let cleared: 'replaced' | 'removed' | 'kept' = 'kept';
  try {
    cleared = replaceStaleClaudeAccount(expected, file);
  } catch (error) {
    return {
      status: 'unconfirmed',
      detail: `${outcome.error}, and the account metadata could not be corrected: ${error instanceof Error ? error.message : String(error)}`,
      retryAfterMs: outcome.retryAfterMs
    };
  }
  const consequence = cleared === 'replaced'
    ? `the saved profile's identity (${expected.email ?? expected.accountId}) was written to the account file instead`
    : cleared === 'removed'
      ? 'the previous account identity was removed from the account file so Claude Code fetches its own'
      : 'the account file already names the activated login';
  return { status: 'unconfirmed', identity: cleared === 'kept' ? undefined : expected, detail: `${outcome.error}; ${consequence}.`, retryAfterMs: outcome.retryAfterMs };
}

/** Best available email for a credential; undefined when nothing identifies it. Never throws. */
export async function resolveCredentialEmail(provider: AuthProvider, credential: StoredCredential): Promise<string | undefined> {
  return (await resolveCredentialIdentity(provider, credential)).email;
}

/** Best available stable identity for a saved credential. Never throws. */
export async function resolveCredentialIdentity(provider: AuthProvider, credential: StoredCredential): Promise<CredentialIdentity> {
  if (provider === 'codex') {
    const tokens = objectValue(credential.tokens);
    return {
      email: codexCredentialEmail(credential),
      accountId: typeof tokens?.account_id === 'string' && tokens.account_id ? tokens.account_id : undefined
    };
  }
  const profile = await fetchClaudeProfile(credential);
  if (profile) {
    return { email: profile.account.email, accountId: profile.account.uuid };
  }
  return { email: claudeAccountFileEmail(credential), accountId: typeof credential.accountUuid === 'string' ? credential.accountUuid : undefined };
}
