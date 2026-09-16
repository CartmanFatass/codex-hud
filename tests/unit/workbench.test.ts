import test from 'node:test';
import assert from 'node:assert/strict';
import { initialWorkbenchState, handleWorkbenchInput, reconcileWorkbench } from '../../src/render/workbench-state.js';
import { paneItemAt } from '../../src/render/workbench-layout.js';
import { renderWorkbench, safeText } from '../../src/render/workbench.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import { node, treeOf } from '../fixtures/hud-data.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import type { GitChanges } from '../../src/collectors/git-changes.js';

const tree = treeOf(Array.from({length: 20}, (_, i) => node(`a${i}`, `agent-${i}`, 'running')));
const git: GitChanges = {root: '/tmp', branch: 'main', ahead: 1, behind: 0, files: Array.from({length: 15}, (_, i) => ({
  path: `src/file${i}.ts`, index: ' ', worktree: 'M', added: i, removed: 1, binary: false, conflict: false,
}))};
const key = (key: string) => ({type: 'key' as const, key});

test('focus, selection, and scrolling are independent across panes', () => {
  let state = reconcileWorkbench(initialWorkbenchState(), tree, git);
  let frame = renderWorkbench({tree, git, state, width: 45, height: 35});
  const context = () => ({tree, git, panes: frame.panes, events: []});
  state = handleWorkbenchInput(state, key('page-down'), context()).state;
  assert.notEqual(state.tree.selectedId, 'a0');
  const selected = state.tree.selectedId;
  state = handleWorkbenchInput(state, key('tab'), context()).state;
  assert.equal(state.focus, 'details');
  state = handleWorkbenchInput(state, key('down'), context()).state;
  assert.equal(state.scroll.details, 1);
  assert.equal(state.tree.selectedId, selected);
  state = handleWorkbenchInput(state, key('tab'), context()).state;
  assert.equal(state.focus, 'changes');
  state = handleWorkbenchInput(state, key('down'), context()).state;
  assert.equal(state.selectedFile, 'src/file1.ts');
  assert.equal(state.preview, 'file');
  state = handleWorkbenchInput(state, key('enter'), context()).state;
  assert.equal(state.focus, 'details');
  state = handleWorkbenchInput(state, key('escape'), context()).state;
  assert.equal(state.focus, 'changes');
  assert.equal(state.selectedFile, 'src/file1.ts');
  frame = renderWorkbench({tree, git, state, width: 32, height: 35});
  const pane = frame.panes.find(p => p.id === 'agents')!;
  state = handleWorkbenchInput(state, {type:'mouse', x:pane.x+1, y:pane.y+1, button:'wheel-down'}, context()).state;
  assert.equal(state.focus, 'agents');
  assert.equal(state.selectedFile, 'src/file1.ts');
});

test('terminal bounds hold across narrow, wide and zoomed layouts', () => {
  for (const width of [1, 10, 20, 30, 80, 120]) for (const height of [1, 5, 12, 24, 40]) {
    for (const zoom of [false, true]) {
      const state = {...initialWorkbenchState(), zoom};
      const frame = renderWorkbench({tree, git, state, width, height});
      assert.ok(frame.lines.length <= height, `${width}x${height} has too many lines`);
      for (const line of frame.lines) assert.ok(visualLength(line) <= width, `${width}x${height}: ${stripAnsi(line)}`);
    }
  }
  const narrow = renderWorkbench({tree, git, state:initialWorkbenchState(), width:30, height:32});
  assert.equal(narrow.panes.length, 4);
  const wide = renderWorkbench({tree, git, state:initialWorkbenchState(), width:100, height:32});
  assert.ok(new Set(wide.panes.map(p => p.x)).size > 1, 'wide terminal uses a preview column');
});

test('refresh preserves selected identities and terminal strings cannot inject controls', () => {
  let state = reconcileWorkbench(initialWorkbenchState(), tree, git);
  state.selectedFile = 'src/file3.ts';
  state.tree.selectedId = 'a5';
  state.scroll.details = 8;
  const refreshed = reconcileWorkbench(state, treeOf([node('new', 'new', 'running'), ...tree.nodes]), git);
  assert.equal(refreshed.tree.selectedId, 'a5');
  assert.equal(refreshed.selectedFile, 'src/file3.ts');
  assert.equal(refreshed.scroll.details, 8);
  const unsafe = treeOf([node('evil', 'name\x1b[2J\nspoof', 'running')]);
  const frame = renderWorkbench({tree: unsafe, git, state:initialWorkbenchState(), width:80, height:30});
  assert.ok(!frame.lines.join('').includes('\x1b[2J'));
  assert.ok(frame.lines.every(line => !line.includes('\n')));
});

