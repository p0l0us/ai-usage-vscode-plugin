const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { CodexAccountProxy, CODEX_PROXY_SERVICE, SseErrorInspector, classifyUpstreamError, isLoopbackHost, parseCodexLogin, probeCodexProxy, readCodexLogin, requestModel, upstreamErrorDetail, upstreamErrorFields, accessTokenMayHaveExpired } = require('../out/codexProxy');

const AUTH = 'https://api.openai.com/auth';
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const chatgptDocument = (token, accountId = 'acc-1') => ({
  auth_mode: 'chatgpt',
  tokens: { id_token: jwt({ email: 'a@example.com' }), access_token: token, refresh_token: 'r', account_id: accountId },
  last_refresh: '2026-09-17T00:00:00Z'
});
const SSE = 'data: {"type":"response.completed","response":{"id":"r1","output":[]}}\n\n';

/** An upstream that records every request and answers with whatever `respond` decides. */
function upstream(t, respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(record);
      respond(record, res);
    });
  });
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ requests, url: `http://127.0.0.1:${server.address().port}` })));
}

const sse = (record, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '12' });
  res.write(SSE.slice(0, 20));
  setTimeout(() => res.end(SSE.slice(20)), 10);
};

async function fixture(t, { document = chatgptDocument('access-1'), refreshLogin, onLoginRejected, now, ...rest } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-codex-proxy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (document) {
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(document));
  }
  const chatgpt = await upstream(t, rest.chatgptRespond ?? sse);
  const api = await upstream(t, rest.apiRespond ?? sse);
  const logs = [];
  const proxy = new CodexAccountProxy({
    home, port: 0, secret: 'secret-1', log: (message) => logs.push(message), refreshLogin, onLoginRejected, now,
    chatgptBaseUrl: `${chatgpt.url}/backend-api/codex`, apiBaseUrl: `${api.url}/v1`, version: '0.0.17'
  });
  await proxy.start();
  t.after(() => proxy.stop());
  return { home, proxy, chatgpt, api, logs };
}

