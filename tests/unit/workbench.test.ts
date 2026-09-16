import test from 'node:test';
import assert from 'node:assert/strict';
import { initialWorkbenchState, handleWorkbenchInput, reconcileWorkbench } from '../../src/render/workbench-state.js';
import { renderWorkbench } from '../../src/render/workbench.js';
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
  let frame = renderWorkbench({tree, git, state, width: 32, height: 35});
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

test('agent details stay compact even with a long code call and output',()=>{
  const task='Investigate rendering '.repeat(20);
  const item={...node('verbose','worker','running'),task,model:'gpt-6-astra',effort:'high'};
  const agent={session:null,planProgress:null,tokenUsage:null,rateLimits:null,subagents:[],compactCount:0,lastCompactTime:null,lastToolActivityTime:null,lastAssistantMessageTime:null,lastEventTime:null,toolActivity:{recentCalls:[{id:'tool',name:'exec',timestamp:new Date(),status:'error' as const,
    arguments:{code:'const enormous_script = true;\n'.repeat(100)},output:'ENORMOUS_OUTPUT\n'.repeat(100),exitCode:1,duration:2000}],totalCalls:1,callsByType:{exec:1},lastUpdateTime:new Date()}};
  const frame=renderWorkbench({tree:treeOf([item]),agent,state:{...initialWorkbenchState(),focus:'details',zoom:true},width:40,height:30});
  const text=stripAnsi(frame.lines.join('\n'));
  assert.ok(frame.panes[0].contentLength<=7);
  assert.match(text,/✗ exec.*exit 1/);
  assert.doesNotMatch(text,/enormous_script|ENORMOUS_OUTPUT|ID verbose/);
  assert.match(text,/\[v\+\]/);
  const context={tree:treeOf([item]),panes:frame.panes,events:[]};
  const expanded=handleWorkbenchInput(frame.state,key('detail-toggle'),context).state;
  const expandedFrame=renderWorkbench({tree:context.tree,agent,state:expanded,width:40,height:30});
  assert.ok(expandedFrame.panes[0].contentLength>frame.panes[0].contentLength);
  assert.match(stripAnsi(expandedFrame.lines.join('\n')),/enormous_script/);
  const pane=expandedFrame.panes[0];
  const compact=handleWorkbenchInput(expandedFrame.state,{type:'mouse',button:'left',x:pane.x+pane.width-3,y:pane.y}, {...context,panes:expandedFrame.panes}).state;
  assert.equal(compact.detailExpanded,false);
  assert.equal(compact.scroll.details,0);
  assert.equal(compact.collapsed.details,false);
  const moved=handleWorkbenchInput({...expanded,focus:'agents',zoom:false},key('home'),{...context,tree:treeOf([item,node('next','next','running')])}).state;
  assert.equal(moved.tree.selectedId,'next');
  assert.equal(moved.detailExpanded,false);
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
