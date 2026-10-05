import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MonitorState, initialMonitorState, renderMonitor, handleMonitorInput, monitorItemAt, worktreeLabel, monitorPreferences, monitorModes, canMonitorDiff } from '../../src/render/monitor.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import { defaultSettings, loadSettings, saveSettings } from '../../src/settings.js';
import { SETTING_ROWS, renderSettingsPage, handleSettingsInput } from '../../src/render/settings-page.js';
import { stripAnsi, visualLength, colors, theme } from '../../src/render/colors.js';
import { setDisplayConfig, LOOKS } from '../../src/render/hud-config.js';
import { MODEL_GLYPHS, EFFORT_GLYPHS } from '../../src/render/model-glyphs.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';
import type { WorktreesSnapshot } from '../../src/collectors/worktrees.js';
const now = Date.parse('2026-09-16T10:00:00Z');
const root = '00000000-0000-4000-8000-000000000001';
const make = (id:string,name:string,status:SubagentTreeNode['status']):SubagentTreeNode => ({id,name,status,depth:1,children:[],startedAt:new Date(now-120_000),turnStartedAt:new Date(now-30_000),lastEventAt:new Date(now-1000)});
const nodes = [make('00000000-0000-4000-8000-000000000002','Hegel','completed'),make('00000000-0000-4000-8000-000000000003','Pasteur','completed')];
const tree: SubagentTree = {rootId:root,nodes,totalCount:nodes.length,updatedAt:new Date(now)};
const worktrees: WorktreesSnapshot = {sourcePath:'/demo',updatedAt:now,entries:[
  {path:'/demo/main',branch:'main',subject:'Main work',bare:false,detached:false,observedAt:now,status:{changed:3,staged:1,unstaged:2,untracked:0,conflicts:0,branch:'main',ahead:0,behind:0}},
  {path:'/demo/docs',branch:'docs',subject:'Docs work',bare:false,detached:false,observedAt:now,status:{changed:0,staged:0,unstaged:0,untracked:0,conflicts:0,branch:'docs',ahead:null,behind:null}},
]};
const key=(key:string)=>({type:'key' as const,key});
const mouse=(x:number,y:number)=>({type:'mouse' as const,button:'left' as const,x,y});
// Most layout tests exercise Agents beside an open Worktrees box, which is no
// longer the default: open it explicitly.
const withWorktrees=()=>{const state=initialMonitorState();state.modes.worktrees='open';return state;};
const draw=(state=withWorktrees(),width=30,height=28)=>renderMonitor({tree,worktrees,state,width,height,nowMs:now});

test('the default monitor is Agents alone, one row per agent, the selected one with a line on how far it got, and no narratives',()=>{
  const loud={...tree,nodes:nodes.map(n=>({...n,task:'TASK_TEXT',lastReport:{text:'SHOULD_NOT_SHOW_REPLY'.repeat(400),kind:'reply' as const,at:new Date(now)}}))};
  for(const width of [16,20,30,45,70]){
    const frame=renderMonitor({tree:loud,worktrees,state:initialMonitorState(),width,height:28,nowMs:now});
    assert.deepEqual(frame.panes.map(p=>p.id),['agents']);
    const rows=frame.panes[0].rows.filter(row=>row.item);
    assert.equal(new Set(rows.map(row=>row.item)).size,2);
    assert.equal(rows.length,3,'the selected row has its second line, the other none');
    const text=stripAnsi(frame.lines.join('\n'));
    assert.doesNotMatch(text,/SHOULD_NOT_SHOW|Reply|Task|Reports|Checks/,'with no log, no agent words: the task says what it was for');
    assert.equal(text.match(/TASK_TE/g)?.length,1);
  }
});

test('agent rows use model/effort glyphs, not full model names or effort words; the Inspector names them beside the glyphs',()=>{
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
  assert.match(inspect, new RegExp(`│ ${MODEL_GLYPHS.astra}${EFFORT_GLYPHS.high} gpt-5\\.4-astra · high`));
  assert.doesNotMatch(inspect,/Model unknown|Effort unknown/);
  setDisplayConfig({glyphs:'text'});
  assert.match(stripAnsi(renderMonitor({tree:named,worktrees,state,width:45,height:32,nowMs:now}).lines.join('\n')),/│ gpt-5\.4-astra · high/,'glyphs off: the words alone');
  setDisplayConfig({glyphs:'both'});
  setDisplayConfig({glyphs:'both',theme:'terminal'});
});

