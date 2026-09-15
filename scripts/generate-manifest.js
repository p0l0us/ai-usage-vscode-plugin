// Generates the chat-input usage chips in package.json.
//
// The chat input's status toolbar (`chat/input/status`) renders a menu item without an icon as
// its static title, and its hover repeats that title (an item with an icon would drop the title,
// and there is no separate tooltip). Live text therefore needs one command per possible label;
// `when` clauses pick the one matching the chat's agent and the context keys the extension sets
// at runtime:
//   aiUsage.chip.<provider>.simple   "37%"-style single figure or a state (pending/unavailable/error)
//   aiUsage.chip.<provider>.<window> the figure of that window in rich mode, e.g. "4%"
//   aiUsage.chip.named               whether the first item is prefixed with the service name
// Clicking any chip runs `aiUsage.showDetails` for its provider. This script is idempotent: it
// removes all previously generated `aiUsage.chip.*` entries and regenerates them.
const fs = require('fs');
const path = require('path');

// `aiUsage.chip.debug` bypasses the agent match so a missing chip can be told apart from a missing value
// (with it on, every service's chip shows, e.g. Copilot's in a Claude chat).
const agentMatch = (re) =>
  `(aiUsage.chip.debug || chatAgentHostProviderId =~ /${re}/i || lockedCodingAgentId =~ /${re}/i || chatSessionType =~ /${re}/i || sessionType =~ /${re}/i)`;

// `windows` are the labels shown in rich mode (must match src/extension.ts CHIP_WINDOWS); a provider
// without any is always shown as a single figure. Agent identity is exposed through several context
// keys depending on the surface: the locked agent-host provider id ("claude"), the locked coding
// agent id, the chat session type ("agent-host-claude") and, in the Agents window, the session type.
const PROVIDERS = [
  { id: 'claude', title: 'Claude', windows: ['5h', '7d'], match: agentMatch('claude|anthropic') },
  { id: 'codex', title: 'Codex', windows: ['5h', '7d'], match: agentMatch('codex|openai') },
  // Copilot: regular (unlocked) chat, or a Copilot CLI / cloud agent session. Single monthly window.
  { id: 'copilot', title: 'Copilot', windows: [], match: `(!lockedToCodingAgent || ${agentMatch('copilot')})` }
];
const CHIP_PREFIX = 'aiUsage.chip.';
const TOKEN_CHIP_PREFIX = 'aiUsage.chatTokens.chip.';
const NAMED_KEY = `${CHIP_PREFIX}named`;
// Only the `navigation` group is rendered inline by the chat input status toolbar; other groups
// end up in a hidden overflow menu.
const CHIP_GROUP = 'navigation';
// Non-numeric states of the single-figure item and their label.
const STATES = { pending: '…', unavailable: 'n/a', error: '!' };
const PERCENTS = Array.from({ length: 101 }, (_, percent) => String(percent));

const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.contributes = pkg.contributes || {};
pkg.contributes.menus = pkg.contributes.menus || {};

const isChip = (entry) => typeof entry.command === 'string' &&
  (entry.command.startsWith(CHIP_PREFIX) || entry.command.startsWith(TOKEN_CHIP_PREFIX));
const commands = (pkg.contributes.commands || []).filter((c) => !isChip(c));
const statusMenu = (pkg.contributes.menus['chat/input/status'] || []).filter((m) => !isChip(m));
const paletteMenu = (pkg.contributes.menus.commandPalette || []).filter((m) => !isChip(m));

