# Project instructions

## Version numbers

Follow semantic versioning; details in [docs/PUBLISHING.md](docs/PUBLISHING.md#version-numbers).

- **Patch = bug fixes, and every dev install.** `npm run dev:install` bumps the patch version itself
  (`package.json`, `package-lock.json`, and the open `## x.y.z (unreleased)` CHANGELOG section moves along). Do not
  install dev builds any other way, do not set `AI_USAGE_DEV_VERSION` unless asked, and commit the bumped files with
  the change they were built for.
- **Minor = new features, only when publishing.** When the open CHANGELOG section lists a new feature, release with
  `npm run publish -- --minor`; it bumps to the minor after the published version and carries the notes. A release
  with only fixes is a plain `npm run publish`. Never bump the minor version outside a publish.
- **Major** only when the user asks.
- Before publishing, check the live Marketplace version (`npx @vscode/vsce show p0l0us.ai-usage-vscode-plugin --json`)
  and write every change into the open CHANGELOG section first; the publish script refuses an empty one.
- **The account service release is 1.x.** The user chose 1.0.0 for the first release that ships the account service
  (merged into `main` on 2026-10-07); dev installs continue from there (1.0.1, 1.0.2, …).

## Tests

- Tests must never read or write the real account service home (`~/.ai-usage`). Set `AI_USAGE_HOME` to a temporary
  directory in every fixture that creates a profile store or service, and run the suite with
  `AI_USAGE_HOME=<temp dir> npm test` when in doubt. One run once wrote a fake profile into the real store.
