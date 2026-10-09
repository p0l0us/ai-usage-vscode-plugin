# W6 independent security, lifecycle and conformance review

Status: **final scoped audit passed**, 2026-10-09. All W6-001 through W6-010 findings are resolved in the reviewed source. The final root build/test gate remains W8's responsibility. No implementation files were changed by W6.

Scope: both background and editor-owned shared runtime; lease, shutdown, request cancellation, configuration authority, MCP, per-connection workspace and bridge session behavior. Review inputs: `CLAUDE.md`, service architecture and W1–W4 interface/coordination documents.

## Findings and current disposition

### W6-001 — HIGH — absent home under a symlinked ancestor produces two leases

Location: `service/src/runtimeLease.ts`, `canonicalHome`, `leaseEndpoint`, `acquireEngineLease` (initial lines 45–77).

`canonicalHome` falls back to `path.resolve` when the final directory is absent, leaving an existing symlinked ancestor unresolved. The first owner therefore hashes an alias; after it creates the home a second owner hashes its real path and obtains a different OS lease for the same directory.

Reproduction against current source, transpiled in memory: create temporary `real/` and `alias -> real`; acquire `alias/new-home` before that child exists; create the child; acquire `real/new-home`. Result: `{"firstHeld":true,"secondHeld":true,"samePhysicalHome":true}`. All four account-home environment variables were temporary; no engine, credentials or provider was invoked.

Remediation: canonicalize the nearest existing ancestor and append only the absent path suffix; fail closed on unexpected realpath errors. Regression must exercise missing home and symlinked parents, not only two spellings of an existing home. Sent conductor and root; conductor routed W1/W4.

Disposition: **resolved**, independently rerun original source probe: `{"symlinkFirst":true,"symlinkSecond":false}`. Both OS/file missing-home symlink regression tests also passed in the isolated delta run.

### W6-002 — HIGH — queued editor edits use a newer revision than their captured intent

Location: `src/serviceManager.ts`, `pushSettings` (initial lines 271–287).

The method captures `values` from a setting event but reads `this.configRevision` only inside the later `settingsQueue` callback. Another window's same-key edit and `configChanged` event can advance the revision while the old edit is queued. The old payload is then accepted against that new revision, bypassing the promised conflict detection and overwriting the competing edit.

Remediation: capture the observed base revision with the edit values before queueing. Regression: hold the settings queue, record edit A at revision N, process competing same-key edit B at N+1, release queue and assert A uses N and conflicts. Sent conductor; routed W3.

Disposition: **resolved in current source**, independently verified. `baseRevision` is captured before queueing. W6 ran the isolated narrow `queued editor edit` regression successfully.

### W6-003 — HIGH — empty scoped bridge context bypasses saved-session workspace check

Location: `service/src/bridgeRuntime.ts`, `connection`; `bridge/src/request.mjs`, `normalizeRequest`; `bridge/src/engine.mjs`, saved/fork session selection (initial lines 100–107).

The service legitimately signs `directories: {}` for a multi-root or empty workspace without a selected session directory. The bridge accepts it. Its saved/fork guard runs only when `scopedDirectory` is truthy, then overwrites the request directory with `saved.cwd` or `parent.cwd`. Thus a context belonging to window B without a resolved directory can resume or fork window A's saved session and inherit A's working directory.

Remediation: retain/bind workspace identity in the request and session, or fail closed for a scoped request that cannot establish directory ownership. Regression must include multi-root/empty B contexts resuming and forking A, in addition to different nonempty A/B directories. Sent conductor; routed W3.

Disposition: **resolved in current source**, independently verified. The guard tests context presence and rejects unresolved scoped saved/fork requests. W6 ran `bridge/test/workspace-context.test.mjs`: 5/5 pass, including concurrent signed A/B HTTP inference, invalid/expired context, and different/empty/multi-root saved-session/fork denial.

### W6-004 — HIGH — crash between exclusive file creation and record write prevents takeover

Location: `service/src/runtimeLease.ts`, `createLock` and `acquireFileLease` (initial lines 131–172).

`openSync(file, 'wx')` publishes an empty lock before the owner PID/instance record is written. A process killed between those operations leaves an empty record. `acquireFileLease` permanently refuses an unreadable/partial record, so a dead owner cannot be recovered automatically on platforms where the file lease is the default.

Isolated current-source probe with an empty `engine.lock`: `{"partialRecordRecovered":false}`. Remediation: prepare a complete unique record and publish ownership atomically, or use another protocol that distinguishes and safely recovers a crashed creator. Regression: creator death immediately after exclusive creation, before record completion. Sent conductor for W1/W4.

Disposition: **resolved**. The final OS TCP fallback removes filesystem claim publication entirely. The earlier complete-record regression passed; the final forced-TCP SIGKILL recovery regression also passed independently.

### W6-005 — HIGH — age-only reclaim guard can evict a live paused reclaimer

