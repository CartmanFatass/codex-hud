import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialMonitorState,
  renderMonitor,
  handleMonitorInput,
  monitorSettings,
  type MonitorState,
} from '../../src/render/monitor.js';
import { roleSet } from '../../src/render/directions.js';
import { setLanguage } from '../../src/render/i18n.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { stripAnsi, visualLength, theme } from '../../src/render/colors.js';
import { cardSummaryTargets, cardSentence, agentCard } from '../../src/render/cards.js';
import { defaultCardVisibility } from '../../src/card-visibility.js';
import { defaultSettings } from '../../src/settings.js';
import { SETTING_ROWS } from '../../src/render/settings-page.js';
import { nativeWorker, projectWorkCard } from '../../src/collectors/work-card.js';
import { renderWorkCard } from '../../src/render/work-card.js';
import type { AgentLogEntry } from '../../src/collectors/agent-log.js';
import type { AgentStage, SubagentStatus, SubagentTree, SubagentTreeNode } from '../../src/types.js';

const NOW = Date.parse('2026-10-05T10:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);
const node = (
  id: string,
  name: string,
  status: SubagentStatus,
  extra: Partial<SubagentTreeNode> = {}
): SubagentTreeNode => ({ id, name, status, depth: 1, children: [], startedAt: ago(60), ...extra });
const kid = (
  id: string,
  name: string,
  role: string | undefined,
  status: SubagentStatus,
  end?: number,
  extra: Partial<SubagentTreeNode> = {}
): SubagentTreeNode =>
  node(id, name, status, {
    depth: 2,
    ...(role ? { role } : {}),
    startedAt: ago(50),
    ...(end !== undefined ? { statusAt: ago(end) } : {}),
    ...extra,
  });
const stage = (
  start: number,
  end: number | undefined,
  status: AgentStage['status'],
  extra: Partial<AgentStage> = {}
): AgentStage => ({ startedAt: ago(start), ...(end !== undefined ? { endedAt: ago(end) } : {}), status, ...extra });

/** A lead at work with a helper, its subtasks in team roles; a writer finished long ago. */
function session(): SubagentTree {
  const lead = node('lead', 'parser_lead', 'running', {
    agentPath: '/root/parser_lead',
    turnStartedAt: ago(12),
    peers: { '/root/critic': 2 },
    stages: [
      stage(12, undefined, 'running', { intent: 'I will wire the streaming API through the new recovery path.' }),
    ],
    action: { name: 'exec', text: 'npm run\nbench', at: ago(1) },
    children: [
      kid('i1', 'impl_a', 'team-implementer', 'completed', 40),
      kid('i2', 'impl_b', 'team-implementer', 'running', undefined, { turnStartedAt: ago(3) }),
      kid('r1', 'review_a', 'team-reviewer', 'completed', 30, {
        stages: [stage(35, 30, 'done', { result: 'Two nits; ship it.' })],
      }),
      kid('s1', 'scout_a', 'team-scout', 'error', 20),
      kid('g1', 'general_a', 'default', 'completed', 25),
      kid('n1', 'plain_a', undefined, 'completed', 24),
    ],
  });
  const critic = node('critic', 'critic', 'running', {
    agentPath: '/root/critic',
    peers: { '/root/parser_lead': 2 },
    turnStartedAt: ago(2),
  });
  const writer = node('writer', 'docs_writer', 'completed', { startedAt: ago(400), statusAt: ago(300) });
  return { rootId: 'root', nodes: [lead, critic, writer], totalCount: 9, updatedAt: new Date(NOW) };
}
const rich = (extra: Partial<MonitorState> = {}): MonitorState => ({
  ...initialMonitorState(),
  style: 'rich',
  ...extra,
  tree: { ...initialMonitorState().tree, showAll: true, ...extra.tree },
});
const draw = (state = rich(), width = 44, tree = session(), agentLog?: Map<string, AgentLogEntry[]>) =>
  renderMonitor({ tree, state, width, height: 60, nowMs: NOW, agentLog });
const plain = (lines: string[]) => lines.map((line) => stripAnsi(line).trimEnd());
const summary = (lines: string[]) => lines.find((line) => /^ ▦ /.test(line)) ?? '';
/** A card's lines, its top rule to its bottom one. */
const card = (lines: string[], name: string) => {
  const top = lines.findIndex((line) => /^[┌╭›] /.test(line) && line.includes(` ${name} `));
  const end = lines.findIndex((line, i) => i > top && !/^[│└╰]/.test(line));
  return top < 0 ? [] : lines.slice(top, end < 0 ? undefined : end);
};

test('only the L1 agents have cards; the summary counts them, at work while a subtask is, and their subtasks as one figure', () => {
  // §15 2026-11-09: descendants fold into owners, but existing aggregate counts remain.
  const lines = plain(draw().lines);
  assert.match(summary(lines), /▸2 run .*· 6 subtasks, 1 failed$/, 'the subtasks as one figure, with their failures');
  for (const name of ['impl_a', 'impl_b', 'scout_a', 'general_a', 'plain_a'])
    assert.ok(!lines.some((line) => line.includes(name)), name);
  assert.equal(card(lines, 'parser_lead').length, 2); // stalled reason, not a child list
  assert.match(card(lines, 'docs_writer')[0], /to accept/);
  const tree = session();
  tree.nodes[0] = { ...tree.nodes[0], status: 'completed', statusAt: ago(30), stages: [], action: undefined };
  const kept = plain(draw(rich(), 44, tree).lines);
  assert.match(card(kept, 'parser_lead')[0], /to accept/);
  assert.match(summary(kept), /▸2 run/);
});

test("a card: its name in its direction's colour, whom it works with, what it is doing, the subtasks that matter, the rest by role; not its own words cut to a line", () => {
  const tree = session();
  tree.nodes[0].role = 'imp';
  const previous = setDisplayConfig({ theme: 'titanium' });
  try {
    const frame = draw(rich(), 56, tree),
      lead = card(plain(frame.lines), 'parser_lead');
    assert.match(lead[0], /imp parser_lead/);
    assert.ok(frame.lines.some((line) => line.includes(theme.board.roleInk.imp('imp'))));
    assert.ok(lead.length <= 3);
    assert.ok(!/critic|npm run|impl_b|scout_a|implementer|⇄|→/.test(lead.join('\n')));
    assert.ok(!lead.some((line) => line.includes('wire the streaming')));
    assert.match(card(plain(frame.lines), 'critic')[0], /agent critic/);
  } finally {
    setDisplayConfig(previous);
  }
});

test('the subtasks that matter: failed, a named role (or its end), or flagged; three closed, all opened; a click selects one', () => {
  const tree = session();
  const state = rich({ importantRoles: roleSet('reviewer') });
  const log = new Map<string, AgentLogEntry[]>([['s1', [{ at: NOW, kind: 'cause', text: 'Helper failure prose' }]]]);
  const frame = draw(state, 52, tree, log),
    lines = plain(frame.lines);
  const lead = card(lines, 'parser_lead');
  assert.ok(lead.length <= 3);
  assert.ok(!/impl_|review_a|scout_a|Helper failure prose/.test(lead.join('\n')));
  assert.ok(!frame.controls.some((c) => c.kind === 'log' && c.item === 's1'));
  const name = frame.controls.find((c) => c.kind === 'switch' && c.item === 'lead')!;
  assert.ok(name);
  const picked = handleMonitorInput(
    frame.state,
    { type: 'mouse', button: 'left', x: name.x - 1, y: name.y },
    { tree, frame, nowMs: NOW }
  );
  assert.equal(picked.state.tree.selectedId, 'lead');
  assert.equal(picked.action, undefined);
  assert.equal(picked.state.modes.details, 'closed');
});

test("a subtask's digest or cause wraps under its name, whole; with too little room beside the name it starts on the next line", () => {
  const cause = 'The harness timed out on the large corpus after the cache warmed up';
  const owner = node('lead', 'lead', 'error', { lastEventAt: ago(0) });
  for (const width of [32, 44, 56]) {
    const projected = projectWorkCard(nativeWorker(owner), NOW);
    const compact = renderWorkCard(projected, rich(), width, cardSentence(cause));
    assert.ok(compact.length <= 3);
    const lines = renderWorkCard(projected, rich(), width, cardSentence(cause), true, false, cause);
    const full = lines
      .slice(compact.length)
      .map((line) => stripAnsi(line).slice(2).trim())
      .join(' ');
    assert.ok(full.includes(cause), full);
    assert.ok(lines.every((line) => visualLength(line) === width));
    assert.ok(!lines.some((line) => stripAnsi(line).includes('scout_streams')));
  }
});

test('the role counts can be left out, and the corners can be round', () => {
  const lines = plain(
    draw(
      rich({
        cardVisibility: { cardRoleCounts: false },
        cardCorners: 'round',
        tree: { ...initialMonitorState().tree, selectedId: 'writer' },
      })
    ).lines
  );
  const lead = card(lines, 'parser_lead');
  assert.match(lead[0], /^╭ ◷ agent parser_lead/);
  assert.match(lead.at(-1)!, /^╰ No new activity 12m/);
  assert.ok(!lead.some((line) => /implementer/.test(line)));
  const settings = monitorSettings({ ...defaultSettings(), cardCorners: 'round', cardRoleCounts: false });
  assert.deepEqual([settings.cardCorners, settings.cardVisibility?.cardRoleCounts], ['round', false]);
  assert.deepEqual([defaultSettings().cardCorners, defaultSettings().cardRoleCounts], ['square', true]);
  assert.deepEqual(
    SETTING_ROWS.filter((row) => row.key === 'cardCorners' || row.key === 'cardRoleCounts').map((row) => [
      row.group,
      row.values,
    ]),
    [['Cards', ['square', 'round']]]
  );
});

test("j and k step from card to card, never onto a subtask; from one selected on its lead's card, up is the lead", () => {
  const tree = session();
  // Running first, the newest turn first: the critic, the lead, then the writer.
  const frame = draw(rich({ tree: { ...initialMonitorState().tree, selectedId: 'critic' } }), 44, tree);
  let state = frame.state;
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    state = handleMonitorInput(state, { type: 'key', key: 'down' }, { tree, frame, nowMs: NOW }).state;
    seen.push(state.tree.selectedId!);
  }
  assert.deepEqual(seen, ['lead', 'writer', 'writer']);
  const inside = { ...frame.state, tree: { ...frame.state.tree, selectedId: 's1' } };
  assert.equal(
    handleMonitorInput(inside, { type: 'key', key: 'up' }, { tree, frame, nowMs: NOW }).state.tree.selectedId,
    'lead'
  );
  assert.equal(
    handleMonitorInput(inside, { type: 'key', key: 'down' }, { tree, frame, nowMs: NOW }).state.tree.selectedId,
    'writer'
  );
  // The help names no folding in the cards: there is nothing under a card to fold.
  const help = plain(draw(rich({ help: true }), 70).lines).join('\n');
  assert.ok(!help.includes('fold / unfold agent'));
  assert.ok(
    plain(draw({ ...initialMonitorState(), help: true }, 70).lines)
      .join('\n')
      .includes('fold / unfold agent'),
    'the compact tree still folds'
  );
});

