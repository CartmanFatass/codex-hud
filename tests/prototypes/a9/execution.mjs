import {
  accept,
  arm,
  assert,
  context,
  countSubmissions,
  event,
  evidence,
  existsSync,
  harnessPeer,
  id,
  join,
  killedAt,
  meta,
  mergeOwner,
  newCaller,
  now,
  procOwner,
  readFileSync,
  session,
  sessionOwner,
  signal,
  snapshot,
  stat,
  Suite,
  tx,
  until,
  value,
  writeFileSync,
} from './common.mjs';
import {
  attachScope,
  cancel,
  crashMatrix,
  fence,
  groupSignal,
  held,
  killStamp,
  launched,
  nativeReceipt,
  nativeRun,
  newIntent,
  nonExecutionFence,
  qProofs,
  recover,
  released,
  scopeStates,
  writeReceipt,
} from './scenarios.mjs';

const suite = new Suite('execution');
const spawn = (h, f, key, extra = {}, name) =>
  h.call('spawn', { params: meta(), key, directory: f.directory, ...extra }, name);

await suite.test(
  'T-02-1',
  'two MCP processes contend on real SQLite: one intent, one submission; divergent params rejected',
  async (detail) => {
    const f = suite.fixture('race');
    const h = await harnessPeer(suite, f);
    const a = await h.start('a');
    const b = await h.start('b');
    assert.notEqual(a.stamp.pid, b.stamp.pid);
    await h.call('identify', { params: meta() }, 'a');
    await h.call('identify', { params: meta() }, 'b');
    // Deliberately hold the write lock to prove that the second process actually contends.
    const lockPath = join(f.directory, 'lock-held');
    const first = spawn(h, f, 'race-key', { lockPath }, 'a');
    await until(() => existsSync(lockPath), 'first MCP holds SQLite writer lock');
    const [left, right] = await Promise.all([first, spawn(h, f, 'race-key', {}, 'b')]);
    assert.equal(left.runId, right.runId);
    assert.equal(left.linkId, right.linkId);
    assert.equal(left.state, right.state);
    assert.ok(right.busyRetries > 0, 'second OS process encountered SQLite lock contention');
    assert.deepEqual(snapshot(f.db), { links: 1, runs: 1, claims: 1, idempotency: 1, slots: 1, events: 1 });
    assert.equal(countSubmissions(f.directory), 1);
    await assert.rejects(() => spawn(h, f, 'race-key', { control: { mode: 'visible' } }, 'b'), /idempotency_conflict/);
    assert.equal(countSubmissions(f.directory), 1);
    detail.push({
      left,
      right,
      submitted: 1,
      countAfterDifferentParams: 1,
      database: 'real file, WAL, foreign_keys=ON, schema v1',
    });
    f.db.close();
  }
);

await suite.test(
  'T-02-3',
  'MCP restart after accepted and SIGKILL after external submission both replay original outcome',
  async (detail) => {
    for (const point of ['after_reply', 'before_reply']) {
      const f = suite.fixture(`mcp-${point}`);
      const h = await harnessPeer(suite, f);
      const firstCaller = await h.start('a', point === 'before_reply' ? point : undefined);
      let original;
      let pending;
      if (point === 'before_reply') {
        pending = spawn(h, f, 'restart-key', {}, 'a').catch((error) => ({ lostResponse: error.message }));
        const cut = value(await h.peer.call('wait-cut', { name: 'a' }));
        assert.equal(cut.point, 'before_reply');
        original = f.db.prepare('SELECT * FROM idempotency WHERE request_key=?').get('restart-key');
      } else {
        await spawn(h, f, 'restart-key', {}, 'a');
        original = f.db.prepare('SELECT * FROM idempotency WHERE request_key=?').get('restart-key');
      }
      const exited = value(await h.peer.call('stop', { name: 'a' }));
      assert.equal(exited.signal, 'SIGKILL');
      if (pending) await pending;
      const secondCaller = await h.start('b');
      const replay = await spawn(h, f, 'restart-key', {}, 'b');
      assert.notEqual(firstCaller.callerId, secondCaller.callerId);
      assert.equal(replay.ctx.owner, original.owner_key);
      assert.equal(replay.runId, original.run_id);
      assert.equal(replay.linkId, original.link_id);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM idempotency').get().n, 1);
      assert.equal(countSubmissions(f.directory), 1);
      assert.equal(stat(h.stamp.pid).proc_start, h.stamp.proc_start);
      detail.push({
        point,
        killedMcp: firstCaller.stamp,
        newMcp: secondCaller.stamp,
        harness: h.stamp,
        original: JSON.parse(original.outcome),
        replay,
        submissions: 1,
      });
      f.db.close();
    }
  }
);

