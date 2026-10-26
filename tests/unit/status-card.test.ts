import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMonitorState, renderMonitor, handleMonitorInput, type MonitorState, type MonitorFrame, type MonitorData } from '../../src/render/monitor.js';
import { shownLevel, nextLevel } from '../../src/render/status-foot.js';
import { stripAnsi, visualLength, theme, colors } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';
import { displayConfig, setDisplayConfig } from '../../src/render/hud-config.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import type { Recap } from '../../src/collectors/recap.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';
import { useDisplayFixture } from '../fixtures/display.js';

useDisplayFixture();

const now = Date.parse('2026-10-04T10:00:00Z');
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const agent = (i: number): SubagentTreeNode => ({ id: id(i), name: `worker_${i}`, status: 'running', depth: 1, children: [],
  startedAt: new Date(now - 600_000), turnStartedAt: new Date(now - 60_000), lastEventAt: new Date(now - 5000), task: `Task number ${i}` });
const tree = (n: number): SubagentTree => ({ rootId: 'root', nodes: Array.from({ length: n }, (_, i) => agent(i + 1)), totalCount: n, updatedAt: new Date(now) });
const recap: Recap = { goal: 'Fix the flaky cache test in the parser', done: ['Reproduced the failure', 'Found the race'],
  now: 'Waiting on reader agent', needs: '', at: now - 5 * 60_000, coveredUntil: now, sessionId: 's', language: 'en' };
const status: MonitorData['status'] = () => ({ tone: 'needs', busy: true, alerts: ['! 1 agent failed'], state: '▸ exec · 33m51s', rate: '', tasks: '',
  model: '☀', age: '2h', context: { percent: 61, tail: '246K' }, place: 'proj · main', project: 'proj', branch: '· main',
  quota: { percent: 20, window: '7d', spent: '', text: '7d 20%' }, others: '', forecast: '', reset: '', cache: '' });
const session = (attention = false): MonitorData['session'] => () =>
  attention ? { text: '! waiting for approval 2m', attention: true } : { text: '▸ 33m51s', attention: false };
const rich = (extra: Partial<MonitorState> = {}): MonitorState => ({ ...initialMonitorState(), style: 'rich', ...extra });
const plain = (frame: MonitorFrame) => frame.lines.map(stripAnsi);
const draw = (state: MonitorState, extra: Partial<MonitorData> = {}, width = 48, height = 40) =>
  renderMonitor({ tree: tree(3), state, width, height, nowMs: now, status, session: session(), brief: { recap, structured: true, text: '{}', at: now }, ...extra });
/** The card's lines, by the frame's own record of where it sits. */
const card = (frame: MonitorFrame) => plain(frame).slice(frame.statusCard!.y, frame.statusCard!.y + frame.statusCard!.height);
const withGlyphs = <T>(glyphs: 'glyph' | 'text' | 'both', run: () => T): T => {
  const previous = displayConfig();
  // Words in place of marks are the icons' setting; the model badge is the glyphs'. Text here means both.
  setDisplayConfig(glyphs === 'text' ? { glyphs, icons: 'text' } : { glyphs });
  try { return run(); } finally { setDisplayConfig(previous); }
};

