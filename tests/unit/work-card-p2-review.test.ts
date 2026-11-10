import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { p2Fixture, p2Native } from '../fixtures/work-card-p2.js';
import { refR5 } from '../fixtures/r5-jobs.js';
import { associationPath } from '../../src/roles/association.js';
import { useDisplayFixture } from '../fixtures/display.js';
import { projectWorkCard } from '../../src/collectors/work-card.js';
import { targetKey } from '../../src/collectors/workboard-types.js';
import { initialMonitorState, renderMonitor, handleMonitorInput, type MonitorState } from '../../src/render/monitor.js';
import { inspectorRows } from '../../src/render/monitor-inspector.js';
import { visibleWorkboard } from '../../src/render/work-visibility.js';
import { stripAnsi } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';
useDisplayFixture();
const key = (key: string) => ({ type: 'key' as const, key });
const work = (): MonitorState => ({ ...initialMonitorState(), mainTab: 'work' });
const text = (frame: ReturnType<typeof renderMonitor>) => frame.lines.map(stripAnsi).join('\n');

test('P2 review: reused/unknown helper timing cannot fail a replacement primary; current failure and root authority survive', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  const primary = {
    state: 'waiting_helper',
    helper_pending: { kind: 'review', n: 1, status_file: null },
    started_at: new Date(f.now() - 60000).toISOString(),
  };
  f.status(d, primary);
  f.status(
    d,
    { state: 'failed', error: 'old failure', started_at: new Date(f.now() - 3600000).toISOString() },
    'review-1'
  );
  let data = await f.draw();
  let owner = data.board.workers[0];
  assert.equal(projectWorkCard(owner, f.now()).state, 'in-progress');
  assert.equal(owner.work?.helperSignature, null);
  assert.match(data.text, /review r1 unknown/);
  assert.doesNotMatch(data.text, /needs you|Work failed/);
  f.status(d, { state: 'failed', error: 'unconfirmed failure', started_at: undefined }, 'review-1');
  data = await f.draw();
  owner = data.board.workers[0];
  assert.equal(projectWorkCard(owner, f.now()).state, 'in-progress');
  assert.equal(owner.work?.helperSignature, null);
  assert.equal(owner.work?.failed, false);
  assert.match(data.text, /review r1 unknown/);
  f.status(
    d,
    { state: 'failed', error: 'current failure', started_at: new Date(f.now() - 30000).toISOString() },
    'review-1'
  );
  data = await f.draw();
  assert.equal(projectWorkCard(data.board.workers[0], f.now()).state, 'needs-you');
  assert.match(data.text, /Work failed/);
  // Neither missing primary timing nor unconfirmed helper timing may hide root facts.
  f.status(d, { ...primary, started_at: undefined, state: 'failed', error: 'root failure' });
  data = await f.draw();
  assert.match(data.text, /Work failed/);
  f.status(d, { state: 'waiting_orchestrator', started_at: undefined });
  data = await f.draw();
  assert.match(data.text, /needs you/);
  assert.match(data.text, /Decision requested/);
});

