# How it works

## How live usage is read

`service/src/usageMonitor.ts` owns these reads in the shared runtime. Background and editor-owned deployments
use the authenticated socket contract. `src/usageClient.ts` only decodes returned values and renders rotation
diagnostics. See [SERVICE_ARCHITECTURE.md](SERVICE_ARCHITECTURE.md) for configuration authority and deployment modes.

- **Claude Code**: reads the OAuth token from `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`) and calls
  Anthropic's `/api/oauth/usage` endpoint, the same data shown by `/usage` inside Claude Code. The `accountFile`
  source instead reads `cachedUsageUtilization` from `~/.claude.json`, the reading Claude Code itself last fetched
  from that endpoint. The `cli` source runs `claude --print /usage` and then reads that same key: `/usage` is one of
  the commands Claude Code answers itself, so no model is called and nothing is billed, but answering it makes
  Claude Code fetch the endpoint and write the result — which is what `accountFile` cannot do for itself. Claude
  Code rewrites that key at most once a minute and clears it whenever the cached account stops matching the login,
  so after an account switch `accountFile` has nothing to read until something asks for usage and `cli` does.
- **Codex**: the `cli` source runs `codex app-server` over stdio and calls `account/rateLimits/read`, the same data
  shown by `/status` inside Codex. The `api` source calls the ChatGPT usage endpoint with the token in
  `~/.codex/auth.json`; the `sessionLog` source reads the newest `rate_limits` record from `~/.codex/sessions`.
- **`both`** (the default for Claude and Codex): the local file is read on every check — Claude's account file,
  Codex's session logs — and serves the reading while it is no older than that service's `checkIntervalMinutes`.
  Once it falls behind, because the CLI has been idle or has never written a reading, the service endpoint fills
  the gap. Those fallback calls are spaced by `checkIntervalMinutes` in a ledger of their own
  (`claude-fallback-budget.json`, `codex-fallback-budget.json`) and, for Claude, also pass the shared endpoint
  budget below, so the endpoint is never called more often than the `api` source would. While a CLI session is
  active, usage follows it within seconds and costs no calls at all; a reading is never replaced by an older one.
- **Copilot**: VS Code forwards its existing GitHub sign-in and workspace owners over authenticated IPC. The
  service calls the Copilot quota endpoint. Tokens are held only for that connection; standalone service usage can
  use GH_TOKEN/GITHUB_TOKEN from its process environment. Unlimited quotas are not shown.

## Multiple windows and rate limits

All clients read the service's `state/live-usage.json` cache through `config.read` includes the configuration revision and per-key revisions; `config.patch` accepts a `baseRevision`
and rejects keys changed after it. Legacy `config.set` remains an explicit unconditional write. Presentation fields
remain catalog-compatible but do not hydrate editor UI. `workspace.context` stores folders, GitHub context and
per-provider session directories for the connection. Bridge requests carry signed request-scoped workspace context;
the bridge validates it before deriving its working directory. On shutdown, the host stops admission and drains
admitted work, then the managed bridge closes admission, cancels and drains native sessions, and exits before the
host releases the runtime lease. A persistent managed-child record lets a successor verify the old child is gone;
unknown child state fails closed. The host keeps its lease if disposal cannot confirm cleanup, so another engine
cannot start alongside an uncertain child.

`usage.live`. A five-second service timer
checks source deadlines; it does not make a provider call on every tick. Source, polling policy and an opaque
native-credential fingerprint identify cache entries, including unsaved logins. In-flight requests are shared;
results are discarded after an account or source change. Provider backoff and the Claude endpoint budget remain
shared across clients. Native reads and saved-account checks hold the same per-provider account lock so they
cannot concurrently refresh a login. Independent manual operations serialize; nested sweep checks reuse their
parent lock through AsyncLocalStorage.

Sources that read a local file (`accountFile`, and `both`) are exempt from that backoff: there is no rate limit to
respect, and a shared backoff would also stall the free local read. They keep to their own check interval, and
`both` spaces its service calls with its fallback ledger instead.

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

## The account service

