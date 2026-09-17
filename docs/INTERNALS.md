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

Claude and Codex cache keys include the selected authentication-profile id. A switch therefore cannot reuse the
previous account's usage reading or backoff entry.

Per-account caching is not enough for Anthropic's usage endpoint, because every saved account adds its own calls:
the active login polls it, keep-alive and rotation sweeps read it once per profile, and the details panel refreshes
it on click. `src/apiBudget.ts` therefore keeps one call ledger for the endpoint in `claude-api-budget.json`,
beside the usage cache and shared the same way. A call is claimed before it is made and no call may start within
`aiUsage.claude.api.minIntervalSeconds` (default 30) of the previous one, whichever window, account or command made
it. Every response's `anthropic-ratelimit-requests-remaining`/`-reset` and `Retry-After` headers are fed back into
the ledger: an exhausted quota blocks calls until it resets, and a reported remainder is spread over the rest of its
window, so an advertised limit stricter than the setting wins. A blocked interactive refresh releases the shared
fetch lock and shows the cached reading with the wait in its detail line; a background probe waits up to two
minutes for a slot and otherwise reports a transient error, which the automation retries at the next check interval.
Nothing is derived from the endpoint's undocumented limit itself: absent headers, only the configured spacing applies.

## Authentication profile storage and switching

`src/authProfiles.ts` keeps only profile names, timestamps, ids, and the active id in extension `globalState`.
Each credential body has its own namespaced `SecretStorage` entry, with a hard limit of 20 per provider.
`src/authFiles.ts` validates native/imported JSON and performs the filesystem update. Claude profiles contain the
`claudeAiOauth` object plus its root-level `organizationUuid` when present; activation replaces those account fields
in the current `.credentials.json` while preserving MCP OAuth entries. Codex profiles contain the complete
`auth.json` document.

Before activation, a refreshed native credential is copied back to the selected secret only when it can be matched
to the same owner: Codex `account_id`, an identical refresh token, or for Claude the root `organizationUuid`, because
Claude Code rotates the refresh token on every refresh and a token-only match would stop capturing after the first one. Writes go through a newly created
mode-`0600` temporary file in the destination directory and an atomic rename; the resulting file is explicitly
chmodded to `0600` on POSIX. Windows uses the destination directory's inherited user-profile ACL because its chmod
implementation does not support POSIX ownership modes.

Codex does not adopt a switched login in a running process: its auth manager re-reads `auth.json` before a turn but,
when the file now holds another account, fails the turn with "signed in to another account" instead of using it
(verified 2026-09-17 against 0.154.0 with `thread/start` + `turn/start`; `getAuthStatus`, `account/read` and
`account/rateLimits/read` keep answering from memory). Processes started after the write use the new login, and no
thread, rollout or sqlite row is bound to an account, so chats resume under the new login after an extension host
restart. After writing the file for a Codex
profile, `AuthProfileManager.activate()` calls the verifier passed by `extension.ts`
(`verifyCodexNativeAccount` in `src/live.ts`), which runs a fresh `codex app-server` on the native home and compares
the `chatgpt_account_id` claim of the token returned by `getAuthStatus { includeToken: true, refreshToken: false }`
with the stored `tokens.account_id`; `account/read` (email, plan type, `apiKey`) is the fallback because its
answer carries no account id. API-key-only profiles are matched by auth method alone. A mismatch replaces the
success notification with an error and leaves the file in place. Stale Codex processes are detected by start
time only: `afterProfileActivated` records `{ switchedAt, profileName }` in `globalState`
(`aiUsage.codexSwitch.v1`), and every window's one-minute tick lists this extension host's children
(`src/codexProcesses.ts`: `ps -eo pid=,ppid=,etime=,args=` on POSIX, `Win32_Process` on Windows), excluding
AI Usage's own servers by their `cli_auth_credentials_store` argument. A `codex … app-server` older than the switch
triggers one warning per switch per window (`workspaceState` key `aiUsage.codexSwitchNotified.v1`) whose only
action is `workbench.action.restartExtensionHost`; processes are never killed and no turn is ever injected. `aiUsage.codex.switchRestartHint` (default on) disables the warning. Duplicate profiles of one login are
detected by the stored email: refreshing two copies independently reuses a rotated refresh token and the provider
revokes the login, so saving or importing a credential whose email is already saved asks for confirmation.

## How the chat chip works

VS Code renders an item of the `chat/input/status` menu as its static title (or, if the command has an icon, as the
icon alone), and the item's hover repeats that title; there is no separate tooltip. Live text therefore needs one
command per possible label, which `scripts/generate-manifest.js` produces per provider: `aiUsage.chip.claude.simple.<n>`
(title "17%") for the single-figure item and its states `.pending` ("…"), `.unavailable` ("n/a") and `.error` ("!"),
plus `aiUsage.chip.claude.5h.<n>` ("17%") and `aiUsage.chip.claude.7d.<n>` for rich mode. The first item of each
kind also exists with a `.named` suffix ("Claude 17%"), chosen by the `aiUsage.chip.named` key from
`aiUsage.chatChips.labels`. Their `when` clauses match the chat's locked agent (`chatAgentHostProviderId`,
`lockedCodingAgentId`, `chatSessionType` such as `agent-host-claude`, or `sessionType` in the Agents window) and the
per-provider keys the extension sets: `aiUsage.chip.<provider>.simple` with the most used window's percent or a state
name, or in rich mode `aiUsage.chip.<provider>.<window>` per window (falling back to `simple` when no window label is
in the manifest, as for Copilot's single monthly window). All unset hides the chips. Clicking a chip runs `aiUsage.showDetails` for that provider, which opens the details quick pick focused on
that provider; status bar items open the same quick pick for all providers. VS Code gives extensions no way to open
an anchored hover from a toolbar item or a status bar entry. `aiUsage.chatChips.debug` bypasses the agent match, so with it on every provider's
chip shows (Copilot's included). Run `npm run generate` (also part of `npm run compile`) after editing the
generator.

Status-bar percentages use each window's live `resetsAt` value in parentheses. `formatResetRemaining` selects one
largest whole unit only: minutes below one hour, hours below one day, then days. Chat-toolbar command titles are
static, so their compact chips show percentages only; clicking one opens the live window names and countdowns.

The details panel gives each service a single row carrying every window (`5h 41% (4h) · 7d 7% (5d)`), the time of
the reading and, on click, a refresh of that service alone. Full window names and exact reset timestamps are in
the status bar tooltip, which has room for a line per window; the saved-account list uses the same compact form.

All windows share one cache file in the extension's global storage, so only one window calls a source per check
interval and all windows respect the same backoff. Usage polling only reads tokens and never refreshes them. The
profile manager writes the native credential file only after an explicit activation. If a token has expired, the
item shows a warning and asks you to run the CLI once so it refreshes its own login.

### Per-chat token chip

Claude and Codex write provider-reported token counts into their local JSONL session logs. Every ten seconds the
extension selects the newest session belonging to the current workspace, totals Claude's de-duplicated message
usage or reads Codex's cumulative `token_count`, and publishes a compact label such as `400k tokens`. Clicking the
chip shows the exact input/output/cache breakdown. The chat toolbar API scopes `when` clauses to the displayed
agent but does not expose the active chat id to third-party extensions; with concurrent chats, the newest matching
session is therefore the best available association. Copilot's private per-chat telemetry cannot be read here.
