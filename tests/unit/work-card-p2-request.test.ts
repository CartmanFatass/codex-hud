import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { p2Fixture } from '../fixtures/work-card-p2.js';
import { useDisplayFixture } from '../fixtures/display.js';
import { buildWorkboard } from '../../src/collectors/workboard.js';
import { projectWorkCard } from '../../src/collectors/work-card.js';
import { initialMonitorState, renderMonitor } from '../../src/render/monitor.js';
import { stripAnsi } from '../../src/render/colors.js';
useDisplayFixture();
const state = () => ({ ...initialMonitorState(), mainTab: 'work' as const });
const question = (which: string) =>
  `# Question\n\n${which}\n\nOptions:\n- A) Keep\n- B) Remove\n\nDefault if unanswered: A\n`;

test('P2 q19: facade helper QA requires current helper and question proof; protocol hints cannot override negative Task evidence', async (t) => {
  const f = p2Fixture(t),
    a = f.association(984),
    d = join(f.home, 'jobs', a.job),
    started = f.now() - 60000;
  f.dispatch(a, 'waiting_helper', {
    started_at: new Date(started).toISOString(),
    helper_pending: { kind: 'review', n: 1, status_file: null },
  });
  const oldHelper = { state: 'waiting_orchestrator', started_at: new Date(f.now() - 3600000).toISOString() };
  f.status(d, oldHelper, 'review-1');
  f.put(join(d, 'qa/q1.md'), question('Old helper question'), f.now() - 1800000);
  let data = await f.draw(state());
  let owner = data.board.workers[0];
  assert.equal(
    data.tree.nodes[0].job?.requests?.[0].current,
    true,
    'existing execution classification stays unchanged'
  );
  assert.equal(owner.work?.helperSignature, null);
  assert.equal(owner.work?.request, false);
  assert.equal(owner.work?.requestId, undefined);
  assert.equal(projectWorkCard(owner, f.now()).state, 'in-progress');
  assert.match(data.text, /review r1 unknown/);
  assert.doesNotMatch(data.text, /needs you|answer q1/);
  const before = owner.work?.activityAt;
  // A current/newer QName does not repair unknown helper epoch proof or its clock.
  f.status(d, { state: 'waiting_orchestrator', started_at: undefined }, 'review-1');
  f.put(join(d, 'qa/q1.md'), question('Unconfirmed helper question'));
  data = await f.draw(state());
  owner = data.board.workers[0];
  assert.equal(owner.work?.request, false);
  assert.equal(owner.work?.activityAt, before);
  assert.doesNotMatch(data.text, /needs you|answer q1/);
  // Even a current helper cannot claim a question that precedes its own start.
  f.status(d, { state: 'waiting_orchestrator', started_at: new Date(f.now() - 30000).toISOString() }, 'review-1');
  f.put(join(d, 'qa/q1.md'), question('Before this helper started'), f.now() - 45000);
  data = await f.draw(state());
  assert.equal(data.board.workers[0].work?.request, false);
  assert.doesNotMatch(data.text, /needs you|answer q1/);
  f.put(join(d, 'qa/q1.md'), question('Current helper question'));
  data = await f.draw(state());
  owner = data.board.workers[0];
  assert.equal(projectWorkCard(owner, f.now()).state, 'needs-you');
  assert.equal(owner.work?.requestId, 'q1');
  assert.match(data.text, /answer q1.*default A/);
  // Historical q2 remains protocol-current, but a written current q1 stops asking.
  f.put(join(d, 'qa/q2.md'), question('Historical unanswered question'), f.now() - 1800000);
  f.put(join(d, 'qa/q1.answer.md'), 'A');
  data = await f.draw(state());
  assert.equal(data.tree.nodes[0].job?.requests?.find((q) => q.id === 'q2')?.current, true);
  assert.equal(data.board.workers[0].work?.request, false);
  assert.doesNotMatch(data.text, /needs you|answer q[12]/);
  // Same-episode answered QA is negative evidence even while the root still
  // waits for answer consumption; historical q2 must not reintroduce an ask.
  f.status(d, {
    state: 'waiting_orchestrator',
    session_id: owner.work!.episode,
    started_at: new Date(started).toISOString(),
  });
  data = await f.draw(state());
  assert.equal(data.board.workers[0].work?.request, false);
  assert.doesNotMatch(data.text, /needs you|answer q[12]/);
  assert.equal(
    projectWorkCard(data.board.workers[0], f.now()).state,
    'in-progress',
    'known answered root pause is not observation loss'
  );
  // A primary's own new-episode wait stays authoritative even with no current QName.
  f.advance(2000);
  f.status(d, {
    state: 'waiting_orchestrator',
    session_id: 'current-root-wait',
    started_at: new Date(f.now()).toISOString(),
  });
  data = await f.draw(state());
  assert.equal(data.board.workers[0].work?.request, true);
  assert.equal(projectWorkCard(data.board.workers[0], f.now()).state, 'needs-you');
  assert.match(data.text, /Decision requested; inspect the job/);
});

