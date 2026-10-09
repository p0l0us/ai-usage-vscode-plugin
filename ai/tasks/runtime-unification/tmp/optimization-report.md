# Runtime unification optimization review

Initial pass: 2026-10-09, base `8191bf4`, tracked diff plus new source/test files. Source was changing during the initial review. Follow-up source verification confirmed all three accepted items implemented by their existing owners; overall runtime/security acceptance remains with W6/W8. Source remained read-only. This report follows the code-optimization playbook; no descendants were started.

| Id | Files | What | Why better | Size | Risk | Owner module |
|---|---|---|---|---|---|---|
| OPT-01 | `service/src/accountService.ts` (`bridgeContext`, `handle` bridge cases, approximately lines 409 and 746–749); interface already in `service/src/bridgeRuntime.ts` | Replace the three transitional `(method as (context?: unknown) => ...).call(...)` expressions with direct typed method calls. Use the exported `BridgeWorkspaceContext` as the helper's return type, and update the comment claiming the bridge ignores context. | W3 has supplied the actual optional-context signatures. The casts now bypass the compiler unnecessarily; direct calls preserve the receiver and runtime behavior while restoring interface checking. | S (<1 h) | Low: retain the same context argument and `await` for sync. | W1 engine/account service |
| OPT-02 | `service/src/mcp.ts`, `callTool` / `run` (approximately lines 302, 310, 320–340) | Pass the configuration already read by `callTool` into `run`, and reuse it for native usage freshness thresholds. Remove `getConfig()` inside the `list_accounts` and native `refresh_usage` branches. | Each affected request currently serializes and transfers the complete service configuration twice, sequentially. One per-call snapshot removes one socket round trip and uses the same snapshot for the MCP gate and threshold. Do not cache config across requests. | S (<1 h) | Low: a concurrent edit takes effect on the next request; retain the per-request enabled/switching check. | W2 MCP |
| OPT-03 | `src/extension.ts`, `aiUsage.setupMcp` (approximately lines 431 and 450–452) | Remove `'install'` from this picker action union and delete its unreachable handler. | The change removed the only producer of an `install` picker item; every remaining producer is `connect`, `enable`, provider registration, or `settings`. Removing dead code makes the bundled-adapter flow explicit. | S (<1 h) | Low: leave service installation available in its separate service menu. | W3 plugin |

Totals: S **3**, M **0**, L **0**. Owner totals: W1 **1**, W2 **1**, W3 **1**. Final optimization disposition: implemented and source-verified **3**, pending **0**, skipped **0**, optimization regressions identified **0**. No large work or architecture changes proposed.

## Inspected scope and boundaries

- Host/lease/config: new `engineHost.ts`, `runtimeLease.ts`, modified config authority, account-service dispatch, runtime teardown, daemon/path changes.
- Socket/client/MCP: protocol/capability changes, RPC request lifecycle, socket-only `ServiceClient`, MCP summaries and stdio adapter, registration command changes.
- Plugin/bridge: service manager adoption/config/reconnect, config synchronization, extension lifecycle and MCP provider, signed request workspace context, native bridge request handling and session lookup.
- Verification fixtures: new runtime parity scenarios and helpers, engine-host tests, modified bridge service helper, isolated root test launcher. The parameterized modes and shared fixture modules already avoid meaningful duplication; no test consolidation proposed.

Lease, cancellation, shutdown and workspace-security concerns belong to the separate [W6 audit](W6-report.md). In particular, this report does not duplicate its canonical-home, reclaim, queued-write or cross-workspace findings. The two protocol/capability namespaces are an interface-conformance question for W1/W2/W6, not an optimization-driven redesign.

Evidence: source/diff inspection and repository symbol searches only. No builds, tests, runtime probes, live account operations, installs, version changes or commits ran. Existing regression checks and final validation remain with the assigned owners/W8. The follow-up below verifies only the accepted optimization edits; test/build evidence remains with owners and W8.


## Follow-up verification — 2026-10-09

| Id | Disposition | Inspected evidence and effect |
|---|---|---|
| OPT-01 | Resolved; source-verified | `accountService.ts:29,471,821–824` imports and uses `BridgeWorkspaceContext`, directly calls all three bridge methods, preserves `await` for sync, and corrects the context comment. Three type-erasing casts and `.call` indirections removed; receiver and arguments retained. |
| OPT-02 | Resolved; source-verified | `mcp.ts` reads config in `callTool` once, passes it as the typed `ServiceConfig` argument to `run`, and uses it in both affected usage branches. Neither branch rereads config. One complete config RPC removed per affected tool request; enabled/switching checks remain per request. The new `service/test/mcp.test.js:342` test asserts one read for each call and a subsequent disabled state; inspected, not executed by W7. |
| OPT-03 | Resolved; source-verified | `extension.ts:431,450` restricts the setup picker union to actual producers and starts dispatch with `connect`; no obsolete install handler remains. Separate `serviceManager.ts:489,506` install menu/action remains available. |

No additional optimization scope was opened during this follow-up. No source changes or tests were performed by W7, and no owner action remains for OPT-01 through OPT-03.
