#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const repository = path.dirname(root);

// Regenerate shared inputs in this repository. A prepared service source directory
// can also be built on its own, with its checked-in settings catalog and copied bridge.
let parent;
try { parent = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')); } catch { /* Standalone package. */ }
if (parent?.name === 'ai-usage-vscode-plugin') {
  for (const script of ['generate-service-settings.js', 'package-service-bridge.js']) {
    execFileSync(process.execPath, [path.join(repository, 'scripts', script)], { stdio: 'inherit' });
  }
}

if (fs.existsSync(path.join(root, 'src'))) {
  // Do not ship JavaScript left behind by renamed/deleted sources or a failed build.
  const compiler = require.resolve('typescript/bin/tsc', { paths: [root] });
  fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
  execFileSync(process.execPath, [compiler, '-p', root, '--noEmitOnError'], { stdio: 'inherit' });
}

// npm can also repack the compiled distribution, without TypeScript or a parent checkout.
for (const file of ['bin/ai-usage.js', 'out/index.js', 'out/index.d.ts', 'out/cli.js',
  'bridge/src/cli.mjs', 'bridge/package.json', 'README.md', 'LICENSE']) {
  if (!fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Incomplete service package: missing ${file}. Run npm run compile:service in the plugin checkout before copying service/.`);
  }
}
