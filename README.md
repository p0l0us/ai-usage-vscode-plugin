# AI Usage for VS Code

See how much of your AI coding budget is left without leaving the editor. **AI Usage** shows live rate-limit and
quota usage for **Claude Code**, **Codex** and **GitHub Copilot** in the status bar and, in the agent sessions
window, as small chips beneath the chat input next to the context indicator.

- **Status bar**: `Claude 17% (5h) 25% (7d)` · `Codex 37% (7d)` · `Copilot 42%`, placed just left of VS Code's
  language and Copilot indicators. Hover for reset times; the item turns yellow at 80% and red at 95%.
- **Chat input chips**: the same figures for the agent the current chat is locked to, in the normal chat view and,
  after a [short setup](#agents-sessions-window), in the Agents window.
- **Details panel**: click any item for a structured view per service, including the account or organization
  the numbers belong to, plan, reset countdowns and organization-wide Copilot figures where permitted.
- **Multiple accounts and organizations**: Copilot usage follows the GitHub account whose Copilot organization
  owns the workspace repository, so org-billed seats show org data.
- **Gentle on the services**: one shared cache for all open windows, per-service check intervals, `Retry-After`
  aware backoff, and local sources (Codex CLI, Codex session log) that avoid the network entirely.
- **Honest when things fail**: a failed refresh keeps the previous reading and greys it out after 15 minutes
  instead of blanking the item.

Nothing is shown for a tool that is not installed or signed in on the machine. Tokens are only read from the
tools' own login files, never written or refreshed.

This is an open-source project under GPL-3.0. Bug reports, feature ideas and pull requests from any developer are
very welcome; see [Contributing](#contributing).

## Configuration

### Where to change settings

All options live under **AI Usage** in the Settings editor and start with `aiUsage.` in `settings.json`.

| Way | How |
|---|---|
| Settings editor | `Ctrl+,` (macOS `Cmd+,`), then type **AI Usage** in the search box, or run **Preferences: Open Settings (UI)** and open **Extensions → AI Usage**. Typing `@ext:p0l0us.ai-usage-vscode-plugin` in the search box shows only this extension's settings. |
| `settings.json` | Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) → **Preferences: Open User Settings (JSON)**. Paste keys such as `"aiUsage.codex.source": "cli"`. |
| Per workspace | **Preferences: Open Workspace Settings (JSON)** writes to `.vscode/settings.json` in the project. |

User `settings.json` locations: Windows `%APPDATA%\Code\User\settings.json`, macOS
`~/Library/Application Support/Code/User/settings.json`, Linux `~/.config/Code/User/settings.json`
([VS Code docs](https://code.visualstudio.com/docs/configure/settings#_settings-json-file)). In a Remote-SSH, WSL or
container window, **Preferences: Open Remote Settings (JSON)** edits the remote machine's file instead; provider
settings (sources, intervals, accounts) belong there because the extension runs remotely, while the Agents window
setting below must be in the **local** user file.

### Sources

Each service has a `source` setting that selects where its usage is read from:

| Setting | Options | Default | Notes |
|---|---|---|---|
| `aiUsage.claude.source` | `api` | `api` | Claude Code has no read-only CLI or log source; `claude -p` only reports limits after a paid model call. |
| `aiUsage.codex.source` | `cli`, `api`, `sessionLog` | `cli` | `cli` runs `codex app-server` (set `aiUsage.codex.cliPath` if it is not on PATH). `sessionLog` is offline but only as fresh as your last Codex turn. |
| `aiUsage.copilot.source` | `api` | `api` | The Copilot CLI has no headless usage command. |

### Intervals

- `aiUsage.<service>.checkIntervalMinutes` (Claude 10, Codex 5, Copilot 5): how often that service's source is
  called and the result stored in the shared on-disk cache. One call serves every open window.
- `aiUsage.updateIntervalMinutes` (1): how often every window re-reads the cache and redraws the status bar and
  chat chips. Applies to all sources.
- Manual **AI Usage: Refresh** bypasses the check interval but still honours a shared backoff after a
  rate-limit or server error (`Retry-After` when sent, otherwise 1 to 30 minutes doubling).

### Other settings

- `aiUsage.claude.enabled` / `aiUsage.codex.enabled` / `aiUsage.copilot.enabled`: toggle the live items (default on).
- `aiUsage.copilot.account`: GitHub login to use when several are signed in.
- `aiUsage.chatChips.enabled`: toggle the chips beneath the chat input (default on).
- `aiUsage.chatChips.agentsWindow`: also show the chips in the Agents window (default on; see
  [Agents (sessions) window](#agents-sessions-window) for the required one-time setup).
- `aiUsage.accounts` / `aiUsage.chatSessions`: optional manual figures; the `AI xx%` item appears only when set.

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

## Agents (sessions) window

The Agents window is a separate VS Code window type with two rules that affect this extension:

- it runs **local** extensions only (for a remote session it talks to the server through an agent-host channel,
  there is no remote extension host), and
- it **disables extensions that contain code** unless you opt them in with the `extensions.supportAgentsWindow`
  setting (see step 2 below for exactly where to set it).

The extension ships a guided setup: run **AI Usage: Agents Window Setup Guide** from the Command Palette (or click
**Set up** on the one-time hint shown after installation). The steps are:

1. **Install the extension on your local computer.** Skip this if you already use VS Code locally without a
   remote. Otherwise download the VSIX from the
   [releases page](https://github.com/p0l0us/ai-usage-vscode-plugin/releases) and run
   **Extensions: Install from VSIX…** ([how-to](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)),
   or `code --install-extension ai-usage-<version>.vsix` in a local terminal. The manifest prefers the remote copy in
   ordinary remote windows, so the local copy is used only where no remote extension host exists.
2. **Allow it in the Agents window.** Run **AI Usage: Enable in Agents Window** from the Command Palette; it adds
   the entry below to your **local user** `settings.json`. To do it by hand, use either:
   - **Settings editor**: press `Ctrl+,` (macOS `Cmd+,`), type `extensions.supportAgentsWindow` in the search box,
     then click **Edit in settings.json** under the setting (it is an object, so it has no inline editor), or
   - **JSON**: Command Palette → **Preferences: Open User Settings (JSON)**
     (file: Windows `%APPDATA%\Code\User\settings.json`, macOS `~/Library/Application Support/Code/User/settings.json`,
     Linux `~/.config/Code/User/settings.json`) and add:

   ```json
   "extensions.supportAgentsWindow": {
     "p0l0us.ai-usage-vscode-plugin": true
   }
   ```

   This must go into the **local** user settings, not remote or workspace settings, because the Agents window reads
   the local profile.

   Alternative: `"extensions.experimental.enableAgentsWindowCapability": true` in the same file honours the `capabilities.agentsWindow.supported` declaration in the manifest for every extension
   that declares it.
3. **Reload the Agents window** (**Developer: Reload Window**). Chips appear beneath the chat input for the
   session's agent; click one to open that agent's details.

Related settings, all under **Extensions → AI Usage** in the Settings editor (`Ctrl+,` / `Cmd+,`, search the key)
or as keys in `settings.json`:

| Key | Default | Effect |
|---|---|---|
| `aiUsage.chatChips.agentsWindow` | `true` | Show the chips in the Agents window (turning it off hides them there only). |
| `aiUsage.chatChips.enabled` | `true` | Show the chips beneath the chat input anywhere. |
| `aiUsage.chatChips.debug` | `false` | Render a test chip regardless of the agent, for troubleshooting. |
**Output → AI Usage** (command **AI Usage: Open Log**) logs a `host:` line telling you whether the extension runs
locally or remotely.

Because the extension runs on your local computer in the Agents window, it shows the providers signed in **there**:
Copilot always (via VS Code's GitHub account), Claude and Codex only if their CLIs are signed in locally.

## How the chat chips work

VS Code renders items in the `chat/input/status` menu with static titles from the manifest, so
`scripts/generate-manifest.js` generates one command per provider, window and percent (`aiUsage.chip.claude.5h.17` …), so a click
knows which agent it belongs to. The extension publishes the current values as context keys (`aiUsage.chip.<provider>.<window>`) and each menu item's
`when` clause matches them against the chat's locked agent (`chatAgentHostProviderId`). Run `npm run generate`
(also part of `npm run compile`) after editing the generator.

All windows share one cache file in the extension's global storage, so only one window calls a source per check
interval and all windows respect the same backoff. Tokens are only read, never written or refreshed. If a token has expired, the item shows a warning and asks you to
run the CLI once so it refreshes its own login.

## Contributing

Contributions of every size are welcome, from typo fixes to new providers.

- **Found a bug or have an idea?** Open an issue at
  <https://github.com/p0l0us/ai-usage-vscode-plugin/issues>. For bugs, please include the VS Code version, the
  service affected, and the relevant lines from **Output → AI Usage** (tokens are never logged).
- **Want to fix or extend something?** Fork the repo, create a branch, and open a pull request. Small, focused
  PRs are easiest to review. If you plan a larger change, open an issue first so we can agree on the approach.
- **Ideas that would help most**: additional providers (Gemini CLI, Cursor, Windsurf, …), a Claude source that
  does not depend on the undocumented OAuth endpoint, better organization/billing views, localisation, tests.

### Development

```bash
npm install
npm run compile          # regenerates chat-chip commands in package.json and compiles TypeScript
npx @vscode/vsce package --no-dependencies -o ai-usage.vsix
code --install-extension ai-usage.vsix --force
```

`src/live.ts` and `src/cache.ts` have no dependency on the `vscode` module, so provider readers can be exercised
directly with Node:

```bash
node -e "require('./out/live.js').fetchCodexUsageCli().then(r => console.log(JSON.stringify(r, null, 2)))"
```

Please keep provider code in `src/live.ts` free of `vscode` imports, and run `npm run compile` before pushing so the
generated manifest stays in sync.

## Publishing a release

Maintainers publish to the Visual Studio Marketplace with [`@vscode/vsce`](https://github.com/microsoft/vscode-vsce).
The manifest already carries the publisher id (`p0l0us`), repository, license, icon and keywords the Marketplace needs.

### One-time setup

1. Create the publisher at <https://marketplace.visualstudio.com/manage>. Its id must equal the `publisher` field in
   `package.json` (`p0l0us`).
2. Create an Azure DevOps Personal Access Token: <https://dev.azure.com> → User settings → Personal access tokens →
   New token, **Organization: All accessible organizations**, **Scopes: Marketplace → Manage**. Copy the token.
3. Either log in once (`npx @vscode/vsce login p0l0us`, paste the token) or export it as `VSCE_PAT` before each
   publish. On machines without a credential store `vsce login` saves the token in plain text under `~/.vsce`, so
   prefer the environment variable there.

### Release steps

```bash
# 1. Update CHANGELOG.md, then bump the version (patch | minor | major, or an explicit x.y.z)
npm version patch --no-git-tag-version

# 2. Build: regenerates chat-chip commands in package.json and compiles TypeScript
npm run compile

# 3. Package and smoke-test locally
npx @vscode/vsce package --no-dependencies -o ai-usage.vsix
code --install-extension ai-usage.vsix --force     # reload the window, check status bar and chips

# 4. Publish (uses VSCE_PAT or the stored login)
npx @vscode/vsce publish --no-dependencies

# 5. Commit and tag
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release vX.Y.Z"
git tag vX.Y.Z && git push && git push --tags
```

`--no-dependencies` is required: the extension has no runtime npm dependencies and the flag stops `vsce` from
inspecting `node_modules`. Do **not** add `enabledApiProposals` to the manifest: the Marketplace rejects extensions
that declare proposed APIs, and installed-from-Marketplace extensions cannot use them anyway. Agents-window support
is enabled per user through the `extensions.supportAgentsWindow` setting (see the walkthrough), which needs no proposal. Optionally add `--pre-release` for a preview build. The listing appears within a few
minutes; the Marketplace verifies the icon, README links (must be absolute URLs) and the license file.

### Open VSX (VSCodium, Cursor, Gitpod)

Open VSX is a separate registry with its own account and token (<https://open-vsx.org>). Publish the same VSIX
with `npx ovsx publish ai-usage.vsix -p <OVSX_TOKEN>`. The namespace `p0l0us` must be created there first with
`npx ovsx create-namespace p0l0us -p <OVSX_TOKEN>`.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
