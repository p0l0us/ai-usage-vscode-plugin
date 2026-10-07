# MCP server for AI agents (experimental)

The account service can serve its profiles to AI agents over the [Model Context Protocol](https://modelcontextprotocol.io):
an agent such as Claude Code, Codex or Copilot agent mode can list every saved Claude Code and Codex profile with its
usage windows, read a fresh reading for one of them, and switch the active account when it decides to. The feature
is experimental and **off by default**: its tool names and answers can change between releases, and letting an agent
switch accounts is a decision you make once, in Settings, not something the extension does on its own.

The server is `ai-usage mcp`, a stdio server of the [account service](CONFIGURATION.md#account-service): it talks to
the service over its local socket, nothing listens on a network port, and no tool ever returns login material.

## Turning it on

Open the top-level **AI Usage** menu and choose **Set up MCP server…**. It installs the account service if needed,
enables the server, and offers registration with the Claude and Codex CLIs. The setup item stays visible while the
server is off, so you can return to it later.

| Setting | Default | `ai-usage config` key | Purpose |
| --- | --- | --- | --- |
| `aiUsage.mcp.enabled` | `false` | `mcp.enabled` | Serve the tools at all: the command, and the server VS Code offers to its agents. |
| `aiUsage.mcp.switching` | `true` | `mcp.switching` | Offer `switch_account` and `rotate_account`; off leaves agents the usage tools only. |

Both live in **Settings → Extensions → AI Usage → AI agents (experimental)** and are mirrored to the service like the
other account settings (`ai-usage config mcp.enabled true` has the same effect; the service's `config.json` is the
source of truth). The service checks them on **every** tool call: turning `mcp.enabled` off stops the tools of a
server that is already running, and turning `mcp.switching` off makes the switching tools disappear from the next
tool list and refuses them meanwhile. The account service has to be installed and running; the server starts it
when it is installed but stopped.

## Where agents find it

**In VS Code.** While `aiUsage.mcp.enabled` is on and the service is installed, the extension registers an MCP server
definition provider, so the editor lists a server named **AI Usage accounts** next to the servers from your own
`mcp.json` (**MCP: List Servers**). Copilot agent mode and every other agent that takes the editor's MCP servers can
use its tools; VS Code starts it as `node ~/.ai-usage/service/<version>/bin/ai-usage.js mcp` with the Node.js the
service was installed with. Nothing is offered while the setting is off.

**From a terminal.** In **Set up MCP server…**, choose **Register with Claude CLI…** or **Register with Codex CLI…**.
The same registration is available in each service's Accounts menu while the setting is on. It runs that CLI's own
`mcp add` for the launcher with the CLI set in `aiUsage.<service>.cliPath`:
`claude mcp add --scope user ai-usage -- ~/.ai-usage/bin/ai-usage mcp`, so every project sees it, or
`codex mcp add ai-usage -- ~/.ai-usage/bin/ai-usage mcp`, which is global. The item's description tells whether
the CLI already has the entry. An entry of the same name that runs something else is replaced after a confirmation;
when the CLI already runs this launcher, the item offers **Register again** or **Remove**. No sign-in or token is
involved: the server reaches the service over its local socket with the token kept in the service home. Other
agents register the command themselves, as a stdio server. The launcher is `~/.ai-usage/bin/ai-usage`
(`%USERPROFILE%\.ai-usage\bin\ai-usage.cmd` on Windows); most agents do not expand `~` in their configuration
files, so use the full path.

```sh
claude mcp add ai-usage -- /home/you/.ai-usage/bin/ai-usage mcp      # Claude Code
codex mcp add ai-usage -- /home/you/.ai-usage/bin/ai-usage mcp       # Codex CLI
```

The equivalent entry for an agent that reads a JSON configuration file:

```json
{ "mcpServers": { "ai-usage": { "command": "/home/you/.ai-usage/bin/ai-usage", "args": ["mcp"] } } }
```

With `AI_USAGE_HOME` set to another service home, pass `--home <dir>` as well, or set the variable for the agent.

## The tools

| Tool | Needs `mcp.switching` | Arguments | What it does |
| --- | --- | --- | --- |
| `list_accounts` | no | `service?` (`claude` or `codex`) | Every saved profile of one or both services with its last stored reading: the `5h`, `7d` and model-scoped windows as percent **used** with their reset times, when it was read, whether it is active, usable, at a limit or has a login problem, and the keep-alive and rotation state. No endpoint call. |
| `refresh_usage` | no | `service`, `profile` | Reads one profile's usage from the vendor now and stores it, without sending a prompt. One usage-endpoint call (spaced for Claude by `api.minIntervalSeconds`). |
| `switch_account` | yes | `service`, `profile` | Makes the profile the active login of that CLI, as **Switch** in the Accounts menu or `ai-usage use` does, with the same verification and message. |
| `rotate_account` | yes | `service` | Runs one rotation sweep now, as `ai-usage rotate` does: a switch happens only when the active account is at a threshold (or, with the proactive trigger, a clearly better candidate exists). |

`profile` is what `list_accounts` shows: the name, the 1-based number, the id or the login email. Every answer carries
a text the agent can read and a `structuredContent` object with the same facts. `usable` in a profile entry means
the service would switch to it: a login is stored, no counted window is used up and the last check found no login
problem. A failure the agent can act on (the service is not running, no such profile, the tool is turned off) is a
tool result with `isError`, with the reason as its text.

**Example.** `list_accounts` with `service: "claude"` answers with a text like

```
Claude: active “Claude 1” (#1) · keep-alive on · rotation on (leastWaste, proactive, 5h ≥ 95%, 7d ≥ 99.5%)
  #1 “Claude 1” user1@example.com [active]: 5h 2% (resets in 2h) · 7d 12% (resets in 5d) · 7d Fable 6% (resets in 5d) · checked 2026-09-30T21:35:35.000Z
  #2 “Claude 2” user2@example.com: 5h 0% (resets in 2h) · 7d 33% (resets in 2d) · 7d Fable 60% (resets in 2d) · checked 2026-09-30T21:35:03.000Z
  #3 “Claude 3” user3@example.com [at its limit]: 5h 100% (resets in 1h) · 7d 56% (resets in 2d) · checked 2026-09-30T21:52:27.000Z
```

and a `structuredContent` of the form

```json
{ "services": [ { "service": "claude", "title": "Claude",
    "activeProfile": { "id": "…", "name": "Claude 1", "number": 1 }, "nativeUnsaved": false,
    "keepAlive": true, "autoRotate": true, "rotation": "leastWaste, proactive, 5h ≥ 95%, 7d ≥ 99.5%",
    "profiles": [ { "number": 1, "id": "…", "name": "Claude 1", "email": "user1@example.com", "active": true,
        "usable": true, "atLimit": false, "modelLimited": false, "problems": [], "checkedAt": "2026-09-30T21:35:35.000Z",
        "usage": { "fetchedAt": "2026-09-30T21:35:35.000Z",
          "windows": [ { "label": "5h", "usedPercent": 2, "resetsAt": "2026-10-01T00:00:00.000Z", "resetsIn": "2h" }, … ] } }, … ] } ] }
```

`switch_account` answers with the service's message (`Claude switched to “Claude 2” (user2@example.com).`) and
`accountChanged`, `level` (`info`, `warning` when the switch could not be confirmed, `error` when the vendor reports
another login) and the verification detail.

## What a switch by an agent means

A switch through MCP is the same switch as from the Accounts menu: the CLI's native login is replaced, every new
command of that CLI uses the new account, the extension's chats follow on their next turn, and the service's
keep-alives and rotation go on with the new active account. `switch_account` does not apply the rotation thresholds,
so an agent can move to any usable profile; `rotate_account` does. What a switch means for Codex sessions that are
already running is described under
[What happens to running Codex sessions](CONFIGURATION.md#what-happens-to-running-codex-sessions). The agent's own
session is affected too: an agent that switches the account of the CLI it runs in continues on the new account from
its next request.

## Protocol details

JSON-RPC 2.0 over stdin and stdout, one message per line, as the MCP stdio transport specifies; everything else the
command has to say goes to stderr. The server offers protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05`
(the client's choice is echoed when it is one of them), the `tools` capability only, and `instructions` at
`initialize` that tell the agent how to read the figures and when a switch is worth it. The implementation is
`service/src/mcp.ts`, without an MCP SDK; `src/mcpProvider.ts` is the VS Code side.
