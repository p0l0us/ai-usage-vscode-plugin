// Publishes the extension to the Visual Studio Marketplace (and optionally Open VSX).
//
//   npm run publish                 # Marketplace
//   npm run publish -- --pre-release
//   npm run publish -- --ovsx       # also publish to Open VSX (needs OVSX_PAT)
//   npm run publish -- --yes        # non-interactive: auto-bump patch if the version is taken
//   npm run publish -- --dry-run    # do everything except the publish and git steps
//   npm run publish -- --no-push    # commit and tag locally, but do not push
//
// Before publishing it checks that the version in package.json is not already on the
// Marketplace. If it is, it offers to bump (patch/minor/major) using scripts/bump-version.js.
// CHANGELOG.md must have a filled-in section for the version. It then builds and packages to a
// temp folder, commits the working tree as "Release v<version>" and creates the annotated tag
// v<version> on that commit, so the tag is exactly what was packaged, and publishes. A failed
// publish removes the tag and undoes the commit. Finally it pushes the branch and the tag.
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
const noPush = flag('--no-push');

const readPkg = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const run = (cmd, cmdArgs, opts = {}) => {
  const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};
const capture = (cmd, cmdArgs) =>
  spawnSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
/** Like run, but reports failure instead of exiting, for steps that must be undone or only warned about. */
const attempt = (cmd, cmdArgs) =>
  spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' }).status === 0;
const git = (...gitArgs) => capture('git', gitArgs);
const gitOut = (...gitArgs) => (git(...gitArgs).stdout || '').trim();

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

const changelogPath = path.join(root, 'CHANGELOG.md');

/**
 * The CHANGELOG section for `version`: 'missing', 'empty' (only the "- " placeholder bump-version.js writes) or
 * 'ok'. An "(unreleased)" header of a filled-in section is dated today.
 */
function checkChangelog(version) {
  if (!fs.existsSync(changelogPath)) {
    return 'ok';
  }
  let changelog = fs.readFileSync(changelogPath, 'utf8');
  const escaped = version.replace(/\./g, '\\.');
  const header = new RegExp(`^## ${escaped}(?: \\(([^)]*)\\))?[ \\t]*$`, 'm');
  const match = header.exec(changelog);
  if (!match) {
    return 'missing';
  }
  const rest = changelog.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  const body = (next < 0 ? rest : rest.slice(0, next)).split('\n').map((line) => line.trim()).filter(Boolean);
  if (!body.some((line) => line !== '-')) {
    return 'empty';
  }
  if (match[1] === 'unreleased' && !dryRun) {
    const today = new Date().toISOString().slice(0, 10);
    changelog = changelog.slice(0, match.index) + `## ${version} (${today})` + changelog.slice(match.index + match[0].length);
    fs.writeFileSync(changelogPath, changelog);
    console.log(`Dated the CHANGELOG.md section: ${version} (${today}).`);
  }
  return 'ok';
}

/** Where tag `tag` points locally and on origin, as commit ids; undefined where it does not exist. */
function tagTargets(tag) {
  const local = git('rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`);
  const remote = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
  const lines = (remote.stdout || '').trim().split('\n').filter(Boolean).map((line) => line.split(/\s+/));
  // An annotated tag is listed twice; the peeled ^{} line names the commit.
  const peeled = lines.find(([, ref]) => ref.endsWith('^{}')) ?? lines[0];
  return { local: local.status === 0 ? local.stdout.trim() : undefined, remote: peeled?.[0] };
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

  const untagged = published.filter((version) => git('rev-parse', '-q', '--verify', `refs/tags/v${version}`).status !== 0);
  if (untagged.length) {
    console.log(`Note: published versions without a git tag: ${untagged.join(', ')}.`);
  }

  let changelogState = checkChangelog(pkg.version);
  while (changelogState !== 'ok') {
    const problem = changelogState === 'missing'
      ? `CHANGELOG.md has no "## ${pkg.version}" section.`
      : `The CHANGELOG.md section for ${pkg.version} is still empty.`;
    if (dryRun) {
      console.log(`Warning: ${problem} A real publish would stop here.`);
      break;
    }
    if (assumeYes || !process.stdin.isTTY) {
      console.error(`${problem} The release commit and tag are made before publishing, so fill it in first.`);
      process.exit(1);
    }
    const retry = await ask(`${problem} Fill it in, then continue?`, ['y', 'abort'], 'y');
    if (retry === 'abort') {
      console.log('Aborted. Nothing was published.');
      process.exit(1);
    }
    changelogState = checkChangelog(pkg.version);
  }

  const tag = `v${pkg.version}`;
  const existing = tagTargets(tag);
  const head = gitOut('rev-parse', 'HEAD');
  const clean = gitOut('status', '--porcelain') === '';
  // A tag left from an earlier attempt is only reused when it already names exactly what would be released.
  const reuseTag = (existing.local || existing.remote) && clean &&
    (!existing.local || existing.local === head) && (!existing.remote || existing.remote === head);
  if ((existing.local || existing.remote) && !reuseTag) {
    console.error(`Tag ${tag} already exists (${[existing.local && `local ${existing.local.slice(0, 7)}`,
      existing.remote && `origin ${existing.remote.slice(0, 7)}`].filter(Boolean).join(', ')}) but does not name the ` +
      `current${clean ? '' : ', uncommitted'} tree. Delete it (git tag -d ${tag}; git push origin :refs/tags/${tag}) ` +
      'or bump the version, then retry.');
    process.exit(1);
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

  // Commit and tag before publishing so the tag names exactly the tree that was packaged.
  let committed = false;
  let tagged = false;
  if (!clean) {
    run('git', ['add', '-A']);
    run('git', ['commit', '-m', `Release ${tag}`]);
    committed = true;
  }
  if (!existing.local) {
    run('git', ['tag', '-a', tag, '-m', `Release ${tag}`]);
    tagged = true;
  }

  if (!attempt('npx', publishArgs)) {
    console.error('Publishing failed; undoing the release commit and tag.');
    if (tagged) {
      attempt('git', ['tag', '-d', tag]);
    }
    if (committed) {
      attempt('git', ['reset', '--soft', 'HEAD~1']);
    }
    process.exit(1);
  }

  if (alsoOvsx) {
    if (!process.env.OVSX_PAT) {
      console.error('OVSX_PAT is not set; skipping Open VSX.');
    } else {
      run('npx', ['--yes', 'ovsx', 'publish', vsix, '-p', process.env.OVSX_PAT]);
    }
  }

  console.log(`\nPublished ${id}@${pkg.version}${committed ? `, committed as "Release ${tag}"` : ''} and tagged ${tag}.`);

  const manual = `  git push origin HEAD && git push origin ${tag}`;
  const push = noPush ? 'n' : await ask(`Push the branch and tag ${tag} to origin?`, ['y', 'n'], 'y');
  if (push !== 'y') {
    console.log(`Not pushed. To push later:\n${manual}`);
    return;
  }
  // The release is already out: a failed push is reported, not undone.
  const pushed = attempt('git', ['push', 'origin', 'HEAD']) && attempt('git', ['push', 'origin', tag]);
  console.log(pushed ? `Pushed the branch and ${tag}.` : `Push failed. The release commit and tag are local; retry with:\n${manual}`);
  if (!pushed) {
    process.exitCode = 1;
  }
})();