test('rich: min is the band alone, status the band and the corner round the alerts, full the brief between them too, at 40, 56 and 90 columns; 32 and under draw min', () => {
  for (const width of [24, 32]) {
    for (const statusLevel of ['min', 'status', 'full'] as const) {
      const frame = draw(rich({ statusLevel }), {}, width);
      assert.equal(card(frame).length, 1, `${width} ${statusLevel} draws the band alone`);
      assert.equal(frame.state.statusLevel, statusLevel, 'drawing does not rewrite the saved level');
    }
  }
  for (const width of [40, 56, 90]) {
    const min = draw(rich({ statusLevel: 'min' }), {}, width);
    const status = draw(rich({ statusLevel: 'status' }), {}, width);
    const full = draw(rich({ statusLevel: 'full' }), {}, width);
    for (const frame of [min, status, full]) assert.ok(frame.lines.every(line => visualLength(line) === width), `${width}`);

    const one = card(min);
    assert.equal(one.length, 1, `${width}: min is one line`);
    assert.match(one[0], /^ ! ▸ exec · 33m51s .* $/, `${width}: ${one[0]}`);

    const box = card(status);
    assert.equal(box.length, 3, `${width}: the band, the alert and the corner`);
    assert.ok(box[0].startsWith(' ! ▸ exec · 33m51s'), `${width}: ${box[0]}`);
    assert.match(box.at(-1)!, /^╰─ proj (· main )?(7d )?─*20%─+$/, box.at(-1)!);
    assert.equal(box[1].trimEnd(), '│ ! 1 agent failed');

    const lines = card(full);
    assert.equal(lines[1], box[1], `${width}: the alerts come first`);
    assert.match(lines[2], /^│ ◎ Fix the flaky/, `${width}: ${lines[2]}`);
    assert.ok(lines.some(line => /^│ ✓ Reproduced/.test(line)), `${width}`);
    assert.equal(lines.at(-1), box.at(-1));
    if (width >= 40) assert.match(lines[0], / ~5m $/, `${width}: the brief's state is data at the band's end`);
    assert.ok(!lines[0].includes('b‖') && !lines[0].includes(', ?'), 'no switch and no hints on the card');
  }
  assert.ok(card(draw(rich({ statusLevel: 'min' }), {}, 60))[0].includes('7d 20%'), 'min carries the quota reading');
  assert.ok(card(draw(rich({ statusLevel: 'status' }), {}, 60))[0].includes('~5m'), 'status carries the brief\'s state too');
});

test('the brief\'s fields sit inline behind icons, or behind words padded to one column with glyphs off', () => {
  const full = (glyphs: 'glyph' | 'text', width = 44) => withGlyphs(glyphs, () => card(draw(rich({ statusLevel: 'full' }), { brief: { recap: { ...recap, needs: 'Approve npm test' } } }, width)));
  const icons = full('glyph').slice(2, -1).map(line => line.slice(2).trimEnd());
  assert.deepEqual(icons, ['! Approve npm test', '◎ Fix the flaky cache test in the parser', '▸ Waiting on reader agent', '✓ Reproduced the failure', '  Found the race']);
  const words = full('text').slice(2, -1).map(line => line.slice(2).trimEnd());
  assert.deepEqual(words, ['Needs Approve npm test', 'Goal  Fix the flaky cache test in the', '      parser', 'Now   Waiting on reader agent',
    'Done  ✓ Reproduced the failure', '      ✓ Found the race']);
  assert.match(withGlyphs('text', () => card(draw(rich({ statusLevel: 'full' }), {}, 80)))[0], / ~5m ago $/);
  // The Chinese labels line up on display columns.
  const previous = setLanguage('zh');
  try {
    const zh = full('text', 50).slice(2, -1).map(line => line.slice(2));
    const valueColumn = (line: string) => visualLength(line.match(/^\S+ +/)?.[0] ?? '');
    assert.equal(new Set(zh.filter(line => !line.startsWith(' ')).map(valueColumn)).size, 1, zh.join('\n'));
  } finally { setLanguage(previous); }
  // With the agents using every row: each value two lines at most; Done shows the newest two and counts the rest.
  const long: Recap = { ...recap, goal: 'word '.repeat(40), done: ['a', 'b', 'c', 'd', 'e'] };
  const cut = card(draw(rich({ statusLevel: 'full' }), { brief: { recap: long }, tree: tree(12) }, 44));
  assert.equal(cut.filter(line => /^│ [◎ ] +word/.test(line)).length, 2);
  assert.ok(cut.some(line => /word.* …$/.test(line.trimEnd())));
  const done = cut.findIndex(line => line.startsWith('│ ✓'));
  assert.deepEqual(cut.slice(done, done + 2).map(line => line.slice(2).trimEnd()), ['✓ d', '  e +3'], 'the ✓ heads the first item, the rest hang under it');
  // Spare agent rows never change the recap shape.
  assert.deepEqual(card(draw(rich({ statusLevel: 'full' }), { brief: { recap: long } }, 44)), cut);
});

