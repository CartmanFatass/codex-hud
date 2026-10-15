import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProgressSummarizer, PROGRESS_RETRY_MS, type ProgressState, type ProgressContext } from '../../src/collectors/progress-summary.js';
import { SmallModel } from '../../src/collectors/small-model.js';
import { AgentLog, appendEntries, type AgentLogEntry } from '../../src/collectors/agent-log.js';
import { inspectorRows } from '../../src/render/monitor-inspector.js';
import { agentCard, richRows } from '../../src/render/cards.js';
import { initialMonitorState, type MonitorData } from '../../src/render/monitor.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { setLanguage, t } from '../../src/render/i18n.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const now = Date.parse('2026-10-04T10:00:00Z');
const node: SubagentTreeNode = { id:'lead', name:'synthetic lead', depth:1, status:'running', children:[],
  turnStartedAt:new Date(now-1000), lastReport:{at:new Date(now-500),text:'Reading synthetic tests.',kind:'update'} };
const tree: SubagentTree = { rootId:'root', nodes:[node], totalCount:1, updatedAt:new Date(now) };
const context: ProgressContext = {backendOn:true,paused:false,enabled:true,targets:new Set(['lead'])};
const state = {...initialMonitorState(), style:'rich' as const, preview:'agent' as const,
  tree:{...initialMonitorState().tree,selectedId:'lead'}};
const reply = () => new Response(JSON.stringify({choices:[{message:{content:'Reading synthetic tests.'}}]}));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function input(progress: ProgressState, ctx = context): MonitorData {
  return {tree,state,width:56,height:40,progress:new Map([['lead',progress]]),progressContext:ctx};
}
function text(data: MonitorData, width = 32) { return inspectorRows(data,state,width,now).map(row=>stripAnsi(row.text)).join('\n'); }

test('collector reports queue waiting, writing notifications and distinct coverage/generation times with no extra calls', async () => {
  let clock = now;
  let changes = 0;
  const pending: Array<(value: Response) => void> = [];
  const model = new SmallModel({env:{},clock:()=>clock,fetch:(() => new Promise<Response>(resolve=>pending.push(resolve))) as typeof fetch});
  model.configure({backend:'api',api:{base:'http://synthetic.invalid/v1',key:'synthetic-secret',model:''}});
  const blocker = model.submit({feature:'labels',system:'synthetic',prompt:'synthetic'});
  const log = new AgentLog();
  const summarizer = new ProgressSummarizer(model,log,{onChange:()=>changes++});
  summarizer.update({tree,targets:context.targets,on:true,language:'en',now});
  assert.equal(summarizer.state().get('lead')?.phase,'queued');
  assert.equal(summarizer.state().get('lead')?.running,false);
  assert.equal(pending.length,1);
  const before = changes;
  pending[0](reply());
  await blocker.result;
  await tick();
  assert.equal(summarizer.state().get('lead')?.phase,'running');
  assert.ok(changes>before);
  clock += 3000;
  pending[1](reply());
  await tick();
  const note = log.entries('lead').find(entry=>entry.kind==='note')!;
  assert.equal(note.at,now);
  assert.equal(note.coverageAt,now);
  assert.equal(note.generatedAt,now+3000);
  assert.equal(summarizer.state().get('lead')?.coverageAt,now);
  assert.equal(summarizer.state().get('lead')?.generatedAt,now+3000);
  assert.equal(summarizer.state().get('lead')?.phase,'idle');
  summarizer.update({tree,targets:context.targets,on:true,language:'en',now:clock});
  assert.equal(pending.length,2,'diagnostics never request extra model work');
  const restarted = new ProgressSummarizer(model,log);
  restarted.update({tree,targets:context.targets,on:true,language:'en',now:clock+1000});
  assert.equal(restarted.state().get('lead')?.running,false,'a settled cache hit is not generating');
  await tick();
  assert.equal(restarted.state().get('lead')?.generatedAt,now+3000);
  assert.equal(pending.length,2);
  assert.doesNotMatch(JSON.stringify([...summarizer.state()]),/synthetic-secret|synthetic.invalid|Reading synthetic/);
});

test('matching a legacy note never promotes its recording time to coverage', async () => {
  const model = new SmallModel({env:{},clock:()=>now,fetch:(async()=>reply()) as typeof fetch});
  model.configure({backend:'api',api:{base:'http://synthetic.invalid/v1',key:'',model:''}});
  const log = new AgentLog(); log.attach('root');
  log.add('lead',[{kind:'note',at:now-400,text:'Reading synthetic tests.',lang:'en'}]);
  const summary = new ProgressSummarizer(model,log);
  summary.update({tree,targets:context.targets,on:true,language:'en',now});
  await tick();
  assert.equal(summary.state().get('lead')?.coverageAt,undefined);
  assert.equal(log.entries('lead')[0].coverageAt,undefined);
  const data = input(summary.state().get('lead')!); data.agentLog = log.snapshot();
  assert.match(text(data,56),/Recorded:/);
  assert.doesNotMatch(text(data,56),/Coverage:/);
});

test('hourly cap is explicit, safe, and clears failure on retry without raising the budget', async () => {
  let clock = now;
  let calls = 0;
  const model = new SmallModel({env:{},clock:()=>clock,fetch:(async()=>{calls++;return reply();}) as typeof fetch});
  model.configure({backend:'api',hourlyCap:1,api:{base:'http://synthetic.invalid/v1',key:'',model:''}});
  await model.submit({feature:'labels',system:'synthetic',prompt:'synthetic'}).result;
  const summarizer = new ProgressSummarizer(model,new AgentLog());
  const update = () => summarizer.update({tree,targets:context.targets,on:true,language:'en',now:clock});
  update(); await tick();
  assert.equal(summarizer.state().get('lead')?.reason,'hourly-cap');
  assert.equal(summarizer.state().get('lead')?.phase,'error');
  clock += PROGRESS_RETRY_MS-1; update();
  assert.equal(calls,1);
  clock += 3600_000; update();
  assert.equal(summarizer.state().get('lead')?.phase,'running');
  assert.equal(summarizer.state().get('lead')?.error,undefined);
  await tick();
  assert.equal(calls,2);
  assert.equal(model.usage(clock).cap,1);
});

