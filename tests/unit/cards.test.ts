import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialMonitorState, renderMonitor, handleMonitorInput, monitorItemAt, type MonitorState, type MonitorFrame } from '../../src/render/monitor.js';
import { agentTitle, KIND_GLYPHS } from '../../src/render/agent-title.js';
import { hangLines, clockText } from '../../src/render/cards.js';
import { stripAnsi, visualLength, theme, colors } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import { defaultSettings, loadSettings, saveSettings } from '../../src/settings.js';
import { SETTING_ROWS } from '../../src/render/settings-page.js';
import type { AgentLogEntry } from '../../src/collectors/agent-log.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const now = Date.parse('2026-10-04T10:00:00Z');
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const agent = (i: number, name: string, status: SubagentTreeNode['status'], extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode =>
  ({ id: id(i), name, status, depth: 1, children: [], startedAt: new Date(now - 600_000 + i * 1000), turnStartedAt: new Date(now - 247_000),
    lastEventAt: new Date(now - 5000), ...extra });
const tree = (nodes: SubagentTreeNode[]): SubagentTree => ({ rootId: 'root', nodes, totalCount: nodes.length, updatedAt: new Date(now) });
const rich = (extra: Partial<MonitorState> = {}): MonitorState => ({ ...initialMonitorState(), style: 'rich', ...extra });
const key = (k: string) => ({ type: 'key' as const, key: k });
const click = (x: number, y: number) => ({ type: 'mouse' as const, button: 'left' as const, x, y });
const plain = (frame: MonitorFrame) => frame.lines.map(stripAnsi);

const named = agent(1, 'ablation_no_reranker', 'running', { label: '去重排消融召回对比', taskKind: 'research', task: 'Run the ablation without reranker',
  model: 'gpt-5.4-astra', effort: 'high', contextUsage: { percent: 56, used: 100, total: 200, inputTokens: 0, outputTokens: 0, cachedTokens: 0, compactCount: 0 } });
const bare = agent(2, 'small_index_ablation', 'error', { task: 'Build a small index and compare recall against the full one at k=10', statusAt: new Date(now - 120_000) });
const log = new Map<string, AgentLogEntry[]>([
  [named.id, [{ at: now - 247_000, kind: 'started', text: '' }, { at: now - 120_000, kind: 'report', text: 'recall@10 0.71' },
    { at: now - 6000, kind: 'note', text: '召回下降，结果待核对' }]],
  [bare.id, [{ at: now - 300_000, kind: 'started', text: '' }, { at: now - 120_000, kind: 'failed', text: '' }]],
]);

test('the kind of work is a fixed one-column glyph the HUD picks; other and unknown have none', () => {
  for (const [kind, glyph] of Object.entries(KIND_GLYPHS)) {
    if (kind === 'other') assert.equal(glyph, '');
    else assert.equal(visualLength(glyph), 1, kind);
  }
  assert.deepEqual(agentTitle(named), { icon: '⌕', name: 'ablation_no_reranker', task: '去重排消融召回对比', renamed: true });
  assert.deepEqual(agentTitle(bare), { name: 'small_index_ablation', task: bare.task, renamed: false }, 'no label: the task says what it is for');
  assert.deepEqual(agentTitle(agent(3, 'x\x1b[2J', 'running', { taskKind: 'other' })), { name: 'x\\x1b[2J', renamed: false });
});

test('a card: Codex\'s name, glyph and badge on the rule; the smart name, then the news, inside; time and meter below', () => {
  const frame = renderMonitor({ tree: tree([named, bare]), state: rich(), width: 32, height: 40, nowMs: now, agentLog: log });
  const lines = plain(frame);
  const top = lines.findIndex(line => line.includes('ablation_no_reranker'));
  assert.match(lines[top], /^› ▸ ⌕ ablation_no_reranker ─+ \S/, 'selected: › for the corner; the status, the glyph, the name, the badge');
  assert.ok(frame.lines[top].includes(colors.underline('ablation_no_reranker')), 'the name is underlined: it is the thing to click');
  assert.equal(lines[top + 1].trimEnd(), '│ 去重排消融召回对比');
  assert.ok(frame.lines[top + 1].includes(theme.strong('去重排消融召回对比')));
  assert.equal(lines[top + 2].trimEnd(), '│', 'a blank line before the news');
  assert.match(lines[top + 3], /^│ ~ 召回下降，结果待核对 +6s$/, 'the newest model note first, its age at the right');
  assert.match(lines[top + 4], /^│ recall@10 0\.71 +2m$/, 'then the newest observed entry');
  assert.match(lines[top + 5], /^└ ◷ 4m07s ─+ ━╸─ 56% ▾$/, 'the turn clock counting seconds, the meter, the switch');
  assert.ok(frame.lines[top + 1].startsWith(theme.accent('│')), 'a selected card is painted in the accent');
  // A card with no smart name: the task under the name, cut to two lines; the time since it failed.
  const second = lines.findIndex(line => line.includes('small_index_ablation'));
  assert.match(lines[second], /^┌ ! small_index_ablation ─+$/, 'no glyph, no badge, no right border');
  assert.equal(lines[second + 1].trimEnd(), '│ Build a small index and');
  assert.match(lines[second + 2], /^│ compare recall against the … *$/);
  assert.match(lines[second + 3], /^└ 2m ago ─+ ▾$/, 'its failing is the bottom rule\'s to say, not said twice inside');
  assert.ok(frame.lines[second + 1].startsWith(theme.error('│')), 'a failed card is painted in the error colour');
  assert.equal(lines[second - 1].trim(), '', 'a blank line between cards');
  // The compact tree row keeps Codex's name; its log header shows the glyph and the name, the smart name under it.
  const compact = renderMonitor({ tree: tree([named, bare]), state: initialMonitorState(), width: 32, height: 40, nowMs: now, agentLog: log });
  const rows = plain(compact);
  assert.ok(rows.some(line => /^›▸ ablation_no_reranker/.test(line)), 'tree row: the original name');
  assert.ok(!rows.slice(0, 4).some(line => line.includes('去重排')), 'not the smart name in the tree');
  const header = rows.findIndex(line => /^ ▸ ⌕ ablation_no_reranker/.test(line));
  assert.ok(header > 0, rows.join('\n'));
  assert.equal(rows[header + 1].trimEnd(), '   去重排消融召回对比');
});

test('cards never run past the panel, in either language, and give up badge and meter when narrow', () => {
  const child = agent(5, 'b05_result_diagnosis_with_a_long_name', 'running', { depth: 2, label: '子任务', taskKind: 'review' });
  const parent = agent(4, 'parent_task', 'running', { children: [child], task: '父任务'.repeat(30) });
  const nodes = [named, bare, parent];
  const recap = { goal: '整理测试数据补全文档，并在版本冻结前合并本轮改动', done: ['修复构建脚本'], now: '等待', needs: '批准 npm test',
    at: now, coveredUntil: now, sessionId: 's', language: 'zh' as const };
  for (const language of ['en', 'zh'] as const) {
    const previous = setLanguage(language);
    try {
      for (const width of [20, 24, 30, 32, 44, 60]) for (const open of [false, true]) {
        const state = rich({ cards: new Set(open ? nodes.map(n => n.id).concat(child.id) : []) });
        for (const style of ['rich', 'compact'] as const) {
          const frame = renderMonitor({ tree: tree(nodes), state: { ...state, style }, width, height: 80, nowMs: now, agentLog: log, brief: { recap, overall: '两个在跑' } });
          for (const line of frame.lines) assert.ok(visualLength(line) <= width, `${language} ${style} ${width}: ${stripAnsi(line)}`);
          for (const c of frame.controls) assert.ok(c.x >= 0 && c.x + c.width <= width, `${style} ${width}: control ${c.kind} at ${c.x}+${c.width}`);
        }
      }
    } finally { setLanguage(previous); }
  }
  const narrow = plain(renderMonitor({ tree: tree([named]), state: rich(), width: 22, height: 30, nowMs: now }));
  assert.ok(narrow.some(line => /^› ▸ ⌕ ablation…anker ─+ *$/.test(line)), `under 24 columns the badge goes first\n${narrow.join('\n')}`);
  const tiny = plain(renderMonitor({ tree: tree([named]), state: rich(), width: 19, height: 30, nowMs: now }));
  assert.ok(tiny.some(line => /^└ .*56% ▾$/.test(line) && !line.includes('━')), 'then the meter, the percent kept');
  // A child card is indented, one column a level.
  const nested = plain(renderMonitor({ tree: tree([parent]), state: rich(), width: 40, height: 40, nowMs: now }));
  assert.ok(nested.some(line => /^ ┌ ▸ ◈ b05_result/.test(line)), nested.join('\n'));
  const folded = plain(renderMonitor({ tree: tree([parent]), state: rich({ tree: { ...rich().tree, collapsed: new Set([parent.id]) } }), width: 40, height: 40, nowMs: now }));
  assert.ok(!folded.some(line => line.includes('b05_result')));
  assert.ok(folded.some(line => /^└ ◷ 4m07s · \+1 folded ─+ ▾$/.test(line)), 'a collapsed parent counts what it folds');
});

test('a card opens to its whole timeline and the task in full; Enter still inspects, e and Space open', () => {
  const many = [...log.get(named.id)!, ...Array.from({ length: 30 }, (_, i) => ({ at: now - 200_000 + i * 1000, kind: 'report' as const, text: `step ${i}` }))]
    .sort((a, b) => a.at - b.at);
  const agentLog = new Map([[named.id, many]]);
  const frame = renderMonitor({ tree: tree([named]), state: rich(), width: 32, height: 60, nowMs: now, agentLog });
  const ctx = { tree: tree([named]), frame, nowMs: now };
  const viaE = handleMonitorInput(frame.state, key('expand'), ctx).state;
  assert.ok(viaE.cards?.has(named.id));
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('e ')), [key('expand'), key('space')]);
  assert.ok(handleMonitorInput(frame.state, key('space'), ctx).state.cards?.has(named.id), 'Space opens a card');
  assert.equal(handleMonitorInput(frame.state, key('enter'), ctx).state.modes.details, 'open', 'Enter opens the Inspector, as on a tree row');
  assert.ok(!handleMonitorInput(viaE, key('expand'), ctx).state.cards?.has(named.id), 'e again closes it');
  const open = plain(renderMonitor({ tree: tree([named]), state: viaE, width: 32, height: 60, nowMs: now, agentLog }));
  const top = open.findIndex(line => line.includes('ablation_no_reranker'));
  const bottom = open.findIndex((line, i) => i > top && line.startsWith('└'));
  const card = open.slice(top, bottom + 1);
  assert.match(card.at(-1)!, /▴$/);
  assert.ok(card.some(line => /step 29/.test(line)), 'newest first');
  assert.ok(card.some(line => /… \d+ earlier — Inspector/.test(line)), 'capped, the rest left to the Inspector');
  assert.ok(card.length <= 32, `${card.length} lines`);
  assert.equal(card.at(-2)!.trimEnd(), '│ reranker');
  assert.ok(card.some(line => line.trimEnd() === '│ Task'), 'the task in full after a smart name');
  // A compact panel has no cards to open.
  const compact = renderMonitor({ tree: tree([named]), state: initialMonitorState(), width: 32, height: 30, nowMs: now });
  assert.equal(handleMonitorInput(compact.state, key('expand'), { tree: tree([named]), frame: compact }).state.cards, undefined);
  assert.equal(handleMonitorInput(compact.state, key('space'), { tree: tree([named]), frame: compact }).state.modes.details, 'open', 'compact: Space is Enter');
});