await suite.test(
  'T-02-4',
  'atomic proc-to-session UPDATE preserves outcome/time/origin; restart and closed-alias replay',
  async (detail) => {
    const f = suite.fixture('rekey');
    const h = await harnessPeer(suite, f, { bound: false });
    await h.start();
    const first = await spawn(h, f, 'rekey-key');
    const prior = f.db.prepare('SELECT * FROM idempotency WHERE request_key=?').get('rekey-key');
    assert.equal(JSON.parse(prior.owner_key)[0], 'proc');
    value(await h.peer.call('bound'));
    const bound = await h.call('identify', { params: meta() });
    const after = f.db.prepare('SELECT * FROM idempotency WHERE request_key=?').get('rekey-key');
    assert.equal(after.owner_key, sessionOwner(bound.session_ref));
    for (const key of ['origin_owner_key', 'params_digest', 'params_version', 'outcome', 'at', 'link_id', 'run_id'])
      assert.equal(after[key], prior[key]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM idempotency').get().n, 1);
    assert.equal(
      f.db.prepare('SELECT parent_ref FROM links WHERE link_id=?').get(first.linkId).parent_ref,
      bound.session_ref
    );
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM events WHERE kind='owner.merged'").get().n, 1);
    await h.peer.call('stop');
    await h.start('new');
    assert.equal((await spawn(h, f, 'rekey-key', {}, 'new')).runId, first.runId);
    value(await h.peer.call('switch', { ctx: bound, sessionId: 'synthetic-session' }));
    assert.equal((await spawn(h, f, 'rekey-key', {}, 'new')).runId, first.runId);
    const alias = f.db
      .prepare('SELECT * FROM owner_aliases WHERE process_key=? AND generation=?')
      .get(bound.process_key, bound.generation);
    assert.ok(alias.closed_at);
    const currentCtx = await h.call('identify', { params: meta() }, 'new');
    value(await h.peer.call('switch', { ctx: currentCtx, sessionId: 'synthetic-unbound', bound: false }));
    const unbound = await h.call('identify', { params: meta('synthetic-unbound') }, 'new');
    assert.equal(
      f.db.prepare('SELECT * FROM idempotency WHERE owner_key=? AND request_key=?').get(unbound.owner, 'rekey-key'),
      undefined
    );
    assert.equal(countSubmissions(f.directory), 1);
    detail.push({
      before: prior,
      after,
      closedAlias: true,
      newGenerationProcCannotBorrow: true,
      originalRun: first.runId,
    });
    f.db.close();

    const g = suite.fixture('rekey-atomic-reader', false);
    const accepted = await newIntent(g);
    const before = g.db.prepare('SELECT * FROM idempotency').get();
    const merging = suite.peer('merge', { path: g.path, ctx: g.ctx, ref: g.ref, cut: 'merge_updated' });
    await merging.wait('cut');
    assert.deepEqual(g.db.prepare('SELECT * FROM idempotency').get(), before, 'WAL reader never sees partial rekey');
    assert.equal(g.db.prepare('SELECT count(*) AS n FROM owner_aliases').get().n, 0);
    assert.equal(g.db.prepare('SELECT parent_ref FROM links WHERE link_id=?').get(accepted.linkId).parent_ref, null);
    assert.equal((await merging.stop()).signal, 'SIGKILL');
    assert.deepEqual(g.db.prepare('SELECT * FROM idempotency').get(), before);
    const committed = suite.peer('merge', { path: g.path, ctx: g.ctx, ref: g.ref });
    assert.equal((await committed.wait('result')).owner, sessionOwner(g.ref));
    const replay = await accept(g.db, g.ctx, g.origin, 'synthetic-key', { mode: 'headless' });
    assert.equal(replay.runId, accepted.runId);
    assert.equal(g.db.prepare('SELECT count(*) AS n FROM idempotency').get().n, 1);
    detail.push({
      rekeyCrash: 'SIGKILL after updates before merge event/commit',
      readerSawOnlyOriginal: true,
      afterCommitReplayRunId: replay.runId,
    });
    g.db.close();
  }
);

await suite.test(
  'T-02-5',
  'merge rejects different params, different outcomes, and same-generation double alias atomically',
  async (detail) => {
    for (const difference of ['params', 'outcome', 'alias']) {
      const f = suite.fixture(`merge-${difference}`, false);
      const first = await accept(f.db, f.ctx, f.origin, 'collision', { mode: 'headless' });
      if (difference !== 'alias') {
        const other = suite.peer('workload');
        const stamp = (await other.wait('ready')).stamp;
        const otherCtx = tx(f.db, () => context(f.db, f.origin, stamp, newCaller(f.db, f.origin), f.ref));
        await accept(f.db, otherCtx, f.origin, 'collision', { mode: difference === 'params' ? 'visible' : 'headless' });
        const before = snapshot(f.db);
        const rows = f.db.prepare('SELECT * FROM idempotency ORDER BY owner_key').all();
        assert.throws(() => mergeOwner(f.db, f.ctx, f.ref), /merge_conflict/);
        assert.deepEqual(f.db.prepare('SELECT * FROM idempotency ORDER BY owner_key').all(), rows);
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM owner_aliases').get().n, 0);
        assert.equal(snapshot(f.db).runs, before.runs);
        assert.equal(f.db.prepare('SELECT parent_ref FROM links WHERE link_id=?').get(first.linkId).parent_ref, null);
      } else {
        mergeOwner(f.db, f.ctx, f.ref);
        const secondRef = session(f.db, f.origin, 'synthetic-other');
        assert.throws(() => mergeOwner(f.db, f.ctx, secondRef), /alias_conflict/);
        assert.equal(f.db.prepare('SELECT session_ref FROM owner_aliases').get().session_ref, f.ref);
      }
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM events WHERE kind='identity.conflict'").get().n, 1);
      assert.equal(countSubmissions(f.directory), 0);
      detail.push({ difference, snapshots: snapshot(f.db), zeroNewSubmission: true });
      f.db.close();
    }
  }
);

await suite.test(
  'T-02-6',
  'SIGKILL after each intent insert and terminal mutation proves all-or-nothing SQLite commits',
  async (detail) => {
    for (const point of [
      'links',
      'runs',
      'claims',
      'idempotency',
      'slots',
      'events',
      'before_commit',
      'after_commit',
    ]) {
      const f = suite.fixture(`atomic-${point}`);
      detail.push(await killedAt(suite, f, 'intent', point));
      const committed = point === 'after_commit' ? 1 : 0;
      assert.deepEqual(snapshot(f.db), {
        links: committed,
        runs: committed,
        claims: committed,
        idempotency: committed,
        slots: committed,
        events: committed,
      });
      assert.equal(countSubmissions(f.directory), 0);
      if (point === 'after_commit') {
        const runId = f.db.prepare('SELECT run_id FROM runs').get().run_id;
        assert.equal((await recover(suite, f, runId, { age: 30001 })).state, 'uncertain');
        assert.equal(countSubmissions(f.directory), 0, 'recovery never dispatches committed intent');
      }
      f.db.close();
    }
    for (const point of [
      'terminal_evidence',
      'terminal_state',
      'terminal_claim',
      'terminal_slot',
      'terminal_event',
      'terminal_before_commit',
      'terminal_after_commit',
    ]) {
      const f = suite.fixture(`atomic-${point}`);
      const accepted = await newIntent(f);
      fence(f, accepted.runId);
      detail.push(await killedAt(suite, f, 'terminal', point, { runId: accepted.runId }));
      const run = f.db.prepare('SELECT * FROM runs WHERE run_id=?').get(accepted.runId);
      assert.equal(run.state, point === 'terminal_after_commit' ? 'failed' : 'starting');
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM slots').get().n, point === 'terminal_after_commit' ? 0 : 1);
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM events WHERE kind='run.failed'").get().n,
        point === 'terminal_after_commit' ? 1 : 0
      );
      assert.equal(
        f.db.prepare('SELECT state FROM claims WHERE run_id=?').get(accepted.runId).state,
        point === 'terminal_after_commit' ? 'revoked' : 'issued'
      );
      f.db.close();
    }
  }
);