test('decoder buffers split arrows and mouse events and handles batched keys', () => {
  const decoder = new WorkbenchInputDecoder();
  assert.deepEqual(decoder.push(Buffer.from('\x1b[')), []);
  assert.deepEqual(decoder.push(Buffer.from('Bjk\t')), [key('down'), key('down'), key('up'), key('tab')]);
  assert.deepEqual(decoder.push(Buffer.from('\x1b[<65;3;')), []);
  assert.deepEqual(decoder.push(Buffer.from('7M')), [{type:'mouse', button:'wheel-down', x:2, y:6}]);
  assert.deepEqual(decoder.push(Buffer.from('\x1b[Z\x1b[6~')), [key('shift-tab'), key('page-down')]);
  assert.deepEqual(decoder.push(Buffer.from('\x1b')), []);
  assert.deepEqual(decoder.flushEscape(), [key('escape')]);
});

test('collapsed pane headers reclaim space and reopen by mouse', () => {
  let state = initialWorkbenchState();
  let frame = renderWorkbench({tree, git, state, width:80, height:30});
  const context = () => ({tree, git, panes:frame.panes, events:[]});
  const activity = frame.panes.find(p => p.id === 'activity')!;
  assert.equal(activity.height, 1);
  state = handleWorkbenchInput(state, {type:'mouse', button:'left', x:activity.x+2, y:activity.y}, context()).state;
  frame = renderWorkbench({tree, git, state, width:80, height:30});
  assert.ok(frame.panes.find(p => p.id === 'activity')!.height > 1);
  const details = frame.panes.find(p => p.id === 'details')!;
  state = handleWorkbenchInput(state, {type:'mouse', button:'left', x:details.x+2, y:details.y}, context()).state;
  frame = renderWorkbench({tree, git, state, width:80, height:30});
  assert.equal(frame.panes.find(p => p.id === 'details')!.height, 1);
  assert.equal(state.activityTab, 'checks');
  state = handleWorkbenchInput(state, key('next-tab'), context()).state;
  assert.equal(state.activityTab, 'events');
  state = handleWorkbenchInput(state, key('next-tab'), context()).state;
  assert.equal(state.activityTab, 'checks');
});

test('agent rows retain model and effort symbols at narrow and wide widths',()=>{
  const agent = {...node('model','long-agent-name','running'),model:'gpt-6-astra',effort:'high'};
  for (const width of [16,30,70,100]) {
    const frame=renderWorkbench({tree:treeOf([agent]),state:initialWorkbenchState(),width,height:30});
    const pane=frame.panes.find(p=>p.id==='agents')!;
    const row=stripAnsi(frame.lines[pane.y+1]);
    assert.match(row,/☀◕/, `missing model/effort at ${width}: ${row}`);
    assert.match(row,/long/);
    assert.ok(visualLength(row)<=width);
  }
});

test('reopening Changes links its preview and tiny/zoomed panes really collapse',()=>{
  let state = initialWorkbenchState();
  state.collapsed.changes=true;
  const frame=renderWorkbench({tree,git,state,width:80,height:30});
  const changes=frame.panes.find(p=>p.id==='changes')!;
  state=handleWorkbenchInput(state,{type:'mouse',button:'left',x:changes.x+1,y:changes.y},{tree,git,panes:frame.panes,events:[]}).state;
  assert.equal(state.preview,'file');
  state.collapsed.changes=true;
  assert.equal(renderWorkbench({tree,git,state,width:30,height:12}).panes[0].height,1);
  state.zoom=true;
  assert.equal(renderWorkbench({tree,git,state,width:80,height:30}).panes[0].height,1);
});

test('default stacked layout shows every agent report without opening inspector',()=>{
  const reportAt=new Date('2026-09-16T09:00:00Z');
  const nodes=treeOf([
    {...node('a','alpha','running'),lastReport:{text:'ALPHA_SAYS_THIS',at:reportAt,kind:'update' as const}},
    {...node('b','beta','completed'),lastReport:{text:'BETA_SAYS_THIS',at:reportAt,kind:'reply' as const}},
  ]);
  const frame=renderWorkbench({tree:nodes,state:initialWorkbenchState(),width:30,height:32,nowMs:reportAt.getTime()});
  const text=stripAnsi(frame.lines.join('\n'));
  assert.match(text,/2 Reports/);
  assert.match(text,/ALPHA_SAYS_THIS/);
  assert.match(text,/BETA_SAYS_THIS/);
  assert.doesNotMatch(text,/Inspector/);
  assert.equal(frame.state.detailExpanded,false);
});

