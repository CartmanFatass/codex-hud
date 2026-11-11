import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { p2Fixture, p2Native } from '../fixtures/work-card-p2.js';
import { FIXED_R5_NOW } from '../fixtures/r5-jobs.js';
import { projectWorkCard } from '../../src/collectors/work-card.js';
import { targetKey } from '../../src/collectors/workboard-types.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../src/render/monitor.js';
import { renderWorkCard, workCardCost, workCardName } from '../../src/render/work-card.js';
import { laneRows } from '../../src/render/work-lanes.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { setDisplayConfig, LOOKS } from '../../src/render/hud-config.js';
import { setLanguage } from '../../src/render/i18n.js';
import { defaultSettings, loadSettings, saveSettings, settingsPath } from '../../src/settings.js';
import { SETTING_ROWS } from '../../src/render/settings-page.js';
import { isExpired, initialPanelState } from '../../src/render/panel-state.js';
import { useDisplayFixture } from '../fixtures/display.js';
useDisplayFixture();
const key = (key: string) => ({ type: 'key' as const, key });
const card = (data: Awaited<ReturnType<ReturnType<typeof p2Fixture>['collect']>>, now: number, index = 0) =>
  projectWorkCard(data.board.workers[index], now);

test('P2 real producer precedence: active, waiting current QA, failure stays Work but never Home needs-you, and stale', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  f.status(d);
  let data = await f.draw();
  assert.equal(card(data, f.now()).state, 'in-progress');
  assert.match(data.text, /working/);
  f.put(
    join(d, 'qa/q1.md'),
    '# Question\n\nOptions:\n- A) Keep\n- B) Remove\n\nDefault if unanswered: A\n',
    FIXED_R5_NOW - 120_000
  );
  f.status(d, { state: 'waiting_orchestrator' });
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'needs-you');
  assert.equal(data.board.workers.filter((w) => w.homeNeedsHuman).length, 0);
  assert.match(data.text, /needs you/);
  f.status(d, { state: 'failed', error: 'synthetic failure' });
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'needs-you');
  assert.equal(data.board.workers.filter((w) => w.homeNeedsHuman).length, 0);
  assert.equal(data.board.decisions.length, 0);
  f.status(d);
  await f.draw();
  f.put(join(d, 'STATUS.json'), '{');
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'stalled');
  assert.equal(data.board.workers.filter((w) => w.homeNeedsHuman).length, 0);
  assert.match(data.text, /stalled/);
});

test('P2 failed facade output remains visible on Work, never a Home human-needed item', async (t) => {
  const f = p2Fixture(t),
    a = f.association(901);
  f.dispatch(a, 'failed', { error: 'synthetic worker failure', started_at: new Date(f.now() - 60000).toISOString() });
  const data = await f.draw();
  assert.equal(card(data, f.now()).state, 'needs-you');
  assert.match(data.text, /Work failed/);
  const home = renderMonitor({
    tree: data.tree,
    workboard: data.board,
    state: work({ mainTab: 'home' }),
    width: 56,
    height: 32,
    nowMs: f.now(),
  });
  assert.match(home.lines.map(stripAnsi).join('\n'), /nothing needs you/);
  assert.equal(data.board.workers[0].homeNeedsHuman, false);
});

test('P2 current unanswered QA outranks working; historic QA and a written answer do not request another answer, and per-worker observation loss stalls', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  f.status(d);
  const question = '# Question\n\nWhich boundary?\n\nOptions:\n- A) Keep\n- B) Remove\n\nDefault if unanswered: A\n';
  f.put(join(d, 'qa/q1.md'), question, f.now() - 120000);
  let data = await f.draw();
  assert.equal(card(data, f.now()).state, 'in-progress');
  f.put(join(d, 'qa/q2.md'), question);
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'needs-you');
  assert.match(data.text, /answer q2/);
  f.put(join(d, 'qa/q2.answer.md'), 'A');
  f.status(d, { state: 'waiting_orchestrator' });
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'in-progress');
  assert.doesNotMatch(data.text, /needs you/);
  fs.chmodSync(join(d, 'STATUS.json'), 0);
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'stalled');
  assert.match(data.text, /Observation unavailable/);
});

test('P2 exact native enrichment preserves only its existing sentence grant; right arrow reveals full native detail and direct text remains ungranted', async (t) => {
  const f = p2Fixture(t),
    ref = { harness: 'pi' as const, sourceId: 'a'.repeat(64), sessionId: 'native-allowed', threadId: null };
  const native = p2Native('native-owner', { ref });
  const a = f.association(902, { native: ref });
  f.dispatch(a, 'working', { started_at: new Date(f.now() - 60000).toISOString() });
  const pure = f.association(903, { task_label: 'Facade-only invocation' });
  f.dispatch(pure, 'working', { started_at: new Date(f.now() - 60000).toISOString() });
  f.put(join(f.home, 'jobs', a.job, 'report.md'), 'UNGRANTED_PRIMARY_REPORT');
  const data = await f.collect([native]);
  const enriched = data.board.workers.find((w) => w.nodeId === native.id)!;
  assert.ok(enriched);
  const bare = data.tree.nodes.find((n) => n.job?.jobId === pure.job)!;
  const logs = new Map([
    [
      native.id,
      [
        {
          at: f.now(),
          kind: 'note' as const,
          text: 'Allowed native sentence. Expanded native detail ends with NATIVE_DETAIL_END.',
        },
      ],
    ],
    [bare.id, [{ at: f.now(), kind: 'note' as const, text: 'UNGRANTED_FACADE_SENTENCE.' }]],
  ]);
  const target = { kind: 'worker' as const, laneId: enriched.laneId, workerId: enriched.id };
  const args = { tree: data.tree, workboard: data.board, agentLog: logs, width: 56, height: 60, nowMs: f.now() };
  const closed = renderMonitor({ ...args, state: work({ workTarget: target }) });
  const text = closed.lines.map(stripAnsi).join('\n');
  assert.match(text, /Allowed native sentence/);
  assert.doesNotMatch(text, /UNGRANTED_|NATIVE_DETAIL_END/);
  assert.equal((text.match(/›/g) ?? []).length, 1, 'selected card is painted with one cursor, not one in each layer');
  const opened = handleMonitorInput(closed.state, key('right'), { tree: data.tree, frame: closed, nowMs: f.now() });
  assert.equal(opened.action, undefined);
  assert.ok(opened.state.boardExpanded?.has(targetKey(target)));
  const expanded = renderMonitor({ ...args, state: opened.state });
  assert.match(expanded.lines.map(stripAnsi).join('\n'), /NATIVE_DETAIL_END/);
  const collapsed = handleMonitorInput(expanded.state, key('left'), {
    tree: data.tree,
    frame: expanded,
    nowMs: f.now(),
  });
  assert.ok(!collapsed.state.boardExpanded?.has(targetKey(target)));
});

