const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MCP_SERVER_NAME, mcpConfigFile, mcpRegisterArgs, mcpRemoveArgs, readMcpRegistration, registerMcpServer, unregisterMcpServer } = require('../out/mcpRegistration');

/** Both CLIs read their configuration homes from the environment; each test gets empty ones. */
function homes(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-mcp-'));
  const previous = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
  process.env.CODEX_HOME = path.join(dir, 'codex');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  fs.mkdirSync(process.env.CODEX_HOME);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const launcher = '/home/me/.ai-usage/bin/ai-usage';

test("the registration commands are each CLI's own mcp add and remove, Claude's in user scope", () => {
  assert.equal(MCP_SERVER_NAME, 'ai-usage');
  assert.deepEqual(mcpRegisterArgs('claude', launcher), ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'ai-usage', '--', launcher, 'mcp']);
  assert.deepEqual(mcpRegisterArgs('codex', launcher), ['mcp', 'add', 'ai-usage', '--', launcher, 'mcp']);
  assert.deepEqual(mcpRemoveArgs('claude'), ['mcp', 'remove', '--scope', 'user', 'ai-usage']);
  assert.deepEqual(mcpRemoveArgs('codex'), ['mcp', 'remove', 'ai-usage']);
});

test('the registration is read from .claude.json and config.toml: missing, current, or another command', (t) => {
  const dir = homes(t);
  assert.equal(mcpConfigFile('claude'), path.join(dir, 'claude', '.claude.json'));
  assert.equal(mcpConfigFile('codex'), path.join(dir, 'codex', 'config.toml'));
  assert.deepEqual(readMcpRegistration('claude', launcher), { registered: false, current: false });
  assert.deepEqual(readMcpRegistration('codex', launcher), { registered: false, current: false });

  fs.writeFileSync(mcpConfigFile('claude'), JSON.stringify({ mcpServers: { 'ai-usage': { type: 'stdio', command: launcher, args: ['mcp'], env: {} }, other: { command: 'x' } } }));
  assert.deepEqual(readMcpRegistration('claude', launcher), { registered: true, command: launcher, args: ['mcp'], current: true });
  fs.writeFileSync(mcpConfigFile('claude'), JSON.stringify({ mcpServers: { 'ai-usage': { command: 'node', args: ['/old/ai-usage.js', 'mcp'] } } }));
  assert.deepEqual(readMcpRegistration('claude', launcher), { registered: true, command: 'node', args: ['/old/ai-usage.js', 'mcp'], current: false });
  fs.writeFileSync(mcpConfigFile('claude'), '{ broken');
  assert.deepEqual(readMcpRegistration('claude', launcher), { registered: false, current: false });

  // As `codex mcp add` writes it, among other tables.
  fs.writeFileSync(mcpConfigFile('codex'), ['model = "gpt-5"', '', '[mcp_servers.ai-usage]', `command = "${launcher}"`, 'args = ["mcp"]', '', '[mcp_servers.other]', 'command = "x"', ''].join('\n'));
  assert.deepEqual(readMcpRegistration('codex', launcher), { registered: true, command: launcher, args: ['mcp'], current: true });
  fs.writeFileSync(mcpConfigFile('codex'), ['[mcp_servers."ai-usage"]', 'command = "/bin/true"', 'args = ["mcp", "--home", "/x"]'].join('\n'));
  assert.deepEqual(readMcpRegistration('codex', launcher), { registered: true, command: '/bin/true', args: ['mcp', '--home', '/x'], current: false });
  fs.writeFileSync(mcpConfigFile('codex'), '[mcp_servers.other]\ncommand = "x"\n');
  assert.deepEqual(readMcpRegistration('codex', launcher), { registered: false, current: false });
});

test("registering removes an existing entry first, reports the CLI's refusal, and removing is one command", async (t) => {
  homes(t);
  const file = mcpConfigFile('claude');
  const calls = [];
  const run = async (cli, args) => {
    calls.push([cli, args.join(' ')]);
    if (args[1] === 'remove') {
      fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }));
      return { code: 0, stdout: 'Removed MCP server ai-usage from user config\nFile modified: x\n', stderr: '' };
    }
    if (cli === 'refusing') { return { code: 1, stdout: '', stderr: 'MCP server ai-usage already exists in user config\n' }; }
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'ai-usage': { command: launcher, args: ['mcp'] } } }));
    return { code: 0, stdout: 'Added stdio MCP server ai-usage\n', stderr: '' };
  };
  // Nothing registered yet: one add, verified in the file.
  let result = await registerMcpServer('claude', '/usr/bin/claude', launcher, run);
  assert.equal(result.ok, true);
  assert.equal(result.registration.current, true);
  assert.equal(result.detail, `claude mcp add --scope user --transport stdio ai-usage -- ${launcher} mcp`);
  assert.deepEqual(calls, [['/usr/bin/claude', `mcp add --scope user --transport stdio ai-usage -- ${launcher} mcp`]]);
  // Already registered: removed, then added again.
  calls.length = 0;
  result = await registerMcpServer('claude', '/usr/bin/claude', launcher, run);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(([, args]) => args.split(' ')[1]), ['remove', 'add']);
  // The CLI refuses: its last line is the reason.
  calls.length = 0;
  result = await registerMcpServer('claude', 'refusing', launcher, run);
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'MCP server ai-usage already exists in user config');
  assert.equal(result.registration.registered, false);
  // Removal alone.
  const removed = await unregisterMcpServer('claude', '/usr/bin/claude', run);
  assert.deepEqual(removed, { ok: true, detail: 'File modified: x' });
  assert.deepEqual(readMcpRegistration('claude', launcher), { registered: false, current: false });
});