test('rich frames carry the recap only inside the status card; no brief rule, no recap card', () => {
  for (const statusLevel of ['min', 'status', 'full'] as const) {
    const frame = draw(rich({ statusLevel }));
    const above = plain(frame).slice(0, frame.statusCard!.y);
    assert.ok(!above.some(line => /Goal|Main recap|Brief|Reproduced|Waiting on reader/.test(line)), statusLevel);
  }
  // Absent is full.
  assert.equal(shownLevel(rich()), 'full');
  assert.ok(card(draw(rich())).some(line => line.includes('Fix the flaky')));
});

test('full with no recap: the whole-picture sentence as Now, a failure or a reply in another shape; with nothing, it is status', () => {
  const status = card(draw(rich({ statusLevel: 'status' })));
  assert.deepEqual(card(draw(rich({ statusLevel: 'full' }), { brief: undefined })).slice(1), status.slice(1), 'no backend, no approval words: status');
  assert.deepEqual(card(draw(rich({ statusLevel: 'full' }), { brief: {} })).slice(1), status.slice(1), 'a backend with nothing yet: status, its switch aside');

  const failed = draw(rich({ statusLevel: 'full' }), { brief: { error: 'quota exhausted' } }, 44);
  const lines = card(failed);
  assert.match(lines[0], / failed $/, lines[0]);
  assert.ok(failed.lines[failed.statusCard!.y].includes(theme.warning('failed')), 'in words: a lone ✗ said nothing');
  assert.ok(lines.some(line => line.includes('quota exhausted')), 'the error itself has a home');

  const odd = card(draw(rich({ statusLevel: 'full' }), { brief: { text: 'All three agents look fine.', at: now } }));
  assert.ok(odd.some(line => line.includes('All three agents look fine.')), 'a non-JSON reply is shown as it is');

  const overall = card(draw(rich({ statusLevel: 'full' }), { brief: { recap, overall: 'Two running, one waiting', structured: true, text: '{}', at: now } }));
  assert.ok(!overall.some(line => line.includes('Two running')), 'with a recap the sentence repeats Now: dropped');
  const alone = card(draw(rich({ statusLevel: 'full' }), { brief: { overall: 'Two running, one waiting', structured: true, text: '{}', at: now } }));
  assert.ok(alone.some(line => /^│ ▸ Two running/.test(line)), 'without one it stands in Now\'s place');

  // The approval words lead, and they are shown with no brief configured too, with no switch then.
  const approval = card(draw(rich({ statusLevel: 'full' }), { notes: { approval: 'delete dist' } }));
  assert.match(approval[2], /^│ ⚑ ~ delete dist/);
  const words = withGlyphs('text', () => card(draw(rich({ statusLevel: 'full' }), { brief: undefined, notes: { approval: 'delete dist' } })));
  assert.match(words[2], /^│ Approve ~ delete dist/);
  assert.ok(!words[0].includes('pause'), words[0]);

  const paused = draw(rich({ statusLevel: 'full' }), { brief: { recap, paused: true } }, 44);
  assert.match(card(paused)[0], / paused $/, card(paused)[0]);
  assert.ok(card(paused).slice(2, -1).every((line, i) => paused.lines[paused.statusCard!.y + 2 + i].includes(colors.dim(line.slice(2).trimEnd()))), 'paused: the brief steps back');
  assert.ok(!paused.controls.some(c => c.kind === 'brief' && c.y >= paused.statusCard!.y), 'the switch is not on the card');
});

