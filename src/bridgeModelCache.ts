import * as vscode from 'vscode';
import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';

export const MODEL_CACHE_KEY = 'bridge.modelCatalog.v1';
export type Backend = 'codex' | 'claude';
export type CachedCatalog = { savedAt: number; models: vscode.LanguageModelChatInformation[] };
export type Catalogs = Partial<Record<Backend, CachedCatalog>>;
export type ModelCacheStorage = Pick<vscode.Memento, 'get' | 'update'>;

/** Scope suggestions to this host and bridge configuration, without reading credentials. */
export function modelCacheSource(): string {
  const config = vscode.workspace.getConfiguration('aiUsage.bridge');
  return createHash('sha256').update(JSON.stringify([
    os.hostname(), config.get('url', 'http://127.0.0.1:3210'),
    config.get('tokenFile', '') || path.join(os.homedir(), '.cli-byok-bridge', 'token'),
    config.get('codex.executable', 'codex'), config.get('claude.executable', 'claude'),
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  ])).digest('hex');
}

export function readModelCache(storage: ModelCacheStorage | undefined, source: string): Catalogs {
  const value = storage?.get<unknown>(MODEL_CACHE_KEY) as { version?: unknown; source?: unknown; catalogs?: Catalogs } | undefined;
  if (!value || value.version !== 1 || value.source !== source || !value.catalogs || typeof value.catalogs !== 'object') return {};
  const catalogs: Catalogs = {};
  for (const backend of ['codex', 'claude'] as const) {
    const entry = value.catalogs[backend];
    if (!entry || !Number.isFinite(entry.savedAt) || entry.savedAt <= 0 || !Array.isArray(entry.models) || entry.models.length > 512) continue;
    if (!entry.models.every(model => model && typeof model.id === 'string' && model.id.startsWith(backend + '/') &&
      ['name', 'family', 'version'].every(key => typeof (model as unknown as Record<string, unknown>)[key] === 'string') &&
      Number.isFinite(model.maxInputTokens) && model.maxInputTokens > 0 && Number.isFinite(model.maxOutputTokens) && model.maxOutputTokens > 0 &&
      model.capabilities && typeof model.capabilities === 'object')) continue;
    catalogs[backend] = { savedAt: entry.savedAt, models: entry.models };
  }
  return catalogs;
}
