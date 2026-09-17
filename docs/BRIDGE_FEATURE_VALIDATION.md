# Screenshot feature revalidation

Revalidated on 2026-09-16 in `feature/cli-byok-bridge`. This document separates implemented behavior from host/UI acceptance that cannot be established by a Node test.

| Screenshot feature | Implemented behavior | Evidence |
| --- | --- | --- |
| Native Copilot models | Registers AI Usage CLI Bridge through the stable language model provider API. Bundles and starts the local server, discovers authenticated catalogs, streams replies and maps tool calls/results and image input. | `src/bridgeModels.ts`, `src/bridgeRuntime.ts`, `src/bridgeTransport.ts`; provider-to-native-fixture round trips, startup, conversion and SSE failure tests. |
| Check Copilot integration | Command checks native subscription status, CLI version compatibility, visible models, utility selections, Copilot Chat installation, remote host, and Agent Host BYOK setting. Read-only; does not run inference. | `src/bridgeIntegration.ts`, `bridge/src/discovery.mjs`; extension report tests and authenticated diagnostics tests. |
| Faster model discovery | One shared in-flight discovery per backend; independent backend queries; first ready catalog returns without waiting for other backends. Bounded refresh with cache invalidation on credential/configuration metadata, executable changes and routing environment. Cache lifetime 60 seconds; native auth is also checked before worker startup. | `bridge/src/discovery.mjs`; concurrent discovery, slow-backend, timeout, cache and identity tests. |
| Request diagnostics | Discovery, authentication, startup, first-response wait, streaming, tool handoff/result, completion, expiry, cancellation and error phases with timestamps. Bounded records contain no transcript/tool payloads. | `bridge/src/engine.mjs`; lifecycle, cancellation and metadata tests. |
| Session inspector | Refreshing command UI with account, model, explicit bridge/native IDs, parent/child fields, elapsed time, status, phase timeline, copy actions and actual backend usage. Unreported usage remains unknown. | `src/bridgeIntegration.ts`, `/v1/sessions`; metadata and extension registration tests. Native child statuses and saved fork lineage are tracked and tested. |
| In-chat session controls | A marker-free header appears above the answer when the native session ID is announced. Controls carry the exact bridge session ID, route back to this extension host, and prefer the native sidebar. Claude uses its programmatic session command rather than its editor-only URI. Headers are excluded from model history and not repeated for tool continuations. Opening still requires a released worker. | `src/bridgeSessionLinks.ts`; delayed-answer delivery, early server SSE metadata, concurrent chats, tool continuation after provider restart, setting gates, exact-session URI dispatch, remote routing, and CLI quoting. Native command arguments checked against installed Claude 2.1.273 and Codex 26.908.40401; rendered UI still needs host acceptance. |
| Read-only Copilot tools | `get_cli_session_info` and `list_cli_subagents` are registered and contributed. Require an explicit session ID and use authenticated read endpoints. | `package.json`, `src/bridgeIntegration.ts`; tool invocation, ID validation and route authorization tests. |
| Warm CLI workers with isolated threads | Independent worker/thread per conversation. Tool callbacks keep workers warm automatically; opt-in persistent sessions retain them after completion too. No cross-chat prompt matching. Expiry, limits and cancellation close workers. | Both adapters and engine; real child-process tests plus live CLI continuation checks. |
| Persistent conversation continuation with native tool correlation | Opaque tool call IDs resume native callbacks. `bridge_persist` and the returned session ID enable subsequent user turns without history replay, with exact history/settings validation and account/configuration change checks. | Engine and HTTP header tests, replay/mismatch/expiry tests; live same-worker two-turn checks on both CLIs. State lasts only until expiry/shutdown. |
| Richer capabilities and attachments | Native image blocks in current and reconstructed history, catalog-driven Codex vision/effort validation, supported Claude effort settings, native usage, incremental Claude text output. | Request/adapter tests, invalid-attachment limits, capability rejection tests, HTTP JSON/SSE/tool continuation coverage, live image checks. |
| Optional participant | `@aiusage /status`, `/sessions`, `/diagnose`, with progress and buttons. | Contribution and registration tests. Rich responses are confined to that participant. |

## Interface boundaries

