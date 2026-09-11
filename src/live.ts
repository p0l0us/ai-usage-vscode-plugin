import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Live usage readers for locally installed AI CLIs and GitHub Copilot. This module must stay free of
 * `vscode` imports so it can be exercised directly with Node.
 */

export type ProviderId = 'claude' | 'codex' | 'copilot';

export type UsageWindow = {
  /** Short label such as "5h" or "7d". */
  label: string;
  /** Percentage of the window already consumed, 0-100. */
  usedPercent: number;
  resetsAt?: Date;
};

export type LiveUsage = {
  provider: ProviderId;
  title: string;
  /** Account or organization the figures belong to, when known. */
  subtitle?: string;
  plan?: string;
  windows: UsageWindow[];
  /** Extra tooltip lines. */
  details?: string[];
  fetchedAt: Date;
};

export type LiveResult =
  | { kind: 'ok'; usage: LiveUsage }
  | { kind: 'unavailable'; provider: ProviderId; reason?: string }
  | {
      kind: 'error';
      provider: ProviderId;
      title: string;
      message: string;
      /** HTTP status when the failure came from a response. */
      status?: number;
      /** True for rate limits, server errors and network failures: worth backing off and retrying. */
      transient?: boolean;
      /** Server-requested wait from a Retry-After header. */
      retryAfterMs?: number;
    };

