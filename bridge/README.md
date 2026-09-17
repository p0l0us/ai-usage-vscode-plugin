# CLI BYOK Bridge (experimental)

A Node.js local API that uses your **existing Codex or Claude Code subscription login**. The AI Usage extension bundles the bridge and contributes signed-in models directly to Copilot under **AI Usage CLI Bridge**. It can also run standalone as a Custom Endpoint. Copilot executes tools; the CLI waits for their results. No separately billed provider API keys, extracted OAuth tokens, or modified vendor binaries are needed.

Requires Node.js 22 or newer and a native CLI on the same host. Requires at least Codex CLI 0.151.0 or Claude Code 2.1.273; revalidated with Codex 0.154.0 and Claude 2.1.273. Both protocols can change; earlier releases are not supported. The extension starts both backends and contributes only authenticated catalogs. Standalone startup defaults to Codex; pass `--backends codex,claude` for both. Claude initial history is serialized (see limitations).

## Automatic Copilot models

Install this branch's AI Usage extension, reload VS Code, and open the Copilot model picker. **AI Usage CLI Bridge** lists the models from your signed-in Codex and Claude CLIs on the extension host. Discovery checks subscription login without sending a prompt. The picker waits for both backend checks (bounded to 15 seconds each, running concurrently) and refreshes every 30 seconds. If one backend fails, the other backend's models remain available and the failed check is reported in the bridge Output channel.

These settings are available under **AI Usage → Copilot CLI bridge (experimental)**. Every bridge setting carries the **Experimental** tag in the Settings editor. Feature switches appear in User and
Remote settings; machine-specific executable paths appear in the Remote tab in SSH/WSL/container windows:

- `aiUsage.bridge.modelsEnabled` (default `true`): contribute bridge models to Copilot.
- `aiUsage.bridge.autoStart` (default `true`): start the bundled bridge when no server is listening at the configured loopback address. An existing authenticated bridge is reused.
- `aiUsage.bridge.codex.executable` / `aiUsage.bridge.claude.executable`: executable name or path for automatic startup. Defaults to `codex` / `claude`. Restart the bridge after changing these.

Use **AI Usage: Refresh Bridge Models** to refresh immediately and **AI Usage: Check Copilot Integration** for diagnosis. Startup/discovery errors are recorded in **Output → AI Usage CLI Bridge**. The extension closes a server it started when its extension host shuts down; another window can start a replacement. Manually started servers are left running. In SSH/WSL, install the extension and CLIs on the remote host where your subscription login is stored.

Native provider requests support streamed text, image attachments, and client-owned tool calls/results. Context budgets (32,000 input / 4,096 output) and token counting are conservative estimates, not discovered limits or generation caps. Unsupported binary tool results and mixed tool-result/new-user-content messages fail explicitly. Organization policy may disable third-party models.

Both model catalogs are dynamic. Codex uses paginated `model/list` with `includeHidden: true`; hidden entries are labeled in the picker. Claude reads the `models` array from the native CLI's `initialize` control response, without sending a user prompt. Native display names, resolved Claude model IDs, extended-context selectors such as `[1m]`, and advertised effort levels are preserved. The catalog is the set reported by the installed CLI for its login, not every model in the vendor's public API. Discovery does not prove inference entitlement or pricing: native billing rules still apply, including usage-credit models where applicable. No hard-coded Claude alias fallback is used if initialization fails.

## Start

From this worktree, in Bash, PowerShell, or cmd:

```sh
cd bridge
npm start
```

There are no npm dependencies to install. Sign in beforehand with `codex login` using ChatGPT, or `claude auth login` using your Claude subscription. To enable both:

```sh
npm start -- --backends codex,claude
```

Custom executable paths are accepted with `--codex` and `--claude`. Use `npm start -- --help` for port, timeouts, and session limits. On Windows, native executables and standard npm `.cmd` launchers are supported; arbitrary batch wrappers are not. Windows support is implemented but has not been exercised on a Windows host.

The server listens only on `127.0.0.1:3210`. It creates a local bearer token at `~/.cli-byok-bridge/token` (`$HOME\.cli-byok-bridge\token` in PowerShell). Copy that file's contents into VS Code's API-key field. **This is a password for the local bridge, not a provider API key.** The file is restricted to the current user on Unix; on Windows it inherits the user-directory ACL.

