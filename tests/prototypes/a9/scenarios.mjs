import {
  accept,
  arm,
  assert,
  countSubmissions,
  event,
  evidence,
  existsSync,
  hash,
  inspectScope,
  join,
  json,
  live,
  now,
  observationClock,
  receiptPath,
  sameInstance,
  scopeOf,
  signal,
  stat,
  tx,
  until,
  value,
  writeFileSync,
} from './common.mjs';

export async function newIntent(f, key = 'synthetic-key') {
  return accept(f.db, f.ctx, f.origin, key, { mode: 'headless' });
}

export function attachScope(
  f,
  accepted,
  harness,
  { leader = harness, launchers = [stat(process.pid)], sealed = launchers, writers = [] } = {}
) {
  const scope = { ...scopeOf(leader), harness };
  tx(f.db, () => {
    f.db
      .prepare("UPDATE runs SET scope_ref=?,launch_phase='submitted' WHERE run_id=?")
      .run(json(scope), accepted.runId);
    evidence(f.db, 'launch_receipt', { harness, launchers, launchersComplete: true, sealed, writers }, accepted.runId);
  });
  return scope;
}

export async function launched(suite, f, cut, extra = {}) {
  const accepted = await newIntent(f);
  const supervisor = suite.peer('supervisor', {
    path: f.path,
    runId: accepted.runId,
    ticket: accepted.ticket,
    directory: f.directory,
    cut,
    ...extra,
  });
  const ready = await supervisor.wait(cut ? 'cut' : 'submitted');
  return { accepted, supervisor, ...ready };
}

export async function recover(suite, f, runId, options = {}) {
  const peer = suite.peer('recovery', { path: f.path });
  await peer.wait('ready');
  const result = value(await peer.call('reconcile', { runId, options }));
  await peer.stop();
  return result;
}

export async function killStamp(stamp) {
  signal(stamp, 'SIGKILL');
  await until(() => !sameInstance(stamp, stat(stamp.pid)) || !live(stat(stamp.pid)), 'owned workload terminated');
}

export function held(f, runId) {
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM slots WHERE run_id=?').get(runId).n, 1);
}

export function released(f, runId, state) {
  assert.equal(f.db.prepare('SELECT state FROM runs WHERE run_id=?').get(runId).state, state);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM slots WHERE run_id=?').get(runId).n, 0);
}

export function fence(f, runId) {
  f.db
    .prepare('UPDATE runs SET submission_fenced_at=? WHERE run_id=? AND submission_fenced_at IS NULL')
    .run(now(), runId);
}

export function cancel(f, runId) {
  const initial = f.db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId);
  const scope = initial.scope_ref && JSON.parse(initial.scope_ref);
  let acceptedSeq = null;
  const result = tx(f.db, () => {
    const run = f.db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId);
    if (['ended', 'cancelled', 'failed'].includes(run.state)) return 'already_ended';
    if (run.cancel_requested_at == null) {
      const clock = observationClock();
      f.db.prepare("UPDATE runs SET cancel_requested_at=?,state='cancelling' WHERE run_id=?").run(clock.at, runId);
      acceptedSeq = Number(event(f.db, 'cancel.accepted', runId, { clock, scopeId: scope?.scope_id }).lastInsertRowid);
    }
    return 'accepted';
  });
  if (acceptedSeq != null) {
    // This kernel observation follows the committed intent, including any write-lock wait.
    const group = inspectScope(scope);
    const clock = observationClock();
    tx(f.db, () =>
      event(f.db, 'cancel.scope_observed', runId, { acceptedSeq, clock, scopeId: scope?.scope_id, group })
    );
  }
  return result;
}

export function groupSignal(scope, signalName) {
  assert.ok(sameInstance(scope.group_leader, stat(scope.group_leader.pid)), 'safe group instance still owned');
  assert.equal(scope.pgid, scope.group_leader.pid, 'test group created by detached child');
  process.kill(-scope.pgid, signalName);
}