test('P2 exact ten-minute threshold and meaningful progress ignore heartbeat, model, counters and identical artifact touch', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  const start = FIXED_R5_NOW;
  const base = { started_at: new Date(start).toISOString() };
  f.status(d, base);
  let data = await f.draw();
  assert.equal(card(data, f.now()).inactivityMinutes, 0);
  f.advance(599_000);
  f.status(d, {
    ...base,
    updated_at: new Date(f.now()).toISOString(),
    model: 'changed-model',
    thinking: 'max',
    tokens: 9999,
  });
  data = await f.draw(work({ cardVisibility: { ...defaultSettings(), cardClock: false } }));
  assert.equal(card(data, f.now()).state, 'in-progress');
  assert.equal(card(data, f.now()).inactivityMinutes, 9);
  f.advance(1000);
  data = await f.draw(work({ cardVisibility: { ...defaultSettings(), cardClock: false } }));
  assert.equal(card(data, f.now()).state, 'stalled');
  assert.match(data.text, /stalled/);
  f.put(join(d, 'report.md'), '# Synthetic progress\nA meaningful primary revision.');
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'in-progress');
  const activity = data.board.workers[0].work!.activityAt;
  f.advance(600_000);
  fs.utimesSync(join(d, 'report.md'), new Date(f.now()), new Date(f.now()));
  data = await f.draw();
  assert.equal(data.board.workers[0].work!.activityAt, activity);
  assert.equal(card(data, f.now()).state, 'stalled');
  f.put(join(d, 'report.md'), '# Synthetic progress\nSecond meaningful primary revision.');
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'in-progress');
});

test('P2 cached hidden-clock cards cross a producer-relative ten-minute edge within the same wall minute', async (t) => {
  const f = p2Fixture(t),
    d = f.task(),
    start = f.now() - 60000 + 30137;
  f.status(d, { started_at: new Date(start).toISOString() });
  const data = await f.collect(),
    args = { tree: data.tree, workboard: data.board, width: 56, height: 20 };
  const beforeAt = start + 599000,
    afterAt = start + 600000;
  assert.equal(Math.floor(beforeAt / 60000), Math.floor(afterAt / 60000));
  let before = renderMonitor({
    ...args,
    state: work({ cardVisibility: { ...work().cardVisibility, cardClock: false } }),
    nowMs: beforeAt,
  });
  before = renderMonitor({ ...args, state: before.state, nowMs: beforeAt });
  assert.match(before.lines.map(stripAnsi).join('\n'), /working/);
  const after = renderMonitor({ ...args, state: before.state, nowMs: afterAt });
  const text = after.lines.map(stripAnsi).join('\n');
  assert.match(text, /stalled/);
  assert.doesNotMatch(text, /working/);
});

test('P2 restart retains producer elapsed/inactivity and unknown starts stay unknown rather than counting refresh as activity', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  f.status(d, { started_at: '2026-11-09T11:30:00Z', updated_at: new Date(f.now()).toISOString() });
  let data = await f.draw();
  assert.equal(card(data, f.now()).state, 'stalled');
  assert.equal(card(data, f.now()).elapsedMinutes, 30);
  f.pipeline.dispose();
  // A new real collector has no memory to turn a heartbeat into progress.
  const { PanelJobPipeline } = await import('../../src/tree-page.js');
  const pipeline = new PanelJobPipeline(f.home, 'synthetic/main', { live: false, now: f.now }, f.workspace);
  t.after(() => pipeline.dispose());
  for (let n = 0; n < 40; n++) await pipeline.refresh();
  const composition = pipeline.compose(f.emptyTree(), null, f.now());
  const board = pipeline.workboard(composition.tree, composition.legacy);
  assert.equal(projectWorkCard(board.workers[0], f.now()).inactivityMinutes, 30);
  const g = p2Fixture(t),
    unknown = g.task();
  g.status(unknown, { started_at: null });
  data = await g.draw();
  assert.equal(card(data, g.now()).state, 'stalled');
  assert.equal(card(data, g.now()).elapsedMinutes, null);
  assert.equal(card(data, g.now()).inactivityMinutes, null);
  const native = p2Native('New native turn', {
    startedAt: new Date(g.now() - 3600000),
    turnStartedAt: new Date(g.now() - 1000),
    lastEventAt: new Date(g.now() - 3600000),
  });
  data = await g.draw(work(), 56, 40, [native]);
  const nativeCard = projectWorkCard(
    data.board.workers.find((w) => w.id === native.id)!,
    g.now()
  );
  assert.equal(nativeCard.state, 'in-progress');
  assert.equal(nativeCard.elapsedMinutes, 0);
  assert.match(data.text, /New native turn.*working/);
});