test('open panes fill the tree column; a closed pane takes no row',()=>{
  const frame=draw();
  const bottom=frame.panes.reduce((a,b)=>a.y+a.height>=b.y+b.height?a:b);
  assert.equal(bottom.y+bottom.height,28,'with no status card, the panes reach the foot');
  assert.ok(frame.panes[0].height>=5);
  let state=initialMonitorState();
  state.modes={agents:'open',worktrees:'open',changes:'open',details:'open',timeline:'closed'};
  const git={root:'/demo/main',branch:'main',ahead:0,behind:0,files:[{path:'a.ts',index:' ',worktree:'M',added:1,removed:0,binary:false,conflict:false}]};
  const four=renderMonitor({tree,worktrees,git,state,width:30,height:28,nowMs:now});
  assert.equal(four.panes.length,4);
  assert.equal(four.panes.reduce((a,b)=>a.y+a.height>=b.y+b.height?a:b).y+four.panes.reduce((a,b)=>a.y+a.height>=b.y+b.height?a:b).height,28);
  state=withWorktrees();state.modes.worktrees='closed';
  const closed=draw(state);
  assert.deepEqual(closed.panes.map(p=>p.id),['agents']);
  assert.equal(closed.panes[0].y+closed.panes[0].height,28,'Agents takes every row the closed pane gave up');
  assert.ok(!closed.lines.map(stripAnsi).some(line=>line.includes('Worktrees')),'no title line is left behind');
  state=withWorktrees();state.modes.agents='closed';
  const alone=draw(state);
  assert.deepEqual(alone.panes.map(p=>p.id),['worktrees']);
  assert.equal(alone.panes[0].y,1,'with the agents closed, the worktrees start under the bar');
  assert.equal(alone.panes[0].y+alone.panes[0].height,28,'and take their room');
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
      for(const p of frame.panes)assert.ok(p.y>=1&&p.y+p.height<=height,'below the bar, inside the panel');
      // A pane's rows sit behind a gutter on the left only: "│ " from 24
      // columns, "│" under that. No right border, no bottom rule.
      if(width>=16)for(const p of frame.panes)for(let y=p.y+1;y<p.y+p.height;y++){
        const line=stripAnsi(frame.lines[y]);
        if(p.id==='agents'){assert.ok(!line.startsWith('│'),'Agents has no gutter');continue;}
        assert.ok(line.startsWith(width<24?'│':'│ '),line);
        assert.ok(!/[│┘└─]\s*$/.test(line.slice(2)),line);
      }
    }
  }
  setDisplayConfig({theme:'terminal'});
});

test('a pane opens and closes, its number toggles it, the agents too; Tab skips closed panes',()=>{
  let frame=draw();let state:MonitorState={...frame.state,focus:'worktrees'};
  state=handleMonitorInput(state,key('pane-close'),{tree,worktrees,frame}).state;
  frame=draw(state);assert.deepEqual(frame.panes.map(p=>p.id),['agents']);assert.equal(state.focus,'agents');
  state=handleMonitorInput(frame.state,key('tab'),{tree,worktrees,frame}).state;assert.equal(state.focus,'agents');
  state=handleMonitorInput(state,key('worktrees'),{tree,worktrees,frame}).state;
  assert.equal(state.modes.worktrees,'open');assert.equal(state.focus,'worktrees');
  state=handleMonitorInput(state,key('worktrees'),{tree,worktrees,frame}).state;
  assert.equal(state.modes.worktrees,'closed','its number again closes it');
  state=handleMonitorInput(state,key('agents'),{tree,worktrees,frame}).state;
  assert.equal(state.modes.agents,'closed');assert.deepEqual(draw(state).panes,[],'every pane closed: the bar and nothing under it');
  for(const k of ['tab','shift-tab','down','page-down','pane-close','zoom'])handleMonitorInput(state,key(k),{tree,worktrees,frame:draw(state)});
  state=handleMonitorInput(state,key('agents'),{tree,worktrees,frame}).state;
  assert.equal(state.modes.agents,'open');assert.equal(state.focus,'agents');
});

test('the agents area closes like any pane, and its setting is kept',()=>{
  const state=initialMonitorState();state.modes={agents:'closed',worktrees:'closed',changes:'closed',details:'closed',timeline:'closed'};
  const frame=draw(state);
  assert.deepEqual(frame.panes.map(p=>p.id),[]);
  assert.equal(monitorModes({...defaultSettings(),agentsPane:'closed'}).agents,'closed');
  assert.equal(frame.controls.filter(c=>c.kind==='main').length,1);
  assert.equal(frame.controls.filter(c=>c.kind==='settings').length,1);
  // A pane saved folded, as earlier versions could, comes back closed.
  const home=mkdtempSync(join(tmpdir(),'hud-monitor-folded-'));const old=process.env.CODEX_HUD_SETTINGS_PATH;
  process.env.CODEX_HUD_SETTINGS_PATH=join(home,'hud-settings.json');
  try{
    writeFileSync(process.env.CODEX_HUD_SETTINGS_PATH,JSON.stringify({agentsPane:'folded',worktreesPane:'folded',changesPane:'open'}));
    const modes=monitorModes(loadSettings());
    assert.equal(modes.agents,'closed');assert.equal(modes.worktrees,'closed');assert.equal(modes.changes,'open');
  }finally{if(old===undefined)delete process.env.CODEX_HUD_SETTINGS_PATH;else process.env.CODEX_HUD_SETTINGS_PATH=old;rmSync(home,{recursive:true,force:true});}
});

