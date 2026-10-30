import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { UsagePricing } from '../../src/collectors/usage-pricing.js';
import { usageCells } from '../../src/render/usage-theme.js';
const rates={input_cost_per_token:2e-6,output_cost_per_token:10e-6,cache_read_input_token_cost:.1e-6};
test('toktrack Codex normalization charges cached input once and reasoning only inside output',()=>{
  const p=new UsagePricing({table:{'gpt-fixture':{...rates,output_cost_per_reasoning_token:999}}});
  const quote=p.quote('gpt-fixture',[1000000,800000,100000,50000,1100000]);
  assert.ok(Math.abs(quote.usd!-1.48)<1e-12);assert.equal(quote.pricedEvents,1);assert.equal(quote.unpricedEvents,0);
});
test('toktrack per-request tiers apply only above each token-kind breakpoint',()=>{
  const p=new UsagePricing({table:{'gpt-fixture':{...rates,input_cost_per_token_above_272k_tokens:4e-6,
    output_cost_per_token_above_128k_tokens:15e-6,cache_read_input_token_cost_above_200k_tokens:.2e-6}}});
  const expected=272000*2e-6+28000*4e-6+128000*10e-6+22000*15e-6+200000*.1e-6+50000*.2e-6;
  assert.ok(Math.abs(p.quote('gpt-fixture',[550000,250000,150000,90000,700000]).usd!-expected)<1e-12);
});
test('toktrack model resolution prefers exact, dotted, dated, longest whole parts and stable ties',()=>{
  const p=new UsagePricing({table:{'gpt-4.1':rates,'gpt-4':{...rates,input_cost_per_token:9e-6},
    'gpt-4.1-pro':{...rates,input_cost_per_token:3e-6},'azure/gpt-4.1-pro-extra':{input_cost_per_token:99},
    'gpt-5.3-codex':rates}});
  assert.equal(p.list('gpt-4-1-20261001')?.key,'gpt-4.1');
  assert.equal(p.list('provider/gpt-4.1-pro-v2')?.key,'gpt-4.1-pro');
  assert.equal(p.list('gpt-4-1106')?.key,'gpt-4');
  assert.equal(p.list('gpt-5.3-codex-spark'),null);
  assert.equal(p.quote('unknown',[10,5,2,1,12]).usd,null);
  assert.equal(p.quote(null,[10,5,2,1,12]).unpricedEvents,1);
});
test('Fast model billing and list rates share toktrack multipliers without applying them to other providers',()=>{
  const p=new UsagePricing({table:{'gpt-5.5':rates,'gpt-6-astra':rates,'other':{...rates,provider_specific_entry:{fast:3}}}});
  const counts:[number,number,number,number,number]=[1000,500,100,50,1100];
  const standard=p.quote('gpt-5.5',counts).usd!;
  assert.equal(p.quote('gpt-5.5:fast',counts).usd,standard*2.5);
  assert.equal(p.list('gpt-5.5:fast')?.input,5);
  assert.equal(p.quote('gpt-5.5:fast::third-party',counts).usd,standard);
  assert.equal(p.quote('gpt-6-astra',counts,true).usd,p.quote('gpt-6-astra',counts).usd!*2);
  assert.equal(p.quote('other',counts,true).usd,p.quote('other',counts).usd!*3);
});
test('custom pricing preserves exact aliases, equivalent ids and conflicting list-rate ambiguity',()=>{
  const p=new UsagePricing({table:{'gpt-4.1':rates},custom:{'gpt-4.1-20260101':{input_cost_per_token:3e-6},'gpt-4-1-20260202':{input_cost_per_token:4e-6}}});
  assert.equal(p.list('gpt-4.1'),null);
  assert.equal(p.list('gpt-4.1-20260101')?.input,3);
  assert.equal(p.quote('gpt-4.1',[1000,0,0,0,1000]).usd,.002);
});
test('toktrack cache and custom TOML are read locally, per-million custom prices override the table',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hud-price-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const cacheFile=path.join(dir,'pricing.json'),customFile=path.join(dir,'pricing.toml');
  await fs.writeFile(cacheFile,JSON.stringify({fetched_at:123,models:{'gpt-fixture':rates}}));
  await fs.writeFile(customFile,'[models."gpt-fixture"]\ninput = 3\noutput = 12\ncache_read = 0.2\n');
  const p=new UsagePricing({cacheFile,customFile});await p.load();
  assert.equal(p.source,'toktrack cache');assert.equal(p.updatedAtMs,123000);
  assert.equal(p.list('gpt-fixture')?.input,3);
  assert.ok(Math.abs(p.quote('gpt-fixture',[1000000,800000,100000,50000,1100000]).usd!-1.96)<1e-12);
  assert.equal((await fs.readdir(dir)).length,2,'pricing never creates a refresh process or cache file');
});
test('token composition port keeps a cell for small nonzero parts and exactly fills its bar',()=>{
  for(const width of [1,4,5,16,36]){
    const cells=usageCells([99999,1,300,0,1],width);assert.equal(cells.reduce((a,b)=>a+b,0),width);
    if(width>=4)for(const index of [0,1,2,4])assert.ok(cells[index]>=1);
    assert.equal(cells[3],0);
  }
});
const reference=spawnSync('toktrack',['--version'],{encoding:'utf8'}).status===0;
test('installed toktrack and the port agree on cached, tiered, Fast and custom-priced Codex requests', {skip:!reference},async t=>{
  const tiered={...rates,input_cost_per_token_above_272k_tokens:4e-6,output_cost_per_token_above_128k_tokens:15e-6,cache_read_input_token_cost_above_200k_tokens:.2e-6};
  const cases:Array<{name:string;model:string;table:Record<string,Record<string,unknown>>;counts:[number,number,number,number,number];fast:boolean;custom?:Record<string,Record<string,unknown>>}>=[
    {name:'cached',model:'gpt-fixture',table:{'gpt-fixture':rates},counts:[1000000,800000,100000,50000,1100000],fast:false},
    {name:'tiered',model:'gpt-fixture',table:{'gpt-fixture':tiered},counts:[550000,250000,150000,90000,700000],fast:false},
    {name:'fast',model:'gpt-5.5',table:{'gpt-5.5':rates},counts:[1000,500,100,50,1100],fast:true},
    {name:'custom',model:'gpt-fixture-20261001',table:{'gpt-fixture':rates},counts:[1000000,800000,100000,50000,1100000],fast:false,
      custom:{'gpt-fixture':{input_cost_per_token:3e-6,output_cost_per_token:12e-6,cache_read_input_token_cost:.2e-6}}},
  ];
  for(const fixture of cases){
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hud-toktrack-conformance-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    const codex=path.join(dir,'.codex'),tok=path.join(dir,'.toktrack'),now=new Date();
    const day=path.join(codex,'sessions',String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));
    await fs.mkdir(day,{recursive:true});await fs.mkdir(tok,{recursive:true});
    await fs.writeFile(path.join(tok,'pricing.json'),JSON.stringify({fetched_at:Math.floor(Date.now()/1000)+86400,models:fixture.table}));
    const customFile=path.join(tok,'pricing.toml');
    if(fixture.custom)await fs.writeFile(customFile,'[models."gpt-fixture"]\ninput=3\noutput=12\ncache_read=0.2\n');
    const id='12345678-1234-4234-8234-123456789012',timestamp=now.toISOString();
    const [input,cached,output,reasoning,total]=fixture.counts;
    const tokens={input_tokens:input,cached_input_tokens:cached,output_tokens:output,reasoning_output_tokens:reasoning,total_tokens:total};
    const rows=[{type:'session_meta',timestamp,payload:{id,cwd:dir,timestamp}},
      {type:'turn_context',timestamp,payload:{model:fixture.model,effort:'high'}},
      {type:'event_msg',timestamp,payload:{type:'thread_settings_applied',thread_settings:{service_tier:fixture.fast?'priority':'default'}}},
      {type:'event_msg',timestamp,payload:{type:'token_count',info:{total_token_usage:tokens,last_token_usage:tokens}}}];
    await fs.writeFile(path.join(day,`rollout-${timestamp.slice(0,10)}T00-00-00-${id}.jsonl`),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    const result=spawnSync('toktrack',['daily','--json','--local-only'],{encoding:'utf8',timeout:60000,
      env:{...process.env,HOME:dir,USERPROFILE:dir,CODEX_HOME:codex,TOKTRACK_PRICING_FILE:customFile}});
    assert.equal(result.status,0,result.stderr);
    const data=JSON.parse(result.stdout);
    const expected=new UsagePricing({table:fixture.table,custom:fixture.custom}).quote(fixture.model,fixture.counts as [number,number,number,number,number],fixture.fast).usd!;
    const costs:number[]=[];const walk=(v:unknown)=>{if(v&&typeof v==='object')for(const [key,item] of Object.entries(v)){
      if((key==='cost_usd'||key==='total_cost'||key==='total_cost_usd')&&typeof item==='number')costs.push(item);else walk(item);
    }};walk(data);
    assert.ok(costs.some(cost=>Math.abs(cost-expected)<1e-9),`${fixture.name}: Reference costs ${JSON.stringify(costs)} did not contain ${expected}`);
  }
});

test('offline installations use the vendored toktrack table without creating a pricing cache',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hud-pricing-offline-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const p=new UsagePricing({cacheFile:path.join(dir,'absent.json'),customFile:path.join(dir,'absent.toml')});await p.load();
  assert.equal(p.source,'toktrack bundled snapshot');assert.ok(p.list('gpt-5.3-codex'));
  assert.deepEqual(await fs.readdir(dir),[]);
});
