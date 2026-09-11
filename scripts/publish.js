// Publishes the extension to the Visual Studio Marketplace (and optionally Open VSX).
//
//   npm run publish                 # Marketplace
//   npm run publish -- --pre-release
//   npm run publish -- --ovsx       # also publish to Open VSX (needs OVSX_PAT)
//   npm run publish -- --yes        # non-interactive: auto-bump patch if the version is taken
//   npm run publish -- --dry-run    # do everything except the publish step
//
// Before publishing it checks that the version in package.json is not already on the
// Marketplace. If it is, it offers to bump (patch/minor/major) using scripts/bump-version.js,
// then builds, packages to a temp folder and publishes. Nothing is committed or tagged.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const preRelease = flag('--pre-release');
const alsoOvsx = flag('--ovsx');
const assumeYes = flag('--yes') || flag('-y');
const dryRun = flag('--dry-run');

const readPkg = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const run = (cmd, cmdArgs, opts = {}) => {
  const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};
const capture = (cmd, cmdArgs) =>
  spawnSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });

const compare = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] - pb[i];
    }
  }
  return 0;
};

async function ask(question, choices, fallback) {
  if (assumeYes || !process.stdin.isTTY) {
    return fallback;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [${choices.join('/')}] (${fallback}): `, (answer) => {
      rl.close();
      const value = answer.trim().toLowerCase() || fallback;
      resolve(choices.includes(value) ? value : fallback);
    });
  });
}

/** Versions already on the Marketplace, newest first; [] when the extension is not published yet. */
function publishedVersions(id) {
  const result = capture('npx', ['--yes', '@vscode/vsce', 'show', id, '--json']);
  if (result.status !== 0) {
    if (/not found|404|does not exist/i.test(result.stderr + result.stdout)) {
      return [];
    }
    console.error(result.stderr || result.stdout);
    console.error('Could not query the Marketplace. Check your network or VSCE_PAT and retry.');
    process.exit(1);
  }
  try {
    const data = JSON.parse(result.stdout);
    return (data.versions || []).map((v) => v.version).sort((a, b) => compare(b, a));
  } catch {
    return [];
  }
}

(async () => {
  let pkg = readPkg();
  const id = `${pkg.publisher}.${pkg.name}`;

  if (!process.env.VSCE_PAT) {
    console.log('VSCE_PAT is not set; vsce will use the token stored by `vsce login`, if any.');
  }

  console.log(`Checking Marketplace for ${id}…`);
  const published = publishedVersions(id);
  const latest = published[0];
  console.log(published.length ? `Published versions: ${published.join(', ')}` : 'Not published yet.');

  if (published.includes(pkg.version) || (latest && compare(pkg.version, latest) <= 0)) {
    const reason = published.includes(pkg.version)
      ? `Version ${pkg.version} is already published.`
      : `Version ${pkg.version} is not newer than the published ${latest}.`;
    console.log(reason);
    const choice = await ask('Bump the version?', ['patch', 'minor', 'major', 'abort'], 'patch');
    if (choice === 'abort') {
      console.log('Aborted. Nothing was published.');
      process.exit(1);
    }
    run('node', [path.join('scripts', 'bump-version.js'), choice]);
    pkg = readPkg();
    if (published.includes(pkg.version) || (latest && compare(pkg.version, latest) <= 0)) {
      // The bump landed on or below an existing version (e.g. patch after a higher published one).
      console.error(`Bumped to ${pkg.version}, which is still not above ${latest}. Set the version by hand: npm run bump <x.y.z>`);
      process.exit(1);
    }
    console.log(`Version is now ${pkg.version}. Remember to fill in CHANGELOG.md before committing.`);
  }

  if (pkg.enabledApiProposals?.length) {
    console.error('package.json declares enabledApiProposals; the Marketplace rejects those. Remove them first.');
    process.exit(1);
  }

  run('npm', ['run', 'compile']);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-release-'));
  const vsix = path.join(tmp, `${pkg.name}-${pkg.version}.vsix`);
  const packageArgs = ['--yes', '@vscode/vsce', 'package', '--no-dependencies', '-o', vsix];
  const publishArgs = ['--yes', '@vscode/vsce', 'publish', '--no-dependencies', '--packagePath', vsix];
  if (preRelease) {
    packageArgs.push('--pre-release');
    publishArgs.push('--pre-release');
  }
  run('npx', packageArgs);

  if (dryRun) {
    console.log(`Dry run: would publish ${id}@${pkg.version}${preRelease ? ' (pre-release)' : ''}. Package: ${vsix}`);
    process.exit(0);
  }
  const go = await ask(`Publish ${id}@${pkg.version}${preRelease ? ' (pre-release)' : ''} to the Marketplace?`, ['y', 'n'], 'y');
  if (go !== 'y') {
    console.log(`Aborted. The package is at ${vsix}`);
    process.exit(1);
  }
  run('npx', publishArgs);

  if (alsoOvsx) {
    if (!process.env.OVSX_PAT) {
      console.error('OVSX_PAT is not set; skipping Open VSX.');
    } else {
      run('npx', ['--yes', 'ovsx', 'publish', vsix, '-p', process.env.OVSX_PAT]);
    }
  }

  console.log(`\nPublished ${id}@${pkg.version}.`);
  console.log('Next: fill in CHANGELOG.md if needed, then');
  console.log(`  git add -A && git commit -m "Release v${pkg.version}" && git tag v${pkg.version} && git push && git push --tags`);
})();