test('the control bar: ⌂ targets the root UUID; every column of the row is some button',()=>{
  const frame=draw();
  for(const x of [0,1,2])assert.deepEqual(handleMonitorInput(frame.state,mouse(x,0),{tree,worktrees,frame}).action,{type:'switch',id:root});
  // The focused pane's tab filled, with its word; the actions at the right end.
  assert.equal(stripAnsi(frame.lines[0]),' ⌂  ▦ Agents  ⌥ ± ◫ ≣     ⚙ ? ');
  assert.equal(stripAnsi(draw(withWorktrees(),45).lines[0]),' ⌂  ▦ Agents    ⌥ Trees   ±   ◫   ≣      ⚙ ? ');
  const column=(glyph:string)=>[...stripAnsi(frame.lines[0])].indexOf(glyph);
  assert.equal(handleMonitorInput(frame.state,mouse(29,0),{tree,worktrees,frame}).state.help,true,'the columns after ? are still Help');
  assert.equal(handleMonitorInput(frame.state,mouse(column('?'),0),{tree,worktrees,frame}).state.help,true,'Help opens the help');
  assert.deepEqual(handleMonitorInput(frame.state,mouse(column('⚙'),0),{tree,worktrees,frame}).action,{type:'settings'});
  assert.deepEqual(handleMonitorInput(frame.state,mouse(column('⚙')+1,0),{tree,worktrees,frame}).action,{type:'settings'},'the column beside an icon is its button too');
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

test('a pane\'s button opens or closes it in one click; a click on its band zooms it and restores it',()=>{
  let frame=draw(withWorktrees(),45);const ctx=()=>({tree,worktrees,frame});
  const tab=(pane:string)=>frame.controls.find(c=>c.kind==='tab'&&c.pane===pane)!;
  assert.ok(!frame.controls.some(c=>c.y>0&&(c.kind==='tab'||c.kind==='settings'||c.kind==='help')),'no switch below the bar');
  const box=frame.panes.find(p=>p.id==='worktrees')!;
  // The title: its icon and name on the left, how many on the right; on the band in the band look.
  assert.match(stripAnsi(frame.lines[box.y]),/^ ⌥ Worktrees +2 worktrees $/u);
  const looked=setDisplayConfig({look:'band'});
  try{assert.ok(draw(withWorktrees(),45).lines[box.y].startsWith(theme.band('').replace(/\x1b\[0m$/,'')),'on the band');}
  finally{setDisplayConfig(looked);}
  assert.ok(stripAnsi(frame.lines[box.y+1]).startsWith('│ '),'its rows behind a gutter');
  assert.ok(!frame.controls.some(c=>c.y===box.y&&c.kind!=='zoom'),'the band draws no button');
  let state=handleMonitorInput(frame.state,mouse(box.width-3,box.y),ctx()).state;
  assert.equal(state.zoom,true,'a click on the band zooms');assert.equal(state.focus,'worktrees');assert.equal(state.modes.worktrees,'open');
  frame=draw(state,45);
  assert.deepEqual(frame.panes.map(p=>p.id),['worktrees'],'zoomed, the pane fills the panel');
  assert.ok(frame.lines[1].includes(theme.tab(theme.bold(' ⌥ Worktrees '))),'zoomed, its title is a filled tab');
  state=handleMonitorInput(state,mouse(3,1),ctx()).state;
  assert.equal(state.zoom,false,'a second click restores it');
  frame=draw(state,45);
  state=handleMonitorInput(frame.state,mouse(tab('worktrees').x,0),ctx()).state;
  assert.equal(state.modes.worktrees,'closed','one click on an open pane\'s button closes it');
  frame=draw(state,45);assert.equal(frame.panes.some(p=>p.id==='worktrees'),false);
  state=handleMonitorInput(state,mouse(tab('worktrees').x,0),ctx()).state;
  assert.equal(state.modes.worktrees,'open');assert.equal(state.focus,'worktrees','opened, it takes focus');
  // The agents area too: its button closes it, its summary line zooms it.
  frame=draw(state,45);
  const summary=frame.panes.find(p=>p.id==='agents')!;
  const zoomed=handleMonitorInput(state,mouse(2,summary.y),ctx()).state;
  assert.equal(zoomed.zoom,true);assert.equal(zoomed.focus,'agents');
  state=handleMonitorInput(state,mouse(tab('agents').x,0),ctx()).state;
  assert.equal(state.modes.agents,'closed');
  frame=draw(state,45);assert.deepEqual(frame.panes.map(p=>p.id),['worktrees'],'the other panes take its room');
});

test('every look draws the panel to its width; the frame look closes its frame round the panes, and their rows still click',()=>{
  for(const look of LOOKS){
    const looked=setDisplayConfig({look});
    try{
      for(const width of [20,24,30,45]){
        for(const state of [withWorktrees(),{...withWorktrees(),focus:'worktrees' as const,zoom:true}]){
          const frame=draw(state,width);
          frame.lines.forEach((line,y)=>assert.equal(visualLength(line),width,`${look} ${width} row ${y}: "${stripAnsi(line)}"`));
        }
      }
    }finally{setDisplayConfig(looked);}
  }
  const looked=setDisplayConfig({look:'frame'});
  try{
    const frame=draw({...withWorktrees(),focus:'worktrees'},36);
    const lines=frame.lines.map(stripAnsi);
    assert.match(lines[0],/^╭─ ⌂ .* ─╮$/,'the main session and the actions in its top edge');
    assert.match(lines[1],/^│ .*│$/,'the tabs between its sides');
    assert.match(lines.at(-1)!,/^╰─+╯$/,'no status card: the frame closes on a row of its own');
    const box=frame.panes.find(p=>p.id==='worktrees')!;
    assert.match(lines[box.y],/^├─ ⌥ Worktrees .* ─┤$/,'a pane\'s title is an edge of the frame');
    for(let y=box.y+1;y<box.y+box.height;y++)assert.match(lines[y],/^│ .* │$/,lines[y]);
    assert.ok(frame.lines[box.y+1].startsWith(theme.accent('│')),'the focused pane\'s side in the accent');
    assert.equal(box.x,2,'its rows start inside the frame');
    const row=box.rows.findIndex(r=>r.item==='/demo/docs');
    assert.equal(handleMonitorInput(frame.state,mouse(4,box.y+1+row),{tree,worktrees,frame}).state.selectedWorktree,'/demo/docs','a click on a row selects it');
    const zoom=handleMonitorInput(frame.state,mouse(35,box.y),{tree,worktrees,frame}).state;
    assert.equal(zoom.zoom,true,'a click anywhere on the title zooms');
    // Rows a pane leaves empty are blank between the frame's sides, not cut short with "…".
    for(const state of [{...withWorktrees(),tabbed:true},{...withWorktrees(),zoom:true}]){
      const shown=draw(state,36).lines.map(stripAnsi);
      for(const line of shown.slice(2))assert.doesNotMatch(line,/^│ +… │$/,`${state.tabbed?'tabs':'zoomed'}: ${line}`);
    }
  }finally{setDisplayConfig(looked);}
});

test('the tabs layout: one pane at a time, the bar\'s tabs and 1–5 switch it, and the stacked layout\'s panes stay as they were',()=>{
  const start={...withWorktrees(),tabbed:true};
  let frame=draw(start,45);const ctx=()=>({tree,worktrees,frame});
  assert.deepEqual(frame.panes.map(p=>p.id),['agents'],'only the pane shown');
  const tab=(pane:string)=>frame.controls.find(c=>c.kind==='tab'&&c.pane===pane)!;
  assert.deepEqual(frame.controls.filter(c=>c.kind==='tab').map(c=>c.pane),['agents','worktrees','changes','details','timeline'],'every pane has a tab');
  // A click on a tab the stacked layout has closed shows that pane, and opens nothing.
  let next=handleMonitorInput(frame.state,mouse(tab('changes').x,0),ctx()).state;
  assert.equal(next.focus,'changes');assert.deepEqual(next.modes,start.modes,'nothing to save');
  frame=draw(next,45);
  assert.deepEqual(frame.panes.map(p=>p.id),['changes']);
  assert.equal(frame.panes[0].height,28-1,'all the rows under the bar');
  next=handleMonitorInput(frame.state,mouse(tab('changes').x,0),ctx()).state;
  assert.equal(next.focus,'changes','a second click keeps it shown');
  // 1–5 and Tab go through every pane; x and z do nothing.
  next=handleMonitorInput(next,key('timeline'),ctx()).state;assert.equal(next.focus,'timeline');
  next=handleMonitorInput(next,key('tab'),ctx()).state;assert.equal(next.focus,'agents','Tab wraps round');
  next=handleMonitorInput(next,key('tab'),ctx()).state;assert.equal(next.focus,'worktrees');
  assert.deepEqual(handleMonitorInput(next,key('pane-close'),ctx()).state.modes,start.modes,'x closes nothing');
  assert.equal(handleMonitorInput(next,key('zoom'),ctx()).state.zoom,false,'z zooms nothing');
  frame=draw(next,45);
  const head=frame.panes[0];
  assert.equal(handleMonitorInput(frame.state,mouse(3,head.y),ctx()).state.zoom,false,'nor does a click on the title');
  // Enter inspects in the inspector's tab; Esc goes back to what was inspected.
  next=handleMonitorInput(next,key('enter'),ctx()).state;
  assert.equal(next.focus,'details');assert.equal(next.zoom,false);
  next=handleMonitorInput(next,key('escape'),ctx()).state;
  assert.equal(next.focus,'worktrees');assert.deepEqual(next.modes,start.modes);
  // The stacked layout comes back as it was left.
  assert.deepEqual(draw({...next,tabbed:false},45).panes.map(p=>p.id),['agents','worktrees']);
  // The help says what the tabs do.
  const help=draw({...next,help:true},45,200).lines.map(stripAnsi).join('\n');
  assert.match(help,/\n1–5 +show a pane\n/);assert.doesNotMatch(help,/close pane\b|zoom/);
});

test('keyboard motion only previews; Inspector remains closed until explicitly opened',()=>{
  const frame=draw();const next=handleMonitorInput(frame.state,key('down'),{tree,worktrees,frame});
  assert.equal(next.action,undefined);assert.notEqual(next.state.tree.selectedId,frame.state.tree.selectedId);
  assert.equal(next.state.modes.details,'closed');
  const inspect=handleMonitorInput(next.state,key('enter'),{tree,worktrees,frame});assert.equal(inspect.action,undefined);assert.equal(inspect.state.modes.details,'open');
  const opened=handleMonitorInput(next.state,key('open-session'),{tree,worktrees,frame});assert.deepEqual(opened.action,{type:'switch',id:next.state.tree.selectedId});
});

test('a worktree\'s details count only what it has: no zero counts, and no ahead or behind at zero or unknown',()=>{
  const state={...initialMonitorState(),preview:'worktree' as const,focus:'details' as const,selectedWorktree:'/demo/main'};
  state.modes={...state.modes,worktrees:'open',details:'open'};
  const details=(snapshot:WorktreesSnapshot)=>renderMonitor({tree,worktrees:snapshot,state,width:40,height:30,nowMs:now}).panes.find(p=>p.id==='details')!.rows.map(r=>stripAnsi(r.text));
  const main=details(worktrees);
  assert.ok(main.includes('1 staged · 2 unstaged'),main.join('\n'));
  assert.ok(!main.some(line=>/\b0 |ahead|behind|Ahead/.test(line)),main.join('\n'));
  const drifted=details({...worktrees,entries:[{...worktrees.entries[0],status:{...worktrees.entries[0].status!,conflicts:1,ahead:2,behind:0}},worktrees.entries[1]]});
  assert.ok(drifted.includes('1 conflicts · 1 staged · 2 unstaged') && drifted.includes('2 ahead'),drifted.join('\n'));
});

test('a selected row is on the band the selected card is on, in the terminal theme too',()=>{
  const previous=setDisplayConfig({theme:'terminal'});
  try { assert.equal(theme.selected('x'),theme.selectedBand('x')); assert.ok(!theme.selected('x').includes('\x1b[7m'),'not reverse video'); }
  finally { setDisplayConfig(previous); }
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
  // The git header repeats the path and names blobs by hash: the hunks are what is shown.
  const headed=renderMonitor({tree,worktrees,git,state:opened,width:30,height:24,nowMs:now,
    diff:['Unstaged','diff --git a/b b/b','index febb64905..64f804d91 100644','--- a/b','+++ b/b','@@ -1 +1 @@','--- old rule','+++ new rule']});
  const text=stripAnsi(headed.lines.join('\n'));
  assert.doesNotMatch(text,/[0-9a-f]{7,}|diff --git|--- a\/b|\+\+\+ b\/b/);
  assert.match(text,/Unstaged/);assert.match(text,/@@ -1 \+1 @@/);
  assert.match(text,/--- old rule/);assert.match(text,/\+\+\+ new rule/,'inside a hunk such a line is content');
});

test('an untracked directory is one row, its slash kept, and inspected says what is in it in the reader\'s words',async()=>{
  const {setLanguage}=await import('../../src/render/i18n.js');
  const untracked=(path: string)=>({path,index:'?',worktree:'?',added:null,removed:null,binary:false,conflict:false});
  const git={root:'/demo/main',branch:'main',ahead:0,behind:0,files:[untracked('runs/r02/'),untracked('notes.md')]};
  const state=initialMonitorState();state.modes.changes='open';state.focus='changes';state.selectedFile='runs/r02/';state.untrackedOpen=true;
  const frame=renderMonitor({tree,worktrees,git,state,width:30,height:30,nowMs:now});
  assert.match(stripAnsi(frame.lines.join('\n')),/▾ 2 untracked *\n│ ›   runs\/r02\/ /);
  const opened=handleMonitorInput(frame.state,key('enter'),{tree,git,worktrees,frame}).state;
  const diff=['Untracked','2 files','a.json','deep/b.json'];
  const previous=setLanguage('zh');
  try {
    const text=stripAnsi(renderMonitor({tree,worktrees,git,state:opened,width:30,height:24,nowMs:now,diff}).lines.join('\n'));
    assert.match(text,/r02\/ *\n.*runs\/ *\n.*未跟踪 · 2 个文件 *\n.*a\.json *\n.*deep\/b\.json/);
    assert.doesNotMatch(text,/Untracked|2 files/);
    assert.match(stripAnsi(renderMonitor({tree,worktrees,git,state:opened,width:30,height:24,nowMs:now,diff:['Untracked','1 file','a.json']}).lines.join('\n')),/未跟踪 · 1 个文件/);
  } finally { setLanguage(previous); }
  const en=stripAnsi(renderMonitor({tree,worktrees,git,state:opened,width:30,height:24,nowMs:now,diff:['Untracked','1 file','a.json']}).lines.join('\n'));
  assert.match(en,/Untracked · 1 file\b/);
  // Anything else the preview says is shown as it is.
  const failed=stripAnsi(renderMonitor({tree,worktrees,git,state:opened,width:30,height:24,nowMs:now,diff:['[Preview unavailable: No longer on disk]']}).lines.join('\n'));
  assert.match(failed,/\[Preview unavailable: No *\n│ +longer on disk\]/);
});

test('a changed file is a letter in its colour, its path and its line counts; untracked files fold into one last row that Enter or a click opens',()=>{
  const file=(path:string,index:string,worktree:string,added:number|null,removed:number|null,conflict=false)=>({path,index,worktree,added,removed,binary:false,conflict});
  const git={root:'/demo/main',branch:'main',ahead:0,behind:0,files:[file('src/cards.ts','.','M',54,16),file('src/new.ts','A','M',120,0),
    file('docs/old.md','D','.',0,33),file('src/moved.ts','R','.',3,1),file('src/both.ts','U','U',null,null,true),
    file('notes.md','?','?',null,null),file('runs/','?','?',null,null)]};
  const state=initialMonitorState();state.modes.changes='open';state.focus='changes';
  const draw=(at:MonitorState,width=44)=>renderMonitor({tree,worktrees,git,state:at,width,height:30,nowMs:now});
  const frame=draw(state);
  const pane=frame.panes.find(p=>p.id==='changes')!;
  const text=pane.rows.map(row=>stripAnsi(row.text));
  assert.deepEqual(text.map(line=>line.trimEnd()),['1 conflicts · 3 staged · 2 unstaged','› M src/cards.ts                   +54 −16','  A src/new.ts                        +120',
    '  D docs/old.md                        −33','  R src/moved.ts                     +3 −1','  ! src/both.ts','  ▸ 2 untracked'],'the counts leave the untracked to their own row');
  const row=(path:string)=>pane.rows.find(r=>r.item===path)!.text;
  assert.ok(row('src/cards.ts').includes(theme.warning('M'))&&row('src/new.ts').includes(theme.success('A'))&&row('docs/old.md').includes(theme.error('D'))
    &&row('src/moved.ts').includes(theme.info('R'))&&row('src/both.ts').includes(theme.error('!')),'added green, deleted red, renamed blue, modified yellow, a conflict red');
  assert.ok(row('src/cards.ts').includes(theme.success('+54'))&&row('src/cards.ts').includes(theme.error('−16')));
  assert.ok(!stripAnsi(draw(state,24).lines.join('\n')).includes('+54'),'narrow, the counts give way to the path');
  // The keys reach the row; Enter lists the files under it, and again folds them, without opening the Inspector.
  const ctx=(shown:typeof frame)=>({tree,git,worktrees,frame:shown,nowMs:now});
  const last=handleMonitorInput(frame.state,key('end'),ctx(frame)).state;
  const opened=handleMonitorInput(last,key('enter'),ctx(draw(last))).state;
  assert.equal(opened.untrackedOpen,true);assert.equal(opened.modes.details,'closed');assert.ok(!opened.zoom);
  const open=draw(opened);
  assert.deepEqual(open.panes.find(p=>p.id==='changes')!.rows.slice(-3).map(r=>stripAnsi(r.text).trimEnd()),['› ▾ 2 untracked','    notes.md','    runs/']);
  const into=handleMonitorInput(opened,key('down'),ctx(open)).state;
  assert.equal(into.selectedFile,'notes.md');
  assert.equal(handleMonitorInput(into,key('enter'),ctx(draw(into))).state.modes.details,'open','a listed untracked file opens as any file does');
  assert.equal(handleMonitorInput(opened,key('enter'),ctx(open)).state.untrackedOpen,false);
  // A click on the row does the same; folded, a file under it is selected as the row.
  const y=frame.panes.find(p=>p.id==='changes')!.y+1+text.length-1;
  const clicked=handleMonitorInput(frame.state,mouse(5,y),ctx(frame)).state;
  assert.equal(clicked.untrackedOpen,true);
  const folded=draw({...into,untrackedOpen:false});
  assert.match(stripAnsi(folded.lines.join('\n')),/› ▸ 2 untracked/);
  assert.notEqual(folded.state.selectedFile,'notes.md');
  // On the row the Inspector has no file to show.
  const inspected=renderMonitor({tree,worktrees,git,state:{...folded.state,modes:{...folded.state.modes,details:'open'},preview:'file'},width:44,height:30,nowMs:now});
  assert.equal(inspected.panes.find(p=>p.id==='details')!.rows.length,0);
});

test('monitor key profile maps numbers without changing legacy decoder behavior',()=>{
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('1234x')),['agents','worktrees','changes','details','pane-close'].map(key));
  assert.deepEqual(new WorkbenchInputDecoder().push(Buffer.from('24')),['details','activity'].map(key));
});

test('monitor visibility persists independently from legacy open Reports/Changes settings',()=>{
  const home=mkdtempSync(join(tmpdir(),'hud-monitor-settings-'));const old=process.env.CODEX_HUD_SETTINGS_PATH;
  process.env.CODEX_HUD_SETTINGS_PATH=join(home,'hud-settings.json');
  try{
    const settings=saveSettings({details:true,changes:true,activity:true});
    assert.deepEqual(monitorModes(settings),initialMonitorState().modes);
    let state=initialMonitorState();state.modes.changes='open';state.modes.worktrees='closed';state.modes.agents='closed';
    saveSettings(monitorPreferences(state));assert.deepEqual(monitorModes(loadSettings()),state.modes);
    assert.equal(loadSettings().details,true);
  }finally{if(old===undefined)delete process.env.CODEX_HUD_SETTINGS_PATH;else process.env.CODEX_HUD_SETTINGS_PATH=old;rmSync(home,{recursive:true,force:true});}
});

test('Settings exposes open/closed for each pane but the agents, and omits Checks',()=>{
  assert.equal(SETTING_ROWS.some(r=>r.key==='activity'),false);
  assert.equal(SETTING_ROWS.some(r=>r.key==='agentsPane'),false);
  const row=SETTING_ROWS.findIndex(r=>r.key==='worktreesPane');assert.ok(row>=0);
  let state={draft:defaultSettings(),selected:row,offset:0,message:''};
  const frame=renderSettingsPage(state,40,30);
  state=handleSettingsInput(state,key('right'),frame).state;assert.equal(state.draft.worktreesPane,'open');
  state=handleSettingsInput(state,key('right'),frame).state;assert.equal(state.draft.worktreesPane,'closed');
});


test('page movement counts distinct worktree cards rather than their directory continuation lines',()=>{
  const many={...worktrees,entries:Array.from({length:12},(_,i)=>({...worktrees.entries[0],path:'/worktrees/'+i,branch:'branch'+i}))};
  const state={...withWorktrees(),focus:'worktrees' as const};
  const frame=renderMonitor({tree,worktrees:many,state,width:30,height:18,nowMs:now});
  const pane=frame.panes.find(p=>p.id==='worktrees')!;
  const count=new Set(pane.rows.slice(pane.offset,pane.offset+pane.height-1).map(r=>r.item).filter(Boolean)).size;
  const next=handleMonitorInput(frame.state,key('page-down'),{tree,worktrees:many,frame});
  assert.equal(next.state.selectedWorktree,many.entries[count].path);
  assert.equal(next.action,undefined);
});

test('conflicts precede file counts even in narrow optional Changes',()=>{
  const state=initialMonitorState();state.modes.changes='open';
  const git={root:'/demo/main',branch:'main',ahead:0,behind:0,files:[{path:'conflict',index:'U',worktree:'U',added:null,removed:null,binary:false,conflict:true}]};
  const frame=renderMonitor({tree,worktrees,git,state,width:20,height:30,nowMs:now});
  assert.match(stripAnsi(frame.panes.find(p=>p.id==='changes')!.rows[0].text),/^1 conflicts/,'conflicts lead the counts');
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
  assert.equal(wt.height,wt.rows.length+1,'its band and its rows');
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
  assert.match(stripAnsi(pane.rows[0].text),/^ ✓1 done {2}▸1 run$/,'each count with its word');
  assert.match(stripAnsi(frame.lines[0]),/⊕/,'the button that brings them back');
  const ctx={tree:finished,worktrees,frame,nowMs:now};
  assert.ok(!handleMonitorInput(frame.state,mouse(1,pane.y),ctx).state.tree.showAll,'the summary is no switch');
  const older=frame.controls.find(c=>c.kind==='older')!;
  const shown=handleMonitorInput(frame.state,mouse(older.x,0),ctx);
  assert.equal(shown.action,undefined,'a+1 is a toggle, not a session switch');
  assert.equal(shown.state.tree.showAll,true);
  frame=renderMonitor({tree:finished,worktrees,state:shown.state,width:30,height:28,nowMs:now});
  pane=frame.panes[0];
  assert.equal(pane.rows.filter(r=>r.item).length,2);
  assert.ok(stripAnsi(frame.lines[0]).includes('⊖'),'and the button that puts them away again');
  assert.equal(handleMonitorInput(frame.state,key('show-all'),{...ctx,frame}).state.tree.showAll,false);
  // A finished row carries no clock; it recedes once its finish is old news.
  const oldRow=pane.rows.find(r=>r.item===nodes[0].id)!.text;
  assert.doesNotMatch(stripAnsi(oldRow),/\d+[smh]\b/);
  assert.ok(oldRow.includes(colors.dim('Hegel')));
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('a')),[key('show-all')]);
  // Counts that are zero stay out of the summary.
  const allDone:SubagentTree={...tree,nodes:[{...nodes[0],status:'completed',statusAt:new Date(now-1000)}]};
  const summary=stripAnsi(renderMonitor({tree:allDone,worktrees,state:initialMonitorState(),width:30,height:28,nowMs:now}).panes[0].rows[0].text);
  assert.equal(summary.trimEnd(),' ✓1 done');
  // Where the reader asked for words, the counts say what they count.
  const previous=setDisplayConfig({glyphs:'text'});
  try {
    const worded=stripAnsi(renderMonitor({tree:allDone,worktrees,state:initialMonitorState(),width:30,height:28,nowMs:now}).panes[0].rows[0].text);
    assert.equal(worded.trimEnd(),' ✓1 done');
  } finally {setDisplayConfig(previous);}
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

test('the changes say their counts in words, zeros left out, and tell two files of one name apart', async () => {
  const { changeCounts, shownPaths } = await import('../../src/render/monitor.js');
  const { setLanguage } = await import('../../src/render/i18n.js');
  const file = (index: string, worktree: string, path = 'f', conflict = false) => ({ path, index, worktree, added: 1, removed: 0, binary: false, conflict });
  const files = [...Array.from({ length: 5 }, () => file('.', 'M')), ...Array.from({ length: 2924 }, () => file('?', '?'))];
  const previous = setLanguage('zh');
  try {
    assert.equal(stripAnsi(changeCounts(files, 32)), '5 未暂存 · 2924 未跟踪');
    assert.equal(stripAnsi(changeCounts(files, 12)), '5 未暂存', 'untracked goes first, the words stay');
    const all = [file('M', '.'), file('.', 'M'), file('?', '?'), file('U', 'U', 'c', true)];
    assert.equal(stripAnsi(changeCounts(all, 60)), '1 冲突 · 1 已暂存 · 1 未暂存 · 1 未跟踪');
    assert.equal(stripAnsi(changeCounts(all, 22)), '1 冲突 · 1 未暂存', 'then staged; conflicts stay');
  } finally {
    setLanguage(previous);
  }
  const paths = ['.agents/skills/atlas-web-api-transport/SKILL.md', '.claude/skills/atlas-web-api-transport/SKILL.md',
    '.omp/APPEND_SYSTEM.md', 'a/SKILL2.md', 'b/x/SKILL2.md'];
  assert.deepEqual(shownPaths(paths, 27), ['.agents/…/SKILL.md', '.claude/…/SKILL.md', '.omp/APPEND_SYSTEM.md', 'a/SKILL2.md', 'b/x/SKILL2.md']);
  assert.deepEqual(shownPaths(paths, 12), ['.a…/SKILL.md', '.c…/SKILL.md', '…D_SYSTEM.md', 'a/SKILL2.md', 'x/SKILL2.md']);
  assert.deepEqual(shownPaths(paths, 80), paths, 'whole where it fits');
  // An untracked directory keeps its slash, which also tells it from a file of its name.
  const dirs = ['runs/2026/r02/', 'logs/2026/r02', 'experiments/very_long_directory_name/'];
  assert.deepEqual(shownPaths(dirs, 12), ['r02/', 'r02', '…ctory_name/']);
  assert.deepEqual(shownPaths(dirs, 80), dirs);
  // Thousands of untracked files, many of one name, are told apart on every repaint without stalling it.
  const many = Array.from({ length: 6000 }, (_, i) => i % 2 ? `experiments/run_${i % 300}/stage_${i % 20}/__init__.py` : `x06_sampled_progress/run_${i}/controller_${i}.py`);
  const started = performance.now();
  const shown = shownPaths(many, 24);
  assert.ok(performance.now() - started < 1000, `${Math.round(performance.now() - started)}ms`);
  assert.equal(shown.length, many.length);
  assert.ok(shown.every((text) => visualLength(text) <= 24));
});

test('the panel\'s top, for the settings page to preview: the bar as the look draws it and the focused pane\'s title', async () => {
  const { panelTop } = await import('../../src/render/monitor.js');
  const state = { ...initialMonitorState(), focus: 'changes' as const };
  const previous = setDisplayConfig({ look: 'frame', icons: 'unicode', theme: 'terminal' });
  try {
    const top = panelTop({ tree }, state, 40).map(stripAnsi);
    assert.equal(top.length, 3, 'the frame\'s two rows of bar, then the title');
    assert.match(top[0], /^╭─ .*─╮$/);
    assert.match(top[1], /^│ .* │$/);
    assert.match(top[2], /^├─ ± Changes ─+┤$/);
    setDisplayConfig({ look: 'tab' });
    // One row of bar, then a blank one as the panel has: every look is as tall, so the page does not move as they are stepped through.
    const tab = panelTop({ tree }, state, 40).map(stripAnsi);
    assert.equal(tab.length, 3);
    assert.equal(tab[1], '');
    assert.match(tab[2], /^ ± Changes +$/);
    assert.equal(visualLength(tab[0]), 40);
  } finally {
    setDisplayConfig(previous);
  }
});

test('a diff line wraps where a word ends, its later rows two columns in, a tab as spaces and a word too long for a row cut', async () => {
  const { diffRows } = await import('../../src/render/monitor.js');
  assert.deepEqual(diffRows('+const result = await collectGitChanges(selected);', 24), [
    '+const result = await', '  collectGitChanges(', '  selected);']);
  assert.deepEqual(diffRows('+short', 24), ['+short'], 'a line that fits is as it is');
  // An opening bracket ends a row after a call's name, not where it opens an aside in prose.
  assert.deepEqual(diffRows('+the interpreter (written below) is', 20), ['+the interpreter', '  (written below) is']);
  // The first row keeps some text, never only the marker and the indentation.
  assert.deepEqual(diffRows('+        averyveryverylongidentifier', 16), ['+        averyve', '  ryverylongiden', '  tifier']);
  assert.deepEqual(diffRows('-\tif (x) {', 24), ['-    if (x) {'], 'a tab is spaces to the next fourth column');
  assert.deepEqual(diffRows('+\t\treturn', 24), ['+        return']);
  // Chinese breaks between any two characters; a path after a slash.
  assert.deepEqual(diffRows('+这是一段很长的中文说明文字', 14), ['+这是一段很长', '  的中文说明文', '  字']);
  assert.deepEqual(diffRows('+https://github.com/romkatv/powerlevel10k-media/raw', 24), [
    '+https://github.com/', '  romkatv/powerlevel10k-', '  media/raw']);
  // Control characters are escaped, as everywhere in the panel.
  assert.deepEqual(diffRows('+a\u001b[2Jb', 24), ['+a\\x1b[2Jb']);
  for (const width of [8, 12, 20, 33]) {
    for (const line of ['+const result = await collectGitChanges(selected);', '+这是一段很长的中文说明文字 with words', ' x'.repeat(30)]) {
      assert.ok(diffRows(line, width).every(row => visualLength(row) <= width), `${width}: ${line}`);
    }
  }
});

test('the Inspector heads a file with its name, its lines added and removed and its folder, and its sections in the reader\'s words', async () => {
  const { setLanguage } = await import('../../src/render/i18n.js');
  const file = (path: string, more = {}) => ({ path, index: 'M', worktree: 'M', added: 12, removed: 3, binary: false, conflict: false, ...more });
  const git = { root: '/demo/main', branch: 'main', ahead: 0, behind: 0,
    files: [file('.agents/skills/x/SKILL.md'), file('logo.png', { binary: true, added: null, removed: null }), file('only-added.txt', { removed: 0 })] };
  const inspect = (selectedFile: string, diff: string[], width = 30) => {
    const state = initialMonitorState(); state.modes.changes = 'open'; state.focus = 'changes'; state.selectedFile = selectedFile;
    const frame = renderMonitor({ tree, worktrees, git, state, width, height: 24, nowMs: now });
    const opened = handleMonitorInput(frame.state, key('enter'), { tree, git, worktrees, frame }).state;
    return renderMonitor({ tree, worktrees, git, state: opened, width, height: 24, nowMs: now, diff }).lines.map(stripAnsi);
  };
  const diff = ['Staged', 'diff --git a/x b/x', '@@ -1 +1 @@', '-old', '+new', 'Unstaged', 'diff --git a/x b/x', '@@ -1 +1,2 @@', ' new', '+Staged'];
  const previous = setLanguage('zh');
  try {
    const text = inspect('.agents/skills/x/SKILL.md', diff);
    assert.match(text[2], /^│ SKILL\.md +\+12 −3 *$/);
    assert.match(text[3], /^│ \.agents\/skills\/x\/ *$/);
    assert.match(text[4], /^│ ── 已暂存 ─+$/);
    assert.ok(text.some(line => /^│ ── 未暂存 ─+$/.test(line)));
    assert.ok(text.some(line => /^│ \+Staged *$/.test(line)), 'inside a hunk the word is content');
    assert.match(inspect('logo.png', [])[2], /^│ logo\.png +二进制 *$/);
    assert.match(inspect('only-added.txt', [])[2], /^│ only-added\.txt +\+12 *$/, 'a side with none is left out');
    // An untracked file's text may hold the words: only its first line is a label.
    const untracked = inspect('only-added.txt', ['Untracked', 'Unstaged', 'Staged']);
    assert.match(untracked[3], /^│ ── 未跟踪 ─+$/);
    assert.deepEqual(untracked.slice(4, 6).map(line => line.trim()), ['│ Unstaged', '│ Staged']);
  } finally {
    setLanguage(previous);
  }
  // A name too long to share its row puts the counts under it.
  const long = inspect('.agents/skills/x/SKILL.md', [], 14);
  // The folder breaks after a slash.
  assert.deepEqual(long.slice(2, 6).map(line => line.trimEnd()), ['│SKILL.md', '│+12 −3', '│.agents/', '│skills/x/']);
});
