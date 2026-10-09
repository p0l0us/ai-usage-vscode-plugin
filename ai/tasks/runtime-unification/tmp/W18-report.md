# W18 Claude model-quota fallback — implementation frozen

User clarification explicitly superseded original read-only analysis prompt: prefer general+Fable headroom; when none is available, permit general-eligible accounts even when Fable is exhausted. General exhaustion stays hard. No model switching or claim of restored Fable quota.

## Initial gap and final behavior
- AccountAutomation limitState already distinguishes general exhaustion (readOnly) from model-only exhaustion (dimmed). AccountsMenu already permits dimmed manual selection and shows Fable limit reached/actual percentage. No product UI/API change was needed for manual selection; added regression and socket evidence preserve that behavior.
- Existing automatic candidate limitedUntil and eligibleAccount gates counted Fable as an unconditional veto. Added two-pass selection within the same existing sweep: configured counted-window eligibility first, then general-only eligibility when Claude is exhausted and a model window counts. All full-headroom candidates are considered before fallback, including sequential strategy.
- Screenshot regression: general-exhausted active Claude3 switches to general-capable Claude1/2, both Fable100. Claude4/5 never qualify despite Fable62/79 because their general5h is100. Lower configured general thresholds remain hard.
- If the active account still has general headroom and no full model-capable alternative survives verification, retain it instead of rotating among model-limited accounts. Existing sweep throttling remains intact.
- Both candidate usage read and final existing keep-alive readback must pass the selected general/full limits and retain required window labels. Authentication checks, native identity checks, lifecycle/account locks, original probe/keep-alive model, and unknown/stale-reading policies remain. Missing/expired quota is never treated as Fable availability.
- Explicit modelLimits never and auto configured for another model retain their ignored-window semantics. Always/auto Fable or unknown still count model limits as rotation triggers/preferences, but no longer permanently veto a general-capable last resort. Codex retains its existing strict policy.
- Actual quota data stays unchanged: fallback profile is dimmed, Fable100 remains displayed; log states general quota fallback/model limit remains. No selected-model mutation occurs.

## Scope
service/src/accountAutomation.ts; service/test/accountAutomation.test.js; test/accountsMenu.test.js; NEW test/modelQuotaFallbackParity.test.js and test/helpers/modelQuotaFallbackHostChild.js; focused docs/ROTATION.md note. No source/helper changes outside authorized paths. Existing eligibleAccount helper itself remains strict: only Claude exhausted-account selection chooses its explicit general fallback pass.

## Validation
Both TypeScript builds passed: ./node_modules/.bin/tsc -p service and ./node_modules/.bin/tsc -p ./.
node --test service/test/accountAutomation.test.js test/modelQuotaFallbackParity.test.js test/accountsMenu.test.js:118/118 passed first run. Shared flock /tmp/ai-usage-runtime-unification-validation.lock, four temporary homes, inherited fixtureNetwork public HTTP/HTTPS/fetch denial. Scoped git diff --check passed.
Deterministic tests cover exact five-account screenshot with all four strategies, later full-headroom priority, no-bounce active fallback, configured general threshold and unknown general windows, newly general-exhausted readback, authentication failure/model unchanged, explicit never/auto/always, and unchanged Codex behavior.
Ten real-socket parity cases (five each background/embedded): screenshot fallback, full-headroom preference, no-bounce active retention, newly exhausted verification rejection, manual fallback selection with truthful Fable100/dimmed/general readOnly states. Synthetic coherent fetch/probe/identity verification/reset-forbidden hooks, nonexistent CLI paths, isolated native homes. Prior reset-confirmation tests retained in complete automation suite.
No live provider/model calls, real-account reads/writes, installs, commits, version bumps, or descendants. Source and tests frozen for W19 independent verification; final root gate/commit remains conductor-owned.
