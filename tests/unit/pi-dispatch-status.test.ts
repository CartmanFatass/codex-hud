/**
 * Pure unit tests for the bounded native STATUS observation and the shared wait
 * loop in src/roles/pi-dispatch-status.ts.
 *
 * Every fixture is a private temporary directory tree with synthetic data. No
 * herdr, pi, pi-dispatch, model, network or real ~/.hud is touched: the tests
 * only read and write inside a temp HOME they create and remove.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { PiDispatch } from '../../src/roles/pi-dispatch.js';
import {
  dispatchQuestions,
  observeDispatch,
  waitDispatch,
  parseDispatchStatus,
} from '../../src/roles/pi-dispatch-status.js';

interface Stage {
  home: string;
  dir: string;
}

type Fields = Record<string, unknown>;

/** A canonical private task directory: realpath, 0700, removed after the test. */
function stage(t: TestContext): Stage {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hud-r2b-status-')));
  chmodSync(home, 0o700);
  const directory = join(home, 'job');
  mkdirSync(directory, { mode: 0o700 });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, dir: realpathSync(directory) };
}

/** Private fixture write: 0700 parents, 0600 file. */
function privateWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
}

function metadata(role: PiDispatch['role'] = 'implementer', continuation?: PiDispatch['continuation']): PiDispatch {
  return {
    contract_version: 1,
    role,
    executable: '/opt/synthetic/bin/pi-dispatch',
    reaper: '/opt/synthetic/bin/pi-role-reap',
    launch: 'acked',
    ...(continuation ? { continuation } : {}),
  };
}

/** One valid STATUS v1 row; overrides break exactly the field under test. */
function statusRow(directory: string, slot: string, role: string, output: string, overrides: Fields = {}): Fields {
  return {
    version: 1,
    task_dir: directory,
    slot,
    role,
    model: 'synthetic-flash',
    thinking: 'max',
    session_id: `synthetic-session-${slot}`,
    output_path: output,
    output_written: false,
    state: 'working',
    helper_pending: null,
    started_at: '2026-11-08T00:00:00.000Z',
    settled_at: null,
    idle_deadline_at: null,
    ended_at: null,
    exit_reason: null,
    error: null,
    updated_at: '2026-11-08T00:00:00.000Z',
    ...overrides,
  };
}

function reportPath(st: Stage): string {
  return join(st.dir, 'report.md');
}

function writePrimary(st: Stage, overrides: Fields = {}): void {
  const row = statusRow(st.dir, 'primary', 'implementer', reportPath(st), overrides);
  privateWrite(join(st.dir, 'STATUS.json'), `${JSON.stringify(row)}\n`);
}

function helperRole(slot: string): string {
  const kind = slot.slice(0, slot.lastIndexOf('-'));
  return kind === 'review' ? 'reviewer' : kind;
}

function writeHelper(st: Stage, slot: string, overrides: Fields = {}): void {
  const row = statusRow(st.dir, slot, helperRole(slot), join(st.dir, `${slot}.md`), overrides);
  privateWrite(join(st.dir, '.dispatch', slot, 'STATUS.json'), `${JSON.stringify(row)}\n`);
}

function writeRaw(st: Stage, file: string, text: string): void {
  privateWrite(join(st.dir, file), text);
}

const BASELINE: NonNullable<PiDispatch['continuation']> = {
  message_key: 'synthetic-message-key-1',
  previous_session_id: 'synthetic-session-primary',
  previous_settled_at: '2026-11-08T00:00:00.000Z',
};

test('every native STATUS state maps to its facade row', (t) => {
  const rows: [string, string, string | undefined][] = [
    ['working', 'open', undefined],
    ['waiting_helper', 'open', undefined],
    ['waiting_orchestrator', 'open', 'QUESTION'],
    ['idle_grace', 'done', 'DONE'],
    ['closed', 'done', 'DONE'],
    ['failed', 'error', 'FAILED'],
  ];
  for (const [native, state, event] of rows) {
    const st = stage(t);
    writePrimary(st, { state: native });
    const view = observeDispatch(st.dir, metadata());
    assert.equal(view.status, native);
    assert.deepEqual(
      parseDispatchStatus(
        statusRow(st.dir, 'primary', 'implementer', reportPath(st), { state: native }),
        st.dir,
        'primary',
        'implementer',
        reportPath(st)
      ),
      view.dispatch,
      'incremental single-file parser agrees with the existing observer'
    );
    assert.equal(view.state, state, native);
    assert.equal(view.event, event, native);
    assert.equal(view.continuation, null, native);
    assert.equal(view.acceptance, null, native);
    assert.equal(view.report_path, reportPath(st), native);
    assert.deepEqual(view.diagnostics, [], native);
  }
});

