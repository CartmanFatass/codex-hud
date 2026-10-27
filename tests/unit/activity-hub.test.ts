import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityJournal } from '../../src/collectors/activity-journal.js';
import { initialActivityHubState, renderActivityHub, handleActivityHubInput, type ActivityHubState } from '../../src/render/activity-hub.js';
import { setLanguage } from '../../src/render/i18n.js';
import { visualLength, stripAnsi } from '../../src/render/colors.js';
import { node, treeOf, FIXED_NOW, makeHudData } from '../fixtures/hud-data.js';

const NOW=FIXED_NOW.getTime();
function fixture(count=8) {
  const a=new ActivityJournal({rootId:'synthetic-root',now:()=>NOW});
  a.observe({tree:treeOf(Array.from({length:count},(_,i)=>({...node(`synthetic-${i}`,`布局修复 ${i}`,i%2 ? 'completed' : 'error'),
    agentPath:`/root/layout-${i}`,role:i%2 ? 'reviewer' : 'implementer',statusAt:new Date(NOW)})),'synthetic-root'),
    logs:new Map([['synthetic-0',[{kind:'note',at:NOW,text:'Synthetic model summary with no raw conversation.'}]]])});
  return a;
}

test('EN/ZH narrow modal frames have exact widths and visible semantic controls for all tabs',()=>{
  const a=fixture();
  for(const lang of ['en','zh'] as const) {
    const previous=setLanguage(lang); try {
      for(const width of [20,24,32,40,48,56]) for(const tab of ['inbox','updates','find','history'] as const) {
        const frame=renderActivityHub(a.view(),initialActivityHubState(tab),width,18,NOW);
        assert.equal(frame.lines.length,18);
        for(const line of frame.lines) assert.equal(visualLength(line),width,`${lang}/${width}/${tab}: ${stripAnsi(line)}`);
        assert.ok(frame.controls.some(c=>c.action.type==='close'),`${lang}/${width}/${tab}: close`);
        assert.ok(frame.rows.length);
        for(const c of frame.controls) assert.ok(c.x>=0 && c.y>=0 && c.x+c.width<=width && c.y<18);
        if(tab==='inbox' || tab==='updates') {
          for(const type of ['read','snooze','pin','target']) assert.ok(frame.controls.some(c=>c.action.type===type),`${lang}/${width}/${tab}: ${type}`);
        }
      }
    } finally {setLanguage(previous);}
  }
});

test('render and input are pure; visible receipt acknowledges only rendered rows and preserves arrivals',()=>{
  const a=fixture(20); const state=initialActivityHubState('updates');const before=JSON.stringify(a.view());
  const frame=renderActivityHub(a.view(),state,32,12,NOW);
  assert.ok(frame.receipt.eventIds.length<a.view().events.length);
  assert.ok(frame.receipt.eventIds.every(id=>frame.rows.find(r=>r.id===id)?.y!==undefined));
  const result=handleActivityHubInput(frame.state,{type:'key',key:'detail-toggle',raw:'v'},frame);
  assert.equal(result.action?.type,'viewed'); assert.equal(JSON.stringify(a.view()),before);
  if(result.action?.type==='viewed') a.markViewed(result.action.receipt);
  assert.ok(a.sinceViewed().length); assert.ok(a.sinceViewed().every(e=>!frame.receipt.eventIds.includes(e.id)));
  assert.deepEqual(state,initialActivityHubState('updates'));
});

test('Find handles printable raw mapped command keys, Unicode, paste, deletion, arrows and Enter',()=>{
  const a=fixture(); let state=initialActivityHubState('find');
  const input=(key:string,raw?:string)=>{
    const frame=renderActivityHub(a.view(),state,32,16,NOW);state=frame.state;
    const result=handleActivityHubInput(state,{type:'key',key,raw},frame);state=result.state;return result;
  };
  input('close','q');input('down','j');input('reset','r');assert.equal(state.query,'qjr');
  input('backspace','\x7f');input('backspace','\x7f');input('backspace','\x7f');assert.equal(state.query,'');
  let frame=renderActivityHub(a.view(),state,32,16,NOW);
  state=handleActivityHubInput(state,{type:'paste',text:'布局'},frame).state;
  assert.equal(state.query,'布局'); input('down','\x1b[B');assert.equal(state.selected,1);
  const enter=input('enter','\r');assert.equal(enter.action?.type,'target');
  input('','\x10');assert.equal(state.query,'布局'); // Control chords are actions, not query characters.
  assert.equal(input('escape','\x1b').action?.type,'close');
});

