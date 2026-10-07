# AI Usage account service and `ai-usage` command

The background service behind the [AI subscription management and usage](https://github.com/p0l0us/ai-usage-vscode-plugin)
VS Code extension. It keeps the saved Claude Code and Codex logins as profiles, switches between them, sends
keep-alives and rotates accounts on exhaustion, and does so whether VS Code is running or not. The `ai-usage`
command controls it from a terminal; the extension installs it and talks to it the same way.

## Installing

The VS Code extension installs the service with your permission: it copies this package to `~/.ai-usage/service`,
registers it to start when you sign in (a systemd user unit on Linux, a launchd agent on macOS, a Run registry
value on Windows) and puts the `ai-usage` command in `~/.ai-usage/bin`, which VS Code terminals see on their PATH.

From a checkout or an npm install, `ai-usage service install` does the same. `AI_USAGE_HOME` moves the whole
home elsewhere; `AI_USAGE_NODE` names the Node.js (20 or newer) to run the service with.

## Commands

```
ai-usage                          live view in a terminal; status elsewhere
ai-usage status [--json]          active accounts, usage, service state
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

`ai-usage --help` lists everything. Names of settings are `claude.<setting>` and `codex.<setting>`, for example
`claude.autoRotate.strategy`, plus the global `privateProfiles.enabled`, `projectProfiles.enabled`,
`projectProfiles.file`, `history.enabled`, `history.retentionDays`, `history.directory`, `mcp.enabled` and
`mcp.switching`; `ai-usage config` prints them all with a line of explanation each.

A project's profiles (its `.ai-usage.profiles.json`, or the file named by `projectProfiles.file`) are listed
while a VS Code window has the folder open, or when `ai-usage` runs with `--project[=<dir>]` or from a directory
that holds such a file.

## AI agents

`ai-usage mcp` serves the profiles to an AI agent over the Model Context Protocol (stdio): `list_accounts` lists
every saved profile with its usage windows, `refresh_usage` reads one profile from the vendor now, and
`switch_account` and `rotate_account` change the active account. The feature is experimental and off until
`ai-usage config mcp.enabled true`; `mcp.switching false` keeps agents to the usage tools. Register the launcher
with the agent, for example `claude mcp add ai-usage -- ~/.ai-usage/bin/ai-usage mcp`. The VS Code extension offers
the same server to the agents of its window while the setting is on. Details:
[MCP server for AI agents](https://github.com/p0l0us/ai-usage-vscode-plugin/blob/main/docs/MCP.md).

## Where things are

Everything is under `~/.ai-usage` (mode 0700): `profiles.json` holds the saved profiles with their logins (mode
0600), `config.json` the settings, `state/` the per-account readings and call ledgers, `usage-history/` the
month files of readings, switches and sweeps (`ai-usage history`), `service.log` the log,
`service.sock` (a named pipe on Windows) the connection clients use, and `service/` the installed package.

Only the service writes these files; the command line and the extension go through it. Clients present the token
in `service.token` first; on Windows that is what keeps other local users out of the named pipe.
