import {
  arm,
  assert,
  boot,
  countSubmissions,
  event,
  existsSync,
  hash,
  harnessPeer,
  home,
  inspectScope,
  join,
  json,
  live,
  meta,
  metaPath,
  now,
  readFileSync,
  receiptPath,
  registeredSupervisor,
  sameInstance,
  signal,
  stat,
  Suite,
  tx,
  value,
} from './common.mjs';
import {
  attachScope,
  crashMatrix,
  fence,
  held,
  killStamp,
  launched,
  nativeReceipt,
  nativeRun,
  newIntent,
  nonExecutionFence,
  pausedLauncher,
  qProofs,
  recover,
  released,
  scopeStates,
  writeReceipt,
} from './scenarios.mjs';

const suite = new Suite('recovery');
const a8Root = join('tmp', 'tasks', 'A8', 'evidence', 'hud-run-visible');
const root = new URL('../../../', import.meta.url);
const saved = (path) => readFileSync(new URL(`${a8Root}/${path}`, root), 'utf8');
const savedJson = (path) => JSON.parse(saved(path));
const foreground = (path) => savedJson(path).result.process_info.foreground_process_group_id;
const savedStat = (path) =>
  Object.fromEntries(
    [...saved(path).matchAll(/(pid|state|pgrp|tpgid|starttime)=([^\s]+)/g)].map((match) => [match[1], match[2]])
  );

function savedA8(detail) {
  const versions = saved('versions.txt');
  for (const value of ['codex-cli 0.166.0', '2.1.305', '1.4.0', 'herdr 0.9.5', 'v24.22.1', '6.18.33.2'])
    assert.ok(versions.includes(value));
  const context = saved('jia/context/context-probe.txt');
  for (const key of [
    'env_present',
    'workspace_present',
    'tab_present',
    'pane_present',
    'session_present',
    'socket_present',
    'socket_path_present',
    'config_path_present',
    'workspace_matches',
    'tab_matches',
    'pane_matches',
    'ancestor_codex',
  ])
    assert.ok(context.includes(`${key}=true`));
  const states = [
    'agent-list-working-session',
    'agent-list-done',
    'agent-list-idle',
    'agent-list-second-working',
    'agent-list-second-after',
  ].map((file) => savedJson(`jia/context/${file}.json`));
  assert.deepEqual(
    states.map((state) => state.agent_status),
    ['working', 'done', 'idle', 'working', 'idle']
  );
  assert.ok(states.every((state) => state.agent === 'codex' && state.agent_session_present));
  const initial = savedJson('jia/parent-exit/standin-status-before.json');
  const hello = savedJson('jia/parent-exit/standin-status-after-hello.json');
  const final = savedJson('jia/parent-exit/standin-status-final.json');
  assert.equal(initial.stdinIsTTY, true);
  assert.equal(initial.stdoutIsTTY, true);
  assert.equal(initial.lines, 0);
  assert.equal(hello.lines, 1);
  assert.equal(final.lines, 2);
  assert.equal(final.sentinelSeen, true);
  assert.equal(saved('jia/parent-exit/launcher-exit.txt').trim(), '0');
  assert.equal(saved('jia/parent-exit/launcher-gone.txt').trim(), 'gone');
  const receipt = savedJson('jia/parent-exit/run/exit.json');
  assert.equal(receipt.shellStatus, 5);
  assert.equal(receipt.harnessExitCode, null);
  assert.equal(receipt.group.empty, true);
  const before = savedStat('jia/parent-exit/standin-before.stat.txt');
  assert.equal(before.pgrp, before.tpgid);
  assert.equal(Number(before.pgrp), foreground('jia/parent-exit/process-info-before.json'));
  const negative = savedJson('jia/parent-exit-bg/standin-status-after-hello.json');
  assert.equal(negative.lines, 0);
  assert.equal(savedJson('jia/parent-exit-bg/run/exit.json').shellStatus, 149);
  assert.ok(saved('jia/parent-exit-bg/pane-after-hello.txt').includes('command not found: hello'));
  const normalScope = savedJson('jia/normal/run/exit.json');
  assert.equal(normalScope.group.empty, true);
  assert.equal(normalScope.harnessExitCode, null);
  detail.push({
    evidenceKind: 'READ_ONLY_SAVED_A8_NOT_RERUN',
    acceptanceCommit: '8fdf4cf',
    versions: versions.trim().split('\n').slice(1),
    paths: [
      'versions.txt',
      'jia/context/context-probe.txt',
      'jia/context/agent-list-*.json',
      'jia/parent-exit/',
      'jia/parent-exit-bg/',
      'jia/normal/run/exit.json',
    ].map((path) => `${a8Root}/${path}`),
    foregroundOnly: true,
    backgroundNegativeControlFailedAsExpected: true,
  });
}

