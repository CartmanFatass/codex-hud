import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MonitorState, initialMonitorState, renderMonitor, handleMonitorInput, monitorItemAt, worktreeLabel, monitorPreferences, monitorModes, canMonitorDiff } from '../../src/render/monitor.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import { defaultSettings, loadSettings, saveSettings } from '../../src/settings.js';
import { SETTING_ROWS, renderSettingsPage, handleSettingsInput } from '../../src/render/settings-page.js';
import { stripAnsi, visualLength, colors, theme } from '../../src/render/colors.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { MODEL_GLYPHS, EFFORT_GLYPHS } from '../../src/render/model-glyphs.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';
import type { WorktreesSnapshot } from '../../src/collectors/worktrees.js';
const now = Date.parse('2026-09-16T10:00:00Z');
const root = '00000000-0000-4000-8000-000000000001';
const make = (id:string,name:string,status:SubagentTreeNode['status']):SubagentTreeNode => ({id,name,status,depth:1,children:[],startedAt:new Date(now-120_000),turnStartedAt:new Date(now-30_000),lastEventAt:new Date(now-1000)});
const nodes = [make('00000000-0000-4000-8000-000000000002','Hegel','completed'),make('00000000-0000-4000-8000-000000000003','Pasteur','completed')];
const tree: SubagentTree = {rootId:root,nodes,totalCount:nodes.length,updatedAt:new Date(now)};
const worktrees: WorktreesSnapshot = {sourcePath:'/demo',updatedAt:now,entries:[
  {path:'/demo/main',branch:'main',bare:false,detached:false,observedAt:now,status:{changed:3,staged:1,unstaged:2,untracked:0,conflicts:0,branch:'main',ahead:0,behind:0}},
  {path:'/demo/docs',branch:'docs',bare:false,detached:false,observedAt:now,status:{changed:0,staged:0,unstaged:0,untracked:0,conflicts:0,branch:'docs',ahead:null,behind:null}},
]};
const key=(key:string)=>({type:'key' as const,key});
const mouse=(x:number,y:number)=>({type:'mouse' as const,button:'left' as const,x,y});
// Most layout tests exercise Agents beside an open Worktrees box, which is no
// longer the default: open it explicitly.
const withWorktrees=()=>{const state=initialMonitorState();state.modes.worktrees='open';return state;};
const draw=(state=withWorktrees(),width=30,height=28)=>renderMonitor({tree,worktrees,state,width,height,nowMs:now});

test('the default monitor is Agents alone, one row per agent, and no narratives',()=>{
  const loud={...tree,nodes:nodes.map(n=>({...n,task:'SHOULD_NOT_SHOW_TASK',lastReport:{text:'SHOULD_NOT_SHOW_REPLY'.repeat(400),kind:'reply' as const,at:new Date(now)}}))};
  for(const width of [16,20,30,45,70]){
    const frame=renderMonitor({tree:loud,worktrees,state:initialMonitorState(),width,height:28,nowMs:now});
    assert.deepEqual(frame.panes.map(p=>p.id),['agents']);
    assert.equal(frame.panes[0].rows.filter(row=>row.item).length,2);
    assert.doesNotMatch(stripAnsi(frame.lines.join('\n')),/SHOULD_NOT_SHOW|Reply|Task|Reports|Checks/);
  }
});

test('agent rows use model/effort glyphs, not full model names or effort words',()=>{
  setDisplayConfig({glyphs:'both'});
  const named={...tree,nodes:[{...nodes[0],model:'gpt-5.4-astra',effort:'high'},{...nodes[1],model:'gpt-5.4-astra',effort:'high'}]};
  for (const width of [20,30,45]) {
    const frame=renderMonitor({tree:named,worktrees,state:initialMonitorState(),width,height:24,nowMs:now});
    const text=stripAnsi(frame.lines.join('\n'));
    assert.match(text, new RegExp(MODEL_GLYPHS.astra));
    assert.match(text, new RegExp(EFFORT_GLYPHS.high));
    assert.doesNotMatch(text,/gpt-5\.4-astra|Model unknown|Effort unknown/);
    if (width < 40) assert.doesNotMatch(text,/\bAstra\b|\bhigh\b/);
  }
  let state=initialMonitorState();state.modes.details='open';state.focus='details';
  const inspect=stripAnsi(renderMonitor({tree:named,worktrees,state,width:45,height:32,nowMs:now}).lines.join('\n'));
  assert.match(inspect, new RegExp(MODEL_GLYPHS.astra));
  assert.doesNotMatch(inspect,/Model unknown|Effort unknown|gpt-5\.4-astra/);
  setDisplayConfig({glyphs:'both',theme:'terminal'});
});

