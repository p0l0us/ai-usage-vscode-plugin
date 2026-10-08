const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { CodexProxyRuntime } = require('../out/codexProxyRuntime');
const { defaultConfig, setConfigValue } = require('../out/configStore');
const { probeCodexProxy } = require('../out/codexProxy');
async function freePort() { const s = net.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port; }
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-runtime-')); const home = path.join(root,'codex'); fs.mkdirSync(home);
  const config = defaultConfig(); config.codex.proxy = { enabled: true, port: await freePort() };
  const notices = [], instances = [];
  const make = (own = config) => {
    const runtime = new CodexProxyRuntime(root, () => own, message => notices.push(message), () => {}, () => home, async () => {}, 'test', path.join(root,'singleton.lock'));
    instances.push(runtime); return runtime;
  };
  t.after(() => { for (const instance of instances) instance.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { config, home, notices, make };
}
test('one owner across same and different ports; nonowners never rewrite or remove native routing', async t => {
  const f = await fixture(t); const owner = f.make(); await owner.sync(); assert.equal(owner.active,true);
  const before = fs.readFileSync(path.join(f.home,'config.toml'),'utf8');
  const shared = f.make(); await shared.sync(); assert.equal(shared.active,true); shared.dispose();
  assert.equal(fs.readFileSync(path.join(f.home,'config.toml'),'utf8'),before);
  const otherConfig = structuredClone(f.config); otherConfig.codex.proxy.port = await freePort();
  const other = f.make(otherConfig); await other.sync(); assert.equal(other.active,false);
  assert.match(f.notices.at(-1),/Another service owns/);
  otherConfig.codex.proxy.enabled=false; await other.sync(); assert.equal(fs.readFileSync(path.join(f.home,'config.toml'),'utf8'),before);
  owner.dispose(); otherConfig.codex.proxy.enabled=true; await other.sync(); assert.equal(other.active,true);
});
test('port changes close the old listener, preserve the token and update native configuration', async t => {
  const f = await fixture(t); const owner = f.make(); await owner.sync(); const old = f.config.codex.proxy.port;
  const before = fs.readFileSync(path.join(f.home,'config.toml'),'utf8'); const token = /"Bearer ([^"]+)"/.exec(before)?.[1];
  f.config.codex.proxy.port=await freePort(); await owner.sync();
  assert.equal(await probeCodexProxy(old),undefined); assert.ok(await probeCodexProxy(f.config.codex.proxy.port));
  const after=fs.readFileSync(path.join(f.home,'config.toml'),'utf8'); assert.match(after,new RegExp('127.0.0.1:'+f.config.codex.proxy.port));
  assert.ok(token && after.includes(token));
});
test('an unrelated listener blocks startup; port values are bounded integers', async t => {
  const f = await fixture(t); const server=net.createServer(socket=>socket.end());
  await new Promise(resolve=>server.listen(f.config.codex.proxy.port,'127.0.0.1',resolve)); t.after(()=>server.close());
  const runtime=f.make(); await runtime.sync(); assert.equal(runtime.active,false); assert.match(f.notices.at(-1),/taken by another program/);
  for(const value of [1023,65536,43117.5]) assert.throws(()=>setConfigValue(defaultConfig(),'codex.proxy.port',value));
});
test('disposal during startup cannot leave an orphan listener', async t => {
  const f=await fixture(t); const runtime=f.make(); const starting=runtime.sync(); runtime.dispose(); await starting;
  assert.equal(await probeCodexProxy(f.config.codex.proxy.port),undefined);
});

test('a separate process holds ownership across different ports and a crash releases it', { skip: process.platform !== 'linux' && process.platform !== 'win32' }, async t => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const f=await fixture(t); const namespace=path.join(path.dirname(f.home),'singleton.lock');
  const child=spawn(process.execPath,['-e', `
    const { acquireProxyLease }=require(process.argv[1]);
    acquireProxyLease(process.argv[2]).then(lease=>{if(!lease)process.exit(2);process.stdout.write('ready\\n');setInterval(()=>{},1000);});
  `,require.resolve('../out/proxyLease'),namespace],{stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('child exited before holding lease');})]);
  const runtime=f.make();await runtime.sync();assert.equal(runtime.active,false);assert.match(f.notices.at(-1),/Another service owns/);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  await runtime.sync();assert.equal(runtime.active,true);
});
