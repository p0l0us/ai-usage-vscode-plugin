# W14 continuation audit

Status: **scoped delta passed**, 2026-10-09, against frozen W10/W11/W12 sources. All three findings are resolved. Limited to new source-auto/freshness/interval behavior and optional earned-reset confirmation. Existing W6 acceptance remains unchanged. Source is read-only; no implementation fixes by W14.

## Design agreements

W11 approved to implement engine-owned preview, one-client claim and one-use resolution. Applied the repository's preview/command principles to this plain Node runtime: one pure plan/digest helper, no redemption or reset-attempt writes for preview, command revalidation under the existing account lock, UI renders engine facts. Excluding reading timestamps from a stable digest requires separate freshness/reset-expiry/decision-expiry checks. Final admission must bind target/native identity, credentials, current settings, credit/quota facts and plan outcome; cancellation/disconnect/configuration changes/lease loss/shutdown deny before execution. Confirmation defaults false. With confirmation enabled, no UI never silently spends. Preserve the durable provider idempotency key after uncertain execution; never replay a consumed approval.

W10 source ordering is accepted based on local implementation: fresh cache, local file/log, direct API, then CLI transport; the latter adds process work and can reach the same endpoint. Explicit modes remain compatible. Shared endpoint budgets and provider retry instructions must prevent using another transport to bypass a restriction. Codex session-log provenance remains unattributable to the active saved account.

## Findings

### W14-001 — HIGH — pre-request clock rejects successful live readings as future data

Locations: `service/src/live.ts`, `fetchAutoUsage`; `service/src/usageMonitor.ts`, post-fetch auto validation.

The initial selector captures `now` before awaiting readers. Real API/CLI readers stamp `fetchedAt` after their request completes, so the new `fetchedAt <= now` validation rejects those successful readings as future timestamps. The monitor repeated the same comparison against its pre-fetch clock.

Independent current-source reproduction, evaluated in memory: the API and CLI each advance the injected clock 100 ms and return valid usage stamped at completion. Result: `{"advancingClockResult":"unavailable","calls":["api","cli"]}`. Expected: API succeeds and CLI is not called.

**Resolved.** The selector and monitor validate against the completion clock while retaining original timestamps. Independent `sourceAuto.test.js` and `sourceAutoParity.test.js` run passed **13/13**, including advancing-clock API/CLI cases and real background/embedded socket hosts.

### W14-002 — HIGH — cached local reading outlives the auto freshness interval

Location: `service/src/usageMonitor.ts`, early `nextCheck` return and next-check scheduling.

A valid local reading already 29 minutes old is accepted under a 30-minute interval, then the monitor schedules its next check 30 minutes after selection. Its early return does not revalidate auto freshness, allowing the old reading to continue as `kind:ok` after it expires.

Independent current-source reproduction: accept a 29-minute-old local result, advance time two minutes, read again. Result: `{"laterKind":"ok","ageMinutes":31,"fetches":1}`. Expected: stale result cannot satisfy the cache path; attempt eligible fallback or explicitly report unavailable/stale.

**Resolved.** Early auto-cache returns now revalidate freshness; next checks are capped by the original reading expiry and quota reset. A stale result becomes unavailable even when a lock prevents refresh. The independent 13-test source pass includes the 29-minute local reading followed by a 31-minute observation and successful new collection.

### W14-003 — HIGH — queued approval could authorize an unrelated background sweep

Locations: `service/src/accountAutomation.ts`, `resolveReset`, `rotate` and `redeemReset`.

The first implementation set a process-wide `decision.approved` flag before waiting for the account lock. An existing background sweep could read that flag and redeem using it while the approving request remained queued behind another operation. Cancellation of the queued request did not necessarily invalidate the flag before that independent sweep reached redemption.

**Resolved.** An `AsyncLocalStorage` approval scope now binds authorization to the resolver's locked execution. The matching decision ID is required for throttle bypass, initial redemption authorization and the final leaf check. The global flag reserves a decision against duplicate approvals but cannot authorize unrelated work. The final independent compiled confirmation pass includes the strengthened preceding-waiter regression.

An independent differential probe used a manual operation waiting for an external account lock, a background tick paused during native identity validation, and an approval queued behind that manual operation. It cancelled the approval before releasing the tick. Removing only the new scope guards in memory reproduced `{backgroundResetCalls:1,approval:{error:'Cancelled.'}}`; current source produced `{backgroundResetCalls:0,approval:{error:'Cancelled.'}}`. No source files were changed by the probe.

## Evidence discipline

Reproductions used in-memory TypeScript compilation, the shared validation lock, four temporary account homes and the `fixtureNetwork` denial preload. Both independent test passes used the same isolation. No provider calls, real credentials, account changes or root suite. W10 source ordering, preserved provenance, shared-budget/retry stops, explicit-mode branches and W12 default/interval mapping are accepted. W15 owns the full gate.

Independent final commands, run from `/home/p0l0us/projects/ai-usage-vscode-plugin`:

