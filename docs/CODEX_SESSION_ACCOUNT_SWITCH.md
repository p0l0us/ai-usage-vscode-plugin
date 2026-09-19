# Codex running-session account switch

Investigated 2026-09-17 against Codex CLI/app-server 0.154.0 (VS Code extension `openai.chatgpt` 26.908.40401) and one stray 0.149.1 from the VS Code agent-host SDK cache, on Linux with a Remote-SSH `vscode-server`. This is an implementation specification for AI Usage, not a description of shipped behaviour. Scope: after AI Usage activates a different Codex authentication profile, make **already running** Codex chats continue on the new account without the user restarting anything — or, when that is impossible, with a single guided action.

**Recommendation:** keep the existing `writeNativeCredential` swap as the only mechanism that changes accounts. Codex re-reads `auth.json` on the request path, so a correctly written file is picked up by the next turn of every running chat with no restart. Add three things around it: (1) a post-switch verification that the new account is really what a fresh `codex app-server` sees, (2) per-window detection of Codex processes that predate the switch and hold revoked tokens, with a one-click **Restart extensions** action, and (3) documentation that replaces the current "sessions may need to be reopened" sentence. Do not try to inject a `continue` prompt into Codex threads and do not kill Codex processes.

Each finding below is tagged **verified** (observed directly), **inferred** (consistent with observations but not proven), or **unverified**.

## 1. Where Codex keeps the account

| Store | Contents | Bound to a chat session? |
| --- | --- | --- |
| `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`, mode 0600) | `auth_mode`, `OPENAI_API_KEY`, `tokens.{id_token,access_token,refresh_token,account_id}`, `last_refresh` | No. One file per Codex home, shared by every window and process using that home. **verified** |
| `sessions/YYYY/MM/DD/rollout-<ts>-<thread-id>.jsonl` → `session_meta` | `session_id`, `id`, `cwd`, `originator`, `cli_version`, `model_provider`, agent nickname/role, `base_instructions` | No account, key, or server id. **verified** |
| `state_5.sqlite` → `threads` (39 columns: `id`, `rollout_path`, `cwd`, `model`, `git_branch`, `originator`, …) | Resume index used by `codex resume` and the extension | No account column. **verified** |
| `thread_history_1.sqlite`, `queue_1.sqlite`, `goals_1.sqlite`, `memories_1.sqlite`, `session_index.jsonl` | Turn/item projections, queued input, goals, memory summaries, `{id, thread_name, updated_at}` | No account. **verified** |
| `state_5.sqlite` → `remote_control_enrollments` (`server_id`, `environment_id`, `server_name`, `websocket_url`, `account_id`, …) | Remote Control pairing | Keyed by account, not thread; table was empty on the investigated machine. **verified** |
| OS keyring, service `Codex MCP Credentials`, account `<mcp-server>|<hash>` | MCP server OAuth | Per MCP server, unrelated to the ChatGPT account. **verified** |

Consequence: **a Codex thread is not bound to an account anywhere on disk.** The same threads were observed served by one `app-server` PID, then — after that window's extension host restarted — by a different PID under the new login, and they resumed normally. **verified**

## 2. Process model in VS Code

```
VS Code window
└── extension host (node …/bootstrap-fork --type=extensionHost)
    ├── codex -c features.code_mode_host=true app-server   ← one per installed Codex extension
    └── (second app-server if a second Codex extension is installed)
         └── many threads: user chats and their subagent threads
```

