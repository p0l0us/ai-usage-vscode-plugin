// Shared fakes for the live*.test.js files: temp homes, a stubbed fetch and fake provider CLIs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function temporary(t, prefix = 'ai-usage-live-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

function jwt(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}

/** Replaces global fetch for one test. `handler(url, init)` returns a Response, or throws to simulate a network failure. */
function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const reply = (status, body, headers = {}) =>
  new Response(typeof body === 'string' || body === undefined ? body : JSON.stringify(body), { status, headers });

/** An executable that stands in for a provider CLI; `body` is Node source. */
function fakeCli(root, body, name = 'fake-cli') {
  const cli = path.join(root, name);
  fs.writeFileSync(cli, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return cli;
}

/**
 * Fake `codex app-server`: answers each JSON-RPC line from `answers[method]` (`{ error: 'msg' }` fails it).
 * `noise` is printed first (non-JSON and foreign ids must be skipped); `exitOn` makes it exit on that method.
 */
function fakeCodex(root, answers, { noise = true, exitOn } = {}) {
  return fakeCli(root, `
const answers = ${JSON.stringify(answers)};
const exitOn = ${JSON.stringify(exitOn ?? null)};
${noise ? "console.log('not json'); console.log(JSON.stringify({ id: 99, result: {} })); console.log(JSON.stringify({ method: 'notice' }));" : ''}
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === exitOn) { process.stderr.write('boom'); process.exit(3); }
  const answer = message.method === 'initialize' ? {} : answers[message.method];
  if (answer && answer.error) { console.log(JSON.stringify({ id: message.id, error: { message: answer.error } })); return; }
  console.log(JSON.stringify({ id: message.id, result: answer }));
});
`, 'fake-codex');
}

module.exports = { temporary, fixture, jwt, stubFetch, reply, fakeCli, fakeCodex };
