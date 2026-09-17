# Configuration reference

All options live under **AI Usage** in the Settings editor (`Ctrl+,` / `Cmd+,`, then search *AI Usage*) and start
with `aiUsage.` in `settings.json`. In a Remote-SSH, WSL or container window use **Preferences: Open Remote Settings**
for these keys, because the extension runs on the remote side there.

## Sources

Each service has a `source` setting that selects where its usage is read from:

| Setting | Options | Default | Notes |
|---|---|---|---|
| `aiUsage.claude.source` | `api` | `api` | Claude Code has no read-only CLI or log source; `claude -p` only reports limits after a paid model call. |
| `aiUsage.codex.source` | `cli`, `api`, `sessionLog` | `cli` | `cli` runs `codex app-server` (set `aiUsage.codex.cliPath` if it is not on PATH). `sessionLog` is offline but only as fresh as your last Codex turn. |
| `aiUsage.copilot.source` | `api` | `api` | The Copilot CLI has no headless usage command. |

## Intervals

- `aiUsage.<service>.checkIntervalMinutes` (Claude 10, Codex 5, Copilot 5): how often that service's source is
  called and the result stored in the shared on-disk cache. One call serves every open window.
- `aiUsage.updateIntervalMinutes` (1): how often every window re-reads the cache and redraws the status bar and
  chat chip details. Applies to all sources.
- Manual **AI Usage: Refresh** bypasses the check interval but still honours a shared backoff after a
  rate-limit or server error (`Retry-After` when sent, otherwise 1 to 30 minutes doubling).

## Other settings

- `aiUsage.statusBar.enabled` (default on): show the usage items in the status bar at all.
- `aiUsage.statusBar.labels`: what precedes the figures in a status bar item: `none` (figures only), `nameOnly`,
  `iconOnly` (default) or `iconAndName`.
- `aiUsage.statusBar.usage`: `rich` (default) shows every window, `17% (3h) 25% (3d)`; the value in parentheses
  is time until reset, reduced to one largest unit (`42m`, `3h`, or `4d`). `simple` shows only the most-used window.
- `aiUsage.chatChips.labels`: `name` (default) prefixes the first chip with the service name, `Claude 4%`;
  `none` shows figures only. Chips cannot carry the vendor icon: VS Code drops the text of a toolbar item that has
  an icon.
- `aiUsage.chatChips.usage`: `rich` (default) shows one percentage chip per window, `Claude 4%` `26%`; `simple`
  shows the most-used window only, `Claude 26%`. Click a chip to see window names and reset countdowns. Copilot has
  a single monthly window, so both modes look the same for it.
- `aiUsage.chatChips.workbench`: `whenNoStatusBar` (default) shows the chip in a regular VS Code window only when no status bar shows the same figures; `always` or `never` override that. The Agents window has no status bar, so the chip there follows `aiUsage.chatChips.agentsWindow`.
- `aiUsage.claude.enabled` / `aiUsage.codex.enabled` / `aiUsage.copilot.enabled`: toggle the live items (default on).
- `aiUsage.copilot.account`: GitHub login to use when several are signed in.
- `aiUsage.chatChips.enabled`: toggle the chips beneath the chat input (default on). Clicking a chip opens the
  details panel for that agent. Hovering a chip only repeats its text; VS Code offers extensions no richer tooltip
  on that toolbar.
- `aiUsage.chatTokens.enabled`: show the consumed-token chip for the newest local Claude or Codex session in the
  current workspace (default on). Its compact value is rounded; clicking it shows exact input, output and cached
  input counts. VS Code does not expose another extension's active chat id, so if several chats run concurrently,
  the most recently updated matching session is shown. Copilot's per-chat telemetry is not available to extensions.
- `aiUsage.chatChips.agentsWindow`: also show the chip in the Agents window (default on; see
  [Agents (sessions) window](AGENTS_WINDOW.md) for the required one-time setup). The extension there runs
  on your local computer and shows the logins found there, also for remote sessions; a chat whose agent is not signed in
  locally gets an `n/a` chip.