test('keyboard/mouse action target IDs match selected rows; snooze duration uses frame time',()=>{
  const a=fixture();let state=initialActivityHubState();let frame=renderActivityHub(a.view(),state,32,16,NOW);state=frame.state;
  const down=handleActivityHubInput(state,{type:'key',key:'down',raw:'\x1b[B'},frame);state=down.state;
  frame=renderActivityHub(a.view(),state,32,16,NOW);
  const row=frame.rows[state.selected];
  const pin=handleActivityHubInput(state,{type:'key',key:'',raw:'p'},frame);assert.deepEqual(pin.action,{type:'pin',agentId:row.agentId,value:true});
  const read=handleActivityHubInput(state,{type:'key',key:'reset',raw:'r'},frame);assert.deepEqual(read.action,{type:'read',eventId:row.eventId,value:true});
  const snooze=handleActivityHubInput(state,{type:'key',key:'sort',raw:'s'},frame);assert.deepEqual(snooze.action,{type:'snooze',eventId:row.eventId,until:NOW+600_000});
  const control=frame.controls.find(c=>c.action.type==='target')!;
  assert.equal(handleActivityHubInput(state,{type:'mouse',button:'left',x:control.x,y:control.y},frame).action?.type,'target');
  const tab=frame.controls.find(c=>c.action.type==='tab' && c.action.tab==='history')!;
  state=handleActivityHubInput(state,{type:'mouse',button:'left',x:tab.x,y:tab.y},frame).state;assert.equal(state.tab,'history');
});

test('history opens frozen observed state and Escape returns to snapshots before closing',()=>{
  let now=NOW;const a=new ActivityJournal({rootId:'synthetic-root',now:()=>now});
  a.observe({tree:treeOf([{...node('synthetic-a','Synthetic agent','running'),agentPath:'/root/layout'}],'synthetic-root')});
  const first=a.view().history[0];now++;
  a.observe({tree:treeOf([node('synthetic-a','Synthetic agent','completed')],'synthetic-root')});
  let state:ActivityHubState={...initialActivityHubState('history'),replayId:first.id};let frame=renderActivityHub(a.view(),state,32,16,now);
  assert.ok(frame.rows.some(r=>r.kind==='agent' && r.text.includes('running')));
  assert.equal(frame.rows.some(r=>r.kind==='event' && r.text.includes('completed')),false);
  state=handleActivityHubInput(state,{type:'key',key:'escape'},frame).state;assert.equal(state.replayId,undefined);
  frame=renderActivityHub(a.view(),state,32,16,now);assert.ok(frame.rows.every(r=>r.kind==='snapshot'));
  const result=handleActivityHubInput(state,{type:'key',key:'enter'},frame);assert.ok(result.state.replayId);
});

test('external names/model summaries and paths cannot emit terminal escape sequences',()=>{
  const a=new ActivityJournal({rootId:'synthetic-root',now:()=>NOW});
  a.observe({tree:treeOf([{...node('synthetic-a','Name\x1b[2J','error'),agentPath:'/root/\x1b[31m'}],'synthetic-root'),
    logs:new Map([['synthetic-a',[{kind:'note',at:NOW,text:'Summary\x1b[2J\u202eevil'}]]])});
  for(const tab of ['find','updates'] as const) {
    const frame=renderActivityHub(a.view(),initialActivityHubState(tab),48,16,NOW);
    assert.equal(frame.rows.some(r=>r.text.includes('\x1b') || r.detail?.includes('\x1b')),false);
  }
});

