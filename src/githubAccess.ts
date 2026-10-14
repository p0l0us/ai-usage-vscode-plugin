import type * as vscode from 'vscode';
import type { GitHubAccount } from '../service/out';

/** Scope sets Copilot itself signs in with; any of them is enough to read the quota endpoint. */
export const GITHUB_SCOPE_CANDIDATES: string[][] = [
  ['read:user', 'user:email', 'repo', 'workflow'],
  ['user:email'],
  ['read:user']
];
/** Scopes used when asking the user to grant access; Copilot itself signs in with these. */
export const GITHUB_CONNECT_SCOPES = ['user:email'];
export const GITHUB_ACCESS_REQUESTED_KEY = 'aiUsage.githubAccessRequested';

type Account = vscode.AuthenticationSessionAccountInformation;
type Session = { accessToken: string; account: { label: string } };

/** The slice of `vscode.authentication` used here; tests pass a fake. */
export type GitHubAuth = {
  getAccounts(providerId: string): PromiseLike<readonly Account[]>;
  getSession(providerId: string, scopes: readonly string[], options: { silent?: boolean; createIfNone?: boolean; account?: Account }):
    PromiseLike<Session | undefined>;
};

/** The account the user named in `aiUsage.copilot.account` (case-insensitive), else the first signed-in one. */
export function preferredAccount(accounts: readonly Account[], preferred: string | undefined): Account | undefined {
  return accounts.find((candidate) => candidate.label.toLowerCase() === preferred?.toLowerCase()) ?? accounts[0];
}

/** Requests access to the signed-in GitHub account (shows VS Code's Allow dialog). */
export async function connectGitHub(auth: GitHubAuth, preferred: string | undefined, log: (message: string) => void): Promise<boolean> {
  try {
    const accounts = await auth.getAccounts('github');
    const account = preferredAccount(accounts, preferred || undefined);
    const session = await auth.getSession('github', GITHUB_CONNECT_SCOPES, { createIfNone: true, account });
    log(`github: access ${session ? `granted for ${session.account.label}` : 'not granted'}`);
    return Boolean(session);
  } catch (error) {
    log(`github: access request failed: ${String(error)}`);
    return false;
  }
}

/** All GitHub accounts VS Code is signed in to, with a token for each (silent, never prompts). */
export async function getGitHubAccounts(auth: GitHubAuth, log: (message: string) => void): Promise<GitHubAccount[]> {
  let accounts: readonly Account[] = [];
  try {
    accounts = await auth.getAccounts('github');
  } catch (error) {
    log(`github: getAccounts failed: ${String(error)}`);
    accounts = [];
  }
  log(`github: ${accounts.length} account(s) signed in: ${accounts.map((account) => account.label).join(', ') || '-'}`);

  const result: GitHubAccount[] = [];
  const sessionFor = async (account?: Account) => {
    for (const scopes of GITHUB_SCOPE_CANDIDATES) {
      try {
        const session = await auth.getSession('github', scopes, { silent: true, account });
        if (session?.accessToken) {
          return session;
        }
      } catch (error) {
        log(`github: getSession(${scopes.join(' ')}) for ${account?.label ?? 'default'} failed: ${String(error)}`);
      }
    }
    log(`github: no silent session for ${account?.label ?? 'default account'} with any known Copilot scope set`);
    return undefined;
  };

  if (accounts.length) {
    await Promise.all(
      accounts.map(async (account) => {
        const session = await sessionFor(account);
        if (session) {
          result.push({ login: session.account.label || account.label, token: session.accessToken });
        }
      })
    );
  } else {
    const session = await sessionFor();
    if (session) {
      result.push({ login: session.account.label, token: session.accessToken });
    }
  }
  return result;
}

/** Remote URLs listed in a `.git/config`. */
export function remoteUrlsFromGitConfig(config: string): string[] {
  return [...config.matchAll(/^\s*url\s*=\s*(.+)$/gm)].map((match) => match[1].trim());
}

/** The GitHub owners (users/orgs) named by remote URLs (https or ssh form), without duplicates, in first-seen order. */
export function ownersFromRemoteUrls(urls: Iterable<string>): string[] {
  const owners = new Set<string>();
  for (const url of urls) {
    const match = /github\.com[/:]([^/]+)\//i.exec(url);
    if (match) {
      owners.add(match[1]);
    }
  }
  return [...owners];
}
