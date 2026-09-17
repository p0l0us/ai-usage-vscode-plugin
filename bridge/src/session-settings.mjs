import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from './common.mjs';

export function normalizeSessionSettings(value = {}) {
  const invalid = () => { throw new BridgeError('Invalid session settings. Use codex/claude boolean feature switches, an absolute sessionDirectory or empty string, and integer task/tool timeouts from 1 to 1440 minutes.', 400, 'invalid_request_error'); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['codex', 'claude'].includes(k))) invalid();
  return Object.fromEntries(['codex', 'claude'].map(provider => {
    const input = value[provider] ?? {};
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['persistSessions', 'openInCli', 'openInExtension', 'sessionDirectory', 'subagentsEnabled', 'requestTimeoutMinutes', 'toolTimeoutMinutes'].includes(k))) invalid();
    const settings = { persistSessions: false, openInCli: false, openInExtension: false, sessionDirectory: '', subagentsEnabled: false, requestTimeoutMinutes: 60, toolTimeoutMinutes: 60, ...input };
    for (const key of ['persistSessions', 'openInCli', 'openInExtension', 'subagentsEnabled']) if (typeof settings[key] !== 'boolean') invalid();
    for (const key of ['requestTimeoutMinutes', 'toolTimeoutMinutes']) if (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > 1440) invalid();
    if (typeof settings.sessionDirectory !== 'string' || settings.sessionDirectory.includes('\0') || (settings.sessionDirectory && !path.isAbsolute(settings.sessionDirectory))) invalid();
    return [provider, settings];
  }));
}

export class SessionSettings {
  value = normalizeSessionSettings();
  pending = Promise.resolve();
  constructor(file) { this.file = file; }
  async load() {
    if (!this.file) return;
    try { this.value = normalizeSessionSettings(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async update(input) {
    const value = normalizeSessionSettings(input);
    const work = this.pending.then(async () => {
      if (JSON.stringify(value) === JSON.stringify(this.value)) return this.value;
      if (this.file) {
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
        await rename(temporary, this.file);
      }
      this.value = value;
      return value;
    });
    this.pending = work.catch(() => {});
    return work;
  }
}

export async function sessionWorkingDirectory(request, provider, temporary) {
  if (!request.saveSession) return temporary;
  const directory = request.sessionDirectory || path.join(os.homedir(), '.cli-byok-bridge', 'workspaces', provider);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export function sessionLaunch(record, settings) {
  if (!record.persisted || !record.native_session_id || !record.released || !record.cwd) return {};
  const id = record.native_session_id;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return {};
  return {
    ...(settings.openInExtension ? { extension_url: record.backend === 'claude'
      ? `vscode://anthropic.claude-code/open?session=${encodeURIComponent(id)}`
      : `vscode://openai.chatgpt/local/${encodeURIComponent(id)}` } : {}),
    ...(settings.openInCli ? { cli: { command: record.cli_executable?.file || record.backend,
      args: [...(record.cli_executable?.args || []), ...(record.backend === 'claude' ? ['--resume', id] : ['resume', id])], cwd: record.cwd } } : {})
  };
}