test('open panes fill the tree column; folded panes stay one row',()=>{
  const frame=draw();
  const bottom=frame.panes.reduce((a,b)=>a.y+a.height>=b.y+b.height?a:b);
  assert.equal(bottom.y+bottom.height,27);
  assert.ok(frame.panes[0].height>=5);
  let state=initialMonitorState();
  state.modes={agents:'open',worktrees:'open',changes:'open',details:'open'};
  const git={root:'/demo/main',branch:'main',ahead:0,behind:0,files:[{path:'a.ts',index:' ',worktree:'M',added:1,removed:0,binary:false,conflict:false}]};
  const four=renderMonitor({tree,worktrees,git,state,width:30,height:28,nowMs:now});
  assert.equal(four.panes.length,4);
  assert.equal(four.panes.reduce((a,b)=>a.y+a.height>=b.y+b.height?a:b).y+four.panes.reduce((a,b)=>a.y+a.height>=b.y+b.height?a:b).height,27);
  state=withWorktrees();state.modes.worktrees='folded';
  const folded=draw(state);
  assert.equal(folded.panes[1].height,1);
  assert.equal(folded.panes[0].y+folded.panes[0].height,26,'Agents takes the room the folded box gave up');
  state=withWorktrees();state.modes.agents='folded';
  assert.ok(draw(state).panes[0].height>1,'Agents cannot be folded');
});