test('P2 q21: live answered root pause uses answer time; stale freshness, threshold and old-episode answers do not fake progress', async (t) => {
  let live = true;
  const f = p2Fixture(t, () => live),
    a = f.association(987),
    d = join(f.home, 'jobs', a.job);
  f.dispatch(a, 'waiting_orchestrator', { started_at: new Date(f.now() - 60000).toISOString() });
  f.put(join(d, 'qa/q1.md'), question('Current root question'), f.now() - 1000);
  let data = await f.draw(state());
  assert.equal(projectWorkCard(data.board.workers[0], f.now()).state, 'needs-you');
  f.put(join(d, 'qa/q1.answer.md'), 'A');
  const answerAt = f.now();
  data = await f.draw(state());
  let owner = data.board.workers[0];
  assert.equal(data.tree.nodes[0].job?.status, 'unknown', 'shared execution status remains untouched');
  assert.equal(data.tree.nodes[0].job?.freshness.state, 'current');
  assert.equal(owner.work?.answeredRequestAt, answerAt);
  assert.equal(owner.work?.activityAt, answerAt);
  assert.equal(owner.stale, false);
  assert.equal(projectWorkCard(owner, f.now()).state, 'in-progress');
  assert.match(data.text, /working/);
  f.advance(599999);
  data = await f.draw(state());
  assert.equal(projectWorkCard(data.board.workers[0], f.now()).state, 'in-progress');
  f.advance(1);
  data = await f.draw(state());
  assert.equal(projectWorkCard(data.board.workers[0], f.now()).state, 'stalled');
  // Fresh answer, then lose ONLY live corroboration while its age is under10min.
  f.put(join(d, 'qa/q1.answer.md'), 'B');
  data = await f.draw(state());
  assert.equal(projectWorkCard(data.board.workers[0], f.now()).state, 'in-progress');
  live = false;
  f.advance(16000);
  data = await f.draw(state());
  owner = data.board.workers[0];
  assert.notEqual(data.tree.nodes[0].job?.freshness.state, 'current');
  assert.equal(owner.stale, true);
  assert.equal(projectWorkCard(owner, f.now()).state, 'stalled');
  // An old written answer never grants the new primary this exception.
  live = true;
  f.advance(5000); // allow the real sampler's five-second cadence to corroborate recovery
  f.status(d, {
    state: 'waiting_orchestrator',
    session_id: 'new-episode',
    started_at: new Date(f.now()).toISOString(),
  });
  data = await f.draw(state());
  owner = data.board.workers[0];
  assert.equal(data.tree.nodes[0].job?.freshness.state, 'current');
  assert.equal(owner.work?.answeredRequestAt, undefined);
  assert.equal(
    projectWorkCard(owner, f.now()).state,
    'needs-you',
    'new primary root wait remains authoritative, old answer does not count'
  );
});

