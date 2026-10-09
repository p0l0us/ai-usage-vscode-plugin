# W23 — Codex toolbar earned reset count

Implemented default-enabled local presentation setting `aiUsage.codex.statusBar.earnedResets`.
The Codex status bar appends a refresh icon and the available count supplied by the shared
`projectResetCredits` projection. Known zero remains visible; unknown/stale availability has no current
count and is explained in the tooltip. Only the current identity-keyed live reading is used, with no
unproven selected-profile fallback, account aggregate, extra provider check or redemption.

The display-only settings event rerenders cached values without refreshing usage; other and simultaneous
Codex settings changes retain their existing refresh behavior. Whole-percentage formatting and chat chips
remain unchanged. No version bump, installation, account mutation or commit was performed.

Owned changes: `src/extension.ts`, `src/usageFormatting.ts`, new `src/statusBarSettings.ts`, exact setting in
`package.json`, generated `service/src/settingsCatalog.ts`, one presentation-classification entry in
`service/src/configStore.ts`, `test/usageFormatting.test.js`, new `test/statusBarSettings.test.js`, local
setting regression in `test/configSync.test.js`, exact notes in `docs/CONFIGURATION.md` and `CHANGELOG.md`.

Validation: under `/tmp/ai-usage-runtime-unification-validation.lock`,
`node scripts/run-tests.js test/statusBarSettings.test.js test/usageFormatting.test.js test/configSync.test.js test/accountsMenu.test.js`
completed compilation and passed 23/23 tests. The runner isolates HOME, AI_USAGE_HOME, CODEX_HOME and
CLAUDE_CONFIG_DIR and denies external fixture HTTP/fetch. `git diff --check` passed.

Review follow-up: `visibleUsage` returns raw `last.usage`/`lastGood` and does not invalidate them when quota
windows expire. The reviewer's suspected UI early-return issue was closed after source inspection. Added
an explicit expired-quota/still-fresh-credit regression; no production behavior change or fallback was needed.
Final focused rerun: locked isolated `node scripts/run-tests.js --skip-build test/usageFormatting.test.js` passed 3/3 tests, including the explicit expired-quota case.