test('inspector gate diagnoses supersede stale work and stored notes remain with backend off', () => {
  const old = setLanguage('en');
  try {
    const cases: Array<[Partial<ProgressContext>,string]> = [
      [{backendOn:false},'model backend off'],[{paused:true},'models paused'],[{enabled:false},'live progress disabled'],
      [{targets:new Set()},'summary hidden'],
    ];
    for (const [patch,reason] of cases) {
      const data = input({phase:'running',running:true},{...context,...patch});
      data.agentLog = new Map([['lead',[{kind:'note',at:now-60000,coverageAt:now-60000,generatedAt:now-59000,text:'Stored synthetic summary.',lang:'en'}]]]);
      const body = text(data,56);
      assert.ok(body.includes(reason),body);
      assert.match(body,/Stored synthetic summary/);
      assert.match(body,/Coverage: 2026-10-04T09:59:00.000Z/);
      assert.match(body,/Generated: 2026-10-04T09:59:01.000Z/);
      assert.doesNotMatch(body,/Progress: writing/);
    }
    const notLive = input({phase:'idle',running:false});
    notLive.tree = {...tree,nodes:[{...node,status:'completed'}]};
    assert.match(text(notLive),/agent not live/);
    for (const [reason,label] of Object.entries({'no-evidence':'no public progress evidence',cooldown:'refresh cooldown',retry:'retry wait','concurrency-cap':'progress concurrency cap','hourly-cap':'hourly model call cap'})) {
      assert.ok(text(input({phase:'blocked',running:false,reason:reason as ProgressState['reason']}),56).includes(label));
    }
    assert.match(text(input({phase:'queued',running:false})),/queued/);
    assert.match(text(input({phase:'running',running:true})),/writing/);
  } finally { setLanguage(old); }
});

test('cards show only concise enabled queue/writing/error/cap states, wrapping CJK in at most two rows', () => {
  const old = setLanguage('en');
  try {
    for (const lang of ['en','zh'] as const) {
      setLanguage(lang);
      for (const width of [12,20,32,56]) {
        for (const [progress,key] of [
          [{phase:'queued',running:false},'Progress summary queued…'],
          [{phase:'running',running:true},'Writing progress summary…'],
          [{phase:'error',running:false,error:'PRIVATE synthetic secret'},'Progress summary failed'],
          [{phase:'blocked',running:false,reason:'hourly-cap'},'Progress summary hourly cap'],
          [{phase:'blocked',running:false,reason:'concurrency-cap'},'Progress summary concurrency cap'],
        ] as Array<[ProgressState,string]>) {
          const data = input(progress);
          const rows = agentCard({node,depth:1,prefix:'',hasChildren:false,collapsed:false,context:false,parentId:null},data,state,width,now);
          assert.ok(rows.length<=4,`${lang} ${width} status rows capped`);
          for (const row of rows) assert.ok(visualLength(row.text)<=width);
          assert.doesNotMatch(rows.map(row=>stripAnsi(row.text)).join('\n'),/PRIVATE/);
          const hidden = agentCard({node,depth:1,prefix:'',hasChildren:false,collapsed:false,context:false,parentId:null},data,{...state,cardVisibility:{cardSummary:false}},width,now);
          assert.equal(hidden.length,2);
          if (width===56) assert.ok(rows.some(row=>stripAnsi(row.text).includes(t(key))));
        }
      }
    }
    setLanguage('en');
    const queued = richRows(input({phase:'queued',running:false}),state,56,now,false).map(row=>stripAnsi(row.text)).join('\n');
    const writing = richRows(input({phase:'running',running:true}),state,56,now,false).map(row=>stripAnsi(row.text)).join('\n');
    assert.match(queued,/queued/); assert.match(writing,/Writing/); assert.notEqual(queued,writing);
  } finally { setLanguage(old); }
});

test('note metadata persists compatibly; legacy and malformed generatedAt remain unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'summary-status-'));
  try {
    const log = new AgentLog(dir,()=>now); log.attach('root');
    log.add('lead',[{kind:'note',at:now-1000,coverageAt:now-1000,text:'Synthetic note.',generatedAt:now,lang:'en'}]); log.flush();
    const loaded = new AgentLog(dir,()=>now); loaded.attach('root');
    assert.equal(loaded.entries('lead')[0].generatedAt,now);
    assert.equal(loaded.entries('lead')[0].coverageAt,now-1000);
    const entries: AgentLogEntry[] = [];
    appendEntries(entries,[{kind:'note',at:now,text:'Legacy.'},
      {kind:'note',at:now+1,text:'Malformed.',generatedAt:'SECRET' as unknown as number},
      {kind:'note',at:now+2,text:'Nonfinite.',generatedAt:NaN}]);
    assert.ok(entries.every(entry=>entry.generatedAt===undefined));
    const data = input({phase:'idle',running:false}); data.agentLog = new Map([['lead',entries]]);
    assert.doesNotMatch(text(data),/Generated:|Coverage:|SECRET/);
    assert.match(text(data),/Recorded:/,'legacy note time is not falsely presented as coverage');
    appendEntries(entries,[{kind:'note',at:now+3,text:'Nonfinite.',generatedAt:now+5}]);
    assert.equal(entries.at(-1)?.generatedAt,now+5,'same-note refresh retains its own generated time');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
