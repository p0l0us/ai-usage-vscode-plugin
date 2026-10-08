import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { writeTextAtomically } from './authFiles';

/**
 * The `[model_providers.ai-usage]` entry AI Usage manages in Codex's `config.toml`.
 *
 * Codex reads `config.toml` every time a chat starts (`thread/start`), so pointing `model_provider` at the local
 * account proxy takes effect for new chats without restarting Codex or VS Code, and removing it again restores
 * the native path just as quickly. Only the block between the two marker comments and the root-level
 * `model_provider` key are ever touched; every other line of the user's file is preserved byte for byte, and the
 * user's own `model_provider` line is recorded inside the block so removing it puts that line back.
 */

export const CODEX_PROXY_PROVIDER_ID = 'ai-usage';
const PROVIDER_TABLE = `[model_providers.${CODEX_PROXY_PROVIDER_ID}]`;
const BEGIN_MARKER = '# >>> ai-usage: Codex account proxy (managed by the AI Usage extension; do not edit) >>>';
const END_MARKER = '# <<< ai-usage: Codex account proxy <<<';
/** Records the user's own root `model_provider` line (JSON string) or `null` when there was none. */
const PREVIOUS_PREFIX = '# ai-usage.previous_model_provider = ';
/** Marks the root-level line the extension wrote, telling it apart from a line the user wrote. */
const OWN_LINE_SUFFIX = ' # managed by ai-usage';
const OWN_LINE = `model_provider = "${CODEX_PROXY_PROVIDER_ID}"${OWN_LINE_SUFFIX}`;

export type CodexProxyProviderConfig = {
  /** `http://127.0.0.1:<port>/v1`; Codex appends `/responses`. */
  baseUrl: string;
  /** Bearer token Codex sends with every request so only Codex, not any local page, can use the proxy. */
  secret: string;
};

/** TOML basic string. JSON escaping is a subset of TOML's, and only ASCII values are written here. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function isTableHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

function isModelProviderAssignment(line: string): boolean {
  return /^\s*model_provider\s*=/.test(line);
}

function renderBlock(config: CodexProxyProviderConfig, previous: string | null): string[] {
  return [
    BEGIN_MARKER,
    `${PREVIOUS_PREFIX}${JSON.stringify(previous)}`,
    PROVIDER_TABLE,
    'name = "AI Usage · active Codex account"',
    `base_url = ${tomlString(config.baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    `http_headers = { Authorization = ${tomlString(`Bearer ${config.secret}`)} }`,
    END_MARKER
  ];
}

type Stripped = {
  /** The file without the managed block and without any unmarked copy of the provider table. */
  lines: string[];
  eol: string;
  /** What the removed block recorded: a user line, `null` for "none", `undefined` when there was no block. */
  previous: string | null | undefined;
  secret?: string;
  hadBlock: boolean;
};

function strip(text: string): Stripped {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines: string[] = [];
  let previous: string | null | undefined;
  let secret: string | undefined;
  let hadBlock = false;
  let inBlock = false;
  let inStrayTable = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === BEGIN_MARKER) {
      inBlock = true;
      hadBlock = true;
      continue;
    }
    if (inBlock) {
      if (line.trim() === END_MARKER) {
        inBlock = false;
        continue;
      }
      if (line.startsWith(PREVIOUS_PREFIX)) {
        try {
          const recorded: unknown = JSON.parse(line.slice(PREVIOUS_PREFIX.length));
          previous = typeof recorded === 'string' ? recorded : null;
        } catch {
          previous = null;
        }
      }
      const match = /^\s*http_headers\s*=.*"Bearer ([^"\\]+)"/.exec(line);
      if (match) {
        secret = match[1];
      }
      continue;
    }
    // A copy of the table outside the markers (for example after a manual edit) would shadow ours; drop it.
    if (line.trim() === PROVIDER_TABLE) {
      inStrayTable = true;
      continue;
    }
    if (inStrayTable) {
      if (!isTableHeader(line)) {
        continue;
      }
      inStrayTable = false;
    }
    lines.push(line);
  }
  if (hadBlock && previous === undefined) {
    previous = null;
  }
  return { lines, eol, previous, secret, hadBlock };
}

