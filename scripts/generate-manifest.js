// Generates the chat-input usage chips in package.json.
//
// Menu item labels in VS Code are static strings from the manifest, so to show a live
// percentage in the chat input's status toolbar (`chat/input/status`) we contribute one
// command per (window label, percent) pair and let `when` clauses pick the one that matches
// the context keys the extension sets at runtime. This script is idempotent: it removes all
// previously generated `aiUsage.chip.*` entries and regenerates them.
const fs = require('fs');
const path = require('path');

// Commands are generated per provider (aiUsage.chip.<provider>.<window>.<percent>) so that a
// click can open the details of that particular agent. Each provider lists the windows its
// service reports.
// `aiUsage.chip.debug` bypasses the agent match so a missing chip can be told apart from a missing value
// (with it on, every service's chips show, e.g. Copilot's in a Claude chat).
const agentMatch = (re) =>
  `(aiUsage.chip.debug || chatAgentHostProviderId =~ /${re}/i || lockedCodingAgentId =~ /${re}/i || chatSessionType =~ /${re}/i || sessionType =~ /${re}/i)`;

const PROVIDERS = [
  // Locked agent-host session ids look like "claude", "codex", "copilotcli"; the coding
  // agent id is the chat session contribution type (e.g. "agent-host-claude").
  // Agent identity is exposed through several context keys depending on the surface: the locked
  // agent-host provider id ("claude"), the locked coding agent id, the chat session type
  // ("agent-host-claude") and, in the Agents window, the session type. Match any of them.
  { id: 'claude', icon: '$(claude)', windows: ['5h', '7d'], match: agentMatch('claude|anthropic') },
  { id: 'codex', icon: '$(openai)', windows: ['5h', '7d'], match: agentMatch('codex|openai') },
  // Copilot: regular (unlocked) chat, or a Copilot CLI / cloud agent session.
  { id: 'copilot', icon: '$(copilot)', windows: ['month'], match: `(!lockedToCodingAgent || ${agentMatch('copilot')})` }
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
PROVIDERS.forEach((provider, providerIndex) => {
  const base = providerIndex * 1000;

  // Service icon chip (aiUsage.chatChips.icon), placed before that provider's figures. Menu items
  // with an icon render icon-only, so the icon and the percentages have to be separate chips.
  const hasValue = [
    ...provider.windows.map((window) => `aiUsage.chip.${provider.id}.${window}`),
    `aiUsage.chip.${provider.id}.error`,
    `aiUsage.chip.${provider.id}.unavailable`
  ].join(' || ');
  const iconCommand = `${CHIP_PREFIX}${provider.id}.icon`;
  commands.push({ command: iconCommand, title: `${provider.id[0].toUpperCase()}${provider.id.slice(1)} usage`, category: 'AI Usage', icon: provider.icon });
  statusMenu.push({
    command: iconCommand,
    when: `${WINDOW_GATE} && ${provider.match} && aiUsage.chip.icon && (${hasValue})`,
    group: `${CHIP_GROUP}@${base}`
  });
  paletteMenu.push({ command: iconCommand, when: 'false' });
  generated++;

  provider.windows.forEach((window, windowIndex) => {
    for (let percent = 0; percent <= 100; percent++) {
      const command = `${CHIP_PREFIX}${provider.id}.${window}.${percent}`;
      // Copilot has a single monthly window, so its chip is just the percentage.
      const title = window === 'month' ? `${percent}%` : `${percent}% (${window})`;
      commands.push({ command, title, category: 'AI Usage' });
      statusMenu.push({
        command,
        when: `${WINDOW_GATE} && ${provider.match} && aiUsage.chip.${provider.id}.${window} == '${percent}'`,
        group: `${CHIP_GROUP}@${base + 1 + windowIndex * 101 + percent}`
      });
      paletteMenu.push({ command, when: 'false' });
      generated++;
    }
  });

  // Warning chip when the provider is signed in but usage could not be read.
  const errorCommand = `${CHIP_PREFIX}${provider.id}.error`;
  commands.push({ command: errorCommand, title: 'AI usage unavailable', category: 'AI Usage', icon: '$(warning)' });
  statusMenu.push({
    command: errorCommand,
    when: `${WINDOW_GATE} && ${provider.match} && aiUsage.chip.${provider.id}.error`,
    group: `${CHIP_GROUP}@${base + 900}`
  });
  paletteMenu.push({ command: errorCommand, when: 'false' });
  generated++;

  // "n/a" chip when the chat's agent is not signed in where the extension runs (for example a
  // Claude chat in the Agents window, whose local extension cannot see a remote login). Clicking
  // it opens the details, which say where to sign in.
  const unavailableCommand = `${CHIP_PREFIX}${provider.id}.unavailable`;
  commands.push({ command: unavailableCommand, title: 'n/a', category: 'AI Usage' });
  statusMenu.push({
    command: unavailableCommand,
    when: `${WINDOW_GATE} && ${provider.match} && aiUsage.chip.${provider.id}.unavailable`,
    group: `${CHIP_GROUP}@${base + 950}`
  });
  paletteMenu.push({ command: unavailableCommand, when: 'false' });
  generated++;
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