test('P2 review evidence is exact, matching, settled and written; CR fixing requires resumed primary and latest round survives compacting', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  f.status(d, { state: 'waiting_helper', helper_pending: { kind: 'review', n: 1, status_file: null } });
  f.put(join(d, 'review-1.md'), 'Verdict: changes-required\n\nSynthetic review.');
  let data = await f.draw();
  assert.deepEqual(card(data, f.now()).phases, ['build', 'review r1 unknown']);
  f.status(d, { state: 'working' }, 'review-1');
  data = await f.draw();
  assert.ok(!card(data, f.now()).phases.includes('fixing'));
  const settled = { state: 'idle_grace', output_written: true, settled_at: new Date(f.now()).toISOString() };
  f.status(d, settled, 'review-1');
  data = await f.draw();
  assert.deepEqual(card(data, f.now()).phases, ['build', 'review r1 changes-required']);
  f.status(d);
  data = await f.draw();
  assert.deepEqual(card(data, f.now()).phases, ['build', 'review r1 changes-required', 'fixing']);
  assert.match(data.text, /fixing/);
  f.status(d, { state: 'waiting_helper', helper_pending: { kind: 'review', n: 2, status_file: null } });
  f.put(join(d, 'review-2.md'), '# Review\nVerdict: accept\n');
  f.status(d, settled, 'review-2');
  data = await f.draw();
  assert.ok(!card(data, f.now()).phases.some((p) => p === 'review r2 accept'));
  f.put(join(d, 'review-2.md'), 'Verdict: accept\n\nSynthetic review.');
  data = await f.draw();
  assert.ok(card(data, f.now()).phases.includes('review r2 accept'));
  const lines = renderWorkCard(card(data, f.now()), work(), 44);
  assert.equal(lines.length, 2);
  assert.match(lines.map(stripAnsi).join('\n'), /review r2 accept/);
  f.status(d, { session_id: 'replacement-primary', started_at: new Date(f.now() + 1).toISOString() });
  data = await f.draw();
  assert.deepEqual(card(data, f.now()).phases, ['build']);
});

test('P2 mismatched review slot, session start and missing expected output cannot create acceptance; chores never review', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  f.status(d, { state: 'waiting_helper', helper_pending: { kind: 'review', n: 2, status_file: null } });
  f.put(join(d, 'review-2.md'), 'Verdict: accept\n');
  f.status(
    d,
    { slot: 'review-1', state: 'closed', output_written: true, settled_at: new Date(f.now()).toISOString() },
    'review-2'
  );
  let data = await f.draw();
  assert.ok(!card(data, f.now()).phases.includes('review r2 accept'));
  f.status(d, { state: 'closed', output_written: false, settled_at: new Date(f.now()).toISOString() }, 'review-2');
  data = await f.draw();
  assert.ok(!card(data, f.now()).phases.includes('review r2 accept'));
  f.status(
    d,
    {
      state: 'closed',
      output_written: true,
      started_at: new Date(f.now() + 1).toISOString(),
      settled_at: new Date(f.now()).toISOString(),
    },
    'review-2'
  );
  data = await f.draw();
  assert.ok(!card(data, f.now()).phases.includes('review r2 accept'));
  f.status(d, { state: 'waiting_helper', helper_pending: { kind: 'sonic', n: 1, status_file: null } });
  f.status(d, { state: 'closed', output_written: true, settled_at: new Date(f.now()).toISOString() }, 'sonic-1');
  f.put(join(d, 'sonic-1.md'), 'Verdict: accept\nSecret helper prose never becomes card text.');
  data = await f.draw();
  assert.deepEqual(card(data, f.now()).phases, ['build', 'chores']);
  assert.doesNotMatch(data.text, /Secret helper|to accept/);
  const chores = f.task('Primary-chores');
  f.status(chores, { role: 'sonic' });
  data = await f.draw();
  assert.deepEqual(
    projectWorkCard(
      data.board.workers.find((w) => w.role === 'sonic')!,
      f.now()
    ).phases,
    ['chores']
  );
});

test('P2 facade output stays to-accept through pi auto-close and linger; only facade closure makes done, then closed history expires', async (t) => {
  const f = p2Fixture(t),
    a = f.association(301);
  f.dispatch(a, 'idle_grace', { output_written: true, settled_at: '2026-11-09T11:59:00Z' });
  f.put(join(f.home, 'jobs', a.job, 'report.md'), '# Primary report\n');
  let data = await f.draw();
  assert.equal(card(data, f.now()).state, 'awaiting-acceptance');
  f.status(join(f.home, 'jobs', a.job), { state: 'closed', output_written: true, settled_at: '2026-11-09T11:59:00Z' });
  f.advance(30 * 60_000);
  data = await f.draw(work({ tree: { ...initialMonitorState().tree, lingerMs: 60_000 } }));
  assert.equal(card(data, f.now()).state, 'awaiting-acceptance');
  const node = data.tree.nodes[0];
  assert.equal(isExpired(node, { ...initialPanelState(), lingerMs: 60_000 }, f.now()), false);
  f.association(301, { closed: true });
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'done');
  f.advance(61_000);
  data = await f.draw();
  assert.equal(isExpired(data.tree.nodes[0], { ...initialPanelState(), lingerMs: 60_000 }, f.now()), true);
  const native = p2Native('finished-native', { status: 'completed', statusAt: new Date(FIXED_R5_NOW) });
  assert.equal(isExpired(native, { ...initialPanelState(), lingerMs: 60_000 }, f.now()), true);
});

