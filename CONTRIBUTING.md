# Contributing to AI Usage

Thanks for your interest. Everyone is welcome to report bugs, suggest features, or send pull requests.

## Reporting a bug

Open an issue at https://github.com/p0l0us/ai-usage-vscode-plugin/issues and include:

- VS Code version (Help → About) and whether you use the desktop, remote, or agent sessions window.
- Which service is affected (Claude, Codex, Copilot) and its `aiUsage.<service>.source` setting.
- The relevant lines from **Output → AI Usage**. The log never contains tokens.
- What you expected to see and what you saw instead. Screenshots help.

## Suggesting a feature

Open an issue describing the problem you want solved. If it is a new provider, please note where its usage data
can be read from (CLI command, local file, or API) and how the tool stores its login.

## Sending a pull request

1. Fork the repository and create a branch from `main`.
2. Make your change. Keep `src/live.ts` and `src/cache.ts` free of `vscode` imports so they stay testable with Node.
3. Run `npm run compile`. It regenerates the chat-chip commands in `package.json` and type-checks the code.
4. Test in VS Code: package with `npx @vscode/vsce package --no-dependencies` and install the VSIX.
5. Update `docs/CONFIGURATION.md` (and the README table if it is a common setting) when you add or change a setting, and add a line to `CHANGELOG.md`.
6. Open the pull request with a short description of what changed and why. Link the issue if there is one.

Small, focused pull requests are reviewed fastest. For larger changes, open an issue first so the approach can be
discussed before you invest the time.

## Code of conduct

Be kind and constructive. Assume good intent. Disagreements are about code, not people.

## License

By contributing you agree that your contributions are licensed under GPL-3.0-only, the same license as the project.
