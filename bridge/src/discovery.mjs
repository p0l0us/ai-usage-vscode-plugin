import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, resolveCommand, spawnCommand, terminate } from './common.mjs';

// File metadata invalidates cached account/catalog data without reading credentials.
// Native auth status is still checked by adapters before inference.
export async function identityKey(backend, command) {
  const executable = await resolveCommand(command);
  const home = backend === 'codex' ? (process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))
    : (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  const files = [executable.file, ...executable.args, ...(['codex'].includes(backend)
    ? ['auth.json', 'config.toml'] : ['.credentials.json', 'settings.json']).map(f => path.join(home, f))];
  const stamps = await Promise.all(files.map(async file => {
    try { const s = await stat(file); return [file, s.ino, s.size, s.mtimeMs, s.ctimeMs]; }
    catch { return [file, null]; }
  }));
  const overrides = Object.entries(process.env).filter(([k]) => /^(CODEX|OPENAI|ANTHROPIC|CLAUDE_CODE)_/.test(k));
  return createHash('sha256').update(JSON.stringify([home, stamps, overrides])).digest('hex');
}

export async function cliVersion(command, signal) {
  const child = spawnCommand(await resolveCommand(command), ['--version'], { signal });
  let output = '';
  const timer = setTimeout(() => { void terminate(child); }, 5000);
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', data => { output += data; if (output.length > 4096) { void terminate(child); reject(new BridgeError('Invalid CLI version output.', 503, 'cli_incompatible')); } });
      child.once('error', () => reject(new BridgeError('Could not read CLI version.', 503, 'cli_incompatible')));
      child.once('exit', code => code === 0 ? resolve() : reject(new BridgeError(`CLI version check failed (exit ${code}).`, 503, 'cli_incompatible')));
    });
    const version = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (!version) throw new BridgeError('Unrecognized CLI version. Update the CLI.', 503, 'cli_incompatible');
    return version[0];
  } finally { clearTimeout(timer); await terminate(child); }
}

export class ModelDiscovery {
  entries = new Map(); pending = new Map(); controllers = new Set(); closed = false;
  constructor(adapters, { ttlMs = 60000, timeoutMs = 15000 } = {}) {
    this.adapters = adapters; this.ttlMs = ttlMs; this.timeoutMs = timeoutMs;
  }
  async backend(name) {
    if (this.closed) throw new BridgeError('Model discovery is closed.', 503);
    if (!this.adapters[name]) throw new BridgeError('Backend is not enabled.', 404, 'model_not_found');
    if (this.pending.has(name)) return this.pending.get(name);
    const work = this.discover(name).finally(() => this.pending.delete(name));
    this.pending.set(name, work); return work;
  }
  async discover(name) {
    const adapter = this.adapters[name];
    const key = adapter.command ? await identityKey(name, adapter.command) : name;
    if (this.closed) throw new BridgeError('Model discovery is closed.', 503);
    const previous = this.entries.get(name);
    if (previous?.key === key && previous.expires > Date.now()) {
      if (previous.error) throw previous.error;
      return previous.models;
    }
    const controller = new AbortController(); this.controllers.add(controller);
    let timer;
    try {
      const models = await Promise.race([
        (async () => {
          const version = adapter.command ? await cliVersion(adapter.command, controller.signal) : 'test';
          const parts = version.split('.').map(Number);
          const minimum = name === 'codex' ? [0, 151, 0] : [2, 1, 273];
          const older = version !== 'test' && parts.reduce((cmp, n, i) => cmp || Math.sign(n - minimum[i]), 0) < 0;
          if (older) throw new BridgeError(`${name} ${version} is too old; require ${minimum.join('.')} or newer.`, 503, 'cli_incompatible');
          const result = await adapter.models(controller.signal);
          return result.map(m => ({ ...m, bridge: { ...m.bridge, cli_version: version } }));
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BridgeError(`${name} discovery timed out. Check CLI login and compatibility.`, 504, 'discovery_timeout')); }, this.timeoutMs); })
      ]);
      this.entries.set(name, { key, models, expires: Date.now() + this.ttlMs });
      return models;
    } catch (error) {
      this.entries.set(name, { key, models: [], error, expires: Date.now() + Math.min(this.ttlMs, 3000) });
      throw error;
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  async models(name) {
    if (name) return this.backend(name);
    // Return as soon as a backend succeeds. Slower catalogs populate independently
    // and appear on the next refresh; callers can query a backend explicitly.
    const names = Object.keys(this.adapters);
    if (!names.length) throw new BridgeError('No CLI backends configured.', 503);
    const work = names.map(n => this.backend(n).then(models => {
      if (!models.length) throw new BridgeError('No models available.', 503);
      return models;
    }));
    let first;
    try { first = await Promise.any(work); }
    catch (error) { throw error.errors[0]; }
    return [...new Map([...first, ...names.flatMap(n => {
      const e = this.entries.get(n); return e?.expires > Date.now() && !e.error && !this.pending.has(n) ? e.models : [];
    })].map(m => [m.id, m])).values()];
  }
  async diagnose() {
    return Promise.all(Object.keys(this.adapters).map(async backend => {
      const started = Date.now();
      try { const models = await this.backend(backend); return { backend, status: 'ready', elapsed_ms: Date.now() - started, models }; }
      catch (error) { return { backend, status: 'error', elapsed_ms: Date.now() - started, code: error.code || 'backend_error', message: error instanceof BridgeError ? error.message : 'Backend discovery failed.' }; }
    }));
  }
  close() { this.closed = true; for (const controller of this.controllers) controller.abort(); }
}
