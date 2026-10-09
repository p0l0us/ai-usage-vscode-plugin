# W1 design 3: file-lease ownership (W6-005, third and final attempt)

Author W1 (Claude Opus), 2026-10-09. For W6 audit agreement.

**Disclosure:** design A below is already implemented in `service/src/runtimeLease.ts`, with regressions in
`service/test/engineHost.test.js`. I wrote it before reading the 10:39 root steering ("STOP editing runtimeLease until
design reviewed"). Since that note I have made no edits to `runtimeLease.ts`. If the auditor rejects A, or prefers B,
W1 switches only to the design agreed here and makes no other change. That is still attempt 3, not a fourth attempt
under another name.

Scope: the file lease is the default only on platforms other than Linux and Windows (macOS). Linux and Windows use the
OS-released abstract socket / named pipe, which this note does not change. Tests force the file lease on Linux.

## Why attempts 1 and 2 failed
Both reclaimed a dead owner by removing or moving its file at a single pathname (`engine.lock`). Removing a file only
if it still holds the content we saw cannot be done atomically on POSIX. Between reading the file and removing it,
the content can change from the dead owner's to a live successor's. Attempt 1 stole the reclaim guard by age.
Attempt 2 renamed the file before verifying it, which left the path vacant; a third contender then claimed it.

## Design A (implemented): immutable numbered claims, no reclaim of a pathname
Directory `engine.lease/`. Each claim is `g<16 digits>.json` and holds
`{pid, instanceId, startedAt, processStart}`. A released claim gets an empty `g<n>.released` marker next to it.
- **R1 Publish complete.** The record is written to a private temporary file `.claim-<pid>-<uuid>.tmp`, then
  `link()`ed to `g<n>.json`. The link fails with `EEXIST` if the name is taken. A claim file is never modified,
  renamed or truncated.
- **R2 No foreign deletion.** A claim is deleted only by its own claimant (`withdraw`), and only after that claimant
  saw a higher claim, i.e. before it ever became owner. Nobody deletes or moves another process's claim. Release
  writes a marker and deletes nothing.
- **R3 Claim the next number only after a provable end.** A contender lists the directory and takes the highest claim
  n. It links `g<n+1>` only if n's claimant was released, or has provably exited. "Exited" means no such pid exists,
  or that pid now has a different process start identity (Linux `/proc/<pid>/stat` field 22, `ps -o lstart` on
  macOS). Any doubt counts as alive: an unreadable claim, EPERM, an unreadable start identity. Nothing is ever taken
  over because of age.
- **R4 Verify after publishing.** Having linked `g<k>`, the contender owns the home only if a fresh listing shows no
  claim above k. Otherwise it withdraws (R2) and retries, up to 16 attempts; then it reports busy.
- **Owner checks.** `held()` / `assertHeld()` re-read the owner's own claim (and the absence of its marker) before
  every write. A periodic check also verifies the claim is still the highest. This only detects outside interference,
  such as an operator deleting files. Under R1 to R4 nothing else can change the answer.

### Proof sketch
Any number of contenders, arbitrary pauses, and crashes at any step.
- **(a)** The highest claim ever published, H, is never deleted. Under R2 only a claimant that saw a higher claim
  deletes its own claim, and nothing is higher than H. Its claimant is either the owner or dead; neither withdraws.
  So H is present for the whole of any directory listing, and `readdir` reports every entry that exists throughout
  the listing.
- **(b)** The only claim that can be published above H is `g<H+1>`. R3 claims "highest seen + 1", so any higher
  number needs `g<H+1>` to exist first. Linking `g<H+1>` requires H's claimant to have exited or released. A stale
  reading only produces `EEXIST`, or a claim below H that R4 then withdraws.
- **(c)** Owner P of `g<p>` saw no claim above p after linking, so p = H at that moment, by (a). While P lives and has
  not released, (b) forbids any claim above p. Every other contender therefore either gets `EEXIST` or publishes a
  lower claim and withdraws it. **No contender ever removes, moves or vacates `g<p>`.**
- **(d)** Crash recovery is automatic and needs no timeout:
  - Crash before the link: only a temporary file remains. It is removed once its pid has exited.
  - Crash after the link (owner or verifier): a complete claim whose pid is gone. The next contender links the
    following number.
  - Partial publication is impossible because of R1.
  - A reused pid with another start identity counts as exited.
  - A reused pid with no readable identity fails closed.

### Regressions (`service/test/engineHost.test.js`)
All of these pass, 37/37 in the file, under the validation flock, with the `fixtureNetwork` preload and temporary
HOME, AI_USAGE_HOME, CODEX_HOME and CLAUDE_CONFIG_DIR.
- **Three contenders, suspended reclaimer** (the precise W6-005 scenario).
  1. A observes dead D at claim 1 and is suspended.
  2. B acquires claim 2.
  3. C is refused.
  4. A resumes: its stale claim gets `EEXIST`, and its fresh look sees B held.
  5. A and C retry concurrently: both refused.
  6. B's claim fingerprint (inode, size, mtime, content) is unchanged at every step. The directory holds exactly
     claims 1 and 2. `B.held()` stays true throughout.
  7. After B releases, the next contender gets claim 3, and claim 2 is still untouched.
- **Stale claim below the owner.** A's stale claim of a vacated lower number is published, the R4 check fails, and
  A withdraws. B is untouched, and new contenders are refused.
- **Live incumbent's admitted work.** A file-lease host has an import queued behind a held sweep. The stale publish
  gets `EEXIST`, and a new host gets `owner-running`. Once released, the admitted import completes and is saved; the
  incumbent's claim and info file are unchanged.
- **Real processes.** Six child processes race on one home that has a dead claim: exactly one owner. Repeated 15/15
  stress runs, together with the three-contender and stale-claim tests.
- **Crash cases:**
  - A child holding the lease is SIGKILLed: the lease is recovered.
  - Crash before publication: the temporary file is removed.
  - Crash after publication: recovered by the next number, and the dead claim is left as it was.
- **Partial or unreadable claim:** fails closed, and `leaseHeld` reports it held.
- **PID cases:**
  - A live pid with a matching start identity: busy.
  - A live pid with no identity: busy (fail closed).
  - A reused pid with a different identity: recovered.
- **Release marker:** the same process and others take the next number.
- **Missing home under a symlinked parent** (W6-001): one lease.

### Cost and limits (please weigh these)
- **Tombstones grow without bound:** one claim of about 150 B per engine start, plus one empty marker per clean
  stop. Collecting old claims safely would need a floor protocol. Attempt 3 deliberately does not include one,
  because deleting old claims re-opens the "listing misses the highest claim" gap. This conflicts with the root note
  "no infinite tombstone".
- PID reuse on a platform where the start identity is unreadable fails closed. Recovery then needs the operator to
  remove `engine.lease/`.
- Deleting live claims by hand is detected before the next write and stops the owner. It is not prevented.

## Design B (reviewer-preferred alternative): an OS-released loopback lease on file-lease platforms
On macOS and other non-Linux/Windows platforms, bind a TCP listener to `127.0.0.1:<port>`.
- The port is deterministic: `49152 + (sha256(uid + canonical home) mod 16384)`.
- The OS releases it on exit or crash, so there is no file, no reclaim and no tombstone.
- The listener accepts no connections; incoming connections are destroyed.
- `EADDRINUSE` means held → fail closed. A collision with an unrelated listener or another home produces a clear
  error naming the port.
- Leases never move to another port.
- `leaseHeld`: a connection that is refused means free; anything else means held.
- Squatting by another local user denies service; it never produces a second engine. This matches the OS lease.
- Same tests as for the OS lease, plus a fail-closed collision test with an occupied port.

## Recommendation
**B is preferable** if the auditor accepts its fail-closed collision behaviour: it has no tombstones and no
filesystem protocol. **A** is correct as proven above, and is already implemented and tested, but it grows by one
small file per start. W1 asks the auditor to choose A or B. W1 will apply B, or keep A, only after that agreement,
and will make no other changes to this invariant.
