# W1 report: runtime ownership, engine host, config authority (Claude Opus)

Date 2026-10-09. Base 8191bf4. No version bump, install, publish, commit or git index changes. No real credentials,
providers or models used. All test homes are temporary (HOME, AI_USAGE_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR).
Contract: `tmp/interfaces.md` (preliminary + R1 + R2).

## Files (W1 scope only)
| File | Change |
|---|---|
| `service/src/runtimeLease.ts` (new) | Per-home ownership lease. Linux abstract socket / Windows named pipe (OS-released on crash), name = sha256(uid/user + canonical home). File lease (macOS default, tests on Linux): complete record in a private temp file, hard-linked to `engine.lock` (atomic, never partial); reclaim only for a dead pid via rename-aside + byte-identical verification, else restore (no age-based stealing); `held()`/`assertHeld()` re-read the lock; dead temps cleaned. `canonicalHome` = realpath of nearest existing ancestor + missing suffix, other errors throw. `leaseHeld` = non-acquiring check. `reclaimDeadLock` exported for tests. |
| `service/src/engineHost.ts` (new) | The single host for daemon and embedded modes: lease → legacy-owner probe (read-only, `allowLegacyHello`) → state dir/log/token → engine (seed-only config, `ownership: lease`) → socket → info file (`mode`, `instanceId`, `protocol` = W2 `SERVICE_PROTOCOL_VERSION`, `lease`) → `start()`. `EngineOwnedError` `owner-running` / `owner-unreachable` (fail closed after `ownerWaitMs`, default 3 s). `probeEngine` (free/running/unreachable, never takes the lease). Host-handled `service.info`, `service.status`, `service.shutdown {reason}`, `log.tail`, `log` events. `engineOptions` fixture Pick (W4), applied after the lease, cannot override home/log/version/lease/seed. Fail-closed stop: close server → drain + dispose engine → bridge exit → remove own info file → release lease; any failure rejects, keeps lease, retryable. Lease loss → mutations refused, stop `{by:'lease-lost'}`. `runDaemon` returns `StopInfo`. |
| `service/src/daemon.ts` | Now re-exports the host API (`startServiceHost`, `runDaemon`, `probeEngine`, `EngineOwnedError`, `HOST_CAPABILITIES`, types). |
| `service/src/configStore.ts` | `ConfigAuthority`: per-key revisions persisted in config.json (`revision`, `revisions`; ignored by older services), revision-checked `patch` (conflict only for keys whose value would change), unconditional patch for CLI/`config.set`, seed-only first values, hand-edit merge with revision bump before every write, unparsable file kept in memory as defaults and set aside as `config.json.invalid-<ts>` before the first write (never overwritten; a later invalid edit keeps current values), `assertWritable` (lease) checked before every write. `settingScope()` engine/presentation/local/workspace, `configKeys()`, `ConfigError` (extends RpcError) codes `config-conflict` (data revision/keys/values), `config-local-setting`, `config-invalid`. |
| `service/src/accountService.ts` | Config via authority (`config` getter, `configView`, `patchConfig`, `setConfig` kept). New `config.read`, `config.patch {values, baseRevision?, source?}` (local keys refused), `workspace.context {folders?, github?, sessionDirectory?}`, `workspaceContext(clientId)`; bridge ensure/connection/sync get the caller's typed `BridgeWorkspaceContext` (W3); `configChanged` carries `revision`, `changed`, `source`. `start()` refuses without ownership (no more unowned engines). Mutating methods assert the lease. Request context (W2): cancelled/expired before start → `cancelled`/`timeout`; manual-check waits abort with the request; AsyncLocalStorage request scope + `automation.admit` guard refuses queued mutations after cancel/stop/lease loss. Admitted requests and background work tracked; `dispose(): Promise<void>` drains (30 s, then rejects, retryable) then awaits runtime/bridge. Typed `unknown_method` / `invalid_params`. `mcp.registration`/`mcp.register` use W2 `mcpCommand(home)` descriptor. History prune moved from constructor to `start()`. |
| `service/src/accountAutomation.ts` (scope expanded by conductor) | `admit?: () => void` hook called right before queued operations run in `withPaused` and under `withAccountLock`. |
| `service/src/runtime.ts` | `ownership` guard on `sync()`; `start(): Promise<void>`; `dispose(): Promise<void>` awaits `BridgeRuntime.dispose()`. |
| `service/src/paths.ts` | Atomic token creation (temp + rename); `ServiceInfoFile` gains `mode`, `instanceId`, `protocol`, `lease`. |
| `service/test/engineHost.test.js` (new, 27 tests incl. per-kind loops) | See evidence. |
| `service/test/daemon.test.js` | Sandboxed HOME/AI_USAGE_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR (it previously ran with the real HOME). |

