# Codex usage reliability: audit, round 2

Date: 2026-10-24. Audited: release 1.9.0, commit `998ec92`, running on this machine since 05:30 UTC today.
Status: findings and recommendations. Nothing here is implemented.

Round 1 (`CODEX_USAGE_RELIABILITY_RECOMMENDATIONS.md`, 2026-10-23, since removed from the tree together with the
two proposal files under `ai/proposals/`) found six reproducible defects in 1.8.0 and made eight recommendations.
1.9.0 implemented most of them in one 862-line change. This round checks that change: whether the six defects are
closed, what the new code introduced, and what the live service measured over the full day of 1.8.0 that preceded it.

Method: I read the complete 1.9.0 diff of the service (`usageCoordinator.ts`, `requestDiagnostics.ts`, and the
changes to `accountAutomation.ts`, `usageMonitor.ts`, `accountService.ts`, `live.ts`, `cache.ts`, `accountProbe.ts`,
`authFiles.ts`, `configStore.ts`, `profileStore.ts`, `statusProjection.ts`), ran the full suite with a temporary
`AI_USAGE_HOME` (1099 tests, all pass), measured `~/.ai-usage/service.log`, Codex's own log database and the new
`request-diagnostics.json`, and timed the new session-log scan against this machine's real `~/.codex/sessions`.
I did not re-run round 1's six reproductions; where I say "closed" I mean the code path is gone and a test named for
it exists in 1.9.0.

## 1. Round-1 defects: all six closed

| # | Round-1 defect | 1.9.0 change | Test |
|---|---|---|---|
| 1 | Two immediate manual checks both reached the provider despite a one-hour `Retry-After` | `checkAccount` refuses while `serverBlockedUntil` is in the future, before and regardless of `ignoreBackoff`; `UsageCoordinator.blocked()` refuses every path, manual included (`accountAutomation.ts:852-855`, `usageCoordinator.ts`) | `manual account reads cannot bypass a persisted server retry deadline`; `status throttling also blocks manual native usage checks through automation` |
| 2 | A keep-alive repeated after 30 minutes following model overload; a quota success cleared the pause | `keepAliveDueAt` = `max(nextKeepAliveAt, lastKeepAliveAt + period)`; `nextKeepAliveAt` = `now + max(period, period × 2^min(5, failures))`, capped at 24 h; usage-only checks leave both fields alone | `model failures with successful quota never accelerate the keep-alive cadence` |
| 3 | `recordBackoff` cut a one-hour server delay to 30 minutes | The cap applies only to the locally computed wait; a server `retryAfterMs` is taken whole, and a deadline never shrinks (`cache.ts:85-90`) | `cache caps local exponential retry but never server delays…`; `full Retry-After survives manual requests, local observations, token refresh and restart` |
| 4 | Auto source did not re-inspect local sources for a whole interval | Codex's local inspection interval is 5 s for `auto`/`both`/`sessionLog`; `lastRateLimitsIn` is an incremental tail reader keyed by inode and size | `Codex session tails handle unchanged files, split appends, truncation and replacement` |
| 5 | Reset-credit lookup ran after the account lock was released | The lookup is inside the `collect` closure that `runFetch` wraps, goes through the coordinator, and is reused for an hour (`usageMonitor.ts`) | `earned credit lookup runs inside the account lock and does not renew credit age` |
| 6 | A monitor cooldown did not stop an immediate automation read of the same account | One `UsageCoordinator` keyed by provider + ChatGPT user + workspace, used by the monitor's `remote`, by `readNativeUsage` and by the automation's probe wrapper; the status bar reuses the automation's reading (`storedActive`) | `concurrent status/automation reads coalesce…`; `automation quota is reused by status without another request` |

Also present and verified: `CodexRpcError` carries status, code and `retryAfterMs` out of `codexRpc`; the
`initialized` notification completes the app-server handshake; child output is bounded (2 MiB stdout, 8 KiB stderr);
revoked logins (`authBlockedFor`) are left alone until the credential changes; new keep-alive schedules are staggered
over five minutes; `backgroundNetwork` pauses every scheduled path while local inspection and manual checks continue.

