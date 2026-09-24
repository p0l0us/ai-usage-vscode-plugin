# Changelog

## 0.0.23 (2026-09-23)

- Smarter Claude rotation. `aiUsage.claude.autoRotate.strategy` picks the account to switch to from each account's
  stored readings: `soonestReset` (the new default) spends the account whose weekly window resets soonest first,
  but moves one that is spending its week too early to the back; `evenPace` keeps every account close to an even
  weekly spend; `leastWaste` prefers the most allowance left per hour until reset; `sequential` is the old saved
  order. `aiUsage.claude.autoRotate.trigger` chooses between switching only at the limit (default) and also
  switching proactively to a clearly better account, at most once per `autoRotate.minStayMinutes` (30).
- Separate rotation thresholds for the 5h window, the weekly window and, for Claude, the Fable weekly window
  (`autoRotate.fiveHourThresholdPercent`, `.weeklyThresholdPercent`, `.modelWeeklyThresholdPercent`). Empty keeps
  using `autoRotate.thresholdPercent`. `aiUsage.claude.autoRotate.modelLimits` decides whether `7d Fable` counts at
  all: `auto` counts it when Claude Code's configured model is Fable or no model is set.

## 0.0.22 (2026-09-23)

- Rename the extension to **AI subscription management and usage**, which is what it has grown into: the account
  switching, keep-alive and rotation are no longer a sideline to the usage figures. Only the Marketplace name and
  description change. The extension id, every `aiUsage.*` setting and command, and the short name used in
  notifications and the status bar all stay as they are, so updates keep flowing and no configuration needs editing.
- Tell you when a saved Claude or Codex login has been revoked. An account check that finds a revoked login now
  names the profile and its email once, and offers **Sign in again**: the vendor's own login (`codex login`,
  `claude auth login`) runs in a terminal inside the keep-alive home, never the native one, and the new login is
  saved to that profile (and made the native login too when it is the active profile). Until now a revoked login
  only showed up in the profile's usage detail, so rotation could quietly find nothing to switch to.
- Automatic rotation sends a keep-alive to the account it is about to switch to and only switches when that call
  succeeds. A usage reading alone does not prove a login still works. A candidate whose keep-alive fails is
  reported and skipped in favour of the next eligible account.
- New **Codex config** settings section that writes selected keys of Codex's `config.toml` from VS Code settings:
  `aiUsage.codexConfig.agents.maxConcurrentThreadsPerSession` (`[agents] max_concurrent_threads_per_session`),
  `.maxDepth` and `.jobMaxRuntimeSeconds`. Empty by default, which leaves the file alone; a set value is written on
  startup and on every change, touching only that one line, and new Codex chats pick it up.

## 0.0.20 (2026-09-22)

- Add a `cli` source for Claude (`aiUsage.claude.source`), which runs Claude Code's own `/usage` and reads the
  reading it caches. `/usage` is one of the commands Claude Code answers itself, so no model is called and nothing
  is billed, but answering it makes Claude Code fetch the usage endpoint and write the result to its account file.
  That is the one thing `accountFile` cannot do for itself: Claude Code drops that cached reading as soon as it
  stops matching the login, so a freshly activated profile had nothing local to read and the figure sat on the
  previous account's numbers until the endpoint was called again. The call reaches the same rate-limited endpoint
  as `api`, so it is spaced by `aiUsage.claude.checkIntervalMinutes` and the shared budget in exactly the same way,
  and it runs with no settings file, hook, MCP server or session record of your own. Set the command with
  `aiUsage.claude.cliPath`, which the account keep-alive already used.

## 0.0.19 (2026-09-22)

- Read Claude and Codex usage from a local file first and the service endpoint only when that reading goes stale:
  the new `both` source, now the default for both services. Claude's account file and Codex's session logs are
  re-read on every check and serve the reading while it is no older than that service's `checkIntervalMinutes`;
  once the CLI has been idle that long, or has never written a reading, the endpoint fills the gap, called no more
  often than the `api` source would call it. Usage follows an active CLI session within seconds — for Claude every
  `aiUsage.claude.accountFile.checkIntervalSeconds` (default 15) — without spending more of the service's rate
  limit, and a reading is never replaced by an older one.