/** Sends a request to the proxy the way Codex would; resolves with status, headers and the full body. */
function send(proxy, { method = 'POST', path: requestPath = '/v1/responses', headers = {}, body = '{"model":"gpt-5"}', host } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: proxy.port, method, path: requestPath,
      headers: {
        authorization: 'Bearer secret-1', 'content-type': 'application/json', accept: 'text/event-stream',
        'user-agent': 'codex_vscode/0.154.0 (Ubuntu 24.4.0; x86_64)', originator: 'codex_vscode', 'x-codex-window-id': 'w:0',
        ...(host ? { host } : {}), ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('parseCodexLogin follows Codex: ChatGPT tokens win unless auth_mode selects the API key', () => {
  assert.deepEqual(parseCodexLogin(chatgptDocument('a', 'acc-1')), { kind: 'chatgpt', accessToken: 'a', accountId: 'acc-1' });
  assert.deepEqual(parseCodexLogin({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-1' }), { kind: 'apikey', apiKey: 'sk-1' });
  assert.deepEqual(parseCodexLogin({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-1', tokens: { access_token: 'a' } }), { kind: 'apikey', apiKey: 'sk-1' });
  assert.deepEqual(parseCodexLogin({ OPENAI_API_KEY: 'sk-1', tokens: { access_token: 'a' } }), { kind: 'chatgpt', accessToken: 'a', accountId: undefined });
  const fromClaim = parseCodexLogin({ tokens: { access_token: jwt({ [AUTH]: { chatgpt_account_id: 'acc-claim' } }) } });
  assert.equal(fromClaim.accountId, 'acc-claim');
  assert.equal(parseCodexLogin({ auth_mode: 'chatgpt', tokens: {} }), undefined);
  assert.equal(parseCodexLogin(null), undefined);
  assert.equal(readCodexLogin('/nonexistent/home'), undefined);
});

test('loopback hosts only', () => {
  for (const host of ['127.0.0.1:43117', 'localhost:43117', 'LOCALHOST', '[::1]:43117']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['example.com', '127.0.0.1.example.com:43117', '', undefined]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test('health endpoint identifies the proxy to other windows', async (t) => {
  const { proxy } = await fixture(t);
  const health = await probeCodexProxy(proxy.port);
  assert.equal(health.service, CODEX_PROXY_SERVICE);
  assert.equal(health.pid, process.pid);
  assert.equal(health.version, '0.0.17');
  const plain = http.createServer((req, res) => res.end('not a proxy'));
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
  t.after(() => plain.close());
  assert.equal(await probeCodexProxy(plain.address().port), undefined);
});

test('a ChatGPT login is forwarded to the Codex backend with the account headers and the stream comes back', async (t) => {
  const { proxy, chatgpt, api } = await fixture(t);
  const response = await send(proxy, { path: '/v1/responses?foo=1', body: '{"model":"gpt-5","input":[]}' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream');
  assert.equal(response.headers['x-codex-primary-used-percent'], '12');
  assert.equal(response.body, SSE);
  assert.equal(api.requests.length, 0);
  assert.equal(chatgpt.requests.length, 1);
  const [request] = chatgpt.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/backend-api/codex/responses?foo=1');
  assert.equal(request.body, '{"model":"gpt-5","input":[]}');
  assert.equal(request.headers.authorization, 'Bearer access-1');
  assert.equal(request.headers['chatgpt-account-id'], 'acc-1');
  assert.equal(request.headers.version, '0.154.0');
  assert.equal(request.headers.originator, 'codex_vscode');
  assert.equal(request.headers['x-codex-window-id'], 'w:0');
  assert.equal(request.headers['content-length'], String(Buffer.byteLength('{"model":"gpt-5","input":[]}')));
  assert.ok(!('proxy-authorization' in request.headers));
});

test('an API-key login is forwarded to the OpenAI API without ChatGPT headers', async (t) => {
  const { proxy, chatgpt, api } = await fixture(t, { document: { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' } });
  const response = await send(proxy);
  assert.equal(response.status, 200);
  assert.equal(chatgpt.requests.length, 0);
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].url, '/v1/responses');
  assert.equal(api.requests[0].headers.authorization, 'Bearer sk-test');
  assert.equal(api.requests[0].headers['chatgpt-account-id'], undefined);
  assert.equal(api.requests[0].headers.version, undefined);
});

test('the login is read for every request, so a rewritten auth.json applies to the next turn', async (t) => {
  const { proxy, home, chatgpt, api } = await fixture(t);
  await send(proxy);
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(chatgptDocument('access-2', 'acc-2')));
  await send(proxy);
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-3' }));
  await send(proxy);
  assert.deepEqual(chatgpt.requests.map((request) => [request.headers.authorization, request.headers['chatgpt-account-id']]),
    [['Bearer access-1', 'acc-1'], ['Bearer access-2', 'acc-2']]);
  assert.deepEqual(api.requests.map((request) => request.headers.authorization), ['Bearer sk-3']);
});

test('requests without the config.toml token, from another host or to another path never reach upstream', async (t) => {
  const { proxy, chatgpt, api } = await fixture(t);
  assert.equal((await send(proxy, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await send(proxy, { headers: { authorization: '' } })).status, 401);
  assert.equal((await send(proxy, { host: 'example.com' })).status, 403);
  assert.equal((await send(proxy, { path: '/other/responses' })).status, 404);
  assert.equal(chatgpt.requests.length + api.requests.length, 0);
});

test('a missing login is answered with 401 naming the file', async (t) => {
  const { proxy, home, chatgpt } = await fixture(t, { document: null });
  const response = await send(proxy);
  assert.equal(response.status, 401);
  assert.ok(JSON.parse(response.body).error.message.includes(path.join(home, 'auth.json')));
  assert.equal(chatgpt.requests.length, 0);
});

test('an upstream 401 triggers one login refresh through Codex and a retry with the new token', async (t) => {
  let refreshes = 0;
  const context = {};
  const { proxy, home, chatgpt } = await fixture(t, {
    chatgptRespond: (record, res) => {
      if (record.headers.authorization === 'Bearer access-1') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":{"code":"token_expired"}}');
      } else {
        sse(record, res);
      }
    },
    refreshLogin: async () => {
      refreshes++;
      fs.writeFileSync(path.join(context.home, 'auth.json'), JSON.stringify(chatgptDocument('access-fresh')));
    }
  });
  context.home = home;
  const response = await send(proxy);
  assert.equal(response.status, 200);
  assert.equal(response.body, SSE);
  assert.equal(refreshes, 1);
  assert.deepEqual(chatgpt.requests.map((request) => request.headers.authorization), ['Bearer access-1', 'Bearer access-fresh']);
});

test('an upstream 401 that a refresh does not resolve is answered with a message that says what to do', async (t) => {
  let refreshes = 0;
  const rejected = [];
  const { proxy, home, chatgpt } = await fixture(t, {
    chatgptRespond: (record, res) => {
      res.writeHead(401, { 'content-type': 'application/json', 'x-request-id': 'req-1' });
      res.end('{"error":{"code":"token_revoked","message":"Encountered invalidated oauth token for user"}}');
    },
    refreshLogin: async () => {
      refreshes++;
    },
    onLoginRejected: (message) => rejected.push(message)
  });
  const response = await send(proxy);
  assert.equal(response.status, 401);
  assert.equal(response.headers['x-request-id'], 'req-1');
  const message = JSON.parse(response.body).error.message;
  assert.ok(message.includes(path.join(home, 'auth.json')));
  assert.match(message, /token_revoked: Encountered invalidated oauth token for user/);
  assert.match(message, /codex login/);
  assert.equal(refreshes, 1);
  assert.equal(chatgpt.requests.length, 1);
  assert.deepEqual(rejected, [message]);
});

test('a rejected token is not refreshed again until the backoff ends or auth.json holds a new one', async (t) => {
  let refreshes = 0;
  let clock = 0;
  const rejected = [];
  const { proxy, home, chatgpt } = await fixture(t, {
    chatgptRespond: (record, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"detail":"Unauthorized"}');
    },
    refreshLogin: async () => {
      refreshes++;
    },
    onLoginRejected: (message) => rejected.push(message),
    now: () => clock
  });
  await send(proxy);
  await send(proxy);
  await send(proxy);
  assert.equal(refreshes, 1);
  assert.equal(rejected.length, 1);
  assert.equal(chatgpt.requests.length, 3);
  clock += 5 * 60_000;
  await send(proxy);
  assert.equal(refreshes, 2);
  assert.equal(rejected.length, 1);
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(chatgptDocument('access-2')));
  const response = await send(proxy);
  assert.equal(refreshes, 3);
  assert.equal(rejected.length, 2);
  assert.match(JSON.parse(response.body).error.message, /\(Unauthorized\)/);
});

test('a 401 for an access token that has not expired is never refreshed', async (t) => {
  let refreshes = 0;
  const rejected = [];
  const valid = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const { proxy, chatgpt } = await fixture(t, {
    document: chatgptDocument(valid),
    chatgptRespond: (record, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Incorrect API key provided: sk-svcac***fvMA"}}');
    },
    refreshLogin: async () => {
      refreshes++;
    },
    onLoginRejected: (message) => rejected.push(message)
  });
  const response = await send(proxy);
  assert.equal(response.status, 401);
  assert.match(JSON.parse(response.body).error.message, /OpenAI rejected the Codex login/);
  assert.equal(refreshes, 0);
  assert.equal(chatgpt.requests.length, 1);
  assert.equal(rejected.length, 1);
});

test('accessTokenMayHaveExpired reads exp and treats an unreadable token as possibly expired', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const at = (offsetSeconds) => jwt({ exp: Math.floor(now / 1000) + offsetSeconds });
  assert.equal(accessTokenMayHaveExpired(at(3600), now), false);
  assert.equal(accessTokenMayHaveExpired(at(30), now), true);
  assert.equal(accessTokenMayHaveExpired(at(-10), now), true);
  assert.equal(accessTokenMayHaveExpired(jwt({}), now), true);
  assert.equal(accessTokenMayHaveExpired('opaque', now), true);
});

test('upstreamErrorDetail names the reason from the error shapes OpenAI returns', () => {
  assert.equal(upstreamErrorDetail('{"error":{"code":"token_revoked","message":"gone"}}'), 'token_revoked: gone');
  assert.equal(upstreamErrorDetail('{"error":{"message":"Incorrect API key provided","code":null}}'), 'Incorrect API key provided');
  assert.equal(upstreamErrorDetail('{"detail":"Unauthorized"}'), 'Unauthorized');
  assert.equal(upstreamErrorDetail('{}'), undefined);
  assert.equal(upstreamErrorDetail('not json'), undefined);
});

test('an unreachable upstream is reported as 502 and a WebSocket upgrade is refused', async (t) => {
  const { proxy, home, logs } = await fixture(t);
  await proxy.stop();
  const dead = new CodexAccountProxy({ home, port: 0, secret: 'secret-1', log: (message) => logs.push(message), chatgptBaseUrl: 'http://127.0.0.1:1/backend-api/codex' });
  await dead.start();
  t.after(() => dead.stop());
  const response = await send(dead);
  assert.equal(response.status, 502);
  assert.match(JSON.parse(response.body).error.message, /could not reach OpenAI/);
  assert.ok(logs.some((line) => line.includes('upstream request failed')));
  const upgrade = await new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port: dead.port, path: '/v1/responses', headers: { connection: 'Upgrade', upgrade: 'websocket' } });
    request.on('response', (res) => resolve(res.statusCode));
    request.on('upgrade', () => resolve('upgraded'));
    request.on('error', () => resolve('error'));
    request.end();
  });
  assert.equal(upgrade, 404);
});

test('classifyUpstreamError tells OpenAI capacity, server and rate-limit failures from account quota and client errors', () => {
  assert.equal(classifyUpstreamError('server_overloaded', 'Selected model is at capacity. Please try a different model.'), 'capacity');
  assert.equal(classifyUpstreamError(undefined, undefined, 503), 'capacity');
  assert.equal(classifyUpstreamError('server_error', 'An error occurred while processing your request. You can retry your request.'), 'serverError');
  assert.equal(classifyUpstreamError(undefined, undefined, 502), 'serverError');
  assert.equal(classifyUpstreamError('rate_limit_exceeded', 'Too many requests', 429), 'rateLimit');
  assert.equal(classifyUpstreamError(undefined, undefined, 429), 'rateLimit');
  assert.equal(classifyUpstreamError('usage_limit_reached', "You've hit your usage limit.", 429), undefined, 'the account quota is not an OpenAI failure');
  assert.equal(classifyUpstreamError(undefined, 'Your workspace is out of credits.', 429), undefined);
  assert.equal(classifyUpstreamError('invalid_request_error', 'Unsupported parameter', 400), undefined);
  assert.equal(classifyUpstreamError(undefined, undefined, 400), undefined);
  assert.equal(classifyUpstreamError('context_length_exceeded', 'Too long'), undefined);
  assert.deepEqual(upstreamErrorFields('{"error":{"code":"server_error","message":"boom"}}'), { code: 'server_error', message: 'boom' });
  assert.deepEqual(upstreamErrorFields('{"detail":"Internal error"}'), { code: undefined, message: 'Internal error' });
  assert.equal(upstreamErrorFields('nope'), undefined);
  assert.equal(requestModel('/v1/responses', Buffer.from('{"model":"gpt-6-astra","stream":true}')), 'gpt-6-astra');
  assert.equal(requestModel('/v1/models', Buffer.from('')), undefined);
});

test('SseErrorInspector reads error events split across chunks and notices a missing final event', () => {
  const a = new SseErrorInspector();
  const text = 'event: response.created\ndata: {"type":"response.created"}\n\nevent: error\ndata: {"type":"error",\ndata: "code":"server_overloaded","message":"Selected model is at capacity."}\n\n';
  for (let i = 0; i < text.length; i += 7) { a.feed(text.slice(i, i + 7)); }
  a.end();
  assert.deepEqual(a.errors, [{ code: 'server_overloaded', message: 'Selected model is at capacity.' }]);
  assert.equal(a.terminal, true);
  const b = new SseErrorInspector();
  b.feed('data: {"type":"response.created"}\r\n\r\ndata: {"type":"response.output_text.delta","delta":"hi"}\r\n\r\n');
  b.end();
  assert.equal(b.terminal, false, 'the stream never reached its final event');
  assert.deepEqual(b.errors, []);
  const c = new SseErrorInspector();
  c.feed('data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"An error occurred"}}}\n\ndata: [DONE]\n\n');
  c.end();
  assert.deepEqual(c.errors, [{ code: 'server_error', message: 'An error occurred' }]);
  assert.equal(c.terminal, true);
  const d = new SseErrorInspector();
  d.feed('data: {"type":"response.completed","response":{"id":"r1"}}');
  d.end();
  assert.equal(d.terminal, true, 'a final event without its blank line still counts');
});

test('OpenAI failures inside relayed streams, error statuses and streams cut short are counted for the last hour and logged with the model', async (t) => {
  let clock = Date.parse('2026-10-20T06:00:00Z');
  const scripts = [];
  const f = await fixture(t, { now: () => clock, chatgptRespond: (record, res) => scripts.shift()(res) });
  const stream = (events) => (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) { res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
    res.end();
  };
  const json = (status, body) => (res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  scripts.push(
    stream([{ type: 'response.created' }, { type: 'response.output_text.delta', delta: 'x' },
      { type: 'error', code: 'server_overloaded', message: 'Selected model is at capacity. Please try a different model.' }]),
    stream([{ type: 'response.created' }, { type: 'response.failed', response: { error: { code: 'server_error', message: 'An error occurred while processing your request.' } } }]),
    stream([{ type: 'response.created' }, { type: 'response.completed', response: { id: 'r1' } }]),
    stream([{ type: 'response.created' }]),
    json(429, { error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }),
    json(429, { error: { code: 'usage_limit_reached', message: "You've hit your usage limit." } }),
    json(503, {})
  );
  const answers = [];
  for (let i = 0; i < 7; i++) { answers.push(await send(f.proxy, { body: '{"model":"gpt-6-astra","stream":true}' })); }
  assert.deepEqual(answers.map((answer) => answer.status), [200, 200, 200, 200, 429, 429, 503], 'everything is still relayed as it came');
  assert.match(answers[0].body, /server_overloaded/, 'the stream reaches Codex unchanged');
  const summary = f.proxy.upstreamErrorSummary();
  assert.equal(summary.capacity, 2, 'the in-stream server_overloaded and the 503');
  assert.equal(summary.serverErrors, 2, 'the failed response and the stream that ended without its final event');
  assert.equal(summary.rateLimits, 1, 'the usage-limit 429 is the account\'s quota, not an OpenAI failure');
  assert.equal(summary.windowMs, 3_600_000);
  assert.deepEqual(summary.last, { at: new Date(clock).toISOString(), kind: 'capacity', code: undefined, message: undefined, model: 'gpt-6-astra' });
  assert.ok(f.logs.some((line) => /codex proxy #1: \/v1\/responses stream error from OpenAI \(capacity, server_overloaded, gpt-6-astra\): Selected model is at capacity/.test(line)), f.logs.join('\n'));
  assert.ok(f.logs.some((line) => /codex proxy #4: \/v1\/responses stream error from OpenAI \(serverError, stream_ended_early, gpt-6-astra\)/.test(line)), f.logs.join('\n'));
  assert.ok(f.logs.some((line) => /codex proxy #5: \/v1\/responses HTTP 429 from OpenAI \(rateLimit, rate_limit_exceeded, gpt-6-astra\): Too many requests/.test(line)), f.logs.join('\n'));
  assert.ok(!f.logs.some((line) => /usage_limit_reached/.test(line)), 'quota answers are not logged as OpenAI failures');
  // An hour later the window is empty; the entries themselves are kept for a day.
  clock += 3_600_001;
  assert.deepEqual(f.proxy.upstreamErrorSummary(), { windowMs: 3_600_000, capacity: 0, serverErrors: 0, rateLimits: 0 });
  assert.equal(f.proxy.upstreamErrorSummary(24 * 3_600_000).capacity, 2);
});
