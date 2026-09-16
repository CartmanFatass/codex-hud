import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutWorkbench, paneContentWidth, panePadding, paneItemAt, panePageSize, summaryOnly, canPreviewDiff, workspaceCounts, workspaceSummary, gitFailureNotice, toolCommand, toolResult } from '../../src/render/workbench-layout.js';
import type { WorkbenchState, PaneId, PaneRect } from '../../src/render/workbench-state.js';
import type { GitChanges, GitChangedFile } from '../../src/collectors/git-changes.js';
import type { ToolCall } from '../../src/types.js';

// No runtime dependency on collectors, process execution or tmux.
const state = (focus: PaneId = 'agents'): WorkbenchState => ({
  tree: { selectedId: null, collapsed: new Set<string>(), view: 'tree', filter: 'all', sort: 'active', scroll: 0 },
  focus, scroll: {agents:0, details:0, changes:0, activity:0}, selectedFile:null, selectedEvent:null,
  preview:'agent', activityTab:'checks', zoom:false, help:false,
  collapsed:{agents:false, details:false, changes:false, activity:true}, tasksEnabled:false, detailExpanded:false,
});
const file = (overrides: Partial<GitChangedFile> = {}): GitChangedFile => ({path:'src/a.ts',index:' ',worktree:'M',added:2,removed:1,binary:false,conflict:false,...overrides});
const git = (files: GitChangedFile[], error?: string): GitChanges => ({root:'/workspace',branch:'main',ahead:0,behind:0,files,error});
const pane = (overrides: Partial<PaneRect> = {}): PaneRect => ({id:'agents',x:0,y:1,width:30,height:8,offset:0,contentLength:6,rowItems:[0,0,1,1,null,2],...overrides});
const call = (overrides: Partial<ToolCall> = {}): ToolCall => ({id:'tool',name:'exec',status:'completed',timestamp:new Date('2026-09-16T00:00:00Z'),...overrides});

test('one cell of padding on each side, including the 16-column mode', () => {
  for (const width of [16,20,24,30,45,70]) { assert.equal(panePadding(width),1); assert.equal(paneContentWidth(width),width-4); }
  assert.equal(paneContentWidth(1),0);
  assert.equal(paneContentWidth(5),3);
});

test('all layouts stay inside the viewport, including collapse, zoom and tiny heights', () => {
  const ids: PaneId[] = ['agents','details','changes','activity'];
  for (const width of [1,10,16,20,30,40,45,69,70,100]) for (const height of [1,2,5,12,14,18,24,40]) {
    for (let mask=0;mask<16;mask++) for (const focus of ids) for (const zoom of [false,true]) {
      const s=state(focus); s.zoom=zoom; ids.forEach((id,i) => {s.collapsed[id]=Boolean(mask & (1<<i));});
      const panes=layoutWorkbench(width,height,s,20,6);
      for (const p of panes) {
        assert.ok(p.width>0 && p.height>0,`${width}x${height}`);
        assert.ok(p.x>=0 && p.x+p.width<=width,`${width}x${height}: x`);
        assert.ok(p.y>=1 && p.y+p.height<=height-1,`${width}x${height}: y`);
        if (s.collapsed[p.id]) assert.equal(p.height,1);
      }
      for (let i=0;i<panes.length;i++) for (let j=i+1;j<panes.length;j++) {
        const a=panes[i],b=panes[j];
        assert.ok(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y,'overlapping panes');
      }
    }
  }
});

test('16–30 columns keep Changes summary-only, 45 columns permit filenames', () => {
  for (const width of [16,20,24,30]) {
    const panes=layoutWorkbench(width,30,state(),5);
    assert.equal(panes.find(p=>p.id==='changes')!.summary,true);
    assert.equal(canPreviewDiff(panes),false);
  }
  assert.equal(layoutWorkbench(45,30,state(),5).find(p=>p.id==='changes')!.summary,false);
  assert.equal(summaryOnly(39),true); assert.equal(summaryOnly(40),false);
});

test('70-column layout reserves a gutter and gives files the wider column', () => {
  const panes=layoutWorkbench(70,32,state(),8);
  const agents=panes.find(p=>p.id==='agents')!, details=panes.find(p=>p.id==='details')!, changes=panes.find(p=>p.id==='changes')!;
  assert.equal(details.x,agents.width+1);
  assert.equal(changes.x,details.x);
  assert.ok(changes.width>agents.width);
  assert.ok(paneContentWidth(changes.width)>=36);
  assert.equal(canPreviewDiff(panes),true);
});

test('hidden or narrow Details do not request a diff', () => {
  assert.equal(canPreviewDiff([]),false);
  assert.equal(canPreviewDiff([pane({id:'details',width:70,height:1})]),false);
  assert.equal(canPreviewDiff([pane({id:'details',width:30,height:20})]),false);
  assert.equal(canPreviewDiff([pane({id:'details',width:45,height:10})]),true);
});