export function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function parseRetryAfterHeader(value: string | null, now = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const REQUEST_TIMEOUT_MS = 10_000;

function readJson(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function toDate(value: unknown): Date | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds vs milliseconds since epoch.
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function clampPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

function windowLabel(seconds: number): string {
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400}d`;
  }
  if (seconds % 3_600 === 0) {
    return `${seconds / 3_600}h`;
  }
  return `${Math.round(seconds / 60)}m`;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

type JsonResponse = { status: number; body: unknown; retryAfterMs?: number };

async function fetchJson(url: string, headers: Record<string, string>): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: response.status, body, retryAfterMs: parseRetryAfterHeader(response.headers.get('retry-after')) };
  } finally {
    clearTimeout(timer);
  }
}

/** Builds the error result for a non-200 response, flagging rate limits and server errors as transient. */
function httpError(provider: ProviderId, title: string, response: JsonResponse, message?: string): LiveResult {
  const transient = isTransientStatus(response.status);
  const text = message ?? (response.status === 429 ? 'Rate limited by the service.' : `Unexpected response (HTTP ${response.status}).`);
  return { kind: 'error', provider, title, message: text, status: response.status, transient, retryAfterMs: response.retryAfterMs };
}

function networkError(provider: ProviderId, title: string, error: unknown): LiveResult {
  return { kind: 'error', provider, title, message: `Request failed: ${describeError(error)}`, transient: true };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

const CLAUDE_TITLE = 'Claude';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

type ClaudeCredentials = {
  accessToken: string;
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
};

function readClaudeCredentials(): ClaudeCredentials | undefined {
  const data = readJson(path.join(claudeConfigDir(), '.credentials.json')) as { claudeAiOauth?: Record<string, unknown> } | undefined;
  const oauth = data?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    return undefined;
  }
  return {
    accessToken: oauth.accessToken,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
    rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : undefined
  };
}

export function isClaudeAvailable(): boolean {
  return readClaudeCredentials() !== undefined;
}

type ClaudeWindow = { utilization?: number; resets_at?: string | null } | null | undefined;
type ClaudeUsageResponse = {
  five_hour?: ClaudeWindow;
  seven_day?: ClaudeWindow;
  limits?: Array<{
    kind?: string;
    percent?: number;
    resets_at?: string | null;
    scope?: { model?: { display_name?: string | null } | null } | null;
  }>;
};

export async function fetchClaudeUsage(): Promise<LiveResult> {
  const provider: ProviderId = 'claude';
  const credentials = readClaudeCredentials();
  if (!credentials) {
    return { kind: 'unavailable', provider };
  }
  if (credentials.expiresAt !== undefined && credentials.expiresAt <= Date.now()) {
    return { kind: 'error', provider, title: CLAUDE_TITLE, message: 'Login token expired. Run `claude` once to refresh it.' };
  }

  let response: JsonResponse;
  try {
    response = await fetchJson(CLAUDE_USAGE_URL, {
      Authorization: `Bearer ${credentials.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json'
    });
  } catch (error) {
    return networkError(provider, CLAUDE_TITLE, error);
  }

  if (response.status === 401 || response.status === 403) {
    return httpError(provider, CLAUDE_TITLE, response, 'Not authorized. Run `claude` once to sign in again.');
  }
  if (response.status !== 200 || typeof response.body !== 'object' || response.body === null) {
    return httpError(provider, CLAUDE_TITLE, response);
  }

  const body = response.body as ClaudeUsageResponse;
  const windows: UsageWindow[] = [];
  const fiveHour = clampPercent(body.five_hour?.utilization);
  if (fiveHour !== undefined) {
    windows.push({ label: '5h', usedPercent: fiveHour, resetsAt: toDate(body.five_hour?.resets_at) });
  }
  const sevenDay = clampPercent(body.seven_day?.utilization);
  if (sevenDay !== undefined) {
    windows.push({ label: '7d', usedPercent: sevenDay, resetsAt: toDate(body.seven_day?.resets_at) });
  }
  for (const limit of body.limits ?? []) {
    const name = limit.scope?.model?.display_name;
    const percent = clampPercent(limit.percent);
    if (limit.kind === 'weekly_scoped' && name && percent !== undefined) {
      windows.push({ label: `7d ${name}`, usedPercent: percent, resetsAt: toDate(limit.resets_at) });
    }
  }

  if (!windows.length) {
    return { kind: 'error', provider, title: CLAUDE_TITLE, message: 'Usage response contained no rate-limit windows.' };
  }

  return {
    kind: 'ok',
    usage: {
      provider,
      title: CLAUDE_TITLE,
      plan: credentials.rateLimitTier ?? credentials.subscriptionType,
      windows,
      fetchedAt: new Date()
    }
  };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const CODEX_TITLE = 'Codex';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export function codexHomeDir(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

type CodexAuth = {
  accessToken: string;
  accountId?: string;
  expiresAt?: Date;
  plan?: string;
};

function readCodexAuth(): CodexAuth | undefined {
  const data = readJson(path.join(codexHomeDir(), 'auth.json')) as { tokens?: Record<string, unknown> } | undefined;
  const tokens = data?.tokens;
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) {
    return undefined;
  }
  const accessClaims = decodeJwtPayload(tokens.access_token);
  const idClaims = typeof tokens.id_token === 'string' ? decodeJwtPayload(tokens.id_token) : undefined;
  const openaiAuth = (idClaims?.['https://api.openai.com/auth'] ?? accessClaims?.['https://api.openai.com/auth']) as
    | Record<string, unknown>
    | undefined;

  const accountId =
    (typeof tokens.account_id === 'string' && tokens.account_id) ||
    (typeof openaiAuth?.chatgpt_account_id === 'string' ? openaiAuth.chatgpt_account_id : undefined);

  return {
    accessToken: tokens.access_token,
    accountId,
    expiresAt: toDate(accessClaims?.exp),
    plan: typeof openaiAuth?.chatgpt_plan_type === 'string' ? openaiAuth.chatgpt_plan_type : undefined
  };
}

export function isCodexAvailable(): boolean {
  return readCodexAuth() !== undefined;
}

type CodexWindow = { used_percent?: number; limit_window_seconds?: number; reset_at?: number } | null | undefined;
type CodexUsageResponse = {
  plan_type?: string;
  rate_limit?: { primary_window?: CodexWindow; secondary_window?: CodexWindow } | null;
};

