import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMonitorState, renderMonitor, handleMonitorInput, type MonitorState, type MonitorFrame, type MonitorData } from '../../src/render/monitor.js';
import { shownLevel, nextLevel } from '../../src/render/status-foot.js';
import { stripAnsi, visualLength, theme } from '../../src/render/colors.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import type { Recap } from '../../src/collectors/recap.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const now = Date.parse('2026-10-04T10:00:00Z');
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const agent = (i: number): SubagentTreeNode => ({ id: id(i), name: `worker_${i}`, status: 'running', depth: 1, children: [],
  startedAt: new Date(now - 600_000), turnStartedAt: new Date(now - 60_000), lastEventAt: new Date(now - 5000), task: `Task number ${i}` });
const tree = (n: number): SubagentTree => ({ rootId: 'root', nodes: Array.from({ length: n }, (_, i) => agent(i + 1)), totalCount: n, updatedAt: new Date(now) });
const recap: Recap = { goal: 'Fix the flaky cache test in the parser', done: ['Reproduced the failure', 'Found the race'],
  now: 'Waiting on reader agent', needs: '', at: now - 5 * 60_000, coveredUntil: now, sessionId: 's', language: 'en' };
const status: MonitorData['status'] = (_width, rows) =>
  ({ rows: ['! 1 agent failed', '▸ working · 33m51s', 'context ━━━━── 61%'].slice(0, rows), top: '☀ 2h10m', bottom: 'proj · main', bottomRight: '' });
const session = (attention = false): MonitorData['session'] => () =>
  attention ? { text: '! waiting for approval 2m', attention: true } : { text: '▸ working 33m51s', attention: false };
const rich = (extra: Partial<MonitorState> = {}): MonitorState => ({ ...initialMonitorState(), style: 'rich', ...extra });
const plain = (frame: MonitorFrame) => frame.lines.map(stripAnsi);
const draw = (state: MonitorState, extra: Partial<MonitorData> = {}, width = 32, height = 40) =>
  renderMonitor({ tree: tree(3), state, width, height, nowMs: now, status, session: session(), brief: { recap, structured: true, text: '{}', at: now }, ...extra });
/** The card's lines, by the frame's own record of where it sits. */
const card = (frame: MonitorFrame) => plain(frame).slice(frame.statusCard!.y, frame.statusCard!.y + frame.statusCard!.height);

test('rich: min is the top edge alone, status the card, full the card with the brief under an inner rule, at 24, 32 and 44 columns', () => {
  for (const width of [24, 32, 44]) {
    const min = draw(rich({ statusLevel: 'min' }), {}, width);
    const status = draw(rich({ statusLevel: 'status' }), {}, width);
    const full = draw(rich({ statusLevel: 'full' }), {}, width);
    for (const frame of [min, status, full]) assert.ok(frame.lines.every(line => visualLength(line) <= width), `${width}`);

    const one = card(min);
    assert.equal(one.length, 1, `${width}: min is one line`);
    // The card's name gives way before the state does.
    assert.match(one[0], width < 32 ? /^╭─ ▸ working 33m51s ─+╮$/ : /^╭─ Status ▸ working 33m51s ─.*╮$/, `${width}`);
    assert.equal(visualLength(one[0]), width);

    const box = card(status);
    assert.ok(box[0].startsWith('╭─ Status ☀ 2h10m') && box[0].endsWith('╮'), `${width}`);
    assert.ok(box.at(-1)!.startsWith('╰─ proj · main') && box.at(-1)!.endsWith('╯'));
    assert.deepEqual(box.slice(1, -1).map(line => line.slice(2, -2).trimEnd()), ['! 1 agent failed', '▸ working · 33m51s', 'context ━━━━── 61%']);
    assert.ok(!box.some(line => line.startsWith('├')), 'status: no brief');

    const lines = card(full);
    assert.deepEqual(lines.slice(0, 4), box.slice(0, 4), `${width}: the status rows come first, as status shows them`);
    assert.match(lines[4], width < 32 ? /^├─ 5m ago ─+ b pause ─┤$/ : /^├─ Recap 5m ago ─+ b pause ─┤$/, `${width}`);
    assert.match(lines[5], /^│ Goal +│$/, `${width}`);
    assert.ok(lines.some(line => line.includes('✓ Reproduced')), `${width}`);
    assert.equal(lines.at(-1), box.at(-1));
  }
  // The hints go first when the edge is short, the state never.
  const narrow = card(draw(rich({ statusLevel: 'min' }), {}, 24))[0];
  assert.ok(!narrow.includes('?'), narrow);
  assert.ok(card(draw(rich({ statusLevel: 'min' }), {}, 44))[0].includes(', ?'));
});