test('width, height and margins remain bounded with CJK and terminal controls',()=>{
  const malicious={...tree,nodes:[make(nodes[0].id,'中文\x1b[2J\n\t\u202e😀long','unknown')]};
  for(const theme of ['terminal','none','mocha','latte'] as const){
    setDisplayConfig({theme});
    for(const width of [1,5,10,16,20,30,45,70])for(const height of [1,2,4,8,16,24,40]){
      const frame=renderMonitor({tree:malicious,worktrees,state:initialMonitorState(),width,height,nowMs:now,notice:'View is blocked. No keys sent.'});
      assert.equal(frame.lines.length,height);
      assert.ok(frame.lines.every(line=>visualLength(line)<=width));
      assert.doesNotMatch(frame.lines.join(''),/\x1b\[2J|\u202e/);
      assert.ok(frame.lines.every(line=>!line.includes('\n')));
      for(const p of frame.panes)assert.ok(p.y+p.height<=height-1);
      // At 24 columns and up a pane is a box. Below that the side borders are
      // two columns the content needs more, so rows run edge to edge.
      if(width>=16)for(const p of frame.panes)for(let y=p.y+1;y<p.y+p.height-1;y++){
        const line=stripAnsi(frame.lines[y]);
        if(width<24){assert.ok(!line.startsWith('│'));assert.ok(visualLength(frame.lines[y])<=width);}
        else if(p.id!=='agents'){assert.ok(line.startsWith('│ '));assert.ok(line.endsWith(' │'));}
        else assert.ok(!line.startsWith('│'),'Agents has no frame');
      }
    }
  }
  setDisplayConfig({theme:'terminal'});
});

test('a box closes and folds; Agents does neither; Tab skips closed panes',()=>{
  let frame=draw();let state:MonitorState={...frame.state,focus:'worktrees'};
  state=handleMonitorInput(state,key('pane-fold'),{tree,worktrees,frame}).state;
  frame=draw(state);assert.equal(frame.panes[1].height,1);
  state=handleMonitorInput(frame.state,key('pane-close'),{tree,worktrees,frame}).state;
  frame=draw(state);assert.deepEqual(frame.panes.map(p=>p.id),['agents']);
  for(const k of ['pane-close','pane-fold']){
    const kept=handleMonitorInput({...frame.state,focus:'agents'},key(k),{tree,worktrees,frame}).state;
    assert.equal(kept.modes.agents,'open');assert.deepEqual(draw(kept).panes.map(p=>p.id),['agents']);
  }
  state=handleMonitorInput(frame.state,key('tab'),{tree,worktrees,frame}).state;assert.equal(state.focus,'agents');
  state=handleMonitorInput(state,key('worktrees'),{tree,worktrees,frame}).state;
  assert.equal(state.modes.worktrees,'open');assert.equal(state.focus,'worktrees');
});

test('Agents stays even when every setting says closed, and has no fold or close buttons',()=>{
  const state=initialMonitorState();state.modes={agents:'closed',worktrees:'closed',changes:'closed',details:'closed'};
  const frame=draw(state);
  assert.deepEqual(frame.panes.map(p=>p.id),['agents']);
  assert.equal(frame.controls.filter(c=>c.pane==='agents').length,0);
  assert.equal(frame.controls.filter(c=>c.kind==='main').length,1);
  assert.equal(frame.controls.filter(c=>c.kind==='settings').length,1);
  assert.equal(monitorModes({...defaultSettings(),agentsPane:'closed'}).agents,'open');
});

test('the full pinned Main row targets the root UUID, not the selected agent',()=>{
  const frame=draw();
  for(const x of [0,5,15,29])assert.deepEqual(handleMonitorInput(frame.state,mouse(x,0),{tree,worktrees,frame}).action,{type:'switch',id:root});
  assert.deepEqual(handleMonitorInput(frame.state,key('main'),{tree,worktrees,frame}).action,{type:'switch',id:root});
});

test('only visible agent rows navigate; the summary and empty space do not',()=>{
  const frame=draw();const pane=frame.panes[0];
  assert.equal(pane.edge,0);
  const first=pane.rows.find(row=>row.item)!.item!;
  // Unframed: the summary is the pane's first line, the first agent its second.
  assert.deepEqual(handleMonitorInput(frame.state,mouse(3,pane.y+1),{tree,worktrees,frame}).action,{type:'switch',id:first});
  assert.deepEqual(handleMonitorInput(frame.state,mouse(0,pane.y+1),{tree,worktrees,frame}).action,{type:'switch',id:first});
  assert.equal(handleMonitorInput(frame.state,mouse(3,pane.y),{tree,worktrees,frame}).action,undefined);
  assert.equal(handleMonitorInput(frame.state,mouse(3,pane.y+pane.height-1),{tree,worktrees,frame}).action,undefined);
});

test('x on a box is not fold and its hit target cannot trigger navigation',()=>{
  const frame=draw();const close=frame.controls.find(c=>c.kind==='close'&&c.pane==='worktrees')!;
  const result=handleMonitorInput(frame.state,mouse(close.x+1,close.y),{tree,worktrees,frame});
  assert.equal(result.action,undefined);assert.equal(result.state.modes.worktrees,'closed');assert.equal(draw(result.state).panes.some(p=>p.id==='worktrees'),false);
});

test('keyboard motion only previews; Inspector remains closed until explicitly opened',()=>{
  const frame=draw();const next=handleMonitorInput(frame.state,key('down'),{tree,worktrees,frame});
  assert.equal(next.action,undefined);assert.notEqual(next.state.tree.selectedId,frame.state.tree.selectedId);
  assert.equal(next.state.modes.details,'closed');
  const inspect=handleMonitorInput(next.state,key('enter'),{tree,worktrees,frame});assert.equal(inspect.action,undefined);assert.equal(inspect.state.modes.details,'open');
  const opened=handleMonitorInput(next.state,key('open-session'),{tree,worktrees,frame});assert.deepEqual(opened.action,{type:'switch',id:next.state.tree.selectedId});
});

test('worktree clicks preview Git scope without switching sessions or claiming agent ownership',()=>{
  const frame=draw();const pane=frame.panes.find(p=>p.id==='worktrees')!;
  const result=handleMonitorInput(frame.state,mouse(4,pane.y+pane.rows.findIndex(r=>r.item==='/demo/docs')+1),{tree,worktrees,frame});
  assert.equal(result.action,undefined);assert.equal(result.state.selectedWorktree,'/demo/docs');
  assert.equal(result.state.tree.selectedId,frame.state.tree.selectedId);assert.equal(result.state.preview,'worktree');
});

test('same worktree maps to both identity rows',()=>{
  const pane=draw().panes.find(p=>p.id==='worktrees')!;
  assert.equal(monitorItemAt(pane,3,pane.y+1),'/demo/main');assert.equal(monitorItemAt(pane,3,pane.y+2),'/demo/main');
});

test('stale, unknown, prunable, and failed reads are never displayed as clean',()=>{
  const base=worktrees.entries[1];
  assert.equal(worktreeLabel(base,now),'clean');
  assert.equal(worktreeLabel({...base,observedAt:now-31000},now),'stale');
  assert.equal(worktreeLabel({...base,status:undefined},now),'?');
  assert.equal(worktreeLabel({...base,error:'timeout'},now),'unreadable');
  assert.equal(worktreeLabel({...base,prunable:''},now),'prunable');
});

test('state identity and sibling ordering are independent of freshness/reply text',()=>{
  const frame=draw();const selected=frame.state.tree.selectedId;
  const refreshed={...tree,nodes:tree.nodes.map(n=>({...n,lastEventAt:new Date(now+60000)}))};
  const after=renderMonitor({tree:refreshed,worktrees,state:frame.state,width:30,height:28,nowMs:now});
  assert.equal(after.state.tree.selectedId,selected);assert.deepEqual(after.panes[0].rows.map(r=>r.item),frame.panes[0].rows.map(r=>r.item));
});

test('narrow Changes exposes selectable files and opens a readable zoomed preview',()=>{
  const git={root:'/demo/main',branch:'main',ahead:0,behind:0,files:['a','b'].map(path=>({path,index:' ',worktree:'M',added:1,removed:0,binary:false,conflict:false}))};
  let state=initialMonitorState();state.modes.changes='open';state.focus='changes';state.selectedFile='a';
  const frame=renderMonitor({tree,worktrees,git,state,width:30,height:30,nowMs:now});
  assert.equal(frame.panes.find(p=>p.id==='changes')!.rows.some(r=>r.item),true);
  const moved=handleMonitorInput(frame.state,key('down'),{tree,git,worktrees,frame}).state;
  assert.equal(moved.selectedFile,'b');
  assert.equal(canMonitorDiff(frame),false);
  const opened=handleMonitorInput(moved,key('enter'),{tree,git,worktrees,frame}).state;
  assert.equal(opened.zoom,true);
  const preview=renderMonitor({tree,worktrees,git,state:opened,width:30,height:24,nowMs:now,diff:['-old','+new']});
  assert.equal(canMonitorDiff(preview),true);
  assert.deepEqual(preview.panes.map(p=>p.id),['details']);
  assert.match(stripAnsi(preview.lines.join('\n')),/\+new/);
  assert.equal(handleMonitorInput(preview.state,key('escape'),{tree,git,worktrees,frame:preview}).state.zoom,false);
});

test('monitor key profile maps numbers without changing legacy decoder behavior',()=>{
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('1234x-')),['agents','worktrees','changes','details','pane-close','pane-fold'].map(key));
  assert.deepEqual(new WorkbenchInputDecoder().push(Buffer.from('24')),['details','activity'].map(key));
});