test('an explicit facade close wins over a still-working native status', (t) => {
  const st = stage(t);
  writePrimary(st, { state: 'working' });
  const view = observeDispatch(st.dir, metadata(), true);
  assert.equal(view.status, 'working');
  assert.equal(view.state, 'closed');
  assert.equal(view.event, 'BLOCKED');
});

test('the expected primary role comes from the receipt metadata', (t) => {
  const st = stage(t);
  const row = statusRow(st.dir, 'primary', 'architect', reportPath(st), { state: 'idle_grace' });
  privateWrite(join(st.dir, 'STATUS.json'), `${JSON.stringify(row)}\n`);
  assert.equal(observeDispatch(st.dir, metadata('implementer')).status, 'unreadable');
  assert.equal(observeDispatch(st.dir, metadata('architect')).state, 'done');
});

test('a missing primary STATUS is launch_unknown, never terminal', (t) => {
  const st = stage(t);
  const view = observeDispatch(st.dir, metadata());
  assert.equal(view.state, 'launch_unknown');
  assert.equal(view.status, 'unreadable');
  assert.equal(view.dispatch, null);
  assert.equal(view.event, undefined);
  assert.equal(view.report, null);
  assert.deepEqual(view.helpers, []);
  assert.deepEqual(view.pending, []);
  assert.deepEqual(view.diagnostics, [
    { path: join(st.dir, 'STATUS.json'), reason: 'missing_malformed_or_unsupported' },
  ]);
});

test('malformed, mismatched and unreadable snapshots are never terminal', (t) => {
  const broken: [string, (st: Stage) => void][] = [
    ['not json', (st) => writeRaw(st, 'STATUS.json', '{not json')],
    ['not an object', (st) => writeRaw(st, 'STATUS.json', '[]')],
    ['unsupported version', (st) => writePrimary(st, { version: 2 })],
    ['mismatched task_dir', (st) => writePrimary(st, { task_dir: join(st.home, 'elsewhere') })],
    ['mismatched slot', (st) => writePrimary(st, { slot: 'sonic-1' })],
    ['mismatched role', (st) => writePrimary(st, { role: 'reviewer' })],
    ['mismatched output', (st) => writePrimary(st, { output_path: join(st.home, 'report.md') })],
    ['unknown state', (st) => writePrimary(st, { state: 'paused' })],
    ['non boolean output_written', (st) => writePrimary(st, { output_written: 'yes' })],
    ['empty session_id', (st) => writePrimary(st, { session_id: '' })],
    ['unparseable timestamp', (st) => writePrimary(st, { settled_at: 'yesterday' })],
    ['unknown helper kind', (st) => writePrimary(st, { helper_pending: { kind: 'jev', n: 1, status_file: null } })],
    ['non positive helper n', (st) => writePrimary(st, { helper_pending: { kind: 'sonic', n: 0, status_file: null } })],
    ['STATUS is a directory', (st) => mkdirSync(join(st.dir, 'STATUS.json'), { mode: 0o700 })],
    [
      'STATUS is a symlink',
      (st) => {
        const real = join(st.home, 'real-status.json');
        const row = statusRow(st.dir, 'primary', 'implementer', reportPath(st), { state: 'idle_grace' });
        privateWrite(real, `${JSON.stringify(row)}\n`);
        symlinkSync(real, join(st.dir, 'STATUS.json'));
      },
    ],
  ];
  for (const [name, breakIt] of broken) {
    const st = stage(t);
    breakIt(st);
    const view = observeDispatch(st.dir, metadata());
    assert.equal(view.state, 'launch_unknown', name);
    assert.equal(view.status, 'unreadable', name);
    assert.equal(view.event, undefined, name);
    assert.equal(view.report, null, name);
    assert.deepEqual(
      view.diagnostics,
      [{ path: join(st.dir, 'STATUS.json'), reason: 'missing_malformed_or_unsupported' }],
      name
    );
  }
});

