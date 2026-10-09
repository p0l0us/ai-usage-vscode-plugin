W4 complete: parity tests, root suite integration and socket fixture migrations.
Owned scripts/run-tests.js, package scripts + authorized mcp.enabled description, test/runtimeParity.test.js, new helpers, bridge helper/usageClient tests and authorized bridgeModels/bridgeSessionOpening expectation lines.
Root npm test builds under temporary HOME/AI_USAGE_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR and discovers complete plugin + service + bridge suites.
Every test worker and descendant Node process preloads public HTTP/HTTPS/fetch denial; loopback fixture requests allowed.
18 parity tests use real authenticated startServiceHost sockets: background child versus embedded process.
Coverage: native unsaved usage/diagnostics/Copilot context, same-key config conflicts/disjoint edits/events/logs/reconnect, typed errors/version refusal, deadlines/AbortSignal/shutdown.
Coverage: independent process owner elections, SIGKILL takeover preserving native credentials/config/profiles, absent symlinked home process race.
Coverage: bundled MCP stdio child without service installation, native active usage/freshness/unknown/stale/model windows and read-only tools.
Coverage: service-owned bridge child and both mocked native executable providers, concurrent signed A/B workspace inference, tampering refusal, awaited shutdown.
Migrated ServiceClient.local test and fake direct bridge calls to genuine socket hosts; explicit cwd lives in per-connection signed context.
Locked compile+narrow integration: 51/53 passed; all behavior assertions passed, two daemon IPC cleanup races then fixed.
Final locked compile + affected/typed tests: 6/6 passed (both modes error/deadline/cancellation/lifecycle/inference).
Earlier existing helper repair 35/37 passed; remaining saved-workspace context fixture corrected and passed in 51/53 gate.
All latest validations used /tmp/ai-usage-runtime-unification-validation.lock and temporary homes; no install/publish/version/commits.
Historical fixture-repair run overlapped an API rename (engine -> engineOptions), ignoring provider injection: Claude returned service rate-limited, Codex no-session-log. No real credentials/state used; zero external requests in that pre-guard run cannot be proven.
Canonical engineOptions + fixture network guard prevent that recurrence. Provider reads now synthetic; models run only mock executable children.
Remaining: conductor W8 final full root gate after all writers; non-Linux platform parity unexecuted here.
