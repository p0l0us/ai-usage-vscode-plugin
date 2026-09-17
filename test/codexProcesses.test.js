const assert = require('node:assert/strict');
const test = require('node:test');
const { parseElapsedSeconds, parsePsListing, parseWindowsListing, isCodexAppServer, staleCodexProcesses } = require('../out/codexProcesses');

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