- One `app-server` per Codex extension per extension host; a host with two Codex extensions installed (`openai.chatgpt` and a side-loaded copy) runs two, only one of which served threads. **verified** (`ps`, parent PIDs, and `logs_2.sqlite` `process_uuid = pid:<PID>:<instance-uuid>` joined to `thread_id`; one PID served 11 distinct threads.)
- The extension spawns `app-server` exactly once, from `activate()`. `startCodexProcess()` has one call site; the exit handler only records the exit and calls `broadcastFatalError`. There is no respawn and no reconnect. **Killing the process leaves the Codex sidebar dead until the extension host restarts.** **verified** (extension bundle `out/extension.js`.)
- The Codex extension contributes no command for restart, sign-out, or re-authentication (`chatgpt.openSidebar`, `chatgpt.newCodexPanel`, `chatgpt.addToThread`, `chatgpt.addFileToThread`, `chatgpt.implementTodo`, `chatgpt.newChat`, `chatgpt.openCommandMenu`, `chatgpt.showLspMcpCliArgs`, two NUX debug commands). **verified**
- The extension resolves the Codex home from `process.env.CODEX_HOME`, falling back to `$HOME/.codex` (`resolveCodexHome`). Two windows started with different `CODEX_HOME` values therefore run on different accounts independently. **verified** (bundle) — this matches `nativeCredentialPath('codex')` in `src/authFiles.ts`.

## 3. Runtime reload of `auth.json`

Codex's `codex_login::auth::manager` reloads the file at runtime; it is not read only at start-up.

```
model_client.stream_responses_websocket{model=… api.path="/responses"}: Reloading auth for account <account_id>
                                                                        Reloaded auth, changed: false
                                                                        Refreshing token
getAuthStatus{…}:                                                       Reloading auth for account <account_id>
                                                                        Reloaded auth, changed: false
                                                                        Skipping token refresh because auth changed after guarded reload
codex_login::server:                                                    oauth token exchange succeeded status=200 OK
codex_login::auth::manager:                                             Reloading auth
                                                                        Reloaded auth, changed: true
```

- The reload runs inside the request span that starts a model turn, and inside `getAuthStatus`. A process that had been running for hours logged `Reloaded auth, changed: true` about one second after `codex login` rewrote the file. **verified**
- "Skipping token refresh because auth changed after guarded reload" shows Codex re-reads the file before refreshing and abandons a refresh when the file changed underneath it. Whether the guard compares mtime or content, and whether the reload is per request or debounced, is **unverified** (binary inspection was not possible in the investigating session).
- Not everything honours the reload. After the login, the `codex_models_manager` poller (`/backend-api/codex/models`) and the websocket prewarm path in processes started before the login kept failing with `401 token_revoked` for at least 20 minutes, while processes started after the login never did. **verified** These failures did not affect turns of chats that were actively used, which continued on the new account after their next turn. **inferred** (consistent with the thread migration in §1 and the reload evidence above; not isolated experimentally.)
- The 0.149.1 binary from the agent-host SDK cache kept failing as well. Assume it lacks the guarded reload and needs a restart. **inferred**

## 4. The rotation trap

Codex rotates the refresh token when it refreshes the access token and writes the result back to `auth.json`. Restoring an older copy of the same account therefore fails with

```
401 Unauthorized  invalid_request_error  refresh_token_invalidated  "Your session has ended. Please log in again."
401               token_revoked
```

Both were abundant in the investigated logs (576 `token_revoked` events across 29 process instances). **verified** AI Usage already defends against this: `AuthProfileManager.syncActiveProfile()` copies the native file back into the active profile's secret before switching when `isSameCredentialOwner` matches by `tokens.account_id`, and `refreshedCredential()` writes refreshed tokens back only when nothing else changed the file. Keep both; the feature below must not bypass them.

## 5. What AI Usage does today (main, v0.0.13)

