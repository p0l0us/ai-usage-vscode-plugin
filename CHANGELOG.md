# Changelog

## 1.0.20 (unreleased)

- Open CLI now keeps the terminal shell open when a saved account's Codex or Claude process exits, so authentication errors remain visible and the account can be signed in again. Concurrent imports cannot save duplicate credentials, and embedded service shutdown never signals the VS Code host process.
- The socket client checks every service command against the shared TypeScript contract. Both extension and service publishing run the full parity suite before packaging.

- Claude and Codex account menus offer **Open CLI…**: choose an account to launch its CLI in a VS Code terminal using its persistent home. Each menu now has a single **Settings…** entry.

- Codex account menus show earned resets once after usage figures as a refresh icon, available/observed total, and countdown to the next credit expiry (for example, `2/3 (10d)`). Zero, stale and unknown reports remain distinguishable, and open menus update counts from service events.

- Each saved Claude and Codex account now uses a persistent numbered CLI home with its own login and settings. Homes survive service restarts and profile reordering; CLI token refreshes are synchronized before checks and activation.

- The service refreshes saved-account usage at startup and periodically, even with keep-alive and rotation off. Checks publish updates to open account pickers, and reloaded windows reuse service readings.
- Manual service stops are respected by editor reconnects and CLI reads until an explicit Start or Restart.

- Claude and Codex rotation default to `leastWaste`, `proactive` and a 15-minute minimum stay in the extension and standalone service; saved settings take precedence.
- Provider settings shortcuts filter by setting ID so Codex searches do not include related Claude settings.

- MCP now supports cached status resources, usage-change subscriptions and a cancellable wait tool, including per-account usage and Codex earned-reset counts with explicit freshness. Status observation does not trigger provider calls.
- MCP agent guidance exposes live rotation settings, permits occasional account switches and asks agents to obtain user approval to disable competing automatic rotation before sustained agent-controlled selection.
- Claude rotation prefers accounts with model-specific quota, then allows accounts with general quota when no model-capable account qualifies. General limits still block exhausted accounts, and the current usable account is retained to avoid pointless switching.
- Codex's status bar shows the current account's available earned resets by default. Turn off `aiUsage.codex.statusBar.earnedResets` to hide the count; changing this local display setting does not check or redeem resets.
- Claude and Codex now default to `auto` sources: fresh cache, local usage file, direct API, then CLI, stopping at
  the first usable reading. New configurations check every 30 minutes; existing modes and intervals remain unchanged.
- Optional `codex.autoReset.confirmationRequired` requires one connected editor to approve an earned reset before
  the engine revalidates and redeems it. Off by default; with confirmation on and no approval, no credit is spent.

- Usage percentages in the status bar, tooltips and account menus round to whole numbers without changing the underlying readings.
- **Back** in a Claude or Codex Accounts menu and in the Account service menu returns to the previous menu again
  instead of closing everything: the previous menu now opens over the one you leave. Closing it first returned focus
  to the chat or editor, and that focus closed the reopened menu.
- The settings sync to the service no longer fails on connect with "refreshIntervalMinutes must be at least 1": a
  setting without a default that nobody set is not sent, so the service gets the rest of the settings again.
- An account whose last reading is older than its usage reset says when it was last checked instead of "Usage not
  checked yet".
- The service now owns live Claude/Codex/Copilot usage, source fallback, cache and backoff, native CLI settings,
  credential updates, the Codex proxy and CLI bridge. The extension displays service values and forwards settings;
  it does not fall back to provider reads after a service disconnect. Native logins work without saved profiles.
- Engine settings use a generated shared schema and revision-checked updates through `ai-usage config` and VS Code.
  Editors read persisted configuration on connection; presentation settings stay local. Standalone configuration needs no VS Code.
- Background and editor-owned deployments share one runtime ownership lease and authenticated socket contract.
  Linux uses an abstract socket, Windows a named pipe, and other platforms a deterministic loopback TCP port based
  on the OS user and canonical service home; a collision fails closed without trying another port. Editor-owned
  mode uses service-owned profile storage; nonconflicting legacy VS Code credentials migrate on connection.
