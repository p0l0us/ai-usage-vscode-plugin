import { EventEmitter } from 'node:events';
import { BridgeError, readJsonLines, spawnCommand, terminate } from './common.mjs';

export class RpcProcess extends EventEmitter {
  pending = new Map(); sequence = 0; closed = false;
  constructor(command, args, options) {
    super();
    this.child = spawnCommand(command, args, options);
    this.child.on('error', () => this.fail(new BridgeError('Could not start Codex CLI.', 503)));
    this.child.on('exit', () => { if (!this.closed) this.fail(new BridgeError('Codex CLI exited unexpectedly.')); });
    readJsonLines(this.child.stdout, message => {
      if (message.method) this.emit(message.id == null ? 'notification' : 'request', message);
      else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        // Avoid forwarding arbitrary backend error strings (may contain private input).
        if (message.error) pending.reject(new BridgeError(`Codex rejected ${pending.method} (RPC ${message.error.code ?? 'error'}). Check the CLI version and account access.`));
        else pending.resolve(message.result);
      }
    }, error => this.fail(error));
  }
  send(message) {
    if (this.closed) throw new BridgeError('Codex connection is closed.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params = {}) {
    if (this.closed) return Promise.reject(new BridgeError('Codex connection is closed.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BridgeError(`Codex ${method} timed out.`, 504)); }, 30000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ id, method, params });
    });
  }
  respond(id, result) { this.send({ id, result }); }
  fail(error) {
    if (this.closed) return;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('failure', error); void this.close();
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new BridgeError('Codex connection closed.')); }
    this.pending.clear();
    this.closing = terminate(this.child);
    return this.closing;
  }
}