test('card clicks: the name switches, the rest of the top rule and ▾ open, the body selects', () => {
  const agents = tree([named, bare]);
  const frame = renderMonitor({ tree: agents, state: rich(), width: 32, height: 40, nowMs: now, agentLog: log });
  const lines = plain(frame);
  const ctx = { tree: agents, frame, nowMs: now };
  const top = lines.findIndex(line => line.includes('small_index_ablation'));
  const name = frame.controls.find(c => c.kind === 'switch' && c.item === bare.id)!;
  assert.equal(name.y, top);
  assert.equal(name.x, lines[top].indexOf('small_index_ablation'));
  assert.equal(name.width, 'small_index_ablation'.length);
  const go = handleMonitorInput(frame.state, click(name.x, top), ctx);
  assert.deepEqual(go.action, { type: 'switch', id: bare.id });
  assert.equal(go.state.tree.selectedId, bare.id);
  // One column either side of the name opens the card instead.
  for (const x of [name.x - 1, name.x + name.width]) {
    const side = handleMonitorInput(frame.state, click(x, top), ctx);
    assert.equal(side.action, undefined, `x ${x}`);
    assert.ok(side.state.cards?.has(bare.id));
    assert.equal(side.state.tree.selectedId, bare.id);
  }
  const bottom = lines.findIndex((line, i) => i > top && line.startsWith('└'));
  const toggle = frame.controls.find(c => c.kind === 'expand' && c.y === bottom)!;
  assert.equal(stripAnsi(lines[bottom])[toggle.x], '▾');
  assert.ok(handleMonitorInput(frame.state, click(toggle.x, bottom), ctx).state.cards?.has(bare.id));
  // The body and the rest of the bottom rule select, and do no more.
  for (const [x, y] of [[4, top + 1], [3, bottom]]) {
    const picked = handleMonitorInput(frame.state, click(x, y), ctx);
    assert.equal(picked.action, undefined);
    assert.equal(picked.state.tree.selectedId, bare.id);
    assert.ok(!picked.state.cards?.has(bare.id));
  }
  assert.equal(monitorItemAt(frame.panes[0], 4, top + 1), bare.id);
  // `o` still switches to the selected card.
  assert.deepEqual(handleMonitorInput(go.state, key('open-session'), ctx).action, { type: 'switch', id: bare.id });
  // Compact keeps what a click on a tree row did: select and switch.
  const compact = renderMonitor({ tree: agents, state: initialMonitorState(), width: 32, height: 40, nowMs: now });
  const row = plain(compact).findIndex(line => line.includes('small_index_ablation'));
  assert.deepEqual(handleMonitorInput(compact.state, click(4, row), { tree: agents, frame: compact, nowMs: now }).action, { type: 'switch', id: bare.id });
});