export async function fetchCodexUsage(): Promise<LiveResult> {
  const provider: ProviderId = 'codex';
  const auth = readCodexAuth();
  if (!auth) {
    return { kind: 'unavailable', provider };
  }
  if (auth.expiresAt && auth.expiresAt.getTime() <= Date.now()) {
    return { kind: 'error', provider, title: CODEX_TITLE, message: 'Login token expired. Run `codex` once to refresh it.' };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'ai-usage-vscode-plugin'
  };
  if (auth.accountId) {
    headers['ChatGPT-Account-Id'] = auth.accountId;
  }

  let response: JsonResponse;
  try {
    response = await fetchJson(CODEX_USAGE_URL, headers);
  } catch (error) {
    return networkError(provider, CODEX_TITLE, error);
  }

  if (response.status === 401 || response.status === 403) {
    return httpError(provider, CODEX_TITLE, response, 'Not authorized. Run `codex login` to sign in again.');
  }
  if (response.status !== 200 || typeof response.body !== 'object' || response.body === null) {
    return httpError(provider, CODEX_TITLE, response);
  }

  const body = response.body as CodexUsageResponse;
  const windows: UsageWindow[] = [];
  for (const window of [body.rate_limit?.primary_window, body.rate_limit?.secondary_window]) {
    const percent = clampPercent(window?.used_percent);
    if (!window || percent === undefined) {
      continue;
    }
    const seconds = typeof window.limit_window_seconds === 'number' ? window.limit_window_seconds : 0;
    windows.push({
      label: seconds > 0 ? windowLabel(seconds) : 'limit',
      usedPercent: percent,
      resetsAt: toDate(window.reset_at)
    });
  }

  if (!windows.length) {
    return { kind: 'error', provider, title: CODEX_TITLE, message: 'Usage response contained no rate-limit windows.' };
  }

  return {
    kind: 'ok',
    usage: {
      provider,
      title: CODEX_TITLE,
      plan: body.plan_type ?? auth.plan,
      windows,
      fetchedAt: new Date()
    }
  };
}

// --- Codex via the local CLI (app-server JSON-RPC) -----------------------------------------

type CodexRpcWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null | undefined;
type CodexRateLimitsResponse = {
  rateLimits?: {
    primary?: CodexRpcWindow;
    secondary?: CodexRpcWindow;
    planType?: string;
    credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: number | null } | null;
  } | null;
};

const CODEX_CLI_TIMEOUT_MS = 20_000;

/** Extra places to look for the codex binary when the extension host PATH is minimal. */
function cliCandidates(command: string): string[] {
  if (command.includes('/') || command.includes('\\')) {
    return [command];
  }
  const home = os.homedir();
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'share', 'pnpm'),
    path.join(home, '.volta', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin'
  ].filter(Boolean);
  const names = process.platform === 'win32' ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (!seen.has(full)) {
        seen.add(full);
        out.push(full);
      }
    }
  }
  return out;
}

export function resolveCli(command: string): string | undefined {
  for (const candidate of cliCandidates(command)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Runs `codex app-server` over stdio and asks it for the account rate limits. */
function codexRpcRateLimits(cli: string): Promise<CodexRateLimitsResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
        child.kill();
      }
    };
    const timer = setTimeout(() => finish(() => reject(new Error('codex app-server did not answer in time'))), CODEX_CLI_TIMEOUT_MS);

    child.on('error', (error) => finish(() => reject(error)));
    child.on('exit', (code) => finish(() => reject(new Error(`codex app-server exited (${code ?? 'signal'}): ${stderr.trim().slice(0, 200)}`))));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) {
          continue;
        }
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(() => reject(new Error(`initialize failed: ${message.error?.message ?? 'unknown error'}`)));
            return;
          }
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} }) + '\n');
        } else if (message.id === 2) {
          if (message.error) {
            finish(() => reject(new Error(message.error?.message ?? 'account/rateLimits/read failed')));
          } else {
            finish(() => resolve((message.result ?? {}) as CodexRateLimitsResponse));
          }
        }
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'ai-usage-vscode-plugin', title: 'AI Usage', version: '0.0.1' } }
      }) + '\n'
    );
  });
}

function codexWindowsFromRpc(limits: CodexRateLimitsResponse['rateLimits']): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const window of [limits?.primary, limits?.secondary]) {
    const percent = clampPercent(window?.usedPercent);
    if (!window || percent === undefined) {
      continue;
    }
    const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : 0;
    windows.push({ label: minutes > 0 ? windowLabel(minutes * 60) : 'limit', usedPercent: percent, resetsAt: toDate(window.resetsAt) });
  }
  return windows;
}