test('a card counts as every view does: its subtasks at any depth, and its reviews apart, on its ◈, red when one failed', () => {
  const review = (id: string, status: SubagentStatus) =>
    node(id, 'guardian', status, { depth: 2, kind: 'guardian', startedAt: ago(320), statusAt: ago(310) });
  // The writer, long finished: a subtask whose own subtask failed, and a review that failed.
  const tree = session();
  tree.nodes[2] = {
    ...tree.nodes[2],
    children: [
      kid('w1', 'w1', 'team-implementer', 'completed', 310, {
        children: [node('w1x', 'w1_probe', 'error', { depth: 3, startedAt: ago(315), statusAt: ago(312) })],
      }),
      review('wg', 'error'),
    ],
  };
  const lines = draw(rich(), 44, tree).lines;
  const row = lines.find((line) => stripAnsi(line).includes('docs_writer'))!;
  assert.match(stripAnsi(row).trimEnd(), /^┌ ✓ agent docs_writer .*to accept/);
  assert.ok(!plain(lines).some((line) => line.includes('w1_probe')), 'descendant failure stays folded into its owner');
  assert.ok(!row.includes('◈'), 'no guardian chip on the compact card');
  assert.match(
    plain(lines).find((line) => /^ ▦ /.test(line))!,
    /· 8 subtasks, 2 failed$/,
    'as the title counts them'
  );
  // A lead at work names a failure two levels down on its card, and a review under a subtask that failed.
  const deep = session();
  const [lead] = deep.nodes;
  deep.nodes[0] = {
    ...lead,
    children: [
      ...lead.children.slice(0, 2),
      kid('i3', 'impl_c', 'team-implementer', 'completed', 10, {
        children: [
          node('i3x', 'deep_probe', 'error', { depth: 3, startedAt: ago(9), statusAt: ago(8) }),
          { ...review('i3g', 'error'), depth: 3 },
        ],
      }),
    ],
  };
  const drawn = card(plain(draw(rich(), 44, deep).lines), 'parser_lead');
  assert.ok(drawn.length <= 3);
  assert.ok(!/◈|deep_probe|guardian/.test(drawn.join('\n')));
});

