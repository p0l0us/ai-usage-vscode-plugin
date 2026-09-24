import { readCodexConfigText } from './codexConfig';
import { writeTextAtomically } from './authFiles';

/**
 * Codex `config.toml` keys that AI Usage exposes as `aiUsage.codexConfig.*` settings.
 *
 * A setting left at `null` is not managed: the file keeps whatever the user (or Codex) wrote. A set value is written
 * into its table when the extension starts and whenever the setting changes; Codex re-reads `config.toml` when a
 * chat starts, so new chats pick it up. Only the one `key = value` line is touched (its trailing comment is kept),
 * every other line of the file stays byte for byte, and a missing table is added before the account proxy's managed
 * block so that block stays last.
 */

export type CodexSettingValue = number | string | boolean;

export type CodexSetting = {
  /** VS Code setting id. */
  setting: string;
  /** Codex table, e.g. `agents` for `[agents]`. */
  table: string;
  key: string;
  /** Smallest accepted value; every exposed key is a positive integer today. */
  minimum: number;
};

export const CODEX_SETTINGS: readonly CodexSetting[] = [
  { setting: 'aiUsage.codexConfig.agents.maxConcurrentThreadsPerSession', table: 'agents', key: 'max_concurrent_threads_per_session', minimum: 1 },
  { setting: 'aiUsage.codexConfig.agents.maxDepth', table: 'agents', key: 'max_depth', minimum: 1 },
  { setting: 'aiUsage.codexConfig.agents.jobMaxRuntimeSeconds', table: 'agents', key: 'job_max_runtime_seconds', minimum: 1 }
];

export type CodexSettingAssignment = CodexSetting & { value: CodexSettingValue };

/**
 * The settings that carry a value, read through `get` (the VS Code configuration in the extension). `null`,
 * `undefined` and invalid values are left out and reported through `onInvalid`, so the file is never given a value
 * Codex would reject.
 */
export function readCodexSettingAssignments(get: (setting: string) => unknown, onInvalid?: (setting: CodexSetting, value: unknown) => void): CodexSettingAssignment[] {
  const assignments: CodexSettingAssignment[] = [];
  for (const setting of CODEX_SETTINGS) {
    const value = get(setting.setting);
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < setting.minimum) {
      onInvalid?.(setting, value);
      continue;
    }
    assignments.push({ ...setting, value });
  }
  return assignments;
}

/** Matches the start of the account proxy block in `codexConfig.ts`. */
const PROXY_BLOCK_PREFIX = '# >>> ai-usage:';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlValue(value: CodexSettingValue): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function isTableHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

function headerPattern(table: string): RegExp {
  return new RegExp(`^\\s*\\[\\s*${escapeRegExp(table)}\\s*\\]\\s*(#.*)?$`);
}

function keyPattern(key: string, prefix = ''): RegExp {
  return new RegExp(`^(\\s*${prefix}${escapeRegExp(key)}\\s*=\\s*)(.*)$`);
}

/** Splits `value # comment` into the value and the comment (with its leading whitespace), ignoring `#` in strings. */
function splitComment(rest: string): [string, string] {
  let quote: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const char = rest[index];
    if (quote) {
      if (char === '\\' && quote === '"') {
        index++;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#') {
      const valueEnd = rest.slice(0, index).trimEnd().length;
      return [rest.slice(0, valueEnd), rest.slice(valueEnd)];
    }
  }
  return [rest.trimEnd(), ''];
}

/** Replaces the value on `lines[index]`; returns whether it changed. */
function replaceValue(lines: string[], index: number, pattern: RegExp, value: string): boolean {
  const match = pattern.exec(lines[index]);
  if (!match) {
    return false;
  }
  const [current, comment] = splitComment(match[2]);
  if (current === value) {
    return false;
  }
  lines[index] = `${match[1]}${value}${comment}`;
  return true;
}

/**
 * Returns `text` with `table.key = value`. Handles an existing `[table]` section, a root-level dotted
 * `table.key = …` line, or neither (a new section is added). Idempotent.
 */
export function setCodexConfigValue(text: string, table: string, key: string, value: CodexSettingValue): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const hadFinalNewline = text === '' || /\r?\n$/.test(text);
  if (hadFinalNewline && lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const rendered = tomlValue(value);
  const finish = () => lines.join(eol) + eol;

  const header = headerPattern(table);
  const start = lines.findIndex((line) => header.test(line));
  if (start >= 0) {
    // The section ends at the next table or at the account proxy block, which always starts with its marker.
    let end = lines.findIndex((line, index) => index > start && (isTableHeader(line) || line.startsWith(PROXY_BLOCK_PREFIX)));
    if (end === -1) {
      end = lines.length;
    }
    const pattern = keyPattern(key);
    const existing = lines.findIndex((line, index) => index > start && index < end && pattern.test(line));
    if (existing >= 0) {
      return replaceValue(lines, existing, pattern, rendered) ? finish() : text;
    }
    // After the table's last non-blank line, so blank separators and comments before the next table stay put.
    let insertAt = end;
    while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') {
      insertAt--;
    }
    lines.splice(insertAt, 0, `${key} = ${rendered}`);
    return finish();
  }

  // A root-level dotted key (`agents.max_depth = 2`) is the same setting; it must stay before the first table.
  const rootEnd = lines.findIndex(isTableHeader);
  const dotted = keyPattern(key, `${escapeRegExp(table)}\\s*\\.\\s*`);
  const dottedIndex = lines.findIndex((line, index) => (rootEnd === -1 || index < rootEnd) && dotted.test(line));
  if (dottedIndex >= 0) {
    return replaceValue(lines, dottedIndex, dotted, rendered) ? finish() : text;
  }
  if (lines.some((line, index) => (rootEnd === -1 || index < rootEnd) && new RegExp(`^\\s*${escapeRegExp(table)}\\s*=`).test(line))) {
    throw new Error(`${table} is an inline table in config.toml; set ${table}.${key} there by hand`);
  }

  // New section: before the account proxy block when there is one, otherwise at the end.
  let insertAt = lines.findIndex((line) => line.startsWith(PROXY_BLOCK_PREFIX));
  if (insertAt === -1) {
    insertAt = lines.length;
  }
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') {
    insertAt--;
  }
  const section = [`[${table}]`, `${key} = ${rendered}`];
  if (insertAt > 0) {
    section.unshift('');
  }
  if (insertAt < lines.length) {
    section.push('');
  }
  const trailingBlanks = lines.slice(insertAt).findIndex((line) => line.trim() !== '');
  lines.splice(insertAt, trailingBlanks === -1 ? lines.length - insertAt : trailingBlanks, ...section);
  return finish();
}

/** Applies every assignment to `text`; errors of one assignment are reported and do not stop the others. */
export function applyCodexSettings(text: string, assignments: readonly CodexSettingAssignment[], onError?: (assignment: CodexSettingAssignment, error: Error) => void): string {
  let result = text;
  for (const assignment of assignments) {
    try {
      result = setCodexConfigValue(result, assignment.table, assignment.key, assignment.value);
    } catch (error) {
      onError?.(assignment, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return result;
}

/** Writes the assignments into `file`; returns whether the file changed. */
export function applyCodexSettingsToFile(file: string, assignments: readonly CodexSettingAssignment[], onError?: (assignment: CodexSettingAssignment, error: Error) => void): boolean {
  if (!assignments.length) {
    return false;
  }
  const before = readCodexConfigText(file);
  const after = applyCodexSettings(before, assignments, onError);
  if (after === before) {
    return false;
  }
  writeTextAtomically(file, after);
  return true;
}