- `aiUsage.chatChips.debug` (default off): diagnostic. Adds a test chip and shows every service's chip regardless
  of the chat's agent (Copilot's in a Claude chat, for example). Not needed to enable the chip.
- `aiUsage.accounts`: optional manual figures; the `AI xx%` item appears only when set.

## Claude and Codex authentication profiles

Authentication profiles are commands, not settings, because credentials must never appear in `settings.json`.
Run **AI Usage: Manage Claude/Codex Authentication Profiles** to save the current native login, import a credential
JSON file, rename/delete profiles, or activate one of up to 20 profiles per service. Profile names and the selected
profile id are non-secret extension metadata; credential bodies are stored individually in VS Code
`SecretStorage`.

Each saved profile shows the login email beside its name, so the same account saved twice is easy to spot. Codex
emails come from the saved id token; Claude credentials carry no identity, so the email is read from the Claude
OAuth profile endpoint (or the local Claude Code account file when offline) when a login is saved, replaced or
refreshed, and once for older profiles when the menu opens. The email is stored with the profile name as non-secret
metadata.

The profile manager shows the active account alongside the available management actions:

![Codex authentication profile manager with two saved accounts](../images/screenshots/auth-profiles-codex.png)

The details view confirms which profile is active and shows its detected plan:

![Codex account 2 shown as the active authentication profile](../images/screenshots/auth-profile-active.png)

Switching updates the same provider-native credential file used by its CLI and VS Code extension. The write uses
an atomic replacement; its temporary and resulting file use mode `0600` on Linux/macOS and the containing
user-profile directory's ACL on Windows. For Claude only the `claudeAiOauth` object is replaced, so `mcpOAuth.*`
entries remain untouched. Codex `auth.json` is replaced as a unit. When the native active login can be matched
safely to its saved profile (Codex account id, Claude organization, or an identical refresh token), refreshed token data
is captured before switching away. If a saved profile stops working with "Login token expired", log in with that
account natively and use **Save current login** to replace the profile.

### What happens to running Codex chats

Codex re-reads `auth.json` whenever a turn starts, so after a switch every open Codex chat that shares the same
Codex home continues on the new account from its next turn; nothing has to be restarted and no prompt is injected.
Right after the write, AI Usage starts a fresh `codex app-server` on the native home and checks that the login it
reports (`getAuthStatus`, falling back to `account/read`) is the activated profile. A mismatch, such as an imported
copy whose refresh token has since been rotated, is shown as an error instead of the success message; the previous
`auth.json` remains recoverable from its saved profile because refreshed tokens are captured before every switch.

The Codex extension spawns its `app-server` once per window and never respawns it. A server started before the
switch may keep using the previous tokens in its background paths (model list, connection prewarm) and show
sign-in errors. Each window checks once a minute whether its own Codex process predates the last switch and then
shows, once per switch, *"Codex switched to “…”, but this window's Codex process started before the switch and may
still use the previous login."* with a **Restart extensions** action. Choosing it restarts only that window's
extension host (`workbench.action.restartExtensionHost`); editors and terminals stay open, Codex chats reopen from
their local session files. AI Usage never kills a Codex process and never restarts anything on its own.

If you would rather keep two accounts side by side than switch one home, start a VS Code window with
`CODEX_HOME=~/.codex-<account>`: the Codex extension resolves its home from that variable and AI Usage follows it
for reading usage and for its profile commands, so the two windows stay independent.

The extension is workspace-first. In Remote-SSH, WSL, and dev-container windows it runs remotely and manages that
host's native credential files and SecretStorage. In an ordinary Windows/macOS/Linux window it runs locally. These
stores are intentionally separate; remote profiles do not leak into the local workstation or vice versa.

The active native credential is necessarily still plaintext and readable by processes running as your OS user.
SecretStorage protects the inactive saved copies from project files and ordinary extension storage; it does not
change the security model of the vendor CLI. Credential files selected with **Import** are not deleted by the
extension.