test('P2 q20: losing/regaining helper and QA proof never revives stalled work; primary and helper transitions date separately', async (t) => {
  const f = p2Fixture(t),
    d = f.task('proof-loss'),
    primaryStart = f.now() - 1200000,
    helperStart = f.now() - 1080000;
  const waiting = {
    state: 'waiting_helper',
    started_at: new Date(primaryStart).toISOString(),
    helper_pending: { kind: 'review', n: 1, status_file: null },
  };
  f.status(d, waiting);
  f.status(d, { state: 'working', started_at: new Date(helperStart).toISOString() }, 'review-1');
  f.put(join(d, 'qa/q1.md'), question('Previously admitted helper QA'), f.now() - 1020000);
  f.put(join(d, 'qa/q1.answer.md'), 'A', f.now() - 960000);
  let data = await f.draw(state()),
    owner = data.board.workers[0];
  const admitted = owner.work?.activityAt;
  assert.equal(admitted, f.now() - 960000);
  assert.equal(projectWorkCard(owner, f.now()).state, 'stalled');
  f.advance(10000);
  f.status(d, { state: 'working', started_at: undefined }, 'review-1');
  data = await f.draw(state());
  owner = data.board.workers[0];
  assert.equal(owner.work?.helperSignature, null);
  assert.equal(owner.work?.activityAt, admitted);
  assert.equal(projectWorkCard(owner, f.now()).state, 'stalled');
  assert.match(data.text, /review r1 unknown/);
  // Identical QA touches while proof is absent do not become new activity on recovery.
  f.put(join(d, 'qa/q1.md'), question('Previously admitted helper QA'));
  f.put(join(d, 'qa/q1.answer.md'), 'A');
  await f.collect();
  f.advance(10000);
  f.status(d, { state: 'working', started_at: new Date(helperStart).toISOString() }, 'review-1');
  data = await f.draw(state());
  owner = data.board.workers[0];
  assert.equal(owner.work?.activityAt, admitted);
  assert.equal(projectWorkCard(owner, f.now()).state, 'stalled');
  assert.doesNotMatch(data.text, /review r1 unknown/);
  f.advance(30000);
  f.status(d, { state: 'working', started_at: new Date(primaryStart).toISOString() });
  data = await f.draw(state());
  owner = data.board.workers[0];
  const primaryTransition = f.now();
  assert.equal(owner.work?.activityAt, primaryTransition);
  assert.equal(projectWorkCard(owner, f.now()).state, 'in-progress');
  assert.ok(owner.work?.producerSignature);
  assert.ok(!data.text.includes(owner.work!.producerSignature!), 'internal key is never rendered');
  // Same semantic primary key ignores fresh heartbeats/model/counters.
  f.advance(10000);
  f.status(d, {
    state: 'working',
    started_at: new Date(primaryStart).toISOString(),
    updated_at: new Date(f.now()).toISOString(),
    model: 'other',
    counters: { qa: 99 },
  });
  data = await f.draw(state());
  assert.equal(data.board.workers[0].work?.activityAt, primaryTransition);
  f.advance(30000);
  f.status(d, waiting);
  await f.collect();
  f.advance(45000);
  f.status(d, { state: 'waiting_orchestrator', started_at: new Date(helperStart).toISOString() }, 'review-1');
  data = await f.draw(state());
  assert.equal(
    data.board.workers[0].work?.activityAt,
    f.now(),
    'admitted helper semantic transition uses helper file time, not older primary file'
  );
});

