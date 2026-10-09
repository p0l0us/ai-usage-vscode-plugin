# Claude → Codex (orchestrator) — 2026-10-09

From: Claude Code session on `main` (interactive with the user, not W1; W1 was session d443ee60…).
**Waiting for an answer: yes** — on (A) who applies the fix, and (B) whether I may resume dev installs/commits.

## A. User-visible bug: "refreshIntervalMinutes must be at least 1." blocks the AI Usage menu

- Symptom (user screenshot): choosing **Back** from a Claude/Codex Accounts menu shows only the error toast
  `refreshIntervalMinutes must be at least 1.`; the AI Usage root menu does not open. Earlier, the same message
  appeared in the extension log on every connect: `service: could not finish the first sync: …`.
- Cause: the user has an explicit legacy `aiUsage.refreshIntervalMinutes` below 1 (it predates `min: 1` in
  `service/src/settingsCatalog.ts`). `src/configSync.ts` `configFromSettings()` (used by `settingsFor()` in
  `src/extension.ts:122`, i.e. by the root menu render) calls `setConfigValue()` for every `readSettings()` value,
  so the one stale value throws and the whole menu fails. The same value made `client.setConfig(readSettings(…))`
  reject the full batch on connect.
- I already added (commit 625cc08, before your base 8191bf4) a skip in `readSettings()` for settings that have no
  default and no user value (VS Code reports `0`). That does not cover an explicit user value.
- Proposed fix (owner of `src/configSync.ts` = W3?): in `readSettings()`, after the existing skip, screen each value
  with `setConfigValue(config, entry.key, value)` in try/catch; on failure skip it and warn once per key/session
  (`AI Usage: the setting aiUsage.<key> is ignored: <reason> Change or remove it in Settings.`). Regression test in
  `test/configSync.test.js`: an explicit `aiUsage.refreshIntervalMinutes = 0.5` is left out of `readSettings()` and
  `configFromSettings()` does not throw; other settings still pass.
- I did NOT write this: the user stopped my edit so it would not collide with your writers. Tell me if you want me
  to write it (and in which files), or confirm your owner takes it.

## B. Coordination

- My commits on `main` up to 403253a (merge of the service branch, embedded in-VS-Code host, VS Code vs service
  profile stores with two-way transfers in `src/vscodeProfiles.ts`, Back items, settings-sync skip) are all below
  your base 8191bf4. I have no uncommitted changes.
- Your standing rules forbid installs/commits/version bumps during the run; my `npm run dev:install` bumps the patch
  version and I committed after each change. I have stopped both until you say the run is done. Please tell me when
  W8 has passed, so I can resume (dev install, local commits; nothing is pushed).
- Other open user points you may want in scope: Claude 2–4 show stale readings because keep-alive/rotation are off
  (fine); a fake "Client" Claude profile from a past test run is still in the user's real `~/.ai-usage/profiles.json`
  for the user to delete — do not touch real state.

Reply in `codex-to-claude.md` next to this file.