test('success needs output_written and a nonempty regular artifact', (t) => {
  const st = stage(t);
  writePrimary(st, { state: 'idle_grace', output_written: true });
  privateWrite(reportPath(st), '# synthetic report\n');
  const view = observeDispatch(st.dir, metadata());
  assert.equal(view.state, 'done');
  assert.equal(view.event, 'DONE');
  assert.equal(view.report, reportPath(st));
  assert.equal(view.acceptance, null);
});

test('report-only evidence is not success', (t) => {
  const st = stage(t);
  writePrimary(st, { state: 'idle_grace', output_written: false });
  privateWrite(reportPath(st), '# synthetic report\n');
  const view = observeDispatch(st.dir, metadata());
  assert.equal(view.state, 'done');
  assert.equal(view.report, null);
});

test('empty, whitespace-only, missing and .final artifacts are not the report', (t) => {
  const st = stage(t);
  writePrimary(st, { state: 'idle_grace', output_written: true });
  privateWrite(reportPath(st), '   \n\n');
  privateWrite(`${reportPath(st)}.final`, 'Verdict: accept\n');
  let view = observeDispatch(st.dir, metadata());
  assert.equal(view.report, null, 'whitespace artifact');
  assert.equal(view.state, 'done');

  rmSync(reportPath(st));
  view = observeDispatch(st.dir, metadata());
  assert.equal(view.report, null, 'missing artifact');
  assert.equal(view.state, 'done');
});

test('a failed run keeps its artifact as evidence, not acceptance', (t) => {
  const st = stage(t);
  writePrimary(st, {
    state: 'failed',
    output_written: true,
    error: 'synthetic failure',
    exit_reason: 'error',
    ended_at: '2026-11-08T00:10:00.000Z',
  });
  privateWrite(reportPath(st), 'partial synthetic artifact\n');
  const view = observeDispatch(st.dir, metadata());
  assert.equal(view.state, 'error');
  assert.equal(view.event, 'FAILED');
  assert.equal(view.report, reportPath(st));
  assert.equal(view.acceptance, null);
  assert.equal(view.dispatch?.error, 'synthetic failure');
  assert.equal(view.dispatch?.exit_reason, 'error');
  assert.equal(view.dispatch?.ended_at, '2026-11-08T00:10:00.000Z');
});

test('helper slots are read from direct .dispatch children with their own role and output', (t) => {
  const st = stage(t);
  writePrimary(st, {
    state: 'waiting_helper',
    helper_pending: { kind: 'review', n: 1, status_file: join(st.dir, '.dispatch', 'review-1', 'STATUS.json') },
  });
  writeHelper(st, 'sonic-1', { state: 'closed', output_written: true });
  writeHelper(st, 'review-1', { state: 'closed', output_written: true });
  writeHelper(st, 'architect-2', { state: 'working' });
  const view = observeDispatch(st.dir, metadata());
  assert.deepEqual(
    [...view.helpers].sort((a, b) => a.slot.localeCompare(b.slot)),
    [
      { slot: 'architect-2', state: 'working', output_written: false, exit_reason: null },
      { slot: 'review-1', state: 'closed', output_written: true, exit_reason: null },
      { slot: 'sonic-1', state: 'closed', output_written: true, exit_reason: null },
    ]
  );
  assert.deepEqual(view.diagnostics, []);
});

test('a helper snapshot is validated against its slot role and D/<slot>.md output', (t) => {
  const st = stage(t);
  writePrimary(st);
  writeHelper(st, 'sonic-1');
  writeHelper(st, 'review-1', { role: 'review' });
  writeHelper(st, 'architect-2', { output_path: join(st.home, 'architect-2.md') });
  writeRaw(st, '.dispatch/sonic-2', 'not a directory\n');
  const view = observeDispatch(st.dir, metadata());
  assert.deepEqual(
    view.helpers.map((h) => h.slot),
    ['sonic-1']
  );
  assert.deepEqual(
    view.diagnostics.map((d) => d.path).sort(),
    [
      join(st.dir, '.dispatch', 'architect-2', 'STATUS.json'),
      join(st.dir, '.dispatch', 'review-1', 'STATUS.json'),
      join(st.dir, '.dispatch', 'sonic-2', 'STATUS.json'),
    ].sort()
  );
});

