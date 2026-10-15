import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMonitorState, renderMonitor, handleMonitorInput, type MonitorState } from '../../src/render/monitor.js';
import { agentTitle, shownName } from '../../src/render/agent-title.js';
import { uniquePickerLabel } from '../../src/collectors/subagent-tree.js';
import { SETTING_ROWS, rowValue, withRowValue } from '../../src/render/settings-page.js';
import { defaultSettings } from '../../src/settings.js';
import { setLanguage, t } from '../../src/render/i18n.js';
import { stripAnsi } from '../../src/render/colors.js';
import type { AgentLogEntry } from '../../src/collectors/agent-log.js';
import type { WorkbenchEvent } from '../../src/render/workbench-state.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const now = Date.parse('2026-10-04T10:00:00Z');
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const agent = (i: number, name: string, extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode => ({
  id: id(i),
  name,
  nickname: name,
  status: 'running',
  depth: 1,
  children: [],
  startedAt: new Date(now - 600_000),
  turnStartedAt: new Date(now - 60_000),
  lastEventAt: new Date(now - 5000),
  ...extra,
});
const tree = (nodes: SubagentTreeNode[]): SubagentTree => ({
  rootId: 'root',
  nodes,
  totalCount: nodes.length,
  updatedAt: new Date(now),
});
const labelled = agent(1, 'cache_cleanup_reviewer', {
  label: '缓存清理复核',
  task: 'Write the cache cleanup audit handoff',
});
const waiting = agent(2, 'db_index_service', { task: 'Write the index service handoff' });
const old = agent(3, 'session_restart_recovery', {
  label: '会话重启恢复',
  task: 'Recover from a session restart',
  status: 'completed',
  statusAt: new Date(now - 3600_000),
  lastEventAt: new Date(now - 3600_000),
});
const nodes = [labelled, waiting, old];
const state = (labelAsName: boolean, extra: Partial<MonitorState> = {}): MonitorState => ({
  ...initialMonitorState(),
  style: 'rich',
  labelAsName,
  ...extra,
  tree: { ...initialMonitorState().tree, showAll: true, selectedId: labelled.id, ...extra.tree },
});
const draw = (s: MonitorState, extra = {}) =>
  renderMonitor({ tree: tree(nodes), state: s, width: 56, height: 44, nowMs: now, ...extra }).lines.map(stripAnsi);

test('agent names is one row among the model features, over labels and label as name, both on by default', () => {
  const row = SETTING_ROWS.find((entry) => entry.key === 'agentLabels')!;
  assert.equal(row.group, 'LLM');
  assert.equal(row.label, 'Agent names');
  assert.ok(!SETTING_ROWS.some((entry) => entry.key === 'labelAsName'), 'no row of its own');
  assert.equal(defaultSettings().labelAsName, true);
  assert.equal(defaultSettings().agentLabels, true);
  assert.equal(rowValue(row, defaultSettings()), 'name');
  assert.equal(rowValue(row, { ...defaultSettings(), labelAsName: false }), 'line');
  assert.equal(rowValue(row, { ...defaultSettings(), agentLabels: false }), 'off');
  const off = withRowValue(defaultSettings(), row, 'off');
  assert.deepEqual([off.agentLabels, off.labelAsName], [false, true], 'off keeps where a label would go');
  const line = withRowValue(off, row, 'line');
  assert.deepEqual([line.agentLabels, line.labelAsName], [true, false]);
  const previous = setLanguage('zh');
  try {
    assert.equal(t('Agent names'), 'Agent 名称');
    assert.equal(t('under name'), '写在名字下');
  } finally {
    setLanguage(previous);
  }
});

test('the title: with the setting on a label is the name, the task goes under it, and the name Codex prints is kept', () => {
  assert.deepEqual(agentTitle(labelled, true), {
    name: '缓存清理复核',
    task: 'Write the cache cleanup audit handoff',
    renamed: false,
    original: 'cache_cleanup_reviewer',
  });
  assert.deepEqual(agentTitle(labelled, false), {
    name: 'cache_cleanup_reviewer',
    task: '缓存清理复核',
    renamed: true,
  });
  assert.equal(agentTitle(waiting, true).name, 'db_index_service', 'before a label arrives, the name');
  assert.equal(
    shownName({ ...waiting, label: 'db_index_service' }, true),
    'db_index_service',
    'a label that is the name is no label'
  );
});

test("cards and rows show the label in the name's place; closed, no task line under it", () => {
  const on = draw(state(true));
  assert.ok(
    on.some((line) => /^› ▸ 缓存清理复核 ─+/.test(line)),
    on.join('\n')
  );
  assert.ok(
    on.some((line) => /^[┌›] ✓ 会话重启恢复 /.test(line)),
    'a finished row too'
  );
  assert.ok(
    on.some((line) => /^┌ ▸ db_index_service ─+/.test(line)),
    'no label yet: the name'
  );
  const at = on.findIndex((line) => line.includes('缓存清理复核'));
  assert.match(on[at + 1], /^└ /, 'closed, under the label no task cut to a line, and not the label again');
  assert.ok(
    !on.some((line) => line.includes('cache_cleanup_reviewer')),
    'closed, the name Codex prints is not repeated'
  );
  const off = draw(state(false));
  assert.ok(off.some((line) => /^› ▸ cache_cleanup_reviewer ─+/.test(line)));
  assert.equal(off[off.findIndex((line) => line.includes('cache_cleanup_reviewer')) + 1].trimEnd(), '│ 缓存清理复核');
});

test('an opened card and the Inspector keep the name Codex prints', () => {
  const opened = draw(state(true, {cardVisibility:{cardOriginalName:true}}));
  assert.ok(
    opened.some((line) => line.trimEnd() === '│ name cache_cleanup_reviewer'),
    opened.join('\n')
  );
  const inspector = draw(state(true, { modes: { ...initialMonitorState().modes, details: 'open' }, preview: 'agent' }));
  const heading = inspector.findIndex((line) => line.includes('│ 缓存清理复核'));
  assert.ok(heading > 0, inspector.join('\n'));
  assert.match(inspector[heading + 1], /│ name cache_cleanup_reviewer/);
  const previous = setLanguage('zh');
  try {
    const zh = draw(state(true, { modes: { ...initialMonitorState().modes, details: 'open' }, preview: 'agent' }));
    assert.ok(zh.some((line) => line.includes('原名 cache_cleanup_reviewer')));
  } finally {
    setLanguage(previous);
  }
});

test('the compact tree and the timeline show the label too', () => {
  const compact = draw({ ...state(true), style: 'compact' });
  assert.ok(
    compact.some((line) => /^›▸ 缓存清理复核/.test(line)),
    compact.join('\n')
  );
  assert.ok(draw({ ...state(false), style: 'compact' }).some((line) => /^›▸ cache_cleanup_reviewer/.test(line)));
  const event: WorkbenchEvent = {
    id: 'e',
    at: new Date(now - 60_000),
    title: '',
    detail: [],
    status: 'running',
    kind: 'agent-started',
    subject: 'cache_cleanup_reviewer',
    agentId: labelled.id,
  };
  const timeline = (labelAsName: boolean) =>
    draw(state(labelAsName, { modes: { ...initialMonitorState().modes, timeline: 'open' } }), {
      timeline: [event],
    }).join('\n');
  assert.match(timeline(true), /1m ├─▸ 缓存清理复核/);
  assert.match(timeline(false), /1m ├─▸ cache_cleanup_reviewer/);
});

test('switching goes by the name the picker prints, never by the label', () => {
  const agents = tree(nodes);
  assert.equal(uniquePickerLabel(agents, labelled.id), 'cache_cleanup_reviewer');
  assert.ok(!(uniquePickerLabel(agents, labelled.id) ?? '').includes('决策'));
  // A click on the card's name selects that agent by its id. A second click switches.
  const s = state(true);
  const frame = renderMonitor({ tree: agents, state: s, width: 56, height: 44, nowMs: now });
  const control = frame.controls.find((c) => c.kind === 'switch' && c.item === labelled.id)!;
  const out = handleMonitorInput(
    frame.state,
    { type: 'mouse', button: 'left', x: control.x, y: control.y },
    { tree: agents, frame, nowMs: now }
  );
  assert.deepEqual(out.action, { type: 'pick', id: labelled.id });
  assert.equal(out.state.tree.selectedId, labelled.id);
  assert.equal(out.state.modes.details, 'closed');
  const key = handleMonitorInput(
    frame.state,
    { type: 'key', key: 'open-session' },
    { tree: agents, frame, nowMs: now }
  );
  assert.deepEqual(key.action, { type: 'switch', id: labelled.id });
});

test("a finished row's brief line, under its label", () => {
  const log = new Map<string, AgentLogEntry[]>([
    [old.id, [{ at: now - 3600_000, kind: 'note', text: 'socket 检查改为 stat()' }]],
  ]);
  const lines = draw(state(true), { agentLog: log });
  const at = lines.findIndex((line) => line.includes('会话重启恢复'));
  assert.equal(lines[at + 1].trimEnd(), '│ socket 检查改为 stat()');
});

 test('card label visibility is local: Codex names for L1 and child, smart names remain in other views', () => {
  const child = agent(8,'original_child',{depth:2,label:'smart_child',taskKind:'review'});
  const lead = {...labelled,children:[child]};
  const agents = tree([lead]);
  const frame = renderMonitor({tree:agents,state:state(true,{cardVisibility:{cardLabel:false,cardOriginalName:true}}),width:56,height:44,nowMs:now});
  const text = frame.lines.map(stripAnsi).join('\n');
  assert.ok(text.includes('cache_cleanup_reviewer') && text.includes('original_child'));
  assert.ok(!/缓存清理复核|smart_child|name cache_cleanup/.test(text),text);
  assert.equal(agentTitle(lead,true).name,'缓存清理复核');
  const compact = renderMonitor({tree:agents,state:{...frame.state,style:'compact'},width:56,height:44,nowMs:now}).lines.map(stripAnsi).join('\n');
  assert.ok(compact.includes('缓存清理复核'));
 });