await suite.test(
  'T-02-8',
  'reserved 0/30000/30001 boundaries, two OS supervisors race one ticket, crash/fence never resubmits',
  async (detail) => {
    for (const age of [0, 30000, 30001]) {
      const f = suite.fixture(`window-${age}`);
      const accepted = await newIntent(f);
      const observed = await recover(suite, f, accepted.runId, { age });
      assert.equal(observed.state, age <= 30000 ? 'starting' : 'uncertain');
      const actors = [0, 1].map(() =>
        suite.peer('supervisor', {
          path: f.path,
          runId: accepted.runId,
          ticket: accepted.ticket,
          directory: f.directory,
          barrier: true,
        })
      );
      await Promise.all(actors.map((peer) => peer.wait('ready')));
      for (const peer of actors) peer.child.send({ action: 'go' });
      const results = await Promise.all(actors.map((peer) => peer.wait('result')));
      assert.equal(results.filter((result) => result.value.won).length, age <= 30000 ? 1 : 0);
      assert.equal(countSubmissions(f.directory), age <= 30000 ? 1 : 0);
      detail.push({
        age,
        observed,
        supervisors: actors.map((peer) => peer.pid),
        winners: results.filter((r) => r.value.won).length,
      });
      f.db.close();
    }
    {
      const f = suite.fixture('heartbeat-only');
      const item = await launched(suite, f, 'armed');
      assert.equal(
        (await recover(suite, f, item.accepted.runId)).state,
        'starting',
        'heartbeat without child cannot imply running'
      );
      f.db.close();
    }
    await crashMatrix(suite, detail);
    await nonExecutionFence(suite, detail);
  }
);

