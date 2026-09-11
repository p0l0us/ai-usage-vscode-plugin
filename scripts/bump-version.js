// Bumps the extension version in package.json and package-lock.json and opens a matching
// section in CHANGELOG.md. Usage: npm run bump [patch|minor|major|x.y.z]   (default: patch)
// Nothing is committed or tagged; review the diff, fill in the changelog, then commit.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const arg = (process.argv[2] || 'patch').trim();

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = pkg.version;
const [major, minor, patch] = current.split('.').map(Number);

let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else if (arg === 'major') {
  next = `${major + 1}.0.0`;
} else if (arg === 'minor') {
  next = `${major}.${minor + 1}.0`;
} else if (arg === 'patch') {
  next = `${major}.${minor}.${patch + 1}`;
} else {
  console.error(`Unknown bump "${arg}". Use patch, minor, major or an explicit x.y.z.`);
  process.exit(1);
}

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = next;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = next;
  }
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

const changelogPath = path.join(root, 'CHANGELOG.md');
if (fs.existsSync(changelogPath)) {
  let changelog = fs.readFileSync(changelogPath, 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  const unreleased = new RegExp(`^## ${current.replace(/\./g, '\\.')} \\(unreleased\\)`, 'm');
  if (unreleased.test(changelog)) {
    // The current version was still marked unreleased: date it and move on to the new one.
    changelog = changelog.replace(unreleased, `## ${current} (${today})`);
  }
  if (!changelog.includes(`## ${next}`)) {
    changelog = changelog.replace(/^# Changelog\s*\n/, `# Changelog\n\n## ${next} (unreleased)\n\n- \n\n`);
  }
  fs.writeFileSync(changelogPath, changelog);
}

console.log(`${current} → ${next}`);
console.log('Updated package.json, package-lock.json and CHANGELOG.md. Fill in the changelog entry, then:');
console.log(`  git add package.json package-lock.json CHANGELOG.md && git commit -m "Release v${next}" && git tag v${next}`);