| Step | Code | Notes |
| --- | --- | --- |
| Capture refreshed tokens of the active profile | `AuthProfileManager.syncActiveProfile()` — `src/authProfiles.ts` | Matched by `account_id`, refresh token, or exact equality. |
| Write the new document | `writeNativeCredential('codex', credential)` → `writeJsonAtomically()` — `src/authFiles.ts` | `wx` temp file in the same directory, mode 0600, `renameSync`, chmod 0600 on POSIX. Already satisfies §3's requirement that Codex never sees a partial file. |
| Record the active profile | `state.codex.activeProfileId` in `globalState` (`aiUsage.authProfiles.v1`) | Shared by all windows of the same extension host machine. |
| Notify | `activate()` shows "Codex switched to “<name>”. New requests will use this login." or the automatic-rotation variant | The sentence is correct but gives no guidance when a chat reports a 401. |
| Refresh this window's usage | `afterProfileActivated` hook — `src/extension.ts` | Clears `live.last`/`lastGood`, re-renders, refetches. Natural insertion point for the new steps. |
| Automatic rotation | `AccountAutomation` → `profiles.activateProfile(provider, id, true)` — `src/accountAutomation.ts` | Uses the same `activate()` path, so it inherits everything below. |
| Documented gap | `docs/CONFIGURATION.md` → "Existing running vendor sessions may need to finish or be reopened to pick up a switched login, just as with manual switching." | Replace with the behaviour specified here once implemented. |

## 6. Feature specification

### Goal

After `activate('codex', …)` completes, every running Codex chat on the same Codex home continues on the newly activated account on its next turn, with no user action. When a Codex process cannot follow the switch (§3, third and fourth bullets), the user gets one notification with a one-click repair in the affected window, and nothing else.

### Acceptance criteria

1. Switching profiles while a Codex chat is idle, then sending a turn in that chat, completes the turn on the new account (Codex shows the new plan/limits in `/status`; `logs_2.sqlite` contains `Reloaded auth, changed: true` for the serving process after the switch). No restart, no extra prompt.
2. Switching while a turn is streaming does not corrupt `auth.json` and does not truncate the running turn; the *next* turn uses the new account.
3. A post-switch verification confirms the account a fresh `codex app-server` reports matches the activated profile, and a mismatch is surfaced as an error, not a success message.
4. In a window whose Codex `app-server` predates the switch and keeps failing with `token_revoked`, the extension shows one warning with **Restart extensions**; choosing it runs `workbench.action.restartExtensionHost` for that window only. Other windows are unaffected until their own extension instance detects the same condition.
5. No Codex process is ever killed, no `continue` or other prompt is ever injected into a Codex thread, and `syncActiveProfile()`/`refreshedCredential()` still run unchanged.
6. `codex` API-key-only profiles (no `tokens`) still activate; verification tolerates a document without `tokens.account_id` by comparing `OPENAI_API_KEY` presence only.

### Stage A — rely on the request-path reload (no new mechanism)

Nothing changes in how the file is written. The existing atomic write is exactly what §3 needs. Two small hardening points:

- Do not modify `last_refresh` or reorder keys of the stored document beyond what `JSON.stringify(document, null, 2)` already does; Codex tolerates the pretty-printed form today (verified by the current release), but the value of `last_refresh` must stay the one captured with those tokens so Codex does not refresh prematurely.
- When `AccountAutomation` rotates, it already waits for `liveProviders[…].inFlight`. Keep the swap outside any AI Usage keep-alive probe of the *native* home; probes use the dedicated `keepAlive.home`, so this is already true — assert it in a test rather than in prose.

### Stage B — verify the switch took effect

Add `verifyCodexNativeAccount(expected: StoredCredential): Promise<{ ok: boolean; accountId?: string; detail: string }>` in `src/live.ts`, next to `codexRpcRateLimits`. Reuse its stdio JSON-RPC client (`initialize`, then one request) but call **`account/read`** (present in app-server API v2; observed as `rpc.method="account/read"` and `getAuthStatus` in the logs) with `CODEX_HOME` set to the *native* home from `codexHomeDir()` — not the keep-alive home — and `-c cli_auth_credentials_store="file"` as the existing client does. Compare the returned account id with `expected.tokens.account_id`; for API-key profiles accept a response that reports API-key auth. Call it from `afterProfileActivated('codex')` after the write, before `refreshProvider`. On mismatch, log to the "AI Usage" output channel and show an error message instead of the success message; do not roll back automatically (the previous file is already preserved in its profile secret by `syncActiveProfile`).

