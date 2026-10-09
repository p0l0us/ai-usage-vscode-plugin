# W1 final Design B handback — 2026-10-09

Approved replacement in W1-design3, same third/final W6-005 correction. Design A immutable filesystem claims are removed; no reclamation, foreign deletion or unbounded tombstones remain.

## Exact implementation scope
- `service/src/runtimeLease.ts`: default Linux abstract socket / Windows named pipe retained; other platforms use OS-released exclusive loopback TCP listener. Fixed port `49152 + sha256(userKey + NUL + canonicalHome) mod 16384`; no alternate port, no reusePort. Incoming connections immediately destroyed. Occupied/denied acquisition returns undefined; uncertain probe errors/timeouts mean held; only ECONNREFUSED frees TCP observation. Existing missing-home canonicalization retained. Public kind is `os | tcp`, with `tcpLeasePort` exported.
- `service/src/engineHost.ts`: occupied/unavailable TCP ownership diagnostic names `127.0.0.1:<port>` while preserving EngineOwnedError contract. Ownership probes no longer declare an absent directory free before checking its lease. Existing successful-drain-before-release behavior retained.
- `service/src/paths.ts`, `service/src/accountService.ts`: only lease type literals adapted from `os | file` to `os | tcp` in this handback; all prior other-owner edits preserved.
- `service/test/engineHost.test.js`: obsolete file-claim tests removed and replaced with forced real TCP coverage. Existing unrelated regressions retained.

## Validation
One narrow run under `flock /tmp/ai-usage-runtime-unification-validation.lock`: fresh temporary HOME, AI_USAGE_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR; `NODE_OPTIONS=--require=<repo>/test/helpers/fixtureNetwork.js`; `cd service; npx tsc -p . && node --test test/engineHost.test.js`.

Result: compile clean; **33/33 tests passed, zero skipped/cancelled**, duration 3.746 seconds.
Coverage: OS and TCP single holder/release and real SIGKILL reacquire; existing-home alias and absent-home symlink canonicalization; simultaneous three contenders and preserved incumbent; six synchronized real child contenders held until all verdicts (one owner, five busy, later challenger refused); unrelated listener collision names fixed port, preserves listener, writes nothing; uncertain errors/timeouts fail closed; admitted incumbent import completes during contention; TCP ownership retained through delayed bridge disposal and failed-disposal retry; unexpected listener loss refuses mutation and stops host; existing config/cancellation/drain behavior.

No broad suite, commits, index changes, version changes, installs, publication, real credentials or provider network. Linux exercised real TCP fallback; native macOS and Windows not available in this environment. W6 independent acceptance pending; notified reviewer directly. Collision with an unrelated listener intentionally denies startup at the fixed port.
