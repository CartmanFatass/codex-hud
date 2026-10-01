import test from 'node:test';
import assert from 'node:assert/strict';
import { statusCard, type StatusCard } from '../../src/render/status-block.js';
const statusRows = (...args: Parameters<typeof statusCard>) => statusCard(...args)?.rows ?? [];
import { initialMonitorState, renderMonitor } from '../../src/render/monitor.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { makeHudData } from '../fixtures/hud-data.js';
import type { SubagentTree } from '../../src/types.js';

const tree: SubagentTree = { rootId: 'root', nodes: [], totalCount: 0, updatedAt: new Date() };
const plain = (rows: string[]) => rows.map(row => stripAnsi(row));
/** The text from a display column on: a Chinese character is two columns. */
const fromColumn = (line: string, column: number) => {
  let at = 0;
  for (const [i, char] of [...line].entries()) { if (at >= column) return [...line].slice(i).join(''); at += visualLength(char); }
  return '';
};

test('the card lays the bar fields out as a table, alerts first and agents left to the panel', () => {
  const data = makeHudData();
  const now = data.session!.startTime.getTime() + 3_600_000;
  for (const width of [20, 28, 40, 52]) {
    const rows = statusRows(data, width, 6, now);
    for (const row of rows) assert.ok(visualLength(row) <= width, `${width}: ${stripAnsi(row)}`);
    const text = plain(rows);
    assert.match(text[0], /^! /, 'the alert leads');
    assert.ok(!text.some(line => /Agents|F12|1 run/.test(line)), 'the agent counts are the panel’s job');
  }
  const text = plain(statusRows(data, 52, 6, now));
  const context = text.find(line => line.startsWith('Context'))!;
  const quota = text.find(line => line.startsWith('Quota'))!;
  assert.ok(context && quota);
  assert.match(context, /━/, 'the panel’s line meter, not the bar’s blocks');
  // One table: both meters start in the same column and end in the same one.
  const meterEnd = (line: string) => line.search(/[─━╸](?![─━╸])/) + 1;
  assert.equal(context.indexOf(context.match(/[━─╸]/)![0]), quota.indexOf(quota.match(/[━─╸]/)![0]));
  assert.equal(meterEnd(context), meterEnd(quota));
  assert.deepEqual(statusRows(null, 40, 6), []);
});

test('a short card keeps alert, session, context and quota before the rest', () => {
  const data = makeHudData();
  const all = plain(statusRows(data, 48, 6));
  const rows = plain(statusRows(data, 48, 3));
  assert.ok(all.length > 3);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^! /);
  assert.ok(rows.some(line => line.startsWith('Context')) && rows.some(line => line.startsWith('Quota')));
  assert.ok(!rows.some(line => /Output|Tasks/.test(line)), 'the extras row goes first');
  assert.deepEqual(rows, all.filter(line => rows.includes(line)), 'what stays keeps its place');
});

test('card labels follow the panel language and keep the meters aligned', () => {
  const previous = setLanguage('zh');
  try {
    const rows = plain(statusRows(makeHudData(), 48, 6));
    const context = rows.find(line => line.startsWith('上下文'))!;
    const quota = rows.find(line => line.startsWith('额度'))!;
    assert.ok(context && quota);
    assert.equal(visualLength(context.slice(0, context.search(/[━─╸]/))), visualLength(quota.slice(0, quota.search(/[━─╸]/))));
    assert.match(rows[0], /^! 1 个工具失败|^! .*失败/);
  } finally { setLanguage(previous); }
});

test('the frame carries model, age, place and cache, so the rows are only activity and meters', () => {
  const data = makeHudData();
  const card = statusCard(data, 48, 6)!;
  assert.match(stripAnsi(card.top), /\S/, 'model badge and age for the top edge');
  assert.match(stripAnsi(card.bottom), new RegExp(data.project.projectName));
  assert.ok(!card.rows.some(row => stripAnsi(row).includes(data.project.projectName)), 'the place is on the frame, not a row');
});

const card = (top = '☀◆ 2h', bottom = 'repo · main *', bottomRight = '◷~03m'): StatusCard =>
  ({ rows: ['! one', '▸ working', 'Context 40%', 'Quota 5%'], top, bottom, bottomRight });

test('the card takes the foot: hint and identity on the top edge, place and cache on the bottom', () => {
  for (const lang of ['en', 'zh'] as const) {
    const previous = setLanguage(lang);
    try {
      for (const width of [32, 56]) {
        const frame = renderMonitor({ tree, state: initialMonitorState(), width, height: 24, status: () => card() });
        const lines = frame.lines.map(line => stripAnsi(line));
        for (const line of frame.lines) assert.equal(visualLength(line), width, `${lang} ${width}: ${stripAnsi(line)}`);
        const top = lines.at(-6)!, bottom = lines.at(-1)!;
        assert.match(top, /^╭─ (Status|状态) ☀◆ 2h ─+ , .*─╮$/, `${lang} ${width}: ${top}`);
        assert.match(bottom, /^╰─ repo · main \* ─+ ◷~03m ─╯$/);
        assert.deepEqual(lines.slice(-5, -1).map(line => line.replace(/^│ (.*?) *│$/, '$1')), card().rows);
        const control = frame.controls.find(c => c.kind === 'settings')!;
        assert.equal(control.y, 24 - 6);
        assert.ok(fromColumn(top, control.x).startsWith(','), 'the hint opens settings');
        if (width === 56) assert.match(top, lang === 'en' ? /, Settings {2}\? keys ─╮$/ : /, 设置 {2}\? 按键 ─╮$/);
      }
    } finally { setLanguage(previous); }
  }
});

test('a crowded edge gives up the hint before the identity, and cuts the place before the cache', () => {
  const previous = setLanguage('zh');
  try {
    const narrow = renderMonitor({ tree, state: initialMonitorState(), width: 28, height: 24,
      status: () => card('☀◆ 12h', 'a-very-long-project-name › repo · main *') }).lines.map(line => stripAnsi(line));
    assert.match(narrow.at(-6)!, /^╭─ 状态 ☀◆ 12h ─+ , \? ─╮$/);
    assert.match(narrow.at(-1)!, /^╰─ a-very-long-p… ─ ◷~03m ─╯$/);
    assert.equal(visualLength(narrow.at(-1)!), 28);
  } finally { setLanguage(previous); }
  const lines = (height: number, width = 30) =>
    renderMonitor({ tree, state: initialMonitorState(), width, height, status: (_w, max) => ({ ...card(), rows: card().rows.slice(0, max) }) }).lines.map(line => stripAnsi(line));
  assert.equal(lines(14).filter(line => line.startsWith('│')).length, 2, 'a short panel keeps two rows');
  assert.match(lines(10).at(-1)!, /^, Settings/, 'no room for a card: the hint is the last line again');
  assert.ok(!lines(24, 20).some(line => line.startsWith('╭')), 'too narrow for a frame: no card');
});