test('unknown data displays absence labels, paused model summary availability is explicit, tiny layouts do not overflow',()=>{
  const a=new ActivityJournal({rootId:'synthetic-root',now:()=>NOW});
  let frame=renderActivityHub(a.view(),initialActivityHubState('updates'),56,10,NOW);
  assert.match(stripAnsi(frame.lines.join('\n')),/Git unavailable/); assert.match(stripAnsi(frame.lines.join('\n')),/Model summaries unavailable/);
  a.observe({modelAvailable:false});frame=renderActivityHub(a.view(),initialActivityHubState('updates'),56,10,NOW);
  assert.match(stripAnsi(frame.lines.join('\n')),/Model off/);
  for(const width of [0,1,8]) for(const height of [0,1,3,6]) {
    frame=renderActivityHub(a.view(),initialActivityHubState(),width,height,NOW);assert.equal(frame.lines.length,height);
    assert.ok(frame.lines.every(line=>visualLength(line)===width));
  }
});

test('Sessions lists this directory\'s recent sessions with the command that resumes one, whole, and runs nothing',()=>{
  const a=fixture();
  const sessions=[{id:'019bc10d-c89d-7352-935c-76b351384357',modifiedAt:NOW-60_000,title:'Fix parser recovery',current:true},
    {id:'019bc10e-0000-7352-935c-000000000001',modifiedAt:NOW-3*3_600_000},{id:'019bc10f-1111-7352-935c-000000000002',modifiedAt:NOW-2*86_400_000,title:'Release notes'}];
  for(const lang of ['en','zh'] as const) {
    const previous=setLanguage(lang); try {
      for(const width of [20,24,32,40,48,56,80]) for(const selected of [0,1,2]) {
        const frame=renderActivityHub(a.view(),{...initialActivityHubState('sessions'),selected},width,18,NOW,sessions);
        for(const line of frame.lines) assert.equal(visualLength(line),width,`${lang}/${width}: ${stripAnsi(line)}`);
        const text=frame.lines.map(stripAnsi);
        // The selected session's id is on the page whole, maybe across lines, never cut.
        const id=sessions[selected].id;
        const command=text.slice(text.findIndex(line=>line.startsWith('$ codex resume')));
        assert.ok(command.length,`${lang}/${width}: the command`);
        assert.equal(command.join('').replace(/^\$ codex resume/,'').replace(/\s+/g,'').slice(0,id.length),id,`${lang}/${width}: ${command.join('|')}`);
        // This session's mark and each age stay whole; the date gives way first.
        const marked=frame.rows[0].text;
        assert.match(marked,lang==='en' ? /this session$/ : /当前会话$/);
        assert.match(frame.rows[1].text,lang==='en' ? /3h ago/ : /3h前/);
        // Nothing to inspect, read or pin: Close is the only action, and Enter asks for nothing.
        assert.deepEqual(frame.controls.filter(c=>c.action.type!=='row' && c.action.type!=='tab').map(c=>c.action.type),['close']);
        assert.equal(handleActivityHubInput(frame.state,{type:'key',key:'enter'} as never,frame).action,undefined);
      }
    } finally {setLanguage(previous);}
  }
  const wide=renderActivityHub(a.view(),initialActivityHubState('sessions'),80,18,NOW,sessions).lines.map(stripAnsi);
  assert.ok(wide.some(line=>line.includes('$ codex resume 019bc10d-c89d-7352-935c-76b351384357')),'wide: one line');
  assert.ok(wide.some(line=>/\d\d-\d\d \d\d:\d\d · 1m ago · Fix parser recovery · this session/.test(line)),wide.join('\n'));
  // None: says so, in a fact.
  const none=renderActivityHub(a.view(),initialActivityHubState('sessions'),48,12,NOW,[]).lines.map(stripAnsi);
  assert.ok(none.some(line=>line.startsWith('No session started here in the last 7 days')));
  // Tab walks into Sessions after Find; ← from the Inbox still reaches History.
  const find=renderActivityHub(a.view(),initialActivityHubState('find'),48,12,NOW);
  assert.equal(handleActivityHubInput({...find.state,querying:false},{type:'key',key:'tab'} as never,find).state.tab,'sessions');
  const inbox=renderActivityHub(a.view(),initialActivityHubState('inbox'),48,12,NOW);
  assert.equal(handleActivityHubInput(inbox.state,{type:'key',key:'left'} as never,inbox).state.tab,'history');
});
