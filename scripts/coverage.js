#!/usr/bin/env node
'use strict';

// Runs the suite under Node's built-in V8 coverage, prints a summary per area and file, writes coverage/lcov.info and
// enforces coverage-thresholds.json as a ratchet. See docs/TESTING.md.
//
//   node scripts/coverage.js [--skip-build] [--files a.test.js b.test.js] [--update] [--help]
//
// --files runs only those tests and skips the threshold check (a subset cannot meet suite-wide floors).
// --update raises every floor to the current value minus one point (floors never go down).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const thresholdsFile = path.join(root, 'coverage-thresholds.json');
const outputDir = path.join(root, 'coverage');
const lcovFile = path.join(outputDir, 'lcov.info');

const AREAS = [
  { name: 'service', prefix: 'service/out/' },
  { name: 'extension', prefix: 'out/' },
  { name: 'bridge', prefix: 'bridge/src/' }
];
const areaOf = file => AREAS.find(area => file.startsWith(area.prefix))?.name;

/** `out/foo.js` is built from `src/foo.ts`, `service/out/foo.js` from `service/src/foo.ts`. */
function sourceName(file) {
  const match = /^(service\/)?out\/(.+)\.js$/.exec(file);
  return match ? `${match[1] || ''}src/${match[2]}.ts` : file;
}

function parseLcov(text) {
  const files = new Map();
  let current;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const name = path.relative(root, path.resolve(root, line.slice(3))).split(path.sep).join('/');
      current = { file: name, found: 0, hit: 0 };
      files.set(name, current);
    } else if (current && line.startsWith('LF:')) current.found = Number(line.slice(3));
    else if (current && line.startsWith('LH:')) current.hit = Number(line.slice(3));
  }
  return files;
}

const percent = (hit, found) => (found ? (hit / found) * 100 : 100);
const format = value => value.toFixed(1).padStart(5);

