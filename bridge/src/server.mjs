import http from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { BridgeError } from './common.mjs';
import { normalizeRequest } from './request.mjs';

const hash = value => createHash('sha256').update(value).digest();
export function authorized(header, token) {
  return typeof header === 'string' && timingSafeEqual(hash(header), hash(`Bearer ${token}`));
}

export async function readBody(request, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    // Retain the error listener until this request is collected: aborted can be
    // followed by an error event even after the promise has already rejected.
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('aborted', aborted); };
    const error = () => { cleanup(); reject(new BridgeError('Request body interrupted.', 400, 'invalid_request_error')); };
    const aborted = () => error();
    const data = chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        cleanup(); request.resume(); reject(new BridgeError('Request body is too large.', 413, 'request_too_large')); return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new BridgeError('Malformed JSON body.', 400, 'invalid_request_error')); }
    };
    request.on('data', data); request.once('end', end); request.once('error', error); request.once('aborted', aborted);
  });
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function createBridgeServer(engine, { token, maxBodyBytes, log = () => {} } = {}) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('A local token of at least 24 characters is required.');
  const server = http.createServer(async (request, response) => {
    const requestId = randomUUID(); const controller = new AbortController();
    let heartbeat;
    response.on('close', () => { if (!response.writableFinished) controller.abort(); });
    try {
      const host = request.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) || request.headers.origin) throw new BridgeError('Only local non-browser clients are accepted.', 403, 'forbidden');
      if (!authorized(request.headers.authorization, token)) throw new BridgeError('Invalid local bridge token.', 401, 'invalid_api_key');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/v1/session-settings') {
        if (request.method === 'GET') { json(response, 200, engine.sessionSettings.value); return; }
        if (request.method === 'PUT') {
          if (!request.headers['content-type']?.startsWith('application/json')) throw new BridgeError('Use application/json.', 415, 'unsupported_media_type');
          json(response, 200, await engine.sessionSettings.update(await readBody(request, 16384))); return;
        }
      }
      if (request.method === 'GET' && url.pathname === '/v1/diagnostics') { json(response, 200, { backends: await engine.diagnose() }); return; }
      if (request.method === 'GET' && url.pathname === '/v1/sessions') { json(response, 200, { data: engine.inspect() }); return; }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/sessions/')) {
        const parts = url.pathname.split('/');
        const session = engine.inspect(parts[3])[0];
        if (!session) throw new BridgeError('Unknown bridge session.', 404, 'not_found');
        if (parts.length === 5 && parts[4] === 'subagents') json(response, 200, { data: [
          ...(session.subagents || []).map(agent => ({ ...agent, kind: 'native_subagent' })),
          ...engine.inspect().filter(record => record.parent_id === session.id).map(record => ({ ...record, kind: 'session_branch' }))
        ], parent_id: session.id });
        else if (parts.length === 5 && parts[4] === 'graph') json(response, 200, engine.graph(session.id));
        else if (parts.length === 4) json(response, 200, session);
        else throw new BridgeError('Unknown endpoint.', 404, 'not_found');
        return;
      }
      if (request.method === 'GET' && request.url === '/health') { json(response, 200, { status: 'ok', active_sessions: engine.sessions.size }); return; }
      if (request.method === 'GET' && url.pathname === '/v1/models') { json(response, 200, { object: 'list', data: await engine.models(url.searchParams.get('backend') || undefined) }); return; }
      const fork = /^\/v1\/sessions\/([a-f0-9-]{36})\/fork$/.exec(url.pathname);
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions' && !fork) throw new BridgeError('Unknown endpoint.', 404, 'not_found');
      if (!request.headers['content-type']?.startsWith('application/json')) throw new BridgeError('Use application/json.', 415, 'unsupported_media_type');
      const input = await readBody(request, maxBodyBytes);
      if (fork) {
        const parent = engine.inspect(fork[1])[0];
        if (!parent) throw new BridgeError('Unknown parent session.', 404, 'not_found');
        input.bridge_fork_session_id = parent.id; input.model ||= parent.model;
      }
      const body = normalizeRequest(input);
      if (body.ignoredParameters.length) response.setHeader('x-cli-bridge-ignored-parameters', body.ignoredParameters.join(', '));
      const id = `chatcmpl-${requestId}`; const created = Math.floor(Date.now() / 1000);
      let started = false;
      const chunk = (delta, finishReason = null, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra });
      const write = payload => {
        if (response.destroyed) throw new BridgeError('Client disconnected.', 499, 'cancelled');
        response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
        if (response.writableLength > 4 * 1024 * 1024) { controller.abort(); throw new BridgeError('Client is not consuming the response.', 499, 'slow_client'); }
      };
      const start = () => {
        if (started) return;
        started = true;
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        write(chunk({ role: 'assistant', content: '' }));
        heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keep-alive\n\n'); }, 15000); heartbeat.unref();
      };
      const result = await engine.complete(body, {
        signal: controller.signal,
        onSession: id => response.setHeader('x-cli-bridge-session-id', id),
        onSessionReady: session => { if (body.stream) { start(); write(chunk({}, null, { bridge_session: session })); } },
        onSubagent: event => { if (body.stream) { start(); write(chunk({}, null, { bridge_subagent: event })); } },
        onText: text => { if (body.stream) { start(); write(chunk({ content: text })); } }
      });
      if (!body.stream) {
        json(response, 200, { id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, ...result, usage: undefined }], ...(result.usage ? { usage: result.usage } : {}) });
      } else {
        start();
        if (result.message.tool_calls) write(chunk({ tool_calls: result.message.tool_calls.map((call, index) => ({ index, ...call })) }));
        write(chunk({}, result.finish_reason));
        if (body.includeUsage && result.usage) write({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage: result.usage });
        write('[DONE]'); response.end();
      }
      log({ requestId, model: body.model, outcome: result.finish_reason });
    } catch (error) {
      const safe = error instanceof BridgeError ? error : new BridgeError('Internal bridge error.', 500, 'internal_error');
      log({ requestId, outcome: 'error', code: safe.code });
      const payload = { error: { message: safe.message, type: safe.code, code: safe.code } };
      if (!response.destroyed) {
        if (response.headersSent) response.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
        else json(response, safe.status === 499 ? 408 : safe.status, payload);
      }
    } finally { clearInterval(heartbeat); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