await suite.test(
  'T-02-12',
  'only proved non-execution fails; logs/nonzero supervisor and crash after command remain uncertain',
  async (detail) => {
    await nonExecutionFence(suite, detail);
    for (const reason of ['preflight-log-only', 'supervisor-nonzero']) {
      const f = suite.fixture(reason);
      let item;
      if (reason === 'supervisor-nonzero') {
        const accepted = await newIntent(f);
        const supervisor = suite.peer('supervisor', {
          path: f.path,
          runId: accepted.runId,
          ticket: accepted.ticket,
          directory: f.directory,
          exitAfterArmed: 7,
        });
        assert.equal((await supervisor.closed).code, 7);
        item = { accepted, supervisor };
      } else {
        item = await launched(suite, f, 'armed');
        tx(f.db, () => event(f.db, 'preflight.error', item.accepted.runId, { synthetic: true }));
        await item.supervisor.stop();
      }
      const observed = await recover(suite, f, item.accepted.runId);
      assert.equal(observed.state, 'uncertain');
      held(f, item.accepted.runId);
      detail.push({ reason, observed });
      f.db.close();
    }
    const f = suite.fixture('executed-no-writeback');
    const item = await launched(suite, f, 'after_spawn');
    await item.supervisor.stop();
    for (let i = 0; i < 2; i += 1) assert.equal((await recover(suite, f, item.accepted.runId)).state, 'uncertain');
    assert.equal(countSubmissions(f.directory), 1);
    assert.equal(arm(f.db, item.accepted.runId, item.accepted.ticket, stat(process.pid)), false);
    detail.push({ afterCommandBeforeWriteback: true, submissions: 1 });
    f.db.close();
  }
);

