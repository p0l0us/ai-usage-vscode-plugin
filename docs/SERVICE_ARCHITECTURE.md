# Service ownership and shared behavior

When `aiUsage.accountService.enabled` is on, the service is the source of usage readings, account state,
rotation decisions and runtime status. The extension displays those values and forwards configuration and user
actions. A lost connection produces an unavailable/stale display; it never starts a second provider-reading path.

The service owns:

- Active-login Claude, Codex and Copilot quota reads, including native logins not saved as profiles.
- Local usage files, API/CLI fallback, cache, refresh intervals, backoff and account attribution.
- Saved credentials, login refresh, keep-alives, rotation and earned Codex resets.
- The Codex account proxy, bridge process, native CLI settings and MCP registration commands.
- Session token readings and rotation diagnostics returned to clients.

VS Code supplies its GitHub sign-in and workspace context over the authenticated local connection. The service
keeps those GitHub tokens in memory for that connection, requests Copilot quota itself, and discards the context
when the window disconnects. Separate account/workspace contexts have separate cache entries. Without an editor,
Copilot can use `GH_TOKEN` or `GITHUB_TOKEN` in the service process environment; Claude and Codex use their native
CLI logins. Authentication prompts, terminal windows, model-provider registration and rendering remain editor UI.
The extension relays bridge requests to the service-managed bridge without reading Claude or Codex credentials.

## Deployment modes

| Mode | Engine runs in | State and credentials | After all editor windows close |
|---|---|---|---|
| Background service | Its own OS process | Service home | Polling, rotation and enabled proxies continue |
| Service enabled, background installation declined | One VS Code host, shared over the service socket | Same service home | Stops; another open window can take over |
| Service connection disabled | The extension, using the same service engine through an in-process client | Same service home | Stops with that window |

The last mode computes readings, weights and decisions in the plugin process. It shares the implementation,
schema, account locks and file formats with the service. Disabling the connection does not uninstall an existing
background service; stop that process before using an exclusively local deployment. Normal multiwindow use should
keep the service connection enabled so all windows share one scheduler.

Both service modes use `~/.ai-usage/profiles.json` (mode 0600) and project profile files. Existing VS Code profiles
are migrated into the service on connection when they are new, restore a missing login, or match an existing
entry. A source entry is removed only after the target contains it. Conflicting legacy entries are retained for
explicit resolution through profile import/transfer; they are not used for service automation.

## Settings and standalone CLI

Every setting in VS Code's `aiUsage.*` catalog is accepted by `ai-usage config` with the prefix removed. The build
generates the service catalog from the extension manifest, and tests check every default and key. This includes
usage sources, polling intervals, proxy/bridge settings, native CLI configuration, diagnostics and presentation
preferences. Presentation preferences are stored for clients; they do not create a GUI in a headless service.
Connection/background preferences govern VS Code integration; setting them does not install or stop an OS service.
Use `ai-usage service …` for deployment lifecycle.

On every VS Code connection, its effective settings are applied to the service. Later editor changes are pushed;
CLI configuration changes are sent back to connected editors. With multiple windows, the most recent configuration
write wins; use consistent host settings. Reconnecting an editor reapplies that editor's effective values.
Without VS Code, the service uses its persisted `config.json` and accepts CLI changes independently.

```sh
ai-usage config                         # complete catalog, values and explanations
ai-usage config codex.source cli
ai-usage config codex.proxy.enabled true
ai-usage config codex.proxy.port 43117
ai-usage config claude.advanced.rotationDiagnostics true
ai-usage config codexConfig.agents.maxDepth 3
ai-usage config codexConfig.agents.maxDepth null  # stop managing that native setting
ai-usage usage codex                    # native-login usage, even without a saved profile
ai-usage rotation-weights codex         # scores and selection explanation as JSON
```

The service checks for due live reads every five seconds. The chosen source's interval controls actual reads;
Claude's local-file interval remains independently configurable. Known quota reset times can bring a read forward.
A manual refresh respects provider backoff and endpoint spacing. Checks using the same login share the account
lock, so a native status check cannot refresh credentials concurrently with a saved-account check. Identity and
source changes during a read discard its result. Codex session logs remain unattributable to saved accounts: a
reported limit triggers a verified account check, rather than assigning that log to a profile.

## Advanced rotation tooltip

Enable `aiUsage.claude.advanced.rotationDiagnostics` or `aiUsage.codex.advanced.rotationDiagnostics` (both off by
default). The status bar tooltip shows every saved account, the active account, candidate order, numeric score
where applicable, reading time, exclusions and the reason the current account is kept. These are account scores;
rotation does not select the chat's model.

| Strategy | Displayed weight, lower preferred | Why the active account may remain selected |
|---|---|---|
| `sequential` | No numeric score; next saved account after the active one | Active account is below thresholds; proactive ranking does not apply |
| `soonestReset` | Hours to the binding weekly reset; +10000 when spending too far ahead early in the week | Threshold trigger, minimum stay, or no candidate improves enough |
| `evenPace` | Largest gap between used percentage and elapsed weekly percentage | Same switching guards; the account behind its weekly pace is preferred |
| `leastWaste` | Negative usable percentage/hour; ×1.1 when short-window allowance expires within an hour | Same switching guards; the allowance most likely to be wasted is preferred |

Scores use the exact ranking functions used by rotation. A score alone never authorizes a switch: errors,
thresholds, reset timing, minimum stay and fresh account verification still apply. Expired or missing readings are
identified in the explanation. With the service enabled, it returns the diagnostics directly; with the connection
disabled, the same engine computes them inside the extension. Opening a tooltip spends no provider calls.
See [rotation and earned resets](ROTATION.md) for the complete policy.

## Codex proxy ownership and ports

The proxy defaults to `127.0.0.1:43117`. `codex.proxy.port` must be an integer from 1024 through 65535. There is no
silent search for a different port: an unrelated listener produces an error. The owner stops its old listener,
preserves its bearer token and rewrites the managed native configuration when the port changes.

A user-wide ownership lease is independent of the configured port and `AI_USAGE_HOME`. Linux uses an abstract
Unix socket and Windows a named pipe, so the OS releases ownership even after a crash. Other platforms use an
exclusive PID lock that can be reclaimed after the owner exits. A second instance cannot open another proxy on a
different port. If the configured port already serves the AI Usage proxy, clients recognize its health endpoint
and remain passive. Only the owner removes the native routing configuration on shutdown or disable.

This scope is one OS user on one host, not a cross-user or cross-container coordinator. Different hosts and
container namespaces require explicit deployment coordination; see the [Docker proposal](DOCKER_PROPOSAL.md).

## Implementation and tests

`service/src/usageMonitor.ts`, `accountAutomation.ts`, `runtime.ts` and the proxy/bridge modules contain the behavior.
`src/usageClient.ts` converts wire dates and formats the service's diagnostics. Small extension re-export modules
preserve the shared helpers' existing imports without maintaining another implementation.

Tests cover both socket and in-process clients, source changes and account switches during reads, concurrent
clients, reset deadlines, backoff, Copilot context isolation, all four rotation strategies for both providers,
manual check serialization, settings catalog parity, profile migration and proxy ownership/port changes/crash
recovery. Provider and model calls in tests use fixtures rather than real subscription requests.