test('full takes at most a third of the panel and leaves the agents ten rows; a taller brief keeps its most wanted fields and scrolls the rest', () => {
  const long: Recap = { ...recap, needs: 'Approve the migration before the reader agent goes on', done: ['Step one of the work, written out at some length', 'Step two of the work, written out at some length'] };
  // Eight agents: more than the panel holds, so no row is left unused.
  const draw8 = (state: MonitorState) => draw(state, { brief: { recap: long }, tree: tree(8) }, 40, 24);
  const frame = draw8(rich({ statusLevel: 'full' }));
  const info = frame.statusCard!;
  assert.ok(info.height <= 8, `${info.height} rows of 24`);
  assert.ok(info.y >= 11, 'the agents keep ten rows');
  assert.ok(info.total > info.brief, 'the brief is cut');
  const lines = card(frame);
  assert.match(lines[1], /^│ ! 1 agent failed/);
  assert.match(lines[2], /^│ ! Approve the/, 'needs is kept first');
  assert.ok(lines.some(line => line.startsWith('│ ▸ Waiting')), 'then now');
  assert.ok(!lines.some(line => line.startsWith('│ ✓')), 'done gives way');
  assert.match(lines.at(-2)!, /↓ \d+ more lines/);

  const wheel = (state: MonitorState, shown: MonitorFrame, button: 'wheel-down' | 'wheel-up') =>
    handleMonitorInput(state, { type: 'mouse', button, x: 4, y: shown.statusCard!.y + 2 }, { tree: tree(8), frame: shown }).state;
  const agentsBefore = frame.state.scroll.agents;
  const down = wheel(frame.state, frame, 'wheel-down');
  assert.equal(down.statusScroll, 3);
  assert.equal(down.scroll.agents, agentsBefore, 'the wheel over the card leaves the agents alone');
  const scrolled = card(draw8(down));
  assert.deepEqual(scrolled.slice(0, 2), lines.slice(0, 2), 'the edge and the alert stay put');
  assert.ok(scrolled.some(line => line.startsWith('│ ✓')), 'what gave way is a scroll away');
  let state = down;
  for (let i = 0; i < 20; i++) state = wheel(state, draw8(state), 'wheel-down');
  const end = draw8(state);
  assert.equal(end.statusCard!.offset, end.statusCard!.total - end.statusCard!.brief);
  for (let i = 0; i < 20; i++) state = wheel(state, draw8(state), 'wheel-up');
  assert.equal(state.statusScroll, 0);
  // One agent leaves rows unused: the card takes them, past its third, and the whole brief is in view.
  const one = draw(rich({ statusLevel: 'full' }), { brief: { recap: long }, tree: tree(1) }, 40, 24);
  assert.deepEqual(one.statusCard, info);
  assert.deepEqual(card(one), lines);
  assert.ok(plain(one).slice(0, one.statusCard!.y).some(line => line.includes('worker_1')), 'the agent keeps its card');

  // A brief that fits has no hint, and the wheel over it does nothing.
  const short = draw(rich({ statusLevel: 'full' }), {}, 48, 40);
  assert.equal(short.statusCard!.total, short.statusCard!.brief);
  assert.equal(wheel(short.state, short, 'wheel-down').statusScroll ?? 0, 0);
  // Too short for a card that leaves the agents their rows: the one line.
  const cramped = draw(rich({ statusLevel: 'full' }), { tree: tree(8) }, 32, 12);
  assert.equal(card(cramped).length, 1);
});

test('at 90×42 a brief like the atlas one takes at most seven rows, and shows its every done item with rows to spare', () => {
  const previous = setLanguage('zh');
  try {
    const atlas: Recap = { goal: '整理测试数据补全文档，并在版本冻结前合并本轮改动', now: '本轮改动已合并并发布，无待办任务，等待新的需求',
      done: ['修复构建脚本 steer 超时处理并推送', '核对 A/B/C/D 基准结果与独立复核', '整理两个 CI 失败与下一步排查记录', '提交 release 说明并推送到 main 分支'],
      needs: '', at: now - 3 * 60_000, coveredUntil: now, sessionId: 's', language: 'zh' };
    const at = (agents: number) => draw(rich({ statusLevel: 'full' }), { brief: { recap: atlas, running: true }, status: () => ({ ...status!(now)!, alerts: [] }), tree: tree(agents) }, 90, 42);
    const frame = at(12);
    assert.ok(frame.statusCard!.height <= 7, `${frame.statusCard!.height}`);
    assert.ok(frame.lines.every(line => visualLength(line) === 90));
    assert.ok(card(frame).some(line => /推送到 main 分支 \+2/.test(line)));
    const roomy = card(at(3));
    assert.deepEqual(roomy, card(frame));
  } finally { setLanguage(previous); }
});

