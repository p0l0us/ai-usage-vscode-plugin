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

type CodexState = { sessionId?: string; latest?: JsonObject };
type ClaudeState = { sessionId?: string; messages: Map<string, JsonObject>; anonymous: number };

function addCodexEntry(state: CodexState, entry: JsonObject): void {
  const payload = object(entry.payload);
  if (entry.type === 'session_meta' && typeof payload?.id === 'string') {
    state.sessionId = payload.id;
  }
  if (entry.type === 'event_msg' && payload?.type === 'token_count') {
    const info = object(payload.info);
    const total = object(info?.total_token_usage);
    if (total) {
      state.latest = total;
    }
  }
}

function codexUsage(state: CodexState, updatedAt: Date): SessionTokenUsage | undefined {
  const latest = state.latest;
  if (!latest) {
    return undefined;
  }
  const inputTokens = number(latest.input_tokens);
  const outputTokens = number(latest.output_tokens);
  return {
    provider: 'codex',
    sessionId: state.sessionId,
    inputTokens,
    cachedInputTokens: number(latest.cached_input_tokens),
    outputTokens,
    totalTokens: number(latest.total_tokens) || inputTokens + outputTokens,
    updatedAt
  };
}

function addClaudeEntry(state: ClaudeState, entry: JsonObject): void {
  if (!state.sessionId && typeof entry.sessionId === 'string') {
    state.sessionId = entry.sessionId;
  }
  const message = object(entry.message);
  const usage = object(message?.usage);
  if (entry.type !== 'assistant' || !usage) {
    return;
  }
  const id = typeof message?.id === 'string' ? message.id : `anonymous-${state.anonymous++}`;
  state.messages.set(id, usage);
}

function claudeUsage(state: ClaudeState, updatedAt: Date): SessionTokenUsage | undefined {
  if (!state.messages.size) {
    return undefined;
  }
  let directInput = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  for (const usage of state.messages.values()) {
    directInput += number(usage.input_tokens) + number(usage.cache_creation_input_tokens);
    cachedInputTokens += number(usage.cache_read_input_tokens);
    outputTokens += number(usage.output_tokens);
  }
  const inputTokens = directInput + cachedInputTokens;
  return {
    provider: 'claude',
    sessionId: state.sessionId,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    updatedAt
  };
}

/** Reads the cumulative counter emitted by Codex's `token_count` session events. */
export function parseCodexSession(contents: string, updatedAt = new Date()): SessionTokenUsage | undefined {
  const state: CodexState = {};
  for (const entry of jsonLines(contents)) {
    addCodexEntry(state, entry);
  }
  return codexUsage(state, updatedAt);
}

/**
 * Sums Claude's per-request usage. Streaming updates repeat the same message id, so only the last
 * record for each id is counted. Cache reads/writes are billable input tokens and are included.
 */
export function parseClaudeSession(contents: string, updatedAt = new Date()): SessionTokenUsage | undefined {
  const state: ClaudeState = { messages: new Map(), anonymous: 0 };
  for (const entry of jsonLines(contents)) {
    addClaudeEntry(state, entry);
  }
  return claudeUsage(state, updatedAt);
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

/** Newest first; files that vanish between discovery and stat are left out. */
function byNewest(files: string[]): { file: string; modified: Date }[] {
  const found: { file: string; modified: Date }[] = [];
  for (const file of files) {
    try {
      found.push({ file, modified: fs.statSync(file).mtime });
    } catch {
      // The CLI may rotate a session between discovery and stat.
    }
  }
  return found.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

function claudeProjectDirectory(workspace: string): string {
  // This is the directory naming convention used by Claude Code for project-scoped transcripts.
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
}

const READ_CHUNK = 4 * 1024 * 1024;
const FIRST_LINE_CHUNK = 64 * 1024;
const FIRST_LINE_LIMIT = 4 * 1024 * 1024;

/** The first line of a file, read only as far as its newline; `complete` is false when the file ends before one. */
function firstLine(file: string): { text: string; complete: boolean } | undefined {
  const descriptor = fs.openSync(file, 'r');
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < FIRST_LINE_LIMIT) {
      const chunk = Buffer.allocUnsafe(FIRST_LINE_CHUNK);
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, length);
      if (read === 0) {
        return { text: Buffer.concat(chunks).toString('utf8'), complete: false };
      }
      const newline = chunk.subarray(0, read).indexOf(10);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        return { text: Buffer.concat(chunks).toString('utf8'), complete: true };
      }
      chunks.push(chunk.subarray(0, read));
      length += read;
    }
    return undefined;
  } finally {
    fs.closeSync(descriptor);
  }
}

/** The `cwd` of each Codex session's `session_meta` line, which never changes once written (null: none). */
const codexSessionCwds = new Map<string, string | null>();

