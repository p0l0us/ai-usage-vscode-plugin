# W22 status/subscription conformance review

Status: PASS. Final independent gate completed on 2026-10-09; closeout transcribed by the root coordinator from the reviewer’s final tool-result messages. Scope is W21 engine cached status projection, MCP resources/tool wait, and W23's shared active-account credit display. Earlier runtime, credit-redemption and rotation audits remain accepted unless these changes alter a reviewed boundary. Source is read-only; W22 owns this report and a focused audit appendix. No descendants.

## Initial design constraints

- Status is a pure projection of engine-held/cache facts. Existing `snapshot()`/`providerView()` call `followNative()`, and `liveUsage()` may collect provider data; neither is a safe implementation shortcut for the new cached read. Subscription count must not multiply provider activity.
- Saved-account counts must not count an unsaved native login as another saved profile. Active/native attribution must match the relevant identity, or remain unknown. Each Codex account exposes its own provider-reported reset credits; absent is unknown, known zero is zero, stale facts stay explicit. W23 consumes the same projection and never sums inactive accounts.
- Snapshot epoch changes on engine restart. Revision changes track meaningful facts, including time-based expiry; capture timestamps alone must not create endless update churn. Baseline/subscription races and cursor mismatch require resynchronization, not implicit exactly-once delivery.
- Filters, subscriptions, waiting requests and outbound updates must be bounded. Unsubscribe, cancellation, engine disconnect and stdio closure clean listeners/timers/pending waits. Permission changes must prevent later status disclosure. Notifications inform the host; they do not promise to wake a model.
- Keep actual supported MCP negotiation (`2025-06-18`, `2025-03-26`, `2024-11-05`). These versions support resource subscribe/unsubscribe and update notifications. Do not silently switch to the different 2026 subscription protocol. Official references: [2025-06-18 resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources), [2025-06-18 cancellation](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation), [2024-11-05 resources](https://modelcontextprotocol.io/specification/2024-11-05/server/resources).

## W21E design disposition

**Approved** `W21-interfaces.md`: retain ordinary engine-read results per provider/context, synchronously project those facts and raw saved-account state, and expose one shared reset-credit helper. No call to existing collecting snapshots/readers. A process epoch and meaningful-fact revision support conditional reads/resync; one engine-owned deadline timer handles time-based staleness. Filters are bounded; saved counts stay total while rows are filtered. Each account's credits remain separate from native-unsaved data and quota reset freshness. The 15-minute credit age limit is a conservative local policy, not a provider guarantee.

Implementation constraints sent to the owner: invalid/newer reported-credit metadata must not resurrect an older known count; invalid/expired provider credit-expiry metadata cannot appear current; filtered-out rows must not return through active/native fallback; capture the clock once per projection and avoid scheduling already-expired deadlines; verify native identity rather than relying on selected profile ID. W23 was notified to use the same helper and attribution rules.

## W21M design disposition

**Approved** `W21M-interfaces.md`: retain existing negotiated versions; four stable status URIs with validated canonical filters; URI-only resource invalidations; two cache-only read/wait tools; explicit resync and no model-wakeup promise. Final bounds, including the root's subsequent override, are eight subscriptions, **one** wait of at most 30 seconds, one 100-ms coalesced dirty set, 64 active messages/queued responses and an 8-MiB response queue. Output backpressure, shutdown/disconnect and disabled-policy cleanup are part of acceptance.

Concrete race constraints sent before implementation: reserve subscription/wait slots before asynchronous operations; check cancellation/closure/enablement after awaited connect/config/baseline calls before retaining work; unsubscribe must invalidate outstanding baseline callbacks. The root's final filter constraint requires account-specific snapshots to suppress unrelated saved or unsaved native rows; total saved counts remain explicit. Both owners received this override. The editor was advised to omit saved-profile credit fallback without engine proof of matching native identity; W23 chose current identity-keyed live data only.

## In-flight source feedback

- **W22-001 — Medium, resolved and regression-tested:** initial `projectQuota()` reported overall availability as `available` for fresh model-only windows with no general quota report. Current code requires a general window and has a focused model-only regression. Historical window availability is explicitly named `reportedAvailability`; stale overall availability is unknown.
- **W22-002 — Medium, resolved and regression-tested:** the `workspace.context` GitHub setter initially retained the previous context's Copilot status, unlike `usage.context`. Current code invalidates both setter paths, rejects late completions after context replacement/disconnect, and checks retained Copilot selection against current configuration. Own-context normal-cache parity and other-context unknown behavior are covered by new tests.
- **W22-003 — Medium, resolved and regression-tested:** `wait_for_usage_updates` initially started its timeout after connecting and a preflight config request with a 90-second timeout. Its later timer did not interrupt pending calls, and cancellation could wait for unresolved connection setup. The deadline now covers the whole received request and aborts/races setup/read operations; a late unused connection closes without installing status listeners. Timeout returns an unchanged cursor only after an unchanged baseline was actually observed; otherwise it reports a timed-out tool error. Delayed connect/config/status cases were added.
- **W22-004 — Medium, resolved and regression-tested:** the new bounded stdio writer initially cleared queued response frames on normal input EOF while output could still be backpressured. Completed requests could lose their responses without an explicit transport failure. Normal EOF now drains successful responses with a bounded grace period, then explicitly logs/terminates if the peer stays blocked. Named input end/close listeners are removed when output closes first. Delayed-drain and output-close listener regressions were added.
- **W22-005 — Medium, resolved and regression-tested:** resource enablement was initially re-read only after the 100-ms notification-coalescing delay. An authoritative disable event followed by re-enable before that read, or before MCP initialization completed, left old subscriptions active without explicit resubscription. The corrected event handler revokes registrations and waits immediately when the engine's configuration event says `mcp.enabled:false`, independent of delivery/backpressure/initialization. Rapid false→true regressions passed in the final full MCP test file.
- Toolbar source observation **closed without a finding**: review checked whether quota expiry itself discards independently fresh credits. The actual `visibleUsage` uses raw current/last-good data and does not reject quota expiry; the shared credit helper therefore remains independent. No production change or extra read/fallback is needed. W23 will cover expired quota plus still-fresh credits with a focused helper/display regression.

The final narrow gate ran after all source writers froze, using four temporary homes, the network-denial preload and shared validation lock. No real provider/account calls, installation or full-root suite formed part of this verification.

W23 source slice is accepted: default-enabled presentation-only setting, no usage refresh caused solely by its toggle, shared credit helper, identity-keyed current reading only, known zero preserved, and unknown/stale status explained without a current count. The author's 23-test compilation pass and three formatting regressions are author evidence; W22's final combined gate passed.

## Final independent verification

The independent reviewer reported **72/72 passed**, zero failures, cancellations or skips, after compilation of both service and editor. The seven files were `service/test/statusProjection.test.js`, `service/test/statusSnapshot.test.js`, `test/statusSnapshotParity.test.js`, `service/test/mcp.test.js`, `test/statusBarSettings.test.js`, `test/usageFormatting.test.js`, and `test/configSync.test.js`. This includes all 34 current MCP cases, actual CLI notifications in both host modes, cached Copilot context isolation, per-account credit attribution, and toolbar/local-setting behavior. All five Medium findings were resolved. This was the agreed affected-scope gate, not another full repository run.

The reviewer's session exhausted its workspace credits after reporting the successful gate and before completing prose/hash bookkeeping. Root transcribed that recorded result here; no additional independent run is claimed. Runtime source remained frozen. Native Windows/macOS and interactive editor/third-party agent notification wake-up were not exercised.

### Root-captured frozen source fingerprints

Captured after the reported final gate; deployment changed version metadata, not these sources.

| File | SHA-256 |
| --- | --- |
| `service/src/statusProjection.ts` | `57b85d66015f94b5203241fc4fec73081aaf72aae4401d16e40a192e57798027` |
| `service/src/accountService.ts` | `8223be7bf5ff8c2217456e51dff9e758673318541a4ab46fa0c720dec7565a7e` |
| `service/src/protocol.ts` | `d00439404cbe9748b884d85770fcfe4891f341a7eda105be4756cb392b37043a` |
| `service/src/client.ts` | `a4d7eba3b64da937382e31111a15ea50d90fef53211b3c45913e09770a79af13` |
| `service/src/index.ts` | `6f7f4d76f9db561ca32d1cf5557146dbd063b4a9b6a12d02a0ac6a270b8f6927` |
| `service/src/mcp.ts` | `ed460889fd42198e19bd2d84979b7ce0d8ecabf9e1e6fa314d35e9b1917dc397` |
| `service/src/cli.ts` | `c2395b91745b69a73690eed02bf508b967ce69adf402df3fb62078bcd8b81982` |
| `service/src/configStore.ts` | `1f6b09efceeeb2587075955d1848d8de72e7493b6fe296d330dcf33a93172755` |
| `service/src/settingsCatalog.ts` | `5fe11a3b24e2f7e4e63681f3b2a518517089ec9bac6d8e85c4b6ecedeaa1c5b0` |
| `src/extension.ts` | `f42d3c79c34dfe82c5f77ccc73aac5016ed395b246438b43ff8373498612190f` |
| `src/usageFormatting.ts` | `4cc8f6d8d677d44904e52b89315ec8de011c1cfd4c94faa61254d7ed8324d7cb` |
| `src/statusBarSettings.ts` | `fc8c75c5d31375ac313cdef5a2bac28f11a3a1f5bb24b5811a9eaddc48e6b47c` |
