import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkbenchHistory } from '../../src/collectors/workbench-events.js';
import { initialMonitorState, renderMonitor, handleMonitorInput, monitorSettings, TIMELINE_EARLIER, type MonitorData, type MonitorState } from '../../src/render/monitor.js';
import { directions, roleSet, subtaskRoles, isImportant } from '../../src/render/directions.js';
import { displayConfig, setDisplayConfig } from '../../src/render/hud-config.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { SETTING_ROWS, rowValues } from '../../src/render/settings-page.js';
import { defaultSettings } from '../../src/settings.js';
import type { AgentLogEntry } from '../../src/collectors/agent-log.js';
import type { AgentStage, SubagentStatus, SubagentTree, SubagentTreeNode } from '../../src/types.js';
import type { WorkbenchEvent } from '../../src/render/workbench-state.js';

const NOW = Date.parse('2026-10-05T10:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);
const stage = (start: number, end: number | undefined, status: AgentStage['status'], extra: Partial<AgentStage> = {}): AgentStage =>
  ({ startedAt: ago(start), ...(end !== undefined ? { endedAt: ago(end) } : {}), status, ...extra });
const node = (id: string, name: string, status: SubagentStatus, extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode =>
  ({ id, name, status, depth: 1, children: [], ...extra });
/** An L2: one stage, from its start to its end. */
const kid = (id: string, name: string, role: string, status: SubagentStatus, start: number, end?: number, result?: string): SubagentTreeNode =>
  node(id, name, status, { depth: 2, role, startedAt: ago(start), ...(end !== undefined ? { statusAt: ago(end) } : {}), agentPath: `/root/lead/${name}`,
    stages: [stage(start, end, status === 'running' ? 'running' : status === 'error' ? 'failed' : 'done', result ? { result } : {})] });

/** A made-up session: two leads with subtasks, a critic working for one of them, a writer from hours ago. */
function session(): SubagentTree {
  const parser = node('p1', 'parser_lead', 'running', { startedAt: ago(200), agentPath: '/root/parser_lead', peers: { '/root/critic': 3 },
    stages: [
      stage(200, 150, 'done', { result: 'Mapped the parser.' }),
      stage(70, 40, 'done', { result: 'Rewrote error recovery in the parser; 3 of 3 new tests pass. Streaming next, after the critic signs off on the token boundaries.' }),
      stage(12, undefined, 'running', { intent: 'I will wire the streaming API through the new recovery path and benchmark it against the old one.' }),
    ],
    children: [
      kid('p1a', 'impl_recovery', 'implementer', 'completed', 65, 50),
      kid('p1b', 'review_recovery', 'reviewer', 'completed', 48, 42, 'Two nits; ship it.'),
      kid('p1c', 'scout_streams', 'scout', 'error', 45, 41),
      kid('p1d', 'impl_stream', 'implementer', 'running', 10),
    ] });
  const bench = node('b1', 'bench_lead', 'completed', { startedAt: ago(130), statusAt: ago(20), agentPath: '/root/bench_lead',
    stages: [stage(130, 20, 'done', { result: 'ASCII 1.8 GB/s, CJK 0.6 GB/s.' })],
    children: [kid('b1a', 'bench_ascii', 'implementer', 'completed', 120, 90), kid('b1b', 'bench_cjk', 'implementer', 'completed', 100, 25)] });
  const critic = node('c1', 'critic', 'completed', { startedAt: ago(60), statusAt: ago(30), agentPath: '/root/critic', peers: { '/root/parser_lead': 2 },
    stages: [stage(60, 30, 'done', { by: { type: 'MESSAGE', sender: '/root/parser_lead' }, result: 'Token boundaries hold.' })] });
  const docs = node('d1', 'docs_writer', 'completed', { startedAt: ago(400), statusAt: ago(300), agentPath: '/root/docs_writer',
    stages: [stage(400, 300, 'done', { result: 'Added docs/streaming.md.' })] });
  return { rootId: 'root', nodes: [docs, parser, bench, critic], totalCount: 12, updatedAt: new Date(NOW) };
}
const MAIN = { events: [
  { kind: 'turn-finished' as const, at: ago(4), text: 'The recovery rewrite is in.' },
  { kind: 'compacted' as const, at: ago(90) },
  { kind: 'turn-finished' as const, at: ago(250), text: 'Docs are in.' },
  { kind: 'turn-finished' as const, at: ago(320) }, { kind: 'turn-finished' as const, at: ago(330) },
], toolActivity: { recentCalls: [], totalCalls: 0, callsByType: {} } } as never;

function events(tree: SubagentTree, logs = new Map<string, AgentLogEntry[]>()): WorkbenchEvent[] {
  return new WorkbenchHistory().timeline(tree, MAIN, logs);
}
const opened = (extra: Partial<MonitorState> = {}): MonitorState =>
  ({ ...initialMonitorState(), modes: { agents: 'closed', timeline: 'open', changes: 'closed', details: 'closed' }, focus: 'timeline', ...extra });
function draw(data: Partial<MonitorData> & { tree: SubagentTree }, state = opened(), width = 40): string[] {
  return renderMonitor({ state, width, height: 60, nowMs: NOW, timeline: events(data.tree), ...data }).lines.map(stripAnsi);
}
/** The pane's rows, without its gutter. */
const rows = (lines: string[]) => lines.filter(line => line.startsWith('│ ')).map(line => line.slice(2).trimEnd()).filter(Boolean);
const withGlyphs = <T>(glyphs: 'both' | 'text', run: () => T): T => {
  const previous = displayConfig();
  setDisplayConfig({ glyphs });
  try { return run(); } finally { setDisplayConfig(previous); }
};

test('an L1\'s stage is a line off the main session\'s rail at its end: how long it took, the subtasks it saw finish, and, its newest, what it returned', () => {
  const tree = session();
  const shown = rows(draw({ tree }));
  const at = (pattern: RegExp) => shown.findIndex(line => pattern.test(line));
  // Running: at its start, its clock face, what it said it would do in two lines at most.
  const running = at(/^12m ├─▸ parser_lead +◷$/);
  assert.ok(running >= 0, shown.join('\n'));
  assert.match(shown[running + 1], /^ +│ +I will wire the streaming API/);
  assert.match(shown[running + 2], / …$/, 'cut, and said so');
  assert.doesNotMatch(shown[running + 3], /^ +│ {4}\S/, 'two lines');
  assert.ok(at(/^20m ├─✓ bench_lead +✓2 1h$/) >= 0, 'the two benchmarks finished while it ran');
  const rewrite = at(/^40m ├─✓ parser_lead +✓2 ✗1 30m$/);
  assert.ok(rewrite >= 0, 'two subtasks done and one failed during the stage');
  assert.deepEqual(shown.slice(rewrite + 1, rewrite + 4).map(line => line.trim()),
    ['│    Rewrote error recovery in the', '│    parser; 3 of 3 new tests', '│    pass. Streaming next, after …'], 'three lines, the last cut');
  const first = at(/^ 2h ├─✓ parser_lead +50m$/);
  assert.ok(first >= 0);
  assert.doesNotMatch(shown[first + 1], /Mapped/, 'an earlier stage is a line of its own, no more');
  assert.ok(at(/⏎ The recovery rewrite is in\./) >= 0, 'a finished turn says what it told the person');
});

test('a stage counts the subtasks under its agent at any depth, as the agent\'s card does', () => {
  const tree = session();
  const deep = (id: string, name: string, status: SubagentStatus, start: number, end: number): SubagentTreeNode =>
    ({ ...kid(id, name, 'implementer', status, start, end), depth: 3 });
  const nodes = tree.nodes.map(item => item.id !== 'b1' ? item : { ...item, children: [
    { ...item.children[0], children: [deep('b1a1', 'bench_simd', 'completed', 110, 95), deep('b1a2', 'bench_wide', 'error', 105, 92)] },
    ...item.children.slice(1),
  ] });
  const shown = rows(draw({ tree: { ...tree, nodes } }));
  assert.ok(shown.some(line => /^20m ├─✓ bench_lead +✓3 ✗1 1h$/.test(line)), shown.join('\n'));
});

test('of the L2s only those that matter get a line, at their end: failed, in a role the reader named, or flagged', () => {
  const tree = session();
  const plain = rows(draw({ tree })).join('\n');
  assert.match(plain, /41m │ ╰✗ scout_streams +4m/);
  assert.doesNotMatch(plain, /impl_recovery|review_recovery|impl_stream|bench_ascii/, 'routine and running subtasks are counts on their lead\'s line');
  const named = rows(draw({ tree }, opened({ importantRoles: roleSet('critic, reviewer') }))).join('\n');
  assert.match(named, /42m │ ╰✓ review_recovery +6m\n +│ +Two nits; ship it\./, 'a named role, with its result in a line');
  const flagged = rows(draw({ tree, agentLog: new Map([['p1a', [{ at: ago(50).getTime(), kind: 'note', text: 'needs a look', attention: true }]]]) })).join('\n');
  assert.match(flagged, /╰✓ impl_recovery/, 'one the brief flagged');
});

test('a helper\'s stage is in the colour of the lead it worked for, and says whom it was for', () => {
  const tree = session();
  const dirs = directions(tree);
  assert.equal(dirs.serves.get('c1'), 'p1', 'three messages with the parser lead make the critic its helper');
  assert.equal(dirs.paint('c1'), dirs.paint('p1'));
  assert.notEqual(dirs.paint('b1'), dirs.paint('p1'), 'two leads at work together, two colours');
  assert.match(rows(draw({ tree })).join('\n'), /30m ├─✓ critic → parser_lead +30m/);
});

test('a staged agent\'s failure the log saw is its stage\'s end: one line, with the cause', () => {
  const tree = session();
  const logs = new Map<string, AgentLogEntry[]>([['p1c', [{ at: ago(41).getTime(), kind: 'failed', text: '' }]]]);
  const timeline = events(tree, logs).map(event => event.kind === 'agent-failed' ? { ...event, cause: 'The scout hit the rate limit.' } : event);
  assert.ok(timeline.some(event => event.kind === 'agent-failed'), 'the log\'s failure is kept for its cause');
  const shown = rows(draw({ tree, timeline })).join('\n');
  assert.equal(shown.match(/scout_streams/g)?.length, 1, shown);
  assert.match(shown, /╰✗ scout_streams +4m\n +│ {4}~ The scout hit the rate\n +│ {6}limit\./, 'marked as a model\'s');
});

test('the window: the newest hours, at least eight entries, a running stage wherever it started, then a row that brings back twenty at a time', () => {
  const tree = session();
  // Six entries in the last hour, two more to make eight, three earlier.
  const shown = draw({ tree }, opened({ timelineHours: 1 }));
  const lines = rows(shown);
  assert.equal(lines.at(-1)?.trim(), '▸ 3 earlier', lines.join('\n'));
  assert.match(lines.at(-2)!, /^ 2h ├─✓ parser_lead/);
  const title = (lines: string[]) => lines.find(line => /Timeline +\d+ events/.test(line)) ?? '';
  assert.match(title(shown), /8 events/, 'the title counts the entries shown');
  const day = draw({ tree }, opened({ timelineHours: 24 }));
  assert.ok(!rows(day).some(line => /earlier/.test(line)));
  assert.match(title(day), /11 events/);
  // A stage still running shows, however long ago it started.
  const long = session();
  long.nodes[1].stages![2] = stage(150, undefined, 'running', { intent: 'Long haul.' });
  const kept = rows(draw({ tree: long }, opened({ timelineHours: 1 })));
  const tail = kept.slice(-4).join('\n');
  assert.match(tail, /^ 2h ├─✓ parser_lead +50m\n +├─▸ parser_lead +✓2 ✗1 ◉\n +│ +Long haul\.\n +▸ 3 earlier$/, 'after the window, before the earlier row; past the hour, the full clock');
  // Enter on the timeline, or a click on the row, brings back twenty more.
  const frame = renderMonitor({ tree, state: opened({ timelineHours: 1 }), width: 40, height: 60, nowMs: NOW, timeline: events(tree) });
  const more = handleMonitorInput(opened({ timelineHours: 1 }), { type: 'key', key: 'enter' }, { tree, frame, nowMs: NOW }).state;
  assert.equal(more.timelineMore, 20);
  assert.ok(!rows(draw({ tree }, more)).some(line => /earlier/.test(line)), 'everything now');
  const pane = frame.panes.find(p => p.id === 'timeline')!;
  const y = pane.y + 1 + pane.rows.findIndex(row => row.item === TIMELINE_EARLIER) - pane.offset;
  const clicked = handleMonitorInput(opened({ timelineHours: 1 }), { type: 'mouse', button: 'left', x: 6, y }, { tree, frame, nowMs: NOW }).state;
  assert.equal(clicked.timelineMore, 20);
  const none = handleMonitorInput(more, { type: 'key', key: 'enter' }, { tree, frame: renderMonitor({ tree, state: more, width: 40, height: 60, nowMs: NOW, timeline: events(tree) }), nowMs: NOW }).state;
  assert.equal(none.timelineMore, 20, 'nothing earlier, nothing to bring back');
  assert.equal(none.modes.details, 'closed', 'Enter on the timeline opens no Inspector');
});

test('every style draws the levels within the width, in glyphs and words, English and Chinese', () => {
  const tree = session();
  for (const style of ['rail', 'indent', 'lanes'] as const) {
    for (const width of [24, 28, 32, 40, 48, 56]) {
      for (const glyphs of ['both', 'text'] as const) {
        for (const language of ['en', 'zh'] as const) {
          const previous = setLanguage(language);
          try {
            const frame = withGlyphs(glyphs, () => renderMonitor({ tree, state: opened({ timelineStyle: style }), width, height: 60, nowMs: NOW, timeline: events(tree) }));
            for (const line of frame.lines) assert.ok(visualLength(line) <= width, `${style} ${width} ${glyphs} ${language}: ${stripAnsi(line)}`);
          } finally { setLanguage(previous); }
        }
      }
    }
  }
  const indent = rows(draw({ tree }, opened({ timelineStyle: 'indent' }))).join('\n');
  assert.match(indent, /^20m {3}✓ bench_lead/m, 'an L1 a level in');
  assert.match(indent, /^41m {5}✗ scout_streams/m, 'an L2 two');
  const lanes = rows(draw({ tree }, opened({ timelineStyle: 'lanes' })));
  assert.match(lanes.find(line => line.includes('bench_lead'))!, /^20m │ │ ✓ bench_lead/, 'the axis, the parser lane still at work, then the bench lane');
  assert.match(lanes.find(line => line.includes('critic'))!, /^30m │ ✓ {3}critic/, 'a helper in its lead\'s lane');
});

test('the timeline settings: a style, a window, the roles that matter; each validated and given to the panel', () => {
  const settings = { ...defaultSettings(), timelineStyle: 'lanes' as const, timelineHours: 12 as const, importantRoles: 'reviewer, critic' };
  const state = monitorSettings(settings);
  assert.equal(state.timelineStyle, 'lanes');
  assert.equal(state.timelineHours, 12);
  assert.deepEqual([...state.importantRoles!], ['reviewer', 'critic']);
  assert.equal(defaultSettings().timelineStyle, 'rail');
  assert.equal(defaultSettings().timelineHours, 3);
  assert.equal(defaultSettings().importantRoles, '');
  const rows = SETTING_ROWS.filter(row => row.key === 'timelineStyle' || row.key === 'timelineHours');
  assert.deepEqual(rows.map(row => row.values), [['rail', 'indent', 'lanes'], [1, 3, 6, 12, 24]]);
  // Key roles, on the page: none, the roles the subtasks have, the most used first, and a list set in the file.
  const row = SETTING_ROWS.find(row => row.key === 'importantRoles')!;
  assert.equal(row.group, 'Agents');
  const roles = subtaskRoles(session());
  assert.deepEqual(roles, ['implementer', 'reviewer', 'scout'], 'the subtasks\' roles, not the leads\'');
  assert.deepEqual(rowValues(row, { draft: settings, original: settings, roles }), ['', 'implementer', 'reviewer', 'scout', 'reviewer, critic']);
  // Said as the cards say them, the prefix every role shares left out, and each a name that matches its role.
  const team = session();
  const prefixed = (kids: SubagentTreeNode[]) => kids.map(child => ({ ...child, role: `team-${child.role}` }));
  team.nodes[1] = { ...team.nodes[1], children: [...prefixed(team.nodes[1].children),
    kid('p1e', 'critic_tokens', 'team-perf-critic', 'completed', 30, 20), kid('p1f', 'helper', 'default', 'completed', 30, 20)] };
  team.nodes[2] = { ...team.nodes[2], children: prefixed(team.nodes[2].children) };
  assert.deepEqual(subtaskRoles(team), ['implementer', 'perf-critic', 'reviewer', 'scout'], 'Codex\'s default agent has no role to name');
  assert.ok(isImportant(team.nodes[1].children[4], undefined, roleSet('perf-critic')));
});

test('a running stage\'s event carries what the agent said it would do; an ended one, what it returned', () => {
  const timeline = events(session());
  const running = timeline.find(event => event.kind === 'agent-stage' && event.stage === 'running' && event.agentId === 'p1')!;
  assert.match(running.intent!, /^I will wire/);
  assert.equal(running.at.getTime(), ago(12).getTime(), 'at its start');
  const ended = timeline.find(event => event.kind === 'agent-stage' && event.agentId === 'b1')!;
  assert.equal(ended.intent, undefined);
  assert.equal(ended.summary, 'ASCII 1.8 GB/s, CJK 0.6 GB/s.');
  assert.equal(ended.at.getTime(), ago(20).getTime(), 'at its end');
  assert.equal(timeline.find(event => event.agentId === 'c1')?.serves, 'p1');
});

test('a failed tool call is named by the command it ran: an exec script\'s first, a shell call\'s own, else the tool', () => {
  const call = (id: string, name: string, args: Record<string, unknown>, minutes: number) =>
    ({ id, name, arguments: args, timestamp: ago(minutes), status: 'error' as const, duration: 1000 });
  const main = { events: [], toolActivity: { recentCalls: [
    call('x1', 'exec', { code: '// look for the cut\nconst hits = await tools.exec_command({ cmd: "rg -n surrogate src", yield_time_ms: 1000 });' }, 3),
    call('x2', 'shell', { command: ['npm', 'test'] }, 2),
    call('x3', 'apply_patch', {}, 1),
  ], totalCalls: 3, callsByType: {} } } as never;
  const timeline = new WorkbenchHistory().timeline({ rootId: 'root', nodes: [], totalCount: 0, updatedAt: new Date(NOW) }, main, new Map());
  assert.deepEqual(timeline.filter(event => event.kind === 'tool-failed').map(event => event.subject), ['apply_patch', 'npm test', 'rg -n surrogate src']);
  const shown = rows(draw({ tree: { rootId: 'root', nodes: [], totalCount: 0, updatedAt: new Date(NOW) }, timeline }));
  assert.ok(shown.some(row => /✗ rg -n surrogate src/.test(row)), shown.join('\n'));
});
