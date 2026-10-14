import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The engine fingerprints the CLI homes' credential and settings files; the real ones change whenever a live
// session refreshes its login or AI Usage writes its settings, which would fail a resume as "account changed".
// Imported first by every test that runs the engine; a test may still point a variable elsewhere and restore it.
const homes = mkdtempSync(path.join(os.tmpdir(), 'bridge-test-homes-'));
process.env.CLAUDE_CONFIG_DIR = path.join(homes, 'claude');
process.env.CODEX_HOME = path.join(homes, 'codex');
process.on('exit', () => rmSync(homes, { recursive: true, force: true }));
