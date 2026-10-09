# W8 delegation fixture repair — 2026-10-09

The Codex and Claude cases constructed fixture executable paths relative to the process working directory as `test/fixtures/...`. The test runner launches from the plugin repository root, where the existing executables are actually at `bridge/test/fixtures/...`; under the isolated environment, resolution therefore fell through to CLI discovery and returned `CLI not found` (503).

Updated `bridge/test/delegation.test.mjs` to resolve each existing fixture relative to the test module URL. Both adapters already accept these `.mjs` fixture commands and invoke them through Node. No product code or assertions changed.

Narrow validation passed under the required flock with fresh temporary `HOME`, `AI_USAGE_HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR`, using `scripts/run-tests.js --skip-build bridge/test/delegation.test.mjs`. Results: 4 passed, 0 failed, including Codex and Claude delegation, child tracking, tool handoff, fork, and lineage assertions. The runner propagated `test/helpers/fixtureNetwork.js` to the test process. No live CLI, account, or network access was used.
