# Optional Docker deployment proposal

This is a deployment proposal, not a shipped Docker image or a claim that container operation has been verified.
The shared service engine is the intended entry point; container-specific rotation logic is unnecessary.

## Proposed layout

Run one container per OS user with the account service, Codex proxy, CLI bridge, Node and pinned Claude/Codex CLI
versions. Start the service in the foreground and let Docker manage restart and shutdown. Do not run systemd inside
the container. A persistent service volume holds profiles, configuration, history, cache and local transport tokens.

Bind-mount the native credential and configuration directories that host Codex/Claude applications must see. Mount
project/session directories at matching absolute paths where possible. Mounting parent directories, rather than
individual auth files, is necessary for the service's atomic rename writes. Run with the host user's UID/GID and
retain mode-0600 credential files.

Publish only required ports to host loopback, for example `127.0.0.1:43117:43117` for the Codex proxy and
`127.0.0.1:3210:3210` for the bridge. Those services retain their bearer-token checks. The current servers bind to
container loopback, so a container-aware bind-address option would be required before ordinary Docker port
publishing can reach them. The native default should remain loopback.

On Linux, share the service socket directory with the extension. On macOS/Windows, implement a separate
authenticated loopback RPC transport: a socket inside the Docker VM is not a portable host connection method.
Keep the service's native socket transport as the default. Connection details belong in VS Code; service policy
continues to come from the common settings schema and CLI.

## Benefits and limitations

| Area | Benefit | Limitation / work required |
|---|---|---|
| Dependencies | Reproducible Node and CLI versions; one image to roll back | Rebuild regularly as provider CLI protocols change |
| Lifecycle | Runs without VS Code; restart policy and logs are centralized | Graceful shutdown must stop proxy/bridge children and restore native routing |
| Account switching | Host and container see the same active login through mounts | Writable credential mounts reduce isolation; concurrent native/container refreshes still need coordination |
| Projects and sessions | Persistent session/history volumes | Host/container paths, UID/GID and filesystem behavior need validation |
| Authentication | Browser login can be initiated by a connected client | Host keychains, OAuth callback URLs and native browser launch are not automatically available inside the container |
| Copilot | VS Code can forward its GitHub session to the service | Standalone operation needs a token available to the service; no automatic access to VS Code's sign-in |
| UI actions | VS Code remains a thin client | Host terminal launch and extension URLs must run on the client; container executable paths need translation |
| Singleton ownership | A fixed published host port prevents duplicate binds to that port | PID locks, abstract sockets and named pipes do not coordinate across container/host namespaces; different ports permit separate deployments |
| Platforms | Linux has straightforward mounts and Unix-socket sharing | macOS/Windows require transport and path adaptations; host networking is not a portable solution |

Before shipping, add a host-level deployment lease shared by native and container installations, independent of
chosen proxy ports. Do not interpret a container PID as a host PID. Avoid running a native daemon and container
against the same profiles until that coordination is implemented.

## Suggested delivery order

1. Package a Linux image using the existing service entry point, a foreground process and pinned CLIs.
2. Add explicit container bind addresses, socket mounts, UID/GID handling and health checks.
3. Add deployment ownership coordination, host/container path mapping and client-assisted sign-in/terminal actions.
4. Test account rotation and token refresh with host CLIs, quota reset handling, two-window access, crashes and upgrades.
5. Add authenticated loopback RPC and verify Docker Desktop on macOS and Windows.

Keep Docker optional. Native installation remains simpler for desktop users with host keychains and local projects.