test('P2 review: actual native linger removes cards/counts/targets, invalidates a quiet cache edge, and honors showAll/filter', async (t) => {
  const f = p2Fixture(t),
    now = f.now(),
    old = now - 3600000;
  const nodes = [
    p2Native('Expired native', {
      status: 'completed',
      startedAt: new Date(old - 60000),
      turnStartedAt: new Date(old - 60000),
      statusAt: new Date(old),
      lastEventAt: new Date(old),
    }),
    p2Native('Fresh native', { status: 'completed', statusAt: new Date(now) }),
    p2Native('Live but stalled', { lastEventAt: new Date(old), turnStartedAt: new Date(old) }),
    p2Native('Expired unknown', { status: 'unknown', lastEventAt: new Date(old), turnStartedAt: new Date(old) }),
  ];
  const data = await f.collect(nodes),
    state = work();
  state.tree = { ...state.tree, lingerMs: 60000 };
  const args = { tree: data.tree, workboard: data.board, width: 110, height: 40, state, nowMs: now };
  let frame = renderMonitor(args);
  assert.doesNotMatch(text(frame), /Expired native|Expired unknown/);
  assert.match(text(frame), /Fresh native/);
  assert.match(text(frame), /Live but stalled/);
  assert.equal(frame.workboard?.snapshot.workers.length, 2);
  for (const worker of data.board.workers.filter((w) => w.task.startsWith('Expired')))
    assert.ok(!frame.workboard?.targets.has(targetKey({ kind: 'worker', laneId: worker.laneId, workerId: worker.id })));
  const down = handleMonitorInput(frame.state, key('down'), { tree: data.tree, frame, nowMs: now });
  assert.ok(!JSON.stringify(down.state.workTarget).includes('Expired'));
  frame = renderMonitor({ ...args, nowMs: now + 60001 }); // identical board/tree: visibility itself must wake up
  assert.doesNotMatch(text(frame), /Fresh native|to accept/);
  assert.equal(frame.workboard?.snapshot.workers.length, 1);
  frame = renderMonitor({ ...args, nowMs: now + 60001, state: { ...state, tree: { ...state.tree, showAll: true } } });
  assert.match(text(frame), /Expired native/);
  frame = renderMonitor({
    ...args,
    nowMs: now + 60001,
    state: { ...state, tree: { ...state.tree, filter: 'unknown' } },
  });
  assert.match(text(frame), /Expired unknown/);
  frame = renderMonitor({ ...args, nowMs: now + 60001, state: { ...state, mainTab: 'home' } });
  assert.doesNotMatch(text(frame), /Expired native|Fresh native|Expired unknown/);
  // q18: the existing display-only reveal works on both tabs, not a new native action.
  const revealed = handleMonitorInput(frame.state, key('show-all'), { tree: data.tree, frame, nowMs: now + 60001 });
  assert.equal(revealed.action, undefined);
  assert.equal(revealed.state.tree.showAll, true);
  frame = renderMonitor({ ...args, nowMs: now + 60001, state: revealed.state });
  assert.match(text(frame), /Expired native/);
  frame = renderMonitor({ ...args, nowMs: now + 60001, state: { ...revealed.state, mainTab: 'work' } });
  assert.match(text(frame), /Expired native/);
  for (const mainTab of ['home', 'work'] as const) {
    const keep = { ...state, mainTab, tree: { ...state.tree, lingerMs: 0 } };
    assert.equal(visibleWorkboard({ ...args, state: keep }, data.board, keep, now + 60001), data.board);
    const zero = renderMonitor({ ...args, nowMs: now + 60001, state: keep });
    const unfiltered = renderMonitor({
      ...args,
      nowMs: now + 60001,
      state: { ...keep, tree: { ...keep.tree, lingerMs: undefined } },
    });
    assert.deepEqual(zero.lines, unfiltered.lines, 'zero is byte-identical to the unfiltered policy');
    assert.deepEqual(zero.controls, unfiltered.controls);
  }
});

test('P2 review: production facade output stays painted past linger while unclosed and closed history really disappears', async (t) => {
  const f = p2Fixture(t),
    a = f.association(980);
  f.dispatch(a, 'closed', { output_written: true, settled_at: new Date(f.now()).toISOString() });
  f.status(join(f.home, 'jobs', a.job), {
    state: 'closed',
    output_written: true,
    settled_at: new Date(f.now()).toISOString(),
  });
  fs.utimesSync(associationPath(f.home, a.job), new Date(f.now()), new Date(f.now()));
  f.put(join(f.home, 'jobs', a.job, 'report.md'), '# Current output');
  f.advance(1800000);
  const state = work();
  state.tree = { ...state.tree, lingerMs: 60000 };
  let data = await f.draw(state, 110);
  assert.match(data.text, /Synthetic task/);
  assert.match(data.text, /to accept/);
  assert.equal(data.frame.workboard?.snapshot.workers.length, 1);
  f.association(980, { closed: true });
  fs.utimesSync(associationPath(f.home, a.job), new Date(f.now()), new Date(f.now()));
  await f.draw(state, 110);
  f.advance(61000);
  data = await f.draw(state, 110);
  assert.doesNotMatch(data.text, /Synthetic task|to accept/);
  assert.equal(data.frame.workboard?.snapshot.workers.length, 0);
});

