# Runtime unification security and lifecycle audit

Reviewed 2026-10-09 against the working tree based on `8191bf43d57bc84bb6771785f78a5328c5949d75`.

**Verdict: scoped audit passed.** All ten findings raised during implementation are resolved. This records the independent review and targeted regression evidence; the final repository build/test gate remains separate.

## Scope and authority

The audit covers background and editor-owned hosts using the same service home, authenticated socket, configuration authority, MCP adapter and managed bridge. It includes queued cancellation, disconnects, failed shutdown, process death and concurrent windows. It does not treat different OS users, containers or unrelated service homes as one coordinated deployment.

| Actor or boundary | Permitted access | Enforced boundary |
| --- | --- | --- |
| Runtime owner | Native credentials/settings, profile/state/config files, automation, proxy and bridge lifecycle | A single home lease precedes engine construction; disposal drains admitted work before releasing it |
| Authenticated socket client | Shared account/configuration operations and its own connection context | Token handshake, protocol/capability checks, typed errors and request cancellation |
| Unauthenticated local connection | Handshake only | No client context or engine dispatch before authentication |
| Editor window | Shared engine reads/actions; local presentation and connection preferences | Reconnect hydrates authoritative configuration; explicit writes carry the observed revision |
| Bundled MCP adapter | Declared usage/account tools through the socket | Does not launch a detached engine; switching remains gated by MCP policy |
| Managed bridge | Native inference and saved-session metadata | Request-scoped workspace context; persistent child identity and exit-before-replacement supervision |

The service token grants broad account authority, including profile operations. Bridge clients receive its bridge bearer token; the workspace HMAC protects routing integrity, not isolation from a malicious client already holding that token. Per-window context is a routing and lifecycle boundary, not an OS sandbox.

## Requirement matrix

| Requirement | Review result and evidence |
| --- | --- |
| Ownership before token/config/native engine initialization | Shared `engineHost` acquires ownership before engine construction and state initialization. Missing-home symlink identity regression passes |
| Race/crash takeover; live unreachable owner refused | Linux abstract socket, Windows named pipe, other platforms fixed loopback TCP lease. Forced TCP three/six-contender, live-owner, collision, uncertain-probe and SIGKILL tests pass |
| No mutation replay or queued work after stop | Socket client does not replay requests. Request scope reaches queue admission; stop drains admitted work. Queued cancellation/lease-loss and stop/drain tests pass |
| Shared lifecycle/logs/deadlines/version contract | Both hosts expose the same authenticated server and dispatch. Protocol/capability, lifecycle and cancellation behavior inspected; broader parity tests supplied by W4 |
| Token/socket protection | POSIX service home is 0700, token/socket are created with 0600 access; token required before dispatch. Native Windows ACL behavior was not exercised |
| Persisted configuration authority and revision checks | First-run seed preserves existing values; per-key conflicts reject stale edits. Captured editor revision, reconnect and malformed-file preservation paths reviewed |
| Local presentation and per-connection workspace | Editor hydration/push filters presentation. Workspace/GitHub context is removed on disconnect. Signed concurrent A/B inference and foreign/empty/multi-root saved/fork denial regressions pass |
| Bundled MCP; unsaved native usage and honest freshness | Adapter connects without installation or detached startup. Expired resets are stale; missing readings cannot advertise usable capacity. Independent targeted MCP regression passes |
| Await bridge exit on restart/shutdown/crash | Persistent child record precedes admission and remains after listener closure. Real idle/active owner-SIGKILL tests assert old bridge and delayed native worker are dead before replacement spawn |
| Failed cleanup remains closed to takeover | Failed drain/child-stop retains runtime ownership; explicit retry succeeds. Malformed/nonregular bridge metadata and live child without listener refuse replacement |

## Findings resolved

| ID | Severity | Resolution |
| --- | --- | --- |
| W6-001 | High | Canonicalize missing homes through their existing ancestor |
| W6-002 | High | Capture configuration revision together with queued edit values |
| W6-003 | High | Reject scoped saved-session/fork requests with unresolved or foreign workspace |
| W6-004 | High | Eliminate partial filesystem lock publication with the OS-owned fallback |
| W6-005 | High | Remove filesystem reclaim entirely; exclusive deterministic TCP ownership |
| W6-006 | Medium | Mark quota readings with expired resets stale |
| W6-007 | Medium | Require fresh readings for usable capacity; expose stored credentials separately |
| W6-008 | High | Retain ownership when engine disposal cannot prove shutdown |
| W6-009 | High | Recheck queued admission and drain requests/background work |
| W6-010 | High | Wait for the recorded bridge child to exit even after its listener closes |

## Validation and limits