test('rich frames carry the recap only inside the status card; no brief rule, no recap card', () => {
  for (const statusLevel of ['min', 'status', 'full'] as const) {
    const frame = draw(rich({ statusLevel }));
    const above = plain(frame).slice(0, frame.statusCard!.y);
    assert.ok(!above.some(line => /Goal|Main recap|Brief|Reproduced|Waiting on reader/.test(line)), statusLevel);
  }
  // Absent is full.
  assert.equal(shownLevel(rich()), 'full');
  assert.ok(card(draw(rich())).some(line => line.includes('Goal')));
});

test('full with no recap: the other brief parts, a failure or a reply in another shape; with nothing, it is status', () => {
  const status = card(draw(rich({ statusLevel: 'status' })));
  assert.deepEqual(card(draw(rich({ statusLevel: 'full' }), { brief: undefined })), status, 'no backend, no approval words: status');
  assert.deepEqual(card(draw(rich({ statusLevel: 'full' }), { brief: {} })), status, 'a backend with nothing yet: status');

  const failed = draw(rich({ statusLevel: 'full' }), { brief: { error: 'quota exhausted' } });
  const lines = card(failed);
  assert.match(lines[4], /^├─ failed ─+ b pause ─┤$/);
  assert.ok(lines.some(line => line.includes('quota exhausted')), 'the error itself has a home');
  assert.ok(failed.lines[failed.statusCard!.y + 4].includes(theme.warning('failed')));

  const odd = card(draw(rich({ statusLevel: 'full' }), { brief: { text: 'All three agents look fine.', at: now } }));
  assert.ok(odd.some(line => line.includes('All three agents look fine.')), 'a non-JSON reply is shown as it is');

  const overall = card(draw(rich({ statusLevel: 'full' }), { brief: { recap, overall: 'Two running, one waiting', structured: true, text: '{}', at: now } }));
  const goal = overall.findIndex(line => line.includes('Goal'));
  const whole = overall.findIndex(line => line.includes('Two running'));
  assert.ok(goal > 0 && whole > goal, 'the whole-picture sentence follows the recap');

  // The approval words lead, and they are shown with no brief configured too, with no switch then.
  const approval = card(draw(rich({ statusLevel: 'full' }), { notes: { approval: 'delete dist' } }));
  assert.ok(approval[5].includes('Approval') && approval.findIndex(line => line.includes('Goal')) > 5);
  const alone = card(draw(rich({ statusLevel: 'full' }), { brief: undefined, notes: { approval: 'delete dist' } }));
  assert.ok(alone[4].startsWith('├') && !alone[4].includes('b pause'), alone[4]);

  const paused = draw(rich({ statusLevel: 'full' }), { brief: { recap, paused: true } });
  assert.match(card(paused)[4], /^├─ paused ─+ b resume ─┤$/);
  const control = paused.controls.find(c => c.kind === 'brief')!;
  assert.equal(control.y, paused.statusCard!.y + 4);
  assert.deepEqual(handleMonitorInput(paused.state, { type: 'mouse', button: 'left', x: control.x + 1, y: control.y }, { tree: tree(3), frame: paused }).action,
    { type: 'brief-toggle' });
});

