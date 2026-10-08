const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readServiceUsage, rotationTooltipLines } = require('../out/usageClient');
const { AccountService, ServiceClient, defaultConfig, saveConfig, configFileOf, readOrCreateToken, socketPath } = require('../service/out');
const { RpcServer } = require('../service/out/rpc');

for (const mode of ['service', 'plugin']) test(`${mode}: plugin adapter displays authoritative readings and scores from the shared engine`, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'usage-client-'));
  const previous = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME=path.join(home,'codex'); process.env.CLAUDE_CONFIG_DIR=path.join(home,'claude');
  fs.mkdirSync(process.env.CODEX_HOME); fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  const config=defaultConfig(); config.bridge.autoStart=false; config.codex.autoReset.enabled=false;
  saveConfig(configFileOf(home),config);
  const calls=[]; const now=Date.now();
  const engine=new AccountService({ home, version:'test', log() {}, now:()=>now, usageIdentity:()=> 'native',
    fetchUsage: async provider=> { calls.push(provider); return { kind:'ok', usage:{ provider,title:provider,fetchedAt:new Date(now),windows:[{label:'5h',usedPercent:37,resetsAt:new Date(now+3600000)}] } }; }
  });
  let client, server;
  if(mode==='plugin') client=ServiceClient.local(engine);
  else {
    const token=readOrCreateToken(home);
    server=new RpcServer({socketPath:socketPath(home),token,onHello:()=>({ok:true,service:engine.info()}),handle:(method,params,connection)=>engine.handle(method,params,connection.id)});
    await server.listen(); client=await ServiceClient.connect({home,client:'vscode-test'});
  }
  t.after(async()=>{client.close();engine.dispose();if(server)await server.close(); for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(home,{recursive:true,force:true});});
  for(const provider of ['claude','codex','copilot']) {
    const result=await readServiceUsage(client,provider,false,true);
    assert.equal(result.result.usage.windows[0].usedPercent,37);
    assert.ok(result.result.usage.fetchedAt instanceof Date);
    if(provider!=='copilot') assert.deepEqual(JSON.parse(JSON.stringify(result.diagnostics)),JSON.parse(JSON.stringify(engine.automation.diagnostics(provider))));
    else assert.equal(result.diagnostics,undefined);
    await readServiceUsage(client,provider,false,false); assert.equal(calls.filter(p=>p===provider).length,1);
  }
  await assert.rejects(client.call('usage.observe',{provider:'codex'}),/collected by the service/);
});
test('a service failure is surfaced; the adapter never performs a local fallback read', async()=>{
  let calls=0;
  await assert.rejects(readServiceUsage({liveUsage:async()=>{calls++;throw Error('connection lost');},call:async()=>assert.fail('must not request scores after failure')},'codex',true,true),/connection lost/);
  assert.equal(calls,1);
});
test('tooltip renders backend weights verbatim and explains sequential order without inventing a score',()=>{
  const lines=rotationTooltipLines({strategy:'sequential',trigger:'limit',reason:'Below thresholds.',scoreMeaning:'Saved order.',evaluatedAt:new Date().toISOString(),candidates:[
    {id:'a',name:'Active',active:true,reason:'Usable'}, {id:'b',name:'Backup',active:false,rank:1,score:-12.3456,reason:'Deferred'}]});
  assert.match(lines.join('\n'),/Current: Active · score n\/a/);assert.match(lines.join('\n'),/#1: Backup · score -12.346 · Deferred/);
});
