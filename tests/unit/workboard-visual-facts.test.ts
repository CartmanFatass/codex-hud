import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../src/render/monitor.js';
import { stripAnsi, visualLength, theme } from '../../src/render/colors.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { setLanguage } from '../../src/render/i18n.js';
import { targetKey } from '../../src/collectors/workboard-types.js';
import { roleWord } from '../../src/render/workboard-rows.js';
import { r5Fixture, ROOT_R5 } from '../fixtures/r5-jobs.js';

test('orchestrator visual 1: production Home/Work show one cursor, readable distinct answers, phase axes, counts, aligned glyph-first workers and folded controls', async (t) => {
  const oldDisplay = setDisplayConfig({ theme: 'none', icons: 'unicode' }),
    oldLanguage = setLanguage('en');
  t.after(() => {
    setDisplayConfig(oldDisplay);
    setLanguage(oldLanguage);
  });
  const f = r5Fixture(t),
    workspace = join(f.home, 'workspace');
  const task = (name: string, role: string | null, state = 'working') => {
    const dir = join(workspace, 'tmp', 'tasks', name);
    f.put(join(dir, 'brief.md'), `# Synthetic ${name} task`);
    if (role)
      f.put(join(dir, 'STATUS.json'), {
        version: 1,
        task_dir: dir,
        slot: 'primary',
        role,
        model: role === 'reviewer' ? 'gpt-synthetic-review' : 'gpt-synthetic',
        thinking: 'high',
        session_id: `synthetic-${name}`,
        output_path: join(dir, 'report.md'),
        output_written: state === 'idle_grace',
        state,
        helper_pending: null,
        started_at: '2026-11-09T11:30:00Z',
        settled_at: state === 'idle_grace' ? '2026-11-09T11:55:00Z' : null,
        idle_deadline_at: null,
        ended_at: null,
        exit_reason: null,
        error: null,
      });
    if (state === 'idle_grace') f.put(join(dir, 'report.md'), 'Synthetic completed output.');
    return dir;
  };
  const qa = (
    d: string,
    n: number,
    question: string,
    answer: string,
    options = ['keep the boundary', 'drop the shim']
  ) => {
    const q = join(d, 'qa', `q${n}.md`),
      a = join(d, 'qa', `q${n}.answer.md`);
    f.put(
      q,
      `# Question\n\n${question}\n\nOptions:\n- A) ${options[0]}\n- B) ${options[1]}\n\nDefault if unanswered: A`
    );
    f.put(a, answer);
  };
  const build = task('BUILD', 'implementer');
  qa(build, 1, 'Should compatibility stay?', 'B');
  qa(build, 2, 'Should IDs stay opaque?', 'A', ['retain UUID identifiers', 'use a sequence']);
  qa(build, 3, 'Should logs retain audit events?', 'A', ['retain audit events', 'discard audit events']);
  qa(task('DESIGN', 'architect'), 1, 'Which source boundary stays?', 'A');
  task('REVIEW', 'reviewer');
  task('ACCEPT', 'implementer', 'idle_grace');
  task('UNKNOWN', null);
  const web = {
    id: 'web',
    executor: 'jev' as const,
    harness: null,
    model: 'synthetic-web',
    effort: null,
    env_profile: null,
    recipe: null,
  };
  f.jev(
    f.association(1, { backend: web, role: 'jev', task_label: 'Synthetic browser handoff' }),
    'completed',
    { status: 'needs_human' },
    false,
    { run: { startedAt: '2026-11-09T11:00:00Z', endedAt: '2026-11-09T11:50:00Z' } }
  );
  const p = new PanelJobPipeline(f.home, ROOT_R5, { live: false, now: f.now }, workspace);
  t.after(() => p.dispose());
  for (let n = 0; n < 100; n++) await p.refresh();
  const v = p.compose(f.emptyTree(), null, f.now()),
    board = p.workboard(v.tree, v.legacy);
  assert.equal(board.coverage.incomplete, false);
  const draw = (width: number, mainTab: 'home' | 'work' = 'home') =>
    renderMonitor({
      tree: v.tree,
      workboard: board,
      state: { ...initialMonitorState(), mainTab },
      width,
      height: 100,
      nowMs: f.now(),
    });
  for (const width of [44, 56, 110]) {
    for (const tab of ['home', 'work'] as const) {
      const frame = draw(width, tab),
        text = frame.lines.map(stripAnsi).join('\n');
      assert.equal((text.match(/›/g) ?? []).length, 1, `${tab} ${width}: one physical cursor`);
      for (const line of frame.lines) assert.equal(visualLength(line), width);
    }
    const frame = draw(width);
    assert.equal(frame.panes[0].y, 1);
    assert.match(stripAnsi(frame.lines[0]), /Ctrl\+\\ then key/);
    assert.ok(!stripAnsi(frame.lines[1]).includes('Inspect Settings Help'));
    for (const kind of ['board-inspect', 'settings', 'help'] as const) {
      const c = frame.controls.find((c) => c.kind === kind)!;
      assert.ok(c);
      assert.equal(c.y, 0);
      const clicked = handleMonitorInput(
        frame.state,
        { type: 'mouse', button: 'left', x: c.x, y: c.y },
        { tree: v.tree, frame, standalone: true, nowMs: f.now() }
      );
      if (kind === 'board-inspect') assert.equal(clicked.state.focus, 'details');
      else if (kind === 'settings') assert.equal(clicked.action?.type, 'settings');
      else assert.equal(clicked.state.help, true);
    }
    const rows = frame.workboard!.rows;
    for (const label of ['BUILD', 'DESIGN', 'REVIEW', 'ACCEPT']) {
      const lane = board.lanes.find((l) => l.label === label)!;
      const row = stripAnsi(
        rows.find(
          (r) =>
            r.item === targetKey({ kind: 'lane', laneId: lane.id }) ||
            r.controls?.some((c) => c.item === targetKey({ kind: 'lane', laneId: lane.id }))
        )!.text
      );
      assert.match(row, /━{1,6}▸─{3,8}/, `${label}: observed ten-cell phase axis`);
    }
    const unknown = board.lanes.find((l) => l.label === 'UNKNOWN')!;
    const unknownRow = stripAnsi(
      rows.find(
        (r) =>
          r.item === targetKey({ kind: 'lane', laneId: unknown.id }) ||
          r.controls?.some((c) => c.item === targetKey({ kind: 'lane', laneId: unknown.id }))
      )!.text
    );
    assert.match(unknownRow, /phase unknown/);
    assert.doesNotMatch(unknownRow, /━{1,6}▸─{3,8}/);
    const text = frame.lines.map(stripAnsi).join('\n');
    assert.match(text, /1 call\b/);
    assert.match(text, /3 calls\b/);
    assert.doesNotMatch(text, /1 calls\b/);
    assert.match(text, /decided for you/);
    assert.doesNotMatch(text, /recorded calls/);
  }
  const frame = draw(56),
    lane = board.lanes.find((l) => l.label === 'BUILD')!,
    answers = lane.decisions.filter((d) => d.title === 'A');
  assert.equal(answers.length, 2);
  const titles = answers.map((d) =>
    stripAnsi(
      frame.workboard!.rows.find((r) => r.item === targetKey({ kind: 'decision', laneId: lane.id, decisionId: d.id }))!
        .text
    )
  );
  assert.notEqual(titles[0], titles[1]);
  assert.ok(titles.some((t) => t.includes('Should IDs')));
  assert.ok(titles.some((t) => t.includes('Should logs')));
  const q1 = lane.decisions.find((d) => d.title === 'B')!,
    key = targetKey({ kind: 'decision', laneId: lane.id, decisionId: q1.id });
  assert.equal(q1.option, 'B: drop the shim');
  const expanded = renderMonitor({
    tree: v.tree,
    workboard: board,
    state: {
      ...initialMonitorState(),
      homeTarget: { kind: 'decision', laneId: lane.id, decisionId: q1.id },
      boardExpanded: new Set([key]),
    },
    width: 56,
    height: 100,
    nowMs: f.now(),
  });
  assert.match(
    expanded.lines.map(stripAnsi).join(' ').replace(/<1m/g, '').replace(/\s+/g, ' '),
    /Should compatibility stay\? → B: drop the shim/
  );
  for (const width of [56, 110]) {
    const frame = draw(width),
      rows = frame.workboard!.rows;
    let modelColumn: number | undefined;
    for (const w of board.workers) {
      const key = targetKey({ kind: 'worker', laneId: w.laneId, workerId: w.id });
      const row = stripAnsi(rows.filter((r) => r.item === key).at(-1)!.text);
      assert.match(row, /^[?▸✓◷] /);
      if (w.harness) assert.equal(row.indexOf(w.harness), 2);
      else assert.equal(row.slice(2, 8), '      ');
      if (w.role) assert.ok(row.slice(9).startsWith(w.role));
      if (w.model) {
        const column = row.indexOf(w.model);
        assert.ok(column >= 0);
        modelColumn ??= column;
        assert.equal(column, modelColumn);
      }
      if (w.effort) assert.match(row, /·high/);
      assert.match(row, /\d+m$/);
      assert.equal(visualLength(row), width - 1);
    }
  }
  const display = setDisplayConfig({ theme: 'titanium' });
  try {
    const colored = draw(56).lines.join('\n');
    assert.ok(colored.includes('\x1b[38;2;239;193;90m'));
    assert.ok(theme.warning('elsewhere').includes('255;179;71'));
    for (const [role, rgb] of Object.entries({
      imp: '76;195;234',
      reviewer: '226;111;206',
      sonic: '255;143;114',
      oracle: '169;157;242',
      jev: '63;217;176',
    }))
      assert.ok(roleWord(role).includes(`38;2;${rgb}m`));
  } finally {
    setDisplayConfig(display);
  }
  const language = setLanguage('zh');
  try {
    const frame = draw(56);
    assert.match(frame.lines.map(stripAnsi).join('\n'), /代你决定/);
    assert.match(stripAnsi(frame.lines[0]), /Ctrl\+\\ 再按键/);
    for (const line of frame.lines) assert.equal(visualLength(line), 56);
  } finally {
    setLanguage(language);
  }
});