export async function fetchCodexUsageCli(command = 'codex'): Promise<LiveResult> {
  const provider: ProviderId = 'codex';
  if (!readCodexAuth()) {
    return { kind: 'unavailable', provider };
  }
  const cli = resolveCli(command);
  if (!cli) {
    return { kind: 'error', provider, title: CODEX_TITLE, message: `Codex CLI "${command}" not found. Set aiUsage.codex.cliPath or switch aiUsage.codex.source.` };
  }
  let response: CodexRateLimitsResponse;
  try {
    response = await codexRpcRateLimits(cli);
  } catch (error) {
    return { kind: 'error', provider, title: CODEX_TITLE, message: `Codex CLI: ${describeError(error)}`, transient: true };
  }
  const limits = response.rateLimits;
  const windows = codexWindowsFromRpc(limits);
  if (!windows.length) {
    return { kind: 'error', provider, title: CODEX_TITLE, message: 'Codex CLI returned no rate-limit windows.' };
  }
  return {
    kind: 'ok',
    usage: { provider, title: CODEX_TITLE, plan: limits?.planType ?? readCodexAuth()?.plan, windows, details: ['Source: Codex CLI (app-server)'], fetchedAt: new Date() }
  };
}

// --- Codex via local session logs (offline) -------------------------------------------------

type CodexLogRateLimits = {
  primary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
  secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
  plan_type?: string;
};

function newestFiles(dir: string, limit: number): string[] {
  const results: Array<{ file: string; mtime: number }> = [];
  const walk = (current: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && depth < 4) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          results.push({ file: full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          // skip
        }
      }
    }
  };
  walk(dir, 0);
  return results.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((entry) => entry.file);
}

/** Reads the tail of a file and returns the last rate_limits record in it, if any. */
function lastRateLimitsIn(file: string): { limits: CodexLogRateLimits; at: Date } | undefined {
  let text: string;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 512 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.includes('"rate_limits"')) {
      continue;
    }
    try {
      const record = JSON.parse(line) as { timestamp?: string; payload?: { rate_limits?: CodexLogRateLimits | null } };
      const limits = record.payload?.rate_limits;
      if (limits && (limits.primary || limits.secondary)) {
        return { limits, at: toDate(record.timestamp) ?? new Date(fs.statSync(file).mtimeMs) };
      }
    } catch {
      // partial line at the buffer start; keep going
    }
  }
  return undefined;
}

export async function fetchCodexUsageFromSessionLog(): Promise<LiveResult> {
  const provider: ProviderId = 'codex';
  const sessionsDir = path.join(codexHomeDir(), 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    return { kind: 'unavailable', provider, reason: 'No Codex session logs found.' };
  }
  let best: { limits: CodexLogRateLimits; at: Date } | undefined;
  for (const file of newestFiles(sessionsDir, 6)) {
    const found = lastRateLimitsIn(file);
    if (found && (!best || found.at > best.at)) {
      best = found;
    }
  }
  if (!best) {
    return { kind: 'error', provider, title: CODEX_TITLE, message: 'No rate-limit records in recent Codex session logs. Use Codex once, or switch aiUsage.codex.source.' };
  }
  const windows: UsageWindow[] = [];
  for (const window of [best.limits.primary, best.limits.secondary]) {
    const percent = clampPercent(window?.used_percent);
    if (!window || percent === undefined) {
      continue;
    }
    const minutes = typeof window.window_minutes === 'number' ? window.window_minutes : 0;
    windows.push({ label: minutes > 0 ? windowLabel(minutes * 60) : 'limit', usedPercent: percent, resetsAt: toDate(window.resets_at) });
  }
  if (!windows.length) {
    return { kind: 'error', provider, title: CODEX_TITLE, message: 'Codex session log record had no usable windows.' };
  }
  return {
    kind: 'ok',
    usage: {
      provider,
      title: CODEX_TITLE,
      plan: best.limits.plan_type ?? readCodexAuth()?.plan,
      windows,
      details: [`Source: Codex session log (recorded ${best.at.toLocaleString()})`],
      // The reading is as old as the last Codex turn, not as the moment we read the file.
      fetchedAt: best.at
    }
  };
}

