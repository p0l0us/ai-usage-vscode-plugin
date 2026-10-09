# W10 source auto and W13 source parity

Implemented in service/src/live.ts and service/src/usageMonitor.ts. Tests owned: test/sourceAuto.test.js, test/sourceAutoParity.test.js, test/helpers/sourceAutoHost.js and the explicit interval in service/test/usageMonitor.test.js fixture.

Auto reuses genuinely fresh identity-keyed known readings, then account/session files, then direct API, then CLI. Direct API is cheaper than launching either app-server or Claude /usage; Claude CLI reaches the same rate-limited OAuth endpoint. No model prompt is sent by these usage readers. Explicit modes retain their branches and Codex enrichment behavior. Auto local/API success does not launch a second CLI solely for reset credits. W11 confirmed accountProbe already obtains current credits via CLI and will request them on demand for autoReset.

Freshness requires matching provider, finite nonfuture timestamp, age strictly below primary interval, nonempty windows with finite bounded percentages, and finite future resets. Original timestamps survive. Each awaited reader is checked against its completion clock. Monitor cache early-return checks validity and schedules expiry at the oldest accepted reading's remaining interval; stale result becomes unavailable even when a lock prevents refresh. Failed/unavailable/stale readers fall through.429/Retry-After stops same-endpoint fallback. Network fallback spacing and provider budgets remain authoritative; transient final failures block network ledgers while subsequent local reads remain possible. Native account/runFetch locking and post-request identity/policy checks retained.

Optional LiveUsage.source persists via existing cache and serialization spreads. Auto Codex sessionLog and unknown provenance are never account-attributable; API/CLI are attributable. Explicit both remains conservatively unattributable. W12 owns auto enums/default30 minutes; monitor never substitutes Claude accountFile seconds for auto.

Validation under flock /tmp/ai-usage-runtime-unification-validation.lock with temporary HOME, AI_USAGE_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR and inherited fixtureNetwork Node public HTTP/HTTPS/fetch denial:
- ./node_modules/.bin/tsc -p service passed.
- node --test test/sourceAuto.test.js test/sourceAutoParity.test.js service/test/usageMonitor.test.js service/test/localThenApi.test.js service/test/claudeUsageCli.test.js service/test/apiBudget.test.js:47 passed,0 failed.
- W13 source parity: actual background child host and embedded socket host both run the production auto selector using injected fixture readers. Each request asserts same attempted-source order/local/API/CLI selection, unchanged fetchedAt, cache reuse and429 stop. No live calls.
- W14-001/002 completion-clock/early-cache freshness findings fixed with advancing-clock API/CLI and29-minute-local then31-minute-monitor regressions.

Parity criterion had2 fixture assertion failures before passing third attempt: automatic config polling can collect while scenario changes, then429 manual force legitimately creates another request. Fixture scenarios now set before policy mutation and source attempts grouped by unique request, so every individual selector call is checked deterministically. No root suite, installs, commits, version bumps or active descendants. Writes stopped; final gate owned W15.
