# ai-usage-vscode-plugin

VS Code extension that shows AI account usage in one place:

- **Status bar**: remaining usage percentage icon (`AI xx%`) and click for details.
- **Chat panel**: `AI Usage Sessions` view under the chat/agents panel showing per-session token usage.

## Configuration

Set these settings in VS Code:

- `aiUsage.accounts`: list of subscriptions/accounts with token and budget limits.
- `aiUsage.chatSessions`: list of chat sessions to display in the chat panel usage view.

Use command **AI Usage: Refresh** after updating values.
