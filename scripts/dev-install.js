// Builds the current working tree into a temporary VSIX (outside the repo) and installs it into
// the VS Code that is running here: the remote server when inside Remote-SSH/WSL/containers,
// otherwise the desktop `code` CLI. Nothing is written into the repository.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// A fresh version prevents VS Code from reusing an earlier development build.
const devVersion = process.env.AI_USAGE_DEV_VERSION || `9.9.${Math.floor(Date.now() / 1000)}`;
const extensionId = `${pkg.publisher}.${pkg.name}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-dev-'));
const vsix = path.join(tmpDir, `${pkg.name}-${devVersion}-dev.vsix`);

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Locate a VS Code CLI. Prefer the server that owns this shell (remote sessions), then desktop.
function findCli() {
  const candidates = [];
  const serverRoot = path.join(os.homedir(), '.vscode-server', 'cli', 'servers');
  const commit = process.env.VSCODE_GIT_ASKPASS_NODE?.match(/Stable-([a-f0-9]{40})/)?.[1]
    ?? process.env.VSCODE_IPC_HOOK_CLI?.match(/([a-f0-9]{40})/)?.[1];
  if (fs.existsSync(serverRoot)) {
    const servers = fs.readdirSync(serverRoot)
      .filter((d) => d.startsWith('Stable-') && !d.endsWith('.staging'))
      .map((d) => path.join(serverRoot, d, 'server', 'bin', 'code-server'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const own = commit && servers.find((p) => p.includes(commit));
    candidates.push(...(own ? [own, ...servers.filter((p) => p !== own)] : servers));
  }
  for (const name of ['code', 'code-insiders', 'codium', 'cursor']) {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
    if (which.status === 0) {
      const bin = which.stdout.trim().split(/\r?\n/)[0];
      // The standalone `code` CLI (no desktop install) cannot install extensions; skip it.
      const probe = spawnSync(bin, ['--list-extensions'], { encoding: 'utf8' });
      if (probe.status === 0) {
        candidates.push(bin);
      }
    }
  }
  return candidates;
}

run('npm', ['run', 'compile']);
// Keep README image links relative so the locally installed extension page renders the bundled
// screenshots without needing them on GitHub (the publish script rewrites them for the Marketplace).
run('npx', [
  '--yes', '@vscode/vsce', 'package', devVersion,
  '--no-update-package-json', '--no-git-tag-version',
  '--no-dependencies', '--no-rewrite-relative-links', '-o', vsix
]);

const clis = findCli();
if (!clis.length) {
  console.error(`No VS Code CLI found. Install manually: Extensions → … → Install from VSIX → ${vsix}`);
  process.exit(1);
}

const targets = process.argv.includes('--all') ? clis : [clis[0]];
for (const cli of targets) {
  console.log(`\n→ installing into ${cli}`);
  // VS Code refuses to reinstall the same version too often in one session; uninstall first.
  spawnSync(cli, ['--uninstall-extension', extensionId], { stdio: 'ignore' });
  run(cli, ['--install-extension', vsix, '--force']);
}
console.log(`\nInstalled ${extensionId}@${devVersion} (dev build; package.json remains ${pkg.version}). Reload the VS Code window to activate.`);
console.log(`VSIX: ${vsix}`);