test('P2 unconfirmed continuation does not reuse an old completed result or round; same-label invocation never joins a task lane', async (t) => {
  const f = p2Fixture(t),
    a = f.association(302);
  const receipt = f.dispatch(a, 'idle_grace', { output_written: true, settled_at: '2026-11-09T11:59:00Z' });
  f.put(join(f.home, 'jobs', a.job, 'report.md'), '# Prior output');
  await f.draw();
  f.receipt(a, {
    pi_dispatch: {
      ...receipt.pi_dispatch!,
      continuation: {
        previous_session_id: 'synthetic-primary',
        previous_settled_at: '2026-11-09T11:59:00Z',
        message_key: 'synthetic-continuation',
      },
    },
  });
  const d = f.task(a.task_label!);
  f.status(d);
  let data = await f.draw();
  const invocation = data.board.lanes.find((l) => l.identity.kind === 'invocation')!;
  assert.equal(invocation.workers[0].work?.result, false);
  assert.notEqual(projectWorkCard(invocation.workers[0], f.now()).state, 'awaiting-acceptance');
  assert.equal(data.board.lanes.length, 2);
  f.status(join(f.home, 'jobs', a.job), {
    session_id: 'synthetic-primary',
    state: 'working',
    settled_at: null,
    output_written: false,
  });
  data = await f.draw();
  assert.equal(data.board.lanes.find((l) => l.identity.kind === 'invocation')!.workers[0].work?.result, false);
});

test('P2 a replacement episode cannot reuse an old primary output or impossible settle time; execution status remains the producer status', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  f.status(d);
  f.put(join(d, 'report.md'), '# Previous episode output', f.now() - 120000);
  await f.draw();
  const replacement = {
    session_id: 'replacement-primary',
    started_at: new Date(f.now()).toISOString(),
    state: 'idle_grace',
    output_written: true,
    settled_at: new Date(f.now()).toISOString(),
  };
  f.status(d, replacement);
  let data = await f.draw();
  assert.equal(card(data, f.now()).state, 'needs-you');
  assert.match(data.text, /Work failed/);
  f.put(join(d, 'report.md'), '# Current episode output');
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'awaiting-acceptance');
  const a = f.association(904);
  f.dispatch(a, 'idle_grace', replacement);
  f.put(join(f.home, 'jobs', a.job, 'report.md'), '# Old invocation output', f.now() - 120000);
  data = await f.draw();
  let worker = data.board.lanes.find((l) => l.identity.kind === 'invocation')!.workers[0];
  assert.equal(projectWorkCard(worker, f.now()).state, 'needs-you');
  assert.equal(
    data.tree.nodes.find((n) => n.job?.jobId === a.job)!.job!.status,
    'completed',
    'P2 never rewrites execution status to implement a display fallback'
  );
  f.put(join(f.home, 'jobs', a.job, 'report.md'), '# Current invocation output');
  data = await f.draw();
  worker = data.board.lanes.find((l) => l.identity.kind === 'invocation')!.workers[0];
  assert.equal(projectWorkCard(worker, f.now()).state, 'awaiting-acceptance');
  f.status(join(f.home, 'jobs', a.job), { ...replacement, settled_at: new Date(f.now() - 60000).toISOString() });
  data = await f.draw();
  worker = data.board.lanes.find((l) => l.identity.kind === 'invocation')!.workers[0];
  assert.equal(projectWorkCard(worker, f.now()).state, 'needs-you');
});

test('P2 same-session continuation hides old clock/phases/counts; a producer start above its floor restores elapsed and admitted facade helper failure wins', async (t) => {
  const f = p2Fixture(t),
    a = f.association(905),
    floor = f.now() - 60000,
    oldStart = f.now() - 10 * 60000;
  const receipt = f.dispatch(a, 'idle_grace', {
    started_at: new Date(oldStart).toISOString(),
    output_written: true,
    settled_at: new Date(floor).toISOString(),
  });
  f.put(
    join(f.home, 'jobs', a.job, 'report.md'),
    '# Old result\n# tests 777\n# suites 0\n# pass 777\n# fail 0\n',
    floor
  );
  await f.draw();
  f.receipt(a, {
    pi_dispatch: {
      ...receipt.pi_dispatch!,
      continuation: {
        previous_session_id: 'synthetic-primary',
        previous_settled_at: new Date(floor).toISOString(),
        message_key: 'same-session-continuation',
      },
    },
  });
  f.status(join(f.home, 'jobs', a.job), { state: 'working', started_at: new Date(oldStart).toISOString() });
  f.advance(120000);
  let data = await f.draw(),
    projected = card(data, f.now());
  assert.equal(projected.elapsedMinutes, null);
  assert.equal(projected.inactivityMinutes, null);
  assert.deepEqual(projected.phases, []);
  assert.doesNotMatch(data.text, /777|reported|build|review/);
  const started = floor + 30000;
  f.status(join(f.home, 'jobs', a.job), { state: 'working', started_at: new Date(started).toISOString() });
  data = await f.draw();
  projected = card(data, f.now());
  assert.equal(projected.elapsedMinutes, Math.floor((f.now() - started) / 60000));
  assert.equal(projected.state, 'in-progress');
  assert.deepEqual(projected.phases, ['build']);
  assert.doesNotMatch(data.text, /777/);
  f.status(join(f.home, 'jobs', a.job), {
    state: 'waiting_helper',
    started_at: new Date(started).toISOString(),
    helper_pending: { kind: 'review', n: 1, status_file: null },
  });
  f.status(
    join(f.home, 'jobs', a.job),
    { state: 'failed', error: 'Synthetic helper failure', started_at: new Date(started).toISOString() },
    'review-1'
  );
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'needs-you');
  assert.match(data.text, /Work failed/);
  assert.equal(data.board.workers[0].homeNeedsHuman, false);
});