export function writeReceipt(f, accepted, scope, native = null, shellStatus = null, scopeEnded = null) {
  if (native) assert.ok(sameInstance(native.process, scope.harness), 'wait result must name real harness');
  writeFileSync(
    receiptPath(accepted.runId),
    json({
      runId: accepted.runId,
      sourceId: f.origin.sourceId,
      generation: 1,
      scopeId: scope.scope_id,
      native,
      shellStatus,
      scopeEnded,
    }),
    { mode: 0o600 }
  );
}

export async function nativeRun(suite, f, code, extra = {}) {
  const accepted = await newIntent(f);
  assert.equal(arm(f.db, accepted.runId, accepted.ticket, stat(process.pid)), true);
  f.db.prepare("UPDATE runs SET launch_phase='submitting' WHERE run_id=?").run(accepted.runId);
  const workload = suite.peer('workload', {
    detached: true,
    directory: f.directory,
    exitCode: code,
    delay: 250,
    ...extra,
  });
  const ready = await workload.wait('ready');
  const scope = attachScope(f, accepted, ready.stamp);
  const item = { accepted, workload, scope, stamp: ready.stamp };
  item.wait = workload.closed.then((actual) => {
    const group = inspectScope(scope);
    const harnessTerminated = !live(stat(ready.stamp.pid));
    item.scopeEnded = {
      clock: observationClock(),
      scopeId: scope.scope_id,
      group,
      harnessTerminated,
      launchersSealed: true,
      source: 'wait_status_and_complete_scope_check',
    };
    return actual;
  });
  return item;
}

export async function nativeReceipt(suite, f, item, code) {
  const actual = await item.wait;
  assert.equal(actual.code, code);
  assert.equal(actual.signal, null);
  writeReceipt(
    f,
    item.accepted,
    item.scope,
    {
      process: item.stamp,
      subject: 'harness',
      code: actual.code,
      signal: null,
      source: 'wait_status',
    },
    null,
    item.scopeEnded
  );
  return recover(suite, f, item.accepted.runId);
}

export async function crashMatrix(suite, detail) {
  for (const point of ['armed', 'submitting', 'after_spawn']) {
    const f = suite.fixture(`crash-${point}`);
    const item = await launched(suite, f, point);
    const exit = await item.supervisor.stop();
    assert.equal(exit.signal, 'SIGKILL');
    const before = countSubmissions(f.directory);
    assert.equal(before, point === 'after_spawn' ? 1 : 0);
    const observed = await recover(suite, f, item.accepted.runId);
    assert.equal(observed.state, 'uncertain');
    held(f, item.accepted.runId);
    assert.equal(arm(f.db, item.accepted.runId, item.accepted.ticket, stat(process.pid)), false);
    assert.equal(countSubmissions(f.directory), before);
    if (item.harness) {
      await killStamp(item.harness);
      const final = await recover(suite, f, item.accepted.runId);
      assert.equal(final.basis, 'Q');
    } else if (point === 'armed') {
      fence(f, item.accepted.runId);
      const final = await recover(suite, f, item.accepted.runId);
      assert.equal(final.basis, 'N');
    } else {
      fence(f, item.accepted.runId);
      assert.equal(
        (await recover(suite, f, item.accepted.runId)).state,
        'uncertain',
        'submitting with no proof cannot become N'
      );
    }
    detail.push({
      point,
      writerPid: item.supervisor.pid,
      killedBy: exit.signal,
      submissionsBeforeRecovery: before,
      submissionsAfterRecovery: countSubmissions(f.directory),
      observed,
    });
    f.db.close();
  }
}

