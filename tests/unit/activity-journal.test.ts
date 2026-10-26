import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ActivityJournal, ACTIVITY_LIMITS } from '../../src/collectors/activity-journal.js';
import { makeHudData, node, treeOf, FIXED_NOW } from '../fixtures/hud-data.js';
import type { GitChanges } from '../../src/collectors/git-changes.js';

const START=FIXED_NOW.getTime();
function setup() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hud-activity-')); let now=START;
  const create=()=>new ActivityJournal({codexHome:dir,rootId:'synthetic-root',now:()=>now});
  return {dir,create,tick:(ms=1000)=>now+=ms,clock:()=>now,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
const tree=(status:'running'|'error'|'completed'|'starting'='running',at=START)=>({...treeOf([{...node('synthetic-agent','Fix layout',status),
  role:'implementer',agentPath:'/root/layout',statusAt:new Date(at),task:'PRIVATE TASK',charge:'PRIVATE CHARGE',digest:'PRIVATE NODE DIGEST',
    rolloutPath:'/private/session.jsonl',lastReport:{text:'PRIVATE REPORT',at:new Date(at),kind:'message'}}]),rootId:'synthetic-root'});
const git=(name='src/example.ts',added:number|null=1):GitChanges=>({root:'/synthetic/repo',branch:'example',ahead:0,behind:0,files:name ?
  [{path:name,index:'M',worktree:'.',added,removed:null,binary:false,conflict:false}] : []});

test('restart dedup, terminal completion, per-event read/snooze and recovery',()=>{
  const s=setup(); try {
    let journal=s.create(); const data=makeHudData({pendingApproval:{kind:'exec',callId:'approval-a',since:new Date(START),command:'PRIVATE COMMAND',summary:'PRIVATE APPROVAL'}});
    journal.observe({tree:tree('error'),data});
    assert.deepEqual(journal.inbox().map(e=>e.kind).sort(),['approval','failed','tool-failed']);
    const failed=journal.inbox().find(e=>e.kind==='failed')!; journal.markRead(failed.id);
    const approval=journal.inbox().find(e=>e.kind==='approval')!; journal.snooze(approval.id,s.clock()+2000);
    journal=s.create(); journal.observe({tree:tree('error'),data});
    assert.equal(journal.view().events.filter(e=>e.kind==='failed').length,1);
    assert.equal(journal.inbox().some(e=>e.id===failed.id),false);
    assert.equal(journal.inbox().some(e=>e.id===approval.id),false);
    s.tick(2100); assert.equal(journal.inbox().some(e=>e.id===approval.id),true);
    journal.observe({tree:tree('completed',s.clock()),data:makeHudData({pendingApproval:undefined})});
    assert.ok(journal.view().events.find(e=>e.id===failed.id)?.resolvedAt);
    assert.ok(journal.view().events.some(e=>e.kind==='completed'));
    assert.equal(journal.inbox().some(e=>e.kind==='approval'),false);
    s.tick(); journal.observe({tree:tree('error',s.clock())});
    assert.equal(journal.inbox().filter(e=>e.kind==='failed').length,1);
    const count=journal.view().events.length; journal.observe({tree:tree('error',s.clock())});
    assert.equal(journal.view().events.length,count);
  } finally {s.cleanup();}
});

test('a captured receipt cannot hide later arrivals, even after restart or out-of-order acknowledgements',()=>{
  const s=setup();try {
    const a=s.create();a.observe({tree:tree('completed')}); const receipt=a.view().receipt;
    assert.equal(a.sinceViewed().length,1); assert.equal(a.sinceViewed().length,1);
    s.tick();const b=s.create(); b.observe({tree:tree('error',s.clock())});
    a.markViewed(receipt); const next=s.create(); assert.equal(next.sinceViewed().some(e=>e.kind==='failed'),true);
    assert.equal(next.sinceViewed().some(e=>e.kind==='completed'),false);
    const all=next.view().receipt; const last=next.sinceViewed().find(e=>e.kind==='failed')!;
    next.markViewed({...all,eventIds:[last.id]});
    assert.ok(next.view().seenThrough<=last.seq);
    next.markViewed({...all,rootId:'other-root'}); assert.equal(next.view().rootId,'synthetic-root');
  }finally{s.cleanup();}
});

test('concurrent panels merge action state and no-op quiet ticks do not rewrite storage',()=>{
  const s=setup();try {
    const a=s.create(); const b=s.create(); a.observe({tree:tree('error')}); b.pin('synthetic-agent');
    const event=a.inbox()[0]; a.markRead(event.id);
    assert.equal(s.create().view().pinnedIds[0],'synthetic-agent'); assert.ok(s.create().view().events.find(e=>e.id===event.id)?.read);
    const file=fs.readdirSync(path.join(s.dir,'hud','activity')).find(n=>n.endsWith('.json'))!;
    const full=path.join(s.dir,'hud','activity',file);
    a.observe({tree:tree('error'),healthSignals:[{key:'collector:tree',kind:'health',active:false,at:s.clock()}]});
    const quietBefore=fs.statSync(full).mtimeMs;const quietBytes=fs.readFileSync(full,'utf8');
    for(let i=0;i<100;i++) {s.tick(100);a.observe({tree:tree('error'),healthSignals:[{key:'collector:tree',kind:'health',active:false,at:s.clock()}]});}
    assert.equal(fs.statSync(full).mtimeMs,quietBefore); assert.equal(fs.readFileSync(full,'utf8'),quietBytes);
    assert.equal(a.view().pinnedIds[0],'synthetic-agent');
    assert.equal(fs.statSync(full).mode&0o777,0o600);
  }finally{s.cleanup();}
});

test('live lock defers pending actions and dead-owner lock is recovered without dropping them',()=>{
  const s=setup();try {
    const a=s.create(); a.observe({tree:tree('error')});
    const dir=path.join(s.dir,'hud','activity'); const file=fs.readdirSync(dir).find(n=>n.endsWith('.json'))!;const lock=path.join(dir,`${file}.lock`);
    fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner'),JSON.stringify({pid:process.pid}));
    a.pin('synthetic-agent'); assert.equal(a.view().persistence,'pending'); assert.ok(a.view().pinnedIds.includes('synthetic-agent'));
    fs.writeFileSync(path.join(lock,'owner'),JSON.stringify({pid:2147483647})); assert.equal(a.flush(),true);
    assert.ok(s.create().view().pinnedIds.includes('synthetic-agent')); assert.equal(fs.existsSync(lock),false);
  }finally{s.cleanup();}
});

test('Git and changed stored model summaries record observations without raw reports or guessed clean states',()=>{
  const s=setup();try {
    const a=s.create(); const logs=new Map([['synthetic-agent',[
      {kind:'report' as const,at:START,text:'PRIVATE RAW REPORT'},
      {kind:'note' as const,at:START,text:'Stored model summary',lang:'en' as const}]]]);
    a.observe({tree:tree(),logs,git:git(),gitObservedAt:START,gitFresh:true});
    assert.equal(a.view().availability.git,'fresh'); assert.equal(a.view().events.filter(e=>e.kind==='git').length,1);
    s.tick();a.observe({logs,git:null,gitFresh:false});
    assert.equal(a.view().availability.git,'stale');assert.equal(a.view().events.filter(e=>e.kind==='git').length,1);
    s.tick();a.observe({git:git('src/example.ts',2),gitObservedAt:s.clock(),gitFresh:true});
    assert.equal(a.view().events.filter(e=>e.kind==='git').length,2);
    s.tick();a.observe({git:git('src/example.ts',1),gitObservedAt:s.clock(),gitFresh:true});
    assert.equal(a.view().events.filter(e=>e.kind==='git').length,3);
    s.tick();a.observe({logs:new Map([['synthetic-agent',[{kind:'note',at:s.clock(),text:'A revised stored model summary',lang:'en'}]]])});
    assert.equal(a.view().events.filter(e=>e.kind==='summary').length,2);
    a.observe({modelAvailable:false}); assert.equal(a.view().availability.model,'disabled');
    const bytes=fs.readFileSync(path.join(s.dir,'hud','activity',fs.readdirSync(path.join(s.dir,'hud','activity')).find(n=>n.endsWith('.json'))!),'utf8');
    for(const secret of ['PRIVATE','rolloutPath','lastReport','charge','digest','arguments']) assert.equal(bytes.includes(secret),false,secret);
    assert.equal(bytes.includes('Stored model summary'),true);
  }finally{s.cleanup();}
});

test('missing evidence cannot resolve alerts, explicit health recovery and later mismatch create new occurrences',()=>{
  const a=new ActivityJournal({rootId:'synthetic-root',now:()=>START});
  const active={healthSignals:[{key:'native-state',kind:'mismatch' as const,active:true}]};
  a.observe(active); const first=a.inbox()[0].id;
  a.observe({data:makeHudData({stale:true})});assert.equal(a.inbox()[0].id,first);
  a.observe({healthSignals:[{key:'native-state',kind:'mismatch',active:false}]});assert.equal(a.inbox().length,0);
  a.observe(active);const second=a.inbox()[0].id;assert.notEqual(first,second);
  a.observe(active);assert.equal(a.inbox().length,1);assert.equal(a.inbox()[0].id,second);
});

test('history replays bounded agent state, search name/role/path and pins survive restart',()=>{
  const s=setup();try {
    const a=s.create();a.observe({tree:tree('starting')}); const snapshot=a.view().history.at(-1)!;
    assert.equal(snapshot.agents[0].status,'starting'); s.tick();a.observe({tree:tree('completed',s.clock())});
    assert.equal(a.replay(snapshot.id)?.agents[0].status,'starting');
    assert.equal(a.search('implementer layout')[0]?.id,'synthetic-agent');assert.equal(a.search('missing').length,0);
    a.pin('synthetic-agent');assert.equal(s.create().view().pinnedIds[0],'synthetic-agent');
  }finally{s.cleanup();}
});

test('bounds limit persisted history, events, metadata text and ages; session root is scoped safely',()=>{
  let now=START; const a=new ActivityJournal({rootId:'../../synthetic-root',now:()=>now});
  for(let i=0;i<ACTIVITY_LIMITS.events+25;i++) {now++;a.observe({logs:new Map([['synthetic-agent',[{kind:'note',at:now,text:`${i} ${'x'.repeat(2000)}`}]]])});}
  assert.equal(a.view().events.length,ACTIVITY_LIMITS.events);assert.equal(a.view().history.length,ACTIVITY_LIMITS.history);
  assert.ok(a.view().events.every(e=>(e.summary?.length??0)<=ACTIVITY_LIMITS.text));
  now+=ACTIVITY_LIMITS.keepMs+1;assert.equal(a.view().events.length,0);assert.equal(a.view().history.length,0);
});

test('malformed/oversized files are ignored; view snapshots are immutable copies with no file reads',()=>{
  const s=setup();try {
    const a=s.create();a.observe({tree:tree()}); const view=a.view();view.agents[0].name='mutated';assert.notEqual(a.view().agents[0].name,'mutated');
    const dir=path.join(s.dir,'hud','activity');const file=path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith('.json'))!);
    fs.writeFileSync(file,'{broken');assert.equal(s.create().view().agents.length,0);
    fs.writeFileSync(file,' '.repeat(ACTIVITY_LIMITS.bytes+1));assert.equal(s.create().view().events.length,0);
    fs.rmSync(path.join(s.dir,'hud'),{recursive:true}); assert.equal(a.view().agents.length,1);assert.equal(s.create().view().agents.length,0);
  }finally{s.cleanup();}
});

