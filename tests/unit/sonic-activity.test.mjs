import { withState } from '../fixtures/state-helpers.mjs';
/** PANEL-V2 04: the ten-minute activity ring and its row, and sonic children as one-line branches under their parent on Home. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitFixture, split } from '../fixtures/split-layout.mjs';
import { NOW } from '../fixtures/project-page.mjs';
import { ActivityRings } from '../../dist/collectors/activity-ring.js';
import { sparkline } from '../../dist/render/work-card.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

const MIN = 60000, text = (lines) => lines.map((l) => l.trimEnd());
async function scene(t, { parent = {}, kids = [['check retry flags', null], ['list slow tests', NOW - MIN]], activity } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'sonic-activity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await splitFixture(join(root, 'busy'));
  const lane = f.board.lanes.find((l) => l.label === 'AUTH-REFRESH'), base = lane.workers[0];
  const main = { ...base, ...parent, ...(activity ? { activity } : {}) };
  const child = ([task, settledAt], i) => ({
    ...base, id: `thin-job:j00000000000000c${i}`, parentJobId: base.id, role: 'sonic', task, startedAt: NOW - 3 * MIN, settledAt,
    state: settledAt === null ? 'working' : 'done', work: { ...base.work, activityAt: NOW, result: settledAt !== null },
  });
  const workers = [main, ...kids.map(child)];
  const lanes = f.board.lanes.map((l) => (l === lane ? { ...l, workers } : l));
  const board = { ...f.board, lanes, workers: lanes.flatMap((l) => l.workers) };
  // Every row, padded to the panel's width; `text` is the same rows trimmed, for matching.
  const render = (width, lang, state, height = 60, extras) => f.render(width, lang, height, state, f.data, { workboard: board, ...extras }).lines.map(stripAnsi);
  return { f, lane, main, board, render, key: (w) => targetKey({ kind: 'worker', laneId: lane.id, workerId: w.id }) };
}

test('Activity ring: a write counts in the current minute, buckets slide with the clock, a quiet ring is absent; the row is ▁▂▃▄▅▆▇█, ascii ..--==##', () => {
  const rings = new ActivityRings(), at = 5_000_000 * MIN;
  const run = (activityAt, extra) => ({ id: 'a', state: 'working', settledAt: null, work: { activityAt }, ...extra });
  assert.equal(rings.observe([run(1)], at).size, 0, 'first sight has no history');
  assert.equal(rings.observe([run(1)], at + 5000).size, 0, 'no new write, no activity');
  rings.observe([run(2)], at + 6000);
  assert.deepEqual(rings.observe([run(3, { progress: [{}] })], at + 7000).get('a'), [0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
  assert.deepEqual(rings.observe([run(4, { progress: [{}] })], at + 2 * MIN).get('a'), [0, 0, 0, 0, 0, 0, 0, 2, 0, 1]);
  assert.deepEqual(rings.observe([run(4, { progress: [{}] })], at + 3 * MIN).get('a'), [0, 0, 0, 0, 0, 0, 2, 0, 1, 0]);
  assert.equal(rings.observe([run(4, { progress: [{}] })], at + 14 * MIN).size, 0, 'ten quiet minutes empty the ring');
  rings.observe([run(5)], at + 14 * MIN + 1);
  assert.equal(rings.observe([{ ...run(6), settledAt: 1, state: 'done' }], at + 14 * MIN + 2).size, 0, 'a settled worker has none');
  assert.equal(rings.observe([run(7)], at + 15 * MIN).size, 0, 'and starts afresh if it runs again');
  assert.equal(sparkline([0, 0, 0, 0, 1, 2, 4, 6, 8, 30]), '    ▁▂▄▆██');
  const display = setDisplayConfig({ icons: 'text' });
  try { assert.equal(sparkline([0, 0, 0, 0, 1, 2, 4, 6, 8, 30]), '    ..-=##'); } finally { setDisplayConfig(display); }
});

test('Activity row: an expanded running card and the Inspector show it under the milestone, in both languages, and nothing without activity', async (t) => {
  const s = await scene(t, { activity: [0, 0, 1, 2, 4, 6, 8, 3, 1, 2] });
  const expanded = withState(initialMonitorState(), { home: { expanded: new Set([s.key(s.main)]) } });
  const inspector = withState(initialMonitorState(), { subpage: { kind: 'inspector', scroll: 0, target: { kind: 'worker', laneId: s.lane.id, workerId: s.main.id } } });
  for (const width of [40, 80]) for (const [lang, word, span] of [['en', 'Activity', '10m'], ['zh', '活动', '10分']]) for (const state of [expanded, inspector]) {
    const lines = s.render(width, lang, state), row = text(lines).filter((l) => l.includes('▁▂▄▆█▃▁▂'));
    assert.equal(row.length, 1, `${lang} ${width}\n${lines.join('\n')}`);
    assert.match(row[0], new RegExp(`^┃ ${word} +▁▂▄▆█▃▁▂ ${span}`));
    for (const line of lines) assert.equal(visualLength(line), width, line);
  }
  const quiet = await scene(t, { activity: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  assert.ok(!quiet.render(40, 'en', withState(expanded, { home: { expanded: new Set([quiet.key(quiet.main)]) } })).some((l) => l.includes('Activity')));
});

test('Sonic children hang under their parent as one-line branches, in Classic and in Split’s preview, at 40 and 80 columns in both languages', async (t) => {
  const s = await scene(t);
  const lane = targetKey({ kind: 'lane', laneId: s.lane.id });
  for (const width of [40, 80]) for (const lang of ['en', 'zh']) for (const [name, state] of [['classic', initialMonitorState()], ['split', split({ home: { split: { listCursor: lane } } })]]) {
    const lines = s.render(width, lang, state), shown = text(lines), at = shown.findIndex((l) => l.includes('├─ ⚡ sonic · check retry fl'));
    assert.ok(at > 0, `${name} ${lang} ${width}\n${lines.join('\n')}`);
    assert.match(shown[at], /^ {2}├─ ⚡ sonic · check retry fl\S* +3(m|分) ◉$/);
    assert.match(shown[at + 1], /^ {2}└─ ⚡ sonic · list slow te\S* +\d+(m|分) ✓$/);
    assert.ok(!shown.some((l) => /^[◉✓] sonic/.test(l)), 'children are not cards');
    for (const line of lines) assert.equal(visualLength(line), width, `${name} ${lang} ${width}: ${line}`);
  }
  assert.ok(text(s.render(40, 'en', initialMonitorState(), 60, { icons: 'text' })).some((l) => /^ {2}\|- \* sonic · check retry flags/.test(l)), 'ascii');
});

test('A folded parent shows how many sonic children still run on its title row, and not the branches', async (t) => {
  const s = await scene(t, { parent: { settledAt: NOW - 6 * MIN, state: 'done' }, kids: [['check retry flags', null], ['list slow tests', null], ['older run', NOW - 20 * MIN]] });
  for (const [lang, badge] of [['en', '⚡ 2 sonic'], ['zh', '⚡ 2 个 sonic']]) for (const width of [40, 80]) {
    const lines = s.render(width, lang, initialMonitorState());
    assert.ok(lines.some((l) => l.includes(badge)), `${lang} ${width}\n${lines.join('\n')}`);
    assert.ok(!lines.some((l) => l.includes('├─')));
    for (const line of lines) assert.equal(visualLength(line), width, line);
  }
});

test('The / filter keeps a matching sonic child under its parent', async (t) => {
  const s = await scene(t);
  const lines = text(s.render(40, 'en', withState(initialMonitorState(), { home: { filter: { query: 'slow tests', editing: false } } })));
  const parent = lines.findIndex((l) => l.includes('reviewer') && l.includes('AUTH-REFRESH') || l.startsWith('◉ reviewer'));
  const child = lines.findIndex((l) => l.includes('└─ ⚡ sonic · list slow tests'));
  assert.ok(parent >= 0 && child > parent, lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('check retry flags')), 'a child that does not match is gone');
  assert.ok(!lines.some((l) => l.includes('NATIVE-TREE')), 'other lanes are filtered out');
});
