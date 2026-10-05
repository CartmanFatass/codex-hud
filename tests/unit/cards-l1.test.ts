import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMonitorState, renderMonitor, handleMonitorInput, monitorSettings, type MonitorState } from '../../src/render/monitor.js';
import { directions, roleSet } from '../../src/render/directions.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi, visualLength, theme, colors } from '../../src/render/colors.js';
import { defaultSettings } from '../../src/settings.js';
import { SETTING_ROWS } from '../../src/render/settings-page.js';
import type { AgentLogEntry } from '../../src/collectors/agent-log.js';
import type { AgentStage, SubagentStatus, SubagentTree, SubagentTreeNode } from '../../src/types.js';

const NOW = Date.parse('2026-10-05T10:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);
const node = (id: string, name: string, status: SubagentStatus, extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode =>
  ({ id, name, status, depth: 1, children: [], startedAt: ago(60), ...extra });
const kid = (id: string, name: string, role: string | undefined, status: SubagentStatus, end?: number, extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode =>
  node(id, name, status, { depth: 2, ...(role ? { role } : {}), startedAt: ago(50), ...(end !== undefined ? { statusAt: ago(end) } : {}), ...extra });
const stage = (start: number, end: number | undefined, status: AgentStage['status'], extra: Partial<AgentStage> = {}): AgentStage =>
  ({ startedAt: ago(start), ...(end !== undefined ? { endedAt: ago(end) } : {}), status, ...extra });

/** A lead at work with a helper, its subtasks in team roles; a writer finished long ago. */
function session(): SubagentTree {
  const lead = node('lead', 'parser_lead', 'running', { agentPath: '/root/parser_lead', turnStartedAt: ago(12), peers: { '/root/critic': 2 },
    stages: [stage(12, undefined, 'running', { intent: 'I will wire the streaming API through the new recovery path.' })],
    action: { name: 'exec', text: 'npm run\nbench', at: ago(1) },
    children: [
      kid('i1', 'impl_a', 'team-implementer', 'completed', 40), kid('i2', 'impl_b', 'team-implementer', 'running', undefined, { turnStartedAt: ago(3) }),
      kid('r1', 'review_a', 'team-reviewer', 'completed', 30, { stages: [stage(35, 30, 'done', { result: 'Two nits; ship it.' })] }),
      kid('s1', 'scout_a', 'team-scout', 'error', 20), kid('g1', 'general_a', 'default', 'completed', 25), kid('n1', 'plain_a', undefined, 'completed', 24),
    ] });
  const critic = node('critic', 'critic', 'running', { agentPath: '/root/critic', peers: { '/root/parser_lead': 2 }, turnStartedAt: ago(2) });
  const writer = node('writer', 'docs_writer', 'completed', { startedAt: ago(400), statusAt: ago(300) });
  return { rootId: 'root', nodes: [lead, critic, writer], totalCount: 9, updatedAt: new Date(NOW) };
}
const rich = (extra: Partial<MonitorState> = {}): MonitorState =>
  ({ ...initialMonitorState(), style: 'rich', ...extra, tree: { ...initialMonitorState().tree, showAll: true, ...extra.tree } });
const draw = (state = rich(), width = 44, tree = session(), agentLog?: Map<string, AgentLogEntry[]>) =>
  renderMonitor({ tree, state, width, height: 60, nowMs: NOW, agentLog });
const plain = (lines: string[]) => lines.map(line => stripAnsi(line).trimEnd());
/** A card's lines, its top rule to its bottom one. */
const card = (lines: string[], name: string) => {
  const top = lines.findIndex(line => /^[┌╭›] /.test(line) && line.includes(` ${name} `));
  const end = lines.findIndex((line, i) => i > top && /^[└╰]/.test(line));
  return lines.slice(top, end + 1);
};

test('only the L1 agents have cards; the summary counts them, at work while a subtask is, and their subtasks as one figure', () => {
  const lines = plain(draw().lines);
  // The title gives up its name before the counts' words.
  const summary = (lines: string[]) => lines.find(line => /^ ▦ (Agents )? \S/.test(line))!;
  assert.match(summary(lines), /▸2 run .*· 6 subtasks, 1 failed$/, 'the subtasks as one figure, with their failures');
  for (const name of ['impl_a', 'impl_b', 'general_a', 'plain_a']) assert.ok(!lines.some(line => line.includes(name)), name);
  assert.ok(lines.some(line => /^ ✓ docs_writer +5h$/.test(line)), 'an old finished L1 is one line');
  // A finished lead with a subtask still at work keeps its card, and counts as at work.
  const tree = session();
  tree.nodes[0] = { ...tree.nodes[0], status: 'completed', statusAt: ago(30), stages: [], action: undefined };
  const kept = plain(draw(rich(), 44, tree).lines);
  assert.ok(kept.some(line => /^[┌›] ✓ parser_lead/.test(line)), kept.join('\n'));
  assert.match(summary(kept), /▸2 run/);
});

test('a card: its name in its direction\'s colour, what it set out to do, whom it works with, what it is doing, the subtasks that matter, the rest by role', () => {
  const tree = session();
  const frame = draw(rich(), 44, tree);
  const lines = plain(frame.lines);
  const lead = card(lines, 'parser_lead');
  assert.deepEqual(lead.slice(1, -1), [
    '│ I will wire the streaming API through the…',
    '│ ⇄ critic',
    '│ ▸ npm run bench',
    '│ ! scout_a                              20m',
    '│ 2 general · 2 implementer · 1 reviewer +1',
  ], lead.join('\n'));
  const paint = directions(tree).paint('lead');
  assert.ok(frame.lines.some(line => line.includes(theme.bold(paint(colors.underline('parser_lead'))))), 'bold, in its direction\'s colour, underlined to click');
  assert.ok(frame.lines.some(line => line.includes(theme.info('2'))), 'a role with an agent running: its count in the running colour');
  // The helper's card names the lead it works for, in the lead's colour.
  const critic = card(lines, 'critic');
  assert.equal(critic[1], '│ → parser_lead');
  assert.ok(frame.lines.some(line => line.includes(paint('parser_lead')) && stripAnsi(line).includes('→')));
  // Wider, every role fits; the shared "team-" is left out, Codex's default and a missing role are "general".
  const wide = card(plain(draw(rich(), 60, tree).lines), 'parser_lead');
  assert.equal(wide.at(-2), '│ 2 general · 2 implementer · 1 reviewer · 1 scout', 'the most first, a tie by name');
});

test('the subtasks that matter: failed, a named role (or its end), or flagged; three closed, all opened; a click selects one', () => {
  const tree = session();
  const named = rich({ importantRoles: roleSet('reviewer') });
  const lines = plain(draw(named, 52, tree).lines);
  const lead = card(lines, 'parser_lead');
  assert.ok(lead.includes('│ ✓ review_a Two nits; ship it.                  30m'), lead.join('\n'));
  // Flag four more: three show closed, a fourth is counted; opened, all.
  const log = new Map<string, AgentLogEntry[]>(['i1', 'i2', 'g1', 'n1'].map(id => [id, [{ at: NOW - 60_000, kind: 'note', text: 'look', attention: true }]]));
  const closed = card(plain(draw(named, 52, tree, log).lines), 'parser_lead');
  const kids = (lines: string[]) => lines.filter(line => /^│ [!✓▸] (impl|review|scout|general|plain)_/.test(line)).length;
  assert.equal(kids(closed), 3, closed.join('\n'));
  assert.ok(closed.includes('│ +3 more'));
  assert.match(closed[closed.findIndex(line => line.includes('+3 more')) - 3], /! scout_a/, 'failures first');
  const opened = card(plain(draw(rich({ ...named, cards: new Set(['lead']) }), 52, tree, log).lines), 'parser_lead');
  assert.equal(kids(opened), 6, opened.join('\n'));
  // A click on a subtask's line selects it, for the Inspector; the line marks it.
  const frame = draw(named, 52, tree);
  const y = frame.lines.findIndex(line => stripAnsi(line).includes('scout_a'));
  const picked = handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: 4, y }, { tree, frame, nowMs: NOW }).state;
  assert.equal(picked.tree.selectedId, 's1');
  assert.ok(plain(draw(picked, 52, tree).lines).some(line => line.startsWith('│ ›! scout_a')));
});

test('the role counts can be left out, and the corners can be round', () => {
  const lines = plain(draw(rich({ roleCounts: false, cardCorners: 'round', tree: { ...initialMonitorState().tree, selectedId: 'writer' } })).lines);
  const lead = card(lines, 'parser_lead');
  assert.match(lead[0], /^╭ ▸ parser_lead/);
  assert.match(lead.at(-1)!, /^╰ ◷12m00s/);
  assert.ok(!lead.some(line => /implementer/.test(line)));
  const settings = monitorSettings({ ...defaultSettings(), cardCorners: 'round', cardRoleCounts: false });
  assert.deepEqual([settings.cardCorners, settings.roleCounts], ['round', false]);
  assert.deepEqual([defaultSettings().cardCorners, defaultSettings().cardRoleCounts], ['square', true]);
  assert.deepEqual(SETTING_ROWS.filter(row => row.key === 'cardCorners' || row.key === 'cardRoleCounts').map(row => [row.group, row.values]),
    [['Agents', [true, false]], ['Agents', ['square', 'round']]]);
});

test('j and k step from card to card, never onto a subtask; from one selected on its lead\'s card, up is the lead, and e opens the lead\'s card', () => {
  const tree = session();
  // Running first, the newest turn first: the critic, the lead, then the writer.
  const frame = draw(rich({ tree: { ...initialMonitorState().tree, selectedId: 'critic' } }), 44, tree);
  let state = frame.state;
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) { state = handleMonitorInput(state, { type: 'key', key: 'down' }, { tree, frame, nowMs: NOW }).state; seen.push(state.tree.selectedId!); }
  assert.deepEqual(seen, ['lead', 'writer', 'writer']);
  const inside = { ...frame.state, tree: { ...frame.state.tree, selectedId: 's1' } };
  assert.equal(handleMonitorInput(inside, { type: 'key', key: 'up' }, { tree, frame, nowMs: NOW }).state.tree.selectedId, 'lead');
  assert.equal(handleMonitorInput(inside, { type: 'key', key: 'down' }, { tree, frame, nowMs: NOW }).state.tree.selectedId, 'writer');
  assert.deepEqual([...handleMonitorInput(inside, { type: 'key', key: 'expand' }, { tree, frame, nowMs: NOW }).state.cards ?? []], ['lead']);
  // The help names no folding in the cards: there is nothing under a card to fold.
  const help = plain(draw(rich({ help: true }), 70).lines).join('\n');
  assert.ok(!help.includes('fold / unfold agent'));
  assert.ok(plain(draw({ ...initialMonitorState(), help: true }, 70).lines).join('\n').includes('fold / unfold agent'), 'the compact tree still folds');
});