Location: `service/src/runtimeLease.ts`, `withReclaimGuard` and `acquireFileLease` (initial lines 140–180).

The guard directory is removed solely when its mtime is older than 30 seconds. Reclaimer A can pause after checking the stale lock but before unlinking it. Reclaimer B age-steals A's guard, replaces the stale lock and becomes owner. A resumes, unlinks B's live lock based on its previous check and publishes its own lock. Both processes believe they hold ownership until a later guard detects the loss.

Deterministic isolated reproduction against current source: intercept A immediately before stale lock unlink, age the guard to simulate suspension, complete B's acquisition, resume A. Result: `{"pausedReclaimerHeld":true,"newReclaimerHeld":true,"sameHome":true,"distinctInstances":true}`. Remediation: never age-steal a potentially live reclaim owner; use crash-recoverable owner identity and reclaim only proven-dead owners. Regression must suspend a live reclaimer across the age threshold. Sent conductor for W1/W4.

Delta: the rename/restore replacement also failed a three-contender reproduction. A stale reclaimer temporarily vacated live B's lock; C claimed the vacant path before restoration. Output: `{"incumbentInitiallyHeld":true,"staleReclaimReportedSuccess":false,"challengerAcquiredWhileIncumbentAlive":true,"incumbentStillHeld":false,"challengerHeld":true}`. This is a live-owner displacement, even though B detects the loss at its next check.

Third/final correction algorithm agreed before the resumed Sol coder: **W1-design3 Design B**, deterministic OS-owned TCP listener on non-Linux/Windows platforms. Acceptance: fixed UID/canonical-home port, exclusive listen/no reusePort, no alternate-port retry, occupied/uncertain endpoint fails closed with explicit diagnostic, listener retained until successful disposal, OS crash release. Remove obsolete filesystem claims/reclaim path. Required regression coverage: forced TCP on Linux, unrelated-port collision, multiple contenders, live owner, SIGKILL takeover and missing-home symlink. Design A's indefinitely growing immutable claims was not accepted because it violates the requested resource bound.

Disposition: **resolved**. Final source implements `os | tcp` only and removes all file-claim/reclaim paths. W6 independently passed forced-TCP ownership, three/six contenders, unrelated-port and uncertain-error refusal, live admitted work preservation, SIGKILL recovery, missing-home symlink, lost-listener shutdown, and failed-disposal ownership retention.

### W6-006 — MEDIUM — expired quota windows can be reported fresh by MCP

Location: `service/src/mcp.ts`, `readingFreshness`.

The new freshness helper checks reading timestamp and percentages but not elapsed quota resets. The shared runtime's `newestValidUsage` rejects readings with an expired reset, but an MCP summary can label the same data fresh. Isolated in-memory source probe: fetched 30 seconds ago, window reset one second ago yields `{"state":"fresh","ageSeconds":30,"maxAgeSeconds":3600}`.

Remediation: classify expired windows consistently with the runtime. Test saved and native usage including reset expiry. Sent W2 and conductor.

Disposition: **resolved in current source**, independently verified. Reset expiry now produces stale freshness; W6 ran the narrow `expired resets and absent saved` regression successfully.

### W6-007 — MEDIUM — MCP marks missing or stale profile usage usable

Location: `service/src/mcp.ts`, `profileSummary`.

`usable` depends only on stored credentials, login error and `limit.readOnly`. The new freshness annotation does not affect it. Isolated probe with a credentialed profile without any reading returns `usable:true` and `freshness.state:"unknown"`. The MCP guidance says unknown/stale readings are not evidence of capacity and describes usable as what the runtime would select; these simultaneous fields contradict that contract.

Remediation: distinguish basic account eligibility from verified capacity, and ensure the exposed usable decision requires a valid fresh reading. Test missing, stale, fresh and model-only-limited readings. Sent W2 and conductor.

Disposition: **resolved in current source**, independently verified. `usable` now requires fresh usage and `credentialStored` separately represents credential availability. The same W6 narrow MCP regression verifies absent saved readings are not usable.

### W6-008 — HIGH — shutdown releases ownership after an engine-disposal failure

Location: `service/src/engineHost.ts`, `stopWith` (first landed lines 165–175); `service/src/bridgeRuntime.ts`, `stopChild`.

The host catches `service.dispose()` rejection, logs it, closes RPC and releases the lease anyway. Bridge disposal explicitly rejects when its child has not exited after the termination deadline. Therefore this path releases ownership when a known child may still be running, allowing a successor to start while the prior engine's process survives.

Remediation: retain ownership on uncertain disposal, surface the failed stop and permit an explicit safe retry. Regression: injected child/dispose failure must keep the lease held and prevent a successor. Sent conductor for W1.

Disposition: **resolved normal shutdown path**, independently verified. Host retains the lease after disposal rejection; retry can succeed. Narrow `did not stop cleanly` and `dispose rejects` tests passed.

### W6-009 — HIGH — queued profile mutation executes after cancellation and disposal