// ---------------------------------------------------------------------------
// GitHub Copilot
// ---------------------------------------------------------------------------

const COPILOT_TITLE = 'Copilot';
const GITHUB_API = 'https://api.github.com';
const COPILOT_USER_URL = `${GITHUB_API}/copilot_internal/user`;

export type GitHubAccount = { login: string; token: string };

type CopilotQuota = {
  percent_remaining?: number;
  unlimited?: boolean;
  entitlement?: number;
  remaining?: number;
  credits_used?: number;
} | null | undefined;

type CopilotUserResponse = {
  login?: string;
  copilot_plan?: string;
  access_type_sku?: string;
  chat_enabled?: boolean;
  organization_login_list?: string[];
  quota_reset_date?: string;
  quota_snapshots?: {
    premium_interactions?: CopilotQuota;
    chat?: CopilotQuota;
    completions?: CopilotQuota;
  } | null;
};

type CopilotProbe =
  | { kind: 'ok'; account: GitHubAccount; body: CopilotUserResponse }
  | { kind: 'none'; account: GitHubAccount }
  | { kind: 'error'; account: GitHubAccount; message: string; status?: number; transient?: boolean; retryAfterMs?: number };

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ai-usage-vscode-plugin'
  };
}

async function probeCopilot(account: GitHubAccount): Promise<CopilotProbe> {
  let response: JsonResponse;
  try {
    response = await fetchJson(COPILOT_USER_URL, githubHeaders(account.token));
  } catch (error) {
    return { kind: 'error', account, message: `Request failed: ${describeError(error)}`, transient: true };
  }
  if (response.status === 401) {
    return { kind: 'error', account, message: 'GitHub token rejected. Sign in to GitHub again.', status: 401 };
  }
  if (response.status === 403 || response.status === 404) {
    return { kind: 'none', account };
  }
  if (response.status !== 200 || typeof response.body !== 'object' || response.body === null) {
    return {
      kind: 'error',
      account,
      message: response.status === 429 ? 'Rate limited by GitHub.' : `Unexpected response (HTTP ${response.status}).`,
      status: response.status,
      transient: isTransientStatus(response.status),
      retryAfterMs: response.retryAfterMs
    };
  }
  return { kind: 'ok', account, body: response.body as CopilotUserResponse };
}

export type CopilotOptions = {
  /** GitHub logins (users or organizations) owning the repositories open in the workspace. */
  workspaceOwners: string[];
  /** Login the user configured explicitly; wins over automatic selection. */
  preferredLogin?: string;
  /** Diagnostic sink. */
  log?: (message: string) => void;
};

function isOrgProvidedSeat(body: CopilotUserResponse): boolean {
  const sku = (body.access_type_sku ?? '').toLowerCase();
  const plan = (body.copilot_plan ?? '').toLowerCase();
  return sku.includes('business') || sku.includes('enterprise') || plan === 'business' || plan === 'enterprise';
}

/** Picks the account Copilot is most likely using for this workspace. */
function chooseCopilotAccount(probes: CopilotProbe[], options: CopilotOptions): CopilotProbe | undefined {
  const ok = probes.filter((probe): probe is Extract<CopilotProbe, { kind: 'ok' }> => probe.kind === 'ok');
  if (!ok.length) {
    return probes.find((probe) => probe.kind === 'error') ?? probes[0];
  }
  const preferred = options.preferredLogin?.toLowerCase();
  if (preferred) {
    const match = ok.find((probe) => probe.account.login.toLowerCase() === preferred);
    if (match) {
      return match;
    }
  }
  const owners = new Set(options.workspaceOwners.map((owner) => owner.toLowerCase()));
  const byOrg = ok.find((probe) =>
    (probe.body.organization_login_list ?? []).some((org) => owners.has(org.toLowerCase()))
  );
  if (byOrg) {
    return byOrg;
  }
  const byOwner = ok.find((probe) => owners.has(probe.account.login.toLowerCase()));
  return byOwner ?? ok[0];
}