This verifies the file and a fresh process, not the extension's long-running process — that is what Stage C covers. If `account/read` turns out to require parameters or a different name in a future app-server, fall back to `getAuthStatus`; both appear in the 0.154.0 logs.

### Stage C — detect Codex processes that did not follow the switch

Problem: the Codex extension's `app-server` that serves this window may predate the switch and, for its poller/prewarm paths, hold revoked tokens (§3). The user sees intermittent 401s or a "sign in again" banner in Codex with no explanation.

Detection, cheapest first; implement 1, add 2 only if 1 proves insufficient:

1. **Process age vs. switch time.** On `afterProfileActivated('codex')`, record `switchedAt` in `globalState` (`aiUsage.codexSwitch.v1`, non-secret). In each window, on the existing 60-second tick, find `codex … app-server` processes whose parent is this window's extension host (`process.ppid` of the extension is the extension host PID; children are listed with `ps -o pid,ppid,lstart,args` on POSIX or `Get-CimInstance Win32_Process` on Windows) and whose start time is older than `switchedAt`. If any exist, show the Stage D warning once per switch per window. This needs no access to Codex's databases and works on all platforms.
2. **Confirm with Codex's own logs (POSIX, optional).** `$CODEX_HOME/logs_2.sqlite` table `logs(ts, level, target, feedback_log_body, thread_id, process_uuid)`; `process_uuid` is `pid:<PID>:<uuid>`. Rows after `switchedAt` with `feedback_log_body LIKE '%token_revoked%'` or `'%refresh_token_invalidated%'` and a `pid:` matching a live child of this extension host are a confirmed stale process. Open read-only (`file:…?mode=ro`), never write, and treat schema changes as "unknown", not as an error. This file is credential-adjacent; read only `ts`, `target`, `process_uuid`, and the two substrings above, never the full body into logs or telemetry.

### Stage D — one-click repair, never automatic

Show, at most once per switch per window: *"Codex switched to “<name>”, but this window's Codex process started before the switch and may still use the previous login. Restart extensions to apply it to open chats."* with actions **Restart extensions** → `vscode.commands.executeCommand('workbench.action.restartExtensionHost')` and **Later**. Restarting the extension host re-runs the Codex extension's `activate()`, which spawns a fresh `app-server` that reads the new file; editor layout and terminals survive; Codex threads reopen from their local rollouts (§1). Do **not** call `workbench.action.reloadWindow`, do not kill PIDs (§2), and do not restart automatically — the user may be mid-turn in a chat the extension cannot see.

Update the success message to: *"Codex switched to “<name>”. Open chats use this login from their next turn."*

### Explicitly rejected

| Idea | Why not |
| --- | --- |
| Kill the stale `app-server` and let the extension respawn it | No respawn path exists (§2); the sidebar dies. |
| Send `continue` into affected threads | The Codex extension exposes no command that submits a turn (`chatgpt.addToThread` semantics are **unverified** and likely only stage input). Driving `thread/resume` + `turn/start` from AI Usage's own `app-server` would run the turn outside the Codex UI process, duplicating hosts for one thread. Not needed: the next *user* turn already picks up the file. |
| Edit `remote_control_enrollments` or other sqlite rows | Not read on the request path; not the mechanism Codex uses for account selection; table is empty for non-enrolled users. |
| Re-run `codex login` per switch | Revokes the previous refresh token server-side and needs a browser; the profile store already holds valid documents. |

### Alternative architecture worth documenting, out of scope for this feature

Per-window accounts without any switching: start a VS Code window (or the agent host) with `CODEX_HOME=~/.codex-<account>`; the Codex extension resolves it (§2) and AI Usage already follows it via `nativeCredentialPath`. Mention it in `docs/CONFIGURATION.md` under the profiles section as the option for users who want two accounts side by side; AI Usage profiles remain the option for users who want one home and rotation.

