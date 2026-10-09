const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

exports.mcpProcess = (t, home, env) => {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../../service/bin/ai-usage.js'), 'mcp', '--home', home],
    { cwd: path.resolve(__dirname, '../..'), env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const pending = new Map(); let next = 1;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line); const waiter = pending.get(response.id);
    if (waiter) { clearTimeout(waiter.timer); pending.delete(response.id); waiter.resolve(response); }
  });
  const exited = once(child, 'exit');
  require('./runtimeHost').registerCleanup(t, env, async () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('MCP fixture ended')); }
    if (child.exitCode === null && child.signalCode === null) { child.stdin.end(); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]); }
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  });
  return { child, exited, request: (method, params) => {
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP request timed out: ' + stderr)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  } };
};
