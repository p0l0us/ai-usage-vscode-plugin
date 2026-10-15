const fs = require('node:fs');
const path = require('node:path');

exports.hostOptions = (home, mode) => ({
  home, mode, embedded: mode === 'embedded', version: '1.0.10',
  seedConfig: { 'bridge.autoStart': false, 'codex.autoReset.enabled': false, 'claude.api.minIntervalSeconds': 0,
    'claude.keepAlive.enabled': false, 'codex.keepAlive.enabled': false,
    'claude.autoRotate.enabled': false, 'codex.autoRotate.enabled': false },
  engineOptions: {
    now: () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'fixture.json'), 'utf8')).now; } catch { return Date.now(); } },
    // All provider reads in this genuine socket host use local synthetic data.
    fetchUsage: async (provider, context) => {
      const state = JSON.parse(fs.readFileSync(path.join(home, 'fixture.json'), 'utf8'));
      fs.appendFileSync(path.join(home, 'reads.jsonl'), JSON.stringify({ provider, owners: context.workspaceOwners || [] }) + '\n');
      if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
      if (state.kind === 'unavailable') return { kind: 'unavailable', provider, reason: 'No synthetic usage yet.' };
      if (state.kind === 'error') return { kind: 'error', provider, title: provider, message: 'Synthetic provider unavailable', transient: true };
      return { kind: 'ok', usage: { provider, title: provider, fetchedAt: new Date(state.now - (state.ageMs || 0)), windows: [
        { label: '5h', usedPercent: 37, resetsAt: new Date(state.now + 3_600_000) },
        { label: '7d', usedPercent: 56, resetsAt: new Date(state.now + 7 * 86_400_000) },
        ...(provider === 'claude' ? [{ label: '7d Sonnet', usedPercent: 100, resetsAt: new Date(state.now + 7 * 86_400_000) }] : [])
      ] } };
    },
    identityOf: async (provider, credential) => ({ accountId: provider + '-fixture', email: provider + '@example.test' }),
    probe: async () => { throw new Error('The parity fixture must not probe provider accounts.'); },
    verifyCodex: async () => ({ status: 'match', detail: 'Synthetic verification' }),
    syncClaudeMetadata: async () => ({ status: 'match', detail: 'Synthetic metadata' })
  }
});