function main(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/coverage.js [--skip-build] [--update] [--files <test files...>]\n' +
      'Runs the tests with V8 coverage, writes coverage/lcov.info, prints per-area and per-file line coverage,\n' +
      'lists compiled files no test loads and fails when a floor in coverage-thresholds.json is violated.');
    return 0;
  }
  const skipBuild = args.includes('--skip-build');
  const update = args.includes('--update');
  const filesIndex = args.indexOf('--files');
  const subset = filesIndex >= 0 ? args.slice(filesIndex + 1).filter(arg => !arg.startsWith('--')) : [];
  if (filesIndex >= 0 && !subset.length) { console.error('--files needs at least one test file.'); return 2; }

  // Same isolation as scripts/run-tests.js: tests never see the developer's account homes.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-coverage-'));
  const env = { ...process.env };
  for (const [key, name] of Object.entries({ HOME: 'home', AI_USAGE_HOME: 'service', CODEX_HOME: 'codex', CLAUDE_CONFIG_DIR: 'claude' })) {
    env[key] = path.join(temporary, name);
    fs.mkdirSync(env[key], { recursive: true });
  }
  env.USERPROFILE = env.HOME;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  try {
    if (!skipBuild) {
      const npmEntry = process.env.npm_execpath;
      const command = npmEntry ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const buildArgs = npmEntry ? [npmEntry, 'run', 'compile'] : ['run', 'compile'];
      const build = spawnSync(command, buildArgs, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' && !npmEntry });
      if (build.error) throw build.error;
      if (build.status !== 0) return build.status ?? 1;
    }
    const tests = subset.length ? subset : ['test', 'service/test', 'bridge/test'].flatMap(directory =>
      fs.readdirSync(path.join(root, directory)).filter(file => /\.test\.(?:js|mjs)$/.test(file)).sort().map(file => `${directory}/${file}`));
    fs.mkdirSync(outputDir, { recursive: true });
    fs.rmSync(lcovFile, { force: true });
    const preload = path.join(root, 'test/helpers/fixtureNetwork.js');
    const nodeArgs = ['--test', '--experimental-test-coverage',
      '--test-coverage-include=out/**', '--test-coverage-include=service/out/**', '--test-coverage-include=bridge/src/**',
      '--test-coverage-exclude=**/*.d.ts',
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=lcov', `--test-reporter-destination=${lcovFile}`, ...tests];
    const result = spawnSync(process.execPath, nodeArgs, {
      cwd: root, stdio: 'inherit',
      env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`.trim() }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) { console.error('\nTests failed; coverage is not evaluated.'); return result.status ?? 1; }
    if (!fs.existsSync(lcovFile)) { console.error(`No ${path.relative(root, lcovFile)} was produced.`); return 1; }
    return report(parseLcov(fs.readFileSync(lcovFile, 'utf8')), subset.length > 0, update);
  } catch (error) {
    console.error(error.message);
    return 1;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function report(files, partial, update) {
  console.log('\nLine coverage by area');
  const totals = {};
  for (const area of AREAS) {
    const members = [...files.values()].filter(file => areaOf(file.file) === area.name);
    const found = members.reduce((sum, file) => sum + file.found, 0);
    const hit = members.reduce((sum, file) => sum + file.hit, 0);
    totals[area.name] = percent(hit, found);
    console.log(`  ${area.name.padEnd(10)} ${format(totals[area.name])}%  (${hit}/${found} lines, ${members.length} files)`);
    for (const file of members.sort((a, b) => percent(a.hit, a.found) - percent(b.hit, b.found))) {
      const label = sourceName(file.file);
      console.log(`    ${format(percent(file.hit, file.found))}%  ${file.file}${label !== file.file ? `  <- ${label}` : ''}`);
    }
  }

  // Compiled files that no test loads are invisible to V8 coverage, so compare against the build output.
  const compiled = [['out', 'out/'], ['service/out', 'service/out/']].flatMap(([directory, prefix]) => {
    const full = path.join(root, directory);
    return fs.existsSync(full) ? fs.readdirSync(full).filter(file => file.endsWith('.js')).map(file => prefix + file) : [];
  });
  // A compiled file whose source was deleted is a leftover of an older build, not untested code.
  const unloaded = compiled.filter(file => !files.has(file) && fs.existsSync(path.join(root, sourceName(file))));
  console.log(`\nSource files never loaded by a test: ${unloaded.length}`);
  for (const file of unloaded) {
    const text = fs.readFileSync(path.join(root, sourceName(file)), 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean).length;
    console.log(`  ${sourceName(file)}  (${lines} lines${/^export \* from /.test(text.trim()) ? ', re-export' : ''})`);
  }

  if (partial) { console.log('\nSubset run (--files): thresholds are not enforced.'); return 0; }

  const thresholds = JSON.parse(fs.readFileSync(thresholdsFile, 'utf8'));
  const failures = [];
  for (const [area, floor] of Object.entries(thresholds.areas || {})) {
    if (totals[area] === undefined) failures.push(`area ${area}: unknown area`);
    else if (totals[area] < floor) failures.push(`area ${area}: ${totals[area].toFixed(2)}% < floor ${floor}%`);
  }
  for (const [file, floor] of Object.entries(thresholds.files || {})) {
    const entry = files.get(file);
    const value = entry ? percent(entry.hit, entry.found) : 0;
    if (value < floor) failures.push(`${file}: ${entry ? value.toFixed(2) + '%' : 'not loaded by any test'} < floor ${floor}%`);
  }
  if (update) {
    // Floors only go up: a lower reading is a regression to fix, not a floor to relax.
    const next = (floor, value) => Math.max(floor, Math.min(100, Math.floor(value) - 1));
    for (const area of Object.keys(thresholds.areas || {})) thresholds.areas[area] = next(thresholds.areas[area], totals[area] ?? 0);
    for (const file of Object.keys(thresholds.files || {})) {
      const entry = files.get(file);
      thresholds.files[file] = next(thresholds.files[file], entry ? percent(entry.hit, entry.found) : 0);
    }
    fs.writeFileSync(thresholdsFile, JSON.stringify(thresholds, null, 2) + '\n');
    console.log('\nUpdated coverage-thresholds.json (current value minus one point, never lowered).');
  }
  if (failures.length) {
    console.error('\nCoverage ratchet violated:');
    for (const failure of failures) console.error(`  ${failure}`);
    return 1;
  }
  console.log('\nCoverage ratchet satisfied.');
  return 0;
}

process.exitCode = main(process.argv.slice(2));
