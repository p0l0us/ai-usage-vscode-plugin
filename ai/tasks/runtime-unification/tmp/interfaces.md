# W1 interfaces: engine ownership, host, config authority (preliminary, W1 Claude Opus)

Status: PRELIMINARY v1 (2026-10-09). W1 implements exactly this; changes are appended under "Revisions" below,
never silently. W2/W3/W4: write requests/objections in your own `W*-interfaces.md`; W1 reads them.

## 1. Ownership lease (service/src/runtimeLease.ts, W1)

One engine per service home. The lease is acquired BEFORE token creation, config load/seed, state dir creation,
native-settings writes, proxy/bridge startup, the socket bind and the info file.

```ts
type LeaseKind = 'os' | 'file';
type EngineLease = { kind: LeaseKind; instanceId: string; home: string /* realpath */; held(): boolean; release(): void;
  onLost(listener: () => void): void };
acquireEngineLease(home: string, options?: { kind?: LeaseKind }): Promise<EngineLease | undefined>  // undefined: held by someone else
```
- Linux: abstract Unix socket, Windows: named pipe; name = sha256(uid/user + realpath(home)). The OS releases it on crash.
- Other platforms (or `kind: 'file'` in tests): `<home>/engine.lock` (JSON pid/instanceId), O_EXCL; reclaimed only when
  the recorded pid is dead, under a `engine.lock.reclaim` guard directory with re-verification (no double reclaim).
- Squatting by another local user on the abstract name / pipe = fail closed (DoS only, never a second engine).

## 2. Host (service/src/engineHost.ts, W1; daemon.ts keeps `startServiceHost`/`runDaemon` re-exports)

```ts
type HostMode = 'background' | 'embedded';
type HostOptions = { home: string; version?: string; mode?: HostMode; /** legacy alias of mode:'embedded' */ embedded?: boolean;
  onLog?: (line: string) => void; privateProfiles?: PrivateProfileBackend;
  /** Seeds ONLY keys not yet persisted in config.json (first run). Never overwrites existing settings. Replaces initialConfig. */
  seedConfig?: Record<string, unknown>; /** deprecated alias of seedConfig, same seed-only semantics */ initialConfig?: Record<string, unknown> };
type StopInfo = { by: 'host' | 'client' | 'signal' | 'lease-lost'; client?: string; reason?: string };
type ServiceHost = { readonly service: AccountService; readonly socket: string; readonly mode: HostMode; readonly instanceId: string;
  log(message: string): void; stop(reason?: string): Promise<void>; readonly stopped: Promise<StopInfo> };
startServiceHost(options: HostOptions): Promise<ServiceHost>   // throws EngineOwnedError
class EngineOwnedError extends Error { code: 'owner-running' | 'owner-unreachable'; owner?: ServiceInfoFile }
probeEngine(home): Promise<{ state: 'free' } | { state: 'running'; info: ServiceInfo } | { state: 'unreachable'; owner?: ServiceInfoFile }>
```
- `owner-running`: another host owns the home and answers -> connect to it (socket client).
- `owner-unreachable`: lease held but the socket/token does not answer -> FAIL CLOSED: do not host, do not delete the
  socket, report and retry later. Never start a second engine.
- A pre-lease (legacy 1.0.x) daemon answering on the socket while we got the lease -> we release the lease and
  throw `owner-running` (connect to it; plugin may shut it down by version as today).
- The daemon and the embedded host use the SAME function; `runDaemon` = `startServiceHost({mode:'background'})` + signals.
- Stop order: engine dispose (timers, proxy restore, bridge kill) -> socket close -> info file removed -> lease released last.
- `service.json` (ServiceInfoFile) gains `mode`, `instanceId`, `protocol: 2`; `embedded: true` kept for embedded.

### Plugin (W3) usage
`accountService.enabled=false` and background declined both use: `probeEngine` / `connectService`; if free ->
`startServiceHost({ home, mode: 'embedded', version })` then connect over the socket like any client. On
`EngineOwnedError('owner-running')` connect; on `'owner-unreachable'` show unavailable and retry (no local engine).
Dispose of the hosting window -> `host.stop()`; other windows reconnect/take over after their close event.
`new AccountService` / `ServiceClient.local` in the plugin MUST go: `AccountService.start()` now throws without a lease.

## 3. Lifecycle and log methods (handled by the host in both modes)
- `service.info` -> ServiceInfo (+ `mode`, `instanceId`, `protocol`, `capabilities`, `configRevision`).
- `service.status` -> `{ mode, instanceId, pid, startedAt, version, home, socket, lease: LeaseKind, clients: [{ id, client, version }] , configRevision }`.
- `service.shutdown { reason? }` -> `{ ok: true, mode }`; host stops ~50 ms later; `stopped` resolves `{ by: 'client', client }`.
- `log.tail { lines }` -> string[]; `log` events as today.
- capabilities (strings): `lease.v1`, `config.revision.v1`, `workspace.context.v1`, `service.status.v1`.

