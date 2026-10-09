# AI Usage account service and `ai-usage` command

Keeps the saved Claude Code and Codex logins as profiles, switches between them, sends keep-alives and rotates
accounts on exhaustion, collects live Claude/Codex/Copilot usage, and owns the Codex proxy and CLI bridge, as a background service with the `ai-usage` command and an MCP server for AI agents. It
needs no VS Code; the [AI subscription management and usage](https://github.com/p0l0us/ai-usage-vscode-plugin)
VS Code extension uses it too and talks to it the same way.

## Installing

Without VS Code (Node.js 20 or newer, no dependencies):

```
npm install -g ai-usage-service
ai-usage service install        # copy to ~/.ai-usage, register autostart, start; --no-autostart skips the registration
ai-usage service run            # or: run it in the foreground instead
```

`ai-usage service install` copies the package to `~/.ai-usage/service`, registers it to start when you sign in (a
systemd user unit on Linux, a launchd agent on macOS, a Run registry value on Windows) and puts the `ai-usage`
launcher in `~/.ai-usage/bin`. The VS Code extension does the same with your permission; when you decline, it runs
the service inside VS Code while a window is open instead. Both modes keep profiles in
`~/.ai-usage/profiles.json`; existing nonconflicting VS Code profiles migrate there on connection.
`AI_USAGE_HOME` moves the service home. `AI_USAGE_NODE` names the runtime (Node.js 20+ for the service;
22+ for the bundled CLI bridge).

The service owns polling, credentials, rotation, native CLI settings, proxy startup and bridge startup. The editor
supplies GitHub authentication and workspace context; the service makes Copilot requests. Without an editor,
set `GH_TOKEN` or `GITHUB_TOKEN` in the service environment for Copilot.

## Commands

```
ai-usage                          live view in a terminal; status elsewhere
ai-usage status [--json]          active accounts, usage, service state
ai-usage usage [claude|codex|copilot]  current native-login usage, including unsaved accounts
ai-usage rotation-weights <service>   account scores and selection explanation
ai-usage list [claude|codex]      saved profiles and their last readings
ai-usage use <service> <profile>  activate a profile (name, number or id)
ai-usage save <service> <name>    save the current CLI login as a profile (--project[=<dir>]: in a project's file)
ai-usage login <service> <profile>   sign in again with the vendor CLI
ai-usage keepalive <service> [<profile>|--all]   one sweep in the service; waits for a running check
ai-usage rotate <service>         run a rotation sweep now
ai-usage export [file]            write the saved profiles, logins included
ai-usage import-profiles <file>   read them elsewhere
ai-usage history [--days <n>|--all]   summary of the usage history; "history export readings|events|jsonl", "history path"
ai-usage config [<key> [<value>]] show or change a setting
ai-usage service status|install|uninstall|start|stop|restart|run
ai-usage log [-n <lines>] [-f]
ai-usage mcp                      MCP server for AI agents on stdin/stdout (experimental, off by default)
```

`ai-usage --help` lists everything. Engine settings use the VS Code `aiUsage.*` keys with that prefix removed,
including sources, intervals, proxy and bridge configuration, native CLI settings and rotation diagnostics.
Nullable native settings accept `null`; arrays accept JSON. The runtime persists authoritative values in
`config.json`; editors read them on connection and explicit edits use revision checks. Presentation and editor
connection preferences stay local to each editor. Background and editor-owned deployments acquire the same
ownership lease before engine initialization and serve the same authenticated socket contract. Linux holds an
abstract Unix socket lease, Windows a named pipe lease, and other platforms a deterministic loopback TCP port
derived from the OS user and canonical service home. A TCP collision fails closed; no alternate port is tried, and
the OS releases the endpoint when its process exits.

For example: `ai-usage config codex.proxy.enabled true`,
`ai-usage config codex.advanced.rotationDiagnostics true`, and `ai-usage rotation-weights codex`.
Use `ai-usage service start|stop` for background process lifecycle. A manual stop prevents automatic
restarts from editor reconnects or CLI reads until an explicit Start or Restart.

The service refreshes every saved account of an enabled provider at startup without keep-alive prompts,
then refreshes at the provider check interval and after quota resets. Cached readings survive client
disconnects and are published to connected editors through update events. Provider budgets, backoff
and interactive holds still apply.
The proxy uses one ownership lease per OS user, independent of configured port (default `43117`). A port conflict
is reported rather than silently choosing another port.

A project's profiles (its `.ai-usage.profiles.json`, or the file named by `projectProfiles.file`) are listed
while a VS Code window has the folder open, or when `ai-usage` runs with `--project[=<dir>]` or from a directory
that holds such a file.

## AI agents

`ai-usage mcp` serves the profiles to an AI agent over the Model Context Protocol (stdio): `list_accounts` lists
every saved profile plus native-login usage with freshness and model-window scope, `refresh_usage` reads a saved
profile or, with profile omitted, the current native login, and
`switch_account` and `rotate_account` change the active account. The feature is experimental and off until
`ai-usage config mcp.enabled true`; `mcp.switching false` keeps agents to the usage tools. Register the launcher
with the agent, for example `claude mcp add ai-usage -- ~/.ai-usage/bin/ai-usage mcp`. The VS Code extension offers
the same server from its bundled package while the setting is on; background installation is optional. Details:
[MCP server for AI agents](https://github.com/p0l0us/ai-usage-vscode-plugin/blob/main/docs/MCP.md).

## Where things are

Everything is under `~/.ai-usage` (mode 0700): `profiles.json` holds the saved profiles with their logins (mode
0600), `config.json` the settings, `state/` the per-account readings and call ledgers, `usage-history/` the
month files of readings, switches and sweeps (`ai-usage history`), `service.log` the log,
`service.sock` (a named pipe on Windows) the connection clients use, and `service/` the installed package.

Only the service writes these files; the command line and the extension go through it. Clients present the token
in `service.token` first; on Windows that is what keeps other local users out of the named pipe.

Claude and Codex default to `source: auto` with `checkIntervalMinutes: 30`. The engine uses a fresh shared cache,
then a local usage file, direct API and CLI, stopping at the first usable reading and honoring endpoint budgets.
Existing explicit source modes and intervals persist unchanged. `codex.autoReset.confirmationRequired` defaults
to false; when enabled, a connected editor must approve the engine's reset decision. With no approving editor,
no earned reset credit is spent. Details: [configuration](../docs/CONFIGURATION.md#earned-reset-confirmation).

Saved accounts use persistent `~/.claude-profile-1` and `~/.codex-profile-1` CLI homes (and subsequent numbered homes), containing their own logins and CLI settings. `keepAlive.home` accepts a `{number}` template; home numbers stay attached to profile IDs when the list is reordered. See [account home configuration](../docs/CONFIGURATION.md#account-automation) for synchronization and migration details.
