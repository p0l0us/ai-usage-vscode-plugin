# How it works

## How live usage is read

- **Claude Code**: reads the OAuth token from `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`) and calls
  Anthropic's `/api/oauth/usage` endpoint, the same data shown by `/usage` inside Claude Code.
- **Codex**: by default runs `codex app-server` over stdio and calls `account/rateLimits/read`, the same data shown
  by `/status` inside Codex. The `api` source calls the ChatGPT usage endpoint with the token in `~/.codex/auth.json`;
  the `sessionLog` source reads the newest `rate_limits` record from `~/.codex/sessions`.
- **Copilot**: uses VS Code's existing GitHub sign-in (silently, never prompting) and calls the Copilot user
  endpoint that reports premium-request quota. Unlimited quotas are not shown.

## Multiple windows and rate limits

All windows on a machine share one cache file in the extension's global storage (`usage-cache.json`). Each
provider has its own entry. A window that finds a reading younger than the refresh interval uses it instead of
calling the network, and a window that starts a fetch marks the entry so others wait for its result. On a 429 or
5xx the `Retry-After` header is honoured when present, otherwise the wait doubles from 1 minute up to 30 minutes,
and the next-allowed time is stored in the same entry so every window backs off together. Backoff is per provider:
a Claude rate limit never delays Codex or Copilot. During a backoff the last good reading stays visible and is
greyed out once it is older than 15 minutes.

## How the chat chip works

VS Code renders items in the `chat/input/status` menu with the static title and icon from the manifest, and an
item with an icon renders icon-only. `scripts/generate-manifest.js` therefore generates one icon command per
provider (`aiUsage.chip.claude`, `aiUsage.chip.codex`, `aiUsage.chip.copilot`) whose `when` clause matches the chat's
locked agent (`chatAgentHostProviderId`, `lockedCodingAgentId`, `chatSessionType` such as `agent-host-claude`, or
`sessionType` in the Agents window) and a context key of the same name that the extension sets while the provider
is enabled and chips are on. The chip stays when the provider is not signed in where the extension runs or the last
refresh failed; clicking it runs `aiUsage.showDetails` for that provider, which opens a dialog with the same text as
the status bar tooltip (both are rendered from one description of the reading). VS Code gives extensions no way to
open an anchored hover from a toolbar item or a status bar entry, which is why the chip uses a dialog and the status
bar items have no click command. `aiUsage.chatChips.debug` bypasses the agent match, so with it on every provider's
chip shows (Copilot's included). Run `npm run generate` (also part of `npm run compile`) after editing the
generator.

All windows share one cache file in the extension's global storage, so only one window calls a source per check
interval and all windows respect the same backoff. Tokens are only read, never written or refreshed. If a token has expired, the item shows a warning and asks you to
run the CLI once so it refreshes its own login.
