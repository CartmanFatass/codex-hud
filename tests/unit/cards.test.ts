import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialMonitorState, renderMonitor, handleMonitorInput, monitorItemAt, type MonitorState, type MonitorFrame } from '../../src/render/monitor.js';
import { agentTitle, KIND_GLYPHS } from '../../src/render/agent-title.js';
import { hangLines, clockText } from '../../src/render/cards.js';
import { directions } from '../../src/render/directions.js';
import { stripAnsi, visualLength, theme, colors, truncateAnsi } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';
import { displayConfig, setDisplayConfig } from '../../src/render/hud-config.js';
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
  assert.equal(lines[top + 2].trimEnd(), '│ ~ 召回下降，结果待核对', 'then the newest model note, one line, no age');
  assert.equal(lines[top + 3].trimEnd(), '│ recall@10 0.71', 'then the newest update in its own words');
  assert.match(lines[top + 4], /^└ ◷4m07s ─*56%─+ ▾$/, 'the turn clock counting seconds, the rule as the context meter, the switch');
  assert.ok(frame.lines[top + 4].includes(theme.tick('◷')), 'the clock face is the time\'s scale: the tick colour');
  assert.ok(frame.lines[top + 1].startsWith(theme.info('│')), 'a card is painted by its state, selected or not');
  assert.ok(frame.lines[top].startsWith(theme.selectedBand('X').split('X')[0]) && frame.lines[top].includes(theme.accent('›')),
    'the selection is the corner, on the selected surface');
  // A card with no smart name: the task under the name, cut to one line; the time since it failed.
  const second = lines.findIndex(line => line.includes('small_index_ablation'));
  assert.match(lines[second], /^┌ ! small_index_ablation ─+$/, 'no glyph, no badge, no right border');
  assert.match(lines[second + 1], /^│ Build a small index and comp.*…$/);
  assert.match(lines[second + 2], /^└ 2m ─+ ▾$/, 'its failing is the bottom rule\'s to say, not said twice inside');
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
  assert.ok(tiny.some(line => /^└ .*56%─* ▾$/.test(line) && !line.includes('━')), 'then the meter, the percent kept');
  // A subtask gets no card: its lead's card counts it by role.
  const nested = plain(renderMonitor({ tree: tree([parent]), state: rich(), width: 40, height: 40, nowMs: now }));
  assert.ok(!nested.some(line => line.includes('b05_result')), nested.join('\n'));
  assert.ok(nested.some(line => line.trimEnd() === '│ 1 general'), 'Codex\'s default agent, or one with no role, is "general"');
  assert.ok(!nested.some(line => /folded/.test(line)));
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