Everything about saved accounts runs in `service/`, a Node package without `vscode` imports that the extension
bundles and installs under `~/.ai-usage/service/<version>` (`service/src/installer.ts`; `current.json` and
`launch.js` point the autostart and the `ai-usage` launcher at the current version). `daemon.ts` and the editor delegate to `engineHost.ts`, which acquires `runtimeLease.ts` ownership before
constructing one `AccountService` (`accountService.ts`) per home, with the profile store, the automation, activation verification
and the Claude metadata retry that `src/extension.ts` used to hold, and serves it over newline-delimited JSON on
a Unix socket or Windows named pipe (`rpc.ts`; a home whose path is too long for a socket gets one in
`XDG_RUNTIME_DIR` or the temp directory). Every client sends `hello` with the token from `service.token` first and negotiates the wire version and
required capabilities;
requests are `{ id, method, params, deadlineAt? }`, answers `{ id, result | error }`, and subscribed clients receive
`{ event, … }` messages: `activated`, `accountProblem`, `noCandidate`, `notice`, `stateChanged`,
`usageChanged`, `configChanged` and `log`. `client.ts` is the typed client both `cli.ts` and the extension use; `protocol.ts`
the wire types. The service ticks every minute: it follows a native login switched outside it, runs the
automation, retries the Claude identity sync and reloads a hand-edited `config.json`.

The extension's `src/serviceManager.ts` installs, upgrades, starts and connects, and turns service events into UI
updates. `src/accountsMenu.ts` forwards account actions. Both service deployment modes use profiles.json; legacy
VS Code credentials migrate on connection when there is no conflict. `src/configSync.ts` reads authoritative engine
settings on connection and sends explicit edits with revision checks; service config events update the editor.
Presentation and connection preferences stay local. Every manifest key
is represented in the generated `service/src/settingsCatalog.ts`, including nullable native settings and UI options.
The CLI and service validate them through the same config module.

`usage.live` returns active native-login readings, `usage.sessionTokens` reads session counts using the requesting
client's folders, and `rotation.diagnostics` returns the exact scoring implementation's weights and explanation.
Clients cannot inject authoritative readings through the old `usage.observe`/`usage.hintLimit` methods. Profile
probes and the internal collector update automation directly. `usageChanged` prompts clients to request the new
state. Copilot contexts remain in memory per connected client and are forgotten on disconnect.

Project profiles live in the profile file of a project folder (`projectProfiles.file`, the format of a profile
export). Each client declares its folders in its `hello` and with `session.folders` (the extension sends its local
workspace folders and follows changes; `ai-usage` sends `--project` or the current directory when it holds a
profile file); the service keeps the union of connected clients' project folders, and `ProfileStore` reads each
folder's file (cached by mtime) into the shared list, marking project profiles with their `folder`.
This shared profile visibility is separate from per-connection session and bridge workspace context. Writes go back to
the folder's file, and the first write into a Git repository adds the path to its `.gitignore` and emits a
`notice` event. `profiles.saveNative` and `profiles.importCredential` take a `folder` for a new project
profile; the import of an export always makes private profiles.

Checks requested by hand go through `AccountAutomation.withAccountLock`, which queues them under the lock of a
running sweep or waits for it (`waitMs`, 3 minutes by default) and announces the wait as a `waiting` event
with the request's `token`; `automation.cancel` with that token aborts the wait or the sweep.
`automation.keepAliveAll` runs a whole-list keep-alive as one sweep under one lock, spaced by 3 seconds, and
reports each account as a `keepAliveProgress` event, so the extension's and the command line's progress come
from the service rather than from a client-side loop.

`service/src/mcp.ts` is the MCP server behind `ai-usage mcp` (experimental): JSON-RPC 2.0 over stdio, one message
per line, written without an SDK, with `list_accounts`, `refresh_usage` (`usage.read` for a saved profile or `usage.live` for the native login, without
the keep-alive prompt), `switch_account` and `rotate_account` as thin tools over the service client. The `mcp`
block of `config.json` (`mcp.enabled`, `mcp.switching`; `GLOBAL_SETTINGS` in `configStore.ts`, synced to
`aiUsage.mcp.*` like the provider settings) is read on every tool call, so a switch takes effect for a running
server. `src/mcpProvider.ts` registers a `McpServerDefinitionProvider` that offers a bundled or installed command
to the agents of the VS Code window while the setting is on. It works without background installation.
`src/mcpRegistration.ts` re-exports service registration helpers, which select an installed launcher or bundled
command with explicit home and runtime environment for the Accounts menu registration item,
through their own `mcp add` and `mcp remove` (an existing entry is removed first, since Claude Code refuses a
duplicate), and reads the CLI's current entry from `.claude.json` or Codex's `config.toml` for the item's description.

