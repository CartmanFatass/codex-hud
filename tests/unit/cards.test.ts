import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialMonitorState, renderMonitor, handleMonitorInput, monitorItemAt, HELP_TABS, type MonitorState, type MonitorFrame } from '../../src/render/monitor.js';
import { agentTitle, KIND_GLYPHS } from '../../src/render/agent-title.js';
import { hangLines, clockText, agentCard, cardSummaryTargets } from '../../src/render/cards.js';
import { inspectorRows } from '../../src/render/monitor-inspector.js';
import { directions } from '../../src/render/directions.js';
import { stripAnsi, visualLength, theme, colors, truncateAnsi } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';
import { displayConfig, setDisplayConfig } from '../../src/render/hud-config.js';
import { defaultSettings, loadSettings, saveSettings } from '../../src/settings.js';
import { SETTING_ROWS } from '../../src/render/settings-page.js';
import type { AgentLogEntry } from '../../src/collectors/agent-log.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';
import { useDisplayFixture } from '../fixtures/display.js';

useDisplayFixture();

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

test('a card always names/statuses the L1, keeps model text inside, and clock/context below', () => {
  const frame = renderMonitor({ tree: tree([named, bare]), state: rich(), width: 32, height: 40, nowMs: now, agentLog: log });
  const lines = plain(frame);
  const top = lines.findIndex(line => line.includes('ablation_no_reranker'));
  assert.match(lines[top], /^› ▸ ⌕ ablation_no_reranker ─+ \S/);
  assert.ok(frame.lines[top].includes(colors.underline('ablation_no_reranker')));
  assert.equal(lines[top + 1].trimEnd(), '│ 去重排消融召回对比');
  assert.ok(frame.lines[top + 1].includes(theme.strong('去重排消融召回对比')));
  assert.equal(lines[top + 2].trimEnd(), '│ 召回下降，结果待核对');
  assert.ok(!lines.some(line => line.includes('recall@10')));
  assert.match(lines[top + 3], /^└ ◷4m07s ─*56%─+$/);
  assert.ok(frame.lines[top + 3].includes(theme.tick('◷')));
  assert.ok(frame.lines[top + 1].startsWith(theme.info('│')));
  assert.ok(frame.lines[top].includes(theme.accent('›')));
  const second = lines.findIndex(line => line.includes('small_index_ablation'));
  assert.match(lines[second], /^┌ ! small_index_ablation ─+$/);
  assert.match(lines[second+1], /^└ 2m ─+$/);
  assert.equal(lines[second-1].trim(), '');
  assert.ok(!frame.controls.some(c => (c.kind as string) === 'expand'));
  assert.ok(!lines.some(line => /[▾▴]/.test(line)));
  const compact = plain(renderMonitor({ tree: tree([named, bare]), state: initialMonitorState(), width: 32, height: 40, nowMs: now, agentLog: log }));
  assert.ok(compact.some(line => /^›▸ ablation_no_reranker/.test(line)));
  const header = compact.findIndex(line => /^ ▸ ⌕ ablation_no_reranker/.test(line));
  assert.ok(header > 0);
  assert.equal(compact[header+1].trimEnd(), '   去重排消融召回对比');
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
      for (const width of [16, 24, 32, 40, 48, 56]) {
        const state = rich();
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
  assert.ok(tiny.some(line => /^└ .*56%─*$/.test(line) && !line.includes('━')), 'then the meter, the percent kept');
  // A subtask gets no card of its own. Closed, a live one is one line and the role count waits until the card is open.
  const nested = plain(renderMonitor({ tree: tree([parent]), state: rich(), width: 40, height: 40, nowMs: now }));
  assert.ok(nested.some(line => line.includes('b05_result')), nested.join('\n'));
  assert.ok(nested.some(line => /1 general/.test(line)), 'role counts are independent of child scope');
  const openedNested = plain(renderMonitor({ tree: tree([parent]), state: rich(), width: 40, height: 40, nowMs: now }));
  assert.ok(openedNested.some(line => line.trimEnd() === '│ 1 general'), 'Codex\'s default agent, or one with no role, is "general"');
  assert.ok(!nested.some(line => /folded/.test(line)));
});

test('a card is already complete without history; Enter inspects it', () => {
  const many = [...log.get(named.id)!, ...Array.from({length:60},(_,i)=>({at:now-200_000+i*1000,kind:i%2 ? 'report' as const : 'note' as const,text:`step ${i}`}))];
  const agentLog = new Map([[named.id,many]]);
  const frame = renderMonitor({tree:tree([named]),state:rich(),width:32,height:60,nowMs:now,agentLog});
  const ctx = {tree:tree([named]),frame,nowMs:now};
  assert.equal(handleMonitorInput(frame.state,key('enter'),ctx).state.modes.details,'open');
  const after = plain(renderMonitor({tree:ctx.tree,state:frame.state,width:32,height:60,nowMs:now,agentLog}));
  assert.ok(after.some(line=>line.includes('step 58')),'only newest model entry');
  assert.ok(!after.some(line=>/step (?:[0-9]|[1-4][0-9])(?: |$)|Run the ablation/.test(line)));
  const compact = renderMonitor({tree:ctx.tree,state:initialMonitorState(),width:32,height:30,nowMs:now});
  assert.equal(handleMonitorInput(compact.state,key('space'),{tree:ctx.tree,frame:compact}).state.modes.details,'open');
});

test('card clicks select; only its name arms the double-click switch, Enter inspects', () => {
  const agents = tree([named,{...bare,status:'running'}]);
  const notes = new Map(log).set(bare.id,[{at:now-6000,kind:'note',text:'索引对比进行中'}]);
  const frame = renderMonitor({tree:agents,state:rich(),width:32,height:40,nowMs:now,agentLog:notes});
  const lines = plain(frame);
  const ctx = {tree:agents,frame,nowMs:now};
  const top = lines.findIndex(line=>line.includes('small_index_ablation'));
  const name = frame.controls.find(c=>c.kind==='switch' && c.item===bare.id)!;
  assert.equal(name.y,top); assert.equal(name.x,lines[top].indexOf('small_index_ablation'));
  assert.equal(name.width,visualLength('small_index_ablation'));
  const go = handleMonitorInput(frame.state,click(name.x,top),ctx);
  assert.deepEqual(go.action,{type:'pick',id:bare.id});
  assert.equal(go.state.tree.selectedId,bare.id);
  assert.equal(go.state.modes.details,'closed');
  const second = handleMonitorInput(go.state,click(name.x,top),{...ctx,nowMs:now+100});
  assert.deepEqual(second.action,{type:'pick',id:bare.id},'page times the second click and switches');
  const bottom = lines.findIndex((line,i)=>i>top && line.startsWith('└'));
  for (const [x,y] of [[name.x-1,top],[name.x+name.width,top],[4,top+1],[3,bottom]]) {
    const out = handleMonitorInput(frame.state,click(x,y),ctx);
    assert.equal(out.state.tree.selectedId,bare.id); assert.equal(out.state.modes.details,'closed');
    assert.equal(out.action,undefined);
  }
  assert.equal(handleMonitorInput(go.state,key('enter'),ctx).state.modes.details,'open');
  assert.equal(monitorItemAt(frame.panes[0],4,top+1),bare.id);
  assert.deepEqual(handleMonitorInput(go.state,key('open-session'),ctx).action,{type:'switch',id:bare.id});
  const compact = renderMonitor({tree:agents,state:initialMonitorState(),width:32,height:40,nowMs:now});
  const row = plain(compact).findIndex(line=>line.includes('small_index_ablation'));
  const out = handleMonitorInput(compact.state,click(4,row),{tree:agents,frame:compact,nowMs:now});
  assert.deepEqual(out.action,{type:'pick',id:bare.id}); assert.equal(out.state.modes.details,'open');
});

test('a narrow Codex pane does not underline the name; a click there selects', () => {
  const agents = tree([{ ...bare, status: 'running' }]);
  const frame = renderMonitor({ tree: agents, state: rich(), width: 48, height: 40, nowMs: now, linkNames: false });
  const lines = plain(frame);
  const top = lines.findIndex(line => line.includes('small_index_ablation'));
  assert.ok(top > 0, lines.join('\n'));
  assert.ok(!frame.lines[top].includes(colors.underline('small_index_ablation')));
  assert.equal(frame.controls.some(c => c.kind === 'switch'), false);
  const out = handleMonitorInput(frame.state, click(lines[top].indexOf('small_index_ablation'), top), { tree: agents, frame, nowMs: now });
  assert.equal(out.action, undefined);
  assert.equal(out.state.tree.selectedId,bare.id);
  assert.equal(out.state.modes.details, 'closed');
});

test('a click on a subtask line selects it and leaves the Inspector closed', () => {
  const kid = agent(9, 'scout', 'error', { depth: 2, statusAt: new Date(now - 10_000) });
  const lead = agent(8, 'lead', 'running', { children: [kid] });
  const agents = tree([lead]);
  // A finished subtask is on the opened card. A closed card keeps only a live one.
  const frame = renderMonitor({ tree: agents, state: rich(), width: 48, height: 40, nowMs: now });
  const line = plain(frame).findIndex(row => row.includes('scout'));
  assert.ok(line > 0, plain(frame).join('\n'));
  const out = handleMonitorInput(frame.state, click(4, line), { tree: agents, frame, nowMs: now });
  assert.equal(out.action, undefined);
  assert.equal(out.state.tree.selectedId, kid.id);
  assert.equal(out.state.modes.details, 'closed');
  assert.ok(!frame.controls.some(c=>(c.kind as string)==='expand'));
  const details = handleMonitorInput(out.state, key('enter'), { tree: agents, frame, nowMs: now }).state;
  assert.equal(details.modes.details, 'open');
  assert.equal(details.tree.selectedId, kid.id);
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
  const short = plain(renderMonitor({ tree: tree(nodes.slice(0, 5)), state: rich(), width: 32, height: 12, nowMs: now }));
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
  assert.match(lines[0], /Settings.*⊕1 +\? *$/, lines[0]);
  assert.ok(!lines.some(line => line.includes('old_one')));
  const older = frame.controls.find(c => c.kind === 'older')!;
  const shown = handleMonitorInput(frame.state, click(older.x, 0), { tree: tree([named, old]), frame, nowMs: now }).state;
  assert.ok(plain(renderMonitor({ tree: tree([named, old]), state: shown, width: 32, height: 30, nowMs: now })).some(line => line.includes('old_one')));
  assert.equal(lines.slice(1).filter(line => line.includes('Agents')).length, 1, 'under the bar, the cards have one title, their counts beside it');
  const focused = handleMonitorInput({ ...frame.state, modes: { ...frame.state.modes, agents: 'closed', changes: 'open' }, focus: 'changes' }, key('agents'), { tree: tree([named]), frame }).state;
  assert.equal(focused.focus, 'agents');
  assert.equal(focused.modes.agents, 'open', '1 opens the cards, and focuses them');
  assert.equal(handleMonitorInput(focused, key('agents'), { tree: tree([named]), frame }).state.modes.agents, 'closed', 'and closes them again');
  const help = (style: 'rich' | 'compact') => HELP_TABS.map(helpTab => plain(renderMonitor({ tree: tree([]), state: { ...rich(), style, help: true, helpTab }, width: 70, height: 80, nowMs: now })).join('\n')).join('\n');
  assert.doesNotMatch(help('rich'), /open \/ close card/);
  assert.match(help('rich'), /Click a card: select/);
  assert.match(help('rich'), /Click its name: select; double-click switches/);
  assert.match(help('rich'), /Click a blank row: keys stay here/);
  assert.match(help('compact'), /Click agent: inspect; double-click switches/);
  assert.match(help('rich'), /1 Cards/);
  assert.match(help('rich'), /⌕ research ⚗ experiment ⚒ fix/);
  assert.doesNotMatch(help('compact'), /open \/ close card/);
  const previous = setLanguage('zh');
  try { assert.match(plain(renderMonitor({ tree: tree([]), state: { ...rich(), help: true, helpTab: 'legend' }, width: 70, height: 80, nowMs: now })).join('\n'), /⌕ 调研/); }
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
  // Words in place of marks are the icons' setting; the model badge is the glyphs'. Text here means both.
  setDisplayConfig(glyphs === 'text' ? { glyphs, icons: 'text' } : { glyphs });
  try { return run(); } finally { setDisplayConfig(previous); }
};

test('finished agents keep the same card layout, dim old news, navigate without a height jump', () => {
  const old = [finished(20,'audit_code_paths',60*24*12,{task:'Audit the code paths'}),finished(21,'migrate',60*24*12,{contextUsage:ctxUsage(29)})];
  const fresh = finished(22,'just_done',0.5,{lastReport:{text:'All done',kind:'reply',at:new Date(now-30_000)}});
  const nodes = [...old,fresh]; const agents = tree(nodes);
  const state = rich({tree:{...rich().tree,showAll:true,selectedId:old[0].id}});
  const frame = renderMonitor({tree:agents,state,width:90,height:40,nowMs:now});
  const lines = plain(frame);
  assert.equal(lines.filter(line=>/^[┌›] ✓ /.test(line)).length,3);
  assert.equal(lines.filter(line=>/^└ /.test(line)).length,3);
  assert.ok(lines.some(line=>/^└ 12d .*57%/.test(line)));
  assert.ok(lines.some(line=>/^└ 12d .*29%/.test(line)));
  assert.ok(!lines.some(line=>/Audit the code paths|All done/.test(line)));
  const ctx = {tree:agents,frame,nowMs:now};
  const moved = handleMonitorInput(frame.state,key('down'),ctx).state;
  assert.equal(moved.tree.selectedId,old[1].id);
  const next = renderMonitor({tree:agents,state:moved,width:90,height:40,nowMs:now});
  assert.equal(next.panes[0].contentLength,frame.panes[0].contentLength);
  const y = lines.findIndex(line=>line.includes('migrate'));
  const clicked = handleMonitorInput(frame.state,click(2,y),ctx).state;
  assert.equal(clicked.tree.selectedId,old[1].id); assert.equal(clicked.modes.details,'closed');
  const words = withGlyphs('text',()=>plain(renderMonitor({tree:agents,state,width:90,height:40,nowMs:now})));
  assert.ok(words.some(line=>/^└ 12d ago /.test(line)));
  const previous = setLanguage('zh');
  try { assert.ok(withGlyphs('text',()=>plain(renderMonitor({tree:agents,state,width:90,height:40,nowMs:now}))).some(line=>/^└ 12d前 /.test(line))); }
  finally {setLanguage(previous);}
});

test('finished card names stay whole when they fit; each footer retains its own context and age', () => {
  const names = ['refactor_session_store','audit_render_paths','migrate_settings_file'];
  const nodes = [...names.map((name,i)=>finished(40+i,name,60*24*12)),finished(43,'tidy_docs',180)];
  const state = rich({tree:{...rich().tree,showAll:true}});
  for (const width of [32,40,48,56]) {
    const frame = renderMonitor({tree:tree(nodes),state,width,height:60,nowMs:now});
    const lines = plain(frame);
    assert.ok(names.every(name=>lines.some(line=>line.includes(name))),lines.join('\n'));
    assert.equal(lines.filter(line=>/^└ 12d /.test(line)).length,3,'each card owns its age');
    assert.ok(lines.some(line=>/^└ 3h /.test(line)));
    assert.equal(lines.filter(line=>line.includes('57%')).length,4);
    assert.ok(frame.lines.every(line=>visualLength(line)===width));
  }
  const long = finished(44,'refactor_the_session_store_layer_with_extra_suffix',60);
  const lines = plain(renderMonitor({tree:tree([long]),state,width:32,height:40,nowMs:now}));
  assert.ok(lines.some(line=>/^› ✓ /.test(line) && line.includes('…')));
});

test('an opened card leaves the last report to the Inspector, its markdown taken out there; an old card steps its words back', () => {
  const report = 'Published [the handoff](/x/HANDOFF.md) at **`d97a7a688774ad9b45da44f5825ae1ac198b4bb1`**. ### Next __steps__ follow.';
  const done = finished(30, 'cache_clean', 60 * 19, { lastReport: { text: report, kind: 'reply', at: new Date(now - 19 * 3600_000) }, task: 'Write the handoff' });
  const state = rich({ tree: { ...rich().tree, showAll: true, selectedId: done.id } });
  const notes = new Map([[done.id, [{ at: now - 19 * 3600_000, kind: 'digest' as const, text: 'handoff published' }]]]);
  const frame = renderMonitor({ tree: tree([done]), state, width: 90, height: 40, nowMs: now, agentLog: notes });
  const lines = plain(frame);
  assert.ok(!lines.some(line => line.includes('Published') || line.includes('Write the handoff')), lines.join('\n'));
  const inspector = inspectorRows({ tree: tree([done]), nowMs: now, agentLog: notes } as never, { ...state, preview: 'agent' }, 90, now).map(row => stripAnsi(row.text));
  assert.ok(inspector.some(line => line.includes('Published the handoff at d97a7a6. Next steps follow.')), inspector.join('\n'));
  assert.ok(inspector.some(line => line.includes('Write the handoff')), 'the task, always, where the cards leave it');
  assert.ok(inspector.some(line => line.includes('handoff published')), 'the digest is the Inspector\'s');
  // A closed card leaves its update to the opened card and the Inspector: no line cut short, no orphan age.
  const long = 'word '.repeat(80);
  const busy = agent(31, 'busy', 'running', { contextUsage: ctxUsage(20) });
  const shown = plain(renderMonitor({ tree: tree([busy]), state: rich(), width: 40, height: 40, nowMs: now,
    agentLog: new Map([[busy.id, [{ at: now - 60_000, kind: 'report' as const, text: long }]]]) }));
  assert.ok(!shown.some(line => line.includes('word')), shown.join('\n'));
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
  assert.ok(lines.some(line => /^│ ▸ guardian/.test(line)), 'a live review is one line on its parent');
  assert.ok(!lines.some(line => /^[┌╭›]/.test(line) && line.includes('guardian')), 'a review is no card of its own');
  const other = frame.lines.find(line => stripAnsi(line).includes('other'))!;
  assert.doesNotMatch(stripAnsi(other), /✗/, 'a failed review is not one of its lead\'s failed subtasks');
  assert.ok(other.includes(theme.error('◈1')), 'it is its lead\'s chip, in the error colour');
  const opened = plain(renderMonitor({ tree: tree(nodes), state, width: 60, height: 50, nowMs: now }));
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

test('finished cards wrap only the newest model entry, retain meter colors, and never show task/report text', () => {
  const nodes = [50,51,52,53].map(i=>finished(i,`done_${i}`,60*19,{task:`Task of ${i}`,contextUsage:ctxUsage(41)}));
  const agentLog = new Map<string,AgentLogEntry[]>([
    [nodes[0].id,[{at:now-7200_000,kind:'report',text:'Pushed the handoff'},{at:now-3600_000,kind:'note',text:'Handoff published, awaiting review'}]],
    [nodes[1].id,[{at:now-3600_000,kind:'report',text:'Pushed the handoff'},{at:now-60_000,kind:'finished',text:''}]],
  ]);
  for (const width of [16,24,32,40,48,56]) {
    const state = rich({tree:{...rich().tree,showAll:true,selectedId:nodes[1].id}});
    const frame = renderMonitor({tree:tree(nodes),state,width,height:60,nowMs:now,agentLog});
    const lines = plain(frame); const at = lines.findIndex(line=>line.includes('done_50'));
    const end = lines.findIndex((line,i)=>i>at && line.startsWith('└'));
    assert.equal(lines.slice(at+1,end).map(line=>line.slice(2).trim()).join(' '),'Handoff published, awaiting review');
    assert.ok(!lines.some(line=>/Pushed|Task of/.test(line)));
    assert.equal(lines.filter(line=>line.includes('41%')).length,4);
    assert.ok(frame.lines.every(line=>visualLength(line)===width));
    assert.ok(frame.lines.some(line=>line.includes(theme.info('X').split('X')[0]) && line.includes('41%')),'meter keeps zone color');
  }
  const compact = plain(renderMonitor({tree:tree(nodes),state:{...initialMonitorState(),tree:{...initialMonitorState().tree,selectedId:nodes[0].id}},width:40,height:44,nowMs:now,agentLog}));
  assert.equal(compact.filter(line=>/^ +Handoff/.test(line)).length,1);
});

test('a running card\'s clock ticks on cached renders; a resting card keeps its cache entry', () => {
  const working = agent(60,'working_agent','running',{ turnStartedAt: new Date(now-12*60_000), lastEventAt: new Date(now-5*60_000) });
  const resting = finished(61,'resting_agent',60*24*12);
  const agents = tree([working,resting]);
  const footOf = (frame: MonitorFrame, name: string) => {
    const lines = plain(frame);
    const top = lines.findIndex(line=>line.includes(name));
    return lines.slice(top).find((line,i)=>i>0 && /^└/.test(line)) ?? '';
  };
  const first = renderMonitor({tree:agents,state:rich(),width:48,height:40,nowMs:now});
  // The running turn is 12m00s old; a second later the same render loop must say 12m01s.
  const next = renderMonitor({tree:agents,state:first.state,width:48,height:40,nowMs:now+1000});
  assert.match(footOf(first,'working_agent'),/◷12m00s/);
  assert.match(footOf(next,'working_agent'),/◷12m01s/);
  // A resting card's text is the same either way; its cache entry survives the second.
  assert.equal(footOf(next,'resting_agent'),footOf(first,'resting_agent'));
  assert.match(footOf(next,'resting_agent'),/└ 12d /,footOf(next,'resting_agent'));
});

test('a cached card drops an expired output rate even with its clock hidden', () => {
  const working = agent(62,'rate_agent','running',{
    turnStartedAt:new Date(now-12*60_000),lastEventAt:new Date(now-181_000),
    outputRate:{tokensPerSecond:42,sampleMs:30_000,sampledAt:new Date(now-179_500)},
  });
  const agents = tree([working]);
  const first = renderMonitor({tree:agents,state:rich({cardVisibility:{cardClock:false,cardRate:true}}),width:56,height:30,nowMs:now});
  const next = renderMonitor({tree:agents,state:first.state,width:56,height:30,nowMs:now+1000});
  assert.match(plain(first).find(line=>line.startsWith('└')) ?? '',/~42 tok\/s/);
  assert.doesNotMatch(plain(next).find(line=>line.startsWith('└')) ?? '',/tok\/s/);
});