test('P2 browser producer semantic phases refresh activity but identical phase, counters and model metadata do not', async (t) => {
  const f = p2Fixture(t),
    a = f.association(906, {
      backend: {
        id: 'synthetic-browser',
        executor: 'jev',
        harness: null,
        model: 'synthetic-browser-model',
        effort: null,
        env_profile: null,
        recipe: null,
      },
    }),
    started = f.now() - 599000;
  const runtime = join(f.home, 'jev-runtime/jobs', `runtime-${a.job}.json`);
  const update = (phase: string, seq: number) => {
    f.jev(a, 'running', null, false, {
      phase,
      seq,
      provider: { id: 'typesafe', model: `model-${seq}` },
      run: { startedAt: new Date(started).toISOString() },
    });
    fs.utimesSync(runtime, new Date(f.now()), new Date(f.now()));
  };
  update('prepare', 1);
  let data = await f.draw();
  assert.equal(card(data, f.now()).state, 'in-progress');
  f.advance(1000);
  update('prepare', 2);
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'stalled');
  update('click', 3);
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'in-progress');
  assert.match(data.text, /working/);
  f.advance(600000);
  update('click', 4);
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'stalled');
});

test('P2 explicit reported facts only, primary-owned counts, no helper prose, no ambiguous totals, direct never accepted or merged', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  f.status(d);
  const report =
    '# Primary\n\n## Files changed\n- `src/a.ts` synthetic change\n- `src/b.ts` synthetic change\n\n## Checks\n# tests 12\n# suites 0\n# pass 11\n# fail 1\n';
  f.put(join(d, 'report.md'), report);
  f.put(join(d, 'review-1.md'), 'Verdict: accept\n# tests 900\n# suites 0\n# pass 900\n# fail 0\nSecret helper prose.');
  let data = await f.draw();
  assert.match(data.text, /reported 12 tests/);
  assert.match(data.text, /1 failed/);
  assert.match(data.text, /2 files/);
  assert.doesNotMatch(data.text, /900|Secret helper|merged/);
  assert.equal(data.board.workers[0].work?.reported?.passed, 11);
  f.put(join(d, 'report.md'), report + '\n# tests 13\n# suites 0\n# pass 13\n# fail 0\n');
  data = await f.draw();
  assert.doesNotMatch(data.text, /reported \d+ tests/);
  f.status(d, { state: 'closed', output_written: true, settled_at: new Date(f.now()).toISOString() });
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'awaiting-acceptance');
  assert.doesNotMatch(data.text, /merged|Facade closed/);
});

test('P2 all native flags compose: one optional sentence, no phase without evidence, no telemetry or helper prose, expansion keeps detail', async (t) => {
  const f = p2Fixture(t),
    native = p2Native('Native task', {
      model: 'never-model-badge',
      effort: 'never-effort',
      contextUsage: {
        percent: 90,
        used: 90,
        total: 100,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        compactCount: 0,
      },
      children: [p2Native('Secret helper task', { depth: 2 })],
    });
  const data = await f.collect([native]);
  const worker = data.board.workers[0];
  const target = { kind: 'worker' as const, laneId: worker.laneId, workerId: worker.id };
  const note =
    'First synthetic sentence. Second complete sentence, retained only when expanded. ' +
    'Synthetic detail '.repeat(20);
  const logs = new Map([[native.id, [{ at: f.now(), kind: 'note' as const, text: note }]]]);
  for (const label of [false, true])
    for (const summary of [false, true])
      for (const clock of [false, true])
        for (const corners of ['square', 'round'] as const) {
          const state = work({
            cardCorners: corners,
            cardVisibility: { ...defaultSettings(), cardLabel: label, cardSummary: summary, cardClock: clock },
          });
          const rows = laneRows(
            { tree: data.tree, state, width: 55, height: 80, agentLog: logs },
            data.board.lanes[0],
            state,
            55,
            f.now()
          ).slice(1);
          assert.ok(rows.length <= 2);
          const text = rows.map((r) => stripAnsi(r.paint?.() ?? r.text)).join('\n');
          assert.equal(text.includes('First synthetic sentence'), summary);
          assert.doesNotMatch(text, /never-model|never-effort|tok\/s|90%|Secret helper|build|review/);
          assert.equal(text.includes('1m'), clock);
        }
  const state = work({ workTarget: target, boardExpanded: new Set([targetKey(target)]) });
  const expanded = laneRows(
    { tree: data.tree, state, width: 55, height: 80, agentLog: logs },
    data.board.lanes[0],
    state,
    55,
    f.now()
  )
    .map((r) => stripAnsi(r.paint?.() ?? r.text))
    .join('\n');
  assert.match(expanded, /Second complete sentence/);
});