test('the agents view scrolls: a hint says what is out of view, the wheel and pages move it, the selection pulls it', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => agent(10 + i, `worker_${i}`, 'running', { task: `task ${i}` }));
  const agents = tree(nodes);
  for (const style of ['rich', 'compact'] as const) {
    let state: MonitorState = { ...rich(), style };
    const draw = () => renderMonitor({ tree: agents, state, width: 32, height: 20, nowMs: now, agentLog: style === 'compact' ? new Map() : undefined,
      brief: style === 'compact' ? { text: 'line\n'.repeat(40) } : undefined });
    let frame = draw();
    const hint = () => plain(frame)[frame.panes[0].y + frame.panes[0].height - 1];
    assert.match(hint(), /^↓ \d+ more lines/, style);
    assert.equal(frame.panes[0].offset, 0, 'opening the panel does not scroll to the first agent');
    const ctx = () => ({ tree: agents, frame, nowMs: now });
    // The wheel over the view scrolls it and leaves the selection be.
    const selected = frame.state.tree.selectedId;
    state = handleMonitorInput(frame.state, { type: 'mouse', button: 'wheel-down', x: 3, y: 5 }, ctx()).state;
    frame = draw();
    assert.equal(frame.panes[0].offset, 3, style);
    assert.equal(frame.state.tree.selectedId, selected);
    assert.match(hint(), /^↑ 3  ↓ \d+ more lines/);
    assert.match(plain(frame)[frame.panes[0].y], /12 run/, 'the summary line stays put');
    // Repaints keep the place; PgDn goes a page on; past the end is clamped.
    frame = draw(); state = frame.state; frame = draw();
    assert.equal(frame.panes[0].offset, 3);
    state = handleMonitorInput(frame.state, key('page-down'), ctx()).state; frame = draw();
    assert.ok(frame.panes[0].offset > 3);
    state = { ...frame.state, scroll: { ...frame.state.scroll, agents: 999 } }; frame = draw();
    assert.equal(frame.panes[0].offset, frame.panes[0].contentLength - frame.panes[0].visible!, 'clamped');
    assert.match(hint(), /^↑ \d+ more lines/);
    // Moving the selection brings it into view.
    state = handleMonitorInput(frame.state, key('home'), ctx()).state; frame = draw();
    const first = frame.panes[0].rows.findIndex(row => row.item === frame.state.tree.selectedId);
    assert.ok(first - 1 >= frame.panes[0].offset && first - 1 < frame.panes[0].offset + frame.panes[0].visible! - 1, `${style}: selection in view`);
    state = handleMonitorInput(frame.state, key('end'), ctx()).state; frame = draw();
    const last = frame.panes[0].rows.map(row => row.item).lastIndexOf(frame.state.tree.selectedId!);
    assert.ok(last < 1 + frame.panes[0].offset + frame.panes[0].visible! - 1, `${style}: the last one too`);
    // A click on the hint scrolls a page.
    const more = frame.controls.find(c => c.kind === 'more')!;
    assert.ok(more);
  }
  // Content arriving above does not move what the reader is looking at.
  let state = rich();
  let frame = renderMonitor({ tree: agents, state, width: 32, height: 20, nowMs: now });
  state = { ...frame.state, scroll: { ...frame.state.scroll, agents: 8 } };
  frame = renderMonitor({ tree: agents, state, width: 32, height: 20, nowMs: now });
  const before = plain(frame)[2];
  const grown = tree([agent(99, 'newcomer', 'running', { turnStartedAt: new Date(now - 1000), startedAt: new Date(now - 1000) }), ...nodes]);
  frame = renderMonitor({ tree: grown, state: frame.state, width: 32, height: 20, nowMs: now });
  assert.equal(plain(frame)[2], before, 'the same line stays at the top of the view');
  // A cramped view drops its blank lines rather than scroll past most of what it holds.
  const short = plain(renderMonitor({ tree: tree(nodes.slice(0, 3)), state: rich(), width: 32, height: 12, nowMs: now }));
  assert.ok(!short.slice(2, 10).some(line => line.trim() === ''), short.join('\n'));
  const tall = plain(renderMonitor({ tree: tree(nodes.slice(0, 3)), state: rich(), width: 32, height: 30, nowMs: now }));
  assert.ok(tall.slice(2, 12).some(line => line.trim() === ''), 'with room, a blank line between cards');
});