test('unknown agent/native state and main read success cannot claim unrelated Git recovery',()=>{
  const a=new ActivityJournal({rootId:'synthetic-root',now:()=>START});
  a.observe({tree:tree('error'),data:makeHudData({bridgeHealth:{state:'disconnected'},toolActivity:undefined,health:{lastReadAt:new Date(START+10),
    lastError:{source:'git',message:'PRIVATE ERROR',at:new Date(START)}}})});
  const ids=a.inbox().map(e=>e.id);assert.equal(ids.length,3);
  a.observe({tree:treeOf([node('synthetic-agent','Unknown agent','unknown')],'synthetic-root'),
    data:makeHudData({bridgeHealth:{state:'pending'},toolActivity:undefined})});
  assert.deepEqual(a.inbox().map(e=>e.id),ids);
  const data=makeHudData({bridgeHealth:{state:'connected'},toolActivity:undefined,health:{lastError:{source:'git',message:'PRIVATE ERROR',at:new Date(START)}}});
  a.observe({data,git:git(),gitFresh:true,gitObservedAt:START});
  assert.equal(a.inbox().filter(e=>e.kind==='health').length,0);
  const count=a.view().events.length;
  a.observe({tree:tree(),data,git:git(),gitFresh:true,gitObservedAt:START});
  assert.equal(a.view().events.filter(e=>e.kind==='health').length,2);
  assert.ok(a.view().events.length>=count);
});