test("a finished L1's row counts its subtasks by state, and cards keep to the width in both languages", () => {
  const tree = session();
  tree.nodes[2] = {
    ...tree.nodes[2],
    children: [kid('w1', 'w1', 'team-implementer', 'completed', 310), kid('w2', 'w2', 'team-scout', 'error', 305)],
  };
  const lines = plain(draw(rich(), 44, tree).lines);
  assert.match(
    lines.find((line) => line.includes('docs_writer'))!,
    /^┌ ✓ agent docs_writer .*to accept/
  );
  assert.ok(!lines.some((line) => /w2/.test(line)));
  for (const language of ['en', 'zh'] as const) {
    const previous = setLanguage(language);
    try {
      for (const width of [16, 24, 32, 40, 48, 56]) {
        const frame = draw(rich({ importantRoles: roleSet('reviewer') }), width, tree);
        for (const line of frame.lines)
          assert.ok(visualLength(line) <= width, `${language} ${width}: ${stripAnsi(line)}`);
        for (const c of frame.controls)
          assert.ok(c.x >= 0 && c.x + c.width <= width, `${language} ${width}: control ${c.kind}`);
      }
    } finally {
      setLanguage(previous);
    }
  }
});

test('newest model note stays whole opened; live kid progress beats stale digest, request state preserves both notes', () => {
  const leadNote = 'Latest model note describes the streaming parser recovery work and ends with LEAD_END';
  const child = kid('child', 'child', undefined, 'running', undefined, { digest: 'STALE_DIGEST' });
  const lead = node('lead', 'lead', 'running', { children: [child], task: 'RAW_TASK', lastEventAt: ago(0) });
  const tree: SubagentTree = { rootId: 'root', nodes: [lead], totalCount: 2, updatedAt: new Date(NOW) };
  const log = new Map<string, AgentLogEntry[]>([
    [
      'lead',
      [
        { at: NOW - 2000, kind: 'note', text: 'OLD_HISTORY' },
        { at: NOW - 1000, kind: 'report', text: 'RAW_REPORT' },
        { at: NOW, kind: 'note', text: leadNote },
      ],
    ],
    ['child', [{ at: NOW, kind: 'note', text: 'CHILD_END' }]],
  ]);
  for (const width of [32, 40, 48, 56])
    for (const request of [undefined, { running: true }, { running: false, error: 'synthetic timeout' }]) {
      const frame = renderMonitor({
        tree,
        state: rich(),
        width,
        height: 80,
        nowMs: NOW,
        agentLog: log,
        progress: request
          ? new Map([
              ['lead', request],
              ['child', request],
            ])
          : undefined,
      });
      const text = plain(frame.lines).join('\n');
      assert.ok(!/STALE_DIGEST|RAW_TASK|RAW_REPORT|OLD_HISTORY/.test(text));
      assert.ok(!/STALE_DIGEST|RAW_TASK|RAW_REPORT|OLD_HISTORY|CHILD_END|Writing progress|Progress summary/.test(text));
      const projected = projectWorkCard(nativeWorker(lead), NOW),
        compact = renderWorkCard(projected, rich(), width, cardSentence(leadNote));
      assert.ok(compact.length <= 3);
      const expanded = renderWorkCard(projected, rich(), width, cardSentence(leadNote), true, false, leadNote);
      assert.ok(expanded.map(stripAnsi).join('\n').includes('LEAD_END'));
      for (const line of frame.lines) assert.equal(visualLength(line), width);
      for (const control of frame.controls) assert.ok(control.x >= 0 && control.x + control.width <= width);
    }
});

