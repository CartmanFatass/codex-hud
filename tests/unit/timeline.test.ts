import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RolloutParser, type QuotaSample } from '../../src/collectors/rollout.js';
import { quotaForecast, slope, FORECAST_MIN_SPAN_MS } from '../../src/collectors/quota-forecast.js';
import { WorkbenchHistory } from '../../src/collectors/workbench-events.js';
import { initialMonitorState, renderMonitor, handleMonitorInput, monitorModes, monitorPreferences, timelineText } from '../../src/render/monitor.js';
import { directions } from '../../src/render/directions.js';
import { theme } from '../../src/render/colors.js';
import { displayConfig, setDisplayConfig } from '../../src/render/hud-config.js';
import type { WorkbenchEvent } from '../../src/render/workbench-state.js';
import { waitedText, collectAttention } from '../../src/render/attention.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { statusCard } from '../../src/render/status-block.js';
import { buildSnapshot } from '../../src/snapshot.js';
import { resolveNotifierOptions } from '../../src/notify.js';
import { defaultSettings } from '../../src/settings.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import { makeHudData, makeSubagentTree, FIXED_NOW } from '../fixtures/hud-data.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const now = Date.parse('2026-10-01T10:00:00Z');
const at = (seconds: number) => new Date(now + seconds * 1000);
const row = (type: string, payload: object, seconds: number) => JSON.stringify({ timestamp: at(seconds).toISOString(), type, payload }) + '\n';
const quota = (percent: number, seconds: number, resets = 3 * 3600) => row('event_msg', { type: 'token_count',
  rate_limits: { primary: { used_percent: percent, window_minutes: 300, resets_at: Math.floor(now / 1000) + resets } } }, seconds);

test('the rollout\'s events: approvals asked and answered, compaction, quota crossings across batches, turns ending', async (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const parser = new RolloutParser();
  parser.setRolloutPath(file);
  fs.writeFileSync(file, row('session_meta', { id: 'S', timestamp: at(0).toISOString(), cwd: '/r' }, 0)
    + row('event_msg', { type: 'task_started' }, 1)
    + row('event_msg', { type: 'exec_approval_request', call_id: 'c1', command: ['npm', 'test'] }, 2));
  let result = (await parser.parse())!;
  assert.equal(result.pendingApproval?.command, 'npm test', 'the whole command, for its description');
  fs.appendFileSync(file, row('response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' }, 30)
    + row('event_msg', { type: 'context_compacted' }, 40) + quota(79, 50));
  result = (await parser.parse())!;
  assert.deepEqual(result.events.map(e => [e.kind, e.at.getTime(), e.text]), [
    ['approval-requested', at(2).getTime(), 'npm test'], ['approval-answered', at(30).getTime(), 'npm test'], ['compacted', at(40).getTime(), undefined]]);
  fs.appendFileSync(file, quota(81, 60) + quota(96, 70) + row('event_msg', { type: 'task_complete', last_agent_message: 'Done:\n  all  tests pass.' }, 80)
    + row('event_msg', { type: 'turn_aborted' }, 90));
  result = (await parser.parse())!;
  assert.deepEqual(result.events.slice(3).map(e => [e.kind, e.threshold]), [['quota', 80], ['quota', 95], ['turn-finished', undefined], ['turn-interrupted', undefined]],
    'a crossing at the start of a batch is seen from the reading before it');
  assert.equal(result.events[5].text, 'Done: all tests pass.', 'a finished turn keeps its answer, flattened');
  assert.equal(result.events[3].windowMinutes, 300);
  assert.deepEqual(result.quotaSamples.map(s => s.percent), [79, 81, 96]);
  assert.equal(result.quotaSamples[0].resetsAt?.getTime(), Math.floor(now / 1000) * 1000 + 3 * 3600_000);
});

const sample = (minutes: number, percent: number, resetMinutes = 120): QuotaSample =>
  ({ window: 'primary', at: new Date(now + minutes * 60_000), percent, resetsAt: new Date(now + resetMinutes * 60_000), windowMinutes: 300 });

