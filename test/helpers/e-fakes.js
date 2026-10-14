// Fakes for the vscode API pieces the extracted extension modules take as arguments.
class FakeThemeColor { constructor(id) { this.id = id; } }
class FakeMarkdown {
  constructor(value, supportThemeIcons) { this.value = value ?? ''; this.supportThemeIcons = supportThemeIcons; }
  appendMarkdown(text) { this.value += text; return this; }
  appendText(text) { this.value += `\\TEXT(${text})`; return this; }
}
const api = { ThemeColor: FakeThemeColor, MarkdownString: FakeMarkdown };

function fakeItem() {
  return {
    shown: 0, hidden: 0, text: undefined, tooltip: undefined, command: undefined, color: 'untouched', backgroundColor: 'untouched',
    show() { this.shown += 1; }, hide() { this.hidden += 1; }
  };
}

const NOW = new Date('2026-10-11T12:00:00Z');
const minutes = (n) => new Date(NOW.getTime() + n * 60_000);
function usage(overrides = {}) {
  return {
    provider: 'claude', title: 'Claude', windows: [
      { label: '5h', usedPercent: 17.4, resetsAt: minutes(180) },
      { label: '7d', usedPercent: 25.6, resetsAt: minutes(3 * 24 * 60) }
    ], fetchedAt: NOW, ...overrides
  };
}

module.exports = { FakeThemeColor, FakeMarkdown, api, fakeItem, NOW, minutes, usage };
