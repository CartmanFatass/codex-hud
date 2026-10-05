import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCounts } from '../../src/collectors/subagent-tree.js';
import { collectAttention } from '../../src/render/attention.js';
import { statusCard } from '../../src/render/status-block.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { buildSnapshot } from '../../src/snapshot.js';
import { Notifier, type NotifyEvent } from '../../src/notify.js';
import { initialMonitorState, renderMonitor } from '../../src/render/monitor.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi, theme } from '../../src/render/colors.js';
import { makeHudData, node, treeOf, FIXED_NOW } from '../fixtures/hud-data.js';
import type { SubagentStatus, SubagentTreeNode } from '../../src/types.js';

const NOW = FIXED_NOW.getTime();
const quiet = { toolActivity: undefined, rateLimits: undefined, contextUsage: undefined, pendingApproval: undefined };
const review = (id: string, status: SubagentStatus, depth = 1): SubagentTreeNode => ({ ...node(id, 'guardian', status, { depth }), kind: 'guardian' });

/**
 * One of each failure: an agent the main session started, a subtask under a
 * running agent, a guardian review; and a finished agent whose subtask is
 * still at work.
 */
function session(lead: SubagentStatus = 'running', impl: SubagentStatus = 'running') {
  return treeOf([
    node('a1', 'parser_lead', lead, { children: [
      node('a1s1', 'impl_a', 'completed', { depth: 2 }),
      node('a1s2', 'scout_a', 'error', { depth: 2 }),
      review('a1g1', 'completed', 2),
    ] }),
    node('a2', 'bench_lead', 'error'),
    node('a3', 'docs_lead', 'completed', { children: [
      node('a3s1', 'impl_b', impl, { depth: 2, children: [node('a3s1x', 'helper', 'completed', { depth: 3 })] }),
    ] }),
    review('g1', 'error'),
    review('g2', 'running'),
  ]);
}

test('one count for every view: the agents the main session started, their subtasks at any depth, the reviews wherever they sit', () => {
  assert.deepEqual(agentCounts(session().nodes), {
    agents: { total: 3, active: 2, completed: 0, failed: 1, unknown: 0 },
    subtasks: { total: 4, active: 1, completed: 2, failed: 1, unknown: 0 },
    reviews: { total: 3, active: 1, completed: 1, failed: 1, unknown: 0 },
  });
});

