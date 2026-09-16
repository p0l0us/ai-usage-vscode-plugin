# Changelog

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
