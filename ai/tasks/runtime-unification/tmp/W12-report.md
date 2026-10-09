# W12 configuration, manifest and documentation

## Delivered
- `service/src/configStore.ts`: UsageSource gains auto; provider defaults auto/30 minutes; autoReset.confirmationRequired boolean false default and Codex-only schema; maps to AutomationSettings.resetConfirmationRequired. Existing normalization/ConfigAuthority/CAS logic preserved.
- `package.json`: Claude/Codex auto enum option/default, minute descriptions/default30, opt-in confirmationRequired. Existing versions/scripts/unrelated manifest fields preserved.
- `service/src/settingsCatalog.ts`: regenerated from manifest under shared validation lock; never hand edited.
- `service/test/configStore.test.js`: new defaults, opt-in coercion/provider restrictions, every old source mode and old explicit10/5 intervals disk roundtrip, no implicit autoReset enablement, invalid normalization, authority per-key conflict and unrelated stale-view merge/persistence. Existing full manifest/catalog parity test retained.
- Minimal updates README.md, service/README.md, docs/CONFIGURATION.md, docs/SERVICE_ARCHITECTURE.md, docs/MCP.md, CHANGELOG.md. Auto ordering/freshness follows actual W10 selector; reset safety checked against actual W11 accountAutomation.ts claim/list/resolve/planner/redemption code and editor claim handling.

## Evidence
- Locked generation + service TypeScript build + narrow configStore suite: **12/12 pass**, zero skipped; `tmp/W12-validation.log`.
- All product commands ran with temporary HOME, AI_USAGE_HOME, CODEX_HOME and CLAUDE_CONFIG_DIR and inherited fixtureNetwork HTTP/HTTPS/fetch public-network denial. Temporary directories removed by Python context cleanup.
- Local Markdown file links pass; git diff --check passes.
- No root suite, installs, commits, index changes, version bumps, live provider calls or real home/config access. No descendants.
- No heuristic migration of saved both/10/5 values: absent keys alone receive defaults. Explicit autoReset.enabled behavior retained.

## Remaining coordination
- W15 owns combined final gate. W12 source writes stopped after this report unless conductor requests concrete correction.
- Docs distinguish usage polling (no model prompts) from separately enabled keep-alive/rotation model actions.