await suite.test(
  'T-02-14',
  'sourced native 0/7 vs NULL native, N/Q, real S/T/Z/escapes and labelled D/boot observations',
  async (detail) => {
    for (const code of [0, 7]) {
      const f = suite.fixture(`native-${code}`);
      const item = await nativeRun(suite, f, code);
      const observed = await nativeReceipt(suite, f, item, code);
      assert.equal(observed.state, 'ended');
      assert.equal(f.db.prepare('SELECT exit_code FROM runs WHERE run_id=?').get(item.accepted.runId).exit_code, code);
      detail.push({ realWaitCode: code, observed });
      f.db.close();
    }
    for (const shellStatus of [0, 137]) {
      const f = suite.fixture(`shell-${shellStatus}`);
      const accepted = await newIntent(f);
      arm(f.db, accepted.runId, accepted.ticket, stat(process.pid));
      const shell = suite.peer('shell', { exitCode: 0, shellStatus });
      const ready = await shell.wait('ready');
      const scope = attachScope(f, accepted, ready.harness, {
        leader: ready.commandLeader,
        launchers: [ready.stamp, ready.commandLeader],
        sealed: [ready.stamp],
      });
      const actual = await shell.wait('shell-exit');
      assert.equal(actual.code, shellStatus);
      writeReceipt(f, accepted, scope, null, actual.code);
      const observed = await recover(suite, f, accepted.runId);
      const run = f.db.prepare('SELECT * FROM runs WHERE run_id=?').get(accepted.runId);
      assert.equal(observed.state, 'ended');
      assert.equal(run.exit_code, null);
      assert.equal(run.exit_signal, null);
      assert.equal(run.shell_status, shellStatus);
      detail.push({ shellStatus, native: null, observationSource: 'actual /bin/sh wait status', observed });
      f.db.close();
    }
    await nonExecutionFence(suite, detail);
    await qProofs(suite, detail);
    await scopeStates(suite, detail);
  }
);

