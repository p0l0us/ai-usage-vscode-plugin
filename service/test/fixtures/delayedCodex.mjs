#!/usr/bin/env node
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
if (process.argv.includes('--version')) { console.log('0.154.0'); process.exit(0); }
const root = process.env.BRIDGE_DRAIN_FIXTURE_ROOT;
let active = false;
let terminating = false;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const hold = setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  if (terminating) return;
  terminating = true;
  if (!active) { clearInterval(hold); process.exit(0); }
  writeFileSync(path.join(root, `draining-${process.pid}`), String(Date.now()));
  setTimeout(() => { writeFileSync(path.join(root, `drained-${process.pid}`), String(Date.now())); process.exit(0); }, 750);
});
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const answer = result => send({ id: request.id, result });
  switch (request.method) {
    case 'initialize': answer({}); break;
    case 'initialized': break;
    case 'account/read': answer({ account: { type: 'chatgpt' } }); break;
    case 'config/read': answer({ config: {} }); break;
    case 'model/list': answer({ data: [{ model: 'delayed', inputModalities: ['text'] }] }); break;
    case 'thread/start': answer({ thread: { id: randomUUID() } }); break;
    case 'turn/start':
      active = true;
      answer({ turn: { id: randomUUID() } });
      writeFileSync(path.join(root, 'active-native.json'), JSON.stringify({ pid: process.pid }));
      send({ method: 'item/agentMessage/delta', params: { delta: 'native inference running' } });
      // Intentionally omit turn/completed. Real native process cancellation must await our delayed termination.
      break;
    default: if (request.id !== undefined) answer({});
  }
});
