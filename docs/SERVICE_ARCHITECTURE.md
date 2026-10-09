# Service ownership and shared behavior

The shared runtime is the source of usage readings, account state,
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
| Editor-owned runtime | One VS Code host, shared over the service socket | Same service home | Stops; another open window can take over |

Both deployments acquire the same runtime ownership lease per canonical service home before initializing the engine. Linux uses an abstract Unix socket and Windows a named pipe; other platforms bind one deterministic loopback TCP port derived from the OS user and canonical service home. The OS releases each lease on process exit. A TCP port collision fails closed; the service never tries another port. Every editor, CLI and
MCP client uses the authenticated socket and the same request contract. An editor connects to an existing owner
before attempting to host one. Turning `aiUsage.accountService.enabled` off selects editor-owned hosting; it does
not create an independent engine or stop an existing background owner. Background installation remains optional.
A disconnected client shows unavailable or stale state until it reconnects.

Both service modes use `~/.ai-usage/profiles.json` (mode 0600) and project profile files. Existing VS Code profiles
are migrated into the service on connection when they are new, restore a missing login, or match an existing
entry. A source entry is removed only after the target contains it. Conflicting legacy entries are retained for
explicit resolution through profile import/transfer; they are not used for service automation.

## Automatic sources and reset approval

Claude and Codex default to `source: auto` and `checkIntervalMinutes: 30`; saved explicit modes and intervals
remain authoritative. The engine tries fresh identity-keyed cache, local file, direct API and CLI in order, stopping
at the first usable reading. It retains source timestamps, rejects future/stale readings and expired quota windows,
and shares endpoint budgets and backoff. Codex session logs remain unattributable to saved accounts. Auto does
not fetch reset-credit metadata separately after a cheaper source succeeds. Usage source polling sends no model
prompt; separately enabled keep-alives and rotation checks retain their existing model actions and schedules.

`codex.autoReset.confirmationRequired` is opt-in and false by default. The engine's existing reset policy creates a
read-only pending decision; the editor renders engine facts and claims the dialog through the shared socket. Only
one client claims a decision. Approval is single use and revalidates account identity, credentials, settings, quotas,
credits and policy under the account lock before provider redemption. Cancellation, claim-owner disconnect,
five-minute expiry, stale facts and shutdown prevent spend. A runtime with no approving editor leaves the credit
untouched. The same policy handles preview and execution; the UI implements no redemption rules.

## Settings and standalone CLI

The build generates a shared setting catalog from the extension manifest. Engine settings such as usage sources,
polling intervals, proxy/bridge settings, native CLI configuration and automation are persisted in `config.json`.
Presentation and editor connection preferences remain local to each editor. The CLI catalog retains presentation
fields for compatibility, but editors neither push nor hydrate those values. Use `ai-usage service …` for deployment lifecycle.

The runtime's persisted engine configuration is authoritative. A connecting or reconnecting editor reads it rather
than replacing it with its effective settings. Explicit editor engine-setting changes use the last observed configuration
revision; edits to keys changed since that revision are rejected so clients can reload before retrying.
An explicit CLI write may update the requested key without a revision guard. CLI changes are announced to connected
editors. Workspace folders and GitHub sign-in context belong to the requesting connection and are removed when it
disconnects.

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

## Client contract and lifecycle

The socket handshake authenticates the service token and negotiates a protocol version and required capabilities
before accepting client context. Package versions and wire versions are separate. Incompatible clients receive an
error instead of being treated as another deployment mode. `service.status`, `service.info` and `log.tail` expose
the same owner and diagnostics in both deployments.

Requests can carry a deadline and a cancellation signal. Disconnects and owner shutdown abort pending requests.
Cancellation can stop queued work; once a mutation starts, a timeout or disconnect can leave its result unknown.
Clients reload authoritative state before deciding what to do next rather than replaying the mutation automatically.

An owner whose lease is held but whose service socket does not answer is unavailable; clients retry without replacing its
socket or starting another engine. On shutdown, the host closes request admission, drains admitted work, waits for
the managed bridge child to finish native-session cleanup and exit, tears down the service socket, then releases
the lease. If cleanup cannot be confirmed, it keeps ownership and can retry disposal. After a crash, the OS releases
the ownership endpoint, allowing another process to take over.

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
identified in the explanation. The runtime returns the same diagnostics in either deployment. Opening a tooltip spends no provider calls.
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

The root `npm test` command covers extension, service and bridge tests. Runtime scenarios exercise background and
editor-owned hosts through the socket contract, with fixture provider/model calls and temporary account homes.
See [contributing](../CONTRIBUTING.md) for validation and isolation requirements.