## 7. Touch points

| File | Change |
| --- | --- |
| `src/live.ts` | `verifyCodexNativeAccount()` reusing the `codexRpc*` stdio client; export the small `account/read` response type. |
| `src/extension.ts` | In `afterProfileActivated`: for `codex`, run verification before `refreshProvider`; record `switchedAt`; on the 60-second tick, run Stage C detection and Stage D notification (once per switch per window, keyed in `workspaceState`). Adjust the success/failure messages. |
| `src/authProfiles.ts` | Message text only; no change to `activate()`, `syncActiveProfile()`, `refreshedCredential()`. |
| `src/accountAutomation.ts` | None expected; it flows through `activateProfile()`. Confirm the automatic-rotation notification (`Notify users after automatic account rotation`, commit 2c94dca) carries the same "next turn" wording. |
| `docs/CONFIGURATION.md` | Replace the "may need to finish or be reopened" sentence; add the Stage D behaviour and the `CODEX_HOME` alternative. |
| `docs/INTERNALS.md` | Add a short "Codex picks up a switched login on its next request; stale processes are detected by start time" paragraph under "Authentication profile storage and switching". |
| `test/` | Unit tests for the verification comparator (account id match, API-key document, missing `tokens`) and for the process-age detector with fake `ps` output; the existing `writeJsonAtomically` tests stay the contract for Stage A. |

## 8. Manual test plan

1. Two saved Codex profiles A and B, both subscription logins. Open a Codex chat under A, send one turn, leave it idle.
2. Switch to B in AI Usage. Expect the new success message and no error from Stage B.
3. Send a turn in the open chat. Expect it to complete; `codex /status` inside that chat (or `account/rateLimits/read` from AI Usage) shows B's plan; `logs_2.sqlite` has `Reloaded auth, changed: true` for that window's `app-server` PID after the switch.
4. Repeat 2–3 while a turn is streaming: the running turn finishes, the next uses B.
5. Open a second window before the switch, switch in the first, then trigger the second window's tick: expect exactly one Stage D warning there and none in the first window after its own restart.
6. Negative: save a profile, refresh its tokens by using Codex for a while, import the *old* copy under another name and activate it: expect Stage B to fail (Codex reports `refresh_token_invalidated`) and the error message, and the previous file to remain recoverable from its profile secret.
7. Windows and Remote-SSH: repeat 1–3 once each; Stage C's process enumeration is the only platform-specific code.

## 9. Open questions

- Is the `auth.json` reload per request or debounced, and does the guard compare mtime or content? Affects whether a switch within the same second as a turn start is picked up by that turn or the following one. **unverified**
- Does `codex_models_manager` recover on its own after the reload, or only on process restart? Determines whether Stage C is needed for 0.154.0 at all or only for older binaries. **unverified**
- Exact params/response of `account/read` in app-server API v2; the plugin's `initialize` client is known to work for `account/rateLimits/read`. **unverified**
- Whether Codex ever binds a thread to an account server-side for cloud/synced threads. Nothing local suggests it, and locally hosted threads migrated between processes freely. **unverified**

## 10. Evidence index (investigating machine, 2026-09-16/17)

- `ps -eo pid,ppid,lstart,args`: 9 extension hosts × 2 `app-server` children, plus one 0.149.1 `app-server` under an older `vscode-server`; children started 06:02–06:05 after the 06:02:49 login never logged `token_revoked`, children started earlier did.
- `logs_2.sqlite`: `codex_login::auth::manager` lines quoted in §3; `codex_models_manager::manager` `auth error: 401, auth error code: token_revoked` with `client_version=0.149.1` and `0.154.0`; `process_uuid`/`thread_id` join showing 11 threads on one PID and the same threads on a new PID after a window restart.
- `state_5.sqlite`: `threads` schema without an account column; `remote_control_enrollments` schema and zero rows.
- `openai.chatgpt-26.908.40401-linux-x64/out/extension.js`: `startCodexProcess()` definition and its single call site in `activate()`; exit handler → `finishProcessExitIfReady()` → `broadcastFatalError`/`teardownProcess`; `resolveCodexHome()` reading `CODEX_HOME`; the ten contributed commands in `package.json`.

