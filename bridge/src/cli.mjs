#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
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
  'idle-seconds': { type: 'string', default: '300' },
  'timeout-seconds': { type: 'string', default: '180' },
  'max-sessions': { type: 'string', default: '8' },
  help: { type: 'boolean', short: 'h' }
} });

if (values.help) {
  console.log(`CLI BYOK Bridge — use your existing CLI subscription login\n\nUsage: node src/cli.mjs [options]\n\n  --port 3210                  Loopback HTTP port\n  --backends codex             codex, claude, or codex,claude\n  --codex <executable>         Codex CLI path\n  --claude <executable>        Claude CLI path (experimental adapter)\n  --token-file <path>          Local authentication token file\n  --idle-seconds 300           Pending tool continuation lifetime\n  --timeout-seconds 180        Maximum duration per model request\n  --max-sessions 8             Maximum active/pending CLI sessions\n\nNo provider API keys. Sign in with codex login / claude auth login first.`);
} else {
  const integer = (name, min, max) => {
    const n = Number(values[name]);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid --${name}.`);
    return n;
  };
  try {
    const port = integer('port', 1, 65535);
    const backends = values.backends.split(',');
    if (backends.some(b => !['codex', 'claude'].includes(b))) throw new Error('Unknown backend.');
    const tokenFile = path.resolve(values['token-file']);
    await mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
    try { await writeFile(tokenFile, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (process.platform !== 'win32') await chmod(tokenFile, 0o600);
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const adapters = {};
    if (backends.includes('codex')) adapters.codex = new CodexAdapter({ command: values.codex });
    if (backends.includes('claude')) {
      const { ClaudeAdapter } = await import('./claude.mjs');
      adapters.claude = new ClaudeAdapter({ command: values.claude });
    }
    const engine = new BridgeEngine(adapters, { idleMs: integer('idle-seconds', 1, 3600) * 1000, requestMs: integer('timeout-seconds', 1, 3600) * 1000, maxSessions: integer('max-sessions', 1, 64) });
    const server = createBridgeServer(engine, { token, log: entry => console.error(JSON.stringify(entry)) });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    console.error(`Bridge listening at http://127.0.0.1:${port}/v1\nLocal API key: contents of ${tokenFile}\nBackends: ${backends.join(', ')}. Subscription login is checked before use.`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true;
      server.close(); server.closeAllConnections(); await engine.close();
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
