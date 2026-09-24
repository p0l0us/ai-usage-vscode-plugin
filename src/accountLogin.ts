import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AuthProvider, StoredCredential, parseCredentialJson } from './authFiles';
import {
  ProbeSettings, acquireAccountLock, isolatedEnvironment, loginArgs, loginHome, stagedCredentialPath
} from './accountProbe';
import { resolveCli } from './live';

const POLL_MS = 1_000;
/** A browser sign-in the user walked away from must not hold the login folder forever. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;

function readLogin(provider: AuthProvider, file: string): StoredCredential | undefined {
  try { return parseCredentialJson(provider, fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/**
 * Runs the vendor's own interactive login in a terminal whose home is a folder inside the keep-alive home, never the
 * native CLI home, so signing in again cannot touch the active login. Resolves to the new credential, or undefined
 * when the user cancelled or the CLI exited without writing one. The login file is removed afterwards.
 */
export async function signInIsolated(provider: AuthProvider, settings: ProbeSettings, label: string): Promise<StoredCredential | undefined> {
  const cli = resolveCli(settings.cliPath);
  if (!cli) { throw new Error(`${settings.cliPath} was not found. Check the ${provider} CLI path setting.`); }
  const home = loginHome(provider, settings.home);
  const unlock = acquireAccountLock(path.join(home, '.ai-usage.lock'));
  if (!unlock) { throw new Error('Another sign-in is already running.'); }
  const file = stagedCredentialPath(provider, home);
  try {
    // A leftover from an earlier sign-in must not be mistaken for this one.
    fs.rmSync(file, { force: true });
    const terminal = vscode.window.createTerminal({
      name: `AI Usage · sign in ${label}`,
      shellPath: cli,
      shellArgs: loginArgs(provider),
      cwd: home,
      env: isolatedEnvironment(provider, home),
      // The isolated environment already removed provider variables; merging VS Code's would bring them back.
      strictEnv: true,
      isTransient: true
    });
    terminal.show();
    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `AI Usage: sign in to ${label} in the terminal…`,
      cancellable: true
    }, (_progress, token) => new Promise<StoredCredential | undefined>((resolve) => {
      let settled = false;
      const finish = (credential: StoredCredential | undefined) => {
        if (settled) { return; }
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        closed.dispose();
        cancelled.dispose();
        terminal.dispose();
        resolve(credential);
      };
      const poll = setInterval(() => {
        if (!readLogin(provider, file)) { return; }
        // The CLI may still be finishing its write; take the file once it has settled.
        setTimeout(() => finish(readLogin(provider, file)), POLL_MS);
        clearInterval(poll);
      }, POLL_MS);
      const timeout = setTimeout(() => finish(undefined), LOGIN_TIMEOUT_MS);
      const closed = vscode.window.onDidCloseTerminal((closedTerminal) => {
        if (closedTerminal === terminal) { finish(readLogin(provider, file)); }
      });
      const cancelled = token.onCancellationRequested(() => finish(undefined));
    }));
  } finally {
    try { fs.rmSync(file, { force: true }); } finally { unlock(); }
  }
}