export async function pausedLauncher(suite, detail) {
  const f = suite.fixture('paused-launcher');
  const accepted = await newIntent(f);
  const launcher = suite.peer('delayed-shell', { detached: true, directory: f.directory });
  const ready = await launcher.wait('ready');
  assert.equal(arm(f.db, accepted.runId, accepted.ticket, ready.stamp), true);
  f.db.prepare("UPDATE runs SET launch_phase='submitting' WHERE run_id=?").run(accepted.runId);
  signal(ready.stamp, 'SIGSTOP');
  await until(() => stat(ready.stamp.pid)?.state === 'T', 'launcher actually stopped');
  fence(f, accepted.runId);
  const observed = await recover(suite, f, accepted.runId);
  assert.equal(observed.state, 'uncertain');
  assert.equal(observed.N, false);
  held(f, accepted.runId);
  assert.equal(countSubmissions(f.directory), 0);
  signal(ready.stamp, 'SIGCONT');
  await until(() => countSubmissions(f.directory) === 1, 'original paused launcher can still dispatch');
  detail.push({
    condition: 'actual SIGSTOP launcher retains previously permitted dispatch despite DB fence',
    state: observed.state,
    submissionsFromOriginalLauncherAfterCONT: 1,
  });
  f.db.close();
}

export async function nonExecutionFence(suite, detail) {
  for (const phase of ['reserved', 'armed', 'submitting']) {
    const f = suite.fixture(`fence-${phase}`);
    const accepted = await newIntent(f);
    if (phase !== 'reserved') {
      const supervisor = suite.peer('supervisor', {
        path: f.path,
        runId: accepted.runId,
        ticket: accepted.ticket,
        directory: f.directory,
        cut: phase,
      });
      await supervisor.wait('cut');
      assert.equal((await supervisor.stop()).signal, 'SIGKILL');
    }
    fence(f, accepted.runId);
    const result = await recover(suite, f, accepted.runId);
    assert.equal(result.state, phase === 'submitting' ? 'uncertain' : 'failed');
    const late = suite.peer('supervisor', {
      path: f.path,
      runId: accepted.runId,
      ticket: accepted.ticket,
      directory: f.directory,
    });
    assert.equal((await late.wait('result')).value.won, false);
    assert.equal(countSubmissions(f.directory), 0);
    detail.push({ phase, result, lateSubmissions: 0 });
    f.db.close();
  }
}

export async function scopeStates(suite, detail) {
  {
    const f = suite.fixture('surviving-group');
    const accepted = await newIntent(f);
    arm(f.db, accepted.runId, accepted.ticket, stat(process.pid));
    const leader = suite.peer('group', { detached: true, leave: true });
    const ready = await leader.wait('ready');
    const scope = attachScope(f, accepted, ready.stamp);
    assert.equal((await leader.closed).code, 0);
    await until(() => stat(ready.member.pid)?.state === 'S', 'live sleeping group member');
    const sleeping = await recover(suite, f, accepted.runId);
    held(f, accepted.runId);
    assert.equal(sleeping.group.result, 'alive');
    signal(ready.member, 'SIGSTOP');
    await until(() => stat(ready.member.pid)?.state === 'T', 'live stopped group member');
    const stopped = await recover(suite, f, accepted.runId);
    held(f, accepted.runId);
    assert.equal(stopped.group.result, 'alive');
    assert.equal(live({ state: 'D' }), true, 'synthetic classification only; not live-induced D');
    await killStamp(ready.member);
    const drained = await recover(suite, f, accepted.runId);
    assert.equal(drained.state, 'ended');
    detail.push({
      actualLeaderExited: true,
      sleeping,
      stopped,
      drained,
      syntheticOnly: 'D-state classification',
      scope,
    });
    f.db.close();
  }
  {
    const f = suite.fixture('zombie-only');
    const accepted = await newIntent(f);
    arm(f.db, accepted.runId, accepted.ticket, stat(process.pid));
    const keeper = suite.peer('zombie');
    const ready = await keeper.wait('ready');
    const scope = attachScope(f, accepted, ready.zombie, { launchers: [ready.stamp], sealed: [ready.stamp] });
    await until(() => stat(ready.zombie.pid)?.state === 'Z', 'real unreaped zombie');
    const observed = await recover(suite, f, accepted.runId);
    assert.equal(observed.state, 'ended');
    assert.equal(observed.group.zombies.length, 1);
    released(f, accepted.runId, 'ended');
    await keeper.wait('reaped');
    detail.push({ actualZ: true, scope, observed });
    f.db.close();
  }
  for (const role of ['ordinary-tool', 'original-harness', 'same-session-writer']) {
    const f = suite.fixture(`escaped-${role}`);
    const accepted = await newIntent(f);
    arm(f.db, accepted.runId, accepted.ticket, stat(process.pid));
    const harness = suite.peer('workload', { detached: true });
    const escaped = suite.peer('workload', { detached: true });
    const main = (await harness.wait('ready')).stamp;
    const outside = (await escaped.wait('ready')).stamp;
    const scope = attachScope(f, accepted, main, { writers: role === 'ordinary-tool' ? [] : [outside] });
    assert.notEqual(main.sid, outside.sid, 'real setsid escape stand-in');
    await harness.stop();
    const observed = await recover(suite, f, accepted.runId);
    assert.equal(observed.state, role === 'ordinary-tool' ? 'ended' : 'uncertain');
    assert.equal(live(stat(outside.pid)), true);
    if (role !== 'ordinary-tool') held(f, accepted.runId);
    detail.push({ role, outside, scope, observed });
    f.db.close();
  }
}

