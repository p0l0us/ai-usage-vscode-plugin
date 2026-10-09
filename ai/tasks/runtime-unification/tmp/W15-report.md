# W15 final root gate — 2026-10-09

## Attempt 1

Command: `flock /tmp/ai-usage-runtime-unification-validation.lock npm test`, unfiltered from the repository root. `npm test` completed generation and both TypeScript builds, then ran all three suites: **512 tests, 511 passed, 1 failed, 0 skipped/cancelled**. Exit code **1**. Full output: [W15-validation.log](W15-validation.log).

Only failure: `test/configSync.test.js:120`, “presentation, deployment and workspace values stay editor-local on seed, hydration and user change.” At line 131, the test expected the engine write `[['aiUsage.codex.source', 'both']]`; actual was `[['aiUsage.codex.source', 'auto']]`. The owner confirmed this fixture expectation was stale after the authorized `auto` default and changed only that expected value; all editor-local assertions remain intact.

## Final affected-check rerun

After the fixture correction, W15 ran `node scripts/run-tests.js --skip-build test/configSync.test.js` under the shared flock, isolated four-home environment and the runner's external-network guard. The unchanged product source had already compiled in attempt 1; this test-only correction did not warrant repeating compilation. Result: **7/7 passed, 0 failed/skipped/cancelled**, exit code **0**. Output: [W15-configSync-recheck.log](W15-configSync-recheck.log).

Final gate disposition: **PASS by full-run plus affected-check rerun**. Attempt 1 exercised all **512** tests (511 pass, the one now-corrected configSync expectation failed); the targeted rerun exercised the seven configSync tests, all passing. Together the evidence covers the current 512-test inventory with each test passing in at least one run. The full root suite was not repeated, and this is not a claim of a 512/512 result in one invocation.

## Isolation and snapshot

Held the shared validation flock for the full command. The outer `npm test` environment used a fresh temporary `HOME`, `AI_USAGE_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `USERPROFILE`, with GitHub tokens unset. `scripts/run-tests.js` additionally isolates its compile/test children and applies `test/helpers/fixtureNetwork.js` to deny public HTTP/HTTPS/fetch requests in test workers. No live accounts/providers, install, version bump, commit, index change or publish.

All **26** pre-run W14/W6/W16 source fingerprints captured for this gate match after both runs. `docs/RUNTIME_SECURITY_AUDIT.md` contains the accepted W16 extension and MCP helper/provider fingerprints; these match the pre-run snapshot. `git diff --check` passed after the rerun. Generated `service/src/settingsCatalog.ts` was already modified before this run as expected from W12 schema generation; no new generated drift was introduced. `package-lock.json` remains unchanged and `package.json` has no version edit. Native macOS and Windows remain untested.

W10/W11/W12/W14 reports were accepted before the run; W16 report records its 9/9 narrow tests and reviewer source-only acceptance. No other scope requires a broad rerun after this failure.