test('P2 q19: dispatch without Task evidence never infers helper QA, but primary wait and direct-Pi protocol remain authoritative', async (t) => {
  const f = p2Fixture(t),
    a = f.association(985),
    d = join(f.home, 'jobs', a.job);
  f.dispatch(a, 'waiting_helper', {
    started_at: new Date(f.now() - 60000).toISOString(),
    helper_pending: { kind: 'review', n: 1, status_file: null },
  });
  f.status(d, { state: 'waiting_orchestrator', started_at: new Date(f.now() - 3600000).toISOString() }, 'review-1');
  f.put(join(d, 'qa/q1.md'), question('Historical helper question'), f.now() - 1800000);
  let data = await f.collect();
  const observer = f.observer();
  const read = async () => {
    let snapshot = await observer.refresh();
    await observer.live.settled();
    for (let i = 0; i < 40; i++) snapshot = await observer.refresh();
    return snapshot;
  };
  const withoutTask = async () =>
    buildWorkboard(
      f.home,
      { revision: 0, lanes: [], coverage: data.board.coverage, cost: data.cost },
      await read(),
      data.tree
    );
  // Real collector DTOs, deliberately absent Task evidence: exercise the actual merge fallback.
  let board = await withoutTask();
  assert.equal(board.workers[0].work?.request, false);
  let frame = renderMonitor({
    tree: data.tree,
    workboard: board,
    state: state(),
    width: 56,
    height: 40,
    nowMs: f.now(),
  });
  assert.doesNotMatch(frame.lines.map(stripAnsi).join('\n'), /needs you|answer q1/);
  f.status(d, { state: 'waiting_orchestrator', started_at: new Date(f.now() - 60000).toISOString() });
  data = await f.collect();
  board = await withoutTask();
  assert.equal(board.workers[0].work?.request, true, 'explicit primary wait does not depend on Task scan availability');
  frame = renderMonitor({ tree: data.tree, workboard: board, state: state(), width: 56, height: 40, nowMs: f.now() });
  assert.match(frame.lines.map(stripAnsi).join('\n'), /needs you/);
  const direct = f.association(986);
  f.receipt(direct); // direct-Pi, no dispatch status or episode protocol
  f.put(join(f.home, 'jobs', direct.job, 'qa/q1.md'), question('Direct-Pi question'));
  data = await f.draw(state());
  const directJob = data.tree.nodes.find((n) => n.job?.jobId === direct.job)?.job;
  assert.ok(directJob);
  const directOwner = data.board.workers.find((w) => w.id === directJob.id);
  assert.ok(directOwner);
  assert.equal(directOwner.work?.request, true);
  const directFrame = renderMonitor({
    tree: data.tree,
    workboard: data.board,
    state: state(),
    width: 56,
    height: 40,
    nowMs: f.now(),
  });
  assert.match(directFrame.lines.map(stripAnsi).join('\n'), /answer q1/);
});

test('P2 q24: a replacement primary and current helper can rewrite an identical question; physical proof is not content novelty', async (t) => {
  const f = p2Fixture(t),
    a = f.association(990),
    d = join(f.home, 'jobs', a.job),
    q = join(d, 'qa/q1.md'),
    body = question('Repeated helper question');
  f.dispatch(a, 'waiting_helper', {
    started_at: new Date(f.now() - 60000).toISOString(),
    helper_pending: { kind: 'review', n: 1, status_file: null },
  });
  f.status(d, { state: 'waiting_orchestrator', started_at: new Date(f.now() - 30000).toISOString() }, 'review-1');
  f.put(q, body);
  let data = await f.draw(state());
  assert.equal(projectWorkCard(data.board.workers[0], f.now()).state, 'needs-you');
  f.advance(180000);
  const helper = {
    state: 'waiting_orchestrator',
    session_id: 'replacement-helper',
    started_at: new Date(f.now() - 1000).toISOString(),
  };
  f.status(d, {
    state: 'waiting_helper',
    session_id: 'replacement-primary',
    started_at: new Date(f.now() - 60000).toISOString(),
    helper_pending: { kind: 'review', n: 1, status_file: null },
  });
  f.status(d, helper, 'review-1');
  f.put(q, body);
  data = await f.draw(state());
  let owner = data.board.workers[0];
  assert.equal(data.tree.nodes[0].job?.requests?.[0].current, true, 'shared protocol remains current');
  assert.equal(data.tree.nodes[0].job?.requests?.[0].respondable, true);
  assert.match(owner.work?.helperSignature ?? '', /replacement-helper/);
  assert.equal(owner.work?.request, true);
  assert.equal(owner.work?.requestId, 'q1');
  assert.equal(owner.work?.requestInfo?.evidence?.at, f.now(), 'current proof dates the physical question');
  assert.equal(projectWorkCard(owner, f.now()).state, 'needs-you');
  assert.match(data.text, /answer q1.*default A/);
  assert.doesNotMatch(data.text, /review r1 unknown/);
  const admitted = owner.work?.activityAt;
  f.advance(2000);
  f.put(q, body);
  data = await f.draw(state());
  assert.equal(data.board.workers[0].work?.activityAt, admitted, 'identical current touch is not activity');
  f.status(d, { ...helper, started_at: undefined }, 'review-1');
  f.advance(2000);
  f.put(q, body);
  data = await f.draw(state());
  assert.equal(data.board.workers[0].work?.request, false, 'physical QA never repairs unknown helper proof');
  assert.equal(data.board.workers[0].work?.activityAt, admitted);
  assert.doesNotMatch(data.text, /answer q1/);
  f.status(d, helper, 'review-1');
  data = await f.draw(state());
  owner = data.board.workers[0];
  assert.equal(owner.work?.request, true);
  assert.equal(owner.work?.activityAt, admitted, 'proof recovery cannot borrow the latest physical touch');
  assert.equal(projectWorkCard(owner, f.now()).state, 'needs-you');
});