### High-usage highlighting

Status-bar items turn yellow when any displayed window reaches 80% usage and red at 95%. In this example Claude's
92% window resets in 3 hours, so Claude is highlighted while Codex remains neutral at 77%:

![Claude high usage highlighted yellow beside neutral Codex usage](../images/screenshots/status-bar-high-usage.png)


## Account automation

Save or import each subscription login in **AI Usage: Manage Claude/Codex Authentication Profiles**. Under each
provider's **Accounts → Account features** menu you can switch accounts manually and enable or disable
**Account keep-alive and usage collection** and **Automatic account rotation**. Both features default to off
and are stored for the extension host where the menu is used.

The Settings page contains configuration values only: periods, rotation thresholds, models, CLI paths, dedicated
homes, usage sources and check intervals. Feature enable switches intentionally live in the Accounts menu.

| Setting suffix (`aiUsage.claude.` / `aiUsage.codex.`) | Claude default | Codex default | Purpose |
| --- | --- | --- | --- |
| `keepAlive.periodHours` | `2` | `6` | Per-account keep-alive period, minimum 0.25 hours. |
| `autoRotate.thresholdPercent` | `99.5` | `99.5` | Rotate when any reported usage window reaches this percentage. |
| `keepAlive.home` | `~/.claude-tmp` | `~/.codex-tmp` | Dedicated CLI home; must be separate from the native home. |
| `keepAlive.model` | `haiku` | `gpt-5.6-luna` | Select a subscription model for the small request. |
| `cliPath` | `claude` | `codex` | CLI command or executable path. |

Codex defaults to Luna for small background calls, following [OpenAI Docs model usage guidance](https://learn.chatgpt.com/docs/pricing).
Use a model available to your subscription; an empty Codex model setting selects the CLI default.

Every keep-alive asks exactly `what is date today`. Requests use a separate working directory and CLI home,
with inherited authentication and provider routing overrides removed. Claude tools and custom hooks are disabled;
Codex runs noninteractively with a read-only sandbox. A keep-alive has a 90-second timeout. The extension attempts
to collect usage even if the small model call fails. Claude uses the OAuth usage endpoint, and Codex uses
`account/rateLimits/read` through its app-server with the same staged login. Codex API-key-only profiles do not
expose subscription quota windows and cannot qualify as automatic rotation targets.

The configurable home is dedicated to this feature. Relative paths resolve from the OS user home, and `~/` is
expanded. Credentials are staged using an atomic write with mode 0600 on POSIX and removed after the check.
The CLI may retain its own diagnostic/configuration files there. Refreshed credentials are saved back only if the
saved profile has not changed in the meantime; an unchanged active native login receives refreshed tokens too.

Per-account readings and attempt timestamps persist in the extension's global storage without credentials.
A one-minute scheduler checks due accounts; closing all windows pauses it. Reopening runs each overdue account
once, without replaying missed intervals. Each provider checks its accounts sequentially and uses an exclusive
lock across windows. Failed keep-alive attempts wait the configured interval; transient usage errors honor the
provider check interval and any longer `Retry-After`.

Rotation rechecks the active account and visits subsequent saved profiles in order, wrapping once. It requires a
successful current reading and a candidate with every required window below the configured threshold; both Codex
primary and secondary limits are considered. Missing, failed, incomplete or expired candidate readings never
authorize a switch. If
all candidates are exhausted, no native credential is changed. Another sweep may run after
`aiUsage.<provider>.checkIntervalMinutes`, allowing accounts to become eligible after their limits reset.
The selected account must still match the native login immediately before activation. As with manual switching,
Codex chats that are already open continue on the new account from their next turn, and Claude picks the new login
up on its next request.

CLI behavior references: [OpenAI Docs: noninteractive Codex](https://learn.chatgpt.com/docs/non-interactive-mode)
and [Claude CLI reference](https://code.claude.com/docs/en/cli-reference).
