// These fixtures use synthetic credentials and may contact loopback test servers only.
// A missing injection must fail before it can send a provider or model request.
const allowed = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const check = target => {
  let hostname = typeof target === 'string' || target instanceof URL ? new URL(target).hostname
    : target?.hostname || target?.host || 'localhost';
  if (!allowed.has(hostname) && hostname.includes(':')) { try { hostname = new URL(`http://${hostname}`).hostname; } catch { /* Invalid host is refused below. */ } }
  if (!allowed.has(hostname)) throw new Error(`Parity fixture refused external network host ${hostname}`);
};
for (const name of ['node:http', 'node:https']) {
  const transport = require(name);
  for (const method of ['request', 'get']) {
    const original = transport[method];
    transport[method] = function (target, ...args) { check(target); return original.call(this, target, ...args); };
  }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (target, options) => { check(target instanceof Request ? target.url : target); return originalFetch(target, options); };