test('P2 q24: replacement root identical question and answer stop asking; new-episode answer anchor survives touches and proof loss', async (t) => {
  const f = p2Fixture(t),
    a = f.association(991),
    d = join(f.home, 'jobs', a.job),
    q = join(d, 'qa/q1.md'),
    answer = join(d, 'qa/q1.answer.md'),
    body = question('Repeated root question');
  f.dispatch(a, 'waiting_orchestrator', { started_at: new Date(f.now() - 60000).toISOString() });
  f.put(q, body);
  f.put(answer, 'A');
  let data = await f.draw(state());
  assert.equal(projectWorkCard(data.board.workers[0], f.now()).state, 'in-progress');
  const oldAnswer = data.board.workers[0].work?.answeredRequestAt;
  f.advance(180000);
  f.status(d, {
    state: 'waiting_orchestrator',
    session_id: 'replacement-root',
    started_at: new Date(f.now() - 60000).toISOString(),
  });
  f.put(q, body);
  f.put(answer, 'A');
  const answered = f.now();
  data = await f.draw(state());
  let owner = data.board.workers[0];
  assert.equal(data.tree.nodes[0].job?.requests?.[0].state, 'written_consumption_unconfirmed');
  assert.equal(owner.work?.request, false);
  assert.equal(owner.work?.answeredRequestAt, answered);
  assert.notEqual(owner.work?.answeredRequestAt, oldAnswer);
  assert.equal(owner.work?.activityAt, answered);
  assert.equal(owner.stale, false);
  assert.equal(projectWorkCard(owner, f.now()).state, 'in-progress');
  assert.doesNotMatch(data.text, /needs you|Decision requested/);
  f.advance(5000);
  f.put(q, body);
  f.put(answer, 'A');
  data = await f.draw(state());
  assert.equal(data.board.workers[0].work?.answeredRequestAt, answered);
  assert.equal(data.board.workers[0].work?.activityAt, answered, 'same-episode identical paired touch is not progress');
  unlinkSync(q);
  unlinkSync(answer);
  data = await f.draw(state());
  assert.equal(data.board.workers[0].work?.answeredRequestAt, undefined);
  assert.equal(data.board.workers[0].work?.activityAt, answered, 'lost question proof is not activity');
  f.advance(5000);
  f.put(q, body);
  f.put(answer, 'A');
  data = await f.draw(state());
  assert.equal(data.board.workers[0].work?.answeredRequestAt, answered);
  assert.equal(data.board.workers[0].work?.activityAt, answered, 'restored identical files retain the anchor');
  f.advance(589999);
  data = await f.draw(state());
  assert.equal(projectWorkCard(data.board.workers[0], f.now()).state, 'in-progress');
  f.advance(1);
  data = await f.draw(state());
  assert.equal(
    projectWorkCard(data.board.workers[0], f.now()).state,
    'stalled',
    'identical proof cannot extend the ten-minute clock'
  );
  f.put(answer, 'B');
  data = await f.draw(state());
  const changed = f.now();
  assert.equal(data.board.workers[0].work?.answeredRequestAt, changed);
  assert.equal(projectWorkCard(data.board.workers[0], f.now()).state, 'in-progress', 'real changed answer counts once');
  f.advance(5000);
  f.put(q, body);
  data = await f.draw(state());
  assert.equal(
    data.board.workers[0].work?.request,
    true,
    'physical answer preceding current physical question is incoherent'
  );
  assert.equal(data.board.workers[0].work?.answeredRequestAt, undefined);
  f.put(answer, 'B');
  data = await f.draw(state());
  assert.equal(data.board.workers[0].work?.request, false);
  assert.equal(
    data.board.workers[0].work?.answeredRequestAt,
    changed,
    'coherent identical recovery does not redate content activity'
  );
});
