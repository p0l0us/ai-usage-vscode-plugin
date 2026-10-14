'use strict';

// Launches a real VS Code with this extension under development and runs test/e2e/suite inside its extension host.
// Needs a display (use `xvfb-run -a npm run test:e2e` on a headless machine) and network access for the first VS Code
// download; the download is cached in .vscode-test/. Set VSCODE_VERSION to pin a version (default: stable).
// Everything the extension and its embedded service touch lives in a throwaway directory, never the real homes.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '../..');
// Set when started from an Electron-based terminal or tool; it would make VS Code run as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-e2e-'));
  const dirs = {};
  for (const name of ['home', 'service', 'codex', 'claude', 'user-data', 'workspace']) {
    dirs[name] = path.join(temporary, name);
    fs.mkdirSync(dirs[name], { recursive: true });
  }
  // Run the service inside the window (no background daemon, no installer) and keep other prompts quiet.
  const userSettings = path.join(dirs['user-data'], 'User');
  fs.mkdirSync(userSettings, { recursive: true });
  fs.writeFileSync(path.join(userSettings, 'settings.json'), JSON.stringify({
    'aiUsage.accountService.background': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false
  }, null, 2));
  const outputsMissing = ['out/extension.js', 'service/out/index.js'].filter(file => !fs.existsSync(path.join(root, file)));
  if (outputsMissing.length) {
    console.error(`Missing build output (${outputsMissing.join(', ')}). Run "npm run compile" first.`);
    fs.rmSync(temporary, { recursive: true, force: true });
    return 1;
  }
  let code = 1;
  try {
    await runTests({
      version: process.env.VSCODE_VERSION || 'stable',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite/index.js'),
      launchArgs: [dirs.workspace, '--disable-extensions', '--user-data-dir', dirs['user-data'], '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu'],
      extensionTestsEnv: {
        HOME: dirs.home, USERPROFILE: dirs.home, AI_USAGE_HOME: dirs.service, CODEX_HOME: dirs.codex, CLAUDE_CONFIG_DIR: dirs.claude,
        GH_TOKEN: '', GITHUB_TOKEN: ''
      }
    });
    code = 0;
  } catch (error) {
    console.error(`\nThe end-to-end tests failed: ${error?.message || error}`);
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo|download/i.test(String(error?.message))) {
      console.error('VS Code could not be downloaded; check network access or pre-populate .vscode-test/.');
    } else if (/display|DISPLAY|X server|cannot open|Missing X/i.test(String(error?.message))) {
      console.error('No display is available; run "xvfb-run -a npm run test:e2e".');
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return code;
}

main().then(code => { process.exitCode = code; });
