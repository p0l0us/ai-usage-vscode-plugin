// Generates the chat-input usage chips in package.json.
//
// The chat input's status toolbar (`chat/input/status`) renders menu items with the static title
// and icon from the manifest, so each provider gets one icon-only chip whose `when` clause
// matches the chat's agent against the context keys the extension sets at runtime. Clicking a
// chip runs `aiUsage.showDetails` for that provider. This script is idempotent: it removes all
// previously generated `aiUsage.chip.*` entries and regenerates them.
const fs = require('fs');
const path = require('path');

// `aiUsage.chip.debug` bypasses the agent match so a missing chip can be told apart from a missing value
// (with it on, every service's chip shows, e.g. Copilot's in a Claude chat).
const agentMatch = (re) =>
  `(aiUsage.chip.debug || chatAgentHostProviderId =~ /${re}/i || lockedCodingAgentId =~ /${re}/i || chatSessionType =~ /${re}/i || sessionType =~ /${re}/i)`;

const PROVIDERS = [
  // Agent identity is exposed through several context keys depending on the surface: the locked
  // agent-host provider id ("claude"), the locked coding agent id, the chat session type
  // ("agent-host-claude") and, in the Agents window, the session type. Match any of them.
  { id: 'claude', title: 'Claude usage', icon: '$(claude)', match: agentMatch('claude|anthropic') },
  { id: 'codex', title: 'Codex usage', icon: '$(openai)', match: agentMatch('codex|openai') },
  // Copilot: regular (unlocked) chat, or a Copilot CLI / cloud agent session.
  { id: 'copilot', title: 'Copilot usage', icon: '$(copilot)', match: `(!lockedToCodingAgent || ${agentMatch('copilot')})` }
];
const CHIP_PREFIX = 'aiUsage.chip.';
// Only the `navigation` group is rendered inline by the chat input status toolbar; other groups
// end up in a hidden overflow menu.
const CHIP_GROUP = 'navigation';

const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.contributes = pkg.contributes || {};
pkg.contributes.menus = pkg.contributes.menus || {};

const isChip = (entry) => typeof entry.command === 'string' && entry.command.startsWith(CHIP_PREFIX);
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
  // One icon-only chip per provider; `aiUsage.chip.<provider>` is set by the extension while the
  // provider is enabled and chips are on. The figures live in the details opened by a click.
  const command = `${CHIP_PREFIX}${provider.id}`;
  commands.push({ command, title: provider.title, category: 'AI Usage', icon: provider.icon });
  statusMenu.push({
    command,
    when: `${WINDOW_GATE} && ${provider.match} && ${command}`,
    group: `${CHIP_GROUP}@${index}`
  });
  paletteMenu.push({ command, when: 'false' });
  generated++;
});

// Debug chip (aiUsage.chatChips.debug) to confirm the toolbar renders at all.
const debugCommand = `${CHIP_PREFIX}debug`;
commands.push({ command: debugCommand, title: 'AI Usage chips active', category: 'AI Usage', icon: '$(debug)' });
statusMenu.push({ command: debugCommand, when: `${WINDOW_GATE} && aiUsage.chip.debug`, group: `${CHIP_GROUP}@${PROVIDERS.length}` });
paletteMenu.push({ command: debugCommand, when: 'false' });
generated++;

pkg.contributes.commands = commands;
pkg.contributes.menus['chat/input/status'] = statusMenu;
pkg.contributes.menus.commandPalette = paletteMenu;

fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log(`generated ${generated} chip commands`);