test('rich: the summary heads the view with the linger switch; hidden agents have no card; 1 focuses the cards; help says so', () => {
  const old = agent(30, 'old_one', 'completed', { statusAt: new Date(now - 3 * 3600_000) });
  const state = rich({ tree: { ...rich().tree, lingerMs: 180_000 } });
  const frame = renderMonitor({ tree: tree([named, old]), state, width: 32, height: 30, nowMs: now });
  const lines = plain(frame);
  assert.match(lines[1], /▸1 run .* \+1 older$/);
  assert.ok(!lines.some(line => line.includes('old_one')));
  const shown = handleMonitorInput(frame.state, click(2, 1), { tree: tree([named, old]), frame, nowMs: now }).state;
  assert.ok(plain(renderMonitor({ tree: tree([named, old]), state: shown, width: 32, height: 30, nowMs: now })).some(line => line.includes('old_one')));
  assert.ok(!lines.some(line => line.includes('Agents')), 'no Agents pane');
  const focused = handleMonitorInput({ ...frame.state, modes: { ...frame.state.modes, worktrees: 'open' }, focus: 'worktrees' }, key('agents'), { tree: tree([named]), frame }).state;
  assert.equal(focused.focus, 'agents');
  const help = (style: 'rich' | 'compact') => plain(renderMonitor({ tree: tree([]), state: { ...rich(), style, help: true }, width: 70, height: 80, nowMs: now })).join('\n');
  assert.match(help('rich'), /e or Space open \/ close card/);
  assert.match(help('rich'), /Click its name: switch/);
  assert.match(help('rich'), /1 Cards/);
  assert.match(help('rich'), /⌕ research ⚗ experiment ⚒ fix/);
  assert.doesNotMatch(help('compact'), /open \/ close card/);
  const previous = setLanguage('zh');
  try { assert.match(plain(renderMonitor({ tree: tree([]), state: { ...rich(), help: true }, width: 70, height: 80, nowMs: now })).join('\n'), /e 或空格 展开 \/ 收起卡片[\s\S]*⌕ 调研/); }
  finally { setLanguage(previous); }
});