test('monitor visibility persists independently from legacy open Reports/Changes settings',()=>{
  const home=mkdtempSync(join(tmpdir(),'hud-monitor-settings-'));const old=process.env.CODEX_HUD_SETTINGS_PATH;
  process.env.CODEX_HUD_SETTINGS_PATH=join(home,'hud-settings.json');
  try{
    const settings=saveSettings({details:true,changes:true,activity:true});
    assert.deepEqual(monitorModes(settings),initialMonitorState().modes);
    let state=initialMonitorState();state.modes.changes='open';state.modes.worktrees='folded';
    saveSettings(monitorPreferences(state));assert.deepEqual(monitorModes(loadSettings()),state.modes);
    assert.equal(loadSettings().details,true);
  }finally{if(old===undefined)delete process.env.CODEX_HUD_SETTINGS_PATH;else process.env.CODEX_HUD_SETTINGS_PATH=old;rmSync(home,{recursive:true,force:true});}
});

test('Settings exposes open/folded/closed for each box, not for Agents, and omits Checks',()=>{
  assert.equal(SETTING_ROWS.some(r=>r.key==='activity'),false);
  assert.equal(SETTING_ROWS.some(r=>r.key==='agentsPane'),false);
  const row=SETTING_ROWS.findIndex(r=>r.key==='worktreesPane');assert.ok(row>=0);
  let state={draft:defaultSettings(),selected:row,offset:0,message:''};
  const frame=renderSettingsPage(state,40,30);
  state=handleSettingsInput(state,key('right'),frame).state;assert.equal(state.draft.worktreesPane,'open');
  state=handleSettingsInput(state,key('right'),frame).state;assert.equal(state.draft.worktreesPane,'folded');
});


