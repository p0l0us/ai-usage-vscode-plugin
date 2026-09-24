import * as vscode from 'vscode';

const EXTENSION_ID = 'p0l0us.ai-usage-vscode-plugin';

/**
 * Opens the Settings editor on AI Usage's settings, optionally narrowed to one prefix such as `aiUsage.claude`
 * (which also matches its `aiUsage.claudeConfig` section). `openSettings2` always opens the UI editor, even when
 * `workbench.settings.editor` is `json`, where `openSettings` would open settings.json instead.
 */
export async function openAiUsageSettings(prefix?: string): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings2', { query: `@ext:${EXTENSION_ID}${prefix ? ` ${prefix}` : ''}` });
}