function savedDeath(detail) {
  const before = savedStat('jia/supervisor-death/harness.stat.txt');
  const after = savedStat('jia/supervisor-death/harness-after.stat.txt');
  assert.equal(before.pid, after.pid);
  assert.equal(before.starttime, after.starttime);
  assert.ok(['S', 'T', 'D', 'R'].includes(after.state));
  assert.equal(before.pgrp, before.tpgid);
  assert.notEqual(after.pgrp, after.tpgid);
  assert.notEqual(
    foreground('jia/supervisor-death/process-info-before.json'),
    foreground('jia/supervisor-death/process-info-after.json')
  );
  assert.equal(Number(after.tpgid), foreground('jia/supervisor-death/process-info-after.json'));
  assert.ok(saved('jia/supervisor-death/pane-after.txt').includes('suspended (tty input)'));
  const echo = saved('jia/supervisor-death/input-echo.txt');
  assert.ok(echo.includes('x'));
  assert.equal(
    savedJson('jia/supervisor-death/heartbeat-before.json').at,
    savedJson('jia/supervisor-death/heartbeat-after.json').at
  );
  assert.ok(!existsSync(new URL(`${a8Root}/jia/supervisor-death/run/exit.json`, root)));
  detail.push({
    evidenceKind: 'READ_ONLY_SAVED_A8_TTY_FAILURE',
    paths: [
      'harness.stat.txt',
      'harness-after.stat.txt',
      'process-info-before.json',
      'process-info-after.json',
      'pane-after.txt',
      'input-echo.txt',
      'heartbeat-before.json',
      'heartbeat-after.json',
      'receipt-exists.txt',
    ].map((path) => `${a8Root}/jia/supervisor-death/${path}`),
    foregroundReturnedToShell: true,
    sampledState: after.state,
    suspensionShownByPane: true,
    noClaimOfSampledT: true,
  });
}

await suite.test(
  'T-04-3',
  'real /bin/sh child differs from harness; exec preserves instance; real wait status alone supplies native code',
  async (detail) => {
    for (const strategy of ['shell', 'exec']) {
      const f = suite.fixture(`stamp-${strategy}`);
      const accepted = await newIntent(f);
      assert.equal(arm(f.db, accepted.runId, accepted.ticket, stat(process.pid)), true);
      const shell = suite.peer('shell', { exec: strategy === 'exec', exitCode: 7, shellStatus: 137 });
      const ready = await shell.wait('ready');
      assert.equal(sameInstance(ready.commandLeader, ready.harness), strategy === 'exec');
      const scope = attachScope(f, accepted, ready.harness, {
        leader: ready.commandLeader,
        launchers: [ready.stamp, ready.commandLeader],
        sealed: [ready.stamp],
      });
      const actual = await shell.wait('shell-exit');
      assert.equal(actual.code, strategy === 'exec' ? 7 : 137);
      writeReceipt(
        f,
        accepted,
        scope,
        strategy === 'exec'
          ? { process: ready.harness, subject: 'harness', code: actual.code, signal: null, source: 'wait_status' }
          : null,
        strategy === 'shell' ? actual.code : null
      );
      const observed = await recover(suite, f, accepted.runId);
      assert.equal(observed.state, 'ended');
      const row = f.db.prepare('SELECT * FROM runs WHERE run_id=?').get(accepted.runId);
      assert.equal(row.exit_code, strategy === 'exec' ? 7 : null);
      assert.equal(row.shell_status, strategy === 'shell' ? 137 : null);
      detail.push({
        strategy,
        commandLeader: ready.commandLeader,
        harness: ready.harness,
        actualWait: actual.code,
        nativeCode: row.exit_code,
        shellStatus: row.shell_status,
      });
      f.db.close();
    }
    const f = suite.fixture('direct-argv');
    const item = await nativeRun(suite, f, 7);
    assert.equal(item.scope.group_leader.pid, item.stamp.pid);
    await nativeReceipt(suite, f, item, 7);
    detail.push({ directArgvSameInstance: true, actualWaitCode: 7 });
    f.db.close();
  }
);

await suite.test(
  'T-04-5',
  'real leader exit, S/T/Z groups and setsid escape semantics; D classification explicitly synthetic',
  async (detail) => {
    await scopeStates(suite, detail);
  }
);

