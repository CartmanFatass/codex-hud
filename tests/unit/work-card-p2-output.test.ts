import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { p2Fixture } from '../fixtures/work-card-p2.js';
import { useDisplayFixture } from '../fixtures/display.js';
import { projectWorkCard } from '../../src/collectors/work-card.js';
import { initialMonitorState } from '../../src/render/monitor.js';
useDisplayFixture();
const state = () => ({ ...initialMonitorState(), mainTab: 'work' as const });
const report = '# Result\nNo further changes needed.';

test('P2 q22/q23: identical physical current report is a result, old/no write is not; semantic touch and legacy initial fallback stay unchanged', async (t) => {
  const f = p2Fixture(t),
    d = f.task('same-report');
  f.put(join(d, 'report.md'), report);
  f.status(d, { state: 'idle_grace', output_written: true, settled_at: new Date(f.now()).toISOString() });
  let data = await f.draw(state()),
    owner = data.board.workers[0];
  assert.equal(projectWorkCard(owner, f.now()).state, 'awaiting-acceptance');
  const activity = owner.work?.activityAt;
  // Existing primary rule has no report-mtime<=settle upper bound (q23).
  f.advance(60000);
  f.put(join(d, 'report.md'), report);
  data = await f.draw(state());
  owner = data.board.workers[0];
  assert.equal(projectWorkCard(owner, f.now()).state, 'awaiting-acceptance');
  assert.equal(owner.work?.activityAt, activity, 'identical physical rewrite is not semantic progress');
  f.advance(120000);
  const start = f.now();
  f.status(d, {
    state: 'idle_grace',
    session_id: 'new-run',
    started_at: new Date(start).toISOString(),
    output_written: true,
    settled_at: new Date(f.now()).toISOString(),
  });
  data = await f.draw(state());
  assert.equal(
    projectWorkCard(data.board.workers[0], f.now()).state,
    'needs-you',
    'new episode with no write cannot replay old output'
  );
  f.put(join(d, 'report.md'), report, start - 1);
  data = await f.draw(state());
  assert.equal(
    projectWorkCard(data.board.workers[0], f.now()).state,
    'needs-you',
    'physical mtime before current start is not current'
  );
  f.put(join(d, 'report.md'), report, start);
  data = await f.draw(state());
  owner = data.board.workers[0];
  assert.equal(owner.work?.result, true);
  assert.equal(owner.work?.failed, false);
  assert.equal(projectWorkCard(owner, f.now()).state, 'awaiting-acceptance');
  assert.match(data.text, /to accept/);
  f.status(d, {
    state: 'idle_grace',
    session_id: 'new-run',
    started_at: new Date(start).toISOString(),
    output_written: false,
    settled_at: new Date(f.now()).toISOString(),
  });
  data = await f.draw(state());
  assert.equal(
    data.board.workers[0].work?.result,
    false,
    'physical write without positive producer flag is not a result'
  );
  const legacy = f.task('legacy-output');
  f.put(join(legacy, 'report.md'), report);
  f.status(legacy, {
    state: 'idle_grace',
    session_id: 'legacy-initial',
    started_at: undefined,
    output_written: true,
    settled_at: new Date(f.now()).toISOString(),
  });
  data = await f.draw(state());
  const initial = data.board.workers.find((w) => w.work?.episode === 'legacy-initial');
  assert.ok(initial);
  assert.equal(initial.startedAt, null);
  assert.equal(initial.work?.result, true, 'existing unique invocation initial-start fallback stays');
  assert.equal(projectWorkCard(initial, f.now()).state, 'awaiting-acceptance');
});

