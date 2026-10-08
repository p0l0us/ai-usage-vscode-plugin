import * as fs from 'fs';
import { writeTextAtomically } from './authFiles';

/**
 * Claude Code environment variables that AI Usage exposes as `aiUsage.claudeConfig.*` settings.
 *
 * They are written into the `env` object of Claude Code's user settings (`settings.json` in `CLAUDE_CONFIG_DIR`,
 * default `~/.claude`), which Claude Code applies to every session it starts; running sessions keep the value they
 * started with. A setting left at `null` is not managed: the file keeps whatever the user wrote. Only the one `env`
 * entry is changed; the rest of the document is kept, re-serialized with the file's own indentation.
 */

export type ClaudeSetting = {
  /** VS Code setting id. */
  setting: string;
  /** Environment variable in `settings.json` `env`. */
  env: string;
  minimum: number;
  maximum?: number;
};

export const CLAUDE_SETTINGS: readonly ClaudeSetting[] = [
  { setting: 'aiUsage.claudeConfig.env.maxConcurrentSubagents', env: 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', minimum: 1 },
  { setting: 'aiUsage.claudeConfig.env.workflowMaxConcurrentAgents', env: 'CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS', minimum: 1, maximum: 256 }
];

export type ClaudeSettingAssignment = ClaudeSetting & { value: number };

/**
 * The settings that carry a value, read through `get` (the VS Code configuration in the extension). `null`,
 * `undefined` and invalid values are left out and reported through `onInvalid`.
 */
export function readClaudeSettingAssignments(get: (setting: string) => unknown, onInvalid?: (setting: ClaudeSetting, value: unknown) => void): ClaudeSettingAssignment[] {
  const assignments: ClaudeSettingAssignment[] = [];
  for (const setting of CLAUDE_SETTINGS) {
    const value = get(setting.setting);
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < setting.minimum || (setting.maximum !== undefined && value > setting.maximum)) {
      onInvalid?.(setting, value);
      continue;
    }
    assignments.push({ ...setting, value });
  }
  return assignments;
}

/** The indentation the document uses (two spaces when it cannot tell). */
function detectIndent(text: string): string | number {
  const match = /^[{[]\r?\n([ \t]+)\S/.exec(text);
  return match ? match[1] : 2;
}

/**
 * Returns `text` with every assignment in its `env` object (values as strings, as Claude Code expects). Returns
 * `text` unchanged when nothing differs. Throws when the file is not a JSON object, so a broken file is never
 * overwritten.
 */
export function applyClaudeSettings(text: string, assignments: readonly ClaudeSettingAssignment[]): string {
  const document: unknown = text.trim() === '' ? {} : JSON.parse(text);
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('settings.json is not a JSON object');
  }
  const settings = document as Record<string, unknown>;
  if (settings.env !== undefined && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env))) {
    throw new Error('"env" in settings.json is not an object');
  }
  const env = { ...(settings.env as Record<string, unknown> | undefined) };
  let changed = false;
  for (const assignment of assignments) {
    const value = String(assignment.value);
    if (env[assignment.env] !== value) {
      env[assignment.env] = value;
      changed = true;
    }
  }
  if (!changed) {
    return text;
  }
  settings.env = env;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(settings, null, detectIndent(text)).replace(/\n/g, eol) + eol;
}

/** Writes the assignments into `file`; returns whether the file changed. */
export function applyClaudeSettingsToFile(file: string, assignments: readonly ClaudeSettingAssignment[]): boolean {
  if (!assignments.length) {
    return false;
  }
  let before = '';
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const after = applyClaudeSettings(before, assignments);
  if (after === before) {
    return false;
  }
  writeTextAtomically(file, after);
  return true;
}
