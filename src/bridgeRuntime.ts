import * as vscode from 'vscode';
import { bridgeServiceCall } from './bridgeIntegration';
/** The service owns process startup and lifetime; closing a VS Code window only releases this client. */
export class BridgeRuntime implements vscode.Disposable {
  private disposed = false;
  constructor(_extensionPath: string) {}
  async ensure(): Promise<void> {
    if (this.disposed) throw new Error('Bridge client is closed.');
    await bridgeServiceCall('bridge.ensure');
  }
  dispose(): void { this.disposed = true; }
}