test('page movement counts distinct worktree cards rather than their directory continuation lines',()=>{
  const many={...worktrees,entries:Array.from({length:12},(_,i)=>({...worktrees.entries[0],path:'/worktrees/'+i,branch:'branch'+i}))};
  const state={...withWorktrees(),focus:'worktrees' as const};
  const frame=renderMonitor({tree,worktrees:many,state,width:30,height:18,nowMs:now});
  const pane=frame.panes.find(p=>p.id==='worktrees')!;
  const count=new Set(pane.rows.slice(pane.offset,pane.offset+pane.height-2).map(r=>r.item).filter(Boolean)).size;
  const next=handleMonitorInput(frame.state,key('page-down'),{tree,worktrees:many,frame});
  assert.equal(next.state.selectedWorktree,many.entries[count].path);
  assert.equal(next.action,undefined);
});

test('conflicts precede file counts even in narrow optional Changes',()=>{
  const state=initialMonitorState();state.modes.changes='open';
  const git={root:'/demo/main',branch:'main',ahead:0,behind:0,files:[{path:'conflict',index:'U',worktree:'U',added:null,removed:null,binary:false,conflict:true}]};
  const frame=renderMonitor({tree,worktrees,git,state,width:20,height:30,nowMs:now});
  assert.match(stripAnsi(frame.panes.find(p=>p.id==='changes')!.rows[0].text),/! 1 conflicts/);
});

test('malformed dates remain unknown rather than crashing the inspector',()=>{
  const state=initialMonitorState();state.modes.details='open';state.focus='details';
  const malformed={...tree,nodes:[{...nodes[0],turnStartedAt:new Date('invalid')}]};
  const frame=renderMonitor({tree:malformed,worktrees,state,width:45,height:32,nowMs:now});
  assert.match(frame.panes.find(p=>p.id==='details')!.rows.map(r=>stripAnsi(r.text)).join(' '),/Turn age: \?/);
  const more=handleMonitorInput(frame.state,key('detail-toggle'),{tree:malformed,worktrees,frame}).state;
  const expanded=renderMonitor({tree:malformed,worktrees,state:more,width:45,height:32,nowMs:now});
  assert.match(expanded.panes.find(p=>p.id==='details')!.rows.map(r=>stripAnsi(r.text)).join(' '),/Turn start: unknown/);
});

test('long agent names keep model glyphs, and the selection is a marker rather than a highlight',()=>{
  const previous=setDisplayConfig({theme:'terminal',glyphs:'both'});
  try {
    const named={...tree,nodes:[{...nodes[0],name:'context-parser-reviewer-long-name',model:'gpt-5.6-astra',effort:'high'}]};
    for(const width of [16,20,30]){
      const frame=renderMonitor({tree:named,state:initialMonitorState(),width,height:24,nowMs:now});
      const row=frame.lines.find(line=>stripAnsi(line).includes('☀'))!;
      assert.ok(!row.includes('\x1b[7m'),'inverse video hid the row colours');
      assert.ok(row.includes(theme.accent('›')));
      assert.match(stripAnsi(row),/☀◕/);
      assert.match(stripAnsi(row),/›/);
      assert.ok(visualLength(row)<=width);
    }
  } finally {setDisplayConfig(previous);}
});