test('a forecast only when the readings span five minutes, use rises, and the line runs out before the reset', () => {
  assert.equal(slope([{ t: 0, p: 1 }, { t: 10, p: 3 }]), 0.2);
  const rising = [sample(0, 50), sample(5, 60), sample(10, 70)];
  const forecast = quotaForecast(rising, now + 10 * 60_000)!;
  assert.equal(forecast.window, 'primary');
  assert.equal(forecast.exhaustAt.getTime(), now + 25 * 60_000, '2 points a minute from 70: 15 minutes more');
  assert.equal(quotaForecast([sample(0, 50), sample(4, 60)], now), null, 'under five minutes of readings');
  assert.ok(FORECAST_MIN_SPAN_MS === 5 * 60_000);
  assert.equal(quotaForecast([sample(0, 60), sample(10, 60)], now), null, 'flat: no forecast');
  assert.equal(quotaForecast([sample(0, 10), sample(10, 11)], now + 600_000), null, 'runs out long after the reset');
  assert.equal(quotaForecast(rising.map(s => ({ ...s, resetsAt: undefined })), now), null, 'no reset known: no claim');
  // A reset in between starts the line over.
  const reset = [sample(0, 90, 5), sample(6, 2), sample(8, 3)];
  assert.equal(quotaForecast(reset, now + 8 * 60_000), null);
  assert.equal(quotaForecast(rising, now + 30 * 60_000), null, 'a projection already past says nothing');
});

const node = (id: string, name: string, status: SubagentTreeNode['status'], extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode =>
  ({ id, name, status, depth: 1, children: [], ...extra });
const tree = (nodes: SubagentTreeNode[], rootId = 'root'): SubagentTree => ({ rootId, nodes, totalCount: nodes.length, updatedAt: new Date(now) });

test('the timeline is the rollout\'s events and the agent log\'s status changes in one list, newest first, kept once', () => {
  const history = new WorkbenchHistory();
  const agents = tree([node('a', 'reader', 'error', { statusAt: at(50) })]);
  const main = { events: [{ kind: 'turn-finished' as const, at: at(60) }, { kind: 'quota' as const, at: at(20), threshold: 80, windowMinutes: 300 }],
    toolActivity: { recentCalls: [{ id: 'x', name: 'exec_command', timestamp: at(30), status: 'error' as const, target: 'npm test' }], totalCalls: 1,
      callsByType: {}, lastUpdateTime: at(30) } } as never;
  const logs = new Map([['a', [{ at: now + 10_000, kind: 'started' as const, text: '' }, { at: now + 50_000, kind: 'failed' as const, text: '' },
    { at: now + 55_000, kind: 'note' as const, text: 'model words' }]]]);
  const events = history.timeline(agents, main, logs);
  assert.deepEqual(events.map(timelineText), ['Turn finished', 'reader failed', 'Tool failed: npm test', 'Quota past 80% (5h)', 'reader started']);
  assert.equal(history.timeline(agents, main, logs).length, 5, 'the same again adds nothing');
  const answered = new WorkbenchHistory().timeline(tree([]), { events: [{ kind: 'turn-finished' as const, at: at(60), text: 'Shipped.' }],
    toolActivity: { recentCalls: [], totalCalls: 0, callsByType: {} } } as never, new Map());
  assert.deepEqual(answered.map(e => [e.subject, e.summary]), [[undefined, 'Shipped.']], 'an answer is the turn\'s summary, not its subject');
  assert.equal(history.timeline(tree([], 'other'), null, new Map()).length, 0, 'another session starts over');
});

test('the Timeline pane opens with 2, lists events with their ages, and is saved like the other panes', () => {
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('2')), [{ type: 'key', key: 'timeline' }]);
  const agents = tree([]);
  const opened = handleMonitorInput(initialMonitorState(), { type: 'key', key: 'timeline' }, { tree: agents }).state;
  assert.equal(opened.modes.timeline, 'open');
  assert.equal(monitorPreferences(opened).timelinePane, 'open');
  assert.equal(monitorModes({ ...defaultSettings(), timelinePane: 'closed' }).timeline, 'closed');
  const timeline = [{ id: '1', at: at(-120), title: '', detail: [], status: 'completed' as const, kind: 'turn-finished' as const },
    { id: '2', at: at(-300), title: '', detail: [], status: 'error' as const, kind: 'agent-failed' as const, subject: 'reader', cause: 'The test fixture is missing' }];
  const frame = renderMonitor({ tree: agents, state: opened, width: 30, height: 24, nowMs: now, timeline });
  const lines = frame.lines.map(stripAnsi);
  assert.ok(lines.some(line => line.includes('≣ Timeline')));
  assert.ok(lines.some(line => /2m ⏎ Turn finished/.test(line)), 'with glyphs on a finished turn is ⏎ and its words');
  assert.ok(lines.some(line => /5m ├─✗ reader/.test(line)), 'with glyphs on an agent\'s failure branches off the main session\'s rail, ✗ and its name');
  assert.ok(lines.some(line => /~ The test fixture/.test(line)), 'a model-written cause is marked');
  assert.ok(frame.lines.every(line => visualLength(line) <= 30));
  const empty = renderMonitor({ tree: agents, state: opened, width: 30, height: 24, nowMs: now }).lines.map(stripAnsi);
  assert.ok(!empty.some(line => line.includes('No events yet')), 'no events, no line saying so');
  assert.ok(empty.some(line => line.includes('Timeline')), 'the pane keeps its title');
  const words = withGlyphs('text', () => renderMonitor({ tree: agents, state: opened, width: 30, height: 24, nowMs: now, timeline }).lines.map(stripAnsi));
  assert.ok(words.some(line => /2m │ Turn finished/.test(line)), 'with glyphs off, the words, on the main session\'s rail');
  assert.ok(words.some(line => /5m ├─ reader failed/.test(line)));
});