test('panelStyle: rich by default, an older settings file loads, a bad value falls back, the Panel group offers both', () => {
  assert.equal(defaultSettings().panelStyle, 'rich');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-style-'));
  const file = path.join(dir, 'hud-settings.json');
  const previous = process.env.CODEX_HUD_SETTINGS_PATH;
  process.env.CODEX_HUD_SETTINGS_PATH = file;
  try {
    fs.writeFileSync(file, JSON.stringify({ sort: 'created' }));
    assert.equal(loadSettings().panelStyle, 'rich');
    saveSettings({ panelStyle: 'compact' });
    assert.equal(loadSettings().panelStyle, 'compact');
    fs.writeFileSync(file, JSON.stringify({ panelStyle: 'fancy' }));
    assert.equal(loadSettings().panelStyle, 'rich');
  } finally {
    if (previous === undefined) delete process.env.CODEX_HUD_SETTINGS_PATH; else process.env.CODEX_HUD_SETTINGS_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const row = SETTING_ROWS.find(r => r.key === 'panelStyle')!;
  assert.equal(row.group, 'Panel');
  assert.deepEqual(row.values, ['rich', 'compact']);
});

test('helpers: a hanging wrap keeps its text, the turn clock counts seconds', () => {
  const lines = hangLines('one two three four five six', 9, 7);
  assert.equal(lines.join(' '), 'one two three four five six');
  assert.ok(visualLength(lines[0]) <= 9 && lines.slice(1).every(line => visualLength(line) <= 7));
  assert.deepEqual([clockText(42_000), clockText(247_000), clockText(3_840_000)], ['42s', '4m07s', '1h04m']);
});
