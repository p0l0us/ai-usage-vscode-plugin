# Development and publishing

## Development

```bash
npm install
npm run dev:install      # build the working tree to a temp VSIX and install it into this VS Code
```

`dev:install` compiles, packages to a temporary folder (nothing is written into the repo), and installs into the
VS Code that owns the current shell: the remote server in Remote-SSH/WSL/container sessions, otherwise the desktop
`code` CLI. Use `npm run dev:install:all` to install into every VS Code found. Reload the window afterwards.
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
# 1. Bump the version (patch | minor | major, or an explicit x.y.z); this also dates the previous
#    changelog section and opens a new "(unreleased)" one for you to fill in
npm run bump            # same as: npm run bump:patch   |  npm run bump minor  |  npm run bump 1.2.0

# 2. Build: regenerates chat-chip commands in package.json and compiles TypeScript
npm run compile

# 3. Package and smoke-test locally
npx @vscode/vsce package --no-dependencies -o ai-usage.vsix
code --install-extension ai-usage.vsix --force     # reload the window, check status bar and chips

# 4. Publish (uses VSCE_PAT or the stored login); `npm run release` does compile + publish in one go
npx @vscode/vsce publish --no-dependencies

# 5. Commit and tag
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release vX.Y.Z"
git tag vX.Y.Z && git push && git push --tags
```

`--no-dependencies` is required: the extension has no runtime npm dependencies and the flag stops `vsce` from
inspecting `node_modules`. Do **not** add `enabledApiProposals` to the manifest: the Marketplace rejects extensions
that declare proposed APIs, and installed-from-Marketplace extensions cannot use them anyway. Agents-window support
is enabled per user through the `extensions.supportAgentsWindow` setting (see the walkthrough), which needs no proposal. Optionally add `--pre-release` for a preview build. The listing appears within a few
minutes; the Marketplace verifies the icon, README links (must be absolute URLs) and the license file.

### Open VSX (VSCodium, Cursor, Gitpod)

Open VSX is a separate registry with its own account and token (<https://open-vsx.org>). Publish the same VSIX
with `npx ovsx publish ai-usage.vsix -p <OVSX_TOKEN>`. The namespace `p0l0us` must be created there first with
`npx ovsx create-namespace p0l0us -p <OVSX_TOKEN>`.
