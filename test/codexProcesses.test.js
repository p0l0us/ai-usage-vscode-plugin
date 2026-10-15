const assert = require('node:assert/strict');
const test = require('node:test');
const { parseElapsedSeconds, parsePsListing, parseWindowsListing, isCodexAppServer,
  staleCodexProcesses, isExtensionOwnedCodexAppServer, isCodexDaemonHelper, staleCodexDaemons, terminateProcess,
  terminateStaleCodexDaemons } = require('../out/codexProcesses');

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
const HOST = '/home/u/.vscode-server/extensions/openai.chatgpt-26.908.40401-linux-x64/bin/linux-x86_64/codex -c features.code_mode_host=true app-server';

test('ps elapsed times cover seconds, hours and days', () => {
  assert.equal(parseElapsedSeconds('00:05'), 5);
  assert.equal(parseElapsedSeconds('40:47'), 40 * 60 + 47);
  assert.equal(parseElapsedSeconds('21:18:16'), 21 * 3600 + 18 * 60 + 16);
  assert.equal(parseElapsedSeconds('3-01:02:03'), 3 * 86400 + 3600 + 123);
  assert.equal(parseElapsedSeconds('garbage'), undefined);
});

test('ps listing yields pid, parent, start time and command', () => {
  const text = [
    ' 223576  219677       40:38 ' + HOST,
    ' 907551  853565       00:00 /bin/bash -c ps',
    'PID PPID ELAPSED COMMAND'
  ].join('\n');
  const processes = parsePsListing(text, NOW);
  assert.equal(processes.length, 2);
  assert.deepEqual(processes[0], { pid: 223576, ppid: 219677, startedAt: NOW - (40 * 60 + 38) * 1000, command: HOST });
});

test('windows listing accepts a single object or an array and ISO creation dates', () => {
  const row = { ProcessId: 10, ParentProcessId: 5, CreationDate: '2026-09-17T11:00:00.000Z', CommandLine: '"C:\\codex.exe" -c features.code_mode_host=true app-server' };
  assert.deepEqual(parseWindowsListing(JSON.stringify(row)), [{ pid: 10, ppid: 5, startedAt: Date.UTC(2026, 8, 17, 11), command: row.CommandLine }]);
  assert.equal(parseWindowsListing(JSON.stringify([row, { ProcessId: 11 }])).length, 1);
  assert.deepEqual(parseWindowsListing('not json'), []);
});

test('only vendor app-servers count, never AI Usage probes or unrelated processes', () => {
  assert.equal(isCodexAppServer(HOST), true);
  assert.equal(isCodexAppServer('"C:\\Users\\u\\codex.exe" -c features.code_mode_host=true app-server'), true);
  assert.equal(isCodexAppServer('/usr/bin/codex app-server -c cli_auth_credentials_store="file"'), false);
  assert.equal(isCodexAppServer('/usr/bin/codex exec --model luna hi'), false);
  assert.equal(isCodexAppServer('node /opt/my-codex-tool app-server'), false);
});

test('stale detection keys on this extension host and the switch time with a grace period', () => {
  const switchedAt = NOW - 10 * 60 * 1000;
  const processes = [
    { pid: 1, ppid: 100, startedAt: switchedAt - 3600 * 1000, command: HOST },          // stale, ours
    { pid: 2, ppid: 100, startedAt: switchedAt + 5000, command: HOST },                 // fresh, ours
    { pid: 3, ppid: 100, startedAt: switchedAt - 1000, command: HOST },                 // within grace
    { pid: 4, ppid: 200, startedAt: switchedAt - 3600 * 1000, command: HOST },          // another window
    { pid: 5, ppid: 100, startedAt: switchedAt - 3600 * 1000, command: '/usr/bin/codex app-server -c cli_auth_credentials_store="file"' }
  ];
  assert.deepEqual(staleCodexProcesses(processes, 100, switchedAt).map(p => p.pid), [1]);
  assert.deepEqual(staleCodexProcesses(processes, 300, switchedAt), []);
});

