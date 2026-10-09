import * as vscode from 'vscode';

export type PickOptions = Pick<vscode.QuickPickOptions, 'title' | 'placeHolder' | 'matchOnDescription' | 'matchOnDetail'>;

/**
 * `showQuickPick` for a menu whose Back item leads to another menu. Back runs `back` while this menu is still open,
 * so the next menu replaces it. A menu that closes first hands focus back to whatever had it before (a chat view, an
 * editor); in a webview that focus arrives late and closes the next menu as soon as it opens, so Back looked like it
 * closed everything. Any other item closes the menu and resolves as `showQuickPick` would.
 */
export function pickWithBack<T extends vscode.QuickPickItem>(items: T[], options: PickOptions,
  isBack: (item: T) => boolean, back: () => Promise<unknown>): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const picker = vscode.window.createQuickPick<T>();
    picker.title = options.title;
    picker.placeholder = options.placeHolder;
    picker.matchOnDescription = Boolean(options.matchOnDescription);
    picker.matchOnDetail = Boolean(options.matchOnDetail);
    picker.items = items;
    let goingBack = false;
    picker.onDidAccept(() => {
      const item = picker.selectedItems[0] ?? picker.activeItems[0];
      if (!item || goingBack) { return; }
      if (!isBack(item)) {
        resolve(item);
        picker.hide();
        return;
      }
      goingBack = true;
      // The next menu has replaced this one by the time `back` settles; disposing this one then leaves it alone.
      back().then(() => { picker.dispose(); resolve(item); }, (error: unknown) => { picker.dispose(); reject(error); });
    });
    picker.onDidHide(() => {
      if (goingBack) { return; }
      picker.dispose();
      resolve(undefined);
    });
    picker.show();
  });
}