/** Returns the organization whose Copilot budget this seat draws from, if any. */
function resolveBillingOrg(body: CopilotUserResponse, options: CopilotOptions): string | undefined {
  const orgs = body.organization_login_list ?? [];
  if (!orgs.length) {
    return undefined;
  }
  const owners = new Set(options.workspaceOwners.map((owner) => owner.toLowerCase()));
  const workspaceOrg = orgs.find((org) => owners.has(org.toLowerCase()));
  if (workspaceOrg) {
    return workspaceOrg;
  }
  // Not an org project, but the seat itself is paid by an org: name it when unambiguous.
  return isOrgProvidedSeat(body) && orgs.length === 1 ? orgs[0] : undefined;
}

type OrgSeatBilling = {
  seat_breakdown?: { total?: number; active_this_cycle?: number; pending_invitation?: number } | null;
  plan_type?: string;
};

type OrgPremiumUsage = {
  usageItems?: Array<{
    product?: string;
    sku?: string;
    model?: string;
    grossQuantity?: number;
    netQuantity?: number;
    quantity?: number;
    grossAmount?: number;
    netAmount?: number;
  }>;
};

/** Best-effort organization-level figures; these endpoints need org admin rights. */
async function fetchOrgDetails(token: string, org: string, now: Date): Promise<string[]> {
  const lines: string[] = [];
  const headers = githubHeaders(token);
  const encodedOrg = encodeURIComponent(org);
  const [seats, premium] = await Promise.all([
    fetchJson(`${GITHUB_API}/orgs/${encodedOrg}/copilot/billing`, headers).catch(() => undefined),
    fetchJson(
      `${GITHUB_API}/orgs/${encodedOrg}/settings/billing/premium_request/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`,
      headers
    ).catch(() => undefined)
  ]);

  if (seats?.status === 200 && typeof seats.body === 'object' && seats.body) {
    const body = seats.body as OrgSeatBilling;
    const breakdown = body.seat_breakdown;
    if (breakdown && typeof breakdown.total === 'number') {
      const active = typeof breakdown.active_this_cycle === 'number' ? `, ${breakdown.active_this_cycle} active this cycle` : '';
      lines.push(`Org seats: ${breakdown.total}${active}${body.plan_type ? ` (${body.plan_type})` : ''}`);
    }
  }

  if (premium?.status === 200 && typeof premium.body === 'object' && premium.body) {
    const items = (premium.body as OrgPremiumUsage).usageItems ?? [];
    let requests = 0;
    let gross = 0;
    let net = 0;
    for (const item of items) {
      requests += item.grossQuantity ?? item.quantity ?? 0;
      gross += item.grossAmount ?? 0;
      net += item.netAmount ?? 0;
    }
    const cost = gross > 0 ? `, $${net.toFixed(2)} billed of $${gross.toFixed(2)} gross` : '';
    lines.push(`Org premium requests this month: ${Math.round(requests).toLocaleString()}${cost}`);
  } else if (premium && (premium.status === 403 || premium.status === 404)) {
    lines.push('Org-wide usage report needs organization admin access.');
  }

  return lines;
}

/**
 * Reads Copilot quota for the GitHub account Copilot is using in this workspace. When the seat is
 * paid by an organization (or the workspace repository belongs to one of the account's Copilot
 * organizations) the result is labelled with that organization and, where permitted, includes
 * organization-wide figures.
 */