## 11. Implementation notes (2026-09-17)

Implemented on `main` as specified in §6, with these deviations found while implementing against Codex 0.154.0:

- **`account/read` carries no account id.** Its answer is `{ account: { type: 'chatgpt', email, planType } | { type: 'apiKey' } | null, requiresOpenaiAuth }`. The verifier therefore asks `getAuthStatus { includeToken: true, refreshToken: false }` first and compares the `chatgpt_account_id` claim of the returned token with the stored `tokens.account_id` (or the same claim in the stored id/access token). `account/read` is the fallback and compares the email with the stored id token's `email` claim. API-key profiles match on auth method alone. **verified** against the native home (match), a copied document with a foreign `account_id` (mismatch) and an empty home (mismatch, "no login").
- **Parent pid.** Extensions run inside the extension host process, so its pid is `process.pid`, not `process.ppid`. Stage C lists children of `process.pid`.
- **Start time.** `ps -o etime=` (elapsed, `[[dd-]hh:]mm:ss`) is used instead of `lstart` to avoid locale-dependent date parsing; a 2-second grace covers its one-second resolution. Windows uses `Win32_Process.CreationDate` in ISO form.
- **Own processes.** AI Usage's usage checks, keep-alive probes and the verifier itself spawn `codex app-server -c cli_auth_credentials_store="file"`; that argument excludes them from Stage C so a probe running at tick time is never mistaken for a stale vendor server.
- **Where the verification runs.** `AuthProfileManager.activate()` takes an optional verifier (passed from `extension.ts`) and shows the error *instead of* the success message, which the `afterActivate` hook could not do because the success message was already shown by then. `syncActiveProfile()` and `refreshedCredential()` are unchanged.
- **Once per switch per window** is keyed by `switchedAt` in `workspaceState` (`aiUsage.codexSwitchNotified.v1`); the switch record lives in `globalState` (`aiUsage.codexSwitch.v1`). Stage C option 2 (reading `logs_2.sqlite`) was not implemented.
- Files: `src/live.ts` (`codexRpc`, `compareCodexAccount`, `verifyCodexNativeAccount`), `src/codexProcesses.ts` (new), `src/authProfiles.ts`, `src/extension.ts`, `docs/CONFIGURATION.md`, `docs/INTERNALS.md`, tests `test/codexVerify.test.js`, `test/codexProcesses.test.js`, `test/authFiles.test.js` and new cases in `test/authProfiles.test.js`.

## 12. Correction after live testing (2026-09-17, later)

The §3 conclusion that a running process follows a rewritten `auth.json` on its next turn is **wrong** for the
AI Usage switch. Tested with one long-lived `codex -c features.code_mode_host=true app-server` (0.154.0) whose
`CODEX_HOME/auth.json` was atomically replaced between requests:

- `getAuthStatus`, `account/read` and `account/rateLimits/read` kept answering from memory after the swap, with and
  without `cli_auth_credentials_store="file"`, also two seconds later and after `getAuthStatus { refreshToken: true }`.
- `thread/start` + `turn/start` after the swap failed with *"Your access token could not be refreshed because you
  have since logged out or signed in to another account. Please sign in again."* The guarded reload detects the
  change and refuses; it does not adopt the new credentials. **verified**
- The §3 evidence (`Reloaded auth, changed: true` after `codex login`) therefore shows the reload, not adoption.
  Acceptance criterion 1 is not achievable without restarting the process; criterion 4's restart offer is the only
  repair (`aiUsage.codex.switchRestartHint`, opt-in since 0.0.18). VS Code offers no per-extension restart; the
  Codex extension's own "server-restart" path calls `workbench.action.reloadWindow`.
