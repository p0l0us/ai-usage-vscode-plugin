import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Only released, saved-session metadata and bounded child result summaries
// belong on disk. Main transcripts, credentials, and live continuation state
// are never stored here.
export class SessionRecords {
  pending = Promise.resolve();
  lastSaved = new Map();
  constructor(file) { this.file = file; }
  async load() {
    if (!this.file) return [];
    try {
      const records = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(records)) throw new Error('Invalid saved bridge session records.');
      const saved = records.filter(record => record?.persisted === true && record.released === true &&
        /^[a-f0-9-]{36}$/.test(record.id) && ['claude', 'codex'].includes(record.backend) &&
        typeof record.native_session_id === 'string' && typeof record.cwd === 'string').slice(-1000);
      this.lastSaved = new Map(saved.map(record => [record.id, record]));
      return saved;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  save(records) {
    if (!this.file) return Promise.resolve();
    const saved = [...records].filter(r => r.persisted && r.released && r.native_session_id)
      .slice(-1000).map(({ id, model, backend, native_session_id, cwd, cli_executable, started_at, ended_at, status, error_code, usage, usage_scope, conversation_id, account_fingerprint, native_tools, parent_id, child_ids, subagents }) => ({
        id, model, backend, native_session_id, cwd, cli_executable, started_at, ended_at, status, error_code,
        conversation_id, account_fingerprint, native_tools,
        usage, usage_scope, persisted: true, released: true, account: null, parent_id: parent_id || null, child_ids: child_ids || [], subagents: subagents || [], phases: []
      }));
    // A different chat completing must not erase the previous checkpoint of
    // a session that is currently running a long follow-up turn.
    for (const record of saved) this.lastSaved.set(record.id, record);
    this.lastSaved = new Map([...this.lastSaved].slice(-1000));
    const data = JSON.stringify([...this.lastSaved.values()]) + '\n';
    const work = this.pending.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, data, { mode: 0o600 });
        await rename(temporary, this.file);
      } finally { await rm(temporary, { force: true }); }
    });
    this.pending = work.catch(() => {});
    return work;
  }
}
