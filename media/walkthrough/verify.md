# Check the result

Open any session in the Agents window. Beneath the chat input, next to the context indicator, the icon of the
session's agent appears (Claude, OpenAI or Copilot) followed by its most used window, for example `17%`. Click it
for the breakdown: plan, account or organization, every window with its reset time, the same text the status bar
tooltip shows.

- The chip in the Agents window follows [aiUsage.chatChips.agentsWindow](command:workbench.action.openSettings?%5B%22aiUsage.chatChips.agentsWindow%22%5D)
  (on by default) and [aiUsage.chatChips.enabled](command:workbench.action.openSettings?%5B%22aiUsage.chatChips.enabled%22%5D).
  All extension settings: [open AI Usage settings](command:workbench.action.openSettings?%5B%22%40ext%3Ap0l0us.ai-usage-vscode-plugin%22%5D)
  or edit `aiUsage.*` keys in [settings.json](command:workbench.action.openSettingsJson).
- In the Agents window the extension runs on this computer, so it shows the providers signed in **here**:
  Copilot through VS Code's GitHub account, Claude and Codex only if their CLIs are signed in locally.
- Nothing visible? Turn on [aiUsage.chatChips.debug](command:workbench.action.openSettings?%5B%22aiUsage.chatChips.debug%22%5D) to render a test
  chip, and look at [Output → AI Usage](command:aiUsage.openLog) for the line starting with `host:`; it tells you
  where the extension is running.
