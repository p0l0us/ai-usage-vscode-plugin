import { randomUUID } from 'node:crypto';
import { BridgeError, canonical } from './common.mjs';

export class BridgeEngine {
  sessions = new Set(); calls = new Map();
  constructor(adapters, { maxSessions = 8, idleMs = 300000, requestMs = 180000 } = {}) {
    this.adapters = adapters; this.maxSessions = maxSessions; this.idleMs = idleMs; this.requestMs = requestMs;
  }
  async models() {
    const results = await Promise.allSettled(Object.values(this.adapters).map(a => a.models()));
    const models = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    if (!models.length) throw results.find(r => r.status === 'rejected')?.reason || new BridgeError('No CLI backends configured.', 503);
    return models;
  }
  async complete(request, { signal, onText = () => {} } = {}) {
    let state;
    const final = request.messages.at(-1);
    if (final.role === 'tool') {
      state = this.calls.get(final.tool_call_id);
      if (!state) throw new BridgeError('Tool continuation expired or belongs to another bridge instance. Start a new conversation.', 409, 'continuation_expired');
      if (state.busy) throw new BridgeError('This continuation is already running.', 409, 'continuation_busy');
      if (state.signature !== request.signature || canonical(request.messages.slice(0, -1)) !== canonical(state.expected)) {
        throw new BridgeError('Conversation, model, instructions, or tools changed during a pending tool call. Start a new conversation.', 409, 'continuation_mismatch');
      }
      clearTimeout(state.timer); this.calls.delete(final.tool_call_id); state.busy = true;
    } else {
      const adapter = this.adapters[request.model.split('/')[0]];
      if (!adapter) throw new BridgeError('This backend is not enabled.', 404, 'model_not_found');
      if (this.sessions.size >= this.maxSessions) throw new BridgeError('Bridge session limit reached. Finish pending tool calls or retry later.', 429, 'bridge_busy');
      state = { busy: true, signature: request.signature, controller: new AbortController() };
      this.sessions.add(state);
    }
    const controller = state.controller;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timeout = setTimeout(cancel, this.requestMs);
    let text = '';
    try {
      if (controller.signal.aborted) throw new BridgeError('Request cancelled.', 499, 'cancelled');
      if (!state.backend) state.backend = await this.adapters[request.model.split('/')[0]].start(request, controller.signal);
      else await state.backend.reply(state.pendingKey, final.content);
      for (;;) {
        const event = await state.backend.events.next();
        if (controller.signal.aborted) throw new BridgeError('Request cancelled or timed out.', 504, 'request_timeout');
        if (event.type === 'error') throw event.error;
        if (event.type === 'end') throw new BridgeError('Backend session ended before its response completed.');
        if (event.type === 'text') {
          text += event.text;
          if (text.length > 8 * 1024 * 1024) throw new BridgeError('Response size limit exceeded.');
          await onText(event.text);
        }
        if (event.type === 'tool') {
          if (!request.activeTools.some(t => t.name === event.name)) throw new BridgeError('Backend requested a tool not offered by the client.');
          const call = { id: `call_bridge_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name: event.name, arguments: canonical(event.arguments) } };
          const message = { role: 'assistant', content: text, tool_calls: [call] };
          state.expected = [...request.messages, message]; state.pendingKey = event.key; state.busy = false;
          this.calls.set(call.id, state);
          state.timer = setTimeout(() => { void this.dispose(state); }, this.idleMs); state.timer.unref();
          return { message, finish_reason: 'tool_calls' };
        }
        if (event.type === 'done') {
          if (request.choice === 'required' || typeof request.choice === 'object') throw new BridgeError('Backend completed without the required tool call.', 502, 'tool_choice_not_honored');
          await this.dispose(state);
          return { message: { role: 'assistant', content: text }, finish_reason: 'stop', ...(event.usage ? { usage: event.usage } : {}) };
        }
      }
    } catch (error) {
      const aborted = controller.signal.aborted;
      await this.dispose(state);
      if (aborted) throw new BridgeError('Request cancelled or timed out.', 504, 'request_timeout');
      throw error;
    }
    finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
  }
  async dispose(state) {
    clearTimeout(state.timer); state.controller.abort(); this.sessions.delete(state);
    for (const [id, owner] of this.calls) if (owner === state) this.calls.delete(id);
    await state.backend?.close();
  }
  async close() { await Promise.allSettled([...this.sessions].map(s => this.dispose(s))); }
}
