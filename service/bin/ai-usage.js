#!/usr/bin/env node
'use strict';
// Entry point of the `ai-usage` command and of the background service (`ai-usage daemon`).
require('../out/cli').main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
);
