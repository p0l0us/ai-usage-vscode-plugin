# CLI BYOK Bridge (experimental)

A standalone Node.js local API that uses your **existing Codex or Claude Code subscription login**. Select the bridge as a Custom Endpoint model in Copilot. Copilot executes tools; the CLI waits for their results. No separately billed provider API keys, extracted OAuth tokens, modified vendor binaries, or VS Code extension installation are needed.

Requires Node.js 22 or newer and a native CLI on the same host. Developed against Codex CLI 0.151.0 and Claude Code 2.1.273. Both protocols can change; earlier releases are not supported. Codex is enabled by default. Claude is opt-in because initial history is serialized (see limitations).

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

## Configure VS Code

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
        "vision": false,
        "maxInputTokens": 32000,
        "maxOutputTokens": 4096
      },
      {
        "id": "claude/sonnet",
        "name": "Claude CLI subscription (experimental)",
        "url": "http://127.0.0.1:3210/v1/chat/completions",
        "toolCalling": true,
        "vision": false,
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
| `GET /v1/models` | Codex model discovery and/or Claude aliases, after checking subscription login. |
| `POST /v1/chat/completions` | Text messages, function tools, streaming SSE or JSON responses. |

The bridge spawns an isolated CLI worker for a new request. Tool calls return with `finish_reason: "tool_calls"` and an opaque `call_bridge_…` ID. The client executes the requested tool, appends the assistant message and the matching tool result, and submits the conversation again. That result resumes the same worker. The bridge does not execute client tools itself.

Concurrent conversations have independent workers and call IDs. Tool calls are exposed serially, including when a backend produces multiple calls concurrently. The default limit is eight workers. Pending calls expire after five minutes; running HTTP requests time out after three minutes. Client disconnection cancels active inference, while normal completion of a tool-call HTTP response keeps its worker alive. Shutdown terminates owned process trees. Expired/replayed continuations or changes to messages/model/tool definitions return HTTP 409; start a new conversation rather than blindly replay an action.

New user turns reconstruct from the supplied conversation instead of relying on a global current session. Pending continuations require unchanged normalized history and tool definitions. Clients that rewrite system instructions or compact history between tool calls may receive 409; transparent rebase/replay is not implemented.

## Backend boundaries and limitations

- **Codex:** native role/tool history injection, dynamic tools, managed ChatGPT login. Environment access is disabled and shell, web, MCP, plugins, hooks, and other independent tool sources are disabled for bridge threads. Its code-mode host remains available to dispatch dynamic tools. Unexpected native tool events/approval requests terminate the session. This is protocol-level tool isolation, not an OS security sandbox or a guarantee about future CLI versions. See [app-server protocol](https://learn.chatgpt.com/docs/app-server).
- **Claude:** unmodified `claude -p`, structured streaming, explicit private MCP relay, no built-in workspace tools, restricted mode, disabled hooks, and no session persistence. The first request's prior conversation is serialized as labeled JSON because the CLI lacks a general raw message-history input. Tool continuations retain native state. This can affect long/complex conversations and is why the adapter is experimental. See [Claude CLI reference](https://code.claude.com/docs/en/cli-reference).
- **Authentication:** each CLI owns subscription login/refresh. The bridge checks native auth status before use. It does not collect provider credentials. For distribution, Anthropic distinguishes native CLI sign-in from third-party credential routing; this local implementation is not a claim of vendor approval. See [Anthropic authentication conditions](https://code.claude.com/docs/en/legal-and-compliance).
- **Parameters:** `tool_choice` supports `auto`, `none`, `required`, or one named function. Required-call violations fail explicitly. `reasoning_effort` is forwarded where supported. `max_tokens`, `max_completion_tokens`, `temperature`, `top_p`, and frequency/presence penalties are accepted for client compatibility but **not enforced** by the CLIs; the response identifies them in `X-CLI-Bridge-Ignored-Parameters`. Do not use this endpoint when hard token/sampling guarantees are required.
- **Unsupported:** images/audio, strict function schemas, JSON response formats, stop sequences, multiple choices, Responses/Messages endpoints, inline completions, embeddings, automatic account switching, and native VS Code provider registration. Unsupported requests fail before inference rather than losing input silently.
- **Usage:** reported only when the backend supplies it. Codex reports its last model invocation; Claude reports aggregate invocation usage, including internal overhead. Pending tool responses omit usage. These are not equivalent per-request measurements and must not be summed as uniform billing records. Subscription rate limits still apply.
- **Privacy:** logs contain request IDs, model IDs, outcomes, and error codes, not prompt text, tool arguments, results, or provider credentials. The bridge uses temporary private directories for CLI inputs and removes them when workers close. The vendor CLI may have its own diagnostics/storage behavior.

## Validation

```sh
npm test
```

Offline tests cover HTTP/SSE framing, actual child-process adapters, MCP relay, subscription-only authentication, tool-result correlation, concurrent chats, expiry, cancellation, limits, and refusal of unexpected backend actions.

Explicit live checks consume subscription allowance and edit only a disposable client-owned fixture:

```sh
npm run test:live -- --backend codex
npm run test:live -- --backend claude
```

They act as the external client and verify read → edit → test → final answer through HTTP SSE. They do not automate VS Code's UI. A manual Copilot Agent-mode acceptance run and a native Windows run are still required before treating this as production-ready.

Live checks passed on Linux with Codex CLI 0.151.0 (`codex/gpt-5.6-sol`) and Claude Code 2.1.273 (`claude/haiku` and `claude/sonnet`). Codex role-preserving reconstruction was also checked with a prior user/assistant conversation. Both subscriptions were used through their native CLI login.