test('serialized storage remains readable within its byte limit at worst-case metadata sizes',()=>{
  const s=setup();try {
    const a=s.create(); const agents=Array.from({length:200},(_,i)=>({...node(`synthetic-${i}-${'a'.repeat(100)}`,'n'.repeat(80),'running'),
      role:'r'.repeat(80),agentPath:`/root/${'p'.repeat(230)}`}));
    for(let i=0;i<55;i++) {
      s.tick(); agents[0].name=`${i} ${'n'.repeat(75)}`;
      a.observe({tree:treeOf(agents,'synthetic-root')});
    }
    const dir=path.join(s.dir,'hud','activity');const file=path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith('.json'))!);
    assert.ok(fs.statSync(file).size<=ACTIVITY_LIMITS.bytes);
    assert.equal(s.create().view().agents.length,200);assert.ok(s.create().view().history.length<ACTIVITY_LIMITS.history);
  }finally{s.cleanup();}
});

test('an unresolved current condition survives retention and a delayed old panel cannot resolve a newer failure',()=>{
  const s=setup();try {
    const old=s.create();old.observe({tree:tree('running')});
    s.tick();const latest=s.create();latest.observe({tree:tree('error',s.clock())});
    s.tick(ACTIVITY_LIMITS.keepMs+1);assert.equal(latest.inbox().filter(e=>e.kind==='failed').length,1);
    // Reopen with a clock from an older observation. A status replay must not roll the shared state back.
    const delayed=new ActivityJournal({codexHome:s.dir,rootId:'synthetic-root',now:()=>START});delayed.observe({tree:tree('running')});
    assert.equal(s.create().inbox().filter(e=>e.kind==='failed').length,1);
  }finally{s.cleanup();}
});