test('team reports share leftover height with agents; inspector is the only reserved detail budget', () => {
  const stacked=layoutWorkbench(30,24,state(),8);
  const agents=stacked.find(p=>p.id==='agents')!, details=stacked.find(p=>p.id==='details')!, changes=stacked.find(p=>p.id==='changes')!;
  assert.equal(changes.height,6);
  assert.ok(agents.height>=details.height,'many agents must not lose the tree to reserved inspector rows');
  const inspector=layoutWorkbench(30,24,{...state(),detailExpanded:true},1);
  assert.ok(inspector.find(p=>p.id==='details')!.height>inspector.find(p=>p.id==='changes')!.height);
});

test('both card lines map to one logical agent, never to the next agent', () => {
  const p=pane();
  assert.equal(paneItemAt(p,2,2),0);
  assert.equal(paneItemAt(p,2,3),0);
  assert.equal(paneItemAt(p,2,4),1);
  assert.equal(paneItemAt(p,2,5),1);
});

test('border, padding, blank body, titles and non-selectable rows do not select', () => {
  const p=pane({height:12});
  for (const [x,y] of [[0,2],[1,2],[28,2],[29,2],[2,1],[2,12],[2,6],[2,10]]) assert.equal(paneItemAt(p,x,y),undefined,`${x},${y}`);
  assert.equal(paneItemAt(pane({summary:true,rowItems:[null,null],contentLength:2}),2,2),undefined);
});

test('hit testing includes scrolling and does not mutate rectangles', () => {
  const p=pane({offset:2}); const snapshot=JSON.stringify(p);
  assert.equal(paneItemAt(p,2,2),1);
  assert.equal(paneItemAt(p,2,3),1);
  assert.equal(JSON.stringify(p),snapshot);
});

test('PageDown counts logical agents rather than card text lines', () => {
  assert.equal(panePageSize(pane({height:6,rowItems:[0,0,1,1,2,2]})),2);
  assert.equal(panePageSize(pane({height:6,rowItems:undefined})),4);
  assert.equal(panePageSize(pane({height:6,summary:true,rowItems:[null,null,null,null]})),4);
});

test('Git counts are workspace-wide and staged/unstaged overlap is explicit', () => {
  const files=[file({index:'M'}),file({path:'new',index:'?',worktree:'?',added:null,removed:null}),file({path:'conflict',index:'U',worktree:'U',conflict:true}),file({path:'image',binary:true})];
  const count=workspaceCounts(git(files));
  assert.deepEqual(count,{files:4,staged:1,unstaged:2,untracked:1,conflicts:1,binary:1});
  assert.deepEqual(workspaceSummary(git(files)),['! 1 conflict','4 files','1 staged','2 unstaged','1 untracked']);
});

test('missing Git evidence or a partial read must never be labelled clean', () => {
  assert.deepEqual(workspaceSummary(null),['Loading Git…']);
  assert.deepEqual(workspaceSummary({...git([]),root:null,error:'timeout'}),['Git unavailable']);
  assert.deepEqual(workspaceSummary(git([],'timeout')),['Git incomplete']);
  assert.deepEqual(workspaceSummary(git([])),['Working tree clean']);
  assert.equal(workspaceSummary(git([file()],'timeout'))[0],'Git incomplete');
});

test('native Git spawn text is rewritten before it can be drawn', () => {
  assert.equal(gitFailureNotice(undefined), undefined);
  assert.equal(gitFailureNotice('Git timed out'), 'Git timed out');
  assert.equal(gitFailureNotice('Git is not installed'), 'Git is not installed');
  const native = 'Command failed: git --no-optional-locks -c core.fsmonitor=false rev-parse --show-toplevel\nfatal: not a git repository';
  assert.equal(gitFailureNotice(native), 'Git could not complete the request');
  assert.equal(gitFailureNotice('spawn git ENOENT'), 'Git could not complete the request');
});

test('tool completion alone does not prove success or produce a pass rate', () => {
  assert.equal(toolResult(call()),'result unknown');
  assert.equal(toolResult(call({status:'running'})),'recorded running');
  assert.equal(toolResult(call({resultSuccess:true})),'reported success');
  assert.equal(toolResult(call({resultSuccess:false})),'reported error');
  assert.equal(toolResult(call({exitCode:17})),'exit 17');
});

test('use an observed command, not a tool name alone; inline code stays bounded by default', () => {
  assert.equal(toolCommand(call({arguments:{cmd:'npm test'}})),'npm test');
  assert.equal(toolCommand(call({arguments:{command:'git status',code:'lots of code'}})),'git status');
  assert.equal(toolCommand(call({arguments:{code:'const x = 1;\n'.repeat(100)}})),'exec · inline code');
  assert.equal(toolCommand(call({arguments:{code:'const x = 1;'} }),true),'const x = 1;');
});
