# AI Usage for VS Code

See how much of your AI coding budget is left without leaving the editor. **AI Usage** shows live rate-limit and
quota usage for **Claude Code**, **Codex** and **GitHub Copilot** in the status bar and, in the Agents window, as
chips beneath the chat input.

- **Status bar**: `17% (5h) 25% (7d)` for Claude, `37% (7d)` for Codex, `42%` for Copilot, each behind its vendor
  icon. Hover for reset times; the item turns yellow at 80% and red at 95%.
- **Chat chips**: the same figures for the agent the current chat is using.
- **Details panel**: click any item for plan, account or organization, reset countdowns and source.
- **Organization aware**: Copilot follows the GitHub account whose Copilot organization owns the workspace
  repository, so org-billed seats show org data.
- **Gentle on the services**: one shared cache for all open windows, per-service check intervals and
  `Retry-After` aware backoff. Codex can be read from the local CLI with no network at all.
- **Honest when things fail**: a failed refresh keeps the previous reading and greys it out after 15 minutes.

Nothing is shown for a tool that is not installed or signed in. Tokens are only read from the tools' own login
files, never written or refreshed.

## Installation

1. In VS Code open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`), search for **AI Usage**, click **Install**.
   Or install from the command line:

   ```bash
   code --install-extension p0l0us.ai-usage-vscode-plugin
   ```

2. Sign in to the tools you use, if you have not already: run `claude` once, run `codex login` once, and sign in
   to GitHub in VS Code for Copilot.
3. The usage items appear in the status bar within a few seconds. For Copilot, VS Code shows one dialog asking to
   let **AI Usage** use your GitHub account; click **Allow**.

Requires VS Code 1.137 or newer. Works in Cursor and VSCodium from Open VSX.

### Remote development (SSH, WSL, containers, tunnels)

The extension runs **where your AI tools are signed in**. In a Remote-SSH, WSL, dev container or tunnel window
it is installed and runs on the remote machine, so:

- It reads the Claude and Codex logins on the **remote** machine. If you use those CLIs locally instead, they will
  not appear; install the extension locally too, or sign in on the remote side.
- Copilot uses the GitHub account VS Code is signed in with; that works in remote windows as usual.
- Settings for sources and intervals belong in **Remote Settings**, not the local user settings.
- The **Agents window** is the exception: it runs only *local* extensions, and blocks extensions with code until
  you allow them. Chips there need a local install plus a one-time allow step; run
  **AI Usage: Agents Window Setup Guide** from the Command Palette or see
  [docs/AGENTS_WINDOW.md](docs/AGENTS_WINDOW.md).

## Screenshots

Status bar with the default icon-only labels (`aiUsage.statusBar.labels: iconOnly`):

![Status bar, icons only](images/screenshots/status-bar-icons.png)

The same with service names (`iconAndName`):

![Status bar with service names](images/screenshots/status-bar-labels.png)

Hover any item for the per-window breakdown, plan, source and reset times:

| Claude | Codex | Copilot |
|---|---|---|
| ![Claude tooltip](images/screenshots/tooltip-claude.png) | ![Codex tooltip](images/screenshots/tooltip-codex.png) | ![Copilot tooltip](images/screenshots/tooltip-copilot.png) |

The Copilot tooltip names the account and, for organization-billed seats, the organization and its premium-request
usage.

## Settings you are most likely to touch

| Setting | Default | What it does |
|---|---|---|
| `aiUsage.statusBar.labels` | `iconOnly` | `iconAndName` adds the service name next to the icon. |
| `aiUsage.codex.source` | `cli` | `api` calls the ChatGPT endpoint; `sessionLog` is fully offline. |
| `aiUsage.<service>.checkIntervalMinutes` | 10 / 5 / 5 | How often Claude / Codex / Copilot are queried. |
| `aiUsage.copilot.account` | (auto) | GitHub login to use when several are signed in. |
| `aiUsage.<service>.enabled` | on | Hide a service you do not use. |

The full list is in [docs/CONFIGURATION.md](docs/CONFIGURATION.md). Where the numbers come from, how caching and
backoff work and how the chips are built: [docs/INTERNALS.md](docs/INTERNALS.md).

## Troubleshooting

- **A service is missing**: it is not signed in on the machine the extension runs on (see the remote note above).
  **Output → AI Usage** shows what was found.
- **Copilot shows “connect”**: click it and allow access to your GitHub account.
- **Numbers are grey**: the last refresh failed; the tooltip says why. Rate limits clear on their own.

## Contributing

Bug reports, ideas and pull requests from any developer are welcome. Open an issue at
<https://github.com/p0l0us/ai-usage-vscode-plugin/issues> (include the VS Code version and the relevant lines from
**Output → AI Usage**; tokens are never logged) or send a PR. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
workflow and [docs/PUBLISHING.md](docs/PUBLISHING.md) for building, dev-installing and releasing.

Most wanted: additional providers (Gemini CLI, Cursor, …), a Claude source that does not depend on the
undocumented OAuth endpoint, tests.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