const cardInput = (tree: SubagentTree, state: MonitorState, agentLog?: Map<string, AgentLogEntry[]>) => ({
  tree,
  state,
  width: 56,
  height: 100,
  nowMs: NOW,
  agentLog,
});

function visibilityScene() {
  const children = [
    kid('live', 'live_child', 'team-worker', 'running', undefined, { digest: 'STALE_RESULT', label: 'smart_live' }),
    kid('failed', 'failed_child', 'team-worker', 'error', 2, { digest: 'STALE_FAILURE' }),
    kid('done', 'done_child', 'team-worker', 'completed', 3, {
      digest: 'Digest wins. Other detail\nBasis: synthetic evidence',
    }),
    kid('key', 'key_child', 'team-reviewer', 'completed', 4),
    kid('flag', 'flag_child', 'team-worker', 'completed', 5),
    kid('reviewLive', 'review_live', 'team-review', 'running', undefined, { kind: 'guardian' }),
    kid('reviewFailed', 'review_failed', 'team-review', 'error', 6, { kind: 'guardian' }),
    kid('reviewKey', 'review_key', 'team-reviewer', 'completed', 7, { kind: 'guardian' }),
    kid('reviewDone', 'review_done', 'team-review', 'completed', 8, { kind: 'guardian' }),
  ];
  const lead = node('lead', 'original_lead', 'running', {
    label: 'SmartLead',
    task: 'RAW_TASK',
    taskKind: 'fix',
    children,
    agentPath: '/root/lead',
    peers: { '/root/helper': 4 },
    turnStartedAt: ago(1),
    lastEventAt: ago(0),
    action: { name: 'exec', text: 'synthetic-command', at: ago(0) },
    model: 'gpt-6.1-sol',
    effort: 'high',
    outputRate: { tokensPerSecond: 42, sampleMs: 1000, sampledAt: ago(0) },
    contextUsage: {
      percent: 67,
      used: 67,
      total: 100,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      compactCount: 0,
    },
  });
  const helper = node('helper', 'relation_helper', 'running', {
    agentPath: '/root/helper',
    peers: { '/root/lead': 1 },
  });
  const tree: SubagentTree = { rootId: 'root', nodes: [lead, helper], totalCount: 11, updatedAt: new Date(NOW) };
  const log = new Map<string, AgentLogEntry[]>([
    [
      'lead',
      [
        { at: NOW - 1000, kind: 'note', text: 'OLD_HISTORY' },
        { at: NOW, kind: 'report', text: 'RAW_REPORT' },
        {
          at: NOW,
          kind: 'note',
          text: 'The newest lead summary wraps in full and ends with LEAD_END. Another lead sentence stays.',
        },
      ],
    ],
    ['live', [{ at: NOW, kind: 'note', text: 'Live progress wins. SECOND_SENTENCE' }]],
    [
      'failed',
      [
        { at: NOW, kind: 'note', text: 'Fallback note' },
        { at: NOW, kind: 'cause', text: 'Cause wins. SECOND_CAUSE' },
      ],
    ],
    ['done', [{ at: NOW, kind: 'note', text: 'Do not prefer this note' }]],
    ['flag', [{ at: NOW, kind: 'note', text: 'Flagged progress', attention: true }]],
  ]);
  return { lead, tree, log };
}

