# W3 plugin, configuration and bridge integration
Status: implemented; W6-010 correction locked gate **8/8 passed**; previous integration gate **23/23 passed** (2026-10-09).
- Disabled background integration and declined installs both connect the authenticated shared socket; only a leased embedded host may start. No per-window AccountService/local client remains.
- Reconnect hydrates persisted engine state without writes. Initial seed contains explicit engine keys only. Presentation, deployment and workspace directories stay editor-local.
- User engine edits capture their observed base revision before enqueueing; conflicts hydrate the winner. Disconnect never retries uncertain mutation payloads.
- Workspace folders and explicit editor session directories are declared per connection; bridge contexts are signed, expire after 60 seconds, and are relayed per inference request.
- Global bridge session policy no longer receives a window directory. Distinct and unresolved scoped contexts cannot resume/fork another workspace's saved session.
- Restart awaits old bridge child close; concurrent starts/stops coalesce. Disposal awaits exit, escalates termination and rejects if uncertain; rejected stop can be safely retried.
- Managed bridge IPC disconnect cancels/drains sessions with bounded exit. A complete persistent child ledger is exclusively linked before asynchronous startup/admission, retained through exit, and checked before any probe/spawn; unknown/live foreign ownership fails closed. Standalone external bridges remain compatible.
- Real owner SIGKILL during750ms delayed synthetic native drain proves HTTP absence while old workers live; replacement spawn asserts BOTH old bridge/native PIDs dead and native drain complete. Idle crash case also proves dead-before-spawn. W6 independently reran both successfully.
- Extension deactivation awaits ServiceManager.stop; disposal during initial connection cannot leave a client/host. Connection loss retries takeover while ownership is unavailable.
- Bundled MCP setup no longer requires install; enable is revision-checked. OPT-03 unreachable install picker union/branch removed.
- Bridge endpoints and metadata route origins are checked before sending a local bearer token.
Owned source: src/{serviceManager,configSync,bridgeRuntime,bridgeIntegration,bridgeTransport,extension}.ts (bridgeRuntime unchanged); service/src/bridgeRuntime.ts; bridge/src/{request,engine,server,cli}.mjs.
Owned tests: test/{serviceManager,configSync}.test.js; service/test/bridgeRuntime-{lifecycle,parent-death}.test.js and fixtures/{bridgeOwnerProcess.js,delayedCodex.mjs}; bridge/test/workspace-context.test.mjs.
Coordinated W4 bridgeService helper and bridgeModels/bridgeSessionOpening setup migration; preserved others' files.
Validation: shared flock /tmp/ai-usage-runtime-unification-validation.lock around package-service-bridge.js, tsc -p service, tsc -p ., and node --test; latest correction ran the two owned service bridge test files (8/8), prior integration ran all five W3 test files (23/23).
All four HOME/AI_USAGE_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR variables used temporary roots; fixtureNetwork preload blocked provider/model network. No live account operations, installs, publishing, version/index/commit changes.
Audit W6-002/W6-003/W6-010 fixed; W6 independently verified captured-revision and empty/multi-root workspace denial regressions.
Explicit valid absolute editor directories outside workspace folders remain supported; invalid paths reject.
Boundary: managed ledger reclaim relies on the shared engine lease serializing startup for one service home. Separate homes must coordinate shared bridge token/endpoint deployment explicitly. Host stop must retain lease on disposal failure; HMAC is routing integrity, not bearer-client ACL.
Final source frozen; src/configSync.ts and test/configSync.test.js released to conductor for the separate legacy refreshIntervalMinutes compatibility correction.