test('a null pending-helper reservation is preserved without inventing a helper', (t) => {
  const st = stage(t);
  writePrimary(st, { state: 'waiting_helper', helper_pending: { kind: 'sonic', n: null, status_file: null } });
  const view = observeDispatch(st.dir, metadata());
  assert.deepEqual(view.dispatch?.helper_pending, { kind: 'sonic', n: null, status_file: null });
  assert.deepEqual(view.helpers, []);
  assert.equal(view.state, 'open');
  assert.equal(view.event, undefined);
});

test('a helper failure does not fail the primary', (t) => {
  const st = stage(t);
  writePrimary(st, { state: 'working' });
  writeHelper(st, 'sonic-1', { state: 'failed', error: 'synthetic helper failure', exit_reason: 'error' });
  const view = observeDispatch(st.dir, metadata());
  assert.equal(view.state, 'open');
  assert.equal(view.event, undefined);
  assert.deepEqual(view.helpers, [{ slot: 'sonic-1', state: 'failed', output_written: false, exit_reason: 'error' }]);
});

test('an active helper question is actionable while the primary waits', (t) => {
  const st = stage(t);
  writePrimary(st, { state: 'waiting_helper', helper_pending: { kind: 'sonic', n: 1, status_file: null } });
  writeHelper(st, 'sonic-1', { state: 'waiting_orchestrator' });
  const view = observeDispatch(st.dir, metadata());
  assert.equal(view.state, 'open');
  assert.equal(view.event, 'QUESTION');
});

test('historical unanswered questions remain pointers without waking a different working helper', (t) => {
  const st = stage(t);
  writePrimary(st, { state: 'waiting_helper', helper_pending: { kind: 'sonic', n: 2, status_file: null } });
  writeHelper(st, 'sonic-1', { state: 'closed' });
  writeHelper(st, 'sonic-2', { state: 'working' });
  privateWrite(join(st.dir, 'qa', 'q1.md'), 'historical timed-out question\n');
  const view = observeDispatch(st.dir, metadata());
  assert.equal(view.state, 'open');
  assert.equal(view.event, undefined);
  assert.deepEqual(view.pending, [{ id: 'q1', path: join(st.dir, 'qa', 'q1.md') }]);
});

test('helper_pending.status_file is not permission to read outside the task directory', (t) => {
  const st = stage(t);
  const outside = join(st.home, 'outside');
  const row = statusRow(st.dir, 'sonic-1', 'sonic', join(st.dir, 'sonic-1.md'), { state: 'waiting_orchestrator' });
  privateWrite(join(outside, 'STATUS.json'), `${JSON.stringify(row)}\n`);
  writePrimary(st, {
    state: 'working',
    helper_pending: { kind: 'sonic', n: 1, status_file: join(outside, 'STATUS.json') },
  });
  const view = observeDispatch(st.dir, metadata());
  assert.deepEqual(view.helpers, []);
  assert.equal(view.event, undefined);
});

test('a symlinked .dispatch directory is ignored', (t) => {
  const st = stage(t);
  const outside = join(st.home, 'outside-dispatch');
  const row = statusRow(st.dir, 'sonic-1', 'sonic', join(st.dir, 'sonic-1.md'), { state: 'waiting_orchestrator' });
  privateWrite(join(outside, 'sonic-1', 'STATUS.json'), `${JSON.stringify(row)}\n`);
  symlinkSync(outside, join(st.dir, '.dispatch'));
  writePrimary(st, { state: 'waiting_helper', helper_pending: { kind: 'sonic', n: 1, status_file: null } });
  const view = observeDispatch(st.dir, metadata());
  assert.deepEqual(view.helpers, []);
  assert.equal(view.event, undefined);
  assert.deepEqual(view.diagnostics, [{ path: join(st.dir, '.dispatch'), reason: 'unreadable' }]);
});

test('helper enumeration stops at 64 slots with a truncation diagnostic', (t) => {
  const st = stage(t);
  writePrimary(st);
  for (let n = 1; n <= 65; n += 1) writeHelper(st, `sonic-${n}`);
  const view = observeDispatch(st.dir, metadata());
  assert.equal(view.helpers.length, 64);
  assert.deepEqual(view.diagnostics, [{ path: join(st.dir, '.dispatch'), reason: 'truncated' }]);
});