test('every card flag composes independently, with identity/status retained even when all optional fields are off', () => {
  const { lead, tree, log } = visibilityScene(),
    v = defaultCardVisibility();
  const drawCard = (flags: Partial<typeof v>, width = 56) => {
    const state = rich({ labelAsName: true, cardVisibility: flags });
    return agentCard(
      { node: lead, depth: 0, prefix: '', hasChildren: true, collapsed: false, context: false, parentId: null },
      cardInput(tree, state, log),
      state,
      width,
      NOW
    );
  };
  const words = (flags: Partial<typeof v>) => plain(drawCard(flags).map((r) => r.text)).join('\n');
  const full = words({});
  assert.match(full, /SmartLead/);
  assert.match(full, /The newest lead summary/);
  assert.match(full, /working 1m/);
  assert.ok(
    !/relation_helper|synthetic-command|smart_live|Cause wins|6.1sol|◈|tok\/s|67%|worker|Another lead sentence/.test(
      full
    )
  );
  for (const flag of Object.keys(v) as Array<keyof typeof v>) {
    if (flag === 'cardSubagentScope') continue;
    const text = words({ [flag]: false });
    assert.ok(text.includes(flag === 'cardLabel' ? 'original_lead' : 'SmartLead'));
    assert.ok(!/RAW_TASK|RAW_REPORT|OLD_HISTORY|STALE_RESULT|SECOND_SENTENCE|SECOND_CAUSE/.test(text));
    if (['cardLabel', 'cardSummary', 'cardClock'].includes(flag)) continue;
    assert.equal(words({ [flag]: false }), full, `${flag} is retired for compact work cards`);
  }
  assert.match(words({ cardLabel: false }), /original_lead/);
  assert.ok(!words({ cardSummary: false }).includes('The newest lead summary'));
  assert.ok(!words({ cardClock: false }).includes('1m'));
  const off = Object.fromEntries(
    Object.keys(v)
      .filter((k) => k !== 'cardSubagentScope')
      .map((k) => [k, false])
  ) as Partial<typeof v>;
  for (const width of [16, 24, 32, 40, 48, 56]) {
    const rows = drawCard(off, width);
    assert.equal(rows.length, 1);
    assert.match(stripAnsi(rows[0].text), /working/);
    assert.ok(rows.every((row) => visualLength(row.text) <= width));
    assert.ok(rows.flatMap((row) => row.controls ?? []).every((c) => c.kind === 'log' || c.kind === 'switch'));
    assert.ok(rows.every((row) => visualLength(row.text) === width));
    assert.ok(rows.flatMap((r) => r.controls ?? []).every((c) => c.kind === 'switch'));
    assert.ok(
      !/RAW_TASK|RAW_REPORT|OLD_HISTORY|STALE_RESULT|SECOND_SENTENCE|SECOND_CAUSE/.test(
        rows.map((r) => r.text).join('\n')
      )
    );
  }
});