test('the agents view scrolls: its band says which rows are in view, the wheel and pages move it, the selection pulls it', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => agent(10 + i, `worker_${i}`, 'running', { task: `task ${i}` }));
  const agents = tree(nodes);
  for (const style of ['rich', 'compact'] as const) {
    let state: MonitorState = { ...rich(), style };
    const draw = () => renderMonitor({ tree: agents, state, width: 32, height: 20, nowMs: now, agentLog: style === 'compact' ? new Map() : undefined,
      brief: style === 'compact' ? { text: 'line\n'.repeat(40) } : undefined });
    let frame = draw();
    const hint = () => plain(frame)[frame.panes[0].y];
    assert.match(hint(), / 1–\d+\/\d+ $/, style);
    assert.ok(!plain(frame).some(line => /more lines/.test(line)), 'no line says what is below');
    assert.equal(frame.panes[0].offset, 0, 'opening the panel does not scroll to the first agent');
    const ctx = () => ({ tree: agents, frame, nowMs: now });
    // The wheel over the view scrolls it and leaves the selection be.
    const selected = frame.state.tree.selectedId;
    state = handleMonitorInput(frame.state, { type: 'mouse', button: 'wheel-down', x: 3, y: 5 }, ctx()).state;
    frame = draw();
    assert.equal(frame.panes[0].offset, 3, style);
    assert.equal(frame.state.tree.selectedId, selected);
    assert.match(hint(), / 4–\d+\/\d+ $/);
    assert.match(plain(frame)[frame.panes[0].y], /^ ▦ Agents {2}▸12 run +4–/, 'the title stays put');
    // Repaints keep the place; PgDn goes a page on; past the end is clamped.
    frame = draw(); state = frame.state; frame = draw();
    assert.equal(frame.panes[0].offset, 3);
    state = handleMonitorInput(frame.state, key('page-down'), ctx()).state; frame = draw();
    assert.ok(frame.panes[0].offset > 3);
    state = { ...frame.state, scroll: { ...frame.state.scroll, agents: 999 } }; frame = draw();
    assert.equal(frame.panes[0].offset, frame.panes[0].contentLength - frame.panes[0].visible!, 'clamped');
    assert.match(hint(), /–(\d+)\/\1 $/, 'at the end');
    // Moving the selection brings it into view.
    state = handleMonitorInput(frame.state, key('home'), ctx()).state; frame = draw();
    const first = frame.panes[0].rows.findIndex(row => row.item === frame.state.tree.selectedId);
    assert.ok(first - 1 >= frame.panes[0].offset && first - 1 < frame.panes[0].offset + frame.panes[0].visible! - 1, `${style}: selection in view`);
    state = handleMonitorInput(frame.state, key('end'), ctx()).state; frame = draw();
    const last = frame.panes[0].rows.map(row => row.item).lastIndexOf(frame.state.tree.selectedId!);
    assert.ok(last < 1 + frame.panes[0].offset + frame.panes[0].visible! - 1, `${style}: the last one too`);
    // The band is the view's title: a click there zooms it.
    const zoom = frame.controls.find(c => c.kind === 'zoom' && c.pane === 'agents')!;
    assert.equal(zoom.y, frame.panes[0].y);
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

test('rich: the summary heads the view with the linger switch; hidden agents have no card; 1 opens and closes the cards; help says so', () => {
  const old = agent(30, 'old_one', 'completed', { statusAt: new Date(now - 3 * 3600_000) });
  const state = rich({ tree: { ...rich().tree, lingerMs: 180_000 } });
  const frame = renderMonitor({ tree: tree([named, old]), state, width: 32, height: 30, nowMs: now });
  const lines = plain(frame);
  assert.equal(lines[1], ' '.repeat(32), 'a blank row under the bar, the panel being tall enough');
  assert.equal(lines[frame.panes[0].y].trimEnd(), ' ▦ Agents  ✓1 done  ▸1 run', 'each count with its word, the hidden one counted');
  assert.match(lines[0], /⊕1 ⚙ \? $/, lines[0]);
  assert.ok(!lines.some(line => line.includes('old_one')));
  const older = frame.controls.find(c => c.kind === 'older')!;
  const shown = handleMonitorInput(frame.state, click(older.x, 0), { tree: tree([named, old]), frame, nowMs: now }).state;
  assert.ok(plain(renderMonitor({ tree: tree([named, old]), state: shown, width: 32, height: 30, nowMs: now })).some(line => line.includes('old_one')));
  assert.equal(lines.slice(1).filter(line => line.includes('Agents')).length, 1, 'under the bar, the cards have one title, their counts beside it');
  const focused = handleMonitorInput({ ...frame.state, modes: { ...frame.state.modes, agents: 'closed', changes: 'open' }, focus: 'changes' }, key('agents'), { tree: tree([named]), frame }).state;
  assert.equal(focused.focus, 'agents');
  assert.equal(focused.modes.agents, 'open', '1 opens the cards, and focuses them');
  assert.equal(handleMonitorInput(focused, key('agents'), { tree: tree([named]), frame }).state.modes.agents, 'closed', 'and closes them again');
  const help = (style: 'rich' | 'compact') => plain(renderMonitor({ tree: tree([]), state: { ...rich(), style, help: true }, width: 70, height: 80, nowMs: now })).join('\n');
  assert.match(help('rich'), /\ne \/ Space +open \/ close card\n/);
  assert.match(help('rich'), /Click its name: switch/);
  assert.match(help('rich'), /1 Cards/);
  assert.match(help('rich'), /⌕ research ⚗ experiment ⚒ fix/);
  assert.doesNotMatch(help('compact'), /open \/ close card/);
  const previous = setLanguage('zh');
  try { assert.match(plain(renderMonitor({ tree: tree([]), state: { ...rich(), help: true }, width: 70, height: 80, nowMs: now })).join('\n'), /e \/ 空格 +展开 \/ 收起卡片[\s\S]*⌕ 调研/); }
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

const ctxUsage = (percent: number) => ({ percent, used: percent, total: 100, inputTokens: 0, outputTokens: 0, cachedTokens: 0, compactCount: 0 });
const finished = (i: number, name: string, minutesAgo: number, extra: Partial<SubagentTreeNode> = {}) =>
  agent(i, name, 'completed', { statusAt: new Date(now - minutesAgo * 60_000), lastEventAt: new Date(now - minutesAgo * 60_000), contextUsage: ctxUsage(57),
    model: 'gpt-5.4-luna', effort: 'medium', ...extra });
const withGlyphs = <T>(glyphs: 'glyph' | 'text' | 'both', run: () => T): T => {
  const previous = displayConfig();
  setDisplayConfig({ glyphs });
  try { return run(); } finally { setDisplayConfig(previous); }
};

test('a finished agent a minute old is one line, its meter and age in columns; e, Space or a click opens it, j/k only marks it', () => {
  const old = [finished(20, 'audit_code_paths', 60 * 24 * 12, { task: 'Audit the code paths' }), finished(21, 'migrate', 60 * 24 * 12, { contextUsage: ctxUsage(29) })];
  const fresh = finished(22, 'just_done', 0.5, { lastReport: { text: 'All done', kind: 'reply', at: new Date(now - 30_000) } });
  const nodes = [...old, fresh];
  const state = rich({ tree: { ...rich().tree, showAll: true, selectedId: old[0].id } });
  const frame = renderMonitor({ tree: tree(nodes), state, width: 90, height: 40, nowMs: now });
  const lines = plain(frame);
  const rows = lines.filter(line => /^[› ]✓ (audit|migrate)/.test(line));
  assert.equal(rows.length, 2, lines.join('\n'));
  assert.match(rows[0], /^›✓ audit_code_paths +☽◐ Luna ─+57%─+ 12d$/);
  assert.ok(frame.lines[lines.indexOf(rows[0])].startsWith(theme.selectedBand('X').split('X')[0]), 'the selected row is on its own surface');
  assert.equal(lines[lines.indexOf(rows[0]) + 1].trimEnd(), '   Audit the code paths', 'under it, indented under the name, how far it got: here, what it was for');
  assert.equal(rows[0].length, rows[1].length);
  assert.equal(rows[0].lastIndexOf('─'), rows[1].lastIndexOf('─'), 'the meters line up');
  assert.equal(lines.indexOf(rows[1]) - lines.indexOf(rows[0]), 2, 'finished rows sit together, two lines each, no blank between');
  assert.ok(lines.some(line => /^┌ ✓ just_done/.test(line)), 'just finished: still a card, so its report shows for a minute');
  assert.ok(frame.lines.every(line => visualLength(line) <= 90));
  // j/k moves the mark and does not open.
  const ctx = { tree: tree(nodes), frame, nowMs: now };
  const moved = handleMonitorInput(frame.state, key('down'), ctx).state;
  assert.equal(moved.tree.selectedId, old[1].id);
  assert.ok(!(moved.cards?.has(old[1].id)));
  const after = plain(renderMonitor({ tree: tree(nodes), state: moved, width: 90, height: 40, nowMs: now }));
  assert.equal(after.filter(line => /^[› ]✓ (audit|migrate)/.test(line)).length, 2, 'the height does not jump');
  assert.equal(after.length, lines.length);
  // e opens it; a click on the row does too.
  const opened = handleMonitorInput(moved, key('expand'), ctx).state;
  assert.ok(opened.cards?.has(old[1].id));
  const y = lines.indexOf(rows[1]);
  const clicked = handleMonitorInput(frame.state, click(10, y), ctx).state;
  assert.ok(clicked.cards?.has(old[1].id));
  const open = plain(renderMonitor({ tree: tree(nodes), state: opened, width: 90, height: 40, nowMs: now }));
  assert.ok(open.some(line => /^› ✓ migrate ─+/.test(line)) && open.some(line => /^└ 12d ─+29%─+ ▴$/.test(line)), open.join('\n'));
  // Glyphs off: the age says ago.
  const words = withGlyphs('text', () => plain(renderMonitor({ tree: tree(nodes), state, width: 90, height: 40, nowMs: now })));
  assert.ok(words.some(line => /12d ago$/.test(line)), words.join('\n'));
  // In Chinese the age column is measured in display width: snug, and still one column.
  const mixed = [old[0], finished(23, 'migrate', 2, { contextUsage: ctxUsage(29) })];
  const previous = setLanguage('zh');
  try {
    const zh = withGlyphs('text', () => plain(renderMonitor({ tree: tree(mixed), state, width: 90, height: 40, nowMs: now })))
      .filter(line => /^[› ]✓ (audit|migrate)/.test(line));
    assert.equal(zh.length, 2, zh.join('\n'));
    assert.match(zh[0], /[━╸─] 12d前$/, 'the column is as wide as the words, not the English ones');
    assert.match(zh[1], /[━╸─] {2}2m前$/);
    assert.equal(visualLength(zh[0]), visualLength(zh[1]));
    assert.equal(visualLength(zh[0].slice(0, zh[0].lastIndexOf('─'))), visualLength(zh[1].slice(0, zh[1].lastIndexOf('─'))), 'the meters line up');
  } finally { setLanguage(previous); }
});

test('finished rows keep their names whole, drawing meters only where most names fit beside them, and say a run of equal ages once', () => {
  const names = ['refactor_session_store', 'audit_render_paths', 'migrate_settings_file'];
  const nodes = [...names.map((name, i) => finished(40 + i, name, 60 * 24 * 12)), finished(43, 'tidy_docs', 180)];
  const state = rich({ tree: { ...rich().tree, showAll: true } });
  const rowsOf = (list: SubagentTreeNode[], width: number, at = state) =>
    plain(renderMonitor({ tree: tree(list), state: at, width, height: 40, nowMs: now })).filter(line => /^[› ]✓ /.test(line));
  const narrow = rowsOf(nodes, 40);
  assert.equal(narrow.length, 4, narrow.join('\n'));
  assert.ok(narrow.every(line => !line.includes('%')), `at 40 a meter would cut the names, so none is drawn:\n${narrow.join('\n')}`);
  assert.ok(names.every(name => narrow.some(line => line.includes(name))));
  const wide = rowsOf(nodes, 56);
  assert.ok(wide.every(line => line.includes('57%')) && names.every(name => wide.some(line => line.includes(name))), wide.join('\n'));
  // The age at the top of a run only, its column kept so the rows still line up.
  assert.match(wide[0], /─ 12d$/);
  assert.ok(wide.slice(1, 3).every(line => /─ {4}$/.test(line)), wide.join('\n'));
  assert.match(wide[3], /─ {2}3h$/);
  assert.ok(wide.every(line => line.length === wide[0].length));
  // An opened card between two rows ends the run: the row after it says its age again.
  const split = rowsOf(nodes, 56, rich({ cards: new Set([nodes[1].id]), tree: { ...rich().tree, showAll: true } }));
  assert.match(split[1], /^ ✓ migrate_settings_file .* 12d$/, split.join('\n'));
  // One long name among short ones does not cost the others their meters: it alone is cut.
  const mixed = rowsOf([finished(44, 'alpha', 60), finished(45, 'beta', 60), finished(46, 'refactor_the_session_store_layer', 60)], 56);
  assert.ok(mixed.every(line => line.includes('57%')) && mixed[2].includes('…'), mixed.join('\n'));
});

test('an opened finished card with no log shows its last report, its markdown taken out, and an old card steps its words back', () => {
  const report = 'Published [the handoff](/x/HANDOFF.md) at **`d97a7a688774ad9b45da44f5825ae1ac198b4bb1`**. ### Next __steps__ follow.';
  const done = finished(30, 'cache_clean', 60 * 19, { lastReport: { text: report, kind: 'reply', at: new Date(now - 19 * 3600_000) }, task: 'Write the handoff' });
  const state = rich({ cards: new Set([done.id]), tree: { ...rich().tree, showAll: true } });
  const frame = renderMonitor({ tree: tree([done]), state, width: 90, height: 40, nowMs: now });
  const lines = plain(frame);
  const at = lines.findIndex(line => line.includes('Published'));
  assert.ok(at > 0, lines.join('\n'));
  assert.equal(lines[at].trimEnd(), '│ Published the handoff at d97a7a6. Next steps follow.');
  assert.ok(frame.lines[at].includes(colors.dim('X').split('X')[0] + 'Published the handoff'), 'old news: the body is dim with the name');
  // A closed card's entry: one line, cut, and no age on a line of its own.
  const long = 'word '.repeat(80);
  const busy = agent(31, 'busy', 'running', { contextUsage: ctxUsage(20) });
  const shown = plain(renderMonitor({ tree: tree([busy]), state: rich(), width: 40, height: 40, nowMs: now,
    agentLog: new Map([[busy.id, [{ at: now - 60_000, kind: 'report' as const, text: long }]]]) }));
  const body = shown.filter(line => line.startsWith('│ word') || line.startsWith('│   word'));
  assert.equal(body.length, 1, shown.join('\n'));
  assert.match(body[0], /…$/);
  assert.ok(!shown.some(line => /^│ +1m$/.test(line)), 'no orphan age line');
});

test('guardian reviews fold into a ◈N chip on their parent, and the summary counts every one; a failed one still shows', () => {
  const guardian = (i: number, status: SubagentTreeNode['status'] = 'completed') =>
    agent(i, 'guardian', status, { kind: 'guardian', task: 'The following is the Codex agent history whose request action you are assessing.',
      statusAt: new Date(now - 3600_000), lastEventAt: new Date(now - 3600_000) });
  const parent = agent(40, 'bench_corpus', 'running', { children: [guardian(41), guardian(42, 'running')] });
  const nodes = [guardian(43), parent, finished(44, 'other', 30, { children: [guardian(45, 'error')] })];
  const state = rich({ tree: { ...rich().tree, showAll: true } });
  const frame = renderMonitor({ tree: tree(nodes), state, width: 60, height: 50, nowMs: now });
  const lines = plain(frame);
  assert.match(lines[frame.panes[0].y], /^ ▦ Agents {2}✓1 done {2}▸1 run {2}◈4 reviews *$/, 'the agents counted, and beside them the session\'s reviews, wherever they sit');
  assert.ok(frame.lines[frame.panes[0].y].includes(theme.error('◈4')), 'one failed: the summary\'s chip in the error colour');
  const top = lines.find(line => line.includes('bench_corpus'))!;
  assert.match(top, /◈2/);
  assert.ok(frame.lines.some(line => line.includes(theme.info('◈2'))), 'a running review: the chip in the info colour');
  assert.ok(!lines.some(line => /The following is the Codex/.test(line)), 'never the review prompt');
  assert.ok(!lines.some(line => line.includes('guardian')), 'a review is no card');
  assert.match(lines.find(line => line.includes('other'))!, /✗1/, 'a failed one counts among its lead\'s failures');
  const opened = plain(renderMonitor({ tree: tree(nodes), state: { ...state, cards: new Set([id(44)]) }, width: 60, height: 50, nowMs: now }));
  assert.ok(opened.some(line => /^│ ! guardian +\d+h$/.test(line.trimEnd())), 'and has a line on its lead\'s card');
  // j/k never lands on a folded review.
  let s = frame.state;
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) { s = handleMonitorInput(s, key('down'), { tree: tree(nodes), frame, nowMs: now }).state; seen.add(s.tree.selectedId!); }
  assert.ok(![41, 42, 43].some(i => seen.has(id(i))), [...seen].join(','));
  // The compact tree folds them the same way.
  const compact = plain(renderMonitor({ tree: tree(nodes), state: { ...state, style: 'compact' }, width: 60, height: 50, nowMs: now }));
  assert.ok(compact.some(line => /bench_corpus .*◈2/.test(line)), compact.join('\n'));
  assert.equal(compact.filter(line => / guardian/.test(line)).length, 1);
});

test('a finished agent\'s second line says how far it got: the newest model note, else its newest update, else its task', () => {
  const done = (i: number, extra: Partial<SubagentTreeNode> = {}) => finished(i, `done_${i}`, 60 * 19, { task: `Task of ${i}`, contextUsage: ctxUsage(41), ...extra });
  const nodes = [done(50), done(51), done(52), done(53, { task: undefined })];
  const agentLog = new Map<string, AgentLogEntry[]>([
    [nodes[0].id, [{ at: now - 7200_000, kind: 'report', text: 'Pushed **the** handoff' }, { at: now - 3600_000, kind: 'note', text: 'Handoff published, awaiting review' }]],
    [nodes[1].id, [{ at: now - 3600_000, kind: 'report', text: 'Pushed **the** handoff' }, { at: now - 60_000, kind: 'finished', text: '' }]],
  ]);
  for (const width of [32, 40, 56]) {
    const state = rich({ tree: { ...rich().tree, showAll: true, selectedId: nodes[1].id } });
    const frame = renderMonitor({ tree: tree(nodes), state, width, height: 44, nowMs: now, agentLog });
    const lines = plain(frame);
    const under = (name: string) => lines[lines.findIndex(line => line.includes(name)) + 1];
    assert.equal(under('done_50').trimEnd(), truncateAnsi('   ~ Handoff published, awaiting review', width));
    assert.equal(under('done_51').trimEnd(), '   Pushed the handoff', 'the agent\'s own words, markdown out');
    assert.equal(under('done_52').trimEnd(), '   Task of 52');
    assert.ok(!/^ {3}\S/.test(under('done_53') ?? ''), 'nothing to say: no second line');
    assert.ok(frame.lines.every(line => visualLength(line) <= width));
    const row = lines.find(line => line.includes('done_50'))!;
    assert.equal(row.lastIndexOf('─') - row.indexOf('─') + 1, width >= 56 ? 16 : width < 36 ? 8 : 12, `${width}: the meter's cells`);
    const meter = frame.lines.find(line => line.includes('done_50'))!;
    assert.ok(meter.includes(theme.info('X').split('X')[0] + '─'), 'an old row keeps its meter\'s zone colour');
    assert.ok(meter.includes(colors.dim(directions(tree(nodes)).paint(nodes[0].id)('done_50'))), 'only the name dims, in its direction\'s colour');
  }
  // Compact: only the selected row has its second line.
  const compact = plain(renderMonitor({ tree: tree(nodes), state: { ...initialMonitorState(), tree: { ...initialMonitorState().tree, selectedId: nodes[0].id } },
    width: 40, height: 44, nowMs: now, agentLog }));
  assert.equal(compact.filter(line => /^ +~ Handoff/.test(line)).length, 1, compact.join('\n'));
  assert.ok(!compact.some(line => /Task of 52/.test(line)), 'the others stay one line');
});
