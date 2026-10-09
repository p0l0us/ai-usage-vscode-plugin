# W19 independent selection conformance

## W18 verdict: accepted
No open Medium-or-higher finding in the bounded selection delta. Read-only review covered rotate's new two-pass Claude candidate selection, retained general threshold/required-window/authentication/native-lock checks, verified quota readback, no-bounce current-account retention, manual Accounts menu behavior and truthful docs. No source edits.

The screenshot behavior is covered: eligible Claude1/2 with Fable100 remain acceptable last resorts; general-exhausted3/4/5 never become eligible because Fable has headroom. Full counted-model eligibility is preferred first across all four strategies. A current general-eligible model-limited account stays selected absent a verified model-capable alternative. Selected model and observed quota are unchanged; model-only limitation remains dimmed and manually selectable.

The exact source diff modifies rotate's candidate loop/generalSettings selection and logging only. Reset canRedeem/creditUrgent precedence, redeemReset, async approval scope admission, preview/claim and idempotency methods were source-reviewed as untouched. Existing affected reset confirmation tests were independently rerun rather than claiming a fresh broad security/lifecycle audit. Prior audit snapshots remain historical; hashes below describe this reviewed W18 scope only.

## Independent final narrow gate
After W18 explicit source/test freeze, held /tmp/ai-usage-runtime-unification-validation.lock across both builds and focused tests. HOME, AI_USAGE_HOME, CODEX_HOME and CLAUDE_CONFIG_DIR all pointed to temporary fixture directories; inherited NODE_OPTIONS preloaded test/helpers/fixtureNetwork.js to deny public HTTP/HTTPS/fetch in Node children.

Commands: ./node_modules/.bin/tsc -p service; ./node_modules/.bin/tsc -p ./; node --test --test-name-pattern="model-quota|model quota|Claude prefers|Claude keeps|Claude fallback|counted-model|Codex model-window|manual selection permits|reset confirmation|cancelled queued approval|earned reset|redeemed credit" service/test/accountAutomation.test.js test/modelQuotaFallbackParity.test.js test/accountsMenu.test.js.

Both builds passed. Independent tests:40 passed,0 failed,0 cancelled,0 skipped; first attempt. This selected all new fallback strategy/priority/general gate/auth/readback/model policy cases,10 real background/embedded socket parity cases, manual dimmed-selection UI test, and16 earned-reset/confirmation/replay/cancelled-queued-approval tests. W18 author's separate complete three-file118/118 pass is evidence from the author, not an independently repeated suite. No full512 rerun.

Exact output and hashes: tmp/W19-validation.log.

| Reviewed file | SHA256 after independent gate |
| --- | --- |
| service/src/accountAutomation.ts | 51e78d6071e7ed0cc5856b35155662497c7b5eccb585cf82e5010d9b2ca58be3 |
| service/test/accountAutomation.test.js | 8ada91ac7e3816f7a67bb3dd5dc9650bc261bf44f94cdf81a0e2f119a32cfb83 |
| test/modelQuotaFallbackParity.test.js | 918112025dc31e43e674b865444053a8a4eaa264d383db31c9a1e294c1c93316 |
| test/helpers/modelQuotaFallbackHostChild.js | 18a510952f2bdaeb51dfb85b148069dbb34f171356dd1e5cfc6a54b5f235ac7d |
| test/accountsMenu.test.js | 782178efd8aa66e813f46bd7a8a8f4792342e1f989e5a1d3f9f4ac3cbc5bdae2 |
| docs/ROTATION.md | 19e641b6954a7343120973a2a2dfb68cb9231d13d57bce90c9191d251d8352f9 |

No live provider/model calls, real account state access, installs, commits, version bumps or descendants. Product behavior was exercised with coherent injected fixtures; no live provider validation is claimed. MCP guidance W20 is a separate later delta awaiting its owner freeze for a bounded addendum; this does not withhold W18 acceptance.

## W20 bounded MCP addendum: accepted

After W20 explicit three-file source freeze, independently reviewed service/src/mcp.ts, service/test/mcp.test.js and docs/MCP.md. No open Medium-or-higher finding. One low tool-description consistency issue (existing Codex sessions require proxy/restart, unlike Claude next-turn adoption) was corrected by the owner before freeze and checked in this final snapshot.

The contract exposes per-tool engine-configuration rotationPolicy for both providers even when rows are filtered. Per-managed-provider prerequisites distinguish one-provider readiness from both-disabled; policy is expressly not consent or an exclusive-control lease. Sustained agent-managed selection must ask the user to disable competing built-in rotation, reread after approved changes and before later decisions, and stop/ask again on reenabling. No configuration-write tool or silent configuration mutation was introduced. Occasional deliberate switching remains allowed with a warning about later built-in override. rotate_account remains explicit enginePolicy, including when scheduled rotation is disabled. General capacity and intended-model headroom guidance matches W18; quota is not fabricated and no model switch is promised.

Source review also checked isolated-home probeAccount behavior and Codex proxy per-request native-credential behavior to ground policy facts. The MCP adapter does not currently forward engine events, offer subscriptions, run an autonomous selector or wake models; instructions/docs accurately describe that limitation. This W20 acceptance does not imply acceptance of subsequent separately authorized W21 event work.

Final independent discriminating gate held the canonical flock with four temporary homes and inherited fixtureNetwork guard: ./node_modules/.bin/tsc -p service; node --test --test-name-pattern="initialize negotiates|tools/list offers|each tool uses one live|MCP rejects malformed|filtered account lists|occasional account selection|MCP guidance and profile facts|MCP reads the shared engine|switch_account, rotate_account and refresh_usage" service/test/mcp.test.js.

Service build passed;10 selected tests passed,0 failed/cancelled/skipped, first attempt. Includes existing initialize/tool discovery/action outcomes/config snapshot/input validation and all new policy/guidance/occasional-switch cases, plus real background and embedded socket-host policy toggles. Actual host toggles prove configuration reread reflects one off, both off, then reenabling even under opposite-provider row filters. Author's separate20/20 full MCP-file pass and final1/1 wording regression are not counted as independently repeated. No repeat of W19's40 selection tests or full512 suite.

Exact output/hashes: tmp/W19-W20-validation.log.

| W20 reviewed file | SHA256 after independent gate |
| --- | --- |
| service/src/mcp.ts | 63a7d4463609b5a3ba209c5e6964b7ab091526a954f893534d1038815ba2ae79 |
| service/test/mcp.test.js | 09291996c35035c278600502d032b985bad7fb740b18d8a06411509181cbdebb |
| docs/MCP.md | c4d6d6d8f0d757456e035bc25fd44b7ac470ffb5ad15e1db7bd3b66ae1fc3dc1 |

No product edits, actual account/settings changes, provider/model calls, installs, version bumps, commits or descendants. W19 W18+W20 bounded review and independent checks complete; accepted snapshot captured for later W21 ownership transfer.