await suite.test(
  'T-02-15',
  'cancel waits for actual group exit; unconfirmed control holds slot; late cancel and receiptless Q',
  async (detail) => {
    {
      const f = suite.fixture('cancel-live');
      const item = await launched(suite, f);
      assert.equal(cancel(f, item.accepted.runId), 'accepted');
      groupSignal(item.scope, 'SIGSTOP');
      await until(() => stat(item.stamp.pid)?.state === 'T', 'workload stopped before interrupt');
      groupSignal(item.scope, 'SIGINT');
      const afterSignal = await recover(suite, f, item.accepted.runId);
      assert.ok(['cancelling', 'uncertain'].includes(afterSignal.state));
      held(f, item.accepted.runId);
      tx(f.db, () =>
        event(f.db, 'cancel_unconfirmed', item.accepted.runId, { reason: 'synthetic control visibility loss' })
      );
      const unconfirmed = await recover(suite, f, item.accepted.runId, { visibility: 'partial' });
      held(f, item.accepted.runId);
      groupSignal(item.scope, 'SIGKILL');
      await until(() => !stat(item.stamp.pid) || stat(item.stamp.pid).state === 'Z', 'entire group exits');
      const complete = await recover(suite, f, item.accepted.runId);
      assert.equal(complete.state, 'cancelled');
      released(f, item.accepted.runId, 'cancelled');
      detail.push({ afterSignal, unconfirmed, complete, actualSignals: ['SIGSTOP', 'SIGINT', 'SIGKILL'] });
      f.db.close();
    }
    for (const timing of ['cancel-before-exit', 'exit-before-cancel', 'exit-before-cancel-before-import']) {
      const f = suite.fixture(timing);
      const item = await nativeRun(suite, f, 0);
      if (timing === 'cancel-before-exit') cancel(f, item.accepted.runId);
      if (timing === 'exit-before-cancel-before-import') {
        await item.wait;
        assert.equal(
          f.db.prepare('SELECT state FROM runs WHERE run_id=?').get(item.accepted.runId).state,
          'starting',
          'wait observed exit but ledger not yet terminal'
        );
        held(f, item.accepted.runId);
        assert.equal(cancel(f, item.accepted.runId), 'accepted');
      }
      const observed = await nativeReceipt(suite, f, item, 0);
      assert.equal(observed.state, timing === 'cancel-before-exit' ? 'cancelled' : 'ended');
      if (timing === 'exit-before-cancel') assert.equal(cancel(f, item.accepted.runId), 'already_ended');
      if (timing === 'exit-before-cancel-before-import') {
        assert.equal(observed.cancelResult, 'already_ended');
        assert.equal(cancel(f, item.accepted.runId), 'already_ended');
      }
      detail.push({ timing, sourcedScopeEnd: item.scopeEnded, observed });
      f.db.close();
    }
    {
      const f = suite.fixture('cancel-order-unknown');
      const item = await nativeRun(suite, f, 0);
      await item.wait;
      cancel(f, item.accepted.runId);
      writeReceipt(f, item.accepted, item.scope);
      const observed = await recover(suite, f, item.accepted.runId);
      assert.equal(observed.state, 'ended');
      assert.equal(observed.terminalNote, 'cancel_timing_unknown');
      assert.equal(observed.cancelResult, null);
      assert.equal(observed.missing.includes('cancel_exit_order'), false);
      released(f, item.accepted.runId, 'ended');
      detail.push({ timing: 'scope ended but sourced ordering omitted', observed });
      f.db.close();
    }
    {
      const f = suite.fixture('cancel-write-lock-exit');
      const item = await nativeRun(suite, f, 0, { waitForSignal: true });
      const marker = join(f.directory, 'death-before-unlock.json');
      const trigger = join(f.directory, 'cancel-attempted');
      const locker = suite.peer('lock-until-exit', { path: f.path, target: item.stamp, marker, trigger });
      await locker.wait('ready');
      assert.ok(stat(item.stamp.pid) && stat(item.stamp.pid).state !== 'Z');
      writeFileSync(trigger, 'begin cancellation');
      assert.equal(cancel(f, item.accepted.runId), 'accepted');
      const actualDeath = JSON.parse(readFileSync(marker, 'utf8'));
      assert.equal(actualDeath.deathBeforeUnlock, true);
      const afterAcceptance = f.db
        .prepare("SELECT payload FROM events WHERE run_id=? AND kind='cancel.scope_observed'")
        .get(item.accepted.runId);
      assert.equal(JSON.parse(afterAcceptance.payload).group.result, 'gone');
      const withoutReceipt = await recover(suite, f, item.accepted.runId);
      assert.equal(withoutReceipt.state, 'ended');
      assert.equal(withoutReceipt.cancelBeforeExit, false);
      assert.equal(withoutReceipt.terminalNote, 'cancel_timing_unknown');
      assert.equal(withoutReceipt.cancelResult, null);
      released(f, item.accepted.runId, 'ended');
      const lateWaitObservation = await nativeReceipt(suite, f, item, 0);
      assert.equal(
        lateWaitObservation.state,
        'ended',
        'a delayed wait observation retains the original terminal classification'
      );
      assert.equal(lateWaitObservation.terminalNote, 'cancel_timing_unknown');
      assert.equal(lateWaitObservation.cancelResult, null);
      released(f, item.accepted.runId, 'ended');
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM events WHERE run_id=? AND kind='run.ended'").get(item.accepted.runId).n,
        1
      );
      detail.push({
        timing: 'real SQLite writer lock held until actual child death before cancel acceptance',
        actualDeath,
        withoutReceipt,
        lateWaitObservation,
      });
      f.db.close();
    }
    await qProofs(suite, detail, true);
  }
);
suite.finish();