export async function fetchCopilotUsage(
  getAccounts: () => Promise<GitHubAccount[]>,
  options: CopilotOptions
): Promise<LiveResult> {
  const provider: ProviderId = 'copilot';
  let accounts: GitHubAccount[];
  try {
    accounts = await getAccounts();
  } catch {
    accounts = [];
  }
  const log = options.log ?? (() => undefined);
  if (!accounts.length) {
    log('Copilot: no GitHub session available to this extension (getAccounts/getSession returned nothing).');
    return { kind: 'unavailable', provider, reason: 'No GitHub sign-in is visible to this extension.' };
  }
  log(`Copilot: GitHub accounts: ${accounts.map((account) => account.login).join(', ')}; workspace owners: ${options.workspaceOwners.join(', ') || '(none)'}`);

  const probes = await Promise.all(accounts.map(probeCopilot));
  for (const probe of probes) {
    if (probe.kind === 'ok') {
      const quotas = Object.entries(probe.body.quota_snapshots ?? {})
        .map(([name, quota]) => `${name}=${quota?.unlimited ? 'unlimited' : `${quota?.percent_remaining ?? '?'}% left`}`)
        .join(' ');
      log(`Copilot: ${probe.account.login}: plan=${probe.body.copilot_plan ?? '?'} sku=${probe.body.access_type_sku ?? '?'} orgs=${(probe.body.organization_login_list ?? []).join(',') || '-'} ${quotas}`);
    } else {
      log(`Copilot: ${probe.account.login}: ${probe.kind === 'none' ? 'no Copilot seat (403/404)' : probe.message}`);
    }
  }
  const chosen = chooseCopilotAccount(probes, options);
  if (!chosen || chosen.kind === 'none') {
    return {
      kind: 'unavailable',
      provider,
      reason: `No Copilot seat found on ${accounts.map((account) => account.login).join(', ')}.`
    };
  }
  if (chosen.kind === 'error') {
    return {
      kind: 'error',
      provider,
      title: COPILOT_TITLE,
      message: `${chosen.account.login}: ${chosen.message}`,
      status: chosen.status,
      transient: chosen.transient,
      retryAfterMs: chosen.retryAfterMs
    };
  }
  log(`Copilot: using account ${chosen.account.login}`);

  const body = chosen.body;
  const now = new Date();
  const resetsAt = body.quota_reset_date ? toDate(`${body.quota_reset_date}T00:00:00Z`) : undefined;
  const windows: UsageWindow[] = [];
  const snapshots = body.quota_snapshots ?? {};
  const named: Array<[string, CopilotQuota]> = [
    ['month', snapshots.premium_interactions],
    ['chat', snapshots.chat],
    ['completions', snapshots.completions]
  ];
  for (const [label, quota] of named) {
    if (!quota || quota.unlimited) {
      continue;
    }
    const remaining = clampPercent(quota.percent_remaining);
    if (remaining === undefined) {
      continue;
    }
    windows.push({ label, usedPercent: 100 - remaining, resetsAt });
  }

  const org = resolveBillingOrg(body, options);
  const details: string[] = [`Account: ${chosen.account.login}`];
  const premium = snapshots.premium_interactions;
  if (premium && !premium.unlimited && typeof premium.entitlement === 'number' && premium.entitlement > 0) {
    const used = typeof premium.credits_used === 'number' ? premium.credits_used : premium.entitlement - (premium.remaining ?? 0);
    details.push(`Premium requests: ${Math.round(used).toLocaleString()} of ${premium.entitlement.toLocaleString()}`);
  }
  if (org) {
    details.push(`Billed to organization: ${org}`);
    details.push(...(await fetchOrgDetails(chosen.account.token, org, now)));
  }

  if (!windows.length) {
    return {
      kind: 'unavailable',
      provider,
      reason: `${chosen.account.login}${org ? ` (${org})` : ''}: every Copilot quota is unlimited on the ${body.copilot_plan ?? 'current'} plan.`
    };
  }

  return {
    kind: 'ok',
    usage: {
      provider,
      title: COPILOT_TITLE,
      subtitle: org ?? chosen.account.login,
      plan: body.copilot_plan,
      windows,
      details,
      fetchedAt: now
    }
  };
}

// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? 'timed out' : error.message;
  }
  return String(error);
}

export function formatResetIn(resetsAt: Date | undefined, now = new Date()): string {
  if (!resetsAt) {
    return '';
  }
  const diffMinutes = Math.max(0, Math.round((resetsAt.getTime() - now.getTime()) / 60_000));
  if (diffMinutes < 60) {
    return `resets in ${diffMinutes}m`;
  }
  const hours = Math.floor(diffMinutes / 60);
  if (hours < 48) {
    const minutes = diffMinutes % 60;
    return minutes ? `resets in ${hours}h ${minutes}m` : `resets in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `resets in ${days}d ${remHours}h` : `resets in ${days}d`;
}