// `isSessionsWindow` is VS Code's context key for the Agents window (which has no status bar);
// `aiUsage.chip.agentsWindow` mirrors aiUsage.chatChips.agentsWindow. In a regular VS Code window
// `aiUsage.chip.workbench` is set by the extension from aiUsage.chatChips.workbench and whether a
// status bar with the same figures is visible.
const WINDOW_GATE = '((isSessionsWindow && aiUsage.chip.agentsWindow) || (!isSessionsWindow && aiUsage.chip.workbench))';
let generated = 0;
PROVIDERS.forEach((provider, index) => {
  const base = index * 1000;
  const key = `${CHIP_PREFIX}${provider.id}`;
  const add = (command, title, when, group) => {
    commands.push({ command, title, category: 'AI Usage' });
    statusMenu.push({ command, when: `${WINDOW_GATE} && ${provider.match} && ${when}`, group: `${CHIP_GROUP}@${group}` });
    paletteMenu.push({ command, when: 'false' });
    generated++;
  };
  // The first item exists with and without the service name (aiUsage.chatChips.labels).
  const addFirst = (command, text, when, group) => {
    add(command, text, `${when} && !${NAMED_KEY}`, group);
    add(`${command}.named`, `${provider.title} ${text}`, `${when} && ${NAMED_KEY}`, group);
  };

  // Single figure ("37%", the most used window) or a state; also the fallback in rich mode.
  for (const [state, text] of [...Object.entries(STATES), ...PERCENTS.map((percent) => [percent, `${percent}%`])]) {
    addFirst(`${key}.simple.${state}`, text, `${key}.simple == '${state}'`, base);
  }
  // Rich mode: one percentage per window. A menu command's title is static, so the live reset
  // countdown used by the status bar cannot be embedded here without generating every possible
  // percentage/countdown combination. Details identify the window and its reset time.
  provider.windows.forEach((window, windowIndex) => {
    for (const percent of PERCENTS) {
      const command = `${key}.${window}.${percent}`;
      const text = `${percent}%`;
      const when = `${key}.${window} == '${percent}'`;
      if (windowIndex === 0) {
        addFirst(command, text, when, base + 1 + windowIndex);
      } else {
        add(command, text, when, base + 1 + windowIndex);
      }
    }
  });

  // Per-chat token totals are available from local Claude and Codex session logs. Titles are
  // quantized to one significant digit so dynamic-looking labels need only a bounded command set.
  if (provider.id !== 'copilot') {
    const labels = new Set(['0', '1b+']);
    for (const [start, end, step, divisor, suffix] of [
      [0, 1_000, 100, 1, ''],
      [1_000, 10_000, 1_000, 1_000, 'k'],
      [10_000, 100_000, 10_000, 1_000, 'k'],
      [100_000, 1_000_000, 100_000, 1_000, 'k'],
      [1_000_000, 10_000_000, 1_000_000, 1_000_000, 'm'],
      [10_000_000, 100_000_000, 10_000_000, 1_000_000, 'm'],
      [100_000_000, 1_000_000_000, 100_000_000, 1_000_000, 'm']
    ]) {
      for (let value = start; value < end; value += step) {
        const scaled = value / divisor;
        labels.add(`${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}${suffix}`);
      }
    }
    for (const label of labels) {
      const encoded = label.replace('.', '_').replace('+', 'plus');
      const command = `${TOKEN_CHIP_PREFIX}${provider.id}.${encoded}`;
      commands.push({ command, title: `${label} tokens`, category: 'AI Usage' });
      statusMenu.push({
        command,
        when: `${WINDOW_GATE} && ${provider.match} && aiUsage.chatTokens.${provider.id} == '${label}'`,
        group: `${CHIP_GROUP}@${base + 100}`
      });
      paletteMenu.push({ command, when: 'false' });
      generated++;
    }
  }
});

// Debug chip (aiUsage.chatChips.debug) to confirm the toolbar renders at all.
const debugCommand = `${CHIP_PREFIX}debug`;
commands.push({ command: debugCommand, title: 'AI Usage chips active', category: 'AI Usage', icon: '$(debug)' });
statusMenu.push({ command: debugCommand, when: `${WINDOW_GATE} && aiUsage.chip.debug`, group: `${CHIP_GROUP}@${PROVIDERS.length * 1000}` });
paletteMenu.push({ command: debugCommand, when: 'false' });
generated++;

pkg.contributes.commands = commands;
pkg.contributes.menus['chat/input/status'] = statusMenu;
pkg.contributes.menus.commandPalette = paletteMenu;

fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log(`generated ${generated} chip commands`);