test('Inspector paints internal tokens without escaping ANSI and still sanitizes external fields',()=>{
  const previous=setDisplayConfig({glyphs:'both'});
  try {
    for(const theme of ['terminal','mocha','latte','none'] as const){
      setDisplayConfig({theme});
      const named={...tree,nodes:[{...nodes[0],model:'gpt-5.6-astra',effort:'high'}]};
      const state=initialMonitorState();state.focus='details';state.modes.details='open';
      const frame=renderMonitor({tree:named,state,width:45,height:24,nowMs:now});
      const text=frame.panes.find(p=>p.id==='details')!.rows.map(r=>r.text).join('\n');
      assert.doesNotMatch(text,/\\x1b/);
      assert.match(stripAnsi(text),/☀◕/);
      assert.doesNotMatch(stripAnsi(text),/UUID:|Turn start:/);
      const malicious={...named,nodes:[{...named.nodes[0],name:'bad\x1b[2Jname',model:'custom\x1b[2J'}]};
      const safe=renderMonitor({tree:malicious,state,width:45,height:24,nowMs:now}).lines.join('\n');
      assert.doesNotMatch(safe,/\x1b\[2J/);
      assert.match(safe,/\\x1b\[2J/);
    }
  } finally {setDisplayConfig(previous);}
});

test('short help pages wrap and scroll to the complete model legend',()=>{
  let state=initialMonitorState();state.help=true;
  let frame=draw(state,16,12);
  assert.ok(frame.helpPage!.total>frame.helpPage!.count);
  const start=frame.lines.join('\n');
  state=handleMonitorInput(frame.state,key('end'),{tree,worktrees,frame}).state;
  frame=draw(state,16,12);
  assert.notEqual(frame.lines.join('\n'),start);
  assert.match(stripAnsi(frame.lines.join('\n')),/ultra/);
  assert.ok(frame.lines.every(line=>visualLength(line)<=16));
  assert.equal(handleMonitorInput(frame.state,key('escape'),{tree,worktrees,frame}).state.help,false);
});

test('worktree panels shrink to their content while Agents receives spare height',()=>{
  const frame=draw();
  const wt=frame.panes.find(p=>p.id==='worktrees')!;
  assert.equal(wt.height,wt.rows.length+2);
  assert.ok(frame.panes[0].height>frame.panes[0].rows.length+2);
});

test('an agent shows its own context fill where the row can carry it, and nothing where it cannot',()=>{
  const previous=setDisplayConfig({theme:'terminal',glyphs:'both'});
  try {
    const measured:SubagentTreeNode={...nodes[0],contextUsage:{used:114240,total:260000,percent:42,
      inputTokens:68544,outputTokens:22848,cachedTokens:22848,compactCount:0}};
    const unmeasured=nodes[1];
    const named={...tree,nodes:[measured,unmeasured]};

    for(const width of [30,45,70]){
      const frame=renderMonitor({tree:named,worktrees,state:initialMonitorState(),width,height:28,nowMs:now});
      const agents=frame.panes.find(p=>p.id==='agents')!;
      const measuredRow=agents.rows.find(r=>r.item===measured.id)!.text;
      const unmeasuredRow=stripAnsi(agents.rows.find(r=>r.item===unmeasured.id)!.text);
      assert.match(stripAnsi(measuredRow),/━╸─/,`width ${width}: 42% of three cells is two and a half halves, rounded up`);
      assert.ok(measuredRow.includes(theme.contextSafe('━╸')),'the used part takes the context colour');
      assert.doesNotMatch(stripAnsi(measuredRow),/%/,'the row draws the fill rather than printing it');
      assert.doesNotMatch(unmeasuredRow,/[━╸─]/,'an agent with no report shows nothing, not an empty meter');
      assert.ok(frame.lines.every(line=>visualLength(line)<=width),`width ${width} overflowed`);
    }

    // In a narrower pane the badge and the name are worth more than the meter.
    // Agents has no frame, so a 26-column pane already has room for it.
    for(const width of [16,20,24]){
      const frame=renderMonitor({tree:named,worktrees,state:initialMonitorState(),width,height:28,nowMs:now});
      const agents=frame.panes.find(p=>p.id==='agents')!;
      assert.doesNotMatch(stripAnsi(agents.rows.find(r=>r.item===measured.id)!.text),/[━╸]/);
      assert.ok(frame.lines.every(line=>visualLength(line)<=width),`width ${width} overflowed`);
    }

    // The Inspector spells it out, in the same shape the compact bar uses.
    const inspect=(shown:SubagentTreeNode[])=>{
      const state=initialMonitorState();state.modes.details='open';state.focus='details';
      return stripAnsi(renderMonitor({tree:{...tree,nodes:shown},worktrees,state,width:45,height:32,nowMs:now})
        .panes.find(p=>p.id==='details')!.rows.map(r=>r.text).join('\n'));
    };
    assert.match(inspect([measured]),/Ctx 42% \(114\.2K\/260K\)/);
    assert.doesNotMatch(inspect([unmeasured]),/Ctx/,'no report, no line');
  } finally {setDisplayConfig(previous);}
});

test('the agents summary counts what the linger window hid, and a click or a brings it back',()=>{
  const finished:SubagentTree={...tree,nodes:[{...nodes[0],statusAt:new Date(now-600_000)},{...nodes[1],status:'running'}]};
  let state=initialMonitorState();state.tree.lingerMs=180_000;
  let frame=renderMonitor({tree:finished,worktrees,state,width:30,height:28,nowMs:now});
  let pane=frame.panes[0];
  assert.deepEqual(pane.rows.filter(r=>r.item).map(r=>r.item),[nodes[1].id]);
  assert.match(stripAnsi(pane.rows[0].text),/\+1 older/);
  const ctx={tree:finished,worktrees,frame,nowMs:now};
  const shown=handleMonitorInput(frame.state,mouse(3,pane.y),ctx);
  assert.equal(shown.action,undefined,'the summary is a toggle, not a session switch');
  assert.equal(shown.state.tree.showAll,true);
  frame=renderMonitor({tree:finished,worktrees,state:shown.state,width:30,height:28,nowMs:now});
  pane=frame.panes[0];
  assert.equal(pane.rows.filter(r=>r.item).length,2);
  assert.match(stripAnsi(pane.rows[0].text),/hide old/);
  assert.equal(handleMonitorInput(frame.state,key('show-all'),{...ctx,frame}).state.tree.showAll,false);
  // A finished row carries no clock; it recedes once its finish is old news.
  const oldRow=pane.rows.find(r=>r.item===nodes[0].id)!.text;
  assert.doesNotMatch(stripAnsi(oldRow),/\d+[smh]\b/);
  assert.ok(oldRow.includes(colors.dim('Hegel')));
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('a')),[key('show-all')]);
  // Counts that are zero stay out of the summary.
  const allDone:SubagentTree={...tree,nodes:[{...nodes[0],status:'completed',statusAt:new Date(now-1000)}]};
  const summary=stripAnsi(renderMonitor({tree:allDone,worktrees,state:initialMonitorState(),width:30,height:28,nowMs:now}).panes[0].rows[0].text);
  assert.match(summary,/✓1 done/);
  assert.doesNotMatch(summary,/run|failed|unknown/);
});

