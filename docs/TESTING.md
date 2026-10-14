# Testing and coverage

## Layout

| Kind | Where | Run |
| --- | --- | --- |
| Unit and integration | `test/`, `service/test/`, `bridge/test/` (`*.test.js`, node:test + `assert/strict`) | `npm test` |
| Parity | `test/*Parity.test.js`: the extension's TypeScript and the service must give the same answers | part of `npm test` |
| Contract | `test/settingsContract.test.js`: package.json settings vs the service schema (scope, defaults, limits, types) | part of `npm test` |
| End to end | `test/e2e/`: a real VS Code with the extension loaded, run inside the extension host | `xvfb-run -a npm run test:e2e` (plain `npm run test:e2e` where a display exists) |

`npm test` compiles first and runs only files directly inside the three test folders, so `test/e2e/` never runs there.
The e2e run downloads VS Code into `.vscode-test/` on first use, takes about a minute (one case waits for the
service's 60 s tick to pick up a hand-edited `config.json`) and needs `npm run compile` to have run.

## Isolation rule

Tests must never read or write the real account service home (`~/.ai-usage`), `~/.claude` or `~/.codex`. Every runner
(`scripts/run-tests.js`, `scripts/coverage.js`, `test/e2e/runTest.js`) points `HOME`, `AI_USAGE_HOME`, `CODEX_HOME` and
`CLAUDE_CONFIG_DIR` at a temporary directory and preloads `test/helpers/isolatedHome.js`, which gives each test process
its own `HOME` beneath that directory (services started by different files must not share the default per-profile CLI
homes `~/.claude-profile-N`), and `test/helpers/fixtureNetwork.js`, which refuses non-loopback network access. A fixture
that creates a profile store or service sets `AI_USAGE_HOME` to its own temporary directory.
When running a single file by hand, use `AI_USAGE_HOME=$(mktemp -d) node --test <file>`.

## Coverage ratchet

`npm run coverage` builds, runs the whole suite under Node's V8 coverage, writes `coverage/lcov.info` and prints line
coverage per area (extension `out/`, service `service/out/`, bridge `bridge/src/`) and per file, maps compiled files back to
their `src/*.ts` names, and lists compiled files no test loads.

`coverage-thresholds.json` holds floors for each area and for the core service files. The run fails when a value drops
below its floor. Floors are raised, never lowered to make a run pass: after coverage improves, run
`npm run coverage -- --update` (rewrites each floor to the current value minus one point, only upwards) and commit the file.

For a quick look at one test file: `node scripts/coverage.js --skip-build --files service/test/configStore.test.js`
(thresholds are not enforced for a subset).

## Mutation testing

`npm run mutation` runs StrykerJS (`stryker.config.json`) on `service/out/accountAutomation.js` and
`service/out/configStore.js` with the account automation, config store and account service tests. It is slow (a full test run
per mutant, about 25 minutes for configStore alone), so it is run by hand, not in CI. Narrow it with
`npx stryker run --mutate service/out/configStore.js`. Reports go to `reports/mutation/` (open `index.html`); the incremental
file there makes later runs faster. A surviving mutant is a behavior no test pins down: add an assertion that fails for it.
Compile before running (`npm run compile`); the mutants are applied to the compiled JavaScript.

## Writing tests

- Assert behavior a user or caller depends on, not that code ran; a test should fail when the behavior is broken.
- Follow the existing style: CommonJS, node:test, `assert/strict`, 2-space indent, short comments that say why.
- Keep fixtures local and temporary; never depend on the developer's logins, usage or network.
- Fixed-port tests (codex proxy, proxy runtime, engine host) cannot run in parallel with each other.
