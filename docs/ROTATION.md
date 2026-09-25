# Account rotation: strategies and thresholds

Automatic rotation switches the active Claude or Codex login to another saved profile. Two separate questions decide
what happens:

- **When** to switch, set by the thresholds and `autoRotate.trigger`.
- **Where** to switch to, set by `autoRotate.strategy`.

The settings themselves are listed in [Account automation](CONFIGURATION.md#account-automation). All examples below
use the Claude defaults (5-hour threshold **95**, weekly threshold **99.5**, trigger `limit`) unless they say
otherwise. A week is 168 hours.

- [Thresholds](#thresholds)
- [What starts a rotation](#what-starts-a-rotation)
- [Choosing the next account](#choosing-the-next-account)
  - [`sequential`](#sequential)
  - [`soonestReset`](#soonestreset-default)
  - [`evenPace`](#evenpace)
  - [`leastWaste`](#leastwaste)
  - [The four strategies side by side](#the-four-strategies-side-by-side)
  - [Details shared by the ranking strategies](#details-shared-by-the-ranking-strategies)
- [Proactive switching](#proactive-switching)
- [Which setup to choose](#which-setup-to-choose)
- [Safety](#safety)
- [Codex](#codex)

## Thresholds

Every usage window of an account has a threshold, set by the kind of window:

| Window | Claude | Codex |
| --- | --- | --- |
| 5-hour (`5h`) | `autoRotate.fiveHourThresholdPercent`, default **95** | fixed at **100** (only a used-up window) |
| Weekly, all models (`7d`) | `autoRotate.weeklyThresholdPercent`, default **99.5** | `autoRotate.weeklyThresholdPercent`, default **99** |
| Weekly, one model (`7d Fable`) | the weekly threshold, when `autoRotate.modelLimits` counts the window | — |

The thresholds are used in two ways:

- **When to rotate.** The active account is *at its limit* as soon as any counted window's usage is **at or above**
  its threshold (`usage ≥ threshold`).
- **Where to rotate to.** An account can only be switched to while **every** counted window is **below** its
  threshold. This applies to every strategy and to both triggers. An account at exactly the threshold is not a
  candidate, so it is never switched to only to be rotated away again.

**Example: when and where.**

| Account | `5h` | `7d` | At its limit? | Can be switched to? |
| --- | --- | --- | --- | --- |
| A (active) | 95% | 40% | yes, 5h ≥ 95 | — |
| B | 94% | 99% | no | yes, both below their thresholds |
| C | 20% | 99.5% | yes, 7d ≥ 99.5 | no |
| D | 96% | 10% | yes, 5h ≥ 95 | no |

A rotates, and B is the only possible target, whatever the strategy. B has little room left, so it will soon rotate
again; when no account qualifies, the active one is kept (see below).

**Example: a lower threshold also limits the other accounts.** With `weeklyThresholdPercent` set to 90, an account
at 92% weekly is neither kept as the active account nor switched to. The remaining 8% of its week stays unused.

**Example: no account qualifies.** A (active) reaches 5h 95%, B has 7d at 99.7% and C has 5h at 98%. The active login
is kept, the AI Usage log names the window that reached its threshold (`5h 95% ≥ 95%`), and a notification says once
that no account is available. It is shown again only after a switch, or after the active account has been below its
thresholds again. Another sweep runs after `aiUsage.<provider>.checkIntervalMinutes`, so C qualifies again once its
5-hour window resets.

**Model-scoped windows.** `autoRotate.modelLimits` (Claude) decides whether `7d Fable` counts at all:

- `auto` counts it when Claude Code's `model` setting is Fable or unset.
- `always` counts it.
- `never` ignores it.

A window that does not count neither starts a rotation nor blocks a candidate. With `modelLimits: auto` and Claude
Code set to Sonnet, an account at `7d Fable` 100% and `7d` 30% is a normal candidate.

## What starts a rotation

- A reading of the active account that reaches a threshold starts a sweep at once, without waiting for the
  one-minute scheduler. A reading at most 2 minutes old counts as the active account's current reading, so the
  rate-limited usage endpoint is not asked again.
- Codex's status bar usually reads the session logs, which do not name an account, so their figures are never stored
  as a profile's reading. When they show a threshold reached, the next sweep reads the active account itself instead
  of trusting its stored reading, which may be hours old.
- Without such a reading, the one-minute scheduler looks at the stored reading of the active account. Keep-alives
  (when enabled) keep those readings current.
- When the active account cannot be read (its checks are paused after a provider error), the sweep is retried as
  soon as that pause ends, not a full check interval later.

Every sweep first needs a successful current reading of the active account. If that reading turns out to be below
every threshold, nothing is switched (with the `proactive` trigger, the sweep goes on to look for a
[clearly better account](#proactive-switching)). Sweeps are spaced by the provider's check interval.

## Choosing the next account

Candidates are visited in the order the strategy ranks them, and the first one that passes is switched to. At most
one switch is made per sweep. Before switching, each candidate in turn is read again (it must still be below every
threshold and report every counted window the active account reports) and is sent a keep-alive, because a usage
reading alone does not prove that the login works. A candidate that fails either check is skipped, and a broken
login is reported.

The strategy only decides the **order**. With the default `limit` trigger, every strategy switches exactly once per
threshold reached; only [proactive switching](#proactive-switching) makes the strategy start switches of its own.

### `sequential`

The saved profiles after the active one, in list order, wrapping once. No score is computed.

**Example.** Profiles are saved as A, B, C, D, and B is active and at its limit. Rotation tries C, then D, then A. If
C's 5-hour window is at 97%, C fails the fresh check and D is chosen. The next time D reaches its limit, rotation
tries A, B and C in that order.

Choose `sequential` when you want predictable order, for example a main account followed by backups.

### `soonestReset` (default)

**Score: hours until the weekly window resets. Lowest first.** Allowance that is about to expire is spent before it
is lost.

**Penalty:** an account more than **10 points ahead** of an even spend, with **more than half** of its week left,
goes to the back of the queue. This stops a fresh week from being used up in its first days just because its reset
happens to be the nearest one.

**Example: plain ranking.**

| Account | `7d` used | Resets in | Score |
| --- | --- | --- | --- |
| A | 70% | 20 h | **20** ← chosen |
| B | 10% | 60 h | 60 |
| C | 0% | 150 h | 150 |

A has the least left, but that 29.5% is gone in 20 hours anyway, while B and C keep their allowance for longer.

**Example: the penalty.**

| Account | `7d` used | Resets in | Elapsed share of week | Even spend | Ahead by | Score |
| --- | --- | --- | --- | --- | --- | --- |
| E | 60% | 96 h (4 days) | 43% | 43% | **+17** | 96 + penalty |
| F | 10% | 144 h (6 days) | 14% | 14% | −4 | **144** ← chosen |

E resets sooner, but it is 17 points ahead of an even spend with more than half its week left, so it goes last.

### `evenPace`

**Score: used % minus the share of the week already elapsed. Lowest first.** Picture a straight line from 0% at the
start of each account's week to 100% at its reset; the account furthest **below** its line is chosen. No account
runs out early, and all accounts use up their week at about the same time.

`elapsed share = 1 − hours until reset ÷ 168`

**Example.**

| Account | `7d` used | Resets in | Elapsed share | Score (used − elapsed) |
| --- | --- | --- | --- | --- |
| A | 88% | 12 h | 92.9% | −4.9 |
| B | 30% | 96 h | 42.9% | −12.9 |
| C | 0% | 120 h | 28.6% | **−28.6** ← chosen |

C is furthest behind its line, so it is used first, even though A's remaining 11.5% expires in 12 hours.

`evenPace` pays off most with the [proactive trigger](#proactive-switching), which keeps every account close to its
line while you work. With the `limit` trigger it only decides where to land when the active account is exhausted.

### `leastWaste`

**Score: weekly allowance left per hour until reset. Highest first.** Allowance left is the weekly threshold minus the
usage, so 99.5 − used with the defaults. This spends accounts in proportion to how quickly their allowance would
otherwise go to waste.

**5-hour bonus:** when an account's 5-hour window still has room and resets **within the hour**, its rate is raised
by 10%, because that unused 5-hour allowance is lost too.

**Example: plain ranking.**

| Account | `7d` used | Resets in | Allowance left | Per hour |
| --- | --- | --- | --- | --- |
| A | 88% | 12 h | 11.5 | **0.96** ← chosen |
| B | 30% | 96 h | 69.5 | 0.72 |
| C | 0% | 120 h | 99.5 | 0.83 |

**Example: the bonus decides.**

| Account | `7d` used | Resets in | Per hour | `5h` | Final |
| --- | --- | --- | --- | --- | --- |
| G | 50% | 72 h | 49.5 / 72 = 0.69 | 60%, resets in 40 min | 0.69 × 1.1 = **0.76** ← chosen |
| H | 40% | 80 h | 59.5 / 80 = 0.74 | 10%, resets in 3 h | 0.74 |

Without the bonus H would win. G's remaining 5-hour allowance would be lost in 40 minutes, so G goes first.

### The four strategies side by side

The same three candidates as above, each picked by a different rule:

| Account | `7d` used | Resets in | `sequential` | `soonestReset` | `evenPace` | `leastWaste` |
| --- | --- | --- | --- | --- | --- | --- |
| A | 88% | 12 h | next in list | **12 h** ✅ | −4.9 | **0.96 %/h** ✅ |
| B | 30% | 96 h | next in list | 96 h | −12.9 | 0.72 %/h |
| C | 0% | 120 h | next in list | 120 h | **−28.6** ✅ | 0.83 %/h |

- `soonestReset` picks A because it resets first.
- `leastWaste` also picks A, but because it would waste the most per hour. If A reset in 40 hours instead
  (11.5 / 40 = 0.29 %/h), `leastWaste` would pick C while `soonestReset` would still pick A.
- `evenPace` picks C because it is furthest behind its line.
- `sequential` picks whichever comes next in the saved list.

### Details shared by the ranking strategies

These apply to `soonestReset`, `evenPace` and `leastWaste`:

- **Ranking uses stored readings.** Candidates are ranked from the readings already collected for each account (by
  keep-alives, the status bar and earlier sweeps), so ranking costs no endpoint calls. Only the candidates actually
  tried are read again.
- **Order of groups.** Accounts whose stored reading looks usable come first, best score first. Then usable accounts
  that report no weekly window, then those that look exhausted, then accounts never read. Ties keep saved-profile
  order. Accounts that look exhausted are still tried, because a fresh reading may show that they have recovered.
- **A reset since the reading counts as fresh.** A stored reading of `7d` 97% with a reset time that has since passed
  is ranked as 0% used, with its next reset one week later. The account is still read again before any switch.
- **Headroom is measured up to the thresholds.** "Allowance left" is the threshold minus the usage, not 100 minus the
  usage.
- **The 5-hour window only blocks.** It does not change the ranking, except for `leastWaste`'s bonus. It acts through
  its threshold: an account at 5h 96% is never switched to, however good its weekly score.
- **Several weekly windows: the tightest one decides.** When both `7d` and `7d Fable` count, `soonestReset` uses the
  window with the least allowance left, `evenPace` the one furthest ahead of its line, and `leastWaste` the lowest
  rate.

**Example: several weekly windows.** Account J has `7d` at 40% resetting in 24 h and `7d Fable` at 90% resetting in
100 h.

| | Only `7d` counts (`modelLimits: never`) | `7d Fable` counts too |
| --- | --- | --- |
| `soonestReset` | 24 h, a strong candidate | Fable has less left: 100 h, and 90% is 49 points ahead of an even spend with over half the week left, so it gets the penalty |
| `evenPace` | 40 − 85.7 = −45.7, a strong candidate | Fable: 90 − 40.5 = **+49.5**, near the end of the queue |
| `leastWaste` | 59.5 / 24 = 2.48 %/h | Fable: 9.5 / 100 = **0.095 %/h** |

If you do not use Fable, `modelLimits: never` (or `auto` with another model configured) keeps a busy Fable window from
hiding an account that has plenty of general allowance.

## Proactive switching

With `autoRotate.trigger: proactive` (Claude only, and not with `sequential`), a working account is also left when a
candidate scores **clearly better**. This is the setup that rotates while you work, based on how usage relates to
each account's reset time. It applies these rules:

- **Margin.** The candidate must beat the active account by:
  - at least 3 hours sooner reset with `soonestReset`,
  - at least 5 points further behind its line with `evenPace`,
  - at least 0.1 %/hour more allowance with `leastWaste`.
- **Minimum stay.** No proactive switch happens within `autoRotate.minStayMinutes` (default 30) of an account becoming
  active, automatically or by hand.
- **Thresholds still apply both ways.** A proactive target must be below every threshold, like any other target. When
  the active account reaches a threshold it is rotated at once, without waiting for the minimum stay and without the
  margin.
- **Two readings must agree.** The candidate has to score better on its stored reading and again on a fresh one.
  Endpoint calls are only made once the stored readings show such a candidate, and only candidates that look usable
  in their stored reading are considered.
- **Spacing.** At most one switch per sweep, and sweeps are spaced by the provider's check interval.

**Example: `evenPace` with `proactive`.** A (active) is at `7d` 70% with 72 hours to its reset. Its week is 57.1%
elapsed, so it is 12.9 points ahead of its line.

| Candidate | `7d` used | Resets in | Score | Better by at least 5? |
| --- | --- | --- | --- | --- |
| B | 40% | 96 h | 40 − 42.9 = −2.9 | yes: −2.9 + 5 = 2.1 < 12.9 → switch to B |
| D | 60% | 90 h | 60 − 46.4 = +13.6 | no |
| K | 30% | 100 h | 30 − 40.5 = −10.5 | yes, and best, but its `5h` is at 96% → not eligible |

After 30 minutes on A, the extension switches to B. Had K's 5-hour window been below 95%, K would have been chosen.
Once on B, it stays at least 30 minutes, then the comparison starts again from B.

**Example: `soonestReset` with `proactive`.** The active account's weekly window resets in 100 hours. A candidate
resetting in 98 hours is not 3 hours sooner, so nothing happens. A candidate resetting in 90 hours (and not
penalized) is.

**Example: the threshold overrides the minimum stay.** Ten minutes after a proactive switch to B, B's 5-hour window
reaches 95%. Rotation starts at once and picks the best eligible account; the minimum stay and the margin do not
apply.

## Which setup to choose

| Goal | Strategy | Trigger |
| --- | --- | --- |
| Use a main account until its limit, then fixed backups | `sequential` | `limit` |
| Waste as little expiring weekly allowance as possible, few switches | `soonestReset` or `leastWaste` | `limit` |
| Keep every account on schedule so none runs dry early | `evenPace` | `proactive` |
| Actively move to whichever account would otherwise waste the most | `leastWaste` | `proactive` |

A proactive switch changes the login mid-session. Claude picks up the new login on its next request; see
[Safety](#safety) for Codex.

## Safety

- Missing, failed, incomplete or expired candidate readings never authorize a switch.
- A candidate must pass a real keep-alive request before it is activated.
- The selected account must still match the native login immediately before activation, so a switch made meanwhile
  in another window or by the vendor CLI is not overwritten.
- There is no memory of past exhaustion: an account that was rotated away from becomes a candidate again as soon as
  a fresh reading shows it below every threshold, for example after its window has reset.

As with manual switching, Claude picks the new login up on its next request. Open Codex chats follow it on their next
turn when the Codex account proxy is on, and otherwise need the extension restart described in
[What happens to running Codex sessions](CONFIGURATION.md#what-happens-to-running-codex-sessions).

## Codex

Codex always rotates `sequential` and only at a threshold: `strategy`, `trigger`, `minStayMinutes` and `modelLimits`
do not apply. Its weekly threshold is `aiUsage.codex.autoRotate.weeklyThresholdPercent` (default **99**), and a Codex
5-hour window, when reported, blocks an account or starts a rotation only once it is used up (100%). API-key-only
Codex profiles report no subscription windows and are never rotation targets.

**Example.** Codex profiles are saved as W, X, Y, and W is active. W reaches `7d` 99%. X is at `7d` 99.2% and is
skipped, so Y (`7d` 40%, `5h` 100%) is checked next. Its 5-hour window is used up, so Y is skipped too, and W is kept
with a notification until X or Y recovers.