test('a running row shows its turn length as a clock face, and a quiet agent in the warning colour',()=>{
  const previous=setDisplayConfig({theme:'terminal',glyphs:'glyph'});
  try {
    const running=(id:string,name:string,turnMs:number,quietMs=1000):SubagentTreeNode=>({...make(id,name,'running'),
      turnStartedAt:new Date(now-turnMs),lastEventAt:new Date(now-quietMs)});
    const agents=[running('00000000-0000-4000-8000-00000000000a','a',30_000),running('00000000-0000-4000-8000-00000000000b','b',3*60_000),
      running('00000000-0000-4000-8000-00000000000c','c',10*60_000),running('00000000-0000-4000-8000-00000000000d','d',30*60_000),
      running('00000000-0000-4000-8000-00000000000e','e',50*60_000),running('00000000-0000-4000-8000-000000000010','g',2*3600_000),
      running('00000000-0000-4000-8000-00000000000f','f',20*60_000,6*60_000)];
    const frame=renderMonitor({tree:{...tree,nodes:agents},state:initialMonitorState(),width:30,height:28,nowMs:now});
    const row=(id:string)=>frame.panes[0].rows.find(r=>r.item===id)!.text;
    const bars=agents.map(a=>stripAnsi(row(a.id)).trimEnd().at(-1));
    // Under a minute, then the quarter of the hour the hand has reached, then past the hour.
    assert.deepEqual(bars,['◌','◷','◷','◵','◴','◉','◶']);
    for(const a of agents)assert.doesNotMatch(stripAnsi(row(a.id)),/\d+[smh]\b/,'no number on the row');
    assert.ok(row(agents[3].id).includes(theme.info('◵')));
    assert.ok(row(agents[6].id).includes(theme.warning('◶')),'quiet for 5m+ turns the clock to the warning colour');
  } finally {setDisplayConfig(previous);}
});