await suite.test(
  'T-04-19',
  'SIGKILL at armed/submitting/spawn-writeback cuts and a live stopped launcher never trigger retry',
  async (detail) => {
    await crashMatrix(suite, detail);
    await pausedLauncher(suite, detail);
  }
);

await suite.test(
  'T-04-21',
  'permanent fence plus dead launcher permits N; submitting/paused launcher cannot masquerade as N',
  async (detail) => {
    await nonExecutionFence(suite, detail);
    await pausedLauncher(suite, detail);
  }
);

await suite.test(
  'T-04-24',
  'receiptless Q requires every scope/harness/launcher/visibility predicate; no dead-writer file needed',
  async (detail) => {
    await qProofs(suite, detail);
    await qProofs(suite, detail, true);
  }
);

await suite.test(
  'T-04-25',
  'recovery is a separate observer: live/unknown/empty scope, no H/ticket/exit writes; synthetic boot refusal',
  async (detail) => {
    const f = suite.fixture('observer-rights');
    const item = await launched(suite, f);
    await item.supervisor.stop();
    const before = f.db.prepare('SELECT * FROM runs WHERE run_id=?').get(item.accepted.runId);
    const observer = suite.peer('recovery', { path: f.path });
    await observer.wait('ready');
    for (const action of ['heartbeat', 'ticket', 'exit', 'submit'])
      await assert.rejects(
        async () => value(await observer.call(action, { runId: item.accepted.runId })),
        /no_execution_or_writer_right/
      );
    const alive = value(await observer.call('reconcile', { runId: item.accepted.runId }));
    const unknown = value(
      await observer.call('reconcile', { runId: item.accepted.runId, options: { visibility: 'partial' } })
    );
    assert.equal(alive.state, 'uncertain');
    assert.equal(unknown.state, 'uncertain');
    held(f, item.accepted.runId);
    const foreignBoot = inspectScope({ ...item.scope, boot_id: 'synthetic-other-boot' });
    assert.equal(foreignBoot.result, 'unknown');
    assert.equal(foreignBoot.scanned, false, 'never query old numeric PGID in another boot');
    await killStamp(item.stamp);
    const empty = value(await observer.call('reconcile', { runId: item.accepted.runId }));
    assert.equal(empty.basis, 'Q');
    const after = f.db.prepare('SELECT * FROM runs WHERE run_id=?').get(item.accepted.runId);
    for (const key of [
      'heartbeat_at',
      'heartbeat_seq',
      'heartbeat_mono_ms',
      'supervisor_pid',
      'supervisor_proc_start',
      'launch_phase',
      'launch_token_hash',
    ])
      assert.equal(after[key], before[key]);
    assert.equal(countSubmissions(f.directory), 1);
    assert.equal(existsSync(receiptPath(item.accepted.runId)), false);
    detail.push({
      observerPid: observer.pid,
      alive,
      unknown,
      empty,
      foreignBoot,
      syntheticOnly: 'cross-boot refusal; no reboot or old-instance termination proof induced',
      unchangedWriterFields: true,
      rejectedActions: ['heartbeat', 'ticket', 'exit', 'submit'],
    });
    f.db.close();
  }
);