- Advanced Claude/Codex rotation diagnostics show every saved account's score, order, exclusions and current-account
  explanation in the status tooltip. `ai-usage rotation-weights` exposes the same diagnostics; `ai-usage usage` reads
  current native-login quota. All four rotation strategies reuse the existing scoring implementation.
- Proxy ownership is independent of the selected port: a second service instance cannot open another proxy for the
  same OS user on a different port. Linux/Windows ownership is released by the OS after a crash. Ports are validated
  as integers; conflicts are reported, and only the owner changes native routing.
- Native status reads and account checks share credential locks; independent manual operations serialize while
  nested sweep checks reuse their parent lock. New tests cover polling, account/source changes, backoff, rotation,
  both deployment modes, settings parity, credential migration and proxy lifetime across processes.
- MCP works from the bundled extension without background installation and exposes native-login usage, including
  unsaved accounts, with explicit freshness, unknown state and model-scoped limits. Account switching does not change
  the selected model. Workspace context is scoped to the requesting connection; bridge restarts wait for child exit.
- The root test command includes extension, service and bridge suites with temporary account homes and mocked
  provider requests, covering both socket deployments and runtime ownership/configuration races. Its Node test
  descendants deny external HTTP/HTTPS and `fetch` requests while allowing loopback fixtures.
- Documented service ownership and the optional Docker deployment proposal, including host mounts, transport,
  authentication, singleton coordination and platform limitations.


## 1.0.6 (2026-10-08)

- Earned Codex rate-limit resets can now be redeemed automatically (on by default) for a limited saved account.
  The service checks Codex's available-credit count, natural reset times, other accounts and credit expiry before
  spending a credit, and retries ambiguous outcomes with the same idempotency key. Available resets appear in the
  Codex status tooltip and profile rows, with an observed `x of y` count when more than one was seen.
- Codex account rotation now offers the same four strategies and proactive trigger as Claude. Reset-aware timing is
  on by default: automatic sweeps wait when the active quota is about to recover and skip candidate accounts whose
  quota renews within five minutes, then reconsider them after the reset. Manual rotation bypasses the wait.
- The Account service menu ends with **Back**, to the AI Usage menu or to the Accounts menu it was opened from.
- **Account service…** moved from the Claude and Codex Accounts menus to the AI Usage menu of all services, since one
  service serves both; its line says where the service runs (background or inside a VS Code window) and its version.
- **Accounts without a background service.** Declining the background service, or turning
  `aiUsage.accountService.background` off, no longer leaves the Accounts menus empty: the same account service runs
  inside VS Code while a window is open (the first window hosts it, the others use it, another takes over when that
  window closes) with the profiles saved in VS Code, exactly as before the service, plus project profiles; keep-alives
  and rotation work while a window is open and nothing runs after VS Code closes. **Don't ask again** on the install
  offer now chooses this instead of turning accounts off.
- **Profiles move only when you ask, in both directions.** The background service keeps its profiles in
  `~/.ai-usage/profiles.json`, VS Code keeps its own; installing the service no longer moves them automatically.
  **AI Usage: Account Service…** transfers chosen profiles from VS Code to the service or back, as a move or a copy,
  and AI Usage offers it once per session when the profiles in use are empty but the other side has some.