const DAEMON = '/home/u/.codex/packages/app-server-daemon/releases/0.162.1-x86_64-unknown-linux-musl/bin/codex app-server daemon';
const SDK = '/home/u/.vscode-server/data/agent-host/sdk-cache/codex/0.157.0/linux-x64/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex app-server -c model_providers.vscode-proxy.name="VS Code Proxy"';
const HELPER = '/home/u/.codex/packages/app-server-daemon/releases/0.162.1-x86_64-unknown-linux-musl/bin/codex-code-mode-host --port 1';

test('stale daemons are the shared daemon, its code-mode host and the agent host server, never extension-owned servers or probes', () => {
  assert.equal(isExtensionOwnedCodexAppServer(HOST), true);
  assert.equal(isExtensionOwnedCodexAppServer('C:\\Users\\u\\.vscode\\extensions\\openai.chatgpt-1.0\\bin\\codex.exe app-server'), true);
  assert.equal(isExtensionOwnedCodexAppServer(DAEMON), false);
  assert.equal(isExtensionOwnedCodexAppServer(SDK), false);
  assert.equal(isCodexDaemonHelper(HELPER), true);
  assert.equal(isCodexDaemonHelper(DAEMON), false);
  const changedAt = NOW;
  const old = (pid, command) => ({ pid, ppid: 1, startedAt: NOW - 3_600_000, command });
  const processes = [old(1, DAEMON), old(2, SDK), old(3, HELPER), old(4, HOST), old(5, '/usr/bin/codex app-server -c cli_auth_credentials_store="file"'),
    { pid: 6, ppid: 1, startedAt: NOW - 1_000, command: DAEMON }, old(7, '/usr/bin/codex exec hi'), old(99, DAEMON)];
  assert.deepEqual(staleCodexDaemons(processes, changedAt, 99).map((process) => process.pid), [1, 2, 3]);
});

test('ending a process sends TERM, then KILL when it lingers, and reports what is gone', async () => {
  const sent = [];
  let alive = true;
  const signal = (pid, sig) => { sent.push(sig); if (!alive) { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } if (sig === 'SIGTERM') { alive = false; } };
  assert.equal(await terminateProcess(42, 50, signal, async () => {}), true);
  assert.deepEqual(sent, ['SIGTERM', 0]);
  // One that ignores TERM gets KILL after the grace period.
  sent.length = 0; alive = true;
  const stubborn = (pid, sig) => { sent.push(sig); if (!alive) { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } if (sig === 'SIGKILL') { alive = false; } };
  assert.equal(await terminateProcess(42, 30, stubborn, async () => {}), true);
  assert.ok(sent.includes('SIGKILL'));
  // Not ours: it stays and says so; already gone: nothing to do.
  const foreign = () => { throw Object.assign(new Error('no'), { code: 'EPERM' }); };
  assert.equal(await terminateProcess(42, 30, foreign, async () => {}), false);
  const gone = () => { throw Object.assign(new Error('no'), { code: 'ESRCH' }); };
  assert.equal(await terminateProcess(42, 30, gone, async () => {}), true);
});

test('the sweep ends every stale daemon it can and names the ones it cannot', async () => {
  const listed = [{ pid: 1, ppid: 1, startedAt: NOW - 3_600_000, command: DAEMON }, { pid: 2, ppid: 1, startedAt: NOW - 3_600_000, command: SDK },
    { pid: 4, ppid: 7, startedAt: NOW - 3_600_000, command: HOST }];
  const terminated = [];
  const sweep = await terminateStaleCodexDaemons(NOW, { list: async () => listed, terminate: async (pid) => { terminated.push(pid); return pid !== 2; } });
  assert.deepEqual(terminated, [1, 2]);
  assert.deepEqual([sweep.ended.map((p) => p.pid), sweep.kept.map((p) => p.pid)], [[1], [2]]);
  assert.deepEqual(await terminateStaleCodexDaemons(NOW, { list: async () => { throw new Error('no ps'); } }), { ended: [], kept: [] });
});