Location: `service/src/accountService.ts`, `handle` / `dispose`; `service/src/accountAutomation.ts`, `withPaused`.

Now reproduced against the landed `AccountService` source, transpiled in memory with existing dependency output: hold `automation.pending`, enqueue `profiles.rename` with a signal, abort it, await `service.dispose()`, then resolve the pending automation. A spy replacing the actual store mutation records `{"mutationsAfterDispose":1,"outcome":{"id":"fixture","name":"after"}}`. The engine was never started; provider methods were disabled/guarded and all homes temporary.

The RPC signal/deadline/disposed checks run only at handle entry. `withPaused` awaits an earlier job and then executes the mutation without rechecking. Disposal currently awaits bridge/runtime shutdown but does not drain admitted operations. Consequently a request declared cancelled and a stopped host can later mutate shared state after takeover.

Remediation: recheck abort/deadline/disposed/ownership inside each queued callback before mutation; also drain admitted requests and background work before lease release. Regression must hold the queue across cancellation and stop, then release it and assert no mutation. Sent conductor for W1/W4.

Disposition: **resolved**, independently verified. Request scope reaches queued admission checks; service tracks and drains admitted work. Narrow queued-cancellation, stop/drain, and queued-lease-loss tests passed.

### W6-010 — HIGH — crash takeover can start a bridge before the old child drains

Location: `bridge/src/cli.mjs`, managed `stop`; `service/src/bridgeRuntime.ts`, dead-owner takeover; `bridge/src/engine.mjs`, `dispose`.

The first parent-death correction closes the bridge HTTP listener before awaiting `engine.close`. Backend close and `sessionRecords.save` occur afterwards. A successor waits only for `/health` to disappear, so it can start a new bridge using the same session records while the old bridge is still draining and writing them. The initial real SIGKILL regression passes, but has no active inference and checks eventual old-process death only after replacement startup; it does not establish the required ordering.

Agreed correction with W3: persistent atomic managed-child metadata published before inference admission and retained through exit; foreign child's proven death, not just parent's death or missing health endpoint, gates replacement. Unknown/malformed metadata fails closed. Verify expected owner identity during startup and prevent late startup publication from hiding a successor. Required regression: kill owner during active synthetic inference with delayed native cleanup and assert old bridge PID is dead at the moment replacement is spawned.

Disposition: **resolved**. Metadata publishes by exclusive hardlink before asynchronous initialization and inference admission; repeated IPC/parent-liveness checks prevent orphan startup, and a late publisher cannot overwrite an existing record. The successor checks persistent child identity before health/spawn and validates the new child's identity in health. W6 independently passed idle and delayed-active-native owner-SIGKILL regressions, with both prior bridge/native PIDs dead at replacement spawn. Separate malformed/nonregular-metadata and live-child-without-listener refusal tests passed. The shared service-home lease serializes runtime takeover; this is not a coordinator for unrelated external bridge launchers.

## Delta validation checkpoint

W6 independently ran 9 targeted tests under `/tmp/ai-usage-runtime-unification-validation.lock`, temporary `HOME`, `AI_USAGE_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and the `fixtureNetwork` external-network denial preload: all passed. Covered absent-home symlink ownership (two lease modes), complete crashed claim, queued abort, draining stop, queued lease loss, failed-drain retry, failed-child-stop lease retention, and the initial no-active-session owner SIGKILL bridge test. The latter does not clear W6-010.

Final independent high-severity delta: **13/13** selected TCP ownership/shutdown and idle/active bridge-crash tests passed, followed by **2/2** metadata refusal tests. Same lock, four temporary homes and external-network denial preload. W1 and W3 confirmed source handback before acceptance.

## Positive observations and validation boundary

- The emerging RPC contract authenticates before dispatch, validates explicit protocol/capabilities, rejects duplicate IDs, supports cancellation/deadlines, and does not automatically replay requests.
- Socket stale-removal now checks reachability and inode identity; socket mode is restricted to 0600 on POSIX.
- Per-connection workspace/context maps and disconnect removal are present; presentation settings are filtered out of editor hydration/push.
- Bridge request HMAC and expiry validation are present. A shared bearer token is also returned to clients, so this signature is an integrity/routing mechanism, not a security boundary against another client holding that token.
- MCP freshness, host teardown and queued cancellation were checked in the delta passes above. Broader cross-mode parity evidence is owned by W4; the final root build/test suite is owned by W8 and was not run by W6.
- Tests executed on Linux, including forced real TCP fallback. Native Windows named-pipe and macOS platform runs were not performed. TCP endpoint collisions intentionally deny startup rather than select another port.

Final audited source fingerprints and the requirement matrix are in `docs/RUNTIME_SECURITY_AUDIT.md`.

Evidence discipline: product probes use temporary `HOME`, `AI_USAGE_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`; source transpilation was in memory. No real provider calls, real account changes, installs, publication, commits or source fixes.