test('explicit collector recovery survives old retained lastError records and newer failures still alert',()=>{
  const s=setup();try {
    let a=s.create();const data=makeHudData({stale:true,toolActivity:undefined,health:{lastError:{source:'tree',message:'PRIVATE ERROR',at:new Date(START)}}});
    a.observe({data});assert.equal(a.inbox().length,1);
    s.tick();a.observe({healthSignals:[{key:'collector:tree',kind:'health',active:false,at:s.clock()}]});assert.equal(a.inbox().length,0);
    a=s.create();s.tick();a.observe({data});assert.equal(a.inbox().length,0);
    s.tick();const failedAt=s.clock();a.observe({data:makeHudData({toolActivity:undefined,health:{lastError:{source:'tree',message:'PRIVATE NEW ERROR',at:new Date(failedAt)}}})});
    assert.equal(a.inbox().length,1);
    s.tick();a.observe({healthSignals:[{key:'collector:tree',kind:'health',active:false,at:START}]});assert.equal(a.inbox().length,1);
  }finally{s.cleanup();}
});

test('an existing success watermark crossing a retained failure recovers without quiet timestamp churn',()=>{
  const s=setup();try {
    const a=s.create(); const failureAt=START+1000;
    const data=makeHudData({subagentTree:undefined,toolActivity:undefined,health:{lastError:{source:'worktrees',message:'PRIVATE FAILURE',at:new Date(failureAt)}}});
    a.observe({data,healthSignals:[{key:'collector:worktrees',kind:'health',active:false,at:START}]});
    assert.equal(a.inbox().filter(e=>e.source==='worktrees').length,1);
    s.tick(2000);
    a.observe({data,healthSignals:[{key:'collector:worktrees',kind:'health',active:false,at:s.clock()}]});
    assert.equal(a.inbox().length,0);
    const dir=path.join(s.dir,'hud','activity'); const file=path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith('.json'))!);
    const bytes=fs.readFileSync(file,'utf8'); const modified=fs.statSync(file).mtimeMs;
    for(let i=0;i<20;i++) {s.tick();a.observe({data,healthSignals:[{key:'collector:worktrees',kind:'health',active:false,at:s.clock()}]});}
    assert.equal(fs.readFileSync(file,'utf8'),bytes);assert.equal(fs.statSync(file).mtimeMs,modified);
    assert.equal(s.create().inbox().length,0);
  }finally{s.cleanup();}
});

test('stale nested or explicitly passed trees cannot resolve a newer shared agent failure',()=>{
  const s=setup();try {
    const a=s.create();a.observe({tree:tree('error')}); const failed=a.inbox()[0].id;
    s.tick(); const b=s.create(); const cached=tree('running');
    const stale=makeHudData({stale:true,subagentTree:cached,activity:{state:'working',updatedAt:new Date(s.clock())},
      pendingApproval:undefined,toolActivity:undefined,health:{lastError:{source:'tree',message:'PRIVATE FAILURE',at:new Date(s.clock())}}});
    b.observe({data:stale});
    assert.equal(b.view().agents[0].status,'error');assert.ok(b.inbox().some(e=>e.id===failed));
    assert.ok(b.inbox().some(e=>e.kind==='health' && e.source==='tree'));
    s.tick();b.observe({data:stale,tree:cached});
    assert.equal(b.view().agents[0].status,'error');assert.ok(b.inbox().some(e=>e.id===failed));
    assert.ok(s.create().inbox().some(e=>e.id===failed));
  }finally{s.cleanup();}
});
