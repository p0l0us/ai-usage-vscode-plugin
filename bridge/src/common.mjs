import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const accountFingerprint = account => createHash('sha256').update(JSON.stringify(account)).digest('hex');

export class BridgeError extends Error {
  constructor(message, status = 502, code = 'backend_error') {
    super(message); this.status = status; this.code = code;
  }
}

export class EventQueue {
  items = []; waiters = []; ended = false;
  push(event) {
    if (this.ended) return;
    const resolve = this.waiters.shift();
    if (resolve) resolve(event); else this.items.push(event);
  }
  end() {
    this.ended = true;
    for (const resolve of this.waiters.splice(0)) resolve({ type: 'end' });
  }
  next() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.ended) return Promise.resolve({ type: 'end' });
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

// Never place prompts in shell command strings. On Windows resolve npm's JS
// launcher and invoke it with node, avoiding cmd.exe quoting and expansion.
export async function resolveCommand(command) {
  const hasPath = command.includes('/') || command.includes('\\');
  const dirs = hasPath ? [''] : [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')];
  for (const dir of dirs) {
    const base = hasPath ? path.resolve(command) : path.join(dir, command);
    const candidates = process.platform === 'win32' ? [base + '.exe', base, base + '.cmd'] : [base];
    for (const candidate of candidates) {
      try {
        await access(candidate, /\.(js|cjs|mjs)$/i.test(candidate) ? constants.R_OK : constants.X_OK);
        if (/\.(js|cjs|mjs)$/i.test(candidate)) return { file: process.execPath, args: [candidate] };
        if (/\.(cmd|bat)$/i.test(candidate)) {
          const text = await readFile(candidate, 'utf8');
          const match = text.match(/%dp0%[\\/]([^"\r\n]+\.(?:js|cjs|mjs))/i);
          if (!match) throw new BridgeError('Unsupported Windows launcher; configure the native CLI executable.', 503);
          return { file: process.execPath, args: [path.resolve(path.dirname(candidate), match[1])] };
        }
        return { file: candidate, args: [] };
      } catch (error) { if (error instanceof BridgeError) throw error; }
    }
  }
  throw new BridgeError(`CLI not found: ${path.basename(command)}. Install it or configure its executable path.`, 503, 'cli_not_found');
}

export function spawnCommand(command, args, options = {}) {
  const child = spawn(command.file, [...command.args, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32', ...options, shell: false
  });
  // Do not log stderr: CLIs can include prompts, credentials, or private paths.
  child.stderr.resume();
  child.stdin.on('error', () => {});
  return child;
}

export async function terminate(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
      killer.once('error', () => { child.kill(); resolve(); });
      killer.once('exit', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
    timer.unref();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1200))]);
    clearTimeout(timer);
  }
}

export function readJsonLines(stream, onMessage, onError) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 16 * 1024 * 1024) { onError(new BridgeError('CLI output exceeded the buffer limit.')); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line)); }
      catch { onError(new BridgeError('Invalid structured response from CLI.')); }
    }
  });
}
