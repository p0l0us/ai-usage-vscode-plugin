# W5 documentation handback
- Updated README.md, service/README.md, docs/SERVICE_ARCHITECTURE.md, docs/CONFIGURATION.md,
  docs/MCP.md, docs/INTERNALS.md, CONTRIBUTING.md and open CHANGELOG section only.
- Documents one owner lease per canonical home, socket-only clients in both deployments,
  fail-closed unreachable owner, crash takeover, handshake/deadlines/cancellation and async cleanup.
- Documents persisted engine config, per-key revision conflicts, unconditional explicit CLI writes,
  editor-local presentation and requesting-connection workspace/bridge context.
- Project profiles remain shared across declared folders; no isolation claim for profile visibility.
- MCP documents bundled no-install editor/CLI commands, four tools, optional refresh profile,
  native unsaved activeUsage, freshness/unknown/model scope and account vs model switching.
- CLI bundled registration follows extension location; installed launcher remains stable.
- CONTRIBUTING documents root extension/service/bridge runner and isolated temporary homes.
- Verified current client/configSync/serviceManager/engineHost/runtime/mcp/provider/registration sources
  plus W2 final MCP handback; source now awaits runtime dispose before lease release.
- Validation: local link existence across all eight docs PASS; git diff --check PASS.
- Runtime tests intentionally not run; final functional validation belongs to W8.
- No version bumps, installs, commits, publishing or live account-state changes.
