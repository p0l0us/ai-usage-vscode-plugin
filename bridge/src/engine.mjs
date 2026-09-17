import { randomUUID } from 'node:crypto';
import { BridgeError, canonical, accountFingerprint } from './common.mjs';
import { ModelDiscovery, identityKey } from './discovery.mjs';
import { SessionSettings, sessionLaunch } from './session-settings.mjs';
import { SessionRecords } from './session-records.mjs';

function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new BridgeError('Request cancelled.', 499, 'cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

export class BridgeEngine {
  sessions = new Set(); calls = new Map(); records = new Map();
  constructor(adapters, { maxSessions = 8, idleMs, requestMs, discoveryMs = 15000, discoveryTtlMs = 60000, sessionSettingsFile, sessionRecordsFile } = {}) {
    this.adapters = adapters; this.maxSessions = maxSessions; this.idleMs = idleMs; this.requestMs = requestMs;
    this.discovery = new ModelDiscovery(adapters, { timeoutMs: discoveryMs, ttlMs: discoveryTtlMs });
    this.sessionSettings = new SessionSettings(sessionSettingsFile);
    this.sessionRecords = new SessionRecords(sessionRecordsFile);
  }
  async loadSessionRecords() {
    for (const record of await this.sessionRecords.load()) this.records.set(record.id, record);
  }
  models(backend) { return this.discovery.models(backend); }
  diagnose() { return this.discovery.diagnose(); }
  phase(state, phase) {
    state.record.status = phase; state.record.updated_at = Date.now();
    state.record.phases.push({ phase, at: state.record.updated_at });
    if (state.record.phases.length > 100) state.record.phases.shift();
  }
  inspect(id) {
    const records = id ? [this.records.get(id)].filter(Boolean) : [...this.records.values()];
    return records.map(r => ({ ...r, launch: sessionLaunch(r, this.sessionSettings.value[r.backend]), elapsed_ms: (r.ended_at || Date.now()) - r.started_at }));
  }
  graph(id) {
    const pending = [id], seen = new Set(), data = [];
    let remaining = 200, truncated = false;
    while (pending.length && remaining > 0) {
      const next = pending.shift();
      if (seen.has(next)) continue;
      seen.add(next);
      const record = this.inspect(next)[0];
      if (!record) continue;
      remaining--;
      const children = record.subagents || [];
      const subagents = children.slice(0, remaining).map(({ summary, ...agent }) => agent);
      remaining -= subagents.length;
      truncated ||= subagents.length < children.length;
      const { model, backend, status, parent_id, persisted, released, elapsed_ms } = record;
      data.push({ id: next, model, backend, status, parent_id, persisted, released, elapsed_ms, subagents });
      for (const child of this.records.values()) if (child.parent_id === next && !seen.has(child.id)) pending.push(child.id);
    }
    return { data, truncated: truncated || pending.length > 0 };
  }
  idle(state) {
    state.busy = false;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { this.phase(state, 'expired'); void this.dispose(state).catch(() => {}); }, state.idleMs); state.timer.unref();
  }
  async complete(request, { signal, onText = () => {}, onSession = () => {}, onSessionReady = () => {}, onSubagent = () => {} } = {}) {
    let state; let nextTurn = false;
    const final = request.messages.at(-1);
    const backendName = request.model.split('/')[0];
    const adapter = this.adapters[backendName];
    if (!adapter) throw new BridgeError('This backend is not enabled.', 404, 'model_not_found');
    if (final.role === 'tool') {
      state = this.calls.get(final.tool_call_id);
      if (!state) throw new BridgeError('Tool continuation expired or belongs to another bridge instance. Start a new conversation.', 409, 'continuation_expired');
      if (request.conversationId && state.record.conversation_id && request.conversationId !== state.record.conversation_id) throw new BridgeError('Conversation ID does not own this tool call.', 409, 'continuation_mismatch');
      if (request.sessionId && state.record.id !== request.sessionId) throw new BridgeError('Session ID does not own this tool call.', 409, 'continuation_mismatch');
      if (state.busy) throw new BridgeError('This continuation is already running.', 409, 'continuation_busy');
      if (state.signature !== request.signature || canonical(request.messages.slice(0, -1)) !== canonical(state.expected)) {
        throw new BridgeError('Conversation, model, instructions, or tools changed during a pending tool call. Start a new conversation.', 409, 'continuation_mismatch');
      }
      clearTimeout(state.timer); this.calls.delete(final.tool_call_id); state.busy = true;
    } else if (request.sessionId) {
      state = [...this.sessions].find(s => s.record.id === request.sessionId);
      if (!state || !state.persist) throw new BridgeError('Session expired. Start a fresh conversation without bridge_session_id.', 409, 'continuation_expired');
      if (state.busy || state.record.status !== 'idle') throw new BridgeError('Session is not ready for a new turn.', 409, 'continuation_busy');
      if (state.signature !== request.signature || canonical(request.messages.slice(0, -1)) !== canonical(state.expected)) throw new BridgeError('History or model settings changed. Start a fresh conversation without bridge_session_id.', 409, 'continuation_mismatch');
      state.busy = true; nextTurn = true; clearTimeout(state.timer);
    } else {
      if (this.sessions.size >= this.maxSessions) throw new BridgeError('Bridge session limit reached. Finish pending tool calls or retry later.', 429, 'bridge_busy');
      const settings = this.sessionSettings.value[backendName];
      request = { ...request, saveSession: settings.persistSessions, sessionDirectory: settings.sessionDirectory, subagentsEnabled: settings.subagentsEnabled, toolTimeoutMs: settings.toolTimeoutMinutes * 60000 };
      const parent = request.forkSessionId && this.records.get(request.forkSessionId);
      if (request.forkSessionId && (!parent || !parent.persisted || !parent.released || !parent.native_session_id || parent.backend !== backendName)) throw new BridgeError('Forking requires a released saved session from the same backend.', 409, 'invalid_fork');
      const existing = request.conversationId && [...this.records.values()].find(r => r.conversation_id === request.conversationId && r.backend === backendName);
      const linked = request.resumeSessionId && this.records.get(request.resumeSessionId);
      if (request.resumeSessionId && !linked && !existing) throw new BridgeError('The saved chat link is no longer in the bridge history. Start a new chat to create a session.', 409, 'continuation_expired');
      if (parent && existing) throw new BridgeError('A fork requires a new conversation ID.', 409, 'invalid_fork');
      const saved = parent ? undefined : existing || (linked?.backend === backendName ? linked : undefined);
      if (saved && (!saved.released || [...this.sessions].some(s => s.record.id === saved.id))) throw new BridgeError('This chat session is still running.', 409, 'continuation_busy');
      if (saved?.conversation_id && request.conversationId && saved.conversation_id !== request.conversationId) throw new BridgeError('The saved session belongs to another chat.', 409, 'continuation_mismatch');
      if (saved && (!saved.persisted || !saved.native_session_id)) throw new BridgeError('The previous chat session was not saved and cannot be resumed.', 409, 'continuation_expired');
      if (saved?.native_tools && backendName === 'codex' && saved.native_tools !== accountFingerprint(request.activeTools)) throw new BridgeError('The Codex tool list changed. Its saved session cannot replace dynamic tools during resume.', 409, 'continuation_mismatch');
      if (saved) request = { ...request, saveSession: true, sessionDirectory: saved.cwd,
        resumeNativeId: saved.native_session_id, expectedAccount: saved.account_fingerprint };
      if (parent) request = { ...request, saveSession: true, sessionDirectory: parent.cwd,
        forkNativeId: parent.native_session_id, expectedAccount: parent.account_fingerprint };
      const record = saved || { id: randomUUID(), model: request.model, backend: backendName, account: null, native_session_id: null,
        persisted: request.saveSession, cwd: null, released: false,
        parent_id: parent?.id || null, child_ids: [], started_at: Date.now(), phases: [], usage: null,
        usage_scope: backendName === 'codex' ? 'last_model_invocation' : 'native_turn', status: 'discovery' };
      record.model = request.model; record.released = false;
      if (request.conversationId && record.persisted) record.conversation_id = request.conversationId;
      delete record.ended_at; delete record.error_code;
      state = { busy: true, signature: request.signature, controller: new AbortController(), record, persist: request.persist };
      state.idleMs = this.idleMs ?? settings.toolTimeoutMinutes * 60000;
      state.requestMs = this.requestMs ?? settings.requestTimeoutMinutes * 60000;
      state.continued = !!saved;
      this.sessions.add(state); this.records.set(record.id, record);
      if (parent) parent.child_ids.push(record.id);
      for (const [id, r] of this.records) { if (this.records.size <= 1000) break; if (r.ended_at) this.records.delete(id); }
    }
    onSession(state.record.id);
    const controller = state.controller;
    let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timeout = setTimeout(() => { timedOut = true; cancel(); }, state.requestMs);
    let text = ''; let firstResponse = false;
    let announced = false;
    const announce = async () => {
      state.record.native_session_id = state.backend?.threadId || state.record.native_session_id;
      if (announced || !state.record.native_session_id) return;
      announced = true;
      // Preview controls as soon as the native ID exists. Opening actions still
      // re-fetch the record and require the worker to be released.
      const record = this.inspect(state.record.id)[0];
      await onSessionReady({ ...record, continued: state.continued === true, launch: sessionLaunch({ ...record, released: true }, this.sessionSettings.value[backendName]) });
    };
    try {
      if (controller.signal.aborted) throw new BridgeError('Request cancelled.', 499, 'cancelled');
      if (!state.backend) {
        this.phase(state, 'discovery');
        // Test adapters can omit command; native adapters validate against their catalog.
        if (adapter.command) {
          const model = (await abortable(this.models(backendName), controller.signal)).find(m => m.id === request.model);
          if (!model) throw new BridgeError('Model is unavailable for this CLI account.', 404, 'model_not_found');
          if (request.reasoning && !model.bridge?.reasoning_efforts?.includes(request.reasoning)) throw new BridgeError('Requested reasoning effort is not supported by this model.', 400, 'invalid_request_error');
          if (request.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')) && !model.bridge?.image_input) throw new BridgeError('Selected model does not support image attachments.', 400, 'invalid_request_error');
          state.identity = await identityKey(backendName, adapter.command);
          state.record.cli_version = model.bridge?.cli_version;
        }
        this.phase(state, 'authentication');
        state.backend = await adapter.start(request, controller.signal, phase => this.phase(state, phase));
        if (state.backend.accountIdentity) state.record.account_fingerprint = accountFingerprint(state.backend.accountIdentity);
        state.record.native_tools = accountFingerprint(request.activeTools);
        state.record.account = state.backend.account || null;
        state.record.native_session_id = state.backend.threadId || request.resumeNativeId || null;
        state.record.cwd = state.backend.cwd || null;
        state.record.cli_executable = state.backend.launchCommand;
        this.phase(state, 'first_response');
      } else {
        this.phase(state, 'authentication');
        if (adapter.command && state.identity !== await identityKey(backendName, adapter.command)) throw new BridgeError('CLI account or configuration changed. Start a new conversation.', 409, 'account_changed');
        await state.backend.validateAccount?.();
        if (nextTurn) {
          if (!state.backend.nextTurn) throw new BridgeError('Backend does not support persistent turns.', 409, 'continuation_unsupported');
          this.phase(state, 'startup'); await state.backend.nextTurn(request);
        } else { this.phase(state, 'tool_result'); await state.backend.reply(state.pendingKey, final.content); }
        this.phase(state, 'first_response');
      }
      await announce();
      for (;;) {
        const event = await state.backend.events.next();
        if (controller.signal.aborted) throw new BridgeError('Request cancelled or timed out.', 504, 'request_timeout');
        if (event.type === 'error') throw event.error;
        if (event.type === 'end') throw new BridgeError('Backend session ended before its response completed.');
        await announce();
        if (event.type === 'subagent') {
          const agents = state.record.subagents ||= [];
          const previous = agents.find(agent => agent.id === event.id || event.tool_call_id && agent.tool_call_id === event.tool_call_id);
          const update = { id: event.id, tool_call_id: event.tool_call_id, native_session_id: event.native_session_id,
            parent_native_session_id: event.parent_native_session_id || state.record.native_session_id, status: event.status, updated_at: Date.now(),
            label: typeof event.label === 'string' ? event.label.slice(0, 160) : undefined,
            summary: typeof event.summary === 'string' ? event.summary.slice(0, 4000) : undefined };
          if (previous) Object.assign(previous, Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)));
          else if (agents.length < 100) agents.push(update);
          const agent = previous || agents.find(agent => agent.id === update.id);
          if (agent) await onSubagent({ session_id: state.record.id, agent: { ...agent } });
        }
        if (event.type === 'usage') state.record.usage = event.usage;
        if (event.type === 'text') {
          if (!firstResponse) { this.phase(state, 'streaming'); firstResponse = true; }
          text += event.text;
          if (text.length > 8 * 1024 * 1024) throw new BridgeError('Response size limit exceeded.');
          await onText(event.text);
        }
        if (event.type === 'tool') {
          if (!request.activeTools.some(t => t.name === event.name)) throw new BridgeError('Backend requested a tool not offered by the client.');
          const call = { id: `call_bridge_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name: event.name, arguments: canonical(event.arguments) } };
          const message = { role: 'assistant', content: text, tool_calls: [call] };
          state.expected = [...request.messages, message]; state.pendingKey = event.key;
          state.record.pending_call_id = call.id;
          this.phase(state, 'tool_handoff'); this.calls.set(call.id, state); this.idle(state);
          return { message, finish_reason: 'tool_calls' };
        }
        if (event.type === 'done') {
          if (request.choice === 'required' || typeof request.choice === 'object') throw new BridgeError('Backend completed without the required tool call.', 502, 'tool_choice_not_honored');
          const message = { role: 'assistant', content: text };
          state.record.usage = event.usage || null; delete state.record.pending_call_id;
          if (state.persist && state.backend.nextTurn) {
            state.expected = [...request.messages, message]; this.phase(state, 'idle'); this.idle(state);
          } else { this.phase(state, 'completed'); await this.dispose(state); }
          return { message, finish_reason: 'stop', ...(event.usage ? { usage: event.usage } : {}) };
        }
      }
    } catch (error) {
      const aborted = controller.signal.aborted;
      state.record.error_code = aborted ? (timedOut ? 'request_timeout' : 'cancelled') : error.code || 'backend_error';
      this.phase(state, aborted ? 'cancellation' : 'error'); await this.dispose(state);
      if (aborted) throw new BridgeError(timedOut ? 'Request timed out.' : 'Request cancelled.', timedOut ? 504 : 499, state.record.error_code);
      throw error;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
  }
  async dispose(state) {
    clearTimeout(state.timer); state.controller.abort(); this.sessions.delete(state); state.record.ended_at = Date.now();
    for (const [id, owner] of this.calls) if (owner === state) this.calls.delete(id);
    await state.backend?.close();
    state.record.released = true;
    for (const agent of state.record.subagents || []) if (['running', 'pendingInit'].includes(agent.status)) {
      agent.status = 'interrupted'; agent.updated_at = Date.now();
    }
    await this.sessionRecords.save(this.records.values());
  }
  async close() { this.discovery.close(); await Promise.allSettled([...this.sessions].map(s => this.dispose(s))); }
}
