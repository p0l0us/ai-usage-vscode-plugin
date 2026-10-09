# W16 MCP ownership delta — complete, source frozen

## Evidence and scope
Existing W2 already placed all MCP protocol/tool implementation in service/src/mcp.ts and socket-only entry in service/src/cli.ts. The plugin enables engine config and invokes existing MCP registration RPCs; it retains Account service installation controls and existing Claude/Codex CLI register/re-register/remove actions. No duplicate MCP server, new target or mandatory installation was introduced.
Actual lifetime gap: mcpCommand formerly checked only launcher existence, so a valid installed package whose launcher was missing fell back into the extension package. The editor also duplicated command selection. Its registration confirmation displayed only `<runtime> mcp` for a full runtime/script descriptor.

## Minimal corrections
- service/src/mcpRegistration.ts: service-owned shared selector prefers valid installed package; stable launcher when present, recorded installed runtime/package when launcher absent, bundled service/runtime only when no valid installation exists. Optional bundled location/runtime inputs let the thin editor use this exact helper.
- src/mcpProvider.ts: editor definition delegates to the shared service selector. Installed choices do not depend on extension path; embedded mode remains available without installation.
- src/extension.ts: approved transferred registerMcpWithCli rendering only + McpCommand type import. Uses existing engine-returned command/args in registered/replacement messages, and unavailable warning no longer invents an installation prerequisite. No confirmation-credit flow or registration execution changed.
- test/mcpRegistration.test.js, test/mcpProvider.test.js: missing-launcher descriptor regression, existing launcher preference for both CLI targets, real bundled stdio in both hosts, no replacement after host stops, copied installed-package daemon/stdio surviving editor reader closure with absent extension path.
- docs/MCP.md: service ownership/thin controls, installed fallback and lifetime, retained Account service installation and CLI registration, embedded host lifetime.

## Validation
Canonical flock /tmp/ai-usage-runtime-unification-validation.lock enclosed service TypeScript build, extension TypeScript build and node --test test/mcpRegistration.test.js test/mcpProvider.test.js: 9/9 passed on first run. Final rendering-only change: extension tsc --noEmit passed. Every subprocess used temporary HOME, AI_USAGE_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR (+USERPROFILE), removed GitHub tokens and inherited fixtureNetwork public-network denial. Installed test only copied compiled package files into disposable fixture and wrote synthetic current metadata; never called installer/autostart or real vendor CLI registration. Existing registration tests use mock runner.
Owned-file diff --check passes. No full root suite here; final combined gate belongs W15.

## Audit disposition and limits
Authentication, credentials, socket compatibility, cancellation, ownership lease, engine lifecycle and reset-credit admission/revalidation are unchanged. W14 reviewer was notified of selector/provider delta and exact harmless extension rendering region for scoped source/hash disposition; no broad re-audit justified by these changes.
MCP stdio still only connects to an existing engine. Installed/background operation survives editor closure; an embedded host ends with its hosting window, after which adapter reports unavailable until another engine takes ownership. Bundled registration remains tied to extension installation location and may require re-registration after relocation; stable installed launcher remains preferred.
No installs, real account/config/registration changes, commits, index actions, version bumps or publication. No active source writers; no descendants.
