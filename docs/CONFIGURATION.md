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

The profile manager shows the active account alongside the available management actions:

![Codex authentication profile manager with two saved accounts](../images/screenshots/auth-profiles-codex.png)

The details view confirms which profile is active and shows its detected plan:

![Codex account 2 shown as the active authentication profile](../images/screenshots/auth-profile-active.png)

Switching updates the same provider-native credential file used by its CLI and VS Code extension. The write uses
an atomic replacement; its temporary and resulting file use mode `0600` on Linux/macOS and the containing
user-profile directory's ACL on Windows. For Claude only the `claudeAiOauth` object is replaced, so `mcpOAuth.*`
entries remain untouched. Codex `auth.json` is replaced as a unit. When the native active login can be matched
safely to its saved profile, refreshed token data is captured before switching away.

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
