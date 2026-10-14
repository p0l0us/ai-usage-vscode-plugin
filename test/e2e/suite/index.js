'use strict';

// A minimal runner for the extension host: no mocha, each *.test.js file exports an array of { name, run } cases.
const fs = require('node:fs');
const path = require('node:path');

async function run() {
  let failed = 0;
  for (const file of fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js')).sort()) {
    for (const { name, run: body } of require(path.join(__dirname, file)).cases) {
      const started = Date.now();
      try {
        await body();
        console.log(`  ok   ${name} (${Date.now() - started} ms)`);
      } catch (error) {
        failed++;
        console.error(`  FAIL ${name}\n${error?.stack || error}`);
      }
    }
  }
  if (failed) throw new Error(`${failed} end-to-end test(s) failed`);
}

module.exports = { run };
