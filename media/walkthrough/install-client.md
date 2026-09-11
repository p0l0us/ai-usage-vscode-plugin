# Install the extension on this computer

The Agents window runs extensions from the **local** VS Code install only, even when a session works on a remote
machine. If you use AI Usage through Remote-SSH, WSL, a dev container or a tunnel, it is currently installed on the
remote side and the Agents window cannot see it.

1. Download `ai-usage-<version>.vsix` from the
   [releases page](https://github.com/p0l0us/ai-usage-vscode-plugin/releases), or build it with
   `npx @vscode/vsce package` in a checkout of the repository.
2. Run **Extensions: Install from VSIX…** and pick the file:
   [Install from VSIX…](command:workbench.extensions.action.installVSIX)

   or from a terminal on this computer:

   ```bash
   code --install-extension ai-usage-<version>.vsix
   ```

The extension prefers the remote copy in ordinary remote windows, so having both copies installed changes nothing
there. The local copy is used only where no remote extension host exists, which is the Agents window.
