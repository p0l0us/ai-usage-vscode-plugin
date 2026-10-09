import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  defaultConfig, AuthProvider, ProviderView, ServiceClient, ServiceConfig, ServiceEvent, ServiceHost, Snapshot, compareVersions, connectService, findNode,
  installService, launcherDir, logFile, readCurrentInstall, readServiceInfo, restartService, serviceHome, serviceStatus, startService, startServiceHost,
  stopService, uninstallService, serviceManuallyStopped
} from '../service/out';
import { ConfigSync, readSeedSettings } from './configSync';
import { pickWithBack } from './quickPick';
import { ProfileStoreKind, STORE_TITLES, clientAccess, directAccess, transferProfiles, vscodeProfileCount } from './vscodeProfiles';

/**
 * The extension's side of the account service: installs the bundled package under the service home (with the
 * user's consent), keeps it up to date, starts it when it is not running, holds the connection, and hands the
 * service's events and views to the rest of the extension.
 *
 * Without the background service (declined, not installed yet, or `aiUsage.accountService.background` off) the
 * same service runs inside a VS Code window instead: the first window that finds no service answering hosts it on
 * the service socket, the other windows and the `ai-usage` command connect to it, and when that window closes
 * another one takes over. Both modes keep private profiles in the service's profiles.json. Project profiles are listed either way.
 * Nonconflicting legacy VS Code profiles migrate on connection.
 */

const ENABLED_SETTING = 'aiUsage.accountService.enabled';
const BACKGROUND_SETTING = 'aiUsage.accountService.background';
/** How long a window waits before it hosts the service after losing the one it used, so they do not all race. */
const TAKEOVER_DELAY_MS = 300;
const PROVIDERS: AuthProvider[] = ['claude', 'codex'];
/** How often a lost connection is retried. */
const RECONNECT_MS = 30_000;

export class ServiceManager implements vscode.Disposable {
  private client?: ServiceClient;
  /** The service hosted inside this window, when no background service is used. */
  private host?: ServiceHost;
  private configRevision = 0;
  private shutdown?: Promise<void>;
  private takeoverTimer?: ReturnType<typeof setTimeout>;
  private settingsQueue = Promise.resolve();
  runtimeStatus: { codexProxyActive: boolean } = { codexProxyActive: false };
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

  dispose(): void { void this.stop().catch(error => this.log(`service: shutdown failed: ${String(error)}`)); }