test('the timeline says a time once, at the top of a run of events of one age', () => {
  const state = { ...initialMonitorState(), modes: { ...initialMonitorState().modes, timeline: 'open' as const }, focus: 'timeline' as const };
  const timeline = [{ id: '1', at: at(-120), title: '', detail: [], status: 'completed' as const, kind: 'turn-finished' as const },
    { id: '2', at: at(-150), title: '', detail: [], status: 'error' as const, kind: 'tool-failed' as const, subject: 'exec' },
    { id: '3', at: at(-600), title: '', detail: [], status: 'error' as const, kind: 'agent-failed' as const, subject: 'reader' }];
  const lines = renderMonitor({ tree: tree([]), state, width: 40, height: 30, nowMs: now, timeline }).lines.map(stripAnsi)
    .filter(line => /^│ /.test(line) && line.trim() !== '│').map(line => line.slice(2).trimEnd());
  assert.deepEqual(lines, [' 2m ⏎ Turn finished', '    ✗ exec', '10m ├─✗ reader']);
});

const withGlyphs = <T>(glyphs: 'glyph' | 'text' | 'both', run: () => T): T => {
  const previous = displayConfig();
  setDisplayConfig({ glyphs });
  try { return run(); } finally { setDisplayConfig(previous); }
};

test('the timeline folds repeats, makes an agent\'s run one line, leaves guardian reviews out, and colours each direction its own', () => {
  const ev = (id: string, minutes: number, kind: WorkbenchEvent['kind'], extra: Partial<WorkbenchEvent> = {}): WorkbenchEvent =>
    ({ id, at: new Date(now - minutes * 60_000), title: '', detail: [], status: kind === 'agent-failed' || kind === 'tool-failed' ? 'error' : 'completed', kind, ...extra });
  const guard = { ...makeSubagentTree().nodes[0], id: 'g1', name: 'guardian', kind: 'guardian', children: [] };
  const worker = { ...makeSubagentTree().nodes[0], id: 'w1', name: 'bench_corpus', children: [] };
  const lost = { ...makeSubagentTree().nodes[0], id: 'w2', name: 'migrate', children: [] };
  const agents = { rootId: 'root', nodes: [guard, worker, lost], totalCount: 3, updatedAt: new Date(now) };
  const timeline = [
    ev('1', 1, 'turn-finished'), ev('2', 2, 'turn-finished'), ev('3', 3, 'turn-finished'),
    ev('4', 4, 'agent-finished', { agentId: 'g1', subject: 'guardian' }), ev('5', 5, 'agent-started', { agentId: 'g1', subject: 'guardian' }),
    ev('6', 6, 'agent-finished', { agentId: 'w1', subject: 'bench_corpus' }), ev('7', 18, 'agent-started', { agentId: 'w1', subject: 'bench_corpus' }),
    ev('8', 19, 'agent-failed', { agentId: 'w2', subject: 'migrate' }), ev('9', 20, 'tool-failed', { subject: 'exec' }),
    ev('10', 21, 'agent-started', { agentId: 'w2', subject: 'migrate' }),
  ];
  const state = { ...initialMonitorState(), modes: { ...initialMonitorState().modes, timeline: 'open' as const }, focus: 'timeline' as const };
  const draw = () => renderMonitor({ tree: agents, state, width: 40, height: 40, nowMs: now, timeline });
  const frame = draw();
  const lines = frame.lines.map(stripAnsi).filter(line => /^│ +\d/.test(line)).map(line => line.slice(2).trimEnd());
  // A run is one line at its end, how long it took on the right.
  assert.deepEqual(lines, [' 1m ⏎ Turn finished ×3', ' 6m ├─✓ bench_corpus               12m', '19m ├─✗ migrate                     2m', '20m ✗ exec']);
  const dirs = directions(agents);
  assert.notEqual(dirs.paint('w1'), dirs.paint('w2'), 'two directions at work together, two colours');
  assert.ok(frame.lines.some(line => line.includes(theme.bold(dirs.paint('w1')('bench_corpus')))), 'an L1\'s name bold, in its direction\'s colour');
  assert.equal(directions(agents).paint('w1'), dirs.paint('w1'), 'the same colour every time');
  const words = withGlyphs('text', () => draw().lines.map(stripAnsi).filter(line => /^│ +\d/.test(line)).map(line => line.slice(2).trimEnd()));
  assert.deepEqual(words, [' 1m │ Turn finished ×3', ' 6m ├─ bench_corpus finished       12m', '19m ├─ migrate failed               2m', '20m │ Tool failed: exec']);
  // A failed review still shows.
  const failed = renderMonitor({ tree: agents, state, width: 40, height: 40, nowMs: now, timeline: [ev('11', 1, 'agent-failed', { agentId: 'g1', subject: 'guardian' })] });
  assert.ok(failed.lines.map(stripAnsi).some(line => /├─✗ guardian/.test(line)));
  // Half a run: still going, its clock on the right, or its start out of the list.
  const half = (glyphs: 'glyph' | 'text') => withGlyphs(glyphs, () => renderMonitor({ tree: agents, state, width: 40, height: 40, nowMs: now,
    timeline: [ev('12', 1, 'agent-started', { agentId: 'w1', subject: 'bench_corpus' }), ev('13', 2, 'agent-finished', { agentId: 'w2', subject: 'migrate' })] }))
    .lines.map(stripAnsi).filter(line => /^│ +\d/.test(line)).map(line => line.slice(2).trimEnd());
  assert.deepEqual(half('glyph'), [' 1m ├─▸ bench_corpus                 ◷', ' 2m ├─✓ migrate']);
  assert.deepEqual(half('text'), [' 1m ├─ bench_corpus started          ◷', ' 2m ├─ migrate finished']);
});

