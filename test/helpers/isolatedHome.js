'use strict';
// Preloaded into every test process by scripts/run-tests.js. The runner gives the whole run one temporary HOME;
// `node --test` runs each file in its own process, and several files start an account service that assigns the
// default per-profile CLI homes (`~/.claude-profile-N`, `~/.codex-profile-N`) under that HOME. Two files doing so at
// the same time met in the same directory with different profile ids and failed with "This account home belongs to
// another profile". So each test process gets its own HOME beneath the run's one. Child processes a test starts
// (the CLI, a daemon) inherit it unchanged, which the marker variable guarantees.
const fs = require('node:fs');
const path = require('node:path');

const shared = process.env.HOME;
if (shared && !process.env.AI_USAGE_TEST_HOME_ISOLATED) {
  const own = path.join(shared, `process-${process.pid}`);
  fs.mkdirSync(own, { recursive: true });
  process.env.HOME = own;
  process.env.USERPROFILE = own;
  process.env.AI_USAGE_TEST_HOME_ISOLATED = own;
}
