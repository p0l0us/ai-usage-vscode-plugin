# Changelog

## 0.0.7 (unreleased)

- 

## 0.0.6 (2026-09-11)

- 

## 0.0.5 (2026-09-11)

- 

## 0.0.4 (2026-09-11)

- Chat chip is now one text item, `Claude 17%`: the agent's name and its most used window (`Claude n/a` when the
  agent is not signed in where the extension runs). The icon, per-window and warning chips are gone. Clicking the
  chip opens a dialog with the same text as the status bar tooltip (plan, account or organization, per-window usage,
  reset times, last update). `aiUsage.chatChips.icon` was removed.
- Status bar items no longer open a quick pick on click; the figures are in the hover. The Copilot item still
  opens the GitHub access request when access is missing. **AI Usage: Show Details** shows the same dialog for
  every enabled service.
- Removed the quick-pick details panel.

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