## 2. Round-1 recommendations: what 1.9.0 did with them

| Rec. | Status in 1.9.0 |
|---|---|
| 1 Unified admission | Done in reduced form: one in-process pending promise per key, a file-backed cache for readings and deadlines, stable identity (`usageAccountKey`), credential generation for discarding results after a switch. No cross-process coalescing beyond the file; sufficient while the daemon is the only writer. |
| 2 Separate usage collection from model keep-alives | **Not done.** The probe is still one combined operation; the default went the other way by decision (hourly prompts). The failure cadence and the revoked-login silence from this recommendation were done. See finding F1. |
| 3 Serialize credential work | Credit lookup moved under the lock; `codexRpc` waits for the child to close before releasing; reset redemption goes through the coordinator's deadline and observe. Lock-order documentation and "owned session" draining were not done. |
| 4 Full server delay, typed errors | Done. Classification is partial: `transient` is derived from status; overload vs throttling vs outage are not separate kinds. |
| 5 Decouple local from remote | 5-second local inspection done without a watcher; attribution deliberately kept conservative (session-log readings remain hints); the five-minute remote fallback was, rightly, not adopted. See F2. |
| 6 Documented adapter, credits with usage | Credits come from the hourly keep-alive for saved accounts and from one CLI read per hour for the active login, carrying their own timestamp. The HTTPS quota read was kept, which is correct: the CLI's `account/rateLimits/read` fetches the same `wham/usage` endpoint upstream, as the service log's own error text shows. |
| 7 Proactive rotation opt-in | Not done; product decision, this machine already uses `trigger: limit`. |
| 8 Freshness, counters, pause | Done: `backgroundNetwork` settings, tooltip lines with retry time and per-hour counters, observation age and source (per changelog; the extension side was not re-read here). See F4 for the counters' limits. |

## 3. Measurements

### 3.1 The full day of 1.8.0 (2026-10-23 05:35 → 2026-10-24 05:30, 23.9 h, from `service.log`)

| Codex calls by the service | Count | Per hour |
|---|---|---|
| Usage reads, active account (HTTPS, native login) | 97 | 4.1 |
| Keep-alives, inactive accounts (model turn + usage read, 6-hour period here) | 14 | 0.6 |
| Switches (login written, verified with a new `codex app-server`) | 8 | 0.3 |
| Usage reads, inactive accounts | 5 | 0.2 (all right after the 07:53–07:56 sign-ins) |
| Stale app-servers ended (local, no provider call) | 11 | 0.5 |

Claude over the same day: 81 keep-alives and 22 usage reads, no errors. Revocations: one, Codex 5 at 07:51 on
2026-10-23 while it was the active login; none since, on either service.

The 4.1 reads an hour average hides the shape: 8.5 an hour in the busy first 8.6 hours, far fewer overnight, because
`activeReadDelayMs` shortens the interval only while a window approaches its threshold.

### 3.2 1.9.0 so far

Eight minutes at the time of writing: `request-diagnostics.json` shows for the partial hour `claude: http 5,
process 3, model 3` and nothing yet for Codex; `request-admission.json` holds four Claude keys with readings and no
deadlines. Too short for rates. The daemon used 31 s of CPU in 7 min 55 s of wall time (6.6 %, RSS 144 MB); see F8.

### 3.3 The 5-second session-log scan on this machine

`~/.codex/sessions` holds 2,644 `.jsonl` files in 37 directories (3.9 GB; 710 files newer than 2026-10-17).
`fetchCodexUsageFromSessionLog()` against it: 21.9 ms wall, 20.9 ms CPU per call, averaged over 20 calls, result
`ok`. At one call per 5 s that is about 0.4 % of a core, almost all of it in `newestFiles`, which still `stat`s every
file in the tree on every call (F9). The incremental tail reader itself is cheap once its cursor exists.

## 4. Findings

Severity: **High** = provider load or correctness, **Medium** = freshness or robustness, **Low** = cost or hygiene.

### F1 (Medium): a failing model prompt now suspends the account's only usage read