## Evidence (all under `flock /tmp/ai-usage-runtime-unification-validation.lock`, temp env homes, `npx tsc -p .` clean)
- `node --test test/engineHost.test.js test/daemon.test.js test/configStore.test.js test/accountService.test.js test/accountAutomation.test.js`: **124/124 pass**; `find` over the env temp homes afterwards: no files written.
- `node --test test/cli.test.js test/mcp.test.js test/rpc.test.js test/proxyRuntime.test.js test/installer.test.js`: **32/32 pass** (an earlier run had 2 failures in pure `mcp.ts` summary functions, W2 code in flux; they pass now).
- engineHost.test.js covers: os + file lease single holder/release/alias symlink; killed-process reclaim (child SIGKILL) for both kinds; absent home under symlinked parent = one lease (W6-001); unresolvable path fails closed (EACCES); crashed claim temp cleanup, no partial lock (W6-004); suspended reclaimer restores a live lock (W6-005); unreadable / live-pid lock never reclaimed; 4 concurrent hosts → exactly 1, others `owner-running`; live unanswering owner → `owner-unreachable` with no token/state/info/config change, then free after kill; crashed host (child SIGKILL) replaced, stale socket handled; legacy socket owner → step back + lease released; background and embedded: `service.status`, `log.tail`, `service.shutdown` → `stopped {by:'client'}`, info removed, lease released last; file lease lost → mutation refused + `lease-lost` stop, nothing written; `start()` refused without lease; seed fills first run only, existing values win; per-key revision conflicts across two socket clients, local/invalid codes, same-value no-op, events, persisted revisions, legacy `config.set`; hand edit merge + invalid file set aside; unowned authority writes nothing; per-connection workspace context → per-request bridge context, dropped on disconnect; stop waits for bridge exit before lease release; cancelled/expired request changes nothing; queued mutation refused after cancel / during stop drain / after lease loss with nothing persisted (W6-009); drain timeout rejects and retry succeeds; dispose failure keeps lease, successor `owner-unreachable`, retry releases (W6-008); typed dispatcher errors.

## For other owners
- W2: needs nothing further; `error.data` for `ConfigError` relies on rpc.ts carrying `data` (W2 said it does).
- W3: plugin must use `startServiceHost({mode:'embedded', seedConfig: <explicit engine keys only>, ...})` / `probeEngine` and socket clients only; handle `EngineOwnedError` codes; `config.read` hydrate + `config.patch` with baseRevision; never patch local/presentation keys. `BridgeRuntime.dispose()` should retry after a rejected attempt instead of returning the cached rejection (otherwise a retried `host.stop()` cannot succeed after a bridge-exit failure).
- W4: `engineOptions` frozen; `HostOptions.ownerWaitMs` available to shorten unreachable-owner tests.

