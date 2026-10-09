#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Isolate compilation and every test worker from the developer's account homes.
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-tests-'));
const env = { ...process.env };
for (const [key, name] of Object.entries({ HOME: 'home', AI_USAGE_HOME: 'service', CODEX_HOME: 'codex', CLAUDE_CONFIG_DIR: 'claude' })) {
  env[key] = path.join(temporary, name);
  fs.mkdirSync(env[key], { recursive: true });
}
// Windows and GitHub tooling can otherwise resolve a second, real home or token.
env.USERPROFILE = env.HOME;
delete env.GH_TOKEN;
delete env.GITHUB_TOKEN;

let exitCode = 1;
try {
  const args = process.argv.slice(2);
  const skipBuild = args[0] === '--skip-build';
  if (skipBuild) args.shift();
  if (!skipBuild) {
    const npmEntry = process.env.npm_execpath;
    const command = npmEntry ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const buildArgs = npmEntry ? [npmEntry, 'run', 'compile'] : ['run', 'compile'];
    const build = spawnSync(command, buildArgs, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' && !npmEntry });
    if (build.error) throw build.error;
    if (build.status !== 0) exitCode = build.status ?? 1;
    else exitCode = 0;
  } else exitCode = 0;
  if (exitCode === 0) {
    const files = args.length ? args : ['test', 'service/test', 'bridge/test'].flatMap(directory =>
      fs.readdirSync(path.join(root, directory)).filter(file => /\.test\.(?:js|mjs)$/.test(file)).sort().map(file => path.join(directory, file)));
    const preload = path.join(root, 'test/helpers/fixtureNetwork.js');
    const testEnv = { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`.trim() };
    const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, env: testEnv, stdio: 'inherit' });
    if (result.error) throw result.error;
    exitCode = result.status ?? 1;
  }
} catch (error) {
  exitCode = 1;
  console.error(error.message);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exitCode = exitCode || process.exitCode || 0;
}
