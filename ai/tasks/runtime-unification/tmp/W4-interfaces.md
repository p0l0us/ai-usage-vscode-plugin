# W4 parity fixtures
- Own scripts/run-tests.js (root isolated runner), package.json scripts only, new test/runtimeParity.test.js and test/helpers/runtimeHost*.js, test/helpers/bridgeService.js, test/usageClient.test.js. No service test edits.
- Both modes use startServiceHost and authenticated ServiceClient sockets; background in child Node, embedded in test process. Fixture provider requests are synthetic; all state/env directories temporary.
- Need startServiceHost test-only engineOptions?: Pick<AccountServiceOptions,'fetchUsage'|'usageIdentity'|'now'|'probe'|'identityOf'|'verifyCodex'|'syncClaudeMetadata'>. Inject these AFTER lease acquisition, never accept overriding home/log/version/lease. Background fixture uses same engineOptions constructed in child.
- Config tests use agreed getConfigState/patchConfig with revisions and check error code/data; lifecycle tests use service.status/shutdown and assert stopped.
- Request deadlines/cancellation tests use ServiceClient.call(method,params,{timeoutMs,signal}); delayed mock provider returns after abort, no mutation claims after execution begins.
- MCP fixture runs bundled service/bin/ai-usage.js mcp --home serviceHome; must connect without installing. Native fixture Claude/Codex credentials synthetic, providers have no saved profiles. Usage model-scoped windows and expired/no-reading states should remain distinct.
- Bridge parity needs actual spawned bridge and mocked executable paths bridge/test/fixtures/{codex,claude}.mjs; only loopback HTTP model requests.