test('r and a click on the card\'s top edge cycle min, status, full in rich, and min, status in compact; the level is saved', () => {
  const ctx = (frame: MonitorFrame) => ({ tree: tree(3), frame });
  let frame = draw(rich({ statusLevel: 'min' }));
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const out = handleMonitorInput(frame.state, { type: 'key', key: 'reset' }, ctx(frame));
    assert.deepEqual(out.action, { type: 'status-level' });
    seen.push(out.state.statusLevel!);
    frame = draw(out.state);
  }
  assert.deepEqual(seen, ['status', 'full', 'min']);
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('r')), [{ type: 'key', key: 'reset' }]);

  // The band: anywhere on it.
  const top = draw(rich({ statusLevel: 'status' }), {}, 60);
  const y = top.statusCard!.y;
  for (const x of [3, 58]) {
    const clicked = handleMonitorInput(top.state, { type: 'mouse', button: 'left', x, y }, ctx(top));
    assert.deepEqual(clicked.action, { type: 'status-level' });
    assert.equal(clicked.state.statusLevel, 'full');
  }
  const min = draw(rich({ statusLevel: 'min' }), {}, 44);
  assert.equal(handleMonitorInput(min.state, { type: 'mouse', button: 'left', x: 5, y: min.statusCard!.y }, ctx(min)).state.statusLevel, 'status');

  // Compact has two levels: its full is status, and r goes from it to min.
  const compact = { ...initialMonitorState(), statusLevel: 'full' as const };
  assert.equal(shownLevel(compact), 'status');
  assert.equal(nextLevel(compact), 'min');
  assert.equal(nextLevel({ ...compact, statusLevel: 'min' }), 'status');
  assert.equal(nextLevel({ ...compact, statusLevel: 'status' }), 'min');
});

test('a short window retains full; 32 columns draw min', () => {
  assert.equal(shownLevel(rich(), 24), 'full');
  assert.equal(shownLevel(rich({ statusLevel: 'full' }), 24), 'full');
  assert.equal(nextLevel(rich({ statusLevel: 'full' }), 24), 'min');
  const short = draw(rich({ statusLevel: 'full' }), {}, 48, 24);
  assert.ok(card(short).some(line => line.includes('Fix the flaky')), card(short).join('\n'));
  const stepped = handleMonitorInput(short.state, { type: 'key', key: 'reset' }, { tree: tree(3), frame: short });
  assert.equal(stepped.state.statusLevel, 'min');
  const narrow = draw(rich({ statusLevel: 'full' }), {}, 32, 40);
  assert.equal(card(narrow).length, 1);
  assert.equal(narrow.state.statusLevel, 'full');
});

test('min marks what needs the person: a pending approval, a recap that needs them, a failure', () => {
  const approval = draw(rich({ statusLevel: 'min' }), { session: session(true) });
  assert.match(card(approval)[0], /^ ! waiting for approval 2m /);
  const needs = draw(rich({ statusLevel: 'min' }), { brief: { recap: { ...recap, needs: 'Approve npm test' } } });
  assert.match(card(needs)[0], /^ ! ▸ exec · 33m51s /);
  assert.ok(needs.lines[needs.statusCard!.y].includes(theme.warning('!')));
  const quiet: MonitorData['status'] = () => ({ ...status!(now)!, tone: 'working', alerts: [] });
  const failed = draw(rich({ statusLevel: 'min' }), { status: quiet, session: () => ({ text: '▸ working 33m51s', attention: false, failed: true }) });
  assert.ok(failed.lines[failed.statusCard!.y].includes(theme.error('!')));
  const calm = draw(rich({ statusLevel: 'min' }), { status: quiet });
  assert.ok(!card(calm)[0].includes('!'), 'nothing to act on: no mark');
});