- Stop stalling the local file sources behind the network backoff. A reading that Claude Code had not cached yet
  paused the whole source for a minute, doubling to thirty, although re-reading a local file costs nothing and the
  file usually gains its reading seconds later. `accountFile` and `both` now keep to their own check interval, and
  `both` spaces its service calls with a ledger of its own.

- Stop losing the Claude backend in the Copilot model picker when the bridge outlives its own directory. The CLI
  bridge was started in the extension folder, so an extension update or a moved checkout left the running server
  with a deleted working directory; Claude refuses to run from one and exited before reporting its version, which
  discovery reported as an incompatible CLI and which removed every Claude model from the picker. The bridge now
  starts outside the extension folder and never lets a CLI probe inherit its working directory.

## 0.0.18 (2026-09-19)

- Stop interrupting after a Codex account switch: the **Restart extensions** warning is now opt-in
  (`aiUsage.codex.switchRestartHint`, default off) instead of appearing in every window whose Codex process
  predates the switch. The switch notification still says that the Codex extension needs a restart, and the
  account proxy (`aiUsage.codex.proxy.enabled`) remains the way to make open chats follow a switch without one.

## 0.0.17 (2026-09-18)

- Keep Claude's own account identity in step with a profile switch. Claude Code renders `/status` and `/usage` from
  `~/.claude.json`, not from its credential file, so activating a Claude profile now writes that token's account
  UUID, email and organization there and drops the account-bound usage/model caches. Switching between members of
  one Team no longer leaves Claude reporting the account you switched away from.
- Never leave the previous account on display when Anthropic's profile endpoint cannot be reached (it rate-limits
  per account): the switch still happens, the stale identity is replaced by what the saved profile holds, the
  notification says the login could not be confirmed and why, and AI Usage retries in the background until Claude's
  own status agrees with the switch.
- Report the reason a login could not be confirmed — an HTTP status, a timeout or an unreachable endpoint — in the
  notification and the log, instead of reporting a clean switch.
- Drop the Claude restart hint: Claude Code re-reads its credential file per turn, so open Claude chats and CLI
  sessions adopt a switched login from their next turn without an extension or window restart (verified against
  Claude Code 2.1.276). Codex still needs its hint, or the account proxy.
- Fix the Codex restart hint firing when nothing was switched: saving the current login into a profile, or
  re-selecting the account that is already active, no longer counts as a switch and no longer flags Codex processes
  that hold the right login.
- Add an experimental, opt-in **Codex account proxy** (`aiUsage.codex.proxy.enabled`, `aiUsage.codex.proxy.port`):
  a loopback HTTP server that the Codex VS Code extension and CLI reach through a `model_providers.ai-usage` entry
  AI Usage manages in Codex's `config.toml`. It attaches the login from `auth.json` to every request, so switching
  the Codex authentication profile reaches open Codex chats on their next turn with no extension or window restart;
  the **Restart extensions** hint remains the fallback while the proxy is off. Turning the setting off restores
  `config.toml`.
- Pin `model_provider = "openai"` for AI Usage's own Codex usage checks and switch verification, so they keep
  reporting the login while the proxy provider is selected.

## 0.0.16 (2026-09-17)

- Mark every **Copilot CLI bridge** setting as experimental: the section is titled *(experimental)* and each
  `aiUsage.bridge.*` setting carries VS Code's **Experimental** tag in the Settings editor.
- Show one linked notice per native subagent in Copilot, with an in-chat agent map, status,
  reported results, and saved branch navigation. Codex child links target the exact child thread;
  Claude details explain parent-session resumption. Keep presentation controls out of native history.
- Support native Claude/Codex subagents through the external tool relay, track child status and saved
  session forks, and add a Copilot analysis-fork tool. Add per-backend request/tool lifetimes (60 minutes
  by default, up to 24 hours), remove shorter client/MCP deadlines, and retain 1000 saved link targets.
- Keep one saved native CLI session per Copilot chat across follow-up turns, images, conversation
  compaction, and bridge restarts. Show the session controls once, and release the native worker
  between completed turns so the CLI and extension links remain usable.
