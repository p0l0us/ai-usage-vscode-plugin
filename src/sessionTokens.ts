import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderId } from './live';

export type SessionTokenUsage = {
  provider: Extract<ProviderId, 'claude' | 'codex'>;
  sessionId?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  updatedAt: Date;
};

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null ? value as JsonObject : undefined;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function jsonLines(contents: string): JsonObject[] {
  const result: JsonObject[] = [];
  for (const line of contents.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = object(JSON.parse(line));
      if (parsed) {
        result.push(parsed);
      }
    } catch {
      // A session can be read while the CLI is appending its final JSON line.
    }
  }
  return result;
}

/** Reads the cumulative counter emitted by Codex's `token_count` session events. */
export function parseCodexSession(contents: string, updatedAt = new Date()): SessionTokenUsage | undefined {
  let sessionId: string | undefined;
  let latest: JsonObject | undefined;
  for (const entry of jsonLines(contents)) {
    const payload = object(entry.payload);
    if (entry.type === 'session_meta' && typeof payload?.id === 'string') {
      sessionId = payload.id;
    }
    if (entry.type === 'event_msg' && payload?.type === 'token_count') {
      const info = object(payload.info);
      const total = object(info?.total_token_usage);
      if (total) {
        latest = total;
      }
    }
  }
  if (!latest) {
    return undefined;
  }
  const inputTokens = number(latest.input_tokens);
  const outputTokens = number(latest.output_tokens);
  return {
    provider: 'codex',
    sessionId,
    inputTokens,
    cachedInputTokens: number(latest.cached_input_tokens),
    outputTokens,
    totalTokens: number(latest.total_tokens) || inputTokens + outputTokens,
    updatedAt
  };
}

/**
 * Sums Claude's per-request usage. Streaming updates repeat the same message id, so only the last
 * record for each id is counted. Cache reads/writes are billable input tokens and are included.
 */
export function parseClaudeSession(contents: string, updatedAt = new Date()): SessionTokenUsage | undefined {
  let sessionId: string | undefined;
  const messages = new Map<string, JsonObject>();
  let anonymous = 0;
  for (const entry of jsonLines(contents)) {
    if (!sessionId && typeof entry.sessionId === 'string') {
      sessionId = entry.sessionId;
    }
    const message = object(entry.message);
    const usage = object(message?.usage);
    if (entry.type !== 'assistant' || !usage) {
      continue;
    }
    const id = typeof message?.id === 'string' ? message.id : `anonymous-${anonymous++}`;
    messages.set(id, usage);
  }
  if (!messages.size) {
    return undefined;
  }
  let directInput = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  for (const usage of messages.values()) {
    directInput += number(usage.input_tokens) + number(usage.cache_creation_input_tokens);
    cachedInputTokens += number(usage.cache_read_input_tokens);
    outputTokens += number(usage.output_tokens);
  }
  const inputTokens = directInput + cachedInputTokens;
  return {
    provider: 'claude',
    sessionId,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    updatedAt
  };
}

function filesIn(directory: string, recursive: boolean): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return recursive ? filesIn(file, true) : [];
      }
      return entry.isFile() && entry.name.endsWith('.jsonl') ? [file] : [];
    });
  } catch {
    return [];
  }
}

function newest(files: string[]): { file: string; modified: Date } | undefined {
  let found: { file: string; modified: Date } | undefined;
  for (const file of files) {
    try {
      const modified = fs.statSync(file).mtime;
      if (!found || modified > found.modified) {
        found = { file, modified };
      }
    } catch {
      // The CLI may rotate a session between discovery and stat.
    }
  }
  return found;
}

function claudeProjectDirectory(workspace: string): string {
  // This is the directory naming convention used by Claude Code for project-scoped transcripts.
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
}

const sessionReadCache = new Map<string, { file: string; modifiedMs: number; size: number; usage: SessionTokenUsage }>();

export function readCurrentSessionTokens(provider: 'claude' | 'codex', workspaces: readonly string[]): SessionTokenUsage | undefined {
  let candidate: { file: string; modified: Date } | undefined;
  if (provider === 'claude') {
    const directories = workspaces.length
      ? workspaces.map(claudeProjectDirectory)
      : [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')];
    candidate = newest(directories.flatMap((directory) => filesIn(directory, workspaces.length === 0)));
  } else {
    const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    const candidates = filesIn(root, true);
    // Codex stores cwd in session_meta. Restrict to this workspace when possible.
    const matching = workspaces.length ? candidates.filter((file) => {
      try {
        const descriptor = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(1024 * 1024);
        const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
        fs.closeSync(descriptor);
        const firstLine = buffer.toString('utf8', 0, length).split('\n', 1)[0];
        const meta = jsonLines(firstLine).find((entry) => entry.type === 'session_meta');
        const cwd = object(meta?.payload)?.cwd;
        return typeof cwd === 'string' && workspaces.some((workspace) => path.resolve(cwd) === path.resolve(workspace));
      } catch {
        return false;
      }
    }) : candidates;
    candidate = newest(matching);
  }
  if (!candidate) {
    return undefined;
  }
  try {
    const stats = fs.statSync(candidate.file);
    const cacheKey = `${provider}:${workspaces.join('\0')}`;
    const cached = sessionReadCache.get(cacheKey);
    if (cached?.file === candidate.file && cached.modifiedMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.usage;
    }
    const contents = fs.readFileSync(candidate.file, 'utf8');
    const usage = provider === 'claude'
      ? parseClaudeSession(contents, candidate.modified)
      : parseCodexSession(contents, candidate.modified);
    if (usage) {
      sessionReadCache.set(cacheKey, { file: candidate.file, modifiedMs: stats.mtimeMs, size: stats.size, usage });
    }
    return usage;
  } catch {
    return undefined;
  }
}

/** Compact, stable labels keep the generated chat-menu command set reasonably small. */
export function compactTokenCount(tokens: number): string {
  const scales = [
    { limit: 1_000, step: 100, suffix: '', divisor: 1 },
    { limit: 10_000, step: 1_000, suffix: 'k', divisor: 1_000 },
    { limit: 100_000, step: 10_000, suffix: 'k', divisor: 1_000 },
    { limit: 1_000_000, step: 100_000, suffix: 'k', divisor: 1_000 },
    { limit: 10_000_000, step: 1_000_000, suffix: 'm', divisor: 1_000_000 },
    { limit: 100_000_000, step: 10_000_000, suffix: 'm', divisor: 1_000_000 },
    { limit: 1_000_000_000, step: 100_000_000, suffix: 'm', divisor: 1_000_000 }
  ];
  const safe = Math.max(0, tokens);
  const scale = scales.find((entry) => safe < entry.limit);
  if (!scale) {
    return '1b+';
  }
  const rounded = Math.round(safe / scale.step) * scale.step / scale.divisor;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${scale.suffix}`;
}
