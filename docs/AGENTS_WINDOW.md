# Agents (sessions) window

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
3. **Reload the Agents window** (**Developer: Reload Window**). The session's agent gets an icon chip beneath the
   chat input; click it for that agent's usage, the same text the status bar tooltip shows.

Related settings, all under **Extensions → AI Usage** in the Settings editor (`Ctrl+,` / `Cmd+,`, search the key)
or as keys in `settings.json`:

| Key | Default | Effect |
|---|---|---|
| `aiUsage.chatChips.agentsWindow` | `true` | Show the chip in the Agents window (turning it off hides it there only). |
| `aiUsage.chatChips.enabled` | `true` | Show the chip beneath the chat input anywhere. |
| `aiUsage.chatChips.debug` | `false` | Render a test chip regardless of the agent, for troubleshooting. |
**Output → AI Usage** (command **AI Usage: Open Log**) logs a `host:` line telling you whether the extension runs
locally or remotely.

Because the extension runs on your local computer in the Agents window, it shows the providers signed in **there**,
also for sessions that run on a remote machine: Copilot always (via VS Code's GitHub account), Claude and Codex only
if their CLIs are signed in locally. The chip of an agent that is not signed in locally still shows; clicking it
says where the login has to be. To see the numbers, sign in locally with the same account (`claude` once, or
`codex login`): limits are per account, so the figures are the same as on the remote. Turning on
`aiUsage.chatChips.debug` shows every provider's chip regardless of the chat's agent (that is why Copilot's chip
appears in a Claude chat with debug on); it is a diagnostic, not the way to enable the chip.