export async function qProofs(suite, detail, cancelled = false) {
  const f = suite.fixture(cancelled ? 'q-cancel' : 'q-end');
  const item = await launched(suite, f);
  if (cancelled) cancel(f, item.accepted.runId);
  assert.equal((await item.supervisor.stop()).signal, 'SIGKILL');
  const liveObservation = await recover(suite, f, item.accepted.runId);
  assert.equal(liveObservation.state, 'uncertain');
  held(f, item.accepted.runId);
  await killStamp(item.stamp);
  assert.equal(existsSync(receiptPath(item.accepted.runId)), false);
  const complete = await recover(suite, f, item.accepted.runId);
  assert.equal(complete.basis, 'Q');
  released(f, item.accepted.runId, cancelled ? 'cancelled' : 'ended');
  assert.equal(f.db.prepare('SELECT exit_code FROM runs WHERE run_id=?').get(item.accepted.runId).exit_code, null);
  assert.equal(existsSync(receiptPath(item.accepted.runId)), false, 'recovery never writes dead-writer receipt');
  assert.equal(countSubmissions(f.directory), 1);
  detail.push({ noLeaderOrExitReceipt: true, complete, submissions: 1 });
  f.db.close();
  for (const missing of [
    'scope',
    'launch_record',
    'harness',
    'launchers',
    'launchersComplete',
    'sealed',
    'visibility',
  ]) {
    const g = suite.fixture(`q-missing-${missing}-${cancelled}`);
    const partial = await launched(suite, g, undefined, { omitProof: missing === 'visibility' ? undefined : missing });
    if (cancelled) cancel(g, partial.accepted.runId);
    if (missing !== 'sealed') await partial.supervisor.stop();
    await killStamp(partial.stamp);
    const observed = await recover(
      suite,
      g,
      partial.accepted.runId,
      missing === 'visibility' ? { visibility: 'partial' } : {}
    );
    assert.equal(observed.state, 'uncertain', `Q needs actual ${missing} evidence`);
    held(g, partial.accepted.runId);
    if (['launchers', 'launchersComplete', 'sealed'].includes(missing)) assert.equal(observed.launchersSealed, false);
    const record = g.db
      .prepare("SELECT payload FROM evidence WHERE run_id=? AND kind='launch_receipt'")
      .get(partial.accepted.runId);
    detail.push({
      omittedActualField: missing,
      liveUnsealedLauncher: missing === 'sealed',
      startupRecord: record ? JSON.parse(record.payload) : null,
      observed,
    });
    await partial.supervisor.stop();
    g.db.close();
  }
}
