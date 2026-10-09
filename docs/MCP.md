# MCP server for AI agents (experimental)

The account service can serve its profiles to AI agents over the [Model Context Protocol](https://modelcontextprotocol.io):
an agent such as Claude Code, Codex or Copilot agent mode can list every saved Claude Code and Codex profile with its
usage windows, read a fresh reading for one of them, and switch the active account when it decides to. The feature
is experimental and **off by default**: its tool names and answers can change between releases, and letting an agent
switch accounts is a decision you make once, in Settings, not something the extension does on its own.

The server is `ai-usage mcp`, a stdio server of the [account service](CONFIGURATION.md#account-service): it talks to
the service over its local socket, and no tool ever returns login material. On platforms without an OS local socket
lease, the service also reserves a fixed loopback TCP port solely for runtime ownership; it drops incoming
connections and does not expose the MCP or account-service API over TCP.

## Turning it on

Open the top-level **AI Usage** menu and choose **Set up MCP server…**. It controls the shared service's MCP setting and offers registration with the Claude and Codex CLIs. Background installation remains available through **Account service…**. The setup item stays visible while the
server is off, so you can return to it later.

| Setting | Default | `ai-usage config` key | Purpose |
| --- | --- | --- | --- |
| `aiUsage.mcp.enabled` | `false` | `mcp.enabled` | Serve the tools at all: the command, and the server VS Code offers to its agents. |
| `aiUsage.mcp.switching` | `true` | `mcp.switching` | Offer `switch_account` and `rotate_account`; off leaves agents the usage tools only. |

Both live in **Settings → Extensions → AI Usage → AI agents (experimental)** and are mirrored to the service like the
other account settings (`ai-usage config mcp.enabled true` has the same effect; the service's `config.json` is the
source of truth). The service checks them on **every** tool call: turning `mcp.enabled` off stops the tools of a
server that is already running, and turning `mcp.switching` off makes the switching tools disappear from the next
tool list and refuses them meanwhile. The shared runtime must be running. The MCP adapter connects to its authenticated socket; it does not start an
independent engine. The editor can host the runtime without installing a background service.

## Where agents find it

**In VS Code.** While `aiUsage.mcp.enabled` is on, the extension registers an MCP server definition provider,
so the editor lists **AI Usage accounts** next to the servers from your own `mcp.json` (**MCP: List Servers**).
Copilot agent mode and other consumers of editor MCP servers can use its tools. The provider selects the installed
service command when available, otherwise the extension's bundled `service/bin/ai-usage.js`, with the service home
passed explicitly. The service chooses the command; the editor supplies its definition and connection controls. Background installation is optional. Nothing is offered while the setting is off.

**From a terminal.** In **Set up MCP server…**, choose **Register with Claude CLI…** or **Register with Codex CLI…**.
The same registration is available in each service's Accounts menu while the setting is on. It runs that CLI's own
`mcp add` with the CLI set in `aiUsage.<service>.cliPath`. When an installed launcher exists, it registers:
`claude mcp add --scope user ai-usage -- ~/.ai-usage/bin/ai-usage mcp`, so every project sees it, or
`codex mcp add ai-usage -- ~/.ai-usage/bin/ai-usage mcp`, which is global. The item's description tells whether
the CLI already has the entry. An entry of the same name that runs something else is replaced after a confirmation;
when the CLI already runs this command, the item offers **Register again** or **Remove**. If the installed package's launcher is missing, registration uses that package's recorded Node runtime and script, preserving its independence from the extension. Without an installed service, registration uses the running Node/Electron executable and the bundled
`service/bin/ai-usage.js mcp --home <dir>` command, including `ELECTRON_RUN_AS_NODE=1` when needed.
No sign-in or token is involved: the server reaches the service over its local socket with the token kept in the service home. Other
agents register the command themselves, as a stdio server. For an installed service, the launcher is `~/.ai-usage/bin/ai-usage`
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

For a manual bundled registration, use the full runtime and script paths while an editor-owned runtime is running:

```sh
claude mcp add --scope user ai-usage -- /path/to/node /path/to/extension/service/bin/ai-usage.js mcp --home /home/you/.ai-usage
```

A bundled registration points into the extension installation; rerun registration after an upgrade or relocation
if that path changes. An installed launcher gives terminal sessions a stable command path. With a background engine running, its installed MCP adapter remains usable after VS Code closes. An embedded engine lasts while its hosting editor window is open; its bundled adapter reports unavailable after that engine stops, until another window or background host takes ownership. Neither adapter starts a second engine.

With `AI_USAGE_HOME` set to another service home, pass `--home <dir>` as well, or set the variable for the agent.

## The tools

| Tool | Needs `mcp.switching` | Arguments | What it does |
| --- | --- | --- | --- |
| `list_accounts` | no | `service?` (`claude` or `codex`) | Every saved profile of one or both services with its last stored reading: the `5h`, `7d` and model-scoped windows as percent **used** with their reset times, when it was read, whether it is active, usable, at a limit or has a login problem, and the keep-alive and rotation state, plus current native-login usage even when unsaved. The engine may collect a due native reading. |
| `refresh_usage` | no | `service`, `profile?` | Refreshes a saved profile when supplied, otherwise the current native login, including an unsaved login. Sends no model prompt; respects source selection, endpoint spacing and backoff. |
| `switch_account` | yes | `service`, `profile` | Makes the profile the active login of that CLI, as **Switch** in the Accounts menu or `ai-usage use` does, with the same verification and message. |
| `rotate_account` | yes | `service` | Runs one rotation sweep now, as `ai-usage rotate` does: a switch happens only when the active account is at a threshold (or, with the proactive trigger, a clearly better candidate exists). |

Readings identify `freshness.state` (`fresh`, `stale` or `unknown`), age and the freshness interval. Native
`activeUsage` includes `saved`, status, any previous reading and a problem when collection failed. Window entries
carry `scope` (`account` or `model`) and, for model windows, the model. Model-scoped windows remain separate from account-wide
windows: exhausting one model does not prove every model is unavailable. Missing or expired usage is not reported as fresh
zero-percent usage. Native-login usage is available even when no profile was saved.

`profile` is what `list_accounts` shows: the name, the 1-based number, the id or the login email. Every answer carries
a text the agent can read and a `structuredContent` object with the same facts. `usable` in a profile entry means
a login is stored, capacity is known from a fresh reading, no counted window is used up and the last check found no
login problem. `loginStored` reports the stored-login fact separately; it does not prove usable capacity. Expired quota resets make a reading stale, and missing, invalid or future-dated readings are unknown. A failure the agent can act on (the service is not running, no such profile, the tool is turned off) is a
tool result with `isError`, with the reason as its text.

**Example.** Saved-account rows in `list_accounts` with `service: "claude"` include text like

```
Claude: active “Claude 1” (#1) · keep-alive on · rotation on (leastWaste, proactive, 5h ≥ 95%, 7d ≥ 99.5%)
  #1 “Claude 1” user1@example.com [active]: 5h 2% (resets in 2h) · 7d 12% (resets in 5d) · 7d Fable 6% (resets in 5d) · checked 2026-09-30T21:35:35.000Z
  #2 “Claude 2” user2@example.com: 5h 0% (resets in 2h) · 7d 33% (resets in 2d) · 7d Fable 60% (resets in 2d) · checked 2026-09-30T21:35:03.000Z
  #3 “Claude 3” user3@example.com [at its limit]: 5h 100% (resets in 1h) · 7d 56% (resets in 2d) · checked 2026-09-30T21:52:27.000Z
```

The following excerpt shows the saved-account portion of `structuredContent`; the response also includes
`activeUsage` for the native login and `freshness` for each profile:

```json
{ "services": [ { "service": "claude", "title": "Claude",
    "activeProfile": { "id": "…", "name": "Claude 1", "number": 1 }, "nativeUnsaved": false,
    "keepAlive": true, "autoRotate": true, "rotation": "leastWaste, proactive, 5h ≥ 95%, 7d ≥ 99.5%",
    "profiles": [ { "number": 1, "id": "…", "name": "Claude 1", "email": "user1@example.com", "active": true,
        "usable": true, "loginStored": true, "atLimit": false, "modelLimited": false, "problems": [], "checkedAt": "2026-09-30T21:35:35.000Z",
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
[What happens to running Codex sessions](CONFIGURATION.md#what-happens-to-running-codex-sessions). Account switching does not select a model or change an agent's model preference. Claude reads the new login on its
next turn; an already-running Codex session needs the account proxy or a restart to adopt it.

## Protocol details

JSON-RPC 2.0 over stdin and stdout, one message per line, as the MCP stdio transport specifies; everything else the
command has to say goes to stderr. The server offers protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05`
(the client's choice is echoed when it is one of them), the `tools` capability only, and `instructions` at
`initialize` that tell the agent how to read the figures and when a switch is worth it. The implementation is
`service/src/mcp.ts`, without an MCP SDK; `src/mcpProvider.ts` is the VS Code side.

Usage refresh tools honor the shared engine's `auto` source selection and configured minute interval (Claude and
Codex default to 30 minutes). Existing explicit sources stay supported. When
`codex.autoReset.confirmationRequired` is enabled, MCP usage reads do not approve pending reset decisions; a
connected editor must approve before the engine spends a credit. See [configuration](CONFIGURATION.md#earned-reset-confirmation).
