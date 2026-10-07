import * as fs from 'fs';
import * as vscode from 'vscode';
import { AuthProvider, ServiceClient, SignInResult } from '../service/out';

const POLL_MS = 1_000;
/** A browser sign-in the user walked away from must not hold the login folder forever. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;

/**
 * Runs the vendor's own interactive login in a terminal whose home the service prepared (a folder inside the
 * keep-alive home, never the native CLI home), waits for the login file, and hands it to the service, which
 * stores it in the profile. Resolves to the service's answer, or undefined when the user cancelled or the CLI
 * exited without writing a login.
 */
export async function signInWithTerminal(client: ServiceClient, provider: AuthProvider, profileId: string, label: string,
  confirmOtherAccount: (message: string) => Promise<boolean>): Promise<SignInResult | undefined> {
  const prepared = await client.prepareSignIn(provider);
  let terminal: vscode.Terminal;
  try {
    terminal = vscode.window.createTerminal({
      name: `AI Usage · sign in ${label}`,
      shellPath: prepared.cli,
      shellArgs: prepared.args,
      cwd: prepared.cwd,
      env: prepared.env,
      // The service's environment already removed provider variables; merging VS Code's would bring them back.
      strictEnv: true,
      isTransient: true
    });
  } catch (error) {
    // The service holds its checks for this sign-in from `prepare` on; a sign-in that never starts must let go.
    await client.cancelSignIn(provider).catch(() => undefined);
    throw error;
  }
  terminal.show();
  const written = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `AI Usage: sign in to ${label} in the terminal…`,
    cancellable: true
  }, (_progress, token) => new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) { return; }
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      closed.dispose();
      cancelled.dispose();
      terminal.dispose();
      resolve(value);
    };
    const exists = () => { try { return fs.statSync(prepared.file).size > 0; } catch { return false; } };
    const poll = setInterval(() => {
      if (!exists()) { return; }
      // The CLI may still be finishing its write; take the file once it has settled.
      clearInterval(poll);
      setTimeout(() => finish(exists()), POLL_MS);
    }, POLL_MS);
    const timeout = setTimeout(() => finish(false), LOGIN_TIMEOUT_MS);
    const closed = vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (closedTerminal === terminal) { finish(exists()); }
    });
    const cancelled = token.onCancellationRequested(() => finish(false));
  }));
  if (!written) {
    await client.cancelSignIn(provider).catch(() => undefined);
    return undefined;
  }
  let result = await client.finishSignIn(provider, profileId);
  if (result.status === 'otherAccount') {
    if (!await confirmOtherAccount(result.message)) {
      await client.cancelSignIn(provider).catch(() => undefined);
      return undefined;
    }
    result = await client.finishSignIn(provider, profileId, true);
  }
  return result;
}
