# Contributing to AI subscription management and usage

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
2. Make your change. Everything under `service/` is the account service and the `ai-usage` command, a plain Node
   package without `vscode` imports; the extension in `src/` is one of its clients.
3. Run `npm run compile`. It regenerates the chat-chip commands in `package.json` and type-checks the service and the extension; `npm test` runs the extension, service and bridge suites through the isolated runner.
4. Test in VS Code: package with `npx @vscode/vsce package --no-dependencies` and install the VSIX.
5. Update `docs/CONFIGURATION.md` (and the README table if it is a common setting) when you add or change a setting, and add a line to `CHANGELOG.md`.
6. Open the pull request with a short description of what changed and why. Link the issue if there is one.

Small, focused pull requests are reviewed fastest. For larger changes, open an issue first so the approach can be
discussed before you invest the time.

## Runtime validation

Keep account fixtures isolated: tests and spawned processes must use temporary `HOME`, `AI_USAGE_HOME`, `CODEX_HOME`
and `CLAUDE_CONFIG_DIR`. Never point a test at your native login or `~/.ai-usage`; use synthetic credentials and mock
provider/model calls. The root `npm test` runner supplies these temporary homes for all three suites and removes
them afterward, sets `USERPROFILE` to its temporary home, and removes `GH_TOKEN` and `GITHUB_TOKEN` from child
environments. It preloads a guard into Node test descendants that rejects external HTTP and HTTPS requests and
`fetch` calls while allowing loopback fixtures. This describes that runner guard only; it is not a general network
sandbox for arbitrary commands or non-Node processes.

Changes to runtime behavior should exercise background and editor-owned hosts through the same authenticated
socket client. Cover ownership races, reconnect/takeover, revision conflicts and requesting-window workspace
context when relevant. MCP tests run the bundled command against the fixture host without installing a service.
Bridge lifecycle tests must observe child exit before a replacement process starts or the engine lease is released.

## Code of conduct

Be kind and constructive. Assume good intent. Disagreements are about code, not people.

## License

By contributing you agree that your contributions are licensed under GPL-3.0-only, the same license as the project.