test('a pending approval says how long it has waited, in the bar\'s widest form, the panel card and the snapshot', () => {
  assert.equal(waitedText(new Date(now - 45_000), now), '45s');
  assert.equal(waitedText(new Date(now - 125_000), now), '2m');
  assert.equal(waitedText(new Date(now - 65 * 60_000), now), '1h05m');
  assert.equal(waitedText(new Date(now - 72 * 3600_000), now), '3d');
  const nowMs = FIXED_NOW.getTime();
  const data = makeHudData({ pendingApproval: { kind: 'exec', callId: 'c', since: new Date(nowMs - 125_000), summary: 'npm test' } });
  assert.equal(collectAttention(data, nowMs)[0].since?.getTime(), nowMs - 125_000);
  const attention = buildBarModules(data, { nowMs }).find(module => module.id === 'attention')!;
  assert.match(stripAnsi(attention.variants.full!), /approval needed 2m/);
  assert.doesNotMatch(stripAnsi(attention.variants.short!), /2m/, 'narrower forms keep the phrase alone');
  assert.match(stripAnsi(statusCard(data, nowMs)!.alerts.join('\n')), /approval needed 2m/);
  assert.equal(buildSnapshot(data, { width: 0, segments: [] }, nowMs).approvalSince, new Date(nowMs - 125_000).toISOString());
  assert.equal(buildSnapshot(makeHudData({ pendingApproval: undefined }), { width: 0, segments: [] }, nowMs).approvalSince, undefined);
});

test('a quota forecast shows on the bar\'s widest quota form and the card, marked as an estimate, and in the snapshot', () => {
  const nowMs = FIXED_NOW.getTime();
  const plain = makeHudData();
  const projected = makeHudData({ quotaForecast: { window: 'primary', exhaustAt: new Date(nowMs + 40 * 60_000), percent: 70, windowMinutes: 300 } });
  const module = (data: typeof plain) => buildBarModules(data, { nowMs }).find(m => m.id === 'quota')!;
  assert.match(stripAnsi(module(projected).variants.full!), /out in ~40m/);
  assert.equal(module(projected).variants.short, module(plain).variants.short, 'narrower forms unchanged');
  assert.doesNotMatch(stripAnsi(module(plain).variants.full!), /out in/);
  assert.match(stripAnsi(statusCard(projected, nowMs)!.forecast), /out ~40m/);
  assert.deepEqual(buildSnapshot(projected, { width: 0, segments: [] }, nowMs).quotaForecast,
    { window: 'primary', exhaustAt: new Date(nowMs + 40 * 60_000).toISOString(), percent: 70, windowMinutes: 300 });
  assert.equal(buildSnapshot(plain, { width: 0, segments: [] }, nowMs).quotaForecast, undefined);
});