test('P2 Home 110 peek shares exact Work card cells and Home Enter unfolds the same selected lane', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  f.status(d);
  const data = await f.draw();
  const worker = data.board.workers[0],
    target = { kind: 'worker' as const, laneId: worker.laneId, workerId: worker.id };
  const state = work({ mainTab: 'home', homeTarget: target, boardFolded: new Set([worker.laneId]) });
  const folded = renderMonitor({
    tree: data.tree,
    workboard: data.board,
    state,
    width: 110,
    height: 40,
    nowMs: f.now(),
  });
  const handed = handleMonitorInput(folded.state, key('enter'), {
    tree: data.tree,
    frame: folded,
    nowMs: f.now(),
  }).state;
  assert.equal(handed.mainTab, 'work');
  assert.deepEqual(handed.workTarget, target);
  assert.ok(!handed.boardFolded?.has(worker.laneId));
  const home = renderMonitor({
    tree: data.tree,
    workboard: data.board,
    state: { ...state, boardFolded: new Set() },
    width: 110,
    height: 80,
    nowMs: f.now(),
  });
  const expected = laneRows(
    { tree: data.tree, state: home.state, width: 43, height: 80 },
    data.board.lanes[0],
    { ...home.state, workTarget: target },
    43,
    f.now()
  )
    .slice(1)
    .map((r) => stripAnsi(r.paint?.() ?? r.text).trim());
  for (const cells of expected)
    assert.ok(
      home.lines.some((line) => stripAnsi(line).includes(cells)),
      cells
    );
  assert.ok(home.workboard!.rows.filter((r) => r.text.includes('›')).length <= 1);
});

test('P2 navigation uses human-needed then stalled Work order, stays stable after reorder, fold/expand and Inspector return are passive', async (t) => {
  const f = p2Fixture(t),
    a = f.task('A'),
    b = f.task('B'),
    c = f.task('C');
  f.status(a, { state: 'failed' });
  f.status(b, { started_at: '2026-11-09T11:30:00Z' });
  f.status(c);
  const data = await f.draw();
  const failed =
    data.board.workers.find((w) => w.laneId.endsWith('A"]')) ?? data.board.workers.find((w) => w.state === 'failed')!;
  let outcome = handleMonitorInput(data.frame.state, key('next-trouble'), {
    tree: data.tree,
    frame: data.frame,
    nowMs: f.now(),
  });
  assert.equal(outcome.state.workTarget?.kind, 'worker');
  assert.equal((outcome.state.workTarget as { workerId: string }).workerId, failed.id);
  assert.equal(outcome.action, undefined);
  let frame = renderMonitor({
    tree: data.tree,
    workboard: data.board,
    state: outcome.state,
    width: 110,
    height: 20,
    nowMs: f.now(),
  });
  outcome = handleMonitorInput(frame.state, key('next-trouble'), { tree: data.tree, frame, nowMs: f.now() });
  const selected = outcome.state.workTarget!;
  assert.equal(
    projectWorkCard(
      data.board.workers.find((w) => w.id === (selected as { workerId: string }).workerId)!,
      f.now()
    ).state,
    'stalled'
  );
  frame = renderMonitor({
    tree: data.tree,
    workboard: data.board,
    state: outcome.state,
    width: 110,
    height: 20,
    nowMs: f.now(),
  });
  const inspected = handleMonitorInput(frame.state, key('inspect'), { tree: data.tree, frame, nowMs: f.now() });
  assert.equal(inspected.state.focus, 'details');
  assert.equal(inspected.action, undefined);
  const inspectFrame = renderMonitor({
    tree: data.tree,
    workboard: data.board,
    state: inspected.state,
    width: 110,
    height: 20,
    nowMs: f.now(),
  });
  const returned = handleMonitorInput(inspectFrame.state, key('escape'), {
    tree: data.tree,
    frame: inspectFrame,
    nowMs: f.now(),
  });
  assert.deepEqual(returned.state.workTarget, selected);
  const reordered = {
    ...data.board,
    lanes: [...data.board.lanes].reverse(),
    workers: [...data.board.workers].reverse(),
  };
  const stable = renderMonitor({
    tree: data.tree,
    workboard: reordered,
    state: returned.state,
    width: 110,
    height: 20,
    nowMs: f.now(),
  });
  assert.deepEqual(stable.state.workTarget, selected);
});

test('P2 selected right-column decisions keep their one-way marker and complete minute unit inside the painted hitbox', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  f.status(d);
  f.put(
    join(d, 'qa/q1.md'),
    '# Question\n\nWhich explicit boundary?\n\nOptions:\n- A) Keep\n- B) Change\n\nDefault if unanswered: A'
  );
  f.put(join(d, 'qa/q1.answer.md'), 'B\n\nInstead: Keep\nRationale: Preserve explicit context\nOne-way: true');
  const data = await f.collect(),
    decision = data.board.decisions.find((d) => d.oneWay)!;
  assert.ok(decision);
  const target = { kind: 'decision' as const, laneId: decision.laneId, decisionId: decision.id };
  const frame = renderMonitor({
    tree: data.tree,
    workboard: data.board,
    state: work({ workTarget: target }),
    width: 110,
    height: 40,
    nowMs: f.now(),
  });
  const control = frame.controls.find((c) => c.kind === 'board-pick' && c.item === targetKey(target) && c.x > 50)!;
  assert.ok(control);
  const cells = stripAnsi(frame.lines[control.y]).slice(control.x, control.x + control.width);
  assert.match(cells, /›!/);
  assert.match(cells, /<1m/);
});