The keep-alive is still one operation: prompt, then usage read, and `probeAccount` reads usage even when the prompt
failed. 1.9.0 gates the whole operation on `nextKeepAliveAt`, which doubles after each failed prompt up to 24 hours.
With `checkInactiveAccounts` off (the 1.8.0 default) nothing else reads an inactive account. So after six consecutive
"model at capacity" answers, which is a passing condition on OpenAI's side, an inactive account's quota and login
liveness go unread for a day, and rotation ranks it on day-old numbers. 1.7.0 shortened this retry for the opposite
reason; round 1 asked for the two operations to be split, not for the usage read to inherit the prompt's backoff.

Fix: keep one `nextKeepAliveAt` for the usage read at the plain period, and add `nextPromptAt` that backs off. In
`checkProvider`, when the account is due but `nextPromptAt` is in the future, call `checkAccount(…, keepAlive=false)`
with `creditsRead: true` (it then uses the CLI, which also returns credits). Tests in
`service/test/accountAutomation.test.js`: after two failed prompts, the next hour still produces a usage read and no
process with a prompt.

### F2 (Medium): the active account is still read from the endpoint at the full interval

1.9.0 keeps the monitor's session-log readings as hints and reconciles "against an account-scoped reading at the
configured deadline even while such hints arrive" (`usageMonitor.ts`, `fetch`, `authorityFresh`). The automation's
`refreshDue` reads the active account every `activeReadDelayMs` (floor to `checkIntervalMinutes`, 5 minutes on this
machine), and the monitor now reuses that reading rather than making its own. Net effect: the ≤12 unlogged status-bar
fallbacks an hour from round 1 should be gone (verify with the `http` counter after a day), but the 4–8 endpoint reads
an hour of the active login remain, and they are now the largest source apart from the keep-alive you chose.

The reason given for not crediting session-log readings is that session creation metadata cannot prove which login
made a later turn. Two facts narrow that: Codex processes keep their login in memory after `auth.json` changes (the
reason `terminateStaleDaemons` and the proxy exist), and a record is accepted only when its `creator_user_id` equals
the native login's user id *and* its timestamp is after the last login change. A wrong attribution then needs a
process whose in-memory login differs from `auth.json` while its session was created under the login that is in
`auth.json` now: a process would have to load a credential from somewhere other than the file the service writes.
The residual case is a Codex configured for the keyring store rather than `cli_auth_credentials_store="file"`; the
service's own `config.toml` sets the file store, and that condition can be checked before trusting the log.

Recommendation: keep the reconciliation but lengthen it while attributable readings arrive: read the endpoint when
no attributable record is younger than `max(checkIntervalMinutes, 15 min)`, when a hint reaches a threshold, after a
reset, and before a switch; otherwise credit the record. Ship it first as a comparison build that logs
`codex: session log N% vs endpoint M%` at every reconciliation and rely on the log only after a day of agreement.
Note that `AccountAutomation.observe` already has a `source === 'sessionLog'` branch that production appears never
to reach, since the monitor marks every session-log reading non-attributable; either remove it or make it the target
of this change.

### F3 (Low–Medium): `codexRpc` can now wait forever for `close`

`finish()` stores the resolve/reject and runs it only from `child.on('close')`, after `kill()` and a 1-second
`SIGKILL`. That is the right order for the credential lock, but `close` fires only when the process has exited *and*
all stdio pipes are closed. A grandchild inheriting the pipes, which `SIGKILL` on the child does not reach, leaves the
promise pending; the coordinator's `pending` entry (deleted in `finally`) and the caller's account lock stay held,
and every later check of that provider is "deferred" until the service restarts. Fix: a second timer after the
`SIGKILL` (5 s) that runs `complete` with a rejection naming the condition, and a test with a fake child that exits
but keeps a pipe open.

### F4 (Low): the counters answer less than the plan needs

`RequestDiagnostics` is provider-level, shows only the current UTC hour in the tooltip (close to zero just after the
hour), has no operation reason, and `record()` rewrites its JSON file on every single event including cache hits and
blocks. Suggested: show the previous full hour next to the current one or a rolling 60 minutes; add an operation
dimension (`usage`, `credits`, `keepAlive`, `verify`, `reset`) so the before/after tables in this series can be read
off it; debounce the write to once per few seconds. The per-account view stays in `service.log` and the usage history.