The bridge rejects API-key logins and API-key/custom-endpoint environment overrides. It never switches billing automatically. Stop and restart it after switching CLI accounts. Finish or cancel active conversations before switching accounts; in-flight native sessions may retain their original login.

In SSH, containers, or WSL, start the bridge where the CLI is signed in. `localhost` refers to the machine making the endpoint request; a client on another host requires an explicit loopback tunnel. The bridge does not expose a network listener.

## Manual Custom Endpoint alternative

Run **Chat: Manage Language Models → Add Models → Custom Endpoint**, select **Chat Completions**, and enter the local token. Configure models in `chatLanguageModels.json`, for example:

```json
[
  {
    "vendor": "customendpoint",
    "name": "Local CLI subscriptions",
    "apiType": "chat-completions",
    "apiKey": "<contents of your local bridge token file>",
    "models": [
      {
        "id": "codex/gpt-5.6-sol",
        "name": "Codex CLI subscription",
        "url": "http://127.0.0.1:3210/v1/chat/completions",
        "toolCalling": true,
        "vision": true,
        "maxInputTokens": 32000,
        "maxOutputTokens": 4096
      },
      {
        "id": "claude/sonnet",
        "name": "Claude CLI subscription (experimental)",
        "url": "http://127.0.0.1:3210/v1/chat/completions",
        "toolCalling": true,
        "vision": true,
        "maxInputTokens": 32000,
        "maxOutputTokens": 4096
      }
    ]
  }
]
```

The token values above are placeholders. Keep the actual configuration in VS Code's user configuration, not this repository. Replace the Codex model with one returned by authenticated `GET /v1/models`; access depends on your account. The context sizes above are conservative client budgeting settings, not discovered model specifications. The output setting does not impose a hard CLI generation limit.

