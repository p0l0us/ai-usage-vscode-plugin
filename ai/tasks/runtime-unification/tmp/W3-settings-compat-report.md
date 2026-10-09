# W3 settings compatibility report

- `readSettings()` now validates each returned editor value through shared `setConfigValue()` validation and excludes invalid values from the batch.
- Invalid setting warnings are shown once per key per extension session and omit the supplied value; no editor preference is modified.
- Regression coverage confirms legacy `refreshIntervalMinutes = 0.5` is skipped, config/menu interpretation falls back safely, valid settings remain available, repeated reads warn once, and the stored editor value remains unchanged.
- Validation passed under `/tmp/ai-usage-runtime-unification-validation.lock` with isolated `HOME`, `AI_USAGE_HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR`, plus the fixture network guard: `npx tsc -p ./`; `node --require ./test/helpers/fixtureNetwork.js --test ./test/configSync.test.js` (7/7).
- No install, version change, commit, or account-state operation was performed.