test('P2 the lane renderer supports already-scoped mixed workers without a proportional phase claim or owner prose merging', async (t) => {
  const f = p2Fixture(t),
    a = f.task('Build-worker'),
    b = f.task('Design-worker');
  f.status(a);
  f.status(b, { role: 'architect' });
  const data = await f.collect();
  assert.equal(data.board.lanes.length, 2, 'production never invents a join between the two sources');
  // Renderer-only layout fixture: feed two real observed workers in an explicitly supplied lane, not a collector join.
  const lane = {
    ...data.board.lanes[0],
    workers: data.board.workers.map((w) => ({ ...w, laneId: data.board.lanes[0].id })),
  };
  for (const width of [44, 110]) {
    const rows = laneRows({ tree: data.tree, state: work(), width, height: 40 }, lane, work(), width, f.now());
    assert.match(stripAnsi(rows[0].text), /mixed/);
    assert.doesNotMatch(stripAnsi(rows[0].text), /[━▸]/);
    const text = rows.map((r) => stripAnsi(r.paint?.() ?? r.text)).join('\n');
    assert.match(text, /build/);
    assert.match(text, /design/);
    assert.ok(rows.every((r) => visualLength(r.paint?.() ?? r.text) === width));
    if (width === 110) assert.ok(rows.some((r) => r.controls?.some((c) => c.kind === 'board-pick' && c.x > 50)));
  }
});

test('P2 settings migration is display-only, obsolete controls absent and threshold bounded', (t) => {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'hud-p2-settings-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = join(home, 'settings.json');
  for (const [name, value] of Object.entries({
    HOME: home,
    HUD_HOME: home,
    CODEX_HOME: join(home, 'codex'),
    HUD_SETTINGS_PATH: file,
  })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  assert.ok(settingsPath().startsWith(home + '/'), 'settings writes must remain inside the private test directory');
  saveSettings({
    ...defaultSettings(),
    briefAgents: false,
    cardPreset: 'progress',
    cardContext: true,
    cardRate: true,
    cardSubagents: true,
  } as ReturnType<typeof defaultSettings>);
  const loaded = loadSettings();
  assert.equal(loaded.cardStallMinutes, 10);
  assert.equal(loaded.briefAgents, false);
  assert.equal(Object.hasOwn(loaded, 'briefingApiKey'), false);
  assert.deepEqual(
    SETTING_ROWS.filter((r) => r.group === 'Cards').map((r) => r.key),
    ['cardCorners', 'cardLabel', 'cardSummary', 'cardClock', 'cardStallMinutes']
  );
  for (const invalid of [0, 121, -1, 1.5, '10', null]) {
    fs.writeFileSync(file, JSON.stringify({ cardStallMinutes: invalid }));
    assert.equal(loadSettings().cardStallMinutes, 10);
  }
  fs.writeFileSync(file, JSON.stringify({ cardStallMinutes: 15 }));
  assert.equal(loadSettings().cardStallMinutes, 15);
});

test('P2 viewport-only formatting, warm/selected cache, minute boundary with hidden clocks, scroll/resize and changed native digest', async (t) => {
  const f = p2Fixture(t);
  for (let i = 0; i < 45; i++) {
    const d = f.task(`T${String(i).padStart(2, '0')}`);
    f.status(d, { started_at: new Date(f.now()).toISOString() });
  }
  const data = await f.collect([], 240);
  assert.equal(data.board.workers.length, 45);
  const args = { tree: data.tree, workboard: data.board, width: 56, height: 12, nowMs: f.now() };
  const initial = work({ cardVisibility: { ...defaultSettings(), cardClock: false } });
  workCardCost.formatted = 0;
  let frame = renderMonitor({ ...args, state: initial });
  assert.ok(workCardCost.formatted > 0);
  assert.ok(workCardCost.formatted < 10);
  workCardCost.formatted = 0;
  frame = renderMonitor({ ...args, state: frame.state });
  assert.equal(workCardCost.formatted, 0);
  const selected = data.board.workers[1],
    target = { kind: 'worker' as const, laneId: selected.laneId, workerId: selected.id };
  frame = renderMonitor({ ...args, state: { ...frame.state, workTarget: target } });
  assert.equal(workCardCost.formatted, 0);
  frame = renderMonitor({ ...args, state: { ...frame.state, workScroll: 50 } });
  assert.ok(workCardCost.formatted < 10);
  workCardCost.formatted = 0;
  renderMonitor({ ...args, state: frame.state, width: 110 });
  assert.ok(workCardCost.formatted < 10);
  const clamped = renderMonitor({ ...args, state: { ...frame.state, workScroll: Number.MAX_SAFE_INTEGER } }),
    pane = clamped.panes.find((p) => p.id === 'agents')!;
  assert.ok((clamped.state.workScroll ?? 0) <= Math.max(0, pane.contentLength - pane.height));
  const lane = data.board.lanes[0];
  // Fold through the real input path with that lane selected; right arrow restores its children.
  const laneFrame = renderMonitor({
    ...args,
    state: { ...clamped.state, workTarget: { kind: 'lane', laneId: lane.id } },
  });
  const closedLane = handleMonitorInput(laneFrame.state, key('left'), {
    tree: data.tree,
    frame: laneFrame,
    nowMs: f.now(),
  });
  assert.ok(closedLane.state.boardFolded?.has(lane.id));
  const closedFrame = renderMonitor({ ...args, state: closedLane.state });
  const openedLane = handleMonitorInput(closedFrame.state, key('right'), {
    tree: data.tree,
    frame: closedFrame,
    nowMs: f.now(),
  });
  assert.ok(!openedLane.state.boardFolded?.has(lane.id));
  assert.equal(closedLane.action, undefined);
  const timed = renderMonitor({ ...args, state: initial, nowMs: f.now() + 600_000 });
  assert.match(timed.lines.map(stripAnsi).join('\n'), /stalled/);
  const n = p2Native('Digest cache native'),
    native = await f.collect([n]);
  const logs = new Map([[n.id, [{ at: f.now(), kind: 'note' as const, text: 'Old native sentence.' }]]]);
  const nativeArgs = {
    tree: native.tree,
    workboard: native.board,
    agentLog: logs,
    state: work(),
    width: 56,
    height: 200,
    nowMs: f.now(),
  };
  renderMonitor(nativeArgs);
  logs.set(n.id, [{ at: f.now(), kind: 'note', text: 'New native sentence.' }]);
  const changed = renderMonitor(nativeArgs);
  assert.match(changed.lines.map(stripAnsi).join('\n'), /New native sentence/);
  assert.doesNotMatch(changed.lines.map(stripAnsi).join('\n'), /Old native sentence/);
});

test('P2 admitted current-helper progress dates owner activity, but helper heartbeats never keep it alive', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  const old = new Date(f.now() - 20 * 60_000).toISOString(),
    helperStart = new Date(f.now() - 60_000).toISOString();
  f.status(d, {
    started_at: old,
    updated_at: old,
    state: 'waiting_helper',
    helper_pending: { kind: 'sonic', n: 1, status_file: null },
  });
  fs.utimesSync(join(d, 'STATUS.json'), new Date(old), new Date(old));
  f.status(d, { started_at: helperStart }, 'sonic-1');
  let data = await f.draw();
  assert.equal(card(data, f.now()).state, 'in-progress');
  assert.equal(card(data, f.now()).inactivityMinutes, 1);
  assert.deepEqual(card(data, f.now()).phases, ['build', 'chores']);
  f.advance(10 * 60_000);
  f.status(
    d,
    { started_at: helperStart, model: 'heartbeat-only-model', updated_at: new Date(f.now()).toISOString() },
    'sonic-1'
  );
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'stalled');
  assert.equal(card(data, f.now()).inactivityMinutes, 11);
  const settled = new Date(f.now()).toISOString();
  f.put(join(d, 'sonic-1.md'), 'Synthetic helper feedback, never card prose.');
  f.status(d, { started_at: helperStart, state: 'closed', output_written: true, settled_at: settled }, 'sonic-1');
  data = await f.draw();
  assert.equal(card(data, f.now()).state, 'in-progress');
  assert.equal(card(data, f.now()).inactivityMinutes, 0);
  assert.doesNotMatch(data.text, /Synthetic helper feedback|to accept/);
  f.advance(60_000);
  f.status(
    d,
    { started_at: helperStart, state: 'closed', output_written: true, settled_at: settled, model: 'another-heartbeat' },
    'sonic-1'
  );
  f.put(join(d, 'sonic-1.md'), 'Synthetic helper feedback, never card prose.');
  data = await f.draw();
  assert.equal(card(data, f.now()).inactivityMinutes, 1);
});