test('clock, rate and context are separate footer fields in all eight combinations, and child clocks follow clock', () => {
  const { lead, tree, log } = visibilityScene();
  for (const cardClock of [false, true])
    for (const cardRate of [false, true])
      for (const cardContext of [false, true]) {
        const state = rich({ cardVisibility: { cardClock, cardRate, cardContext } });
        const rows = agentCard(
          { node: lead, depth: 0, prefix: '', hasChildren: true, collapsed: false, context: false, parentId: null },
          cardInput(tree, state, log),
          state,
          56,
          NOW
        );
        const head = stripAnsi(rows[0].text);
        assert.equal(head.includes('1m'), cardClock, head);
        assert.ok(!rows.some((row) => /tok\/s|67%|failed_child/.test(stripAnsi(row.text))));
        assert.ok(rows.length <= 3);
      }
});

test('child scope and summary toggles use identical subjects for rendering and progress eligibility, including reviews', () => {
  const { tree, log } = visibilityScene();
  const expected = {
    live: ['live', 'reviewLive'],
    important: ['live', 'failed', 'key', 'flag', 'reviewLive', 'reviewFailed', 'reviewKey'],
    all: ['live', 'failed', 'done', 'key', 'flag', 'reviewLive', 'reviewFailed', 'reviewKey', 'reviewDone'],
  };
  for (const cardSubagentScope of ['live', 'important', 'all'] as const)
    for (const cardSubagents of [false, true])
      for (const cardSubagentSummary of [false, true])
        for (const cardSummary of [false, true]) {
          const state = rich({
            importantRoles: roleSet('reviewer'),
            cardVisibility: { cardSubagentScope, cardSubagents, cardSubagentSummary, cardSummary },
          });
          const frame = renderMonitor({ ...cardInput(tree, state, log), height: 120 });
          const targets = cardSummaryTargets({ tree, agentLog: log }, state, NOW);
          assert.deepEqual(
            [...targets].sort(),
            [
              ...(cardSummary ? ['lead', 'helper'] : []),
              ...(cardSubagents && cardSubagentSummary ? expected[cardSubagentScope] : []),
            ].sort()
          );
          const shown = new Set(frame.controls.filter((c) => c.kind === 'log').map((c) => c.item));
          for (const id of expected.all) assert.equal(shown.has(id), false, id);
          const raw = log.get('lead')!.at(-1)!.text;
          const expanded = renderWorkCard(
            projectWorkCard(nativeWorker(tree.nodes[0]), NOW),
            state,
            56,
            raw,
            true,
            false,
            raw
          );
          const text = plain(frame.lines).join('\n') + '\n' + expanded.map(stripAnsi).join('\n');
          assert.equal(text.includes('Live progress wins.'), false);
          assert.equal(text.includes('LEAD_END'), cardSummary);
          assert.equal(text.includes('The newest lead summary'), cardSummary);
          assert.ok(!/SECOND_SENTENCE|SECOND_CAUSE|STALE_RESULT|STALE_FAILURE/.test(text));
        }
});