- Ordinary Custom Endpoint clients are not assumed to echo the bridge's optional session metadata. They retain native workers for pending tools and reconstruct independent user turns. Explicit `bridge_session_id` is necessary for reuse across completed turns. Identical first prompts never identify a conversation. If history changes, a new user turn can omit that ID to start fresh; stale pending tool results return 409.
- Native subagents may delegate through the external tool relay; native workspace execution remains disabled. Native child metadata and saved conversation forks are tracked separately.
- Images support PNG, JPEG, GIF and WebP as embedded base64 data URLs. Remote URLs, local file paths, audio and binary document parts are rejected. Text file context remains supported as text. Configure `vision: true` in the Custom Endpoint model entry.
- Claude initial history is still serialized with role labels and native image blocks; subsequent persistent turns use native context. Claude discovery reads native initialization model metadata without inference; it does not prove per-model entitlement or pricing. Codex discovery includes hidden entries and follows all catalog pages.
- Credential file metadata changes conservatively invalidate continuations, even when caused by token refresh. This avoids silently continuing a worker under changed login/configuration.
- Usage is backend-reported, not estimated: Codex last model invocation and Claude native result aggregate. These have different scopes and are not uniform billing records.

## Validation commands

```sh
npm test
npm test --prefix bridge
npm run test:live --prefix bridge -- --backend codex
npm run test:live --prefix bridge -- --backend claude
npm run test:live:continuation --prefix bridge -- --backend codex
npm run test:live:continuation --prefix bridge -- --backend claude
npm run test:live:images --prefix bridge -- --backend codex --model codex/gpt-5.6-sol
npm run test:live:images --prefix bridge -- --backend claude
```

Live checks use native subscriptions and consume allowance. The continuation check passed on Linux with Codex 0.154.0 (`codex/gpt-6-astra`) and Claude 2.1.273 (`claude/haiku`): same worker, same native session, retained context, and native usage. Image recognition/history/tool checks also passed for Codex 0.154.0 (`codex/gpt-5.6-sol`) and Claude 2.1.273 (`claude/haiku`).

The extension suite passed 61 tests and the bridge suite passed 55 tests after the Claude session visibility and saved-link restart fixes. The model-cache regression test recreates the provider and storage from a disk snapshot, verifies that all saved entries return while bridge startup is blocked, and checks live catalog replacement, persistence, transient failure retention, and configuration invalidation. This simulates an extension restart; an actual VS Code restart/picker check remains manual acceptance. The live HTTP/SSE read → edit → test flow also passed on both CLIs in the earlier live validation.

Claude exact-session restore was additionally checked against the installed Claude Code 2.1.273 native reader. Its webview communications subclass sets `includeProgrammaticSessions = false`, hiding `sdk-cli` transcripts even during exact-ID activation. A new live Haiku session with `CLAUDE_CODE_ENTRYPOINT=ai-usage-copilot` appears in that filtered list and loads three native messages. Five affected saved transcripts were repaired by changing only their origin metadata (original files backed up); all five pass the same filtered-list and native-reader checks. This verifies native session discovery/loading, not the rendered sidebar. Released saved-link targets now survive bridge restarts in a private metadata file beside the bridge token, bounded to 1000 entries.

Saved-chat continuity also passed live checks on both Claude and Codex: a second turn resumed the exact native ID after a full bridge-engine restart, recalled a random secret absent from the new request, and called an external tool again. Provider regression tests verify one header across full-history turns, compacted history with an image, provider/metadata restart, and separate conversation IDs. Run `npm run test:live:saved-session --prefix bridge -- --backend claude` (or `codex`) to repeat the subscription check.

Manual acceptance remains: launch this extension in VS Code, run the integration command and inspector, invoke both metadata tools and participant commands, and attach an image in ordinary Copilot Agent mode. Native Windows and organization-policy scenarios require their respective hosts. Offline tests and direct CLI/HTTP checks do not establish those UI outcomes.

Protocol references: [Codex app server](https://learn.chatgpt.com/docs/app-server), [Claude structured streaming](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [VS Code utility and model settings](https://code.visualstudio.com/docs/agent-customization/language-models).

Live delegation and fork checks passed on Claude 2.1.273 and Codex 0.154.0. Each spawned a child that called an external tool, then created a distinct native fork retaining parent context. Fake-clock tests verify the old three-minute model and five-minute tool deadlines no longer interrupt configured long tasks, including the extension transport. Native delegation is not a detached scheduler, and conversation forks do not create Git worktrees.


Agent-link validation (2026-09-16): real Claude/Codex delegation emitted child lifecycle
metadata and retained native forks. Codex 0.154.0 uses `subAgentActivity` for the newer
agent flow; both that event and older collaboration/thread notifications are handled.
A saved child from the live check loaded its own nonempty history through `thread/read`.
Regression checks cover SSE events, one child link across tool continuations/provider restart,
remote link routing, parent-versus-child native opening, branch graphs, bounded map responses,
escaped labels/results, and presentation removal from native history. Copilot maps use the
VS Code chat-open command with an explicit metadata participant query; rendered UI acceptance
still requires reloading the installed extension and clicking the links in a real chat.