Select the model in the Copilot model picker and use Agent mode. Regular Chat is the first target. Agent Host BYOK requires the separately experimental `chat.agentHost.byokModels.enabled` setting. Organization policy can disable BYOK. See [VS Code model configuration](https://code.visualstudio.com/docs/agent-customization/language-models).

## API and lifecycle

All routes require `Authorization: Bearer <local token>`:

| Route | Behavior |
| --- | --- |
| `GET /health` | Server status and active/pending session count; no inference. |
| `GET /v1/models` | Available cached catalogs; returns when the first backend is ready. Add `?backend=codex` or `?backend=claude` to query independently. |
| `GET /v1/diagnostics` | Bounded checks for each backend: CLI version, native subscription authentication, and model capabilities. No inference. |
| `GET /v1/sessions` | Recent and active session metadata, timings, status, native IDs, account, and reported usage. |
| `GET /v1/sessions/:id` | One explicit bridge session. |
| `GET /v1/sessions/:id/subagents` | Tracked native children and saved session branches, including IDs and statuses. |
| `GET /v1/session-settings` | Current per-provider persistence and opening settings. |
| `PUT /v1/session-settings` | Replace per-provider settings; omitted fields/providers reset to defaults. Requires the local token and JSON. |
| `POST /v1/chat/completions` | Text and image messages, function tools, streaming SSE or JSON responses. |

The bridge spawns an isolated CLI worker for a new request. Tool calls return with `finish_reason: "tool_calls"` and an opaque `call_bridge_…` ID. The client executes the requested tool, appends the assistant message and the matching tool result, and submits the conversation again. That result resumes the same worker. The bridge does not execute client tools itself.

Concurrent conversations have independent workers and call IDs. Tool calls are exposed serially, including when a backend produces multiple calls concurrently. The default limit is eight workers. Model requests and pending tool calls each default to 60 minutes, configurable per backend from 1 to 1440 minutes. Client disconnection cancels active inference, while normal completion of a tool-call HTTP response keeps its worker alive. Shutdown terminates owned process trees. Expired/replayed continuations or changes to messages/model/tool definitions return HTTP 409; start a new conversation rather than blindly replay an action.

New user turns reconstruct from the supplied conversation by default. Clients that can preserve explicit metadata can send `"bridge_persist": true` on the first request, retain the returned `X-CLI-Bridge-Session-Id` header, and send `"bridge_session_id": "<that ID>"` with the full conversation on subsequent turns. The bridge validates the exact normalized history, model, reasoning, and tools, then sends only the new user input to the same native thread and warm worker. Both adapters support this; idle workers expire after the configured tool timeout and count toward the session limit. State is in memory and does not survive bridge restarts.

The VS Code provider automatically correlates saved chats using Copilot’s stable conversation ID, scoped to this host, workspace, and backend. Follow-up turns resume the same native session after releasing its worker; compacted history is not re-injected. The original session controls appear once. The optional `bridge_conversation_id` is a 64-character SHA-256 key; `bridge_resume_session_id` can adopt a saved session explicitly linked in existing assistant history. Saved metadata retains that mapping across restarts, bounded to 1000 sessions. Concurrent requests for the same chat are rejected while it is running. Claude resumes with current tools and instructions; Codex requires the saved dynamic tool list to match because its resume API cannot replace those tools. Clients without a stable ID can continue through an explicit saved-session link, but cannot recover correlation if compaction removes it.

Pending tools resume by their opaque call IDs without additional client options. Both kinds of continuation check native account identity and reject changes to credential/configuration file metadata or CLI binaries. This deliberately conservative check can also invalidate a session after a credential refresh. Finish pending tool work before switching accounts.

The Custom Endpoint interface is not assumed to echo the extra session metadata. Such clients retain warm native state during tool round trips and reconstruct subsequent user turns. There is no prompt-based conversation matching. Explicit continuations with changed/compacted history return 409; remove the session ID to start a fresh user turn. Do not replay an expired pending tool action.

Discovery shares concurrent work per backend, caches successful catalogs for 60 seconds, and invalidates them when CLI executable, account credential/configuration metadata, or routing environment changes. CLI versions and native authentication are checked on refresh; each new worker also checks native authentication. Slow or unavailable backends do not block a ready backend's fast catalog response. `/v1/diagnostics` reports both results, each bounded to 15 seconds. Discovery uses native model metadata without running inference.

The VS Code model provider also saves both catalogs in extension global state. After an extension restart, saved entries are offered immediately with a cached label while live discovery runs in the background. Successful discovery replaces and saves each backend's catalog; transient failures retain cached suggestions, while confirmed login or compatibility failures remove the affected entries. This persistent picker cache is scoped to the host and bridge configuration. The standalone HTTP discovery cache remains in memory.

## AI Usage extension diagnostics

The extension starts or connects to the bridge for native model discovery; it never runs inference during discovery. Configure `aiUsage.bridge.url` and `aiUsage.bridge.tokenFile` on the extension host if the defaults do not match your setup. Set `autoStart` to `false` to manage the server yourself.

- **AI Usage: Check Copilot Integration** checks backend login and CLI versions, visible models, utility-model selections, Copilot Chat availability, and the local/remote host plus Agent Host BYOK setting. It does not change settings or run inference.
- **AI Usage: Inspect CLI Sessions** refreshes every two seconds while open. It shows account, model, native and bridge IDs, elapsed time, phase/status, and actual usage when reported. Select a session to see full timing details or copy IDs/metadata. The bridge retains at most 1000 session records, including bounded native child result summaries; main transcripts remain in the native store.
- Read-only Copilot tools **get_cli_session_info** and **list_cli_subagents** require an explicit bridge session ID from the inspector. They do not infer which chat is current. Native children and explicit session forks are tracked separately. `fork_cli_session` runs a focused analysis branch from a released saved session and returns its IDs and answer.
- Optional **@aiusage /status**, **/sessions**, and **/diagnose** return metadata with progress and command buttons. These responses belong to the participant's own interaction; they do not decorate normal Copilot responses.

See the [feature revalidation matrix](../docs/BRIDGE_FEATURE_VALIDATION.md) for test coverage and remaining host acceptance checks.

## Save sessions and open them in VS Code or a CLI

Configure these options in **VS Code Settings → AI Usage → Copilot CLI bridge (experimental)**, separately for **Codex** and **Claude**. The switches are settings only; the inspector offers actions, not configuration toggles.

The persistence and opening switches are visible in the **User** tab, including in SSH/WSL/container
windows. Use **Remote** settings for host-specific overrides and session directories. Bridge settings
are excluded from Settings Sync by default.

| Setting (replace `<provider>` with `codex` or `claude`) | Default | Effect |
| --- | --- | --- |
| `aiUsage.bridge.<provider>.persistSessions` | `false` | Save new sessions in the provider's native session history. |
| `aiUsage.bridge.<provider>.openInExtension` | `false` | Show the exact-session chat link above the answer when the native session starts, plus opening/copying actions in the inspector. |
| `aiUsage.bridge.<provider>.openInCli` | `false` | Show a CLI link and copyable resume command above the answer when the native session starts, plus a terminal action in the inspector. |
| `aiUsage.bridge.<provider>.sessionDirectory` | `""` | Absolute workspace directory on the bridge host. The extension uses the current workspace when exactly one folder is open; otherwise empty falls back to `~/.cli-byok-bridge/workspaces/<provider>`. An explicit path always takes precedence. |

For example, enable history and extension opening for both providers in User settings:

```json
{
  "aiUsage.bridge.codex.persistSessions": true,
  "aiUsage.bridge.codex.openInExtension": true,
  "aiUsage.bridge.claude.persistSessions": true,
  "aiUsage.bridge.claude.openInExtension": true
}
```

Run a new request with an **AI Usage CLI Bridge** model. A **CLI session** header appears above the answer as soon as the native session ID is available, with **Open in CLI**, a copyable resume command, and **Open in Codex/Claude Code chat**, according to the enabled switches. There are no HTML markers. The command changes to the saved session's directory before resuming. These controls use the exact response's bridge session ID, including when several chats run simultaneously, and are removed from subsequent model context. Tool continuations do not repeat the header. They do not change older replies or responses from other model providers/Custom Endpoints. The session inspector remains available for metadata and opening actions.

A session must have finished and its worker must have closed before opening elsewhere. Controls are visible earlier; clicking while the worker is active explains that it is still running. Clients using `bridge_persist` must wait for worker expiry before opening elsewhere; that option controls live worker reuse separately from saving native history. Resuming outside the bridge starts an independent interaction; bridge tool connections are not recreated.

The inspector and `GET /v1/sessions/:id` expose `persisted`, `cwd`, `released`, and a `launch` object containing enabled extension URLs and CLI arguments. Codex uses `vscode://openai.chatgpt/local/<thread-id>`, based on the installed Codex extension's URI handler and route (26.908.40401); this is an internal integration that may change. Claude uses its [documented session link](https://code.claude.com/docs/en/ide-integrations#launch-a-vscode-tab-from-other-tools), `vscode://anthropic.claude-code/open?session=<session-id>`. AI Usage adapts the URL scheme for VS Code Insiders and compatible editors.

Chat links use AI Usage's URI handler and VS Code's `asExternalUri` routing to reach the correct extension host. Opening re-fetches the exact record and checks persistence, release, and current settings. Claude uses `claude-vscode.editor.open` with the exact native session ID and `programmatic: honor-preferred-location`, after selecting and awaiting its sidebar preference. This avoids Claude's public URL handler, which always invokes its primary editor. An already-open editor for the same session may be focused instead. Codex uses its sidebar and native thread route. These native command arguments are verified against the installed extensions and may change in future versions.

Install the corresponding native extension on the same host, using the same native CLI home and account. Claude requires the session directory to be open in the current window; AI Usage checks this before dispatching. Copied native URLs should be opened with the correct window focused. Remote/WSL dispatch and the rendered native extension UI still require a manual acceptance check.

The extension synchronizes settings on activation and changes, retries every 15 seconds when the standalone bridge is unavailable, and synchronizes before session inspection/opening. Settings apply to all clients of that bridge, are stored beside its token as `<token-file>.session-settings.json`, and survive server restarts. Use consistent User settings across windows/profiles sharing a bridge. Disabling persistence affects new sessions only and does not delete existing native history; disabling an opening action immediately hides it in the extension and removes its launch metadata after synchronization. Enabling an opening action does not automatically enable persistence or recover old ephemeral sessions.

Saved history remains in the provider's native store after bridge shutdown. Released saved-session metadata, child summaries, and branch links survive restart in the private records file beside the token (up to 1000 records); older saved sessions remain in the native history. Temporary prompt/MCP configuration is removed when the worker closes, while the configured workspace and native history are preserved.

## Image attachments

Image attachments are enabled by default for image-capable models; no bridge option is required. The Custom Endpoint configuration above includes `"vision": true` for both backends, so Copilot offers image attachments from the initial setup. If you previously copied the older text-only configuration, change its `"vision": false` entries to `true`. Codex discovery respects the CLI's model capabilities; models with `bridge.image_input: false` remain text-only.

Both backends accept Chat Completions user content with text and embedded images, including multiple images and image-only messages:

```json
{
  "model": "codex/gpt-5.6-sol",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Explain this screenshot." },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,<base64 image bytes>" } }
    ]
  }]
}
```

Replace the placeholder with the image's base64 bytes. PNG, JPEG, GIF, and WebP are accepted, with at most 20 images per request, 5 MiB decoded per image, and an 8 MiB total JSON request limit (including base64 and conversation history). The provider also validates image contents and may impose stricter limits. Images must appear in user messages. Remote URLs, local file paths, audio, and binary document/file parts are rejected; files already supplied as text work as before.

Images remain available in reconstructed conversation history and through tool continuations. Codex receives native image input and history items, following the [OpenAI Docs app-server protocol](https://learn.chatgpt.com/docs/app-server). Claude receives native base64 image blocks through [structured streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode); its serialized history uses labeled references to those blocks. Codex forwards `image_url.detail` (`auto`, `low`, or `high`). Claude chooses image processing itself, so explicit `low`/`high` hints are reported as `image_url.detail` in `X-CLI-Bridge-Ignored-Parameters`.

## Backend boundaries and limitations

- **Codex:** native role/tool history injection, dynamic tools, managed ChatGPT login. Environment access is disabled and shell, web, MCP, plugins, hooks, and other independent tool sources are disabled for bridge threads. Its code-mode host remains available to dispatch dynamic tools. Unexpected native tool events/approval requests terminate the session. This is protocol-level tool isolation, not an OS security sandbox or a guarantee about future CLI versions. See [app-server protocol](https://learn.chatgpt.com/docs/app-server).
- **Claude:** unmodified `claude -p`, structured streaming, explicit private MCP relay, no built-in workspace tools, restricted mode, disabled hooks, and no disk session persistence by default (session settings can save native transcripts; opt-in continuation retains the live worker). The first request's prior conversation is serialized as labeled JSON because the CLI lacks a general raw message-history input. Tool continuations retain native state. This can affect long/complex conversations and is why the adapter is experimental. See [Claude CLI reference](https://code.claude.com/docs/en/cli-reference).
- **Authentication:** each CLI owns subscription login/refresh. The bridge checks native auth status before use. It does not collect provider credentials. For distribution, Anthropic distinguishes native CLI sign-in from third-party credential routing; this local implementation is not a claim of vendor approval. See [Anthropic authentication conditions](https://code.claude.com/docs/en/legal-and-compliance).
- **Parameters:** `tool_choice` supports `auto`, `none`, `required`, or one named function. Required-call violations fail explicitly. `reasoning_effort` is validated against the selected model's native catalog before inference, then forwarded. Effort choices are model-dependent; the bridge accepts `max` and `ultra` when advertised by the backend. `max_tokens`, `max_completion_tokens`, `temperature`, `top_p`, and frequency/presence penalties are accepted for client compatibility but **not enforced** by the CLIs; the response identifies them in `X-CLI-Bridge-Ignored-Parameters`. Do not use this endpoint when hard token/sampling guarantees are required.
- **Unsupported:** remote image URLs, audio and binary document/file attachments, strict function schemas, JSON response formats, stop sequences, multiple choices, Responses/Messages endpoints, inline completions, embeddings, automatic account switching. Unsupported requests fail before inference rather than losing input silently.
- **Usage:** reported only when the backend supplies it. Codex reports its last model invocation; Claude reports aggregate invocation usage, including internal overhead. Pending tool responses omit usage. These are not equivalent per-request measurements and must not be summed as uniform billing records. Subscription rate limits still apply.
- **Privacy:** logs contain request IDs, model IDs, outcomes, and error codes, not prompt text, tool arguments, results, or provider credentials. The bridge uses temporary private directories for CLI inputs and removes them when workers close. When native session persistence is enabled, conversation history is retained by the vendor CLI and the configured workspace is preserved. The vendor CLI may also have its own diagnostics/storage behavior.

## Validation

```sh
npm test
```

Offline tests cover HTTP/SSE framing, actual child-process adapters, native image input/history, attachment validation and limits, MCP relay, subscription-only authentication, tool-result correlation, concurrent chats, expiry, cancellation, limits, and refusal of unexpected backend actions.

Explicit live checks consume subscription allowance and edit only a disposable client-owned fixture:

```sh
npm run test:live -- --backend codex
npm run test:live -- --backend claude
npm run test:live:continuation -- --backend codex
npm run test:live:continuation -- --backend claude
npm run test:live:images -- --backend codex --model codex/gpt-5.6-sol
npm run test:live:images -- --backend claude
```

They act as the external client and verify read → edit → test → final answer through HTTP SSE. The image checks send synthetic PNGs and verify recognition of current and historical images, followed by an external tool call and continuation. They do not automate VS Code's UI. A manual Copilot Agent-mode acceptance run and a native Windows run are still required before treating this as production-ready.

Live checks passed on Linux with Codex CLI 0.151.0 (`codex/gpt-5.6-sol`) and Claude Code 2.1.273 (`claude/haiku` and `claude/sonnet`). Codex role-preserving reconstruction was also checked with a prior user/assistant conversation. Both subscriptions were used through their native CLI login.

Live image checks passed on Linux with Codex CLI 0.154.0 (`codex/gpt-5.6-sol`) and Claude Code 2.1.273 (`claude/haiku`), including image recognition, reconstructed image history, and tool continuations.

Live continuation checks passed on Linux with Codex CLI 0.154.0 (`codex/gpt-6-astra`) and Claude Code 2.1.273 (`claude/haiku`): two user turns retained native context in the same worker/thread, with native usage reported.

The read → edit → test HTTP/SSE flow was revalidated with Codex CLI 0.154.0 (`codex/gpt-6-astra`) and Claude Code 2.1.273 (`claude/haiku`) after the integration changes.

### Long tasks, native delegation, and forks

In **Copilot CLI bridge** settings, each backend now has **Subagents Enabled**, **Request Timeout Minutes**, and **Tool Timeout Minutes**. VS Code enables delegation by default; standalone clients can enable `subagentsEnabled` through session settings. Requests and tool waits default to 60 minutes, with a 24-hour maximum. The model transport and Claude MCP relay respect the extended lifetime. Cancellation or disconnection stops the current request; this is not a detached background job scheduler. Saved sessions can be resumed afterward.

Native children use the external client’s tool relay. Claude provides a `bridge-worker` agent; Codex can delegate with inherited context/tools. Delegation is limited to four concurrent agents and one nesting level. Child text and completion events are isolated from the parent answer, and the parent waits for tracked children before releasing its worker. Codex fresh-context children may not inherit dynamic tools in the installed CLI; request inherited context when they need external tools. Native workspace execution remains disabled.

To create a native session branch, submit a normal Chat Completions body to `POST /v1/sessions/<parent-id>/fork`, or include `bridge_fork_session_id` in a request. The parent must be saved and released. Supply a new conversation ID for a new branch; follow-up turns use the returned branch ID/conversation ID. Each fork has a distinct native ID and inherits parent history through Codex `thread/fork` or Claude `--fork-session`. This forks conversation history, not Git branches or worktrees. The `fork_cli_session` Copilot tool provides analysis-only forks with no workspace tools; regular fork API clients can supply external tools and handle their results.

Live checks: `node bridge/scripts/live-delegation.mjs --backend claude` or `--backend codex` (run from the repository root). They verify native delegation, child calls through the external tool relay, and a distinct fork retaining a secret from parent context.


### Agent links inside Copilot

SSE includes `bridge_subagent: { session_id, agent }` when native delegation status changes.
The VS Code provider shows each child link once and removes these controls from forwarded
assistant history. The session header's **Agent map** link invokes `@aiusage /agents <id>`
in Copilot; a child link selects its details. Maps include native child status/results and
saved branch relationships, with explicit refresh links. Native labels are escaped and result
summaries are capped at 4,000 characters. Maps show at most 200 entries.

Codex child opening validates that the child belongs to the requested saved, released parent
before opening its exact native thread. Claude subagents use parent-session resumption;
the details describe the supported route rather than treating an agent ID as a session UUID.
These are bridge-backed Copilot controls, not a replacement for every native IDE feature.