test('a name too long for its row keeps both ends, so siblings stay apart',()=>{
  const a={...make('00000000-0000-4000-8000-0000000000a1','b05_result_review_package','completed'),statusAt:new Date(now)};
  const b={...make('00000000-0000-4000-8000-0000000000a2','b05_result_diagnosis_package','completed'),statusAt:new Date(now)};
  for(const width of [20,30]){
    const rows=renderMonitor({tree:{...tree,nodes:[a,b]},state:initialMonitorState(),width,height:20,nowMs:now}).panes[0].rows;
    const [ra,rb]=[a,b].map(n=>stripAnsi(rows.find(r=>r.item===n.id)!.text));
    assert.match(ra,/b05.*…/);assert.match(rb,/b05.*…/);
    assert.notEqual(ra.replace(/\s+/g,' '),rb.replace(/\s+/g,' '));
    assert.match(ra,/package|kage|age/,'the end of the name survives');
  }
});

test('the Inspector shows what the agent last said, labelled as such, and v More shows the rest',()=>{
  const said='First sentence about the work. '.repeat(20)+'THE_END';
  const agent={...make(nodes[0].id,'reviewer','running'),turnStartedAt:new Date(now-60_000),
    lastReport:{text:said,kind:'update' as const,at:new Date(now-30_000)},task:'Review the package'};
  const inspect=(expanded:boolean)=>{
    const state=initialMonitorState();state.modes.details='open';state.focus='details';state.expanded=expanded;
    return renderMonitor({tree:{...tree,nodes:[agent]},worktrees,state,width:30,height:60,nowMs:now})
      .panes.find(p=>p.id==='details')!.rows.map(r=>stripAnsi(r.text));
  };
  const short=inspect(false);
  assert.ok(short.includes('Latest update · 30s ago'));
  assert.match(short.join('\n'),/First sentence/);
  assert.ok(short.some(line=>line.endsWith(' …')),'a long update is cut and says so');
  assert.doesNotMatch(short.join('\n'),/THE_END|Review the package/);
  assert.ok(short.every(line=>visualLength(line)<=30));
  const full=inspect(true).join('\n');
  assert.match(full,/THE_END/);
  assert.match(full,/Task\nReview the package/);
  const prior={...agent,lastReport:{...agent.lastReport,at:new Date(now-120_000)}};
  const state=initialMonitorState();state.modes.details='open';state.focus='details';
  assert.match(stripAnsi(renderMonitor({tree:{...tree,nodes:[prior]},worktrees,state,width:30,height:60,nowMs:now}).lines.join('\n')),/Previous turn · 2m ago/);
});
