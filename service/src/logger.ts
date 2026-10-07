import * as fs from 'fs';
import * as path from 'path';

/** Above this size the log is rolled over to `<file>.1`, which replaces the previous rollover. */
export const LOG_ROLLOVER_BYTES = 2 * 1024 * 1024;

/**
 * Append-only log with one rollover. Lines are also handed to listeners, which is how connected clients
 * (the VS Code output channel, `ai-usage log -f`) see the service's log live.
 */
export class Logger {
  private readonly listeners = new Set<(line: string) => void>();
  private size = 0;

  constructor(private readonly file?: string, private readonly maxBytes = LOG_ROLLOVER_BYTES) {
    if (file) {
      try { this.size = fs.statSync(file).size; } catch { this.size = 0; }
    }
  }

  log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    if (this.file) {
      try {
        if (this.size + line.length + 1 > this.maxBytes) {
          try { fs.renameSync(this.file, `${this.file}.1`); } catch { /* Nothing to roll over. */ }
          this.size = 0;
        }
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        fs.appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
        this.size += line.length + 1;
      } catch { /* Logging must never break the service. */ }
    }
    for (const listener of this.listeners) {
      try { listener(line); } catch { /* A listener's failure is its own. */ }
    }
  }

  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The last `count` lines, oldest first, including the rolled-over file when the current one is short. */
  static tail(file: string, count: number): string[] {
    const lines: string[] = [];
    for (const candidate of [`${file}.1`, file]) {
      try { lines.push(...fs.readFileSync(candidate, 'utf8').split(/\r?\n/).filter(Boolean)); } catch { /* Absent. */ }
    }
    return lines.slice(-Math.max(0, count));
  }
}
