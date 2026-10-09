# W21E implementation handback

Source and tests frozen; no runtime/source edits remain. W22 independently owns the final combined validation gate.

## Delivered
- Pure shared `statusProjection.ts`: raw/rounded quota facts, general/model limitation, provenance, known-zero/unknown/stale per-account reset credits, conservative 15-minute local credit freshness independent of quota reset.
- Additive `status.snapshot`, `statusChanged` cursor event, client cancellation/timeout options, status capability and exported types/helper.
- Observational engine status from raw account caches and ordinary-read retained native/context data. Snapshot/subscriber reads never collect providers, probe, follow native credentials, redeem, switch, or write account state.
- Total saved counts and filtered rows, separate native status, identity/ownership checks, bounded filters, conditional cursor reads/restart resync, lifecycle cleanup and one shared freshness deadline timer.
- Copilot ordinary toolbar-context data is visible only in its own status context; both setters/account changes/disconnect invalidate retained facts and late reads cannot restore old context.
- Native Codex unknown auto/session-log readings remain unattributed; API/CLI and exact account-scoped probe evidence retain positive attribution. Native-to-saved cache fallback only fills the matching owner with positive proof.

## Scope
`service/src/statusProjection.ts`, additive `accountService.ts`, `protocol.ts`, `client.ts`, `index.ts`; new `service/test/statusProjection.test.js`, `statusSnapshot.test.js`, `test/statusSnapshotParity.test.js`, `test/helpers/statusSnapshotHostChild.js`. Contract/report files in this tmp directory. No automation, usageMonitor, MCP, UI, manifest, configuration or deployment edits in W21E.

## Validation
All test commands used isolated HOME, AI_USAGE_HOME, CODEX_HOME and CLAUDE_CONFIG_DIR, fixtureNetwork preload and the shared runtime validation flock; synthetic fetch/probe/reset boundaries only.

Service and root TypeScript compilation succeeded, followed by:
`node --test service/test/statusProjection.test.js service/test/statusSnapshot.test.js test/statusSnapshotParity.test.js service/test/accountService.test.js`
Result: **36/36 passed**, `/tmp/w21-engine-tests.log`. Includes four real-host scenarios across background/embedded modes: multi-client counts/known0/filter/reconnect without extra provider reads; own Copilot ordinary cache parity versus unknown other contexts.

After final pure malformed timestamp/expiry/quota-shape guards, service TypeScript compilation and:
`node --test service/test/statusProjection.test.js`
Result: **11/11 passed**, `/tmp/w21-projection-final.log`. Scoped diff whitespace check passed. The earlier 36-test gate had nine helper cases; the final helper gate added two cases, so these results are separate, not a claim of a 38-test combined run.

## Limits
Snapshot freshness describes cached reported headroom, not credential validity or a promise that a model is callable. Unknown provider/context facts stay unknown until ordinary engine collection; no subscriber forces collection. Credit freshness is a conservative local display policy, not vendor-guaranteed TTL. Filtering leaves saved counts total but withholds unrelated native account facts. W22's final independent conformance/audit remains owned by the reviewer.