- New hazard found the same day: two saved profiles holding the same account (`Codex account 1` and
  `Codex account 4 (Frydl)`) were refreshed independently by keep-alives and by a switch between them; the provider
  revoked the login (`401 token_revoked`, "invalidated oauth token for user") within the hour. Profiles now record the
  login email, mark duplicates and warn before a second copy is saved.

## 13. Account proxy (2026-09-18)

The restart offer of §12 is now the fallback. `aiUsage.codex.proxy.enabled` routes the Codex extension's model
requests through a local proxy (`src/codexProxy.ts`, `src/codexConfig.ts`, `src/codexProxyRuntime.ts`) that reads
`auth.json` per request, so a switch reaches every chat on the proxy on its next turn with no restart. Findings that
made it possible, all **verified** against the 0.154.0 app-server bundled with the extension:

- `config.toml` is loaded on every `thread/start`: a config error is reported by that request, and a provider edited
  between two `thread/start` calls is used by the second thread while the first keeps its own. The webview passes
  `modelProvider: null` unless the Copilot language-model proxy is in use, so the file's `model_provider` wins. A
  provider with `requires_openai_auth = false` and `http_headers = { Authorization = "Bearer …" }` sends exactly
  that header and no login; with `requires_openai_auth = true` the login's bearer overrides the configured header.
- With such a provider selected, `getAuthStatus`, `account/read` and `account/rateLimits/read` report no login and
  `requiresOpenaiAuth: false`; the webview computes `requiresAuth = requiresOpenaiAuth ?? true` and skips its login
  wall. AI Usage's own probes pass `-c model_provider="openai"` and see the login again.
- To a custom provider Codex sends HTTP `POST {base_url}/responses` with `originator`, `user-agent`, `session-id`,
  `thread-id`, `x-codex-*` and `x-client-request-id` headers and no `Authorization` beyond `http_headers`. To its
  own backend it opens a WebSocket to `wss://chatgpt.com/backend-api/codex/responses` with `Authorization`,
  `chatgpt-account-id`, `version` and `openai-beta: responses_websockets=…`. The HTTP form of that backend URL
  accepts the custom-provider body with only `Authorization`, `chatgpt-account-id` and `version` added: the proxied
  request was authenticated and answered with 429 `usage_limit_reached` plus `x-codex-*` rate-limit headers (every
  available workspace was out of credits that day), which the app-server surfaced as `account/rateLimits/updated`.
  A 200 stream through the proxy is verified against a mock upstream only.
- A rewritten `auth.json` is still never adopted by a running process; writing into its stdin through
  `/proc/<pid>/fd/0` is impossible (libuv stdio is a socketpair, `ENXIO`; `ptrace_scope = 1`), and the extension's
  IPC socket (`$CODEX_HOME/ipc/ipc.sock`) forwards only `ide-context` and `thread-owner-discovery`.
  `account/login/start { type: "apiKey" | "chatgptAuthTokens" }` does switch a live process, but only the process
  that owns its stdio can send it, which would mean a launcher shim (`codex2.cliExecutable`, one reload) or a patched
  bundle.

Checked again on 2026-09-19 with the CLI at 0.155.0, which picks the provider up from the same `config.toml`
(`codex exec` printed `provider: ai-usage`): the proxied request reached the ChatGPT backend and was answered with
the account's own state (`workspace_owner_credits_depleted`, that workspace having no credits), and the app-server
recorded a `token_count` event carrying `rate_limits` — so rate-limit data does travel back through the proxy and
reaches Codex's own status. `account/rateLimits/read` stays empty (no login is reported), which is why `/status`
shows `Rate limit: Unavailable` until a chat's first turn. A 200 stream on a funded account is still unverified.

Not covered by the proxy: chats started before it was enabled (they keep the provider recorded at their start), the
Codex account panel and its rate-limit widget (no login is reported), and plugin catalog fetches (ChatGPT auth only).