/** Index of the first table header; root-level keys must stay before it. */
function rootEnd(lines: string[]): number {
  const index = lines.findIndex(isTableHeader);
  return index === -1 ? lines.length : index;
}

function ownLineIndex(lines: string[]): number {
  const end = rootEnd(lines);
  return lines.findIndex((line, index) => index < end && isModelProviderAssignment(line) && line.endsWith(OWN_LINE_SUFFIX));
}

function trimTrailingBlankLines(lines: string[]): void {
  while (lines.length && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
}

/** True when the file selects the proxy provider and carries the managed block. */
export function hasCodexProxyProvider(text: string): boolean {
  const stripped = strip(text);
  return stripped.hadBlock && ownLineIndex(stripped.lines) >= 0;
}

/** The bearer token recorded in the managed block, so a new owner window keeps serving running chats. */
export function readCodexProxySecret(text: string): string | undefined {
  return strip(text).secret;
}

/** Returns the config text with the proxy provider selected. Idempotent; unrelated content is untouched. */
export function applyCodexProxyProvider(text: string, config: CodexProxyProviderConfig): string {
  const stripped = strip(text);
  const lines = stripped.lines;
  const end = rootEnd(lines);
  let previous: string | null = stripped.previous ?? null;
  const index = lines.findIndex((line, position) => position < end && isModelProviderAssignment(line));
  if (index >= 0) {
    if (!lines[index].endsWith(OWN_LINE_SUFFIX)) {
      // The user's line, possibly written after an earlier apply; it is what removal must restore.
      previous = lines[index];
    }
    lines[index] = OWN_LINE;
  } else {
    // No selection at all (or the user deleted ours): nothing to restore later. Insert before the first table.
    previous = null;
    let insertAt = end;
    while (insertAt > 0 && lines[insertAt - 1].trim() === '') {
      insertAt--;
    }
    const followedByContent = insertAt < lines.length && lines[insertAt].trim() !== '';
    lines.splice(insertAt, 0, OWN_LINE, ...(followedByContent ? [''] : []));
  }
  trimTrailingBlankLines(lines);
  if (lines.length) {
    lines.push('');
  }
  lines.push(...renderBlock(config, previous));
  return lines.join(stripped.eol) + stripped.eol;
}

/** Returns the config text without the proxy provider, restoring the user's `model_provider` line if any. */
export function removeCodexProxyProvider(text: string): string {
  const stripped = strip(text);
  const lines = stripped.lines;
  const index = ownLineIndex(lines);
  if (!stripped.hadBlock && index < 0 && lines.join(stripped.eol) === text) {
    return text;
  }
  if (index >= 0) {
    if (typeof stripped.previous === 'string') {
      lines[index] = stripped.previous;
    } else {
      lines.splice(index, 1);
      // The blank line that separated the managed line from a following table goes with it.
      if (index < lines.length && lines[index].trim() === '' && (index === 0 || lines[index - 1].trim() === '')) {
        lines.splice(index, 1);
      }
    }
  }
  trimTrailingBlankLines(lines);
  return lines.length ? lines.join(stripped.eol) + stripped.eol : '';
}

export function codexConfigPath(home: string): string {
  return path.join(home, 'config.toml');
}

export function readCodexConfigText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

/** Writes the provider into `file`; returns whether the file changed. */
export function applyCodexProxyProviderToFile(file: string, config: CodexProxyProviderConfig): boolean {
  const before = readCodexConfigText(file);
  const after = applyCodexProxyProvider(before, config);
  if (after === before) {
    return false;
  }
  writeTextAtomically(file, after);
  return true;
}

/** Removes the provider from `file`; an emptied file is deleted. Returns whether anything changed. */
export function removeCodexProxyProviderFromFile(file: string): boolean {
  const before = readCodexConfigText(file);
  const after = removeCodexProxyProvider(before);
  if (after === before) {
    return false;
  }
  if (after === '') {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return true;
  }
  writeTextAtomically(file, after);
  return true;
}

/** A fresh bearer token for the provider block. */
export function newCodexProxySecret(): string {
  return randomUUID().replace(/-/g, '');
}