test('a card counts as every view does: its subtasks at any depth, and its reviews apart, on its ◈, red when one failed', () => {
  const review = (id: string, status: SubagentStatus) =>
    node(id, 'guardian', status, { depth: 2, kind: 'guardian', startedAt: ago(320), statusAt: ago(310) });
  // The writer, long finished: a subtask whose own subtask failed, and a review that failed.
  const tree = session();
  tree.nodes[2] = { ...tree.nodes[2], children: [
    kid('w1', 'w1', 'team-implementer', 'completed', 310, { children: [node('w1x', 'w1_probe', 'error', { depth: 3, startedAt: ago(315), statusAt: ago(312) })] }),
    review('wg', 'error'),
  ] };
  const lines = draw(rich(), 44, tree).lines;
  const row = lines.find(line => stripAnsi(line).includes('docs_writer'))!;
  assert.match(stripAnsi(row).trimEnd(), /^ ✓ docs_writer +◈1 ✓1 ✗1 +5h$/, 'the failed review is its ◈, not one of the ✗; the probe two levels down is');
  assert.ok(row.includes(theme.error('◈1')), 'the ◈ in red: a review failed');
  assert.match(plain(lines).find(line => /^ ▦ /.test(line))!, /· 8 subtasks, 2 failed$/, 'as the title counts them');
  // A lead at work names a failure two levels down on its card, and a review under a subtask that failed.
  const deep = session();
  const [lead] = deep.nodes;
  deep.nodes[0] = { ...lead, children: [...lead.children.slice(0, 2), kid('i3', 'impl_c', 'team-implementer', 'completed', 10, { children: [
    node('i3x', 'deep_probe', 'error', { depth: 3, startedAt: ago(9), statusAt: ago(8) }),
    { ...review('i3g', 'error'), depth: 3 },
  ] })] };
  const drawn = card(plain(draw(rich(), 44, deep).lines), 'parser_lead');
  assert.match(drawn[0], / ◈1( |$)/, drawn.join('\n'));
  assert.ok(drawn.some(line => line.includes('deep_probe')), drawn.join('\n'));
  assert.ok(drawn.some(line => /! guardian/.test(line)), drawn.join('\n'));
});

test('a finished L1\'s row counts its subtasks by state, and cards keep to the width in both languages', () => {
  const tree = session();
  tree.nodes[2] = { ...tree.nodes[2], children: [kid('w1', 'w1', 'team-implementer', 'completed', 310), kid('w2', 'w2', 'team-scout', 'error', 305)] };
  const lines = plain(draw(rich(), 44, tree).lines);
  assert.match(lines.find(line => line.includes('docs_writer'))!, /^ ✓ docs_writer +✓1 ✗1 +5h$/);
  for (const language of ['en', 'zh'] as const) {
    const previous = setLanguage(language);
    try {
      for (const width of [24, 28, 32, 40, 48, 56]) for (const open of [false, true]) {
        const frame = draw(rich({ cards: new Set(open ? ['lead', 'critic', 'writer'] : []), importantRoles: roleSet('reviewer') }), width, tree);
        for (const line of frame.lines) assert.ok(visualLength(line) <= width, `${language} ${width}: ${stripAnsi(line)}`);
        for (const c of frame.controls) assert.ok(c.x >= 0 && c.x + c.width <= width, `${language} ${width}: control ${c.kind}`);
      }
    } finally { setLanguage(previous); }
  }
});
