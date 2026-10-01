import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AuthProvider, ProviderView, ServiceClient, ServiceConfig, ServiceEvent, Snapshot, compareVersions, configFileOf, connectService, findNode, installService,
  launcherDir, logFile, readCurrentInstall, restartService, serviceHome, serviceStatus, startService, stopService, uninstallService
} from '../service/out';
import { ConfigSync, readSettings } from './configSync';
import { migrateLegacyProfiles } from './legacyProfiles';

/**
 * The extension's side of the account service: installs the bundled package under the service home (with the
 * user's consent), keeps it up to date, starts it when it is not running, holds the connection, and hands the
 * service's events and views to the rest of the extension.
 */

const ENABLED_SETTING = 'aiUsage.accountService.enabled';
const SEEDED_KEY = 'aiUsage.accountService.configSeeded.v1';
const PROVIDERS: AuthProvider[] = ['claude', 'codex'];
/** How often a lost connection is retried. */
const RECONNECT_MS = 30_000;

export class ServiceManager implements vscode.Disposable {
  private client?: ServiceClient;
  private connecting?: Promise<ServiceClient | undefined>;
  private readonly eventEmitter = new vscode.EventEmitter<ServiceEvent>();
  private readonly stateEmitter = new vscode.EventEmitter<AuthProvider | undefined>();
  private readonly installEmitter = new vscode.EventEmitter<void>();
  private lastAttemptAt = 0;
  private offered = false;
  private disposed = false;
  /** The latest view of each provider, refreshed on the service's `stateChanged` events. */
  views: Partial<Record<AuthProvider, ProviderView>> = {};
  config?: ServiceConfig;
  readonly home = serviceHome();
  readonly configSync: ConfigSync;
  /** Fired with every event the service pushes. */
  readonly onEvent = this.eventEmitter.event;
  /** Fired when a provider's view was refreshed (undefined: the connection was lost). */
  readonly onStateChanged = this.stateEmitter.event;
  /** Fired after the service package was installed, reinstalled or upgraded. */
  readonly onDidInstall = this.installEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext, private readonly log: (message: string) => void) {
    this.configSync = new ConfigSync(log);
  }

  dispose(): void {
    this.disposed = true;
    this.client?.close();
    this.eventEmitter.dispose();
    this.stateEmitter.dispose();
    this.installEmitter.dispose();
  }

  get enabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(ENABLED_SETTING, true);
  }

  get connected(): ServiceClient | undefined {
    return this.client?.connected ? this.client : undefined;
  }

  get bundledDir(): string {
    return path.join(this.context.extensionPath, 'service');
  }

  bundledVersion(): string {
    try { return String(JSON.parse(fs.readFileSync(path.join(this.bundledDir, 'package.json'), 'utf8')).version ?? '0.0.0'); }
    catch { return '0.0.0'; }
  }

  isInstalled(): boolean {
    return readCurrentInstall(this.home) !== undefined;
  }

  /** The connected client, or an error that says what to do. */
  require(): ServiceClient {
    const client = this.connected;
    if (client) { return client; }
    if (!this.enabled) { throw new Error(`The account service is turned off (${ENABLED_SETTING}). Turn it on to manage accounts.`); }
    throw new Error(this.isInstalled() ? 'The account service is not running yet. It is started in the background; try again in a moment.' : 'The account service is not installed. Run AI Usage: Install Account Service.');
  }

  /** Connects, installing or upgrading first as needed; `promptInstall` asks the user before a first install. */
  ensure(options: { promptInstall?: boolean } = {}): Promise<ServiceClient | undefined> {
    if (this.disposed) { return Promise.resolve(undefined); }
    if (!this.enabled) {
      // Turned off: the service keeps running on its own, but this window stops using it.
      this.client?.close();
      return Promise.resolve(undefined);
    }
    if (this.connected) { return Promise.resolve(this.connected); }
    if (this.connecting) { return this.connecting; }
    this.lastAttemptAt = Date.now();
    this.connecting = (async () => {
      try {
        const installed = readCurrentInstall(this.home);
        if (!installed) {
          if (options.promptInstall) { await this.offerInstall(); }
          return this.connected;
        }
        if (compareVersions(this.bundledVersion(), installed.version) > 0) {
          await this.upgrade(installed.version);
        }
        return await this.connect();
      } catch (error) {
        this.log(`service: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  /** Called every minute: reconnects after a loss, without prompting. */
  tick(): void {
    if (!this.enabled || this.connected || this.connecting || Date.now() - this.lastAttemptAt < RECONNECT_MS) { return; }
    void this.ensure();
  }

  private async connect(): Promise<ServiceClient | undefined> {
    const version = String((this.context.extension.packageJSON as { version?: string }).version ?? '0');
    try {
      const client = await connectService({
        home: this.home, client: 'vscode', version, subscribe: 'all', waitMs: 15_000,
        start: () => {
          const started = startService(this.home);
          this.log(`service: ${started.ok ? `starting (${started.detail})` : `could not start: ${started.detail}`}`);
          if (!started.ok) { throw new Error(started.detail); }
        }
      });
      await this.adopt(client);
      return client;
    } catch (error) {
      this.log(`service: connection failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async adopt(client: ServiceClient): Promise<void> {
    this.client = client;
    this.log(`service: connected to version ${client.info.version} (pid ${client.info.pid}, home ${client.info.home})`);
    client.on('event', (event: ServiceEvent) => {
      if (event.event === 'stateChanged') { void this.refreshViews(event.provider); }
      if (event.event === 'configChanged') { this.config = event.config; void this.configSync.pull(event.config); }
      if (event.event === 'log') { this.log(`[service] ${event.line.replace(/^\[[^\]]*\]\s*/, '')}`); }
      this.eventEmitter.fire(event);
    });
    client.on('close', () => {
      if (this.client === client) { this.client = undefined; }
      this.views = {};
      this.log('service: connection closed');
      this.stateEmitter.fire(undefined);
    });
    // The window's local folders hold its project profiles; the service lists them while this window is connected.
    await this.declareFolders(client);
    // The extension's terminals get the ai-usage command without any PATH editing by the user.
    this.context.environmentVariableCollection.description = 'Adds the ai-usage command of the AI Usage account service.';
    this.context.environmentVariableCollection.prepend('PATH', `${launcherDir(this.home)}${path.delimiter}`);
    try {
      await this.syncConfig(client);
      const migrated = await migrateLegacyProfiles(this.context, client, this.home, this.log);
      if (migrated && (migrated.moved || migrated.withoutLogin.length)) {
        void vscode.window.showInformationMessage(`AI Usage: moved ${migrated.moved} saved profile${migrated.moved === 1 ? '' : 's'} to the account service.${migrated.withoutLogin.length ? ` No login was stored here for ${migrated.withoutLogin.join(', ')}; sign in again for those.` : ''}`);
      }
    } catch (error) {
      this.log(`service: could not finish the first sync: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.refreshViews();
  }

  /** Seeds the service from the user settings once, then adopts the service's values. */
  private async syncConfig(client: ServiceClient): Promise<void> {
    const seeded = this.context.globalState.get<boolean>(SEEDED_KEY) || fs.existsSync(configFileOf(this.home));
    let config = await client.getConfig();
    if (!seeded) {
      const values = readSettings(config);
      config = await client.setConfig(values);
      await this.context.globalState.update(SEEDED_KEY, true);
      this.log('service: seeded its settings from the user settings');
    }
    this.config = config;
    await this.configSync.pull(config);
  }

  /** Pushes the user-setting values a configuration change carried, if any. */
  async pushSettings(event: vscode.ConfigurationChangeEvent): Promise<void> {
    const client = this.connected;
    if (!client || !this.config) { return; }
    const values = this.configSync.changedKeys(event, this.config);
    if (!Object.keys(values).length) { return; }
    try {
      this.config = await client.setConfig(values);
      this.log(`settings: pushed ${Object.keys(values).join(', ')} to the account service`);
    } catch (error) {
      void vscode.window.showWarningMessage(`AI Usage: the account service rejected the setting: ${error instanceof Error ? error.message : String(error)}`);
      await this.configSync.pull(this.config);
    }
  }

  /** The open local workspace folders, whose project profile files the service reads. */
  static localFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);
  }

  /** Tells the service which project folders this window has open; called on connect and when they change. */
  async declareFolders(client = this.connected): Promise<void> {
    if (!client) { return; }
    try { await client.setFolders(ServiceManager.localFolders()); }
    catch (error) { this.log(`service: could not declare the workspace folders: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async refreshViews(provider?: AuthProvider): Promise<void> {
    const client = this.connected;
    if (!client) { return; }
    try {
      for (const candidate of provider ? [provider] : PROVIDERS) {
        this.views[candidate] = await client.list(candidate);
      }
      this.stateEmitter.fire(provider);
    } catch (error) {
      this.log(`service: could not read the ${provider ?? 'account'} view: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async snapshot(): Promise<Snapshot | undefined> {
    const client = this.connected;
    if (!client) { return undefined; }
    try {
      const snapshot = await client.snapshot();
      this.views = snapshot.providers;
      this.config = snapshot.config;
      return snapshot;
    } catch { return undefined; }
  }

  /** Asks once per session whether to install; "Don't ask again" turns the service setting off. */
  private async offerInstall(): Promise<void> {
    if (this.offered) { return; }
    this.offered = true;
    const choice = await vscode.window.showInformationMessage(
      'AI Usage manages Claude and Codex accounts through a small background service, so keep-alives and rotation keep running while VS Code is closed and the ai-usage command can control them from a terminal. Install it now? It goes to ~/.ai-usage and is registered to start when you sign in.',
      'Install', 'Not now', 'Don\'t ask again');
    if (choice === 'Install') { await this.install(); }
    else if (choice === 'Don\'t ask again') {
      await vscode.workspace.getConfiguration().update(ENABLED_SETTING, false, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`AI Usage: the account service stays off. Turn ${ENABLED_SETTING} on to install it later.`);
    }
  }

  /** Installs (or reinstalls) the bundled service, starts it and connects; every outcome is reported. */
  async install(): Promise<boolean> {
    const node = findNode({ fallback: { execPath: process.execPath, electron: Boolean(process.versions.electron) } });
    if (!node) {
      void vscode.window.showErrorMessage('AI Usage: no Node.js 20 or newer was found to run the account service with. Install Node.js and run AI Usage: Install Account Service again.');
      return false;
    }
    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AI Usage: installing the account service…' }, async () => {
        const installed = installService({ home: this.home, sourceDir: this.bundledDir, node, log: this.log });
        const restarted = await restartService(this.home);
        this.log(`service: ${restarted.ok ? `restarted (${restarted.detail})` : `could not start: ${restarted.detail}`}`);
        return { installed, restarted };
      });
      this.installEmitter.fire();
      const client = this.connected ?? await this.connect();
      const autostart = result.installed.autostart.ok ? `starts at sign-in (${result.installed.autostart.detail})` : `not registered to start at sign-in: ${result.installed.autostart.detail}`;
      const message = `AI Usage: account service ${result.installed.version} installed with Node.js ${node.version} from ${node.source}; ${autostart}. The ai-usage command is available in VS Code terminals${vscode.env.remoteName ? ' of this remote' : ''}; elsewhere add ${launcherDir(this.home)} to your PATH.`;
      if (client) { void vscode.window.showInformationMessage(message); }
      else { void vscode.window.showWarningMessage(`${message} The service did not answer yet; see the AI Usage log.`); }
      return Boolean(client);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`service: installation failed: ${message}`);
      void vscode.window.showErrorMessage(`AI Usage: could not install the account service: ${message}`);
      return false;
    }
  }

  private async upgrade(from: string): Promise<void> {
    const node = findNode({ fallback: { execPath: process.execPath, electron: Boolean(process.versions.electron) } });
    if (!node) { this.log(`service: installed version ${from} is older than the bundled ${this.bundledVersion()}, but no Node.js 20+ was found to upgrade with`); return; }
    const installed = installService({ home: this.home, sourceDir: this.bundledDir, node, log: this.log });
    const restarted = await restartService(this.home);
    this.log(`service: upgraded ${from} → ${installed.version}; ${restarted.ok ? `restarted (${restarted.detail})` : `could not restart: ${restarted.detail}`}`);
    this.installEmitter.fire();
  }

  /** The Account Service menu: status, start, stop, restart, reinstall, uninstall, log, command path. */
  async showMenu(): Promise<void> {
    const status = serviceStatus(this.home);
    const client = this.connected;
    type Item = vscode.QuickPickItem & { action?: 'install' | 'start' | 'stop' | 'restart' | 'uninstall' | 'log' | 'settings' };
    const items: Item[] = [];
    items.push({ label: 'Status', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: status.installed ? `$(package) Installed: version ${status.installed.version}` : '$(package) Not installed',
      detail: status.installed ? `${status.installed.dir} · Node.js ${status.installed.node.command}` : `Bundled version ${this.bundledVersion()} can be installed under ${this.home}.` });
    items.push({ label: status.running ? `$(pass) Running: pid ${status.pid}, version ${status.runningVersion}` : '$(circle-slash) Not running',
      detail: client ? `Connected · ${client.info.clients} client${client.info.clients === 1 ? '' : 's'}` : this.enabled ? 'Not connected' : `Turned off by ${ENABLED_SETTING}` });
    items.push({ label: status.autostart.kind === 'none' ? '$(warning) Autostart: none available' : `$(${status.autostart.registered ? 'pass' : 'warning'}) Autostart: ${status.autostart.kind}, ${status.autostart.registered ? 'registered' : 'not registered'}`,
      detail: status.autostart.detail ?? (status.autostart.registered ? 'The service starts when you sign in.' : 'Reinstall to register it.') });
    if (status.launcher) { items.push({ label: '$(terminal) Command: ai-usage', detail: `${status.launcher} · available in VS Code terminals; add ${launcherDir(this.home)} to your PATH elsewhere.` }); }
    items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: status.installed ? '$(sync) Reinstall or upgrade' : '$(cloud-download) Install', detail: `Installs the bundled service ${this.bundledVersion()} and registers it to start at sign-in.`, action: 'install' });
    if (status.installed) {
      items.push({ label: '$(debug-start) Start', action: 'start' });
      items.push({ label: '$(debug-stop) Stop', detail: 'Keep-alives and rotation pause until it is started again.', action: 'stop' });
      items.push({ label: '$(debug-restart) Restart', action: 'restart' });
      items.push({ label: '$(trash) Uninstall', detail: 'Stops and unregisters the service and removes its package; saved profiles and settings are kept.', action: 'uninstall' });
    }
    items.push({ label: '$(output) Open the service log', detail: logFile(this.home), action: 'log' });
    items.push({ label: '$(gear) Settings', description: ENABLED_SETTING, action: 'settings' });
    const picked = await vscode.window.showQuickPick(items, { title: 'AI Usage · Account service', matchOnDetail: true });
    if (!picked?.action) { return; }
    switch (picked.action) {
      case 'install': await this.install(); break;
      case 'start': { const result = startService(this.home); void vscode.window.showInformationMessage(`AI Usage: account service ${result.ok ? result.detail : `could not start: ${result.detail}`}.`); await this.ensure(); break; }
      case 'stop': { const result = await stopService(this.home); void vscode.window.showInformationMessage(`AI Usage: account service ${result.detail}.`); break; }
      case 'restart': { const result = await restartService(this.home); void vscode.window.showInformationMessage(`AI Usage: account service ${result.ok ? `restarted (${result.detail})` : `could not restart: ${result.detail}`}.`); await this.ensure(); break; }
      case 'uninstall': {
        const confirmed = await vscode.window.showWarningMessage('Uninstall the AI Usage account service? Keep-alives and rotation stop, and the Accounts menus need it again. Saved profiles and settings are kept under ~/.ai-usage.', { modal: true }, 'Uninstall');
        if (confirmed !== 'Uninstall') { return; }
        const result = await uninstallService(this.home, this.log);
        this.context.environmentVariableCollection.clear();
        void vscode.window.showInformationMessage(`AI Usage: account service uninstalled (${result.stopped.detail}; ${result.autostart.detail}).`);
        break;
      }
      case 'log': await vscode.window.showTextDocument(vscode.Uri.file(logFile(this.home)), { preview: false }); break;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings2', { query: '@ext:p0l0us.ai-usage-vscode-plugin aiUsage.accountService' }); break;
    }
  }
}