test('P2 q18: expiry preserves terminal human attention, admitted daily one-way decisions, and partial coverage', async (t) => {
  const f = p2Fixture(t),
    old = f.now() - 3600000,
    d = f.task('HISTORY');
  const raw = f.status(d, {
    state: 'closed',
    output_written: true,
    started_at: new Date(old - 3600000).toISOString(),
    settled_at: new Date(old).toISOString(),
  });
  f.put(join(d, 'STATUS.json'), raw, old);
  f.put(join(d, 'report.md'), '# Finished history', old);
  f.put(
    join(d, 'qa/q1.md'),
    '# Question\n\nProceed?\n\nOptions:\n- A) Wait\n- B) Proceed\n\nDefault if unanswered: A\n'
  );
  f.put(join(d, 'qa/q1.answer.md'), 'B\n\nOne-way: true\n');
  const a = f.association(983, {
    role: 'oracle',
    phase: 'propose',
    task_label: 'Human required',
    backend: {
      id: 'browser',
      executor: 'jev',
      harness: null,
      model: 'synthetic',
      effort: null,
      env_profile: null,
      recipe: null,
    },
  });
  f.jev(a, 'completed', { status: 'needs_human' }, false, {
    run: { startedAt: new Date(old - 3600000).toISOString(), endedAt: new Date(old).toISOString() },
  });
  const damaged = f.task('DAMAGED');
  f.put(join(damaged, 'STATUS.json'), '{');
  const data = await f.collect(),
    state = work();
  state.tree = { ...state.tree, lingerMs: 60000 };
  assert.equal(data.board.decisions.filter((d) => d.oneWay).length, 1);
  assert.equal(data.board.coverage.incomplete, true);
  for (const mainTab of ['home', 'work'] as const) {
    const frame = renderMonitor({
      tree: data.tree,
      workboard: data.board,
      state: { ...state, mainTab },
      width: 110,
      height: 70,
      nowMs: f.now(),
    });
    assert.equal(frame.workboard?.snapshot.workers.length, 1);
    assert.equal(frame.workboard?.snapshot.workers[0].homeNeedsHuman, true);
    assert.equal(frame.workboard?.snapshot.decisions, data.board.decisions);
    assert.equal(frame.workboard?.snapshot.coverage, data.board.coverage);
    assert.match(text(frame), /Human required/);
    assert.match(text(frame), /one-way/);
    assert.match(text(frame), /partial|coverage incomplete/);
  }
});

test('P2 review: readable current QA/default/evidence reaches compact, expanded, and source Inspector; unavailable details fall back', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  f.status(d, { state: 'waiting_orchestrator' });
  const q = join(d, 'qa/q2.md');
  f.put(q, '# Question\n\nWhich safe mode?\n\nOptions:\n- A) Keep\n- B) Remove\n\nDefault if unanswered: A\n');
  let data = await f.draw();
  const owner = data.board.workers[0];
  assert.equal(owner.work?.requestInfo?.question, 'Which safe mode?');
  assert.equal(owner.work?.requestInfo?.evidence?.relativePath, 'qa/q2.md');
  assert.match(data.text, /answer q2.*default A.*Which safe mode\?/);
  const target = { kind: 'worker' as const, laneId: owner.laneId, workerId: owner.id };
  const args = { tree: data.tree, workboard: data.board, width: 56, height: 80, nowMs: f.now() };
  let frame = renderMonitor({ ...args, state: { ...work(), workTarget: target } });
  const expanded = handleMonitorInput(frame.state, key('right'), { tree: data.tree, frame, nowMs: f.now() });
  frame = renderMonitor({ ...args, state: expanded.state });
  assert.match(text(frame), /A\) Keep/);
  assert.match(text(frame), /B\) Remove/);
  const inspected = handleMonitorInput(frame.state, key('inspect'), { tree: data.tree, frame, nowMs: f.now() });
  frame = renderMonitor({ ...args, state: inspected.state });
  assert.match(text(frame), /Which safe mode\?/);
  assert.match(text(frame), /default A/);
  assert.match(text(frame), /qa\/q2\.md/);
  assert.equal(inspected.action, undefined);
  setLanguage('zh');
  frame = renderMonitor({ ...args, state: { ...work(), workTarget: target } });
  assert.match(text(frame), /答复 q2.*默认 A/);
  setLanguage('en');
  fs.chmodSync(q, 0);
  data = await f.draw();
  assert.equal(data.board.workers[0].work?.requestInfo, undefined);
  assert.match(data.text, /Decision requested; inspect the job/);
  assert.doesNotMatch(data.text, /Which safe mode\?/);
});

for (const role of ['oracle', 'imp'] as const)
  test(`P2 review: real Jev ${role} paints recorded wait/click instead of role-derived design/build`, async (t) => {
    const f = p2Fixture(t),
      a = f.association(981, {
        role,
        phase: role === 'oracle' ? 'propose' : null,
        backend: {
          id: 'browser',
          executor: 'jev',
          harness: null,
          model: 'synthetic',
          effort: null,
          env_profile: null,
          recipe: null,
        },
      });
    const update = (phase: string, seq: number) =>
      f.jev(a, 'running', null, false, { phase, seq, run: { startedAt: new Date(f.now() - 60000).toISOString() } });
    update('wait', 1);
    let data = await f.draw();
    assert.deepEqual(data.board.workers[0].work?.phases, ['wait']);
    assert.match(data.text, /wait/);
    assert.doesNotMatch(data.text, /design|build/);
    f.advance(1000);
    update('click', 2);
    data = await f.draw();
    assert.deepEqual(data.board.workers[0].work?.phases, ['click']);
    assert.match(data.text, /click/);
    assert.doesNotMatch(data.text, /design|build/);
  });

