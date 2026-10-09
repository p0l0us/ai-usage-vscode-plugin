# W8 final validation — 2026-10-09

## Initial full gate result

Canonical command: `flock /tmp/ai-usage-runtime-unification-validation.lock npm test` from the plugin repository root. It ran the root `npm test` without filters or exclusions. The runner compiled/generated the service, manifest and bundled bridge, then executed all **48** root-discovered test files across `test/`, `service/test/` and `bridge/test/`.

Compilation and generation passed. Test result: **458 total; 456 passed, 2 failed, 0 skipped/cancelled**. Initial gate exit code: **1**. Full unfiltered output is preserved in [W8-validation.log](W8-validation.log).

The only initial failures were the Codex and Claude variants of `bridge/test/delegation.test.mjs:13`. At line 35 each expected HTTP 200 but received 503 with `CLI not found: codex.mjs` / `CLI not found: claude.mjs`. The test cases used a root-relative fixture command that did not resolve from the repository root. The owner changed fixture resolution to an `import.meta.url`-anchored path; assertions are unchanged.

## Acceptance evidence

| Area | W8 result |
| --- | --- |
| One lease before initialization, startup race, live-unreachable refusal, crash/takeover, background survival, embedded-owner stop/takeover | Exercised by the 458-test root run; service `engineHost`, lifecycle and parent-death files were included. The root gate cannot be called fully accepted while any suite test fails. |
| No uncertain mutation replay; socket capabilities, deadlines, cancellation, events, logs and lifecycle | Included in the passing service RPC/client tests and runtime parity scenarios. |
| Config revision/CAS, reconnect, presentation and workspace isolation; existing profile preservation | Included in passing config synchronization and runtime parity cases across background and embedded modes. |
| Bundled real MCP without install; native unsaved usage, freshness and model limits | Included in passing MCP provider/registration and both-mode parity cases. |
| Bridge child awaited on restart/shutdown and A/B inference context | Context and managed-child parity tests passed. The two delegation tests failed before completing their native-child/fork assertions because the isolated fixture CLI was undiscoverable. |
| All root suites | 48 files executed, 456/458 passed; gate failed on the two delegation fixture cases above. |
| Independent W6 audit | Separate audit report exists and records all ten findings resolved; W8 does not replace that review. |

## Final affected-scope rerun

After the delegation fixture repair and W9 whole-percentage presentation change, one locked isolated command compiled/generated once and ran exactly `bridge/test/delegation.test.mjs`, `test/accountsMenu.test.js` and `test/usageFormatting.test.js`: **15/15 passed, zero skipped/cancelled**, exit code **0**. The run covers all four delegation cases, the updated menu output and the new formatting regression. It also covered the W9 new `usageFormatting.test.js` test proving visible `0%`/rounded output while stored and live readings retain their precision. The test runner's external-network denial and temporary homes remained active. Full rerun output is [W8-affected-validation.log](W8-affected-validation.log).

The final affected-scope gate is **PASS**: both originally failing cases now pass, the new/changed presentation tests pass, and the other 456 tests passed in the initial full run. This is a full-run result combined with an affected-scope rerun, not a second full root-suite run. Distinct current test inventory is 460 tests (the original 458 plus two W9 regression tests); the targeted 15-test rerun includes 13 tests already present in the original full run. Thus evidence is: original full run 456/458, followed by the 15/15 affected rerun; together they cover 460/460 current tests, with no claim that all 460 ran in a single invocation.

## Snapshot and side effects

The 12 audited lifecycle source fingerprints captured before the initial gate still match; all nine fingerprints listed in `docs/RUNTIME_SECURITY_AUDIT.md` also match after the affected rerun. `git diff --check` passed. Compile/generation introduced no unexpected generated or version changes; `package-lock.json` remains unchanged and `package.json` has no version edit. Other working-tree edits belong to the authorized task/W9 scope. No installs, publishes, commits, index changes, account access or source edits were made by W8. Test/compile child processes inherited isolated `HOME`, `AI_USAGE_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`; tests used `test/helpers/fixtureNetwork.js` to deny public network access.

Execution was Linux only. Native macOS and Windows behavior remains unverified as noted by W6. The one full run plus the affected rerun is the final evidence; untouched suites were not repeated.