test('team reports are selection independent and inspector is explicit',()=>{
  const reportAt=new Date('2026-09-16T09:00:00Z');
  const nodes=treeOf([
    {...node('a','alpha','running'),lastReport:{text:'ALPHA_REPORT',at:reportAt,kind:'update' as const}},
    {...node('b','beta','completed'),lastReport:{text:'BETA_REPORT',at:reportAt,kind:'reply' as const}},
    node('c','gamma','unknown'),
  ]);
  const first=renderWorkbench({tree:nodes,state:{...initialWorkbenchState(),focus:'details',zoom:true},width:45,height:24,nowMs:reportAt.getTime()});
  const second=renderWorkbench({tree:nodes,state:{...first.state,tree:{...first.state.tree,selectedId:'b'}},width:45,height:24,nowMs:reportAt.getTime()});
  assert.deepEqual(first.lines,second.lines,'selection cannot filter the team reports');
  const text=stripAnsi(first.lines.join('\n'));
  assert.match(text,/ALPHA_REPORT/); assert.match(text,/BETA_REPORT/);
  assert.match(text,/unknown/); assert.match(text,/No public report/);
  const ctx={tree:nodes,panes:first.panes,events:[]};
  const explicit=handleWorkbenchInput(first.state,key('detail-toggle'),ctx).state;
  assert.equal(explicit.detailExpanded,true);
  const inspected=renderWorkbench({tree:nodes,state:explicit,width:45,height:24});
  assert.match(stripAnsi(inspected.lines.join('\n')),/Inspector/);
  const back=handleWorkbenchInput(explicit,key('escape'),ctx).state;
  assert.equal(back.detailExpanded,false);
});