test('hidden summaries have no pending/error rows or targets; linger/filter, tabs, zoom and help gate UI eligibility', () => {
  const { tree, log } = visibilityScene();
  const progress = new Map(
    tree.nodes.flatMap((n) => [n, ...n.children]).map((n) => [n.id, { running: false, error: 'synthetic error' }])
  );
  for (const cardSummary of [false, true])
    for (const cardSubagentSummary of [false, true]) {
      const state = rich({ cardVisibility: { cardSummary, cardSubagentSummary } });
      const text = plain(renderMonitor({ ...cardInput(tree, state, log), height: 120, progress }).lines).join('\n');
      assert.equal(text.includes('Progress summary failed'), false);
      if (!cardSummary) {
        assert.ok(!/The newest lead summary|queued|Writing progress|synthetic error/.test(text));
        const lead = projectWorkCard(nativeWorker(tree.nodes[0]), NOW);
        const expanded = renderWorkCard(lead, state, 56, 'Secret hidden summary', true, false, 'Secret hidden detail');
        assert.ok(!/Secret hidden|queued|Writing progress|synthetic error/.test(expanded.map(stripAnsi).join('\n')));
      }
      if (!cardSummary && !cardSubagentSummary)
        assert.equal(cardSummaryTargets({ tree, agentLog: log }, state, NOW).size, 0);
    }
  const hidden: Partial<MonitorState>[] = [
    { style: 'compact' },
    { help: true },
    { modes: { ...rich().modes, agents: 'closed' } },
    { tabbed: true, focus: 'details' },
    { zoom: true, focus: 'timeline' },
  ];
  for (const extra of hidden) assert.equal(cardSummaryTargets({ tree, agentLog: log }, rich(extra), NOW).size, 0);
  const old = node('old', 'old', 'completed', { statusAt: ago(20) });
  const failed = node('error', 'failed', 'error', { statusAt: ago(20) });
  const live = node('new', 'live', 'running');
  const subjects: SubagentTree = { ...tree, nodes: [old, failed, live] };
  const state = rich({ tree: { ...rich().tree, showAll: false, lingerMs: 60_000 } });
  assert.deepEqual([...cardSummaryTargets({ tree: subjects }, state, NOW)].sort(), ['error', 'new']);
  assert.deepEqual(
    [...cardSummaryTargets({ tree: subjects }, { ...state, tree: { ...state.tree, showAll: true } }, NOW)].sort(),
    ['error', 'new', 'old']
  );
  assert.deepEqual(
    [...cardSummaryTargets({ tree: subjects }, { ...state, tree: { ...state.tree, filter: 'failed' } }, NOW)],
    ['error']
  );
});