test('the title row, the status card, the bar, notifications and the snapshot say the same of one session', () => {
  const data = makeHudData({ ...quiet, subagentTree: session() });

  // The alerts: each failure under its own name.
  const failures = collectAttention(data, NOW).filter((item) => item.kind.endsWith('-error'));
  assert.deepEqual(failures.map((item) => [item.kind, item.label, item.detail]), [
    ['agent-error', '1 agent failed', 'bench_lead'],
    ['subtask-error', '1 subtask failed', 'scout_a'],
    ['review-error', '1 review failed', 'guardian'],
  ]);
  // Said as one phrase, on the card and the bar alike.
  assert.equal(stripAnsi(statusCard(data, NOW)!.alerts[0]), '! 1 agent · 1 subtask · 1 review failed');

  // The panel's title row, the same in both layouts.
  const title = (style: 'rich' | 'compact') => {
    const state = { ...initialMonitorState(), style, tree: { ...initialMonitorState().tree, showAll: true } };
    const frame = renderMonitor({ tree: session(), state, width: 80, height: 40, nowMs: NOW });
    return frame.lines[frame.panes[0].y];
  };
  for (const style of ['rich', 'compact'] as const) {
    assert.equal(stripAnsi(title(style)).trimEnd(), ' ▦ Agents  !1 failed  ▸2 run  ◈3 reviews  · 4 subtasks, 1 failed', style);
    assert.ok(title(style).includes(theme.error('◈3')), `${style}: a failed review paints the chip`);
  }

  // The bar's Agents field counts the agents; the rest is in its alert.
  const bar = buildBarModules(data, { nowMs: NOW, barWidth: 10 });
  assert.equal(stripAnsi(bar.find((module) => module.id === 'agents')!.variants.full!), 'Agents 2 run · 1 fail');
  const alert = bar.find((module) => module.id === 'attention')!.variants;
  assert.deepEqual([alert.full, alert.short, alert.min].map((text) => stripAnsi(text!)), ['! 1 agent · 1 subtask · 1 review failed', '! 1 agent · 1 subtask · 1 review failed', '!']);
  // An approval and the failures: two phrases, the approval first with its wait.
  const asking = makeHudData({ ...quiet, subagentTree: session(), pendingApproval: { kind: 'exec', since: new Date(NOW - 90_000) } as never });
  const both = buildBarModules(asking, { nowMs: NOW, barWidth: 10 }).find((module) => module.id === 'attention')!.variants;
  assert.deepEqual([both.full, both.short, both.min].map((text) => stripAnsi(text!)), ['! approval needed 1m · 1 agent · 1 subtask · 1 review failed', '! approval needed', '!2']);
  assert.equal(stripAnsi(statusCard(asking, NOW)!.alerts[0]), '! approval needed 1m · 1 agent · 1 subtask · 1 review failed');

  // The snapshot gives the three counts and says what each thread is.
  const snapshot = buildSnapshot(data, { width: 120, segments: [] }, NOW);
  assert.deepEqual({ ...snapshot.agents, nodes: undefined }, {
    active: 2, completed: 0, failed: 1, unknown: 0,
    subtasks: { active: 1, completed: 2, failed: 1, unknown: 0 },
    reviews: { active: 1, completed: 1, failed: 1, unknown: 0 },
    nodes: undefined,
  });
  assert.deepEqual(snapshot.agents.nodes.map((entry) => `${entry.name}:${entry.kind}`), [
    'parser_lead:agent', 'impl_a:subtask', 'scout_a:subtask', 'guardian:review', 'bench_lead:agent',
    'docs_lead:agent', 'impl_b:subtask', 'helper:subtask', 'guardian:review', 'guardian:review',
  ]);

  // Notifications: the agents finishing, and the failures as one alert.
  const sent: NotifyEvent[] = [];
  const notifier = new Notifier({ enabled: true, cooldownMs: 60_000, deliver: (event) => sent.push(event) });
  notifier.update(data, NOW);
  notifier.update(makeHudData({ ...quiet, subagentTree: session('completed', 'completed') }), NOW + 1000);
  assert.deepEqual(sent.map((event) => event.message), ['1 agent failed, 1 subtask failed, 1 review failed', '2 agents finished, 1 failed']);
});

test('short of room, the title row gives up where its rows are before the subtasks, and the subtasks before the agents', () => {
  const many = treeOf(Array.from({ length: 12 }, (_, i) => node(`a${i}`, `lead_${i}`, i === 0 ? 'error' : 'running', { children: [
    node(`a${i}s`, `impl_${i}`, i === 1 ? 'error' : 'completed', { depth: 2 }),
  ] })));
  for (const style of ['rich', 'compact'] as const) {
    const title = (width: number) => {
      const frame = renderMonitor({ tree: many, state: { ...initialMonitorState(), style }, width, height: 24, nowMs: NOW });
      return stripAnsi(frame.lines[frame.panes[0].y]).trimEnd();
    };
    assert.match(title(56), /^ ▦ Agents {2}!1 ▸11 {2}· 12 subtasks, 1 failed +1–22\/\d+$/, style);
    assert.equal(title(40), ' ▦  !1 ▸11  · 12 subtasks, 1 failed', style);
    assert.match(title(32), /^ ▦ Agents {2}!1 ▸11 +1–22\/\d+$/, style);
  }
});

test('the alerts and the title row in Chinese', () => {
  setLanguage('zh');
  try {
    const data = makeHudData({ ...quiet, subagentTree: session() });
    assert.equal(stripAnsi(statusCard(data, NOW)!.alerts[0]), '! 1 个 agent · 1 个子任务 · 1 个评审 失败');
    const two = makeHudData({ ...quiet, subagentTree: treeOf([node('a', 'a', 'error'), node('b', 'b', 'error')]) });
    assert.equal(stripAnsi(statusCard(two, NOW)!.alerts[0]), '! 2 个 agent 失败');
    const state = { ...initialMonitorState(), style: 'rich' as const, tree: { ...initialMonitorState().tree, showAll: true } };
    const frame = renderMonitor({ tree: session(), state, width: 80, height: 40, nowMs: NOW });
    assert.match(stripAnsi(frame.lines[frame.panes[0].y]), /!1 失败 {2}▸2 运行 {2}◈3 评审 {2}· 4 子任务，1 失败/);
  } finally {
    setLanguage('en');
  }
});