test('questions stay pending until a nonempty answer is at least as new as the question', (t) => {
  const st = stage(t);
  const qa = join(st.dir, 'qa');
  const question = (id: string): string => {
    privateWrite(join(qa, `${id}.md`), `synthetic question ${id}\n`);
    return join(qa, `${id}.md`);
  };
  const answer = (id: string, text: string): string => {
    privateWrite(join(qa, `${id}.answer.md`), text);
    return join(qa, `${id}.answer.md`);
  };

  question('q1');
  question('q2');
  answer('q2', '   \n');
  question('q3');
  answer('q3', '');
  question('q4');
  utimesSync(answer('q4', 'stale answer\n'), new Date(1_000), new Date(1_000));
  const answered = question('q5');
  answer('q5', 'fresh answer\n');
  utimesSync(answered, new Date(1_000), new Date(1_000));

  assert.deepEqual(
    dispatchQuestions(st.dir).map((p) => p.id),
    ['q1', 'q2', 'q3', 'q4']
  );
});

test('only regular qN.md files are questions', (t) => {
  const st = stage(t);
  const qa = join(st.dir, 'qa');
  privateWrite(join(qa, 'q1.md'), 'one\n');
  privateWrite(join(qa, 'q0.md'), 'zero\n');
  privateWrite(join(qa, 'q01.md'), 'padded\n');
  privateWrite(join(qa, 'q10000.md'), 'too many digits\n');
  privateWrite(join(qa, 'notes.md'), 'notes\n');
  mkdirSync(join(qa, 'q2.md'), { mode: 0o700 });
  assert.deepEqual(
    dispatchQuestions(st.dir).map((p) => p.id),
    ['q1']
  );
});

test('a symlinked qa directory or answer file is not followed', (t) => {
  const st = stage(t);
  const outside = join(st.home, 'outside-qa');
  privateWrite(join(outside, 'q1.md'), 'outside question\n');
  symlinkSync(outside, join(st.dir, 'qa'));
  assert.deepEqual(dispatchQuestions(st.dir), []);

  rmSync(join(st.dir, 'qa'));
  const qa = join(st.dir, 'qa');
  privateWrite(join(qa, 'q1.md'), 'synthetic question\n');
  const outsideAnswer = join(st.home, 'answer.md');
  privateWrite(outsideAnswer, 'answer outside\n');
  symlinkSync(outsideAnswer, join(qa, 'q1.answer.md'));
  assert.deepEqual(
    dispatchQuestions(st.dir).map((p) => p.id),
    ['q1']
  );
});

test('a missing qa directory has no pending questions', (t) => {
  const st = stage(t);
  assert.deepEqual(dispatchQuestions(st.dir), []);
});

test('a continuation baseline suppresses the previous settlement and report', (t) => {
  const st = stage(t);
  writePrimary(st, { state: 'idle_grace', output_written: true, settled_at: BASELINE.previous_settled_at });
  privateWrite(reportPath(st), 'previous round\n');
  const view = observeDispatch(st.dir, metadata('implementer', BASELINE));
  assert.equal(view.continuation, 'unconfirmed');
  assert.equal(view.status, 'idle_grace');
  assert.equal(view.state, 'open');
  assert.equal(view.event, undefined);
  assert.equal(view.report, null);
});

test('a new settled_at completes the continuation even when working was missed', (t) => {
  const st = stage(t);
  writePrimary(st, { state: 'idle_grace', output_written: true, settled_at: '2026-11-08T00:05:00.000Z' });
  privateWrite(reportPath(st), 'new round\n');
  const view = observeDispatch(st.dir, metadata('implementer', BASELINE));
  assert.equal(view.continuation, null);
  assert.equal(view.state, 'done');
  assert.equal(view.event, 'DONE');
  assert.equal(view.report, reportPath(st));
});

test('a new round that is still working is open with no timestamp', (t) => {
  const st = stage(t);
  writePrimary(st, { state: 'working', output_written: false, settled_at: null });
  const view = observeDispatch(st.dir, metadata('implementer', BASELINE));
  assert.equal(view.continuation, null);
  assert.equal(view.state, 'open');
  assert.equal(view.event, undefined);
  assert.equal(view.report, null);
});

