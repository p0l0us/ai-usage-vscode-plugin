const assert = require('node:assert/strict');
const test = require('node:test');
const { readServiceUsage, rotationTooltipLines } = require('../out/usageClient');
const fs = require('node:fs');
const path = require('node:path');
const { runtimeFixture } = require('./helpers/runtimeHost');

for (const mode of ['background', 'embedded']) test(`${mode}: plugin adapter displays authoritative readings and scores from the shared engine`, async t => {
  const fixture = await runtimeFixture(t, mode);
  for (const provider of ['claude', 'codex', 'copilot']) {
    const result = await readServiceUsage(fixture.client, provider, false, true);
    assert.equal(result.result.usage.windows[0].usedPercent, 37);
    assert.ok(result.result.usage.fetchedAt instanceof Date);
    if (provider !== 'copilot') assert.deepEqual(JSON.parse(JSON.stringify(result.diagnostics)), await fixture.client.call('rotation.diagnostics', { provider }));
    else assert.equal(result.diagnostics, undefined);
    const reads = () => fs.readFileSync(path.join(fixture.home, 'reads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(read => read.provider === provider).length;
    const before = reads();
    await readServiceUsage(fixture.client, provider, false, false);
    assert.equal(reads(), before);
  }
  await assert.rejects(fixture.client.call('usage.observe', { provider: 'codex' }), /collected by the service/);
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
