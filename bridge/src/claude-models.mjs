import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, spawnCommand, readJsonLines, terminate } from './common.mjs';

// The native extension uses the same initialize control response for its picker.
// Send no user message: catalog discovery must never trigger model inference.
export async function claudeModels(command, signal) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'byok-claude-models-'));
  let child; let timer; let cancel;
  try {
    if (signal?.aborted) throw new BridgeError('Model discovery cancelled.', 499, 'cancelled');
    child = spawnCommand(command, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--tools', '', '--restricted', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--settings', '{"disableAllHooks":true}', '--no-session-persistence'], { cwd: directory });
    return await new Promise((resolve, reject) => {
      cancel = () => reject(new BridgeError('Model discovery cancelled.', 499, 'cancelled'));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      timer = setTimeout(() => reject(new BridgeError('Claude model discovery timed out.', 504, 'discovery_timeout')), 12000);
      child.once('error', () => reject(new BridgeError('Could not start Claude model discovery.', 503, 'cli_incompatible')));
      child.once('exit', () => reject(new BridgeError('Claude exited before reporting its model catalog.', 503, 'cli_incompatible')));
      readJsonLines(child.stdout, message => {
        if (message.type !== 'control_response' || message.response?.request_id !== 'bridge-models') return;
        const response = message.response;
        const models = response.response?.models;
        if (response.subtype !== 'success' || !Array.isArray(models)) {
          reject(new BridgeError('Claude did not return a native model catalog. Update the CLI and check its login.', 503, 'cli_incompatible')); return;
        }
        resolve(models.map(model => {
          if (typeof model.value !== 'string' || !/^[a-zA-Z0-9._-]+(?:\[1m\])?$/.test(model.value)) throw new BridgeError('Claude returned an unsupported model identifier.', 503, 'cli_incompatible');
          return { id: `claude/${model.value}`, object: 'model', created: 0, owned_by: 'claude-cli', bridge: {
            display_name: model.displayName || model.value, resolved_model: model.resolvedModel,
            description: model.description, tool_calling: true, image_input: true,
            reasoning_efforts: model.supportsEffort ? (model.supportedEffortLevels || []) : [],
            experimental: true, history: 'serialized', discovery: 'native_initialize',
            availability: 'native CLI catalog; inference access and billing checked by CLI'
          } };
        }));
      }, reject);
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'bridge-models', request: { subtype: 'initialize' } }) + '\n');
    });
  } finally {
    clearTimeout(timer); if (cancel) signal?.removeEventListener('abort', cancel);
    await terminate(child); await rm(directory, { recursive: true, force: true });
  }
}