## 4. Config authority (configStore.ts `ConfigAuthority`, owned by engine)
config.json keeps the ServiceConfig keys plus top-level `revision: number` and `revisions: { "<dotted key>": number }`
(older services ignore them). Only the owner writes it, atomically, after re-checking the file stamp (a hand edit is
merged first and bumps the changed keys' revisions). An unparsable config.json is never overwritten silently: it is
kept in memory as defaults and moved to `config.json.invalid-<ts>` before the first write.

```ts
type SettingScope = 'engine' | 'presentation' | 'local' | 'workspace';
settingScope(dottedKey): SettingScope
// local: accountService.enabled, accountService.background (VS Code integration, never patched by clients)
// presentation: statusBar.*, chatChips.*, chatTokens.enabled, updateIntervalMinutes, refreshIntervalMinutes, accounts,
//   *.statusBar.accountNumber, codex.switchRestartHint, *.advanced.rotationDiagnostics  (editor-local per D2; engine ignores, CLI may store)
// workspace: bridge.codex.sessionDirectory, bridge.claude.sessionDirectory (global default; per-connection context overrides)
// engine: everything else
type ConfigView = { config: ServiceConfig; revision: number; revisions: Record<string, number>; scopes: Record<string, SettingScope> };
```
Wire (W2 to add to protocol.ts/client.ts; engine implements now in AccountService.handle):
- `config.read` -> ConfigView.
- `config.patch { values: Record<key, value>, baseRevision?: number, source?: string }` -> `{ config, revision, changed: string[] }`.
  Conflict when any patched key has `revisions[key] > baseRevision` (keys changed by others since the client last read):
  RpcError code `config-conflict`, message lists keys; `error.data = { revision, keys, values }` (W2: rpc.ts must carry
  `error.data` and copy `code`/`data` from any error with string `code`, not only RpcError). Local-scope keys -> code
  `config-local-setting`. Invalid value -> code `config-invalid`. No baseRevision = unconditional (explicit CLI/user write).
- `config.set { values }` unchanged semantics = unconditional patch with source 'legacy' (CLI keeps working).
- `config.get` unchanged (ServiceConfig).
- `configChanged` event gains `revision`, `changed: string[]`, `source?: string`.
Plugin (W3) contract: on (re)connect `config.read`, hydrate VS Code from the engine, NEVER push defaults/effective values;
push only the keys a user edit changed via `config.patch` with the last seen revision; on `config-conflict` pull.

## 5. Per-connection workspace context (AccountService, W1)
```ts
type WorkspaceContext = { folders: string[]; github?: { accounts: {login, token}[]; workspaceOwners: string[] };
  sessionDirectory?: Partial<Record<'codex' | 'claude', string>> };
```
- `workspace.context { folders?, github?, sessionDirectory? }` (fields given replace that part; per connection, dropped
  on disconnect). Existing `session.folders` / `usage.context` / hello `folders` keep working and feed the same context.
- `AccountService.workspaceContext(clientId): WorkspaceContext | undefined`.
- Bridge (W3, service/src/bridgeRuntime.ts): please accept a per-request context:
  `ensure(context?: BridgeWorkspaceContext)`, `syncSettings(context?: BridgeWorkspaceContext)` with
  `BridgeWorkspaceContext = { folders: string[]; sessionDirectory?: Partial<Record<'codex'|'claude', string>> }`;
  sessionDirectory = context.sessionDirectory[p] || config value || (context.folders.length === 1 ? folders[0] : '').
  AccountService passes the calling connection's context on `bridge.ensure` / `bridge.sync` / `bridge.connection`
  (extra arg ignored by the current signature until W3 lands it). Background (no client) sync passes no context.

## Revisions
R1 (W1, implemented 2026-10-09; supersedes the matching text above):
- Protocol/capabilities: host uses W2's `SERVICE_PROTOCOL_VERSION` (1) and `SERVICE_CAPABILITIES` from protocol.ts
  (`HOST_CAPABILITIES = [...SERVICE_CAPABILITIES]`); no `protocol: 2`. service.json: `protocol`, `mode`, `instanceId`,
  `lease: 'os'|'file'` (absent = pre-lease service), `embedded: true` kept for embedded.
- Test fixtures: `HostOptions.engineOptions?: Pick<AccountServiceOptions, 'fetchUsage'|'usageIdentity'|'now'|'probe'|'identityOf'|
  'verifyCodex'|'syncClaudeMetadata'>` (W4). Applied after the lease; cannot override home/log/version/lease/seed.
- `HostOptions.ownerWaitMs?` (default 3000): how long a lease holder may take to answer before `owner-unreachable`.
- `probeEngine` never takes the lease (uses `leaseHeld`, a non-acquiring check), so probing cannot fail a starting host.
- Stop order is awaited: `AccountService.dispose(): Promise<void>` -> `ServiceRuntime.dispose(): Promise<void>` awaits
  `BridgeRuntime.dispose()` (W3) -> sockets closed -> info file removed (only if it still names this instanceId) ->
  lease released. `stopped` resolves `StopInfo` after the lease is released. `runDaemon` returns `StopInfo`.
- Lease lost (file lease displaced/removed): mutations throw code `lease-lost`; host stops ~50 ms later with
  `{ by: 'lease-lost' }`. Read-only methods keep answering until then.
- Request context: host passes W2's `RpcRequestContext` to `AccountService.handle(method, params, clientId, request)`;
  aborted/expired before start -> RpcError `cancelled`/`timeout`, nothing changed; manual-check waits
  (`automation.keepAliveNow|keepAliveAll|rotateNow`) abort with the request signal; a disposed engine -> `closed`.
- Bridge: AccountService passes `BridgeWorkspaceContext` of the calling connection to `bridge.ensure/connection/sync`
  (typed against W3's BridgeRuntime). Background sync passes none.
- MCP: `mcp.registration` returns `{ launcher: descriptor.command, command: McpCommand, cli?, reason?, registration }`;
  register uses `mcpCommand(home)` (W2 descriptor).
- Config: `config.patch` conflict only for keys whose value would actually change (same value = agreement, no error).
  Presentation keys (D2): the engine still accepts/stores them for CLI compatibility, but they are editor-local state;
  the plugin must neither hydrate nor push them. `settingScope()` exported from configStore for that filter.
- File lease (W6 blockers fixed): record written to a private temp file then hard-linked to `engine.lock` (never an
  empty/partial lock; dead pids' temp files removed); reclaim only when the recorded pid is dead, by renaming the lock
  to a private name and verifying it is byte-identical to the dead record seen, otherwise restoring it (no age-based
  stealing, safe for suspended reclaimers); `held()`/`assertHeld()` re-read the lock file. Unreadable lock = fail closed.
- `canonicalHome`: realpath of the nearest existing ancestor + missing suffix (symlinked parent of an absent home
  shares one lease); other realpath errors throw (fail closed). OS lease name key = `uid:<n>` / `user:<name>`.
R2 (W1, implemented 2026-10-09; contract freeze respected, `engineOptions` unchanged):
- Stop is fail-closed (W6-008): `host.stop()` closes the socket server first (no new requests; W2 aborts in-flight
  signals), then `AccountService.dispose()` drains admitted requests + tracked background work (tick, usage poll,
  runtime sync, post-request automation kicks; default 30 s), then awaits bridge exit. On any failure `stop()` rejects
  "did not stop cleanly and still owns <home>", the LEASE AND INFO FILE ARE KEPT, `stopped` stays pending, and `stop()`
  may be called again (W3: `BridgeRuntime.dispose()` must re-attempt on a retry after a rejection, not return the
  cached rejected promise). Successors see `owner-unreachable` meanwhile.
- Queued mutations (W6-009): `AccountAutomation.admit` hook runs right before every operation leaves `withPaused` or
  gets the account lock; AccountService checks engine stopping (`closed`), the request's own signal (`cancelled`,
  via AsyncLocalStorage request scope) and the lease for non-read methods (`lease-lost`). Background work triggered by
  a request runs outside that request's scope (a client's cancel/disconnect does not stop a sweep).
- Typed dispatcher errors (W4): unknown method -> `unknown_method`; bad provider/missing id/ref/name, bad usage
  provider, bad baseRevision -> `invalid_params`.
- Legacy discovery (W2): host probes use `RpcClient.connect({ allowLegacyHello: true })`, read-only, before any
  token/config/state/native write.
- `ServiceRuntime.start(): Promise<void>` (tracked by the engine).
R3 (W1, W6-005 attempt 3, PENDING AUDIT, see W1-design3.md): file lease = immutable numbered claims in
`<home>/engine.lease/` (`g<n>.json` + `g<n>.released`), no `engine.lock`; new exports `fileLeaseDirectory`,
`observeFileLease`, `publishFileClaim`, `fileClaimIsHighest`, `withdrawFileClaim`, `newFileLeaseRecord`,
`processStartIdentity`; `engineLockFile`/`reclaimDeadLock` removed. Host/engine API unchanged. Alternative B
(loopback TCP lease) awaits auditor choice; no further runtimeLease edits until agreement.