## Authentication profile storage and switching

`service/src/profileStore.ts` keeps profile names, timestamps, stable account ids, emails, logins and the active
id in `~/.ai-usage/profiles.json`, written atomically with mode 0600, with a hard limit of 20 per provider.
`service/src/authFiles.ts` validates native/imported JSON and performs the filesystem update. Claude profiles contain the
`claudeAiOauth` object plus its root-level `organizationUuid` when present; activation replaces those account fields
in the current `.credentials.json` while preserving MCP OAuth entries. Codex profiles contain the complete
`auth.json` document.

Before activation, a refreshed native credential is copied back to the selected secret only when it can be matched
to the same owner: Codex `account_id`, an identical refresh token, or for a rotated Claude token the account UUID
returned by `/api/oauth/profile`. Claude's root `organizationUuid` is deliberately insufficient because every Team
member shares it. Writes go through a newly created
mode-`0600` temporary file in the destination directory and an atomic rename; the resulting file is explicitly
chmodded to `0600` on POSIX. Windows uses the destination directory's inherited user-profile ACL because its chmod
implementation does not support POSIX ownership modes.

Claude Code keeps display identity and account caches in `~/.claude.json`, separately from its OAuth credential.
After activating a Claude token, `service/src/accountIdentity.ts` resolves that token through `/api/oauth/profile`, replaces
only `oauthAccount`, and removes known account-bound usage/model caches while preserving all unrelated settings.

That lookup can fail — most often because the endpoint is rate-limiting the account — and the previous account's
identity must not survive it, or Claude keeps reporting the login the user just switched away from. When the profile
cannot be fetched, the identity the saved profile is known to hold replaces `oauthAccount` (without
`profileFetchedAt`, so Claude Code refreshes the rest itself), the account-bound caches are still dropped, and the
switch is reported to the user as unconfirmed with the reason. The service then retries on its minute tick,
re-reading the native credential each time so a token refreshed in the meantime is used, backing off to at least any
`Retry-After` and giving up after ten attempts.

Claude Code re-reads `.credentials.json` on its request path, so a switch reaches chats and CLI sessions that were
already running, from their next turn: verified 2026-09-18 against 2.1.276, where a chat process started 13s before
a switch recorded the newly activated account 15s after it. Claude therefore has no stale-process warning; only
Codex, whose app-server fails the turn instead, offers an extension-host restart. Only an actual account change
stamps the switch record that warning measures processes against: re-selecting the active login or saving the
current login into a profile reports `accountChanged: false`, because neither starts anything on a new account and
re-stamping would flag every running process, including ones started after the switch.

Codex does not adopt a switched login in a running process: its auth manager re-reads `auth.json` before a turn but,
when the file now holds another account, fails the turn with "signed in to another account" instead of using it
(verified 2026-09-17 against 0.154.0 with `thread/start` + `turn/start`; `getAuthStatus`, `account/read` and
`account/rateLimits/read` keep answering from memory). Processes started after the write use the new login, and no
thread, rollout or sqlite row is bound to an account, so chats resume under the new login after an extension host
restart. After writing the file for a Codex
profile, `ProfileStore.activateProfile()` calls the verifier the service set
(`verifyCodexNativeAccount` in `service/src/live.ts`), which runs a fresh `codex app-server` on the native home and compares
the `chatgpt_account_id` claim of the token returned by `getAuthStatus { includeToken: true, refreshToken: false }`
with the stored `tokens.account_id`; `account/read` (email, plan type, `apiKey`) is the fallback because its
answer carries no account id. API-key-only profiles are matched by auth method alone. A mismatch replaces the
success notification with an error and leaves the file in place. Stale Codex processes are detected by start
time only: `afterProfileActivated` records `{ switchedAt, profileName }` in `globalState`
(`aiUsage.codexSwitch.v1`), and every window's one-minute tick lists this extension host's children
(`src/codexProcesses.ts`: `ps -eo pid=,ppid=,etime=,args=` on POSIX, `Win32_Process` on Windows), excluding
AI Usage's own servers by their `cli_auth_credentials_store` argument. A `codex … app-server` older than the switch
triggers one warning per switch per window (`workspaceState` key `aiUsage.codexSwitchNotified.v1`) whose only
action is `workbench.action.restartExtensionHost`; processes are never killed and no turn is ever injected. The
warning is opt-in: `aiUsage.codex.switchRestartHint` (default off) enables it, and the process listing is skipped
entirely while it is off. Duplicate profiles of one login are detected by the stored email: refreshing two copies
independently reuses a rotated refresh token and the provider revokes the login, so saving or importing a credential
whose email is already saved asks for confirmation.