function codexSessionCwd(file: string): string | undefined {
  const known = codexSessionCwds.get(file);
  if (known !== undefined) {
    return known ?? undefined;
  }
  try {
    const line = firstLine(file);
    const meta = line ? jsonLines(line.text).find((entry) => entry.type === 'session_meta') : undefined;
    const cwd = object(meta?.payload)?.cwd;
    const found = typeof cwd === 'string' ? cwd : undefined;
    // A first line still being written is read again next time.
    if (found !== undefined || !line || line.complete) {
      codexSessionCwds.set(file, found ?? null);
    }
    return found;
  } catch {
    return undefined;
  }
}

/**
 * The parse state of a session file, so a growing transcript is read only from where the last read stopped.
 * Transcripts are append-only; `guard` (the bytes just before `offset`) catches a file that was rewritten instead.
 */
type SessionRead = {
  provider: 'claude' | 'codex';
  ino: number;
  size: number;
  mtimeMs: number;
  offset: number;
  guard: Buffer;
  codex: CodexState;
  claude: ClaudeState;
};

const sessionReads = new Map<string, SessionRead>();
const MAX_SESSION_READS = 16;

function freshRead(provider: 'claude' | 'codex', stats: fs.Stats): SessionRead {
  return { provider, ino: stats.ino, size: 0, mtimeMs: 0, offset: 0, guard: Buffer.alloc(0), codex: {}, claude: { messages: new Map(), anonymous: 0 } };
}

function readSession(provider: 'claude' | 'codex', file: string, modified: Date): SessionTokenUsage | undefined {
  const stats = fs.statSync(file);
  let read = sessionReads.get(file);
  const usage = (state: SessionRead) => provider === 'claude' ? claudeUsage(state.claude, modified) : codexUsage(state.codex, modified);
  if (read && read.provider === provider && read.ino === stats.ino && read.size === stats.size && read.mtimeMs === stats.mtimeMs) {
    return usage(read);
  }
  const descriptor = fs.openSync(file, 'r');
  try {
    const appended = read && read.provider === provider && read.ino === stats.ino && stats.size > read.size;
    if (!read || !appended || !guardMatches(descriptor, read)) {
      read = freshRead(provider, stats);
    }
    const add = (entry: JsonObject) => provider === 'claude' ? addClaudeEntry(read!.claude, entry) : addCodexEntry(read!.codex, entry);
    let carry = Buffer.alloc(0);
    let position = read.offset;
    while (position < stats.size) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK, stats.size - position));
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, position);
      if (count === 0) {
        break;
      }
      position += count;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, count)]) : chunk.subarray(0, count);
      const newline = data.lastIndexOf(10);
      if (newline < 0) {
        carry = data;
        continue;
      }
      jsonLines(data.toString('utf8', 0, newline)).forEach(add);
      read.offset += newline + 1;
      carry = data.subarray(newline + 1);
    }
    // A last line without a newline counts once it parses; until then the CLI may still be appending to it.
    const tail = carry.length ? jsonLines(carry.toString('utf8')) : [];
    if (tail.length) {
      tail.forEach(add);
      read.offset += carry.length;
    }
    const guardLength = Math.min(64, read.offset);
    read.guard = Buffer.alloc(guardLength);
    if (guardLength) {
      fs.readSync(descriptor, read.guard, 0, guardLength, read.offset - guardLength);
    }
    read.size = stats.size;
    read.mtimeMs = stats.mtimeMs;
  } finally {
    fs.closeSync(descriptor);
  }
  sessionReads.delete(file);
  sessionReads.set(file, read);
  while (sessionReads.size > MAX_SESSION_READS) {
    sessionReads.delete(sessionReads.keys().next().value!);
  }
  return usage(read);
}

function guardMatches(descriptor: number, read: SessionRead): boolean {
  if (!read.guard.length) {
    return read.offset === 0;
  }
  const current = Buffer.alloc(read.guard.length);
  return fs.readSync(descriptor, current, 0, current.length, read.offset - current.length) === current.length && current.equals(read.guard);
}

export function readCurrentSessionTokens(provider: 'claude' | 'codex', workspaces: readonly string[]): SessionTokenUsage | undefined {
  let candidate: { file: string; modified: Date } | undefined;
  if (provider === 'claude') {
    const directories = workspaces.length
      ? workspaces.map(claudeProjectDirectory)
      : [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')];
    candidate = byNewest(directories.flatMap((directory) => filesIn(directory, workspaces.length === 0)))[0];
  } else {
    const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    const files = filesIn(root, true);
    const present = new Set(files);
    for (const file of codexSessionCwds.keys()) {
      if (!present.has(file)) {
        codexSessionCwds.delete(file);
      }
    }
    // Codex stores cwd in session_meta. Restrict to this workspace when possible; newest first, so usually
    // only the latest sessions' first lines are ever read.
    const resolved = workspaces.map((workspace) => path.resolve(workspace));
    candidate = byNewest(files).find(({ file }) => {
      if (!resolved.length) {
        return true;
      }
      const cwd = codexSessionCwd(file);
      return cwd !== undefined && resolved.includes(path.resolve(cwd));
    });
  }
  if (!candidate) {
    return undefined;
  }
  try {
    return readSession(provider, candidate.file, candidate.modified);
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