The final independent lifecycle delta passed 13 selected lease/shutdown/crash tests and two metadata-refusal tests. Earlier independent passes verified seven configuration/workspace/MCP regressions and nine intermediate lifecycle regressions. Tests used temporary `HOME`, `AI_USAGE_HOME`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR`; final runs used the `fixtureNetwork` external-network denial preload and the shared validation lock. Native inference was synthetic. No real provider calls, account changes, installs or publication were performed.

Execution was on Linux, including actual forced TCP fallback listeners and real child-process SIGKILL. Native macOS and Windows execution remains unverified. A TCP port collision deliberately makes the runtime unavailable; it never chooses another port. Provider integration with real credentials and the final full-suite gate are outside this independent targeted validation.

## Final lifecycle source snapshot

SHA-256 fingerprints at review handback:

| File | SHA-256 |
| --- | --- |
| `service/src/runtimeLease.ts` | `b0729254300f571abf7e4e7c8b54c2915e1debe56839e69c12a1e696282aaaf1` |
| `service/src/engineHost.ts` | `2b017a0d9f20be39737009c7f504da44a7ab641dd0026698339e405d05b7476a` |
| `service/src/accountService.ts` | `a788db171fc97dc2b10f1a65c896e7df490453f756f0434df9849069e2b4a9d8` |
| `service/src/accountAutomation.ts` | `946af3bfb003355f9fdb9cee9cdab884cc1eddeea239dc9f9903938484c2ee74` |
| `service/src/bridgeRuntime.ts` | `6c190a6bd218f21bc1722fa83f809a2e4fea8e34c3bea4d90bf8a51c214fddb5` |
| `bridge/src/cli.mjs` | `7e412f56061b3ab33e213c2b466f223bf28a12666586289faa102207c100c2d0` |
| `service/test/engineHost.test.js` | `fdbf533e883b60608dbe31da09c706676ca278ea36cd4bbd24836046fbcc4fc7` |
| `service/test/bridgeRuntime-parent-death.test.js` | `28348bceacd1db74c80bcb432580510851357c2c2771c5fdd00259650086d739` |
| `service/test/bridgeRuntime-lifecycle.test.js` | `8ae029f6260ea2135322282fdd2745b4657264ad32b8831165d09b66fc6b3fe3` |

## Continuation: automatic sources and earned-reset confirmation

Reviewed 2026-10-09 against frozen W10/W11/W12 sources. **Verdict: scoped continuation passed.** The preceding W6 lifecycle acceptance remains intact. This delta covers automatic usage-source selection, minute intervals/defaults, and optional confirmation before an earned Codex reset. It does not expand the original authentication or ownership audit.

Automatic selection tries fresh identity-keyed cache, local account/session data, direct API, then CLI. It retains original observation timestamps, validates results after asynchronous reads, and stops transport fallback for provider retry instructions or exhausted shared budgets. Expired auto cache data cannot remain a successful current reading while refresh is blocked. Codex session logs and unknown auto provenance remain unavailable for attribution to a saved account. Default intervals are 30 minutes; explicit older source modes and interval values retain their meaning.

Confirmation defaults off, preserving the previous automation policy. When enabled, the engine generates an expiring decision without spending or writing a reset-attempt key. One planner binds target, credential fingerprint, settings/configuration revision, counted windows, quota/credit facts and policy reason. The editor displays engine-provided facts and claims the decision before showing its modal. One client may approve; any client may cancel. Unclaimed, expired, stale, disconnected or cancelled decisions cannot spend. Approval is reserved once and authorized only within its resolver's account-locked asynchronous scope; a background sweep cannot borrow a queued approval. The final leaf rechecks identity, current plan, claim validity, request admission, shutdown and ownership before invoking the native runner. Existing durable provider idempotency protects uncertain outcomes; cancellation after the native mutation starts is not a rollback.

| Finding | Severity | Verified correction |
| --- | --- | --- |
| W14-001 | High | Compare successful asynchronous source results against their completion clock, not request-start time |
| W14-002 | High | Revalidate auto cache age on early returns and schedule by original reading expiry |
| W14-003 | High | Bind approval to the resolving execution scope so an unrelated sweep cannot redeem after queued-request cancellation |

Independent validation passed **13 source tests** and **38 selected earned-reset/confirmation tests**, with zero failures or skipped tests. This includes both actual socket host modes for source selection and all 18 reset-confirmation parity cases: approve/duplicate approval, cancel, no UI, stale credit/account, expiry, disconnect, shutdown and queued request cancellation. Deterministic cases additionally cover pure preview, unchanged-cancellation suppression, freshness/config/native changes, final lease loss, durable idempotency and the background-sweep approval race. An in-memory differential probe reproduced one reset call after queued cancellation without the new scope guards and zero with them.

Every independent command used the shared validation lock, four temporary account homes, and the external-network-denial preload. Reset fixtures injected synthetic runners and configured nonexistent native CLI paths. No real provider/account calls, installs or publication occurred. W11 supplied final service/editor TypeScript builds; W12 supplied configuration normalization/roundtrip/catalog evidence. The full repository gate remains W15's responsibility. Interactive VS Code UI and real provider credit redemption remain untested. The later W16 source-only disposition is recorded below. Detailed commands and the requirement matrix are in `ai/tasks/runtime-unification/tmp/W14-report.md`.

Editor integration was also traced explicitly: activation registers the handler before its initial connection; adoption and reconnection enumerate already-pending decisions after installing event forwarding. That exact initial headless-to-editor UI sequence is source-reviewed, not interactively tested. Configuration-toggle invalidation is covered by a deterministic zero-spend test; revision-based invalidation across further setting changes is source-reviewed. Disconnect cancellation is tested through real sockets in both host modes, while editor shutdown's client-close path and the modal's connected-client checks are source-reviewed. The added host `reset` injection exists only in the local typed constructor whitelist and was exercised by the synthetic parity fixtures.

### Continuation source snapshot

SHA-256 fingerprints at the continuation handback:

| File | SHA-256 |
| --- | --- |
| `service/src/live.ts` | `3128899350b0bf308dc7364facb9978e18e8ca009e029da6d6f0e89f8dcfc303` |
| `service/src/usageMonitor.ts` | `67ce853ff9ae5d1f54428d57df831dbb6b483f18ac95fd70aad188c8b850ee37` |
| `service/src/configStore.ts` | `13cef35a006852a067484b08159d0b46bec81aa31916cb68f87838796e5be15d` |
| `service/src/accountAutomation.ts` | `a9c968c21b3b3b514175c9e76a90650425b75c0a62fba3204401f8cc598b6c64` |
| `service/src/accountService.ts` | `fd5b25bb7233c08874b0e627fdae7dd12c972f62392ee236394ef0c97ece16c0` |
| `service/src/protocol.ts` | `8eb248cc45667ffc80770a37de868a268472ecb6f1abe21eb5754e688567e7e4` |
| `service/src/client.ts` | `a28264b91a7b1b942ecbf90e70b16fbaeaf113a80930bad40563578dd19f676b` |
| `service/src/engineHost.ts` | `21a42da0d28ffcf70f7bf9fbde9ab3f4fb50116920c44cf25b0e1399cf98847e` |
| `src/extension.ts` | `882e9533703c2264ea0fb21b12df52e33ff1419f55ddfd0da2bdf398decd668e` |
| `src/serviceManager.ts` | `2684eb35ad4f989c8894efa2540b1514f8c6f95ff2af7a84d1150a821fdec676` |
| `test/sourceAuto.test.js` | `5a1f79b8164df04ab31f8dfe4217be473d2b05af87f325efa1cf6d7664969eb1` |
| `test/sourceAutoParity.test.js` | `d81cd3376f1b0b7c9c825f2c238918a05becaea17aa55f0cbab5a3e627c7c342` |
| `service/test/accountAutomation.test.js` | `f9e68a1d71bceedff7ade9024defb2e2f7c9fd830f94fa7467f3616f368dfcbe` |
| `test/resetConfirmationParity.test.js` | `ddde189300fb6266004761bb8a8f1f1c431e6a4bea81f8f8636a2f43ae7a4672` |
| `test/helpers/resetConfirmationHostChild.js` | `44d0eb2ec9d018b70d970e12ffa5a374f85e26ab1f737b9a3d49d5b95631d895` |

### W16 post-snapshot source check

Accepted the bounded MCP selector/provider and registration-message delta by source inspection. The service owns installed-versus-bundled command selection; the editor uses the same selector and displays the engine's actual command and arguments. No authentication, ownership, reset handler or registration-execution change was introduced. Reversing only W16's extension import/rendering edits in memory exactly reproduced the original W14 extension fingerprint; the table above records its new hash. Account automation/service, protocol/client, host and manager fingerprints remain unchanged. W16 reports 9/9 targeted tests and final no-emit editor compilation; this final reviewer check ran no tests and does not broaden the completed credit audit.

| Additional inspected file | SHA-256 |
| --- | --- |
| `service/src/mcpRegistration.ts` | `25682de12ae802baaf3b28310343a2907aec2bbdde6d33c13d73819973df61e4` |
| `src/mcpProvider.ts` | `c9213fb7546a73a3f1e392866c77346eee4f8cd6cdcbc6d8cc5cf4dfbf8360c6` |
