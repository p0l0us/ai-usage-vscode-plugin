'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'p0l0us.ai-usage-vscode-plugin';
const SETTING = 'aiUsage.codex.autoRotate.enabled';
const home = process.env.AI_USAGE_HOME;
const configFile = path.join(home || '', 'config.json');
const manifest = require('../../../package.json');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(description, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last; } catch (error) { last = error; }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const extension = () => vscode.extensions.getExtension(EXTENSION_ID);

exports.cases = [];
const cases = exports.cases;
const test = (name, run) => cases.push({ name, run });

test('the test runs against a throwaway account service home', () => {
  // A guard against the extension ever being tested with real credentials.
  assert.ok(home && home.includes('ai-usage-e2e-'), `AI_USAGE_HOME must be the temporary directory, got ${home}`);
  assert.ok(process.env.HOME.includes('ai-usage-e2e-'));
});

test('the extension activates without error', async () => {
  const ext = extension();
  assert.ok(ext, `${EXTENSION_ID} is not installed in the development host`);
  await ext.activate();
  assert.equal(ext.isActive, true);
});

test('every manifest command is registered (generated chip commands by sample)', async () => {
  await extension().activate();
  const registered = new Set(await vscode.commands.getCommands(true));
  const contributed = manifest.contributes.commands.map(command => command.command);
  const fixed = contributed.filter(command => !/^aiUsage\.(?:chip|chatTokens\.chip)\./.test(command));
  assert.ok(fixed.length >= 15, 'the manifest lists the fixed commands');
  const missing = fixed.filter(command => !registered.has(command));
  assert.deepEqual(missing, [], `commands contributed but not registered: ${missing.join(', ')}`);
  const generated = contributed.filter(command => !fixed.includes(command));
  assert.ok(generated.length > 0, 'the manifest lists the generated chip commands');
  for (const command of [generated[0], generated[Math.floor(generated.length / 2)], generated[generated.length - 1]]) {
    assert.ok(registered.has(command), `${command} is not registered`);
  }
});

test('the embedded service starts and writes config.json under AI_USAGE_HOME', async () => {
  await extension().activate();
  await until('the service to create config.json', () => fs.existsSync(configFile) && readConfig().codex);
});

test('a change to the setting reaches the service config', async () => {
  await until('config.json', () => fs.existsSync(configFile));
  const configuration = vscode.workspace.getConfiguration();
  const before = readConfig().codex.autoRotate.enabled;
  const target = !before;
  await configuration.update(SETTING, target, vscode.ConfigurationTarget.Global);
  await until(`config.json codex.autoRotate.enabled to become ${target}`, () => readConfig().codex.autoRotate.enabled === target);
});

test('a change in config.json is written back to the setting', async () => {
  const current = readConfig();
  const target = !current.codex.autoRotate.enabled;
  // Atomic replace like the service itself, so the watcher never reads a half-written file.
  const edited = { ...current, codex: { ...current.codex, autoRotate: { ...current.codex.autoRotate, enabled: target } } };
  const temporary = `${configFile}.e2e`;
  fs.writeFileSync(temporary, JSON.stringify(edited, null, 2));
  fs.renameSync(temporary, configFile);
  // The service reloads a hand edit on its next tick (TICK_MS = 60 s in service/src/accountService.ts); nothing public
  // triggers it sooner, so this is the slow case of the suite (up to a minute).
  await until(`the setting to become ${target}`, () => vscode.workspace.getConfiguration().get(SETTING) === target, 75_000);
});

test('the status bar and refresh do not fail with no accounts saved', async () => {
  const ext = extension();
  await vscode.commands.executeCommand('aiUsage.refresh');
  assert.equal(ext.isActive, true, 'the extension is still active after a refresh without accounts');
  const profiles = path.join(home, 'profiles.json');
  if (fs.existsSync(profiles)) {
    const saved = JSON.parse(fs.readFileSync(profiles, 'utf8'));
    assert.deepEqual(saved.profiles || [], [], 'the throwaway home starts without saved accounts');
  }
});