### F5 (Low): two `UsageCoordinator` instances on one file

`UsageMonitor` constructs its own coordinator on `state/request-admission.json` even though `AccountService` passes
`remote`, so the monitor's instance is dormant in production and only tests use it. If both ever write, the file-backed
`SharedCache` has no merge; last writer wins. Either inject the service's coordinator or do not construct one.

### F6 (Low): a blocked keep-alive resets the prompt backoff

When the coordinator refuses a keep-alive (deadline in force), `checkAccount` still computes
`modelFailures: outcome.keepAliveError ? previous + 1 : 0`, and the blocked result has no `keepAliveError`, so the
failure count returns to zero without a prompt having been sent. The next attempt after the deadline runs at the plain
period. Minor, and moot once F1 separates the two schedules.

### F7 (Info): synthetic "paused" results are shown as account problems

When the probe wrapper returns the coordinator's blocked result for an account not yet marked, the account's
`lastError` becomes `Usage requests paused until …Z.` and `explainAccountProblem` shows that text verbatim as the
problem label, once, until the deadline passes. That is the intended "show why and when", but a short label
("Paused by the provider") with the time in the detail would read better.

### F8 (Low): daemon CPU is worth a profile

6.6 % of a core averaged over the first eight minutes of 1.9.0 is more than an idle poller should need. The
session-log scan explains about 0.4 % (3.3). Candidates for the rest: `nativeRequestKey` reading and JWT-decoding
`auth.json` on every status request from every window, the per-event diagnostics write, the 5-second status pushes.
A ten-minute `node --cpu-prof` of the daemon before the next release would settle it; I did not profile.

### F9 (Low): `newestFiles` still walks and stats the whole sessions tree every 5 seconds

The 1.9.0 change sorts entries by name and caps the walk at 8,192 entries, but it still `stat`s every `.jsonl`
(2,644 here) to find the six newest. The directories are dated (`YYYY/MM/DD`); walking them newest-first and stopping
once six files have been found in the newest day or two reduces 21 ms to about 1 ms. Cache the per-directory
`mtime` and skip unchanged directories for the rest.

### F10 (Low): one automatic `codex app-server` an hour still runs on the active login

`nativeCodexCredits` reads the earned-reset count through `fetchCodexUsageCli` in `~/.codex`, the native home, once
an hour under the lock. This is not a second installation, so it is unlike the revoked-login pattern, but it is the
one remaining scheduled process start on the login in use, and it can refresh that login underneath the user's own
Codex processes. Options: read credits only while `statusBar.earnedResets` is on and a reset could matter (near a
threshold, after a redemption, on opening the details view), or extend the reuse to the keep-alive period.

### F11 (Info): the hourly keep-alive on this machine

Claude moved to one hour (5 accounts, so about 120 `haiku` turns a day, up from 81 at 2 hours); Codex stays at 6
hours because `aiUsage.codex.keepAlive.periodHours: 6` is set explicitly in the Machine settings. The first minutes
show no errors. What to watch over the next week: `login was revoked` lines per day in `service.log`, and the
`model` counter per hour against the revocation times.

## 5. Recommendations for round 3, in order

1. **F1** split the prompt's backoff from the usage read. Small change, restores the freshness the hourly keep-alive
   was meant to give.
2. **F2** credit attributable session-log readings and lengthen the reconciliation, behind a one-day comparison build.
   This is the last large reduction available: it takes the active login from 4–8 endpoint reads an hour to about one.
3. **F3** bounded completion in `codexRpc`.
4. **F9 and F8** cheaper tree walk, then a CPU profile.
5. **F4** counters by operation with a rolling window and debounced writes, so the next audit can be read off them.
6. **F5, F6, F7, F10** hygiene, in any order.

Regression gates stay as in round 1: run the suite with a temporary `AI_USAGE_HOME`; a repeated run against the same
temporary home produced a spurious "This account home belongs to another profile" failure on 2026-10-22.
