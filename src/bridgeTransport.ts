import * as http from 'http';
import * as vscode from 'vscode';
import { bridgeConnection, Session } from './bridgeIntegration';

export type BridgeFrame = { bridge_subagent?: { session_id: string; agent: import('./bridgeIntegration').Subagent }; bridge_session?: Session; error?: { message?: string }; choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[] };

/** Consume bounded SSE frames; a truncated stream is an error, never a successful answer. */
export async function streamBridge(body: unknown, onFrame: (frame: BridgeFrame, sessionId?: string) => void | Promise<void>, cancellation: vscode.CancellationToken): Promise<{ sessionId?: string; finishReason?: string }> {
  const { endpoint, token } = await bridgeConnection();
  if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
  const data = JSON.stringify(body);
  if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new Error('The bridge request exceeds 8 MiB. Reduce conversation context or attachments.');
  return new Promise((resolve, reject) => {
    let buffer = ''; let done = false; let finished = false; let bytes = 0;
    let finishReason: string | undefined;
    let pending = Promise.resolve();
    let failed = false;
    const request = http.request(new URL('/v1/chat/completions', endpoint), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    }, response => {
      const rawId = response.headers['x-cli-bridge-session-id'];
      const sessionId = typeof rawId === 'string' && /^[a-f0-9-]{36}$/.test(rawId) ? rawId : undefined;
      response.setEncoding('utf8');
      response.on('error', () => reject(new Error('Bridge response was interrupted.')));
      response.on('data', (chunk: string) => {
        try {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 16 * 1024 * 1024) throw new Error('Bridge response exceeded its size limit.');
          buffer += chunk;
          if (response.statusCode !== 200) return;
          if (!response.headers['content-type']?.startsWith('text/event-stream')) throw new Error('Bridge did not return an event stream.');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const payload = event.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
            if (!payload) continue;
            if (payload === '[DONE]') { done = true; continue; }
            const frame = JSON.parse(payload) as BridgeFrame;
            if (frame.error) throw new Error(frame.error.message || 'Bridge inference failed.');
            for (const choice of frame.choices || []) {
              if (choice.finish_reason) { finished = true; finishReason = choice.finish_reason; }
            }
            // Session link resolution may be asynchronous. Preserve wire order
            // so the session header always precedes the first answer token.
            pending = pending.then(async () => {
              if (!failed && !cancellation.isCancellationRequested) await onFrame(frame, sessionId);
            }).catch(error => { failed = true; reject(error); response.destroy(); request.destroy(); });
          }
        } catch (error) {
          failed = true;
          reject(error instanceof Error ? error : new Error('Invalid bridge response.'));
          // Reject before closing the response. Passing our application error to
          // destroy can re-emit it on a keep-alive socket after its request closed.
          response.destroy(); request.destroy();
        }
      });
      response.on('end', async () => {
        if (response.statusCode !== 200) {
          let message = `Bridge returned HTTP ${response.statusCode}.`;
          try { message = JSON.parse(buffer).error?.message || message; } catch { /* Keep status-only error. */ }
          reject(new Error(message));
        } else if (!done || !finished) reject(new Error('Bridge response ended before completion.'));
        else {
          await pending;
          if (failed) return;
          if (cancellation.isCancellationRequested) { reject(new vscode.CancellationError()); return; }
          resolve({ sessionId, finishReason });
        }
      });
    });
    const subscription = cancellation.onCancellationRequested(() => request.destroy(new vscode.CancellationError()));
    const backend = String((body as { model?: string }).model || '').split('/')[0];
    const configured = vscode.workspace.getConfiguration('aiUsage.bridge').get<number>(`${backend}.requestTimeoutMinutes`, 60);
    const minutes = Number.isInteger(configured) && configured >= 1 && configured <= 1440 ? configured : 60;
    const timer = setTimeout(() => request.destroy(new Error('Bridge inference timed out.')), minutes * 60000 + 15000);
    request.on('error', reject);
    request.on('close', () => { clearTimeout(timer); subscription.dispose(); });
    request.end(data);
  });
}