await suite.test(
  'T-04-42',
  'atomic full supervisor stamp survives registration-before-meta SIGKILL; missing and cross-domain stay unknown',
  async (detail) => {
    const f = suite.fixture('registration-before-meta');
    const item = await launched(suite, f, 'registered_before_meta');
    assert.equal(existsSync(metaPath(item.accepted.runId)), false);
    assert.equal((await item.supervisor.stop()).signal, 'SIGKILL');
    const run = f.db.prepare('SELECT * FROM runs WHERE run_id=?').get(item.accepted.runId);
    const stamp = registeredSupervisor(f.db, run);
    const { pid, proc_start, boot_id, pid_domain } = item.stamp;
    assert.deepEqual(stamp, { pid, proc_start, boot_id, pid_domain });
    assert.equal(run.launch_phase, 'armed');
    assert.equal(run.heartbeat_seq, 1);
    assert.notEqual(run.heartbeat_at, null);
    assert.equal(f.db.prepare('SELECT state FROM claims WHERE run_id=?').get(run.run_id).state, 'armed');
    const beforeFence = await recover(suite, f, run.run_id);
    assert.equal(beforeFence.supervisorDead, true);
    assert.equal(beforeFence.state, 'uncertain');
    held(f, run.run_id);
    fence(f, run.run_id);
    assert.equal((await recover(suite, f, run.run_id)).basis, 'N');
    assert.equal(countSubmissions(f.directory), 0);
    assert.equal(arm(f.db, run.run_id, item.accepted.ticket, stat(process.pid)), false);
    detail.push({ cut: 'after registration commit, before meta', stamp, beforeFence, submissions: 0 });
    f.db.close();
    for (const kind of ['missing', 'cross-domain']) {
      const g = suite.fixture(`registration-${kind}`);
      const accepted = await newIntent(g);
      const current = stat(process.pid);
      const historical = { ...current, boot_id: 'synthetic-foreign-boot', pid_domain: 'synthetic-foreign-pid-domain' };
      if (kind === 'cross-domain') {
        assert.equal(arm(g.db, accepted.runId, accepted.ticket, historical), true);
      } else {
        // A legacy/incomplete record deliberately lacks the authoritative registration event.
        tx(g.db, () => {
          g.db
            .prepare(
              "UPDATE runs SET supervisor_pid=?,supervisor_proc_start=?,launch_phase='armed',heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=0 WHERE run_id=?"
            )
            .run(current.pid, current.proc_start, now(), accepted.runId);
          g.db
            .prepare("UPDATE claims SET state='armed',supervisor_pid=?,supervisor_proc_start=? WHERE run_id=?")
            .run(current.pid, current.proc_start, accepted.runId);
        });
      }
      fence(g, accepted.runId);
      const row = g.db.prepare('SELECT * FROM runs WHERE run_id=?').get(accepted.runId);
      const recovered = registeredSupervisor(g.db, row);
      assert.equal(kind === 'missing' ? recovered === null : recovered.pid_domain === historical.pid_domain, true);
      const observed = await recover(suite, g, accepted.runId);
      assert.equal(observed.supervisorUnknown, true);
      assert.equal(observed.supervisorDead, false);
      assert.equal(observed.N, false);
      assert.equal(observed.state, 'uncertain');
      assert.equal(observed.blockNewOperations, true);
      held(g, accepted.runId);
      detail.push({ kind, matchingLocalPidAndStart: true, recovered, observed });
      g.db.close();
    }
  }
);

await suite.test(
  'T-04-30',
  'read-only checks of accepted A8 foreground/context/status evidence and supervision failure, with version limits',
  async (detail) => {
    const f = suite.fixture('saved-a8-schema');
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n,
      16
    );
    savedA8(detail);
    savedDeath(detail);
    detail.push({
      sqliteSchema: 'contract-02 verbatim',
      productionAcceptance: false,
      realHarnessOrHerdrStarted: false,
    });
    f.db.close();
  }
);

await suite.test(
  'T-04-36',
  'supervisor SIGKILL disables interaction and holds slot; distinct parent-offline continue uses saved TTY proof',
  async (detail) => {
    savedDeath(detail);
    const f = suite.fixture('supervisor-death');
    const item = await launched(suite, f);
    await item.supervisor.stop();
    assert.equal(live(stat(item.stamp.pid)), true);
    const interrupted = await recover(suite, f, item.accepted.runId);
    assert.equal(interrupted.state, 'uncertain');
    assert.equal(interrupted.cause, 'supervisor_dead');
    assert.deepEqual(interrupted.interaction, { focus: false, input: false, resume: false });
    held(f, item.accepted.runId);
    assert.equal(existsSync(receiptPath(item.accepted.runId)), false);
    assert.equal(countSubmissions(f.directory), 1);
    detail.push({ newSyntheticSupervisorDeath: interrupted, noFgInputFocusWrapperRecoveryOrResume: true });
    f.db.close();
    const g = suite.fixture('parent-offline');
    const parent = await harnessPeer(suite, g);
    const parentMcp = await parent.start();
    g.ctx = await parent.call('identify', { params: meta() });
    const other = await launched(suite, g);
    assert.equal(value(await parent.peer.call('stop')).signal, 'SIGKILL');
    tx(g.db, () =>
      event(g.db, 'parent.offline', other.accepted.runId, {
        callerId: parentMcp.callerId,
        contextId: g.ctx.context_id,
        generation: g.ctx.generation,
        parent: parentMcp.stamp,
        since: now(),
        policy: 'continue',
      })
    );
    const continued = await recover(suite, g, other.accepted.runId);
    assert.equal(continued.state, 'running');
    assert.equal(continued.cause, null);
    assert.deepEqual(continued.interaction, { focus: true, input: true, resume: false });
    held(g, other.accepted.runId);
    detail.push({
      newSyntheticParentOffline: true,
      continued,
      ttyVerification: 'saved accepted A8 parent-launcher evidence; this process case uses pipes',
    });
    savedA8(detail);
    g.db.close();
  }
);
suite.finish();