test('an unchanged old settlement is unavailable, not a new result', (t) => {
  for (const native of ['closed', 'failed']) {
    const st = stage(t);
    writePrimary(st, { state: native, output_written: true, settled_at: BASELINE.previous_settled_at });
    privateWrite(reportPath(st), 'old round\n');
    const view = observeDispatch(st.dir, metadata('implementer', BASELINE));
    assert.equal(view.continuation, 'unavailable', native);
    assert.equal(view.state, 'open', native);
    assert.equal(view.event, 'BLOCKED', native);
    assert.equal(view.report, null, native);
  }
});

test('a changed session id keeps the continuation unconfirmed', (t) => {
  const st = stage(t);
  writePrimary(st, {
    state: 'idle_grace',
    output_written: true,
    session_id: 'synthetic-session-restarted',
    settled_at: '2026-11-08T00:05:00.000Z',
  });
  privateWrite(reportPath(st), 'restarted round\n');
  const view = observeDispatch(st.dir, metadata('implementer', BASELINE));
  assert.equal(view.continuation, 'unconfirmed');
  assert.equal(view.state, 'open');
  assert.equal(view.event, undefined);
  assert.equal(view.report, null);
});

test('a continuation baseline with no primary snapshot stays unconfirmed', (t) => {
  const st = stage(t);
  const view = observeDispatch(st.dir, metadata('implementer', BASELINE));
  assert.equal(view.continuation, 'unconfirmed');
  assert.equal(view.state, 'launch_unknown');
  assert.equal(view.status, 'unreadable');
  assert.equal(view.event, undefined);
});

test('a persisted continuation baseline behaves the same after a restart', (t) => {
  const st = stage(t);
  writePrimary(st, { state: 'idle_grace', output_written: true, settled_at: BASELINE.previous_settled_at });
  privateWrite(reportPath(st), 'previous round\n');
  const live = observeDispatch(st.dir, metadata('implementer', BASELINE));
  const restored = JSON.parse(JSON.stringify(metadata('implementer', BASELINE))) as PiDispatch;
  assert.deepEqual(observeDispatch(st.dir, restored), live);
  assert.equal(live.continuation, 'unconfirmed');
  assert.equal(live.event, undefined);
});

test('waitDispatch returns a preexisting event immediately', async () => {
  let calls = 0;
  const started = performance.now();
  const result = await waitDispatch(async () => {
    calls += 1;
    return { event: 'DONE' as const, state: 'done' };
  }, 60_000);
  assert.deepEqual(result, { event: 'DONE', state: 'done' });
  assert.equal(calls, 1);
  assert.ok(performance.now() - started < 1_000);
});

test('waitDispatch with a zero timeout observes once and times out', async () => {
  let calls = 0;
  const result = await waitDispatch(async (remaining): Promise<{ event?: 'DONE'; state: string }> => {
    calls += 1;
    assert.ok(remaining >= 0);
    return { state: 'open' };
  }, 0);
  assert.equal(result.event, 'timeout');
  assert.equal(calls, 1);
});

test('waitDispatch sleeps between polls instead of busy looping', async () => {
  const budgets: number[] = [];
  const started = performance.now();
  const result = await waitDispatch(async (remaining): Promise<{ event?: 'DONE'; state: string }> => {
    budgets.push(remaining);
    return { state: 'open' };
  }, 30);
  const elapsed = performance.now() - started;
  assert.equal(result.event, 'timeout');
  assert.ok(budgets.length <= 3, `expected a sleeping poll loop, saw ${budgets.length} calls`);
  assert.ok(budgets[0]! > 0 && budgets[0]! <= 30, `first budget was ${budgets[0]}`);
  assert.ok(elapsed >= 25, `expected an actual sleep, saw ${elapsed.toFixed(1)}ms`);
  assert.ok(elapsed < 2_000, `expected a bounded wait, saw ${elapsed.toFixed(1)}ms`);
});

test('independent waiters do not consume each other’s event', async () => {
  let event: 'QUESTION' | undefined;
  const observe = async (): Promise<{ event: 'QUESTION' | undefined }> => ({ event });
  const first = waitDispatch(observe, 3_000);
  const second = waitDispatch(observe, 3_000);
  await delay(10);
  event = 'QUESTION';
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.event, 'QUESTION');
  assert.equal(b.event, 'QUESTION');
});