test('P2 review: real facade multi-round history reaches existing job Inspector without removing any native/job detail or controls', async (t) => {
  const f = p2Fixture(t),
    a = f.association(982),
    d = join(f.home, 'jobs', a.job);
  f.dispatch(a, 'waiting_helper', {
    started_at: new Date(f.now() - 60000).toISOString(),
    helper_pending: { kind: 'review', n: 2, status_file: null },
  });
  for (const [n, verdict] of [
    [1, 'changes-required'],
    [2, 'accept'],
  ] as const) {
    f.put(join(d, `review-${n}.md`), `Verdict: ${verdict}\n\nSynthetic review.`);
    f.status(d, { state: 'closed', output_written: true, settled_at: new Date(f.now()).toISOString() }, `review-${n}`);
  }
  const data = await f.collect(),
    owner = data.board.workers[0];
  assert.deepEqual(owner.work?.phases, ['build', 'review r1 changes-required', 'fixing', 'review r2 accept']);
  const target = { kind: 'worker' as const, laneId: owner.laneId, workerId: owner.id };
  const args = { tree: data.tree, workboard: data.board, width: 110, height: 100, nowMs: f.now() };
  let frame = renderMonitor({ ...args, state: { ...work(), workTarget: target } });
  const inspected = handleMonitorInput(frame.state, key('inspect'), { tree: data.tree, frame, nowMs: f.now() });
  assert.equal(inspected.state.boardInspect, undefined); // existing node/job route, not a replacement Inspector
  frame = renderMonitor({ ...args, state: inspected.state });
  assert.match(text(frame), /Work state/);
  assert.match(text(frame), /changes-required/);
  assert.match(text(frame), /review r2 accept/);
  assert.match(text(frame), /waiting_helper/);
  assert.match(text(frame), /review-1\.md/);
  assert.match(text(frame), /Time basis/);
  const original = inspectorRows({ ...args, state: frame.state, workboard: undefined }, frame.state, 80, f.now());
  const integrated = inspectorRows({ ...args, state: frame.state }, frame.state, 80, f.now());
  assert.deepEqual(integrated.slice(-original.length), original);
  assert.equal(inspected.action, undefined);
});

test('P2 review: genuine native Inspector gains local Work facts and preserves its original detail/action suffix', async (t) => {
  const f = p2Fixture(t),
    node = p2Native('Genuine native', { ref: refR5() });
  const data = await f.collect([node]),
    owner = data.board.workers[0];
  const state = { ...work(), workTarget: { kind: 'worker' as const, laneId: owner.laneId, workerId: owner.id } };
  const args = { tree: data.tree, workboard: data.board, state, width: 110, height: 100, nowMs: f.now() };
  let frame = renderMonitor(args);
  const inspected = handleMonitorInput(frame.state, key('inspect'), { tree: data.tree, frame, nowMs: f.now() });
  frame = renderMonitor({ ...args, state: inspected.state });
  assert.match(text(frame), /Work state/);
  const original = inspectorRows({ ...args, workboard: undefined }, frame.state, 80, f.now());
  const integrated = inspectorRows(args, frame.state, 80, f.now());
  assert.deepEqual(integrated.slice(-original.length), original);
  assert.equal(inspected.action, undefined);
});

test('P2 review: wide lane header keeps the full distinct written title on a shared stage axis', async (t) => {
  const f = p2Fixture(t),
    d = f.task('ID'),
    other = f.task('D');
  const title = 'The complete written title must be visible at 110 columns';
  f.put(join(d, 'brief.md'), '# ' + title);
  f.status(d);
  f.status(other, { role: 'architect' });
  const data = await f.draw(work(), 110);
  const headers = data.board.lanes.map((lane) =>
    data.frame.workboard!.rows.find((row) => row.item === targetKey({ kind: 'lane', laneId: lane.id }))!
  );
  const strings = headers.map((row) => stripAnsi(row.text));
  assert.ok(strings.some((value) => value.includes('ID  ' + title)));
  assert.ok(data.frame.workboard!.rows.some((row) => /design\s+build\s+review\s+accept/.test(stripAnsi(row.text))));
  const positions = strings.map((value) => value.indexOf('▸')).sort((a, b) => a - b);
  assert.equal(positions[1] - positions[0], 7);
});
