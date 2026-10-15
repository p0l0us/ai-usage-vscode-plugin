#!/usr/bin/env node
'use strict';

// Exercise the distribution consumers install, including its own lifecycle hooks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repository = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-package-'));
const env = { ...process.env, AI_USAGE_CLAUDE_KEYCHAIN: 'off', NO_COLOR: '1' };
for (const [key, name] of Object.entries({ HOME: 'home', USERPROFILE: 'home', AI_USAGE_HOME: 'state', CODEX_HOME: 'codex', CLAUDE_CONFIG_DIR: 'claude', npm_config_cache: 'npm-cache' })) {
  env[key] = path.join(temporary, name);
  fs.mkdirSync(env[key], { recursive: true });
}
delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
delete env.AI_USAGE_TEST_HOME_ISOLATED;
// Descendant daemons use synthetic homes and may only contact local fixture endpoints.
env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require=${JSON.stringify(path.join(repository, 'service/test/helpers/fixtureNetwork.js'))}`.trim();
Object.assign(process.env, env);
delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN;
require('../service/test/helpers/fixtureNetwork');

function run(command, args, cwd, extra = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000, ...extra });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function npm(args, cwd) {
  const entry = process.env.npm_execpath;
  return entry ? run(process.execPath, [entry, ...args], cwd)
    : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd, { shell: process.platform === 'win32' });
}

async function main() {
  let api;
  let host;
  let client;
  try {
    // Build a clean checkout fixture, deliberately omitting all generated output.
    const checkout = path.join(temporary, 'checkout');
    const source = path.join(checkout, 'service');
    fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(repository, 'package.json'), path.join(checkout, 'package.json'));
    for (const script of ['generate-service-settings.js', 'package-service-bridge.js']) {
      fs.copyFileSync(path.join(repository, 'scripts', script), path.join(checkout, 'scripts', script));
    }
    fs.cpSync(path.join(repository, 'bridge'), path.join(checkout, 'bridge'), { recursive: true });
    fs.cpSync(path.join(repository, 'service'), source, { recursive: true,
      filter: file => !['out', 'bridge', 'node_modules'].includes(path.relative(path.join(repository, 'service'), file).split(path.sep)[0]) && !file.endsWith('.tgz') });
    fs.symlinkSync(path.join(repository, 'node_modules'), path.join(checkout, 'node_modules'), 'junction');
    const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', temporary], source));
    const files = new Set(packed.files.map(file => file.path));
    for (const file of ['out/index.js', 'out/index.d.ts', 'out/cli.js', 'bin/ai-usage.js', 'bridge/src/cli.mjs', 'bridge/package.json', 'LICENSE', 'README.md']) {
      assert.ok(files.has(file), `Missing package artifact: ${file}`);
    }
    assert.ok([...files].every(file => !/^(?:src|test|node_modules)\//.test(file) && !file.endsWith('.map')));
    console.log('Clean npm pack built the service, declarations and bundled bridge.');

    // Check that the prepared source directory can build/test without a parent plugin.
    const standalone = path.join(temporary, 'standalone');
    fs.renameSync(source, standalone);
    fs.symlinkSync(path.join(repository, 'node_modules'), path.join(standalone, 'node_modules'), 'junction');
    npm(['test', '--', 'test/configStore.test.js', 'test/rpc.test.js', 'test/statusSnapshot.test.js'], standalone);
    assert.ok(fs.existsSync(path.join(standalone, 'bridge/src/cli.mjs')));
    console.log('Standalone source build and selected service integration tests passed.');

    const consumer = path.join(temporary, 'consumer');
    fs.mkdirSync(consumer);
    npm(['install', '--prefix', consumer, '--offline', '--omit=dev', '--no-audit', '--no-fund', path.join(temporary, packed.filename)], consumer);
    const installed = path.join(consumer, 'node_modules', 'ai-usage-service');
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    const cli = path.join(installed, manifest.bin['ai-usage']);
    assert.equal(run(process.execPath, [cli, '--version'], consumer).trim(), manifest.version);
    assert.match(run(process.execPath, [cli, '--help'], consumer), /ai-usage/);
    assert.ok(fs.existsSync(path.join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'ai-usage.cmd' : 'ai-usage')));
    assert.ok(!fs.existsSync(path.join(consumer, 'node_modules', 'typescript')));
    // The published scripts can repack already-built output without a compiler.
    npm(['pack', '--json', '--pack-destination', consumer], installed);

    const ts = require('typescript');
    const declarationConsumer = path.join(consumer, 'consumer.ts');
    fs.writeFileSync(declarationConsumer, `import { ServiceClient } from 'ai-usage-service';
async function read(client: ServiceClient) {
  const accounts = await client.list('codex');
  accounts.profiles.map(profile => profile.name.toUpperCase());
  // @ts-expect-error Providers must be recognized by the service.
  await client.list('unknown');
}
`);
    const program = ts.createProgram([declarationConsumer], { noEmit: true, strict: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      typeRoots: [path.join(repository, 'node_modules/@types')], types: ['node'] });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: file => file, getCurrentDirectory: () => consumer, getNewLine: () => '\n' }));

    api = require(installed);
    const config = api.defaultConfig();
    for (const provider of ['claude', 'codex', 'copilot']) config[provider].enabled = false;
    config.bridge.autoStart = false; config.codex.autoReset.enabled = false;
    api.saveConfig(api.configFileOf(env.AI_USAGE_HOME), config);
    // Use the npm copy's embedded engine and its public typed client over a real socket.
    host = await api.startServiceHost({ home: env.AI_USAGE_HOME, mode: 'embedded' });
    client = await api.ServiceClient.connect({ home: env.AI_USAGE_HOME, client: 'npm-package-test' });
    assert.equal(client.info.version, manifest.version);
    assert.deepEqual((await client.list('codex')).profiles, []);
    client.close(); client = undefined;
    await host.stop(); host = undefined;

    // Exercise the daemon CLI independently; status must connect to the installed npm code.
    run(process.execPath, [cli, 'status', '--json'], consumer);
    client = await api.ServiceClient.connect({ home: env.AI_USAGE_HOME, client: 'npm-daemon-test' });
    assert.equal(client.info.version, manifest.version);
    await client.shutdown(); client.close(); client = undefined;
    // Wait for shutdown to release the home before cleanup.
    const deadline = Date.now() + 10_000;
    while (api.readServiceInfo(env.AI_USAGE_HOME) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(api.readServiceInfo(env.AI_USAGE_HOME), undefined);
    console.log('Offline npm install, CLI, public API, embedded host and daemon passed.');
  } finally {
    if (client) { await client.shutdown().catch(() => {}); client.close(); }
    await host?.stop();
    // A failed assertion after CLI startup must not leave a detached daemon behind.
    if (api?.readServiceInfo(env.AI_USAGE_HOME)) await api.stopService(env.AI_USAGE_HOME);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