test('P2 every visual mode keeps cells exact, all four active states plus done, no telemetry, and name rectangles exclude role/state/time', async (t) => {
  const f = p2Fixture(t),
    d = f.task();
  f.status(d);
  const a = f.association(401);
  f.dispatch(a, 'closed', { output_written: true, settled_at: '2026-11-09T11:59:00Z' });
  f.put(join(f.home, 'jobs', a.job, 'report.md'), '# Result');
  f.association(401, { closed: true });
  const waiting = f.task('Needs-you');
  f.status(waiting, { state: 'waiting_orchestrator' });
  const stalled = f.task('Stalled');
  f.status(stalled, { started_at: '2026-11-09T11:00:00Z' });
  const result = f.task('To-accept');
  f.put(join(result, 'report.md'), '# Result');
  f.status(result, { state: 'idle_grace', output_written: true, settled_at: new Date(f.now()).toISOString() });
  const data = await f.collect([
    p2Native('Long native title '.repeat(7), { model: 'Long model '.repeat(20), effort: 'max' }),
  ]);
  assert.deepEqual(
    new Set(data.board.workers.map((w) => projectWorkCard(w, f.now()).state)),
    new Set(['in-progress', 'needs-you', 'stalled', 'awaiting-acceptance', 'done'])
  );
  for (const lang of ['en', 'zh'] as const)
    for (const theme of ['none', 'terminal', 'mocha', 'latte', 'titanium'] as const)
      for (const icons of ['unicode', 'text'] as const)
        for (const look of LOOKS) {
          setLanguage(lang);
          setDisplayConfig({ theme, icons, look });
          for (const width of [16, 43, 44, 56, 110])
            for (const mainTab of ['home', 'work'] as const) {
              const frame = renderMonitor({
                tree: data.tree,
                workboard: data.board,
                state: work({ mainTab }),
                width,
                height: 50,
                nowMs: f.now(),
              });
              assert.ok(
                frame.lines.every((line) => visualLength(line) === width),
                `${lang} ${theme} ${icons} ${look} ${width} ${mainTab}`
              );
              assert.doesNotMatch(
                frame.lines.map(stripAnsi).join('\n'),
                mainTab === 'work' ? /tok\/s|Long model/ : /tok\/s/
              );
            }
        }
  setLanguage('en');
  setDisplayConfig({ theme: 'none', icons: 'unicode', look: 'tab' });
  const native = data.board.workers.find((w) => w.nodeId === 'Long native title '.repeat(7))!,
    projected = projectWorkCard(native, f.now());
  const name = workCardName(projected, work(), 44),
    line = stripAnsi(renderWorkCard(projected, work(), 44)[0]);
  assert.ok(name.text.length < projected.title.length);
  assert.equal(line.slice(name.x, name.x + name.text.length), name.text);
  assert.ok(name.x > 4);
  assert.ok(name.x + visualLength(name.text) < 44 - visualLength('working 1m'));
});
import { work } from '../fixtures/work-card-p2-perf.js';
