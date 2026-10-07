# Development and publishing

## Development

```bash
npm install
npm run dev:install      # build the working tree to a temp VSIX and install it into this VS Code
```

`dev:install` bumps the patch version, compiles, packages to a temporary folder, and installs into the VS Code
that owns the current shell: the remote server in Remote-SSH/WSL/container sessions, otherwise the desktop `code`
CLI. The bump (`npm run bump patch --carry`) updates `package.json` and `package-lock.json` and moves the open
`## x.y.z (unreleased)` section of `CHANGELOG.md` to the new version, so every dev build has its own version and a
later Marketplace release still replaces it. `AI_USAGE_DEV_VERSION=<x.y.z>` installs that version instead and
leaves the repository alone. Use `npm run dev:install:all` to install into every VS Code found. Reload the window
afterwards.

### Version numbers

- **Patch** (`x.y.Z`): bug fixes. Every `npm run dev:install` bumps it, and a release with only fixes publishes
  the patch version the dev installs reached.
- **Minor** (`x.Y.0`): new features. Only a publish bumps it: `npm run publish -- --minor` sets the version to
  the minor after the published one and carries the open changelog section to it.
- **Major** (`X.0.0`): by hand, `npm run bump major`.
Manual equivalent:

```bash
npm run compile          # regenerates chat-chip commands in package.json and compiles TypeScript
npx @vscode/vsce package --no-dependencies -o /tmp/ai-usage.vsix
code --install-extension /tmp/ai-usage.vsix --force
```

`src/live.ts` and `src/cache.ts` have no dependency on the `vscode` module, so provider readers can be exercised
directly with Node:

```bash
node -e "require('./out/live.js').fetchCodexUsageCli().then(r => console.log(JSON.stringify(r, null, 2)))"
```

Please keep provider code in `src/live.ts` free of `vscode` imports, and run `npm run compile` before pushing so the
generated manifest stays in sync.

## Publishing a release

Maintainers publish to the Visual Studio Marketplace with [`@vscode/vsce`](https://github.com/microsoft/vscode-vsce).
The manifest already carries the publisher id (`p0l0us`), repository, license, icon and keywords the Marketplace needs.

### One-time setup

1. Create the publisher at <https://marketplace.visualstudio.com/manage>. Its id must equal the `publisher` field in
   `package.json` (`p0l0us`).
2. Create an Azure DevOps Personal Access Token: <https://dev.azure.com> → User settings → Personal access tokens →
   New token, **Organization: All accessible organizations**, **Scopes: Marketplace → Manage**. Copy the token.
3. Either log in once (`npx @vscode/vsce login p0l0us`, paste the token) or export it as `VSCE_PAT` before each
   publish. On machines without a credential store `vsce login` saves the token in plain text under `~/.vsce`, so
   prefer the environment variable there.

### Release steps

```bash
npm run publish            # checks the Marketplace, offers a bump if the version is taken, builds, packages, publishes
npm run publish:pre        # same, as a pre-release
npm run publish:all        # also publishes to Open VSX (needs OVSX_PAT)
npm run publish -- --minor # a release with new features: bumps to the next minor version first
npm run publish -- --yes   # non-interactive: auto-bumps patch when needed, no confirmation prompts
npm run publish:dry        # everything except the publish step (builds and packages to a temp folder)
```

`npm run publish` queries the Marketplace for the versions already published. If `package.json` has a version that
exists there or is not newer than the latest, it offers to bump patch/minor/major (via `npm run bump`, which also
opens a new changelog section) and refuses to continue otherwise. It then compiles, packages to a temporary folder
and publishes with `VSCE_PAT` or the stored `vsce login`. After a successful publish it asks whether to commit,
tag and push; fill in `CHANGELOG.md` before answering `y`. Confirming runs:

```bash
git add -A && git commit -m "Release vX.Y.Z" && git tag vX.Y.Z && git push && git push --tags
```

The step is skipped (and the commands printed for manual use) when you answer `n`, when running with `--yes` or
without a terminal, or when the tag already exists.

Manual equivalent: `npm run bump`, `npm run compile`, `npx @vscode/vsce package --no-dependencies`,
`npx @vscode/vsce publish --no-dependencies`.

`--no-dependencies` is required: the extension has no runtime npm dependencies and the flag stops `vsce` from
inspecting `node_modules`.

README screenshots live in `images/screenshots/` and are bundled in the VSIX. Screenshots must not show real
email addresses, account names or home directories: the ones in the repository use `userN@example.com` and `~`,
and are cropped to the widget they show. `dev:install` packages with
`--no-rewrite-relative-links`, so the extension page of a local install renders them from the bundle. A release
package lets `vsce` rewrite the links to `https://github.com/p0l0us/ai-usage-vscode-plugin/raw/HEAD/...` (the
Marketplace needs absolute URLs), so new or changed screenshots must be pushed to `main` before publishing. Do **not** add `enabledApiProposals` to the manifest: the Marketplace rejects extensions
that declare proposed APIs (the publish script checks this too).

### Open VSX (VSCodium, Cursor, Gitpod)

Open VSX is a separate registry with its own account and token (<https://open-vsx.org>). Publish the same VSIX
with `npx ovsx publish ai-usage.vsix -p <OVSX_TOKEN>`. The namespace `p0l0us` must be created there first with
`npx ovsx create-namespace p0l0us -p <OVSX_TOKEN>`.