## Known limits / gaps
- File lease: PID reuse makes a dead owner look alive → fail closed (manual `engine.lock` removal). A reclaimer displacing a live lock for an instant can make that owner see a lost lease and stop (safe direction); no two writers persist past the owner's next `assertHeld`.
- Lease squatting by another local user on the abstract socket / pipe name only denies service (fail closed); no cross-user/container coordination (as documented for the proxy lease).
- Operations already executing when stop begins are allowed to finish (drained), their RPC answers may be lost (W2 "outcome unknown" contract).
- Presentation keys are still accepted by `config.set`/`config.patch` for CLI compatibility (D2); the plugin must keep them local.
- Root suite and `test/usageClient.test.js` (W4) not run by W1 per instructions; root tests that used `ServiceClient.local`/`new AccountService().start()` must use the host (W3/W4).

## Attempt 3: W6-005 file-lease reclaim (resumed session)
- Root cause of attempts 1 and 2: both reclaimed a dead owner at the single pathname `engine.lock`, by removing or
  moving that file. Removing a file only if it still holds the dead owner's record cannot be done atomically, so a
  live successor's lock could be removed (attempt 1: guard stolen by age) or the path left vacant for a third
  contender (attempt 2: rename before verify).
- Correction (design A, implemented): immutable numbered claims.
  - Claims are published by `link`, so they are complete when they appear.
  - Nobody deletes or moves another process's claim. Release adds a marker instead.
  - A contender claims "highest + 1" only after the highest claimant released or provably exited (pid gone, or the pid
    has another start identity). Nothing is taken over because of its age.
  - After publishing, a contender owns the home only if its claim is the highest; otherwise it withdraws its own claim.
  - Proof and rules R1–R4 are in `tmp/W1-design3.md` and in the comment in `runtimeLease.ts`.
- Evidence, all under the validation flock with the `fixtureNetwork` preload and temporary HOME, AI_USAGE_HOME,
  CODEX_HOME and CLAUDE_CONFIG_DIR:
  - `test/engineHost.test.js` 37/37.
  - Three-contender, stale-claim and multi-process tests passed 15 of 15 repeated stress runs.
  - The engineHost, daemon, configStore, accountService, accountAutomation, cli, mcp, rpc, proxyRuntime and installer
    tests together: 162/162.
  - The only file written in the temporary env homes was a bridge token, inside the temporary HOME.
- Regressions:
  - Three contenders with a suspended reclaimer: the incumbent's claim fingerprint is never changed, and its holder
    stays held.
  - A stale lower claim is withdrawn by its own claimant.
  - A live incumbent host's admitted import completes while stale and new contenders are refused.
  - Six real processes race for one home: exactly one owner.
  - Crash before and after publication.
  - Unreadable claim fails closed.
  - PID cases: live, unknown identity, reused.
  - Release marker.
- Process note: the root steering ("stop editing runtimeLease until the design is reviewed") arrived while design A
  was being implemented. There have been no edits to `runtimeLease.ts` since; the design is submitted for audit.
- Open: design A leaves unbounded tombstones (one ~150 B claim per start plus a marker per clean stop). Design B, an
  OS-released loopback TCP lease that fails closed on collision, is proposed as the alternative the reviewer
  prefers. The auditor's choice decides; there will be no fourth attempt.
- Status: **W6-005 is not declared fixed until the W6 re-audit.** W6-001/004/008/009 remain as previously reported.

## Final accepted-design implementation handback: Design B
Design A above is superseded by reviewer-approved Design B in the same third/final W6-005 attempt. All filesystem lease claims/reclaim code and superseded claim tests are removed. Non-Linux/Windows defaults to a fixed exclusive loopback TCP listener (`os | tcp` kind); collisions fail closed and the host diagnostic names the occupied/unavailable port. OS release on crash and ownership retention through drain require no tombstones. Minimal service type adaptations and absent-home ownership probe correction accompany the lease replacement.

Exact changed-file scope and narrow isolated validation are in `tmp/W1-designB-report.md`: TypeScript compilation clean, engineHost tests **33/33, zero skipped**, including real forced-TCP contention, foreign listener collision/no writes, SIGKILL takeover, missing-home canonical aliases, uncertain probes, admitted work and failed/draining disposal retention. W6 has the source/test handback for independent W6-005 acceptance. No broad suite or publication performed.