test('notifications follow the settings unless an environment variable was set', () => {
  assert.equal(resolveNotifierOptions({}, {}).enabled, false, 'off by default');
  assert.equal(resolveNotifierOptions({}, { notify: true }).enabled, true);
  assert.equal(resolveNotifierOptions({ CODEX_HUD_NOTIFY: '0' }, { notify: true }).enabled, false, 'an explicit variable wins');
  assert.equal(resolveNotifierOptions({ CODEX_HUD_NOTIFY: '1' }, { notify: false }).enabled, true);
  assert.equal(resolveNotifierOptions({ CODEX_HUD_NOTIFY: '' }, { notify: true }).enabled, true, 'an empty variable is unset');
  assert.equal(resolveNotifierOptions({}, { notify: true }).desktop, false, 'desktop is a second opt-in');
  assert.equal(resolveNotifierOptions({}, { notifyDesktop: true }).desktop, true);
  assert.equal(resolveNotifierOptions({ CODEX_HUD_NOTIFY_DESKTOP: 'false' }, { notifyDesktop: true }).desktop, false);
});

test('the key help lists every key, the new ones included, in both languages', async () => {
  const { setLanguage } = await import('../../src/render/i18n.js');
  const state = { ...initialMonitorState(), help: true };
  const lines = () => renderMonitor({ tree: tree([]), state, width: 70, height: 80, nowMs: now }).lines.map(stripAnsi).join('\n');
  const en = lines();
  // A shortcut is its key in the key column, then what it does.
  const shortcut = (text: string, key: string, does: string) => new RegExp(`^${key.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} +${does.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`, 'm').test(text);
  for (const [key, does] of [['1–4', 'open / close a pane'], ['b', 'pause / resume brief'], ['r', 'status card: min / status'], ['f', 'filter'], ['h l', 'fold / unfold agent'],
    ['g G', 'first / last'], ['Ctrl+]', 'Ctrl+] itself, to Codex']]) assert.ok(shortcut(en, key, does), `${key} ${does}`);
  for (const key of ['2 Timeline', "Click the card's band: its level", 'Click a log line: select agent', '~ = written by a model',
    'Keys typed in the panel go to Codex', 'Shortcuts: Ctrl+], then a key', '⚙ settings ? help']) assert.ok(en.includes(key), key);
  // The prefix the settings chose is the one the help names.
  const other = renderMonitor({ tree: tree([]), state, width: 70, height: 80, nowMs: now, prefix: 'Ctrl+\\' }).lines.map(stripAnsi).join('\n');
  assert.ok(other.includes('Shortcuts: Ctrl+\\, then a key') && shortcut(other, 'Ctrl+\\', 'Ctrl+\\ itself, to Codex') && !other.includes('Ctrl+]'), other);
  assert.ok(!en.includes('min / status / full'), 'compact has two levels');
  assert.ok(!/copy|fold \/ unfold recap/.test(en), 'no recap copy, no recap fold');
  const richHelp = renderMonitor({ tree: tree([]), state: { ...state, style: 'rich' }, width: 70, height: 80, nowMs: now }).lines.map(stripAnsi).join('\n');
  assert.ok(shortcut(richHelp, 'r', 'status card: min / status / full') && shortcut(richHelp, 'e / Space', 'open / close card') && richHelp.includes('Wheel over the card: its brief'));
  const previous = setLanguage('zh');
  try {
    const zh = lines();
    assert.ok(shortcut(zh, '1–4', '打开 / 关闭面板') && shortcut(zh, 'r', '状态卡：一行 / 状态'), zh);
    for (const key of ['2 时间线', '点击状态卡色带：切换显示层级', '点击日志行', '由模型撰写', '筛选',
      '快捷键：先按 Ctrl+]，再按一键', '在侧栏里打字，按键都交给 Codex']) assert.ok(zh.includes(key), key);
    assert.ok(!zh.includes('复制'));
  } finally { setLanguage(previous); }
});