test('P2 q22: same-session facade continuation admits identical rewritten output only with the new start/floor and actual current write', async (t) => {
  const f = p2Fixture(t),
    a = f.association(988),
    d = join(f.home, 'jobs', a.job),
    floor = f.now() - 60000;
  const receipt = f.dispatch(a, 'idle_grace', {
    started_at: new Date(f.now() - 120000).toISOString(),
    output_written: true,
    settled_at: new Date(floor).toISOString(),
  });
  f.put(join(d, 'report.md'), report, floor);
  let data = await f.draw(state());
  assert.equal(projectWorkCard(data.board.workers[0], f.now()).state, 'awaiting-acceptance');
  const session = data.board.workers[0].work!.episode;
  f.receipt(a, {
    pi_dispatch: {
      ...receipt.pi_dispatch!,
      continuation: {
        previous_session_id: session,
        previous_settled_at: new Date(floor).toISOString(),
        message_key: 'identical-output-continuation',
      },
    },
  });
  f.status(d, {
    state: 'idle_grace',
    session_id: session,
    started_at: new Date(f.now()).toISOString(),
    output_written: true,
    settled_at: new Date(f.now()).toISOString(),
  });
  data = await f.draw(state());
  assert.equal(projectWorkCard(data.board.workers[0], f.now()).state, 'needs-you');
  assert.equal(data.tree.nodes[0].job?.work?.outputCurrent, false);
  f.put(join(d, 'report.md'), report);
  data = await f.draw(state());
  assert.equal(data.tree.nodes[0].job?.work?.outputCurrent, true);
  assert.equal(
    data.board.workers[0].work?.result,
    true,
    'same-episode Task proof must use physical time, not reject valid identical bytes'
  );
  assert.equal(projectWorkCard(data.board.workers[0], f.now()).state, 'awaiting-acceptance');
  assert.match(data.text, /to accept/);
});

test('P2 q22: identical review bytes rewritten by a current settled/written helper admit the phase; old or out-of-settle writes never supply it', async (t) => {
  const f = p2Fixture(t),
    d = f.task('same-review'),
    body = 'Verdict: accept\n\nSame supported conclusion.';
  const pending = { kind: 'review', n: 1, status_file: null };
  f.status(d, {
    state: 'waiting_helper',
    started_at: new Date(f.now() - 120000).toISOString(),
    helper_pending: pending,
  });
  f.put(join(d, 'review-1.md'), body, f.now() - 1000);
  f.status(
    d,
    {
      state: 'closed',
      started_at: new Date(f.now() - 60000).toISOString(),
      output_written: true,
      settled_at: new Date(f.now()).toISOString(),
    },
    'review-1'
  );
  let data = await f.draw(state());
  assert.ok(data.board.workers[0].work?.phases.includes('review r1 accept'));
  f.advance(180000);
  const helperStart = f.now() - 30000;
  f.status(d, {
    state: 'waiting_helper',
    session_id: 'new-review-parent',
    started_at: new Date(f.now() - 60000).toISOString(),
    helper_pending: pending,
  });
  f.status(
    d,
    {
      state: 'closed',
      session_id: 'new-review-helper',
      started_at: new Date(helperStart).toISOString(),
      output_written: true,
      settled_at: new Date(f.now()).toISOString(),
    },
    'review-1'
  );
  data = await f.draw(state());
  assert.ok(
    !data.board.workers[0].work?.phases.includes('review r1 accept'),
    'old physical file is not this helper output'
  );
  f.put(join(d, 'review-1.md'), body, helperStart - 1);
  data = await f.draw(state());
  assert.ok(!data.board.workers[0].work?.phases.includes('review r1 accept'));
  f.put(join(d, 'review-1.md'), body);
  data = await f.draw(state());
  assert.ok(data.board.workers[0].work?.phases.includes('review r1 accept'));
  const activity = data.board.workers[0].work?.activityAt;
  f.advance(1000);
  f.put(join(d, 'review-1.md'), body);
  data = await f.draw(state());
  assert.ok(
    !data.board.workers[0].work?.phases.includes('review r1 accept'),
    'strict review output<=settle bound stays'
  );
  assert.equal(data.board.workers[0].work?.activityAt, activity, 'identical post-settle touch is not progress');
});