test('compact: status and full draw the same card, the brief stays above it, min is one line', () => {
  const compact = (statusLevel: MonitorState['statusLevel']) => draw({ ...initialMonitorState(), statusLevel });
  assert.deepEqual(plain(compact('full')), plain(compact('status')));
  const lines = plain(compact('status'));
  const foot = compact('status').statusCard!.y;
  assert.ok(lines.slice(0, foot).some(line => line.startsWith(' ◎ Fix')), 'the recap sits in the brief area as before');
  assert.ok(!card(compact('status')).some(line => line.startsWith('├')));
  assert.equal(card(compact('min')).length, 1);
});

test('y is no longer a key: nothing copies the recap', () => {
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('y')), []);
  const frame = draw(rich());
  assert.ok(!frame.controls.some(c => (c.kind as string) === 'copy'));
  assert.ok(!plain(frame).some(line => line.includes('y copy')));
});

test('a blank row parts the sections where the panel is tall enough: under the bar, between panes, above the card', () => {
  const blank = (line: string) => line.trim() === '';
  const state = rich({ modes: { ...initialMonitorState().modes, timeline: 'open' } });
  const frame = draw(state, { timeline: [] });
  const lines = plain(frame);
  const [agents, timeline] = frame.panes;
  assert.ok(blank(lines[1]) && agents.y === 2, 'under the bar');
  assert.ok(blank(lines[timeline.y - 1]) && timeline.y === agents.y + agents.height + 1, 'between the panes');
  assert.ok(blank(lines[frame.statusCard!.y - 1]) && frame.statusCard!.y === timeline.y + timeline.height + 1, 'above the card');
  // Short of rows, the panes keep them.
  const short = draw(state, { timeline: [] }, 32, 24);
  assert.equal(short.panes[0].y, 1);
  assert.equal(short.panes[1].y, short.panes[0].y + short.panes[0].height);
  // In the frame look its edges part the sections; in the tabs layout the one pane is parted from the bar and the card.
  const previous = setDisplayConfig({ look: 'frame' });
  try {
    const framed = draw(state, { timeline: [] });
    assert.equal(framed.panes[0].y, 2, 'the title edge right under the tabs');
    assert.equal(framed.panes[1].y, framed.panes[0].y + framed.panes[0].height);
  } finally {
    setDisplayConfig(previous);
  }
  const tabbed = draw({ ...state, tabbed: true });
  assert.equal(tabbed.panes.length, 1);
  assert.equal(tabbed.panes[0].y, 2);
  assert.equal(tabbed.statusCard!.y, tabbed.panes[0].y + tabbed.panes[0].height + 1);
});

test('full recap geometry and content are stable when card summaries change visibility, with and without alerts', () => {
  for (const height of [24,39,40,56]) for (const alerts of [[], ['! synthetic alert']]) {
    const agents = tree(1);
    const log = new Map([[id(1), [{at: now, kind: 'note' as const, text: 'Long model progress note '.repeat(60)}]]]);
    const extra = {tree: agents, agentLog: log, status: () => ({...status!(now)!, alerts})};
    const hidden = draw(rich({statusLevel:'full',cardVisibility:{cardSummary:false}}),extra,48,height);
    const shown = draw(rich({statusLevel:'full',cardVisibility:{cardSummary:true}}),extra,48,height);
    assert.deepEqual(shown.statusCard,hidden.statusCard);
    assert.deepEqual(card(shown),card(hidden));
    assert.equal(shown.state.statusLevel,'full');
    assert.ok(shown.statusCard!.brief > 0);
  }
});