```sh
node --test test/sourceAuto.test.js test/sourceAutoParity.test.js
# 13 passed, 0 failed, 0 skipped
node --test --test-name-pattern='confirmation|earned reset|reset credit|redeemed credit|queued approval|final validation' service/test/accountAutomation.test.js test/resetConfirmationParity.test.js
# 38 passed, 0 failed, 0 skipped
```

Each command held `/tmp/ai-usage-runtime-unification-validation.lock`, set four temporary homes, and inherited `NODE_OPTIONS=--require=/home/p0l0us/projects/ai-usage-vscode-plugin/test/helpers/fixtureNetwork.js`. Confirmation fixtures additionally configured nonexistent native CLI paths and injected synthetic fetch/probe/reset runners. W11 supplied both final TypeScript build passes; W14 did not rebuild or edit production source.

## Final conformance

| Requirement | Result |
| --- | --- |
| Both providers auto; cache/local → API → CLI until fresh success | Accepted; direct selector and both actual socket host modes tested |
| Fresh timestamps, original observation age, conservative account attribution | Accepted; completion-clock and expiry regressions resolved; Codex session logs/unknown auto provenance cannot feed saved-account automation |
| Shared budget and explicit retry restrictions | Accepted; transport fallback stops for 429/Retry-After and respects provider budget/spacing |
| Minutes/default 30, explicit legacy modes and values | Accepted; config/schema/catalog/mapping inspected; W12 supplied 12-test normalization/roundtrip/CAS evidence |
| Pure preview and engine-owned impact | Accepted; one planner binds account, credential, settings/config revision, counted windows, quota/credit facts and reason; list/claim preview does not write a reset attempt |
| Opt-in false and no-UI safety | Accepted; previous opt-out redemption and idempotency cases pass; confirmation-enabled unclaimed decisions spend zero |
| Single owner, no approval replay, cancellation and stale facts | Accepted; duplicate claim/approval, other-client denial, any-client cancel, stale account/credit/config/native/freshness/expiry cases covered |
| Request, disconnect, shutdown and lease boundary | Accepted; scoped authorization and final revalidation deny cancelled/disconnected/stopped/lost-lease work before the native runner |
| Background/embedded parity | Accepted; 18 confirmation scenarios run through actual socket hosts, plus both source-auto host scenarios |

No extra optimization change is justified before the final gate. The shared planner and selector already avoid duplicating confirmation policy in the UI.

### Editor integration evidence distinction

- **Initial connection to an already-running headless engine: source-reviewed.** `extension.ts` registers its reset event handler during synchronous activation before the end-of-activation `ensure()` call. `ServiceManager.adopt()` installs event forwarding, declares folders, then calls `resetConfirmations()` and emits each pending decision. The same path runs on reconnect; `claimReset()` prevents duplicate dialogs across pushed and enumerated events/windows. The exact already-pending-at-first-editor-connection UI flow was not executed in an interactive VS Code test.
- **Configuration changes: tested and source-reviewed.** The deterministic configuration-toggle case changes confirmation from true to false, then verifies the old approval is stale and spends zero. W12 tests the flag's false default and automation mapping. Every engine configuration revision also participates in the plan digest, so changing settings and changing them back invalidates an older decision; this revision roundtrip is source-reviewed. Turning confirmation off intentionally restores separately enabled legacy automatic redemption, without authorizing the old confirmation.
- **Editor disconnect: engine-tested and editor source-reviewed.** Both real socket host modes close the claiming client's connection and verify decision removal, stale replay and zero redemption. Host disconnect invokes `forgetFolders()` → `forgetResetClient()`. `ServiceManager.stop()` closes the client, and the modal handler checks that the same client remains connected before resolving. A real graphical editor disconnect was not exercised.
- **Minimal host test hook: source-reviewed and exercised.** `EngineTestOptions` and its runtime whitelist both include only the additional `reset` runner injection. It is a local constructor option, not a socket/configuration setting; both host parity fixtures exercised it with synthetic data.

Source fingerprints and the final continuation verdict are appended to `docs/RUNTIME_SECURITY_AUDIT.md`. Review limits: synthetic providers only; no interactive VS Code modal or live credit redemption exercised. Once the native mutation has started, existing unknown-outcome/idempotency semantics apply; cancellation is not a rollback. No active descendants.

### W16 final source-only disposition

The frozen W16 command-selector/provider delta and extension registration-message rendering were inspected without rerunning tests or extending the credit audit. The shared service helper prefers the valid installed package/launcher and otherwise selects the bundled adapter; the editor delegates to that helper. The extension renders the existing engine-returned command/arguments and replaces the obsolete installation warning. Registration execution and reset confirmation are unchanged. Reversing only W16's type import and message-rendering edits in memory exactly reproduced W14's previous extension SHA-256, `2d7f5d93827a4dd3a0f4f20200dd7075157f20862a3e907a3db4c864de86e0b2`. All previously recorded account/confirmation/protocol/client/host/manager hashes remain unchanged. **Accepted; no new finding.** The audit appendix repins the extension hash. W16 supplied its 9/9 narrow tests and final no-emit extension compilation; W14 performed source review only for this final delta.