- Fix Claude exact-session chat links opening an empty chat: saved Copilot sessions now use their own
  origin instead of `sdk-cli`, which Claude's chat UI excludes. Retain the last 100 saved session link
  targets across bridge restarts without storing prompts, answers, or credentials.
- Show CLI resume commands and exact-session chat links above the answer when a native session starts,
  without HTML markers or duplicate controls during tool continuations. Route clicks to the originating
  host and prefer the native chat sidebar; Claude uses its session command instead of its editor-only URL.
- Default saved bridge sessions to the current single workspace folder so Claude extension links can
  resume them there; explicit session directories still take precedence.
- Show Copilot bridge feature switches in User settings in remote windows; retain machine-specific
  paths and connection settings in the Remote tab.
- Group CLI bridge settings in a separate **Copilot CLI bridge** settings section, including separate Claude and
  Codex controls for persistent sessions, Open in CLI, and VS Code extension/plugin links.
- Replace fixed Claude aliases with native CLI catalog discovery, include hidden/paginated Codex entries,
  preserve model display names and resolved IDs, and accept advertised effort and extended-context selectors.
- Fix incomplete Copilot model lists by collecting both CLI backend catalogs before updating the picker,
  while keeping the healthy backend available when the other fails discovery.
- Register signed-in Claude and Codex CLI models directly in Copilot, bundle and automatically start the
  local bridge, and support native provider streaming, images, and external tool continuations.
- Add Copilot integration diagnostics, a live CLI session inspector, read-only session tools, and the
  optional `@aiusage` status participant.
- Share and cache model discovery independently per backend, validate reasoning capabilities, and
  retain isolated native workers across explicitly correlated user turns with bounded lifecycle diagnostics.
- Add separate Codex and Claude bridge settings for native session persistence, workspace directories,
  CLI opening, and VS Code extension links, with opening actions for saved sessions in the session inspector.
- Support embedded image attachments in both CLI BYOK backends, including conversation history and tool
  continuations, with input validation, image capability discovery, and offline/live vision checks.
- Add a separate Node.js CLI BYOK bridge with a loopback Chat Completions API, subscription-backed Codex and
  experimental Claude CLI adapters, external tool-call continuations, and offline/live integration checks.

## 0.0.15 (2026-09-17)

- Show the login email beside every saved Claude and Codex profile so the same account saved twice is easy to spot.
  Codex reads it from the saved id token; Claude asks the OAuth profile endpoint and records it when a login is saved,
  replaced or refreshed, backfilling older profiles when the menu opens.
- Recognise a refreshed Claude login by its organization instead of its refresh token. Claude Code rotates the refresh
  token on every refresh, which left saved Claude profiles with dead tokens and made their keep-alives fail.
- Verify a Codex profile switch by asking a fresh `codex app-server` which account it sees, and show an error instead
  of the success message when it differs. Open Codex chats pick a switched login up on their next turn.
- Warn once per switch, in each window whose Codex `app-server` predates the switch, with a **Restart extensions**
  action; the process is never killed and nothing restarts automatically.
- Keep-alive failures now include the CLI's own error text, such as a usage limit or an unsupported model, instead of
  only the exit code.
- Show each window's reset countdown (e.g. `5h: 59% (3h)`) beside its usage percentage in the saved-account picker,
  matching the status bar and tooltip.
- Replace the per-window rows in the details panel with one row per service that carries every window and its
  countdown, and refreshes that service when clicked. Full window names and exact reset times moved into the
  status bar tooltip.
- Space every call to Anthropic's usage endpoint with one ledger shared by all windows, all saved accounts and
  manual refreshes (`aiUsage.claude.api.minIntervalSeconds`, default 30 s), tightening automatically when a
  response advertises a stricter limit. A refresh that arrives too early shows the cached reading and says when
  the next call is due.
- Move **Account keep-alive and usage collection** and **Automatic account rotation** out of the Accounts menu into
  the ordinary settings `aiUsage.<service>.keepAlive.enabled` and `aiUsage.<service>.autoRotate.enabled`, so they
  sync and can be set per profile or by policy. Existing menu choices are carried over once; the menu now shows
  their state and links to Settings.

