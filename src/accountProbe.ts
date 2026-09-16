import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AuthProvider, StoredCredential, nativeCredentialPath, parseCredentialJson, writeJsonAtomically } from './authFiles';
import { LiveResult, fetchClaudeUsage, fetchCodexUsageCli, resolveCli } from './live';

export type ProbeSettings = { home: string; cliPath: string; model: string };
export type ProbeResult = { result: LiveResult; credential: StoredCredential; keepAliveError?: string };

/** Exclusive across extension hosts; only reclaim locks whose owning process has exited. */
export function acquireAccountLock(file: string): (() => void) | undefined {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(file); } catch { /* Already removed. */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
      try {
        const pid = Number(fs.readFileSync(file, 'utf8'));
        // An empty lock can be another process between open and write.
        if (!Number.isInteger(pid) || pid <= 0) { return undefined; }
        try { process.kill(pid, 0); return undefined; }
        catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') { return undefined; }
        }
        fs.unlinkSync(file);
      } catch { return undefined; }
    }
  }
  return undefined;
}

export function isolatedHome(provider: AuthProvider, configured: string): string {
  const expanded = configured.startsWith('~/') || configured.startsWith('~\\')
    ? path.join(os.homedir(), configured.slice(2)) : configured;
  const home = path.resolve(os.homedir(), expanded || `.${provider}-tmp`);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const actual = fs.realpathSync(home);
  const native = path.dirname(nativeCredentialPath(provider));
  const nativeReal = fs.existsSync(native) ? fs.realpathSync(native) : path.resolve(native);
  // Never stage credentials in a native home, including through a symlink or parent directory.
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
  if (overlaps(actual, nativeReal) || actual === fs.realpathSync(os.homedir())) {
    throw new Error('Keep-alive home must be separate from the native CLI home.');
  }
  return actual;
}

export function isolatedEnvironment(provider: AuthProvider, home: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Inherited credentials and provider routing must never override the staged account.
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|CLAUDECODE$)/.test(key)) { delete env[key]; }
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  env.XDG_CACHE_HOME = path.join(home, '.cache');
  env[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = home;
  return env;
}

export function keepAliveArgs(provider: AuthProvider, model: string): string[] {
  const prompt = 'what is date today';
  if (provider === 'claude') {
    return ['--print', '--model', model || 'haiku', '--tools', '', '--strict-mcp-config',
      '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
      '--no-session-persistence', '--max-turns', '1', prompt];
  }
  return ['-a', 'never', 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral',
    '-c', 'cli_auth_credentials_store="file"', '-c', 'model_reasoning_effort="low"',
    ...(model ? ['--model', model] : []), prompt];
}

export function runKeepAlive(cli: string, args: string[], home: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Account check cancelled.')); return; }
    const child = spawn(cli, args, { cwd: home, env, stdio: 'ignore', windowsHide: true });
    let failure: string | undefined;
    const stop = () => { failure = 'Account check cancelled.'; child.kill('SIGKILL'); };
    const timer = setTimeout(() => { failure = 'Keep-alive timed out after 90 seconds.'; child.kill('SIGKILL'); }, 90_000);
    signal.addEventListener('abort', stop, { once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    child.once('error', () => { cleanup(); reject(new Error('Could not start the keep-alive CLI. Check its configured path.')); });
    child.once('close', (code) => {
      cleanup();
      if (failure || code !== 0) { reject(new Error(failure ?? `Keep-alive CLI exited with code ${code}.`)); }
      else { resolve(); }
    });
  });
}

/** Swap saved credentials into a separate home, make a small call, then collect all limit windows. */
export async function probeAccount(provider: AuthProvider, credential: StoredCredential, settings: ProbeSettings,
  keepAlive: boolean, signal: AbortSignal): Promise<ProbeResult> {
  const home = isolatedHome(provider, settings.home);
  const unlock = acquireAccountLock(path.join(home, '.ai-usage.lock'));
  if (!unlock) { throw new Error('Another account check is using the keep-alive home.'); }
  const file = path.join(home, provider === 'claude' ? '.credentials.json' : 'auth.json');
  let staged = false;
  try {
    // Only the provider-owned auth fields, never native settings, hooks, MCP servers or sessions.
    writeJsonAtomically(file, credential);
    staged = true;
    const env = isolatedEnvironment(provider, home);
    let keepAliveError: string | undefined;
    if (keepAlive) {
      try {
        const cli = resolveCli(settings.cliPath);
        if (!cli) { throw new Error('Keep-alive CLI not found. Check its configured path.'); }
        await runKeepAlive(cli, keepAliveArgs(provider, settings.model), home, env, signal);
      } catch (error) { keepAliveError = error instanceof Error ? error.message : 'Keep-alive failed.'; }
    }
    // Collect usage even if the model call hit a usage limit or the CLI is unavailable.
    const result: LiveResult = signal.aborted
      ? { kind: 'unavailable', provider, reason: 'Account check cancelled.' }
      : provider === 'claude' ? await fetchClaudeUsage(home)
        : await fetchCodexUsageCli(settings.cliPath, home, env, home);
    return { result, credential: parseCredentialJson(provider, fs.readFileSync(file, 'utf8')), keepAliveError };
  } finally {
    try { if (staged) { fs.unlinkSync(file); } } finally { unlock(); }
  }
}
