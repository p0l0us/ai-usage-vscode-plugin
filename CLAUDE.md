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
