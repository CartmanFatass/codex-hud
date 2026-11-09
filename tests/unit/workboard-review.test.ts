import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { TaskObservationCollector } from '../../src/collectors/task-observations.js';
import { JobObservationCollector } from '../../src/collectors/job-observations.js';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { renderMonitor, initialMonitorState, handleMonitorInput, type MonitorState } from '../../src/render/monitor.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { r5Fixture, ROOT_R5 } from '../fixtures/r5-jobs.js';

function fixture(t: TestContext) {
  const f = r5Fixture(t),
    workspace = join(f.home, 'workspace');
  fs.mkdirSync(join(workspace, 'tmp', 'tasks'), { recursive: true });
  const task = (name = 'SYN') => {
    const d = join(workspace, 'tmp', 'tasks', name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const qa = (d: string, n: number, answer: string, at = f.now() - 60000, reverse = false) => {
    const q = join(d, 'qa', `q${n}.md`),
      a = join(d, 'qa', `q${n}.answer.md`);
    f.put(
      q,
      `# Question\n\nWhich boundary?\n\nOptions:\n- A) ${reverse ? 'Remove' : 'Keep'}\n- B) ${reverse ? 'Keep' : 'Remove'}\n\nDefault if unanswered: ${reverse ? 'B' : 'A'}`
    );
    f.put(a, answer);
    fs.utimesSync(q, new Date(at - 1000), new Date(at - 1000));
    fs.utimesSync(a, new Date(at), new Date(at));
  };
  const collector = () => {
    const c = new TaskObservationCollector(workspace);
    t.after(() => c.dispose());
    return c;
  };
  const pipeline = () => {
    const p = new PanelJobPipeline(f.home, ROOT_R5, { live: false, now: f.now }, workspace);
    t.after(() => p.dispose());
    return p;
  };
  const warm = async (p: PanelJobPipeline) => {
    for (let n = 0; n < 40; n++) await p.refresh();
    const composed = p.compose(f.emptyTree(), null, f.now());
    return { tree: composed.tree, board: p.workboard(composed.tree, composed.legacy) };
  };
  return { ...f, workspace, task, qa, collector, pipeline, warm };
}

for (const replacement of ['symlink', 'real-directory'])
  test(`review R1: warm completed-job dependency probes refuse ${replacement} ancestor with identical leaves`, async (t) => {
    const f = fixture(t),
      a = f.association(1);
    f.dispatch(a, 'idle_grace', { output_written: true, settled_at: '2026-11-09T11:50:00Z' });
    f.put(a.report_path, 'Synthetic complete');
    const c = new JobObservationCollector(f.home, { root: ROOT_R5, live: false, now: f.now });
    t.after(() => c.dispose());
    let snapshot = await c.refresh();
    for (let n = 0; n < 40; n++) snapshot = await c.refresh();
    assert.equal(snapshot.jobs[0].freshness.state, 'current');
    assert.equal(snapshot.jobs[0].status, 'completed');
    const jobs = join(f.home, 'jobs'),
      moved = join(f.home, 'moved-jobs');
    fs.renameSync(jobs, moved);
    if (replacement === 'symlink') fs.symlinkSync(moved, jobs, 'dir');
    else {
      fs.mkdirSync(jobs);
      fs.renameSync(join(moved, a.job), join(jobs, a.job));
    }
    for (let n = 0; n < 40; n++) {
      snapshot = await c.refresh();
      assert.ok(snapshot.jobs.every((job) => job.freshness.state !== 'current'));
    }
    assert.ok(snapshot.coverage.diagnostics.length > 0);
    assert.equal(snapshot.coverage.incomplete, true);
  });

test('review R2: discovery beyond 200 sources cannot consume the admitted-source processing share', (t) => {
  const f = fixture(t);
  for (let n = 0; n < 270; n++) f.task(`T${String(n).padStart(3, '0')}`);
  const c = f.collector();
  let snapshot = c.refresh();
  for (let n = 0; n < 300; n++) {
    snapshot = c.refresh();
    assert.ok(snapshot.cost.probes <= 64);
    assert.ok(snapshot.cost.files <= 8);
  }
  assert.equal(snapshot.lanes.length, 200);
  assert.equal(snapshot.coverage.incomplete, true);
  assert.ok(snapshot.coverage.diagnostics.includes('lane_capacity'));
});

test('review R3: every one-file QA slice preserves the last coherent call instead of publishing a mixed departure', (t) => {
  const f = fixture(t),
    d = f.task(),
    c = f.collector();
  f.qa(d, 1, 'A');
  let snapshot = c.refresh();
  for (let n = 0; n < 30; n++) snapshot = c.refresh();
  assert.equal(snapshot.lanes[0].decisions[0].departure, false);
  const original = snapshot.lanes[0].decisions[0];
  f.qa(d, 1, 'B', f.now() - 10000, true);
  snapshot = c.refresh([], undefined, { maxFiles: 1 });
  const pending = snapshot.lanes[0].decisions[0];
  assert.equal(pending.departure, false);
  assert.equal(pending.stale, true);
  assert.deepEqual(pending.evidence, original.evidence);
  assert.equal(snapshot.coverage.incomplete, true);
  for (let n = 0; n < 8; n++) {
    snapshot = c.refresh([], undefined, { maxFiles: 1 });
    assert.ok(snapshot.lanes[0].decisions.every((d) => !d.departure));
  }
  assert.equal(snapshot.lanes[0].decisions[0].title, 'B');
  assert.equal(snapshot.lanes[0].decisions[0].stale, false);
  assert.equal(snapshot.coverage.incomplete, false);
});

test('review R4: ended ask and judge needs-human jobs without end clocks still appear, running ones do not', async (t) => {
  const f = fixture(t),
    web = {
      id: 'synthetic-jev',
      executor: 'jev' as const,
      harness: null,
      model: null,
      effort: null,
      env_profile: null,
      recipe: null,
    };
  f.jev(f.association(1, { backend: web, role: 'jev' }), 'completed', { status: 'needs_human' });
  f.jev(
    f.association(2, { backend: web, role: 'jev' }),
    'completed',
    { statements: [{ name: 'synthetic', verdict: 'needs_human' }], calls: 1, extendedMs: 0 },
    false,
    {
      tag: 'judge',
      input: {
        tag: 'judge',
        url: 'https://example.test/',
        statements: [{ name: 'synthetic', statement: 'Synthetic' }],
      },
    }
  );
  f.jev(f.association(3, { backend: web, role: 'jev' }), 'running', { status: 'needs_human' });
  const data = await f.warm(f.pipeline());
  assert.equal(data.board.workers.filter((w) => w.homeNeedsHuman).length, 2);
  assert.ok(data.board.workers.every((w) => w.humanEndedAt === null));
  const frame = renderMonitor({
    tree: data.tree,
    workboard: data.board,
    state: initialMonitorState(),
    width: 56,
    height: 32,
    nowMs: f.now(),
  });
  const text = frame.lines.map(stripAnsi).join('\n');
  assert.match(text, /Home \?2/);
  assert.match(text, /need you 2/);
  assert.doesNotMatch(text, /nothing needs you|NaN|Invalid Date/);
  for (const line of frame.lines) assert.equal(visualLength(line), 56);
});

test('review R5: older-today fold is a traversable/collapsible keyboard anchor in both directions', async (t) => {
  const f = fixture(t),
    d = f.task();
  f.qa(d, 1, 'A');
  f.qa(d, 2, 'B', f.now() - 3 * 3600000);
  const data = await f.warm(f.pipeline());
  let state = initialMonitorState();
  const draw = () =>
    renderMonitor({ tree: data.tree, workboard: data.board, state, width: 56, height: 40, nowMs: f.now() });
  const press = (key: string) => {
    const frame = draw();
    state = handleMonitorInput(
      frame.state,
      { type: 'key', key },
      { tree: data.tree, frame, standalone: true, nowMs: f.now() }
    ).state;
    return state;
  };
  const first = draw();
  state = first.state;
  const recent = state.homeTarget!;
  assert.equal(recent.kind, 'decision');
  press('down');
  assert.equal(state.boardAnchor, 'fold:older');
  assert.ok(state.boardExpanded?.has('fold:older'));
  assert.ok(
    draw()
      .lines.map(stripAnsi)
      .some((l) => l.startsWith('›') && l.includes('older today'))
  );
  press('down');
  assert.equal(state.boardAnchor, undefined);
  assert.equal(state.homeTarget?.kind, 'decision');
  assert.notDeepEqual(state.homeTarget, recent);
  const older = state.homeTarget;
  press('down');
  assert.equal(state.homeTarget?.kind, 'lane');
  press('up');
  assert.deepEqual(state.homeTarget, older);
  press('up');
  assert.equal(state.boardAnchor, 'fold:older');
  press('left');
  assert.equal(state.boardExpanded?.has('fold:older'), false);
  press('right');
  assert.equal(state.boardExpanded?.has('fold:older'), true);
  press('up');
  assert.deepEqual(state.homeTarget, recent);
  assert.equal(state.boardAnchor, undefined);
});

for (const outage of ['permissions', 'replacement'])
  test(`review R6: QA ${outage} outage retains individually stale calls; safe revalidation recovers`, (t) => {
    const f = fixture(t),
      d = f.task(),
      c = f.collector();
    f.qa(d, 1, 'B');
    f.qa(d, 2, 'B');
    let snapshot = c.refresh();
    for (let n = 0; n < 30; n++) snapshot = c.refresh();
    assert.ok(snapshot.lanes[0].decisions.every((d) => !d.stale));
    const qa = join(d, 'qa'),
      moved = join(f.home, 'moved-qa');
    if (outage === 'permissions') fs.chmodSync(qa, 0);
    else {
      fs.renameSync(qa, moved);
      fs.symlinkSync(moved, qa, 'dir');
    }
    for (let n = 0; n < 30; n++) snapshot = c.refresh();
    assert.equal(snapshot.lanes[0].decisions.length, 2);
    assert.ok(snapshot.lanes[0].decisions.every((d) => d.stale));
    assert.equal(snapshot.coverage.incomplete, true);
    if (outage === 'permissions') {
      fs.chmodSync(qa, 0o700);
      for (let n = 0; n < 30; n++) snapshot = c.refresh();
      assert.ok(snapshot.lanes[0].decisions.every((d) => !d.stale));
      assert.equal(snapshot.coverage.incomplete, false);
    }
  });

test('review R7: wide right-column lane selection paints its own cursor, including initial calm selection', async (t) => {
  const previous = setDisplayConfig({ theme: 'none' });
  t.after(() => setDisplayConfig(previous));
  const f = fixture(t);
  f.qa(f.task('SYN'), 1, 'A');
  f.task('ZZZ');
  const data = await f.warm(f.pipeline()),
    lane = data.board.lanes.find((l) => l.label === 'ZZZ')!;
  const state: MonitorState = { ...initialMonitorState(), homeTarget: { kind: 'lane', laneId: lane.id } };
  const frame = renderMonitor({
    tree: data.tree,
    workboard: data.board,
    state,
    width: 110,
    height: 30,
    nowMs: f.now(),
  });
  const rows = frame.lines.map(stripAnsi).filter((line) => line.includes('›'));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /› ZZZ/);
  assert.ok(rows[0].indexOf('›') > 55);
  assert.ok(frame.controls.some((c) => c.kind === 'board-pick' && c.x > 55));
  // No left-side call: the right-hand progress lane is still a real initial target/cursor.
  fs.unlinkSync(join(f.workspace, 'tmp', 'tasks', 'SYN', 'qa', 'q1.answer.md'));
  const calm = await f.warm(f.pipeline());
  const empty = renderMonitor({
    tree: calm.tree,
    workboard: calm.board,
    state: initialMonitorState(),
    width: 110,
    height: 30,
    nowMs: f.now(),
  });
  assert.equal(empty.state.homeTarget?.kind, 'lane');
  assert.ok(empty.lines.map(stripAnsi).some((line) => line.indexOf('›') > 55));
});