test('child sentence extraction keeps only meaningful model prose with a 160-codepoint safety bound', () => {
  assert.equal(cardSentence('\n- The result landed. More details.\nBasis: synthetic'), 'The result landed.');
  assert.equal(
    cardSentence('Basis: synthetic evidence\nCaveats: irrelevant\nSummary: First meaningful result! Second result.'),
    'First meaningful result!'
  );
  assert.equal(cardSentence('修复已完成。更多内容\n依据：测试'), '修复已完成。');
  assert.equal(cardSentence('Version 6.1 works. More detail.'), 'Version 6.1 works.');
  // A digest is one line, its conclusion and evidence joined by " · " (digestText):
  // the basis and caveats stay in the Inspector, with or without terminal punctuation.
  assert.equal(
    cardSentence('Fixed the timeout by warming the cache · Basis: synthetic slow disk · Caveats: untested on CI'),
    'Fixed the timeout by warming the cache'
  );
  assert.equal(
    cardSentence('Compared input · output before merging · Basis: synthetic'),
    'Compared input · output before merging'
  );
  assert.equal(cardSentence('完成对比 · 依据：合成数据 · 注意事项：未部署'), '完成对比');
  assert.equal(cardSentence('存疑：合成风险。依据：测试数据'), '存疑：合成风险。');
  assert.equal([...cardSentence('界'.repeat(200))].length, 160);
  assert.ok(cardSentence('界'.repeat(200)).endsWith('…'));
  assert.equal(cardSentence('Caveats: none\nBasis: none'), '');
  assert.equal(cardSentence('Escaped\x1b[2J. More.'), 'Escaped\\x1b[2J.');
});

test('child sentences wrap whole at every panel width, sanitize once, and never use active stale digests', () => {
  const text = '模型正在核对缓存恢复并准备提交完整的测试结果给协调者。忽略第二句话';
  const child = kid('child', 'child_with_a_long_name', 'worker', 'running', undefined, {
    digest: 'STALE_DIGEST',
    task: 'RAW_TASK',
  });
  const done = kid('done', 'done', 'worker', 'completed', 2, {
    digest: 'Basis: synthetic\n- Digest result wraps completely beside or under its name. Ignore later.\nCaveats: none',
  });
  const failed = kid('failed', 'failed', 'worker', 'error', 3, { digest: 'STALE_FAILURE' });
  const lead = node('lead', 'lead', 'running', { children: [child, done, failed] });
  const tree: SubagentTree = { rootId: 'root', nodes: [lead], totalCount: 4, updatedAt: new Date(NOW) };
  const agentLog = new Map<string, AgentLogEntry[]>([
    ['child', [{ at: NOW, kind: 'note', text }]],
    ['failed', [{ at: NOW, kind: 'note', text: 'Fallback note only. Ignore later.' }]],
  ]);
  for (const lang of ['en', 'zh'] as const) {
    const previous = setLanguage(lang);
    try {
      for (const width of [16, 24, 32, 40, 48, 56]) {
        const state = rich({ cardVisibility: { cardClock: false, cardSubagentScope: 'all', cardRoleCounts: false } });
        const frame = renderMonitor({ tree, state, agentLog, width, height: 100, nowMs: NOW });
        const full = plain(frame.lines).join('\n');
        assert.ok(!/忽略第二句话|STALE_DIGEST|STALE_FAILURE|RAW_TASK|Basis|Caveats|Ignore later/.test(full), full);
        assert.ok(
          !/child_with|Digest result|Fallback note|忽略第二句话|STALE_DIGEST|STALE_FAILURE|RAW_TASK|Basis|Caveats|Ignore later/.test(
            full
          ),
          full
        );
        const sentence = cardSentence(text),
          projected = projectWorkCard(nativeWorker(lead), NOW);
        const compact = renderWorkCard(projected, state, width, sentence);
        assert.ok(compact.length <= 3);
        const expanded = renderWorkCard(projected, state, width, sentence, true, false, sentence);
        const all = expanded
          .slice(compact.length)
          .map((line) => stripAnsi(line).slice(2).trim())
          .join('')
          .replace(/\s/g, '');
        assert.ok(all.includes('模型正在核对缓存恢复并准备提交完整的测试结果给协调者。'), all);
        for (const line of expanded) assert.equal(visualLength(line), width);
        for (const line of frame.lines) assert.equal(visualLength(line), width);
        for (const control of frame.controls) assert.ok(control.x >= 0 && control.x + control.width <= width);
      }
    } finally {
      setLanguage(previous);
    }
  }
  const raw = 'Safe\x1b[2J. Not shown.';
  assert.equal(cardSentence(raw), 'Safe\\x1b[2J.');
});
