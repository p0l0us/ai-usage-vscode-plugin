# Allow AI Usage in the Agents window

VS Code disables extensions with code in the Agents window unless you opt them in. One click adds this
extension to the allow list in your **user settings**:

[Enable AI Usage in the Agents window](command:aiUsage.enableAgentsWindow)

This writes the following to your user `settings.json`:

```json
"extensions.supportAgentsWindow": {
  "p0l0us.ai-usage-vscode-plugin": true
}
```

You can also edit it yourself:

- **Settings editor**: [open extensions.supportAgentsWindow](command:workbench.action.openSettings?%5B%22extensions.supportAgentsWindow%22%5D)
  and click **Edit in settings.json**, or
- **JSON**: [open user settings.json](command:workbench.action.openSettingsJson) and paste the snippet above.
  The file is `%APPDATA%\Code\User\settings.json` on Windows, `~/Library/Application Support/Code/User/settings.json`
  on macOS and `~/.config/Code/User/settings.json` on Linux.

Use the **local** user settings (not remote or workspace settings): the Agents window reads your local profile.

Then reload the Agents window (**Developer: Reload Window**).
