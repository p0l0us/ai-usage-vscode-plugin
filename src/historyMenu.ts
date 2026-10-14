import type * as vscode from 'vscode';
import type { HistoryInfo } from '../service/out';

export const HISTORY_PERIODS: Array<{ label: string; days?: number }> = [
  { label: 'Summary of the last 7 days', days: 7 },
  { label: 'Summary of the last 30 days', days: 30 },
  { label: 'Summary of the last 90 days', days: 90 },
  { label: 'Summary of everything kept' }
];

export type HistoryItem = vscode.QuickPickItem & { action?: 'summary' | 'readings' | 'events' | 'jsonl' | 'file' | 'settings'; days?: number };

/** The usage history menu: a summary of a period, exports, the files and the settings. */
export function historyItems(info: Pick<HistoryInfo, 'location' | 'enabled' | 'retentionDays'>, separator: vscode.QuickPickItemKind): HistoryItem[] {
  return [
    { label: 'Summary', kind: separator },
    ...HISTORY_PERIODS.map((period): HistoryItem => ({ label: `$(graph) ${period.label}`, action: 'summary', days: period.days })),
    { label: 'Export', kind: separator },
    { label: '$(export) Readings as CSV…', description: 'one row per account, reading and window', action: 'readings' },
    { label: '$(export) Switches, sweeps and check failures as CSV…', action: 'events' },
    { label: '$(json) Everything as JSON Lines…', description: 'the kept month files in one', action: 'jsonl' },
    { label: 'Files', kind: separator },
    { label: '$(file) Open the newest month file', description: info.location, action: 'file' },
    { label: '$(gear) History settings', description: `aiUsage.history.* · ${info.enabled ? `on, kept ${info.retentionDays} days` : 'off'}`, action: 'settings' }
  ];
}

export function historyPlaceholder(info: Pick<HistoryInfo, 'files' | 'location'>): string {
  return `${info.files.length} month file${info.files.length === 1 ? '' : 's'} in ${info.location}`;
}

/** Default name of an exported history file, dated by `now`. */
export function historyExportName(kind: string, extension: string, now: Date): string {
  return `ai-usage-${kind}-${now.toISOString().slice(0, 10)}.${extension}`;
}