test('old reports are marked prior-turn and report text cannot inject terminal controls',()=>{
  const nodes=treeOf([{...node('a','alpha','running'),turnStartedAt:new Date('2026-09-16T09:01:00Z'),
    lastReport:{text:'old\x1b[2Jreport',at:new Date('2026-09-16T09:00:00Z'),kind:'reply' as const}}]);
  const frame=renderWorkbench({tree:nodes,state:{...initialWorkbenchState(),focus:'details',zoom:true},width:45,height:24});
  const text=stripAnsi(frame.lines.join('\n'));
  assert.match(text,/Prev:/); assert.doesNotMatch(text,/\x1b\[2J/);
  assert.match(text,/\\x1b/);
});

test('enter inspects but a mouse agent selection returns to team view',()=>{
  let frame=renderWorkbench({tree,git,state:initialWorkbenchState(),width:45,height:32});
  let ctx={tree,git,panes:frame.panes,events:[]};
  let state=handleWorkbenchInput(frame.state,key('enter'),ctx).state;
  assert.equal(state.detailExpanded,true);
  frame=renderWorkbench({tree,git,state,width:45,height:32});ctx={...ctx,panes:frame.panes};
  const pane=frame.panes.find(p=>p.id==='agents')!;
  state=handleWorkbenchInput(frame.state,{type:'mouse',button:'left',x:pane.x+2,y:pane.y+1},ctx).state;
  assert.equal(state.detailExpanded,false);
});

test('navigation notices occupy only the footer and never reflow agent details',()=>{
  const state={...initialWorkbenchState(),focus:'details' as const,zoom:true};
  const baseline=renderWorkbench({tree,state,width:30,height:20});
  const notice='Switch requested, but a restored draft or another view prevents confirming it. '.repeat(4);
  const frame=renderWorkbench({tree,state,width:30,height:20,notice});
  assert.deepEqual(frame.lines.slice(0,-1),baseline.lines.slice(0,-1));
  assert.match(stripAnsi(frame.lines.at(-1)!),/Switch requested/);
  assert.equal(frame.panes[0].contentLength,baseline.panes[0].contentLength);
});


test('narrow Changes is a workspace summary, not a hidden file selector',()=>{
  const frame=renderWorkbench({tree,git,state:{...initialWorkbenchState(),focus:'changes'},width:30,height:32});
  const changes=frame.panes.find(p=>p.id==='changes')!;
  assert.equal(changes.summary,true);
  assert.equal(frame.state.preview,'workspace');
  const lines=frame.lines.slice(changes.y+1,changes.y+changes.height-1).map(stripAnsi).join('\n');
  assert.match(lines,/15 files/);
  assert.doesNotMatch(lines,/src\/file|\+\d+-\d+/);
  const ctx={tree,git,panes:frame.panes,events:[]};
  const moved=handleWorkbenchInput(frame.state,key('down'),ctx).state;
  assert.equal(moved.selectedFile,frame.state.selectedFile);
  const details=handleWorkbenchInput(moved,key('enter'),ctx).state;
  assert.equal(details.focus,'details');
  assert.equal(details.preview,'workspace');
  assert.equal(handleWorkbenchInput(details,key('escape'),ctx).state.focus,'changes');
});

test('an agent task continuation selects that agent; empty space is not an agent',()=>{
  const sample=treeOf([{...node('a','alpha','unknown'),task:'Inspect picker UUIDs'}, {...node('b','beta','running'),task:'Check pane margins'}]);
  const s=initialWorkbenchState(); s.tree.sort='created';
  const frame=renderWorkbench({tree:sample,state:s,width:30,height:32});
  const pane=frame.panes.find(p=>p.id==='agents')!;
  assert.deepEqual(pane.rowItems,[0,0,1,1]);
  assert.equal(paneItemAt(pane,pane.x+2,pane.y+2),0);
  assert.equal(paneItemAt(pane,pane.x+1,pane.y+2),undefined);
  assert.equal(paneItemAt(pane,pane.x+2,pane.y+5),undefined);
  const selected=handleWorkbenchInput(frame.state,{type:'mouse',button:'left',x:pane.x+2,y:pane.y+2},{tree:sample,panes:frame.panes,events:[]}).state;
  assert.equal(selected.tree.selectedId,'a');
  const moved=handleWorkbenchInput(selected,key('down'),{tree:sample,panes:frame.panes,events:[]}).state;
  assert.equal(moved.tree.selectedId,'b');
});

test('workspace warnings remain visible when a partial Git read returned files',()=>{
  for (const width of [30,45,70]) {
    const frame=renderWorkbench({tree,git:{...git,error:'Git timed out'},state:initialWorkbenchState(),width,height:32});
    assert.match(stripAnsi(frame.lines.join('\n')),/Git incomplete/);
    assert.doesNotMatch(stripAnsi(frame.lines.join('\n')),/Working tree clean/);
  }
});

test('Git failures never echo the failed command or native stderr',()=>{
  const native='Command failed: git --no-optional-locks -c core.fsmonitor=false -c color.ui=false rev-parse --show-toplevel\nfatal: not a git repository (or any of the parent directories): .git';
  const missing={root:null,branch:null,ahead:0,behind:0,files:[],error:native};
  const empty=renderWorkbench({tree,git:missing,state:{...initialWorkbenchState(),focus:'changes'},width:45,height:24});
  const emptyText=stripAnsi(empty.lines.join('\n'));
  assert.match(emptyText,/Git unavailable/);
  assert.doesNotMatch(emptyText,/Command failed|git --no-optional-locks|rev-parse|fatal:/);
  const details=renderWorkbench({tree,git:{...git,error:native},state:{...initialWorkbenchState(),focus:'details',preview:'workspace',zoom:true},width:45,height:24});
  const detailsText=stripAnsi(details.lines.join('\n'));
  assert.match(detailsText,/Git could not complete the request|Git incomplete/);
  assert.doesNotMatch(detailsText,/Command failed|git --no-optional-locks|rev-parse|fatal:/);
});

test('literal filename controls and bidi marks cannot inject terminal structure',()=>{
  assert.equal(safeText('a\tb\nc\r\x1b[2J\u202e'),'a\\tb\\nc\\r\\x1b[2J\\u202e');
  const unsafe={...git,files:[{...git.files[0],path:'evil\nx.ts',previousPath:'old\tx.ts'}]};
  const frame=renderWorkbench({tree,git:unsafe,state:{...initialWorkbenchState(),focus:'details',preview:'file',zoom:true},width:30,height:24});
  const text=stripAnsi(frame.lines.join('\n'));
  assert.match(text,/evil\\nx\.ts/);
  assert.match(text,/old\\tx\.ts/);
  assert.ok(frame.lines.every(line=>!line.includes('\n') && !line.includes('\x1b[2J')));
});

test('padding and two-column gutter use the same coordinates as hit testing',()=>{
  const frame=renderWorkbench({tree,git,state:initialWorkbenchState(),width:70,height:32});
  const changes=frame.panes.find(p=>p.id==='changes')!;
  for (const pane of frame.panes.filter(p=>p.height>2)) {
    for (let y=pane.y+1;y<pane.y+pane.height-1;y++) {
      const line=stripAnsi(frame.lines[y]);
      assert.equal(line[pane.x],'│');
      assert.equal(line[pane.x+1],' ');
      assert.equal(line[pane.x+pane.width-2],' ');
      assert.equal(line[pane.x+pane.width-1],'│');
    }
  }
  assert.ok(changes.width>frame.panes.find(p=>p.id==='agents')!.width);
  assert.equal(stripAnsi(frame.lines[changes.y+1])[changes.x-1],' ');
});

test('a narrow file preview contains metadata, not wrapped diff lines',()=>{
  const frame=renderWorkbench({tree,git,diff:['+THIS_PATCH_MUST_STAY_HIDDEN'],state:{...initialWorkbenchState(),focus:'details',preview:'file',zoom:true},width:30,height:24});
  const text=stripAnsi(frame.lines.join('\n'));
  assert.match(text,/Widen for diff/);
  assert.doesNotMatch(text,/THIS_PATCH/);
});
