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
const PROVIDERS = [
  // Locked agent-host session ids look like "claude", "codex", "copilotcli"; the coding
  // agent id is the chat session contribution type (e.g. "agent-host-claude").
  { id: 'claude', windows: ['5h', '7d'], match: '(chatAgentHostProviderId =~ /claude/i || lockedCodingAgentId =~ /claude/i)' },
  { id: 'codex', windows: ['5h', '7d'], match: '(chatAgentHostProviderId =~ /codex|openai/i || lockedCodingAgentId =~ /codex|openai/i)' },
  // Copilot: regular (unlocked) chat, or a Copilot CLI / cloud agent session.
  { id: 'copilot', windows: ['month'], match: '(!lockedToCodingAgent || chatAgentHostProviderId =~ /copilot/i || lockedCodingAgentId =~ /copilot/i)' }
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

// `isSessionsWindow` is VS Code's context key for the Agents window; `aiUsage.chip.agentsWindow`
// mirrors the aiUsage.chatChips.agentsWindow setting.
const WINDOW_GATE = '(!isSessionsWindow || aiUsage.chip.agentsWindow)';
let generated = 0;
PROVIDERS.forEach((provider, providerIndex) => {
  const base = providerIndex * 1000;
  provider.windows.forEach((window, windowIndex) => {
    for (let percent = 0; percent <= 100; percent++) {
      const command = `${CHIP_PREFIX}${provider.id}.${window}.${percent}`;
      // Copilot has a single monthly window, so its chip is just the percentage.
      const title = window === 'month' ? `${percent}%` : `${percent}% (${window})`;
      commands.push({ command, title, category: 'AI Usage' });
      statusMenu.push({
        command,
        when: `${WINDOW_GATE} && ${provider.match} && aiUsage.chip.${provider.id}.${window} == '${percent}'`,
        group: `${CHIP_GROUP}@${base + windowIndex * 101 + percent}`
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