  /** Awaited by extension deactivation so ownership is released only after engine children exit. */
  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.disposed = true;
    clearTimeout(this.takeoverTimer);
    this.client?.close();
    this.shutdown = (async () => {
      await this.connecting;
      this.client?.close();
      await this.host?.stop();
      this.host = undefined;
    })();
    this.eventEmitter.dispose();
    this.stateEmitter.dispose();
    this.installEmitter.dispose();
    return this.shutdown;
  }

  get enabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(ENABLED_SETTING, true);
  }

  /** Whether the service should run as its own background process; off keeps it inside VS Code windows. */
  get background(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(BACKGROUND_SETTING, true);
  }

  /** Whether this window hosts the service. */
  get hosting(): boolean {
    return Boolean(this.host);
  }

  /** One line for the root menu: where the service runs, or why it does not. */
  summary(): string {
    const client = this.connected;
    if (!client) { return 'not running'; }
    const where = this.host ? 'inside this VS Code window' : readServiceInfo(this.home)?.embedded ? 'inside a VS Code window' : 'background';
    return `${where} · version ${client.info.version} · Claude and Codex`;
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
    throw new Error('The account service is not answering yet; try again in a moment. AI Usage: Account Service… shows its state.');
  }

  /** Connects, installing or upgrading first as needed; `promptInstall` asks the user before a first install. */
  ensure(options: { promptInstall?: boolean } = {}): Promise<ServiceClient | undefined> {
    if (this.disposed) { return Promise.resolve(undefined); }
    if (this.connected) { return Promise.resolve(this.connected); }
    if (this.connecting) { return this.connecting; }
    this.lastAttemptAt = Date.now();
    this.connecting = (async () => {
      try {
        if (serviceManuallyStopped(this.home)) { return await this.connectExisting(); }
        const installed = readCurrentInstall(this.home);
        if (installed && this.enabled && this.background) {
          if (compareVersions(this.bundledVersion(), installed.version) > 0) {
            await this.upgrade(installed.version);
          }
          return await this.connect();
        }
        // No background service in use: offer it once (without waiting), then use whichever service answers (another
        // window's, or one started from a terminal), or host it in this window.
        if (!installed && this.enabled && this.background && options.promptInstall) { void this.offerInstall(); }
        return await this.connectExisting() ?? await this.hostHere();
      } catch (error) {
        this.log(`service: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  /** Connects to a service that already answers, without starting one. */
  private async connectExisting(): Promise<ServiceClient | undefined> {
    try {
      const client = await connectService({ home: this.home, client: 'vscode', version: this.extensionVersion(), subscribe: 'all' });
      await this.adopt(client);
      if (this.disposed || !client.connected) { client.close(); return undefined; }
      return client;
    } catch { return undefined; }
  }

  /** Hosts the service in this window and connects to it; when another window won the race, connects to that one. */
  private async hostHere(): Promise<ServiceClient | undefined> {
    if (this.disposed) return undefined;
    let host: ServiceHost;
    try {
      host = await startServiceHost({ home: this.home, version: this.bundledVersion(), embedded: true, seedConfig: readSeedSettings(defaultConfig()), onLog: this.log });
    } catch (error) {
      this.log(`service: not hosted in this window: ${error instanceof Error ? error.message : String(error)}`);
      return this.connectExisting();
    }
    if (this.disposed) { await host.stop(); return undefined; }
    this.host = host;
    this.log(`service: running inside this VS Code window with profiles owned by the service (home ${this.home}); it stops when the window closes`);
    void host.stopped.then(() => { if (this.host === host) { this.host = undefined; } });
    const client = await this.connectExisting();
    if (!client) { await host.stop(); if (this.host === host) this.host = undefined; }
    return client;
  }

  private extensionVersion(): string {
    return String((this.context.extension.packageJSON as { version?: string }).version ?? '0');
  }

  /** Called every minute: reconnects after a loss, without prompting. */
  tick(): void {
    if (this.disposed || serviceManuallyStopped(this.home) || this.connected || this.connecting || Date.now() - this.lastAttemptAt < RECONNECT_MS) { return; }
    void this.ensure();
  }

  private scheduleReconnect(delay = 1_000): void {
    clearTimeout(this.takeoverTimer);
    if (this.disposed || serviceManuallyStopped(this.home)) return;
    this.takeoverTimer = setTimeout(() => {
      void this.ensure().then(client => { if (!client && !this.disposed && !serviceManuallyStopped(this.home)) this.scheduleReconnect(); });
    }, delay);
    this.takeoverTimer.unref();
  }

  private async connect(): Promise<ServiceClient | undefined> {
    try {
      const client = await connectService({
        home: this.home, client: 'vscode', version: this.extensionVersion(), subscribe: 'all', waitMs: 15_000,
        start: () => {
          if (serviceManuallyStopped(this.home)) { throw new Error('The account service was stopped manually. Use Account Service… → Start to resume it.'); }
          const started = startService(this.home);
          this.log(`service: ${started.ok ? `starting (${started.detail})` : `could not start: ${started.detail}`}`);
          if (!started.ok) { throw new Error(started.detail); }
        }
      });
      await this.adopt(client);
      if (this.disposed || !client.connected) { client.close(); return undefined; }
      return client;
    } catch (error) {
      this.log(`service: connection failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async adopt(client: ServiceClient): Promise<void> {
    if (this.disposed) { client.close(); return; }
    this.client = client;
    this.log(`service: connected to version ${client.info.version} (pid ${client.info.pid}, home ${client.info.home})`);
    client.on('event', (event: ServiceEvent) => {
      if (event.event === 'stateChanged') { void this.refreshViews(event.provider); }
      if (this.client !== client || this.disposed) return;
      if (event.event === 'configChanged' && (event.revision === undefined || event.revision >= this.configRevision)) {
        this.config = event.config; this.configRevision = event.revision ?? this.configRevision;
        void this.configSync.pull(event.config).catch(error => this.log(`settings: hydration failed: ${String(error)}`));
      }
      if (event.event === 'log') { this.log(`[service] ${event.line.replace(/^\[[^\]]*\]\s*/, '')}`); }
      this.eventEmitter.fire(event);
    });
    client.on('close', () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.views = {};
      this.log('service: connection closed');
      this.stateEmitter.fire(undefined);
      // A service hosted by a window that closed is taken over by another window soon, not after the minute tick.
      if (!this.disposed) {
        this.scheduleReconnect(TAKEOVER_DELAY_MS + Math.random() * 1_500);
      }
    });
    // The window's local folders hold its project profiles; the service lists them while this window is connected.
    await this.declareFolders(client);
    if (client.supports('reset-confirmation')) {
      for (const decision of await client.resetConfirmations()) this.eventEmitter.fire({ event: 'resetConfirmation', decision });
    }
    // The extension's terminals get the ai-usage command without any PATH editing by the user.
    if (this.isInstalled()) {
      this.context.environmentVariableCollection.description = 'Adds the ai-usage command of the AI Usage account service.';
      this.context.environmentVariableCollection.prepend('PATH', `${launcherDir(this.home)}${path.delimiter}`);
    }
    try {
      await this.syncConfig(client);
      if (vscodeProfileCount(this.context) > 0) {
        const source = await directAccess('vscode', this.home, this.context, this.log);
        const entries = await source.list();
        const plans = await client.planImport(JSON.stringify({ aiUsageProfiles: 1, profiles: entries }));
        const chosen = entries.filter(entry => plans.some(plan => plan.provider === entry.provider && plan.id === entry.id && ['new', 'restore', 'same'].includes(plan.kind)));
        if (chosen.length) await transferProfiles(source, clientAccess(client), chosen, true);
      }
    } catch (error) {
      this.log(`service: could not finish the first sync: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.refreshViews();
  }

  /** Reconnect reads authoritative persisted settings and never replays an editor's old defaults. */
  private async syncConfig(client: ServiceClient): Promise<void> {
    const current = await client.getConfigState();
    if (this.client !== client || this.disposed || current.revision < this.configRevision) return;
    this.config = current.config;
    this.configRevision = current.revision;
    await this.configSync.pull(current.config);
    this.log('service: adopted persisted engine settings');
  }

  /** Pushes the user-setting values a configuration change carried, if any. */
  async pushSettings(event: vscode.ConfigurationChangeEvent): Promise<void> {
    const client = this.connected;
    if (!client || !this.config) { return; }
    const values = this.configSync.changedKeys(event, this.config);
    const baseRevision = this.configRevision;
    if (event.affectsConfiguration('aiUsage.bridge.codex.sessionDirectory') || event.affectsConfiguration('aiUsage.bridge.claude.sessionDirectory')) { await this.declareFolders(client); }
    if (!Object.keys(values).length) { return; }
    this.settingsQueue = this.settingsQueue.catch(() => undefined).then(async () => {
      if (this.client !== client || !client.connected || this.disposed) return;
      try {
        const result = await client.patchConfig(values, baseRevision);
        if (this.client !== client || result.revision < this.configRevision) return;
        this.config = result.config; this.configRevision = result.revision;
        this.log(`settings: pushed ${Object.keys(values).join(', ')} to the account service`);
      } catch (error) {
        void vscode.window.showWarningMessage(`AI Usage: the account service rejected the setting: ${error instanceof Error ? error.message : String(error)}`);
        // A disconnect may hide a committed mutation. Re-read after reconnect; never retry its payload.
        if (client.connected && this.client === client) await this.syncConfig(client);
      }
    });
    await this.settingsQueue;
  }

  /** The open local workspace folders, whose project profile files the service reads. */
  static localFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);
  }

  /** Tells the service which project folders this window has open; called on connect and when they change. */
  async declareFolders(client = this.connected): Promise<void> {
    if (!client) { return; }
    try {
      const configuration = vscode.workspace.getConfiguration('aiUsage.bridge');
      const sessionDirectory: Partial<Record<AuthProvider, string>> = {};
      for (const provider of PROVIDERS) {
        const directory = configuration.get<string>(`${provider}.sessionDirectory`, '');
        if (directory) sessionDirectory[provider] = directory;
      }
      await client.call('workspace.context', { folders: ServiceManager.localFolders(), sessionDirectory });
    }
    catch (error) { this.log(`service: could not declare the workspace folders: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async refreshViews(provider?: AuthProvider): Promise<void> {
    const client = this.connected;
    if (!client) { return; }
    try {
      for (const candidate of provider ? [provider] : PROVIDERS) {
        const view = await client.list(candidate);
        if (this.client !== client || this.disposed) return;
        this.views[candidate] = view;
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
      if (this.client !== client || this.disposed) return undefined;
      this.views = snapshot.providers;
      if (snapshot.configRevision !== undefined && snapshot.configRevision >= this.configRevision) {
        this.config = snapshot.config; this.configRevision = snapshot.configRevision;
      }
      return snapshot;
    } catch { return undefined; }
  }

  /**
   * Asks once per session whether to install the background service. Accounts work either way: without it the
   * service runs inside VS Code. "Don't ask again" keeps it that way by turning the background setting off.
   */
  private async offerInstall(): Promise<void> {
    if (this.offered) { return; }
    this.offered = true;
    const choice = await vscode.window.showInformationMessage(
      'AI Usage can run its account service in the background, so keep-alives and rotation keep running while VS Code is closed and the ai-usage command works in any terminal. Without it, accounts work while VS Code is open. Install it? It goes to ~/.ai-usage and is registered to start when you sign in.',
      'Install', 'Not now', 'Don\'t ask again');
    if (choice === 'Install') { await this.install(); }
    else if (choice === 'Don\'t ask again') {
      await vscode.workspace.getConfiguration().update(BACKGROUND_SETTING, false, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`AI Usage: accounts keep working while VS Code is open; nothing runs in the background. Turn ${BACKGROUND_SETTING} on to install the service later.`);
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

  /** Which store the connected service keeps its private profiles in. */
  profileStore(client = this.connected): ProfileStoreKind | undefined {
    return client ? client.info.profileStore ?? 'service' : undefined;
  }

  private async access(kind: ProfileStoreKind) {
    const client = this.connected;
    return client && this.profileStore(client) === kind ? clientAccess(client) : directAccess(kind, this.home, this.context, this.log);
  }

  /**
   * Copies or moves private profiles between the account service and VS Code, both ways. Asks which profiles and
   * whether to copy or move; `preset` skips the second question. Returns whether anything was transferred.
   */
  async transfer(from: ProfileStoreKind, to: ProfileStoreKind, preset?: 'copy' | 'move'): Promise<boolean> {
    try {
      const source = await this.access(from);
      const entries = await source.list();
      if (!entries.length) {
        void vscode.window.showInformationMessage(`AI Usage: ${STORE_TITLES[from]} keeps no profiles to transfer.`);
        return false;
      }
      const picked = await vscode.window.showQuickPick(entries.map((entry) => ({
        label: entry.name, description: [entry.provider === 'claude' ? 'Claude' : 'Codex', entry.email].filter(Boolean).join(' · '), picked: true, entry
      })), { title: `AI Usage · Profiles from ${STORE_TITLES[from]} to ${STORE_TITLES[to]}`, placeHolder: 'The chosen profiles are transferred with their logins', canPickMany: true });
      if (!picked?.length) { return false; }
      let mode = preset;
      if (!mode) {
        const choice = await vscode.window.showQuickPick([
          { label: '$(arrow-right) Move', description: `removes them from ${STORE_TITLES[from]}, so each login is kept in one place`, mode: 'move' as const },
          { label: '$(copy) Copy', description: `keeps them in ${STORE_TITLES[from]} too; a login refreshed in one place can stop working in the other`, mode: 'copy' as const }
        ], { title: `AI Usage · Move or copy ${picked.length} profile${picked.length === 1 ? '' : 's'}` });
        mode = choice?.mode;
      }
      if (!mode) { return false; }
      const target = await this.access(to);
      const summary = await transferProfiles(source, target, picked.map((item) => item.entry), mode === 'move');
      this.log(`profiles: ${mode === 'move' ? 'moved' : 'copied'} ${picked.length} from ${STORE_TITLES[from]} to ${STORE_TITLES[to]}: ${summary}`);
      void vscode.window.showInformationMessage(`AI Usage: ${mode === 'move' ? 'moved' : 'copied'} ${picked.length} profile${picked.length === 1 ? '' : 's'} to ${STORE_TITLES[to]} (${summary}).`);
      await this.refreshViews();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`profiles: transfer from ${STORE_TITLES[from]} to ${STORE_TITLES[to]} failed: ${message}`);
      void vscode.window.showErrorMessage(`AI Usage: could not transfer the profiles: ${message}`);
      return false;
    }
  }

  /** When the store in use is empty but the other one keeps profiles, offers to bring them over, once per session. */

  /**
   * The Account Service menu: status, profiles and transfers, start, stop, restart, reinstall, uninstall, log.
   * Back returns to `back` (an Accounts menu), or to the AI Usage menu of all services.
   */
  async showMenu(back?: { description: string; run: () => Promise<unknown> }): Promise<void> {
    const status = serviceStatus(this.home);
    const client = this.connected;
    type Item = vscode.QuickPickItem & { action?: 'install' | 'start' | 'stop' | 'restart' | 'uninstall' | 'log' | 'settings' | 'toService' | 'toVscode' | 'back' };
    const items: Item[] = [];
    items.push({ label: 'Status', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: status.installed ? `$(package) Installed: version ${status.installed.version}` : '$(package) Not installed',
      detail: status.installed ? `${status.installed.dir} · Node.js ${status.installed.node.command}` : `Bundled version ${this.bundledVersion()} can be installed under ${this.home}.` });
    const embedded = this.host ? ' inside this VS Code window' : readServiceInfo(this.home)?.embedded ? ' inside a VS Code window' : '';
    items.push({ label: status.running ? `$(pass) Running${embedded}: pid ${status.pid}, version ${status.runningVersion}` : '$(circle-slash) Not running',
      detail: client ? `Connected · ${client.info.clients} client${client.info.clients === 1 ? '' : 's'}` : this.enabled ? 'Not connected' : `Turned off by ${ENABLED_SETTING}` });
    items.push({ label: status.autostart.kind === 'none' ? '$(warning) Autostart: none available' : `$(${status.autostart.registered ? 'pass' : 'warning'}) Autostart: ${status.autostart.kind}, ${status.autostart.registered ? 'registered' : 'not registered'}`,
      detail: status.autostart.detail ?? (status.autostart.registered ? 'The service starts when you sign in.' : 'Reinstall to register it.') });
    if (status.launcher) { items.push({ label: '$(terminal) Command: ai-usage', detail: `${status.launcher} · available in VS Code terminals; add ${launcherDir(this.home)} to your PATH elsewhere.` }); }
    const store = this.profileStore(client);
    items.push({ label: 'Profiles', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: `$(database) In use: ${store === 'vscode' ? 'saved in VS Code' : store === 'service' ? 'saved in the account service' : 'none (not connected)'}`,
      detail: store === 'vscode' ? 'No background service is used; the private profiles are in VS Code\'s storage, as before the service. Project profiles are listed too.'
        : store === 'service' ? `The private profiles are in ${this.home}/profiles.json, also without VS Code. Project profiles are listed too.` : undefined });
    items.push({ label: '$(arrow-right) Transfer profiles from VS Code to the account service…', detail: `Copy or move; ${vscodeProfileCount(this.context)} saved in VS Code.`, action: 'toService' });

    items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: status.installed ? '$(sync) Reinstall or upgrade' : '$(cloud-download) Install', detail: `Installs the bundled service ${this.bundledVersion()} and registers it to start at sign-in.`, action: 'install' });
    if (status.installed) {
      items.push({ label: '$(debug-start) Start', action: 'start' });
      items.push({ label: '$(debug-stop) Stop', detail: 'Keep-alives and rotation pause until it is started again.', action: 'stop' });
      items.push({ label: '$(debug-restart) Restart', action: 'restart' });
      items.push({ label: '$(trash) Uninstall', detail: 'Stops and unregisters the service and removes its package; saved profiles and settings are kept.', action: 'uninstall' });
    }
    items.push({ label: '$(output) Open the service log', detail: logFile(this.home), action: 'log' });
    items.push({ label: '$(gear) Settings', description: `${ENABLED_SETTING}, ${BACKGROUND_SETTING}`, action: 'settings' });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(arrow-left) Back', description: back?.description ?? 'AI Usage menu of all services', action: 'back' });
    const picked = await pickWithBack(items, { title: 'AI Usage · Account service', matchOnDetail: true }, (item) => item.action === 'back', async () => {
      this.log(`service: Account service menu → Back to ${back?.description ?? 'the AI Usage menu'}`);
      await (back ? back.run() : vscode.commands.executeCommand('aiUsage.showDetails'));
    });
    if (!picked?.action || picked.action === 'back') { return; }
    switch (picked.action) {
      case 'install': await this.install(); break;
      case 'toService': await this.transfer('vscode', 'service'); break;
      case 'toVscode': await this.transfer('service', 'vscode'); break;
      case 'start': { const result = startService(this.home); void vscode.window.showInformationMessage(`AI Usage: account service ${result.ok ? result.detail : `could not start: ${result.detail}`}.`); await this.ensure(); break; }
      case 'stop': { const result = await stopService(this.home); void vscode.window.showInformationMessage(`AI Usage: account service ${result.detail}.`); break; }
      case 'restart': { const result = await restartService(this.home); void vscode.window.showInformationMessage(`AI Usage: account service ${result.ok ? `restarted (${result.detail})` : `could not restart: ${result.detail}`}.`); await this.ensure(); break; }
      case 'uninstall': {
        const confirmed = await vscode.window.showWarningMessage('Uninstall the AI Usage background service? Accounts, keep-alives and rotation then run inside VS Code while it is open. Saved profiles and settings are kept under ~/.ai-usage.', { modal: true }, 'Uninstall');
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
