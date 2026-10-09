/**
 * `window.createQuickPick` for the vscode mocks, answered from the same queue as their `showQuickPick`: a response is
 * the picked item, a function of the items and options that returns it, or undefined for Escape. `menus` records each
 * menu's title with `shown`, `hidden` and `disposed`, so a test can tell whether one was still open when the next opened.
 */
function quickPickFactory(responses, menus = []) {
  return () => {
    const listeners = { accept: [], hide: [] };
    const menu = { shown: false, hidden: false, disposed: false };
    const picker = {
      items: [], selectedItems: [], activeItems: [],
      onDidAccept(listener) { listeners.accept.push(listener); return { dispose() {} }; },
      onDidHide(listener) { listeners.hide.push(listener); return { dispose() {} }; },
      show() {
        menu.title = picker.title; menu.shown = true; menus.push(menu);
        const response = responses.shift();
        const item = typeof response === 'function' ? response(picker.items, { title: picker.title, placeHolder: picker.placeholder }, picker) : response;
        Promise.resolve(item).then((picked) => {
          if (picked) { picker.selectedItems = [picked]; picker.activeItems = [picked]; listeners.accept.forEach((listener) => listener()); }
          else { picker.hide(); }
        });
      },
      hide() { if (!menu.hidden) { menu.hidden = true; listeners.hide.forEach((listener) => listener()); } },
      dispose() { menu.disposed = true; }
    };
    return picker;
  };
}

module.exports = { quickPickFactory };