- The Accounts row of the AI Usage menu says how many profiles are saved when none is active ("5 saved · current
  login not saved") instead of "None saved".
- **The service works without VS Code.** It is ready to be published as the npm package `ai-usage-service`:
  `npm install -g ai-usage-service`, then `ai-usage service install` or `ai-usage service run`. Its profiles are in
  `~/.ai-usage`, shared by the command, the background service and the extension.
- **Account service.** Saved Claude and Codex profiles, keep-alives and automatic rotation moved out of the extension
  host into a background service, so they keep running while VS Code is closed. The extension installs the service
  under `~/.ai-usage` with your permission (one notification with **Install**, **Not now** and **Don't ask again**;
  `aiUsage.accountService.enabled` is the switch), registers it to start when you sign in (a systemd user unit on
  Linux, a launchd agent on macOS, a Run registry value on Windows) and upgrades it when the extension is updated. The Accounts menus, the status bar
  account number and every notification work as before, now through the service, and every window connected to the
  same host shares its profiles. **AI Usage: Account Service…** shows its status and log and starts, stops,
  reinstalls or uninstalls it. Without the service the Accounts menus offer to install it and nothing rotates.
- **`ai-usage` command.** Everything the Accounts menus can do, from a terminal: `status`, `list`, `use`,
  `save`, `import`, `rename`, `delete`, `login`, `keepalive`, `rotate`, `export`, `import-profiles`,
  `config`, `service …` and `log`, with `--json` where it applies. `ai-usage top` (or `ai-usage` alone in a
  terminal) is a small live view: arrows select, Enter switches, `k`/`K` send keep-alives, `r` runs a sweep, `e`
  and `o` toggle keep-alive and rotation. VS Code terminals have the command on their PATH once the service is
  installed; elsewhere add `~/.ai-usage/bin`. A setting changed with `ai-usage config` shows up in VS Code's
  settings, and a change in Settings reaches the service; the service's `config.json` is the source of truth.
- Private profiles now live with the host the extension runs on (the remote in a Remote-SSH, WSL or container
  window), in `~/.ai-usage/profiles.json` (mode 0600), no longer with the VS Code client. Project profiles
  (0.0.34) work through the service too: every connected window declares its open folders, and `ai-usage` lists a
  folder's profiles with `--project[=<dir>]`, or by itself when the current directory holds a profile file;
  `save` and `import` take `--project` to keep the new profile there. The switches are the service's
  `privateProfiles.enabled`, `projectProfiles.enabled` and `projectProfiles.file`, mirrored from the settings
  of the same names. Export and import are unchanged.
- The pending-sign-in hold (0.0.34), the lock waiting of keep-alives sent by hand (0.0.36) and the rotation changes
  of 0.0.34 and 0.0.36 run in the service. **All accounts** and `ai-usage keepalive --all` run as one sweep in the
  service, under one lock; the progress notification says when it waits for a running check and can cancel the
  sweep. `ai-usage rotate` waits for a running check the same way.
- **MCP server for AI agents (experimental, off by default).** `ai-usage mcp` serves the saved profiles to an AI
  agent over the Model Context Protocol on stdin/stdout: `list_accounts` lists every Claude Code and Codex profile
  with its usage windows, reset times, check time, limit state and login problems; `refresh_usage` reads one
  profile from the vendor now without a keep-alive prompt; `switch_account` activates a profile by name, number,
  id or email; `rotate_account` runs a rotation sweep. `aiUsage.mcp.enabled` (`mcp.enabled` for `ai-usage config`)
  turns it on; `aiUsage.mcp.switching` (default on) decides whether the switching tools are offered at all. Both are
  checked by the service on every call. While it is on, the extension offers the server to the agents of the VS
  Code window as **AI Usage accounts** (Copilot agent mode and other consumers of the editor's MCP servers see it
  without configuration). **Set up MCP server…** in the top-level AI Usage menu installs and enables it, then offers
  CLI registration; the Claude and Codex Accounts menus also offer **Register the MCP server with the … CLI…**,
  which runs `claude mcp add` (user scope) or `codex mcp add` for `~/.ai-usage/bin/ai-usage mcp` and tells whether
  the CLI already has the entry; other agents in a terminal register that command themselves. No tool returns login
  material, and nothing listens on a network port. See [docs/MCP.md](docs/MCP.md).
- Choosing a profile marked **Login problem** in the Accounts menu no longer sends a keep-alive straight away. It
  opens a menu that names the problem and offers **Renew the login…**, which runs the CLI login in a terminal with a
  separate home inside the keep-alive home and stores the new login in that profile, **Try a keep-alive**, which is
  what choosing the profile did before, **Select anyway**, which activates the login as it is, and **Back**.
- **Usage history.** The service appends every reading of every saved Claude and Codex account, every account
  switch (by hand, or by rotation together with the accounts it considered and what it did with each: skipped for a
  failed check, still at its limit, not clearly better, exhausted on a fresh reading, failed its keep-alive, or
  chosen), the rotation sweeps that spent endpoint calls without switching, the stretches with every account at its
  limit and when they ended, and checks that start or stop failing to one JSON Lines file per month under
  `~/.ai-usage/usage-history` (`aiUsage.history.directory` moves them; `~` is supported), kept for a year by default
  (`aiUsage.history.retentionDays`) and on by default (`aiUsage.history.enabled`); the settings are mirrored to the
  service's `history.*`. No login material is written. **AI Usage: Show Usage History…**, also **Usage history** in
  the details panel, and `ai-usage history [--days <n>|--all]` summarize the last 7, 30 or 90 days or everything
  kept as a Markdown document: per account the time as the active login, the weekly cycles seen with their mean
  peak, how many weeks and 5-hour cycles reached the limit, readings and failed checks; per service the switches by
  reason with the median stay, how long every account was at its limit at once, and the sweeps that switched
  nothing; and an estimate of how many accounts the observed weekly use needs. The same menu, and `ai-usage history
  export readings|events|jsonl`, export the readings, or the switches and sweeps, as CSV, and everything as JSON
  Lines. Details: [Usage history](docs/CONFIGURATION.md#usage-history).
- The stretch with every account at its limit now also ends when the active account's status bar reading drops below
  its thresholds, not only when a sweep reads it again, so the next such stretch is reported again.
- The extension package now carries the service under `service/`; the account modules moved there from `src/`.
- Saved profiles keep their order in the account service and `ai-usage move` reorders them from a terminal; a
  project profile moves among the profiles of its own folder.

## 0.1.0 (2026-10-07)

- **Account service profiles are listed.** A build with the account service moves the saved profiles into
  `~/.ai-usage/profiles.json` (or `$AI_USAGE_HOME`) once and removes them from SecretStorage, so builds without the
  service showed none. The Accounts menu now lists those profiles after the private ones and before the project ones,
  marked **account service**, uses their logins, and writes refreshed logins, renames, reordering and deletions back
  to that file without touching what else the service keeps there. Saving a profile offers the file as a place to
  keep it. `aiUsage.serviceProfiles.enabled` turns this off.
- **Manage saved profiles…** in the Accounts menu groups credential import, profile export/import, sign-in, rename,
  reorder and delete in a submenu. Import remains available when no profiles are saved. Each action returns to the
  submenu, so several changes take fewer steps and the Accounts menu is shorter.
- The active profile and status bar use the newest valid reading for that account. Readings from a quota window that
  has already reset are no longer shown or used to block activation.

## 0.0.38 (2026-10-07)

- **Move a profile up or down…** in the Accounts menu changes the order of the saved profiles, one step per pick, so
  they can be put back in order without deleting and adding them again. The order is the one the menu lists and
  rotation in saved order follows. A project profile moves among the profiles of its own folder.

## 0.0.37 (2026-10-03)

- **Usage history.** Every reading of every saved Claude and Codex account, every account switch (by hand, or by
  rotation together with the accounts it considered and what it did with each: skipped for a failed check, still at
  its limit, not clearly better, exhausted on a fresh reading, failed its keep-alive, or chosen), the rotation sweeps
  that spent endpoint calls without switching, the stretches with every account at its limit and when they ended, and
  checks that start or stop failing are appended to one JSON Lines file per month under the extension's global storage
  (`aiUsage.history.directory` moves them; `~` is supported), kept for a year by default
  (`aiUsage.history.retentionDays`) and on by default (`aiUsage.history.enabled`). No login material is written.
  **AI Usage: Show Usage History…**, also **Usage history** in the details panel, summarizes the last 7, 30 or 90 days
  or everything kept as a Markdown document: per account the time as the active login, the weekly cycles seen with
  their mean peak, how many weeks and 5-hour cycles reached the limit, readings and failed checks; per service the
  switches by reason with the median stay, how long every account was at its limit at once, and the sweeps that
  switched nothing; and an estimate of how many accounts the observed weekly use needs. The same menu exports the
  readings, or the switches and sweeps, as CSV, and everything as JSON Lines. Details:
  [Usage history](docs/CONFIGURATION.md#usage-history).
- The stretch with every account at its limit now also ends when the active account's status bar reading drops below
  its thresholds, not only when a sweep reads it again, so the next such stretch is reported again.
- Choosing a profile marked **Login problem** in the Accounts menu no longer sends a keep-alive straight away. It
  opens a menu that names the problem and offers **Renew the login…**, which runs the CLI login in a terminal with a
  separate home inside the keep-alive home and stores the new login in that profile, **Try a keep-alive**, which is
  what choosing the profile did before, **Select anyway**, which activates the login as it is, and **Back**.

## 0.0.36 (2026-10-01)

- Rotation no longer re-reads an account whose stored reading is still at a threshold with that window's reset
  ahead: usage only rises until the reset, so the call could not show it recovered. While every account is at its
  limit, a sweep now costs nothing and ends at once instead of spending an endpoint call per account every check
  interval and holding the account lock for minutes. The notification that no candidate remains names those
  accounts with the time until their reset.
- **Send keep-alive now…** waits for an account check running in another window instead of failing at once with
  "Another claude account check is already running" for every account. The progress notification says that it is
  waiting and can be cancelled; after 3 minutes the accounts are reported as not sent. **All accounts** keeps the
  lock for the whole sweep, so a periodic check cannot cut in between two of its accounts, and a check requested
  meanwhile in the same window, such as the re-read after a sign-in, runs after the sweep instead of being refused.

## 0.0.35 (2026-10-01)

- `aiUsage.claude.checkIntervalMinutes` accepts fractional minutes down to 0.25 (15 seconds) instead of stopping at
  a whole minute. Every call to Anthropic's usage endpoint is still spaced by `aiUsage.claude.api.minIntervalSeconds`
  (30 seconds by default) and by any limit the endpoint advertises; lower that setting too to call more often than
  every 30 seconds.

## 0.0.34 (2026-10-01)

- Rotation never switches to an account whose last check failed. A failed keep-alive, whatever the reason, or a
  usage check that found a login problem leaves the account out of the sweep, without spending a call on it, until a
  later check of it succeeds (the next periodic keep-alive, or **Send keep-alive now…**). The notification that no
  candidate remains names the accounts left out for that reason.
- **Project profiles.** Besides the private profiles kept with the VS Code client, a profile can now live in the
  workspace folder, in `.ai-usage.profiles.json` by default (`aiUsage.projectProfiles.file` sets another path; the
  format of a profile export, mode `0600`), login included, and
  is listed whenever that folder is open on any computer. **Save current login…** and **Import credential JSON…**
  ask whether to create a private or a project profile when both kinds are enabled (`aiUsage.privateProfiles.enabled`
  and `aiUsage.projectProfiles.enabled`, both on by default) and a local folder is open; otherwise the only possible
  kind is used. Refreshed tokens, renames and deletions go back to the file. Known limitation: the project profiles
  of every folder open in a window are merged into one list, so a project can be used with another open project's
  profiles. The first project profile saved in a Git repository adds the file to its `.gitignore`.
- A pending sign-in no longer competes with the automation. From **Sign in again…** until the new login is stored or
  the sign-in is cancelled, that service's keep-alives and rotation wait, a running sweep stops at its next account,
  and a keep-alive started by hand says that a sign-in is in progress; the **All accounts** keep-alive stops there
  and says how many accounts were not sent. The wait ends with the sign-in, or after 20 minutes at most.

## 0.0.33 (2026-09-29)

- **Export or import saved profiles…** in the Claude and Codex Accounts menus opens a picker with **Export saved
  profiles…** and **Import saved profiles…**, also available as **AI Usage: Export/Import Claude/Codex
  Authentication Profiles…** in the Command Palette; they move the saved profiles of both services to another
  computer. The export lists every profile, preselected, and writes the chosen ones with
  their logins to a JSON file (mode `0600` on Linux and macOS) and opens it in the editor. The import shows what each entry would do before
  anything is written: a profile not saved here is added with its name, email and account id; one saved here without
  a login gets it restored; one whose login differs is replaced only when chosen; one already saved with the same
  login is skipped. Nothing is activated. The notification after an export says that the file holds login tokens in
  plain text, and the docs explain that a copied login is one session, which two computers must not both refresh.
- The docs now say where profiles live: VS Code keeps the profile list and its logins with the VS Code client, also
  in remote windows, so another computer starts empty even when it connects to the same remote host.
- Rotation no longer waits behind a window that stopped responding. Account checks are serialized across windows by
  a lock file, and a window whose VS Code client had disconnected kept it forever (its extension host hangs in any
  call that needs the client), so no window rotated or sent keep-alives any more. A lock whose owner shows no
  progress for 10 minutes is now taken over; a live sweep renews it with every account it checks. A keep-alive sweep
  also re-checks the active account's limit before each account instead of once at its end, so a limit reached
  during a sweep of many accounts switches within one account check, not minutes later.
- `aiUsage.codex.autoRotate.fiveHourThresholdPercent` sets the Codex 5-hour threshold; its default 100 keeps the
  previous behavior of rotating only on a used-up window.

## 0.0.32 (2026-09-29)

- Choosing a profile marked **Login problem** in the Accounts menu, or sending it a keep-alive, no longer shows two
  **Sign in again** notifications when the login turns out to be dead. The keep-alive's own failure notification
  reports it and offers the sign-in; the automation's once-per-login announcement is recorded as given instead of
  being shown as well. That notification now also offers **Sign in again** when the keep-alive itself went through
  but the usage read found the login revoked.

## 0.0.31 (2026-09-29)

- **Sign in again…** in the Claude and Codex Accounts menus replaces a saved profile's login by running the CLI
  login in a terminal with a separate home; the active login is replaced only when that profile is the active one.
  A profile whose last keep-alive or usage check failed to authenticate is marked **Login problem**, and choosing it
  sends a keep-alive instead of activating it. When the keep-alive fails because the login expired and could not be
  refreshed, or was revoked, the failure notification offers **Sign in again**. Claude's "OAuth session expired and
  could not be refreshed" is now recognized as **Login expired** and announced once, like a revoked login, instead of
  being shown as an unknown keep-alive failure.
- README and docs show the current Accounts menus, tooltips, status bar account numbers and the Copilot model
  picker, cropped and with example addresses.

## 0.0.30 (2026-09-29)

- **Send keep-alive now…** can target every saved account at once. With more than one account saved, the picker
  offers **All accounts** at the top. It sends the keep-alive to each account in turn, 3 seconds apart so the usage
  endpoint is not hit in a burst, and shows progress that you can cancel. One summary at the end names any account
  whose keep-alive or usage refresh failed.

## 0.0.29 (2026-09-25)

- The Codex account proxy no longer asks Codex to refresh a login that has not expired. An upstream 401 for a valid
  token means the login was rejected, and refreshing it anyway rotated the refresh token under every other Codex
  process, which can get even a fresh sign-in revoked. The proxy used to refresh on every 401, about once a second
  while a chat retried. An expired token is still refreshed, at most once every 5 minutes.
- A Codex login that OpenAI rejects through the proxy now reads plainly: chats show "OpenAI rejected the Codex login
  in …/auth.json (reason). Run `codex login` or activate another AI Usage profile, then start a new chat." instead
  of OpenAI's misleading "Incorrect API key provided: sk-svcac…", and one notification says the same per rejected
  login instead of a log line per request.
- The Accounts menu marks accounts at their usage limit. An account with nothing left in its 5-hour or all-models
  weekly window shows a no-entry icon and **At its usage limit**, and selecting it only explains that it cannot be
  activated until it resets. An account that has only used up a model's weekly window (`7d Fable`) is dimmed with
  **Fable limit reached** and can still be activated for other models.
- Rotation strategies and thresholds are now described in their own page,
  [Account rotation: strategies and thresholds](docs/ROTATION.md), with worked examples; the configuration reference
  keeps a short summary.

## 0.0.28 (2026-09-24)

- Fewer rotation thresholds. Claude has `aiUsage.claude.autoRotate.fiveHourThresholdPercent` (default **95**) and
  `aiUsage.claude.autoRotate.weeklyThresholdPercent` (default **99.5**, for `7d` and, when it counts, `7d Fable`).
  Codex has `aiUsage.codex.autoRotate.weeklyThresholdPercent` (default **99**); a Codex 5-hour window rotates only
  once it is used up. The general `autoRotate.thresholdPercent`, Claude's `modelWeeklyThresholdPercent` and Codex's
  `fiveHourThresholdPercent` are gone, and values saved for them are no longer read.
- Codex rotation reacts to the status bar. Its figures usually come from the session logs, which name no account and
  were never used by rotation, so rotation only saw the account's stored reading, refreshed every few hours by
  keep-alives. A session-log reading at the threshold now makes rotation read the active account at once.
- When the active account is at its limit and no saved account is below the thresholds, a notification says so,
  naming the window, instead of rotation keeping the account silently.
- New [Rotation strategies and thresholds](docs/CONFIGURATION.md#rotation-strategies-and-thresholds) documentation:
  when a rotation starts (usage ≥ threshold), which accounts can be switched to (below every threshold), and how each
  strategy ranks them.

## 0.0.27 (2026-09-24)

- The status bar's account number and the Accounts menu's **Active** mark follow the native login when it is
  switched outside this window, by another VS Code window's switch or rotation or by signing in with the vendor
  CLI. The status bar used to keep the number of the profile this window last activated beside the other
  account's figures. The owner is found locally, from a matching token or the account id (Claude's account file,
  Codex's `auth.json`), with no endpoint call. A native login that belongs to no saved profile shows no number.

## 0.0.26 (2026-09-24)

- New **Claude Code config** settings section that sets how many agents Claude Code runs at once:
  `aiUsage.claudeConfig.env.maxConcurrentSubagents` (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, default 20) and
  `.workflowMaxConcurrentAgents` (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`, default 16, up to 256). A set value
  is written to `env` in Claude Code's user `settings.json` on startup and on every change. Empty by default, which
  leaves the file alone. New Claude Code sessions pick it up.
- Each service menu has its own settings item. The Claude and Codex Accounts menus have **Claude settings…** /
  **Codex settings…**, and the details panel for one service (Copilot's status bar item, or a chat chip) has
  **Copilot settings** (or Claude, Codex). Each opens Settings filtered to that service's settings, including its config section.
- The **Settings** item of the AI Usage menu of all services always opens AI Usage's settings in the Settings editor.
  With `workbench.settings.editor` set to `json`, it used to open the raw `settings.json` instead.

## 0.0.25 (2026-09-24)

- Clicking the Claude or Codex status bar item opens that service's Accounts menu, with its profiles and their
  usage, instead of the general details panel. The Copilot item and the chat chips still open the details panel.
- The Accounts menu ends with a **Back** item that opens the AI Usage menu of all services, and the account pickers inside
  it (send keep-alive, rename, delete) have a **Back** item that returns to the Accounts menu.

## 0.0.24 (2026-09-24)

- Rotation reacts as soon as a threshold is reached. A status bar reading of the active account that reaches a
  threshold starts rotation at once instead of on the next minute's check, and that reading is trusted for up to
  2 minutes instead of asking the rate-limited usage endpoint again. A sweep that could not read the active account,
  because its checks were paused after a rate limit, now retries as soon as the pause ends; it used to wait a whole
  `checkIntervalMinutes` (10 by default), so an account at its limit could keep being used for that long.
- Account problems read in plain words. The Accounts menu shows a known keep-alive or usage-check failure as a short
  label with a warning icon, such as **Insufficient credits**, **Invalid token**, **Login expired**, **Usage limit
  reached**, **Rate limited**, **Network error** or **Keep-alive model unavailable**, instead of the CLI's raw
  output, and the notifications add what to do about it. The vendor's own message is still written to the AI Usage
  log, and unrecognized errors are shown as before, without the "Keep-alive CLI exited with code 1" prefix.
- The status bar shows which saved account is active, e.g. `#2 17% (3h)` after the service icon, numbered as in the Accounts menu.
  Turn it off per service with `aiUsage.claude.statusBar.accountNumber` and `aiUsage.codex.statusBar.accountNumber`.
  It only appears when at least two profiles are saved.

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