`service/src/codexProxy.ts`, `service/src/codexConfig.ts` and `service/src/codexProxyRuntime.ts` implement the opt-in Codex account proxy
(`aiUsage.codex.proxy.*`). Codex loads `config.toml` on every `thread/start`, and a custom `model_providers.<id>`
entry may carry any `base_url`, `requires_openai_auth = false` and static `http_headers`; the Codex extension's
webview sends `modelProvider: null` unless the Copilot language-model proxy is in use, so the file's
`model_provider` decides. `codexConfig.ts` edits the file line by line: a root-level
`model_provider = "ai-usage" # managed by ai-usage` line (the user's own line is recorded as JSON inside the block
and restored on removal) and a `[model_providers.ai-usage]` table between two marker comments, written through the
same atomic mode-0600 path as `auth.json`; an emptied file is deleted. `codexProxy.ts` is a Node `http` server on
`127.0.0.1` that answers `GET /ai-usage/health` (service name, pid, version) and forwards `/v1/*` after checking
that `Host` is loopback and `Authorization` equals the token from the block. Per request it parses `auth.json` the
way Codex does (ChatGPT tokens unless `auth_mode = "apikey"`), drops hop-by-hop headers and the placeholder
`Authorization`, adds `Authorization: Bearer <access token>`, `chatgpt-account-id` and `version` (derived from the
user agent; Codex sends it to its own backend but not to custom providers) for ChatGPT logins or
`Authorization: Bearer <API key>` for API keys, and streams the response back with its `x-codex-*` rate-limit
headers, which the app-server turns into `account/rateLimits/updated`. Codex talks WebSocket to its own backend but
plain HTTP to custom providers, so upgrades are refused; the HTTP form of `/backend-api/codex/responses` accepts
the custom-provider request (verified live: 429 with rate-limit headers on an exhausted workspace). An upstream 401 for
a ChatGPT login runs `refreshCodexNativeLogin` (`getAuthStatus { refreshToken: true }` on a fresh app-server, so
Codex rotates the refresh token itself) once, shared by concurrent requests, then retries with the token now in the
file. `codexProxyRuntime.ts` binds the configured port on service startup and configuration changes. A user-wide
lease in `proxyLease.ts` is independent of the port and service home: Linux uses an abstract Unix socket, Windows a
named pipe, and other platforms an exclusive PID lock. Only the owner rewrites/removes the native configuration.
A matching health endpoint identifies a shared proxy; an unrelated listener is an error. Port changes close the
old listener and preserve the bearer token in the service's mode-0600 token file. The background proxy survives
editor shutdown. `runtime.ts` also writes native CLI settings and owns the bridge process; the standalone service
package bundles the same bridge sources as the extension build. Every AI Usage `codex app-server` probe passes `-c model_provider="openai"`, because a server on the proxy
provider reports no login and no rate limits. `AuthProfileManager.codexChatsFollowSwitch` and the stale-process
warning consult the runtime so the switch message and the restart offer match the mode.

## Usage history

`service/src/usageHistory.ts` appends one JSON object per line to `usage-history/history-YYYY-MM.jsonl` under the
service home (or `history.directory`), with mode `0600`, and prunes month files older than the retention once a day.
`AccountAutomation` records readings from the service live collector (historical source label `status`) and from every account check, a check
that starts or stops failing, and in `rotate` the candidates with their outcomes, the switch, the sweeps that spent
calls without switching, the exhausted stretch and its recovery; `AccountService` records switches by hand
(`profiles.activate`) and switches followed from outside the service (`followNative`). `index.json` in the same
directory remembers the last recorded reading per account (its figures and time) and the last switch per provider,
so an unchanged reading is written once an hour at most. `service/src/usageHistoryReport.ts` turns the events into
the summary document (per-account cycles keyed by window label and reset, time active from the switch timeline,
exhausted episodes from `exhausted`/`recovered` pairs, the accounts-needed estimate) and `readingsCsv`/`eventsCsv`
into the exports; `history.info`, `history.summary` and `history.export` serve them to the extension's history menu
and to `ai-usage history`. Both modules are plain Node and tested directly.

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