test('full takes at most half the panel and leaves the agents their rows; a taller brief scrolls on its own under the wheel', () => {
  const long: Recap = { ...recap, done: Array.from({ length: 8 }, (_, i) => `Step ${i + 1} of the work, written out at length`) };
  const frame = draw(rich({ statusLevel: 'full' }), { brief: { recap: long } }, 32, 30);
  const info = frame.statusCard!;
  assert.ok(info.height <= 15, `${info.height} rows of 30`);
  assert.ok(info.y >= 6, 'the agents keep a few rows');
  assert.ok(info.total > info.brief, 'the brief is cut');
  const lines = card(frame);
  assert.deepEqual(lines.slice(1, 4).map(line => line.slice(2, -2).trimEnd()), ['! 1 agent failed', '▸ working · 33m51s', 'context ━━━━── 61%'], 'status rows fixed');
  assert.match(lines.at(-2)!, /↓ \d+ more lines/);

  const wheel = (state: MonitorState, shown: MonitorFrame, button: 'wheel-down' | 'wheel-up') =>
    handleMonitorInput(state, { type: 'mouse', button, x: 4, y: shown.statusCard!.y + 6 }, { tree: tree(3), frame: shown }).state;
  const agentsBefore = frame.state.scroll.agents;
  const down = wheel(frame.state, frame, 'wheel-down');
  assert.equal(down.statusScroll, 3);
  assert.equal(down.scroll.agents, agentsBefore, 'the wheel over the card leaves the agents alone');
  const scrolled = draw(down, { brief: { recap: long } }, 32, 30);
  const after = card(scrolled);
  assert.deepEqual(after.slice(0, 5), lines.slice(0, 5), 'the status rows and the inner rule stay put');
  assert.notDeepEqual(after.slice(5, -2), lines.slice(5, -2));
  assert.match(after.at(-2)!, /↑ 3 {2}↓ \d+ more lines/);
  // Past the end it stops at the end; up again, at the top.
  let state = down;
  for (let i = 0; i < 20; i++) state = wheel(state, draw(state, { brief: { recap: long } }, 32, 30), 'wheel-down');
  const end = draw(state, { brief: { recap: long } }, 32, 30);
  assert.equal(end.statusCard!.offset, end.statusCard!.total - end.statusCard!.brief);
  assert.match(card(end).at(-2)!, /↑ \d+ more lines/);
  for (let i = 0; i < 20; i++) state = wheel(state, draw(state, { brief: { recap: long } }, 32, 30), 'wheel-up');
  assert.equal(state.statusScroll, 0);

  // A brief that fits has no hint, and the wheel over it does nothing.
  const short = draw(rich({ statusLevel: 'full' }), {}, 32, 40);
  assert.equal(short.statusCard!.total, short.statusCard!.brief);
  assert.equal(wheel(short.state, short, 'wheel-down').statusScroll ?? 0, 0);
  // Too short for any of the brief: the card is status.
  const cramped = draw(rich({ statusLevel: 'full' }), {}, 32, 14);
  assert.ok(!card(cramped).some(line => line.startsWith('├')));
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

  // The top edge: anywhere but its hint, which opens settings.
  const top = draw(rich({ statusLevel: 'status' }), {}, 44);
  const y = top.statusCard!.y;
  const clicked = handleMonitorInput(top.state, { type: 'mouse', button: 'left', x: 3, y }, ctx(top));
  assert.deepEqual(clicked.action, { type: 'status-level' });
  assert.equal(clicked.state.statusLevel, 'full');
  const hint = top.controls.find(c => c.kind === 'settings' && c.y === y)!;
  assert.deepEqual(handleMonitorInput(top.state, { type: 'mouse', button: 'left', x: hint.x + 1, y }, ctx(top)).action, { type: 'settings' });
  const min = draw(rich({ statusLevel: 'min' }), {}, 44);
  assert.equal(handleMonitorInput(min.state, { type: 'mouse', button: 'left', x: 5, y: min.statusCard!.y }, ctx(min)).state.statusLevel, 'status');

  // Compact has two levels: its full is status, and r goes from it to min.
  const compact = { ...initialMonitorState(), statusLevel: 'full' as const };
  assert.equal(shownLevel(compact), 'status');
  assert.equal(nextLevel(compact), 'min');
  assert.equal(nextLevel({ ...compact, statusLevel: 'min' }), 'status');
  assert.equal(nextLevel({ ...compact, statusLevel: 'status' }), 'min');
});

test('min marks what needs the person: a pending approval, a recap that needs them, a failure', () => {
  const approval = draw(rich({ statusLevel: 'min' }), { session: session(true) });
  assert.match(card(approval)[0], /^╭─ ! waiting for approval 2m ─/, 'at 32 columns the name goes, the state stays');
  const needs = draw(rich({ statusLevel: 'min' }), { brief: { recap: { ...recap, needs: 'Approve npm test' } } });
  assert.match(card(needs)[0], /^╭─ Status ! ▸ working 33m51s ─/);
  const tight = card(draw(rich({ statusLevel: 'min' }), { session: () => ({ text: '! waiting for approval 12m', short: 'waiting 12m', attention: true }) }, 24))[0];
  assert.match(tight, /^╭─ ! waiting 12m ─+╮$/, 'narrower still: the short form, the mark kept');
  assert.ok(needs.lines[needs.statusCard!.y].includes(theme.warning('! ')));
  const failed = draw(rich({ statusLevel: 'min' }), { session: () => ({ text: '▸ working 33m51s', attention: false, failed: true }) });
  assert.ok(failed.lines[failed.statusCard!.y].includes(theme.error('! ')));
  const calm = draw(rich({ statusLevel: 'min' }));
  assert.ok(!card(calm)[0].includes('!'), 'nothing to act on: no mark');
});

test('compact: status and full draw the same card, the brief stays above it, min is one line', () => {
  const compact = (statusLevel: MonitorState['statusLevel']) => draw({ ...initialMonitorState(), statusLevel });
  assert.deepEqual(plain(compact('full')), plain(compact('status')));
  const lines = plain(compact('status'));
  const foot = compact('status').statusCard!.y;
  assert.ok(lines.slice(0, foot).some(line => line.trimEnd() === ' Goal'), 'the recap sits in the brief area as before');
  assert.ok(!card(compact('status')).some(line => line.startsWith('├')));
  assert.equal(card(compact('min')).length, 1);
});

test('y is no longer a key: nothing copies the recap', () => {
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('y')), []);
  const frame = draw(rich());
  assert.ok(!frame.controls.some(c => (c.kind as string) === 'copy'));
  assert.ok(!plain(frame).some(line => line.includes('y copy')));
});
