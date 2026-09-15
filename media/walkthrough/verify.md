# Check the result

Open any session in the Agents window. Beneath the chat input, next to the context indicator, chips such as
`Claude 4% (5h)` `26% (7d)` appear for the session's agent. Click one to open the details panel of that agent: plan,
account or organization, every window with its reset time, source and actions.
[aiUsage.chatChips.labels](command:workbench.action.openSettings?%5B%22aiUsage.chatChips.labels%22%5D) and
[aiUsage.chatChips.usage](command:workbench.action.openSettings?%5B%22aiUsage.chatChips.usage%22%5D) choose the
name prefix and whether every window or just the most used one is shown.

- The chip in the Agents window follows [aiUsage.chatChips.agentsWindow](command:workbench.action.openSettings?%5B%22aiUsage.chatChips.agentsWindow%22%5D)
  (on by default) and [aiUsage.chatChips.enabled](command:workbench.action.openSettings?%5B%22aiUsage.chatChips.enabled%22%5D).
  All extension settings: [open AI Usage settings](command:workbench.action.openSettings?%5B%22%40ext%3Ap0l0us.ai-usage-vscode-plugin%22%5D)
  or edit `aiUsage.*` keys in [settings.json](command:workbench.action.openSettingsJson).
- In the Agents window the extension runs on this computer, so it shows the providers signed in **here**:
  Copilot through VS Code's GitHub account, Claude and Codex only if their CLIs are signed in locally.
- Nothing visible? Turn on [aiUsage.chatChips.debug](command:workbench.action.openSettings?%5B%22aiUsage.chatChips.debug%22%5D) to render a test
  chip, and look at [Output → AI Usage](command:aiUsage.openLog) for the line starting with `host:`; it tells you
  where the extension is running.