## 0.0.13 (2026-09-16)

- Let **Save current login** replace an existing profile, making expired or reauthenticated accounts easy to update without deleting and recreating them.
- Preserve the last valid Claude OAuth credential when the CLI clears its isolated temporary credential file, so a successful keep-alive can still refresh usage statistics.

## 0.0.12 (2026-09-16)

- Show each service's editable keep-alive model beside its interval in User settings, defaulting to Claude Haiku and Codex Luna.
- Add a per-service **Send keep-alive now** account action that targets a selected saved account and refreshes its statistics.
- Show a VS Code notification naming the service and destination account after automatic rotation.
- Add isolated Claude and Codex keep-alive checks for every saved account, including inactive-account usage
  collection and refreshed-token preservation.
- Add per-service automatic account rotation with configurable thresholds, checking every reported rate-limit
  window and keeping the active account when no candidate is eligible.
- Move account feature switches into the Accounts menu and expose periods, thresholds, models, CLI paths, and
  dedicated homes as per-service settings. Copilot is excluded from account automation.

## 0.0.11 (2026-09-16)

- Compact status-bar percentages now show the live time until reset in one largest unit (`42m`, `3h`, or `4d`)
  instead of the fixed quota-window duration.
- Add an optional per-chat token chip for the latest local Claude or Codex session, with exact input, output, and
  cached-input counts available on click.
- Expand and reorganize the documentation with authentication profiles, usage details, status-bar states, and
  anonymized examples placed alongside their feature descriptions.

## 0.0.10 (2026-09-15)

- Add named Claude and Codex authentication profiles (up to 20 per service), backed by VS Code SecretStorage and
  switchable from a quick-pick menu. Activation securely updates the provider-native credential file, preserves
  Claude MCP credentials, isolates cached usage by selected profile, and works in local Windows/macOS/Linux and
  remote SSH/WSL/container extension hosts.

## 0.0.9 (2026-09-15)

- Maintenance update.

## 0.0.8 (2026-09-11)

- The details quick pick is back: status bar items and chat chips open it again (chips focused on their agent,
  with a "Show all providers" action), replacing the modal dialog from 0.0.4.

## 0.0.7 (2026-09-11)

- 

## 0.0.6 (2026-09-11)

- 

## 0.0.5 (2026-09-11)

- 

## 0.0.4 (2026-09-11)

- Chat chips are text only, `Claude 4% (5h)` `26% (7d)` by default, `Claude n/a` when the agent is not signed in
  where the extension runs. New settings `aiUsage.chatChips.labels` (`none` / `name`) and `aiUsage.chatChips.usage`
  (`simple`, one figure for the most used window / `rich`, every window). The icon chip is gone: VS Code drops the
  text of a toolbar item that has an icon. `aiUsage.chatChips.icon` was removed.
- Status bar: `aiUsage.statusBar.labels` gained `none` and `nameOnly`; new `aiUsage.statusBar.usage` (`simple` /
  `rich`) chooses between the most used window and every window.

## 0.0.1 (unreleased)

- Status bar items with live usage for Claude Code, Codex and GitHub Copilot.
- Chat input chips for the agent the current chat is locked to (VS Code 1.137+).
- Structured details panel with per-service windows, account/organization and reset times.
- Copilot account selection following the workspace repository's organization; org billing figures for admins.
- Selectable sources per service (`api`, `cli`, `sessionLog` for Codex) and per-service check intervals.
- `aiUsage.statusBar.enabled` / `aiUsage.statusBar.labels` (icon only by default) for the status bar.
- `aiUsage.chatChips.icon` vendor-icon chip and `aiUsage.chatChips.workbench` to show chips in regular windows only when no status bar shows the figures.
- Shared on-disk cache across windows with `Retry-After` aware backoff; stale readings greyed out after 15 minutes.
- `n/a` chip for the chat's own agent when it is not signed in where the extension runs (typically a Claude or Codex chat in the Agents window, whose local extension cannot see a remote login); the details say where to sign in.
- README screenshots are bundled in the VSIX; `dev:install` keeps the image links relative so a local install renders them.
