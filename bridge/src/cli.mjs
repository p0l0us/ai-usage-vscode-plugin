#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { CodexAdapter } from './codex.mjs';
import { BridgeEngine } from './engine.mjs';
import { createBridgeServer } from './server.mjs';

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '3210' },
  'token-file': { type: 'string', default: path.join(os.homedir(), '.cli-byok-bridge', 'token') },
  codex: { type: 'string', default: 'codex' }, claude: { type: 'string', default: 'claude' },
  backends: { type: 'string', default: 'codex' },
  'idle-seconds': { type: 'string' },
  'timeout-seconds': { type: 'string' },
  'owner-id': { type: 'string' },
  'owner-pid': { type: 'string' },
  'max-sessions': { type: 'string', default: '8' },
  help: { type: 'boolean', short: 'h' }
} });

if (values.help) {
  console.log(`CLI BYOK Bridge — use your existing CLI subscription login\n\nUsage: node src/cli.mjs [options]\n\n  --port 3210                  Loopback HTTP port\n  --backends codex             codex, claude, or codex,claude\n  --codex <executable>         Codex CLI path\n  --claude <executable>        Claude CLI path (experimental adapter)\n  --token-file <path>          Local authentication token file\n  --idle-seconds <seconds>           Pending tool continuation lifetime\n  --timeout-seconds <seconds>        Maximum duration per model request\n  --max-sessions 8             Maximum active/pending CLI sessions\n\nNo provider API keys. Sign in with codex login / claude auth login first.`);
} else {
  const integer = (name, min, max) => {
    const n = Number(values[name]);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid --${name}.`);
    return n;
  };
  const managed = values['owner-id'] !== undefined;
  let parentLost = managed && !process.connected;
  let shutdown;
  const disconnected = () => { parentLost = true; void shutdown?.(); };
  if (managed) { process.once('disconnect', disconnected); process.channel?.unref(); }
  const checkParent = () => {
    if (managed) {
      try { process.kill(Number(values['owner-pid']), 0); } catch { parentLost = true; }
      if (!process.connected) parentLost = true;
    }
    if (parentLost) throw new Error('The owning engine disconnected during bridge startup.');
  };
  try {
    checkParent();
    const owner = managed ? { id: values['owner-id'], pid: integer('owner-pid', 1, Number.MAX_SAFE_INTEGER), bridgePid: process.pid } : undefined;
    if (managed && (!/^[a-f0-9-]{36}$/.test(owner.id) || typeof process.send !== 'function')) throw new Error('A managed bridge requires its owner IPC channel.');
    const port = integer('port', 1, 65535);
    const backends = values.backends.split(',');
    if (backends.some(b => !['codex', 'claude'].includes(b))) throw new Error('Unknown backend.');
    const tokenFile = path.resolve(values['token-file']);
    if (managed) {
      // Publish complete ownership before asynchronous initialization or admission. Exclusive linking never overwrites a live successor.
      checkParent();
      mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
      const ownerFile = tokenFile + '.owner.json';
      const staged = ownerFile + '.' + owner.id;
      try {
        writeFileSync(staged, JSON.stringify({ id: owner.id, pid: process.pid, parentPid: owner.pid }), { flag: 'wx', mode: 0o600 });
        checkParent();
        linkSync(staged, ownerFile);
        checkParent();
      } finally { try { unlinkSync(staged); } catch { /* A failed stage was never published. */ } }
    }
    await mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
    checkParent();
    try { await writeFile(tokenFile, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (process.platform !== 'win32') await chmod(tokenFile, 0o600);
    const token = (await readFile(tokenFile, 'utf8')).trim();
    checkParent();
    const adapters = {};
    if (backends.includes('codex')) adapters.codex = new CodexAdapter({ command: values.codex });
    if (backends.includes('claude')) {
      const { ClaudeAdapter } = await import('./claude.mjs');
      adapters.claude = new ClaudeAdapter({ command: values.claude });
    }
    const engine = new BridgeEngine(adapters, { idleMs: values['idle-seconds'] ? integer('idle-seconds', 1, 86400) * 1000 : undefined, requestMs: values['timeout-seconds'] ? integer('timeout-seconds', 1, 86400) * 1000 : undefined, maxSessions: integer('max-sessions', 1, 64), sessionSettingsFile: tokenFile + '.session-settings.json', sessionRecordsFile: tokenFile + '.sessions.json' });
    await engine.sessionSettings.load();
    checkParent();
    await engine.loadSessionRecords();
    checkParent();
    const server = createBridgeServer(engine, { token, owner, log: entry => console.error(JSON.stringify(entry)) });
    let stopping;
    const stop = () => {
      if (stopping) return stopping;
      stopping = (async () => {
        // Close admission immediately, then cancel/drain native sessions. A stalled backend cannot leave an orphan indefinitely.
        const deadline = setTimeout(() => process.exit(1), 3000); deadline.unref();
        const closed = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
        try { await Promise.all([closed, engine.close()]); }
        finally { clearTimeout(deadline); if (process.connected) process.disconnect(); }
      })();
      return stopping;
    };
    shutdown = stop;
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
    checkParent();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    if (parentLost) await stop();
    else console.error(`Bridge listening at http://127.0.0.1:${port}/v1\nLocal API key: contents of ${tokenFile}\nBackends: ${backends.join(', ')}. Subscription login is checked before use.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
