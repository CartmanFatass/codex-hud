import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { procStat } from '../../dist/mcp/cli-judge.js';
import {
  legacyFixture as fixture,
  until,
  fakeCliWithChild,
  statusQueries,
  readCloseReaped,
  withoutCallerLookups,
  declareDone,
  writeCliRole,
  cliState,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

test('supervisor events: 60s at rest means zero spawns and zero STATUS writes; socket loss stays working', { timeout: 30000 }, async (t) => {
  const clockScale = 20;
  const f = await fixture(t, { clockScale });
  // Keep the 10 s real-time grace headroom during flaps instead of grok's 10 s virtual turn-trust deadline.
  writeFixtureFile(join(f.env.HUD_HOME, 'harnesses.json'), JSON.stringify({ grok: { state_trust: 'advisory' } }));
  writeFixtureFile(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'rest-events', 10);
  const job = await f.call('hud_create', { role: 'rest-events', request_key: 'rest-events', task: 'Synthetic rest.' });
  // The direct worker seeds status after subscribing, without probing the pane address.
  await until(() => {
    const cliSub = f.socketRequests.findIndex((r) => r.id === 'hud-cli-events');
    const watchSub = f.socketRequests.findIndex((r) => r.id === 'hud-watch');
    return cliState(job.task_dir)?.agent_session_id &&
      cliState(job.task_dir)?.pid_start_time &&
      cliSub >= 0 && watchSub >= 0;
  }, t.signal);
  f.push(job.job, 'working');
  const writes = fs.readFileSync(join(f.env.HOME, 'status-writes'), 'utf8');
  // The MCP can still be doing its asynchronous caller-pane delivery lookup.
  const supervisorCommands = () => withoutCallerLookups(f.commands());
  const commands = supervisorCommands(), requests = f.socketRequests.length;
  // Observe two actual 30 s safety ticks rather than assuming the test timer
  // and the supervisor's accelerated clock get the same scheduling time.
  const beforeRest = statusQueries(f, job);
  await until(() => statusQueries(f, job) >= beforeRest + 3, t.signal);
  assert.deepEqual(supervisorCommands(), commands);
  const extra = f.socketRequests.slice(requests);
  assert.ok(extra.every((r) => r.method === 'agent.get'), JSON.stringify(extra));
  assert.equal(fs.readFileSync(join(f.env.HOME, 'status-writes'), 'utf8'), writes);
  assert.equal(cliState(job.task_dir).state, 'working');
  const beforeFlaps = statusQueries(f, job);
  for (let i = 0; i < 3; i++) {
    f.push(job.job, 'done');
    f.push(job.job, 'working');
  }
  await until(() => statusQueries(f, job) > beforeFlaps, t.signal);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'status-writes'), 'utf8'), writes, 'no-report status flaps do not write STATUS');
  assert.deepEqual(supervisorCommands(), commands);
  writeFixtureFile(join(f.env.HOME, 'herdr-errors'), '');
  const beforeDrop = statusQueries(f, job);
  f.drop();
  await until(() => statusQueries(f, job) >= beforeDrop + 3, t.signal); // Reconnect seed plus two safety ticks.
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).error, null);
  assert.deepEqual(supervisorCommands(), commands);
});

test('supervisor edges: stalled submission stays supervised; pre-input rejection retains the direct launch', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  fs.writeFileSync(join(f.env.HOME, 'stalled-prompt'), '');
  const live = await f.call('hud_create', { role: 'general', on: 'agy', request_key: 'stalled', task: 'Synthetic stall.' });
  assert.notEqual(live.ok, false);
  await until(() => cliState(live.task_dir)?.state === 'working', t.signal);
  assert.equal(JSON.parse(fs.readFileSync(join(live.task_dir, 'turn.json'))).seq, 1);
  assert.ok(fs.existsSync(join(live.task_dir, 'supervisor.pid')));
  assert.equal(f.commands().some((c) => c.args[0] === 'tab' && c.args[1] === 'close'), false);
  fs.unlinkSync(join(f.env.HOME, 'stalled-prompt'));
  fs.writeFileSync(join(f.env.HOME, 'rejected-prompt'), '');
  const rejected = await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'rejected', task: 'Synthetic rejection.' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'dispatch_failed');
  assert.equal(fs.existsSync(join(rejected.task_dir, 'supervisor.pid')), false);
  assert.match(fs.readFileSync(join(rejected.task_dir, 'SESSION.txt'), 'utf8'), /^DIRECT_EXEC=1$/m);
  assert.equal(f.commands().some((c) => c.args[0] === 'tab' && c.args[1] === 'close'), false);
});

for (const mode of ['once', 'twice']) {
  test(`Claude launch with Enter dropped ${mode}`, { timeout: 30000 }, async t => {
    const f = await fixture(t, { failedRetentionMs: 120_000 });
    writeFixtureFile(join(f.env.HOME, 'manual-socket'), '');
    writeFixtureFile(join(f.env.HOME, 'claude-initial-enter'), mode);
    const job = await f.call('hud_create', { role: 'lead', task: 'Synthetic lead brief.' });
    assert.equal(job.role, 'lead');
    assert.equal(cliState(job.task_dir).agent, 'claude');
    const pane = f.socketRequests.find(r => r.method === 'pane.read' && r.params.source === 'visible')?.params.pane_id;
    assert.ok(pane);
    assert.deepEqual(f.socketRequests.filter(r => r.method === 'pane.send_keys').map(r => r.params), [
      { pane_id: pane, keys: ['Enter'] },
    ]);
    assert.equal(f.commands().filter(c => c.args[0] === 'agent' && c.args[1] === 'prompt').length, 1, 'the brief is never pasted twice');
    if (mode === 'once') {
      assert.notEqual(job.ok, false);
      assert.equal(cliState(job.task_dir).state, 'working');
      assert.ok(fs.existsSync(join(job.task_dir, 'supervisor.pid')));
      assert.ok(fs.existsSync(join(job.task_dir, 'fake-claude-submitted')));
    } else {
      assert.equal(job.ok, false);
      assert.equal(job.code, 'dispatch_failed');
      assert.match(job.reason, /first prompt did not submit after one Enter resend/);
      const status = cliState(job.task_dir);
      assert.equal(status.state, 'failed');
      assert.equal(status.exit_reason, 'agent_prompt_stalled');
      assert.equal(fs.existsSync(join(job.task_dir, 'supervisor.pid')), false);
    }
  });
}

test('supervisor edges: outage with a report settles at 60s, and missed root exit fails without quota scans', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'outage-events', 10);
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: f.env, stdio: 'ignore' });
  t.after(() => worker.kill('SIGKILL'));
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(worker.pid));
  const job = await f.call('hud_create', { role: 'outage-events', request_key: 'outage-report', task: 'Synthetic outage.' });
  await until(() => cliState(job.task_dir)?.pid === worker.pid, t.signal);
  writeFixtureFile(join(job.task_dir, 'report.md'), 'Report survives a socket outage.\n');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  f.drop();
  await until(() => cliState(job.task_dir)?.state === 'idle_grace', t.signal);
  assert.equal(cliState(job.task_dir).output_written, true);
  worker.kill('SIGKILL');
  await until(() => cliState(job.task_dir)?.state === 'failed', t.signal);
  assert.equal(cliState(job.task_dir).exit_reason, 'worker exited (exit unknown)');
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));
  const worker2 = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: f.env, stdio: 'ignore' });
  t.after(() => worker2.kill('SIGKILL'));
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(worker2.pid));
  const failed = await f.call('hud_create', { role: 'outage-events', request_key: 'no-report-death', task: 'Task text says quota but that is not a quota fact.' });
  await until(() => cliState(failed.task_dir)?.pid === worker2.pid, t.signal);
  writeFixtureFile(join(f.env.HOME, 'pane-read'), 'quota exceeded');
  worker2.kill('SIGKILL');
  await until(() => cliState(failed.task_dir)?.state === 'failed', t.signal);
  assert.equal(cliState(failed.task_dir).exit_reason, 'worker exited (exit unknown)');
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
  assert.equal(f.commands().filter((c) => c.args[0] === 'pane' && c.args[1] === 'read').length, 2, 'only the two dispatch trust reads, no exit scan');
});

test('a CLI that exits without an exit event fails as exit unknown', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-exit'), '');
  const exited = await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'grok-exit', task: 'Synthetic exit.' });
  await until(() => cliState(exited.task_dir)?.state === 'failed', t.signal);
  assert.equal(cliState(exited.task_dir).error, 'worker exited (exit unknown)');
  fs.unlinkSync(join(f.env.HOME, 'cli-exit'));
  fs.writeFileSync(join(f.env.HOME, 'cli-gone'), '');
  const missing = await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'grok-gone', task: 'Synthetic gone.' });
  await until(() => cliState(missing.task_dir)?.state === 'failed', t.signal);
  assert.equal(cliState(missing.task_dir).error, 'worker exited (exit unknown)');
});

for (const first of ['watcher', 'supervisor']) {
  for (const fact of ['stop', 'exit with report']) {
    test(`CLI root exit: ${first} writes first for ${fact}`, { timeout: 60000 }, async (t) => {
      const f = await fixture(t);
      const worker = fakeCliWithChild(t, f);
      fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
      writeCliRole(f, 'tab-fact', 8);
      const job = await f.call('hud_create', { role: 'tab-fact', request_key: fact, task: 'Synthetic tab race.' });
      const dir = job.task_dir;
      await until(() => cliState(dir)?.supervisor_pid && cliState(dir).pid === worker.pid && f.socketRequests.some(r => r.id === 'hud-watch'), t.signal);
      const supervisor = cliState(dir).supervisor_pid;
      const watcher = Number(fs.readFileSync(join(f.env.HUD_HOME, 'watch.pid'), 'utf8'));
      const second = first === 'watcher' ? supervisor : watcher;
      process.kill(second, 'SIGSTOP');
      let terminal;
      try {
        writeFixtureFile(join(dir, 'report.md'), 'Synthetic report before loss of tab.\n');
        if (fact === 'stop') fs.writeFileSync(join(dir, 'STATUS.json.stop-requested'), '');
        f.exitAgent(job.job, 0);
        await until(() => cliState(dir)?.ended_at, t.signal);
        terminal = cliState(dir);
        assert.equal(terminal.state, fact === 'stop' ? 'stopped' : 'closed');
        assert.equal(terminal.exit_reason, fact === 'stop' ? 'stop requested' : 'settled');
        assert.equal(terminal.output_written, true);
        if (fact !== 'stop') await worker.exit();
      } finally {
        process.kill(second, 'SIGCONT');
      }
      await until(() => readCloseReaped(job), t.signal);
      await until(() => !procStat(supervisor) || procStat(supervisor)?.state === 'Z', t.signal);
      assert.deepEqual(cliState(dir), terminal);
    });
  }
}

test('a buffered close of a reused tab cannot fail a live CLI worker', { timeout: 30000 }, async (t) => {
  const f = await fixture(t), worker = fakeCliWithChild(t, f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'reused-cli', 10);
  const job = await f.call('hud_create', { role: 'reused-cli', task: 'Synthetic replacement worker.' });
  const dir = job.task_dir;
  await until(() => cliState(dir)?.pid === worker.pid && f.socketRequests.some(req => req.id === 'hud-watch'), t.signal);
  f.emitTabClosed('w4E:t2'); // Prior occupant's buffered address-only event.
  assert.ok(procStat(worker.pid));
  f.exitAgent(job.job, 3);
  await until(() => cliState(dir)?.exit_reason === 'worker exited (code 3)', t.signal);
  assert.equal(cliState(dir).state, 'failed');
});

test('supervisor preserves the watcher root-exit fact when its own push socket was lost', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'lost-close', 10);
  const job = await f.call('hud_create', { role: 'lost-close', request_key: 'lost-close', task: 'Synthetic tab-close outage.' });
  // A PID does not mean the watcher is subscribed to the one-shot close event yet.
  await until(() => cliState(job.task_dir)?.pid === worker.pid &&
    f.socketRequests.some(r => r.id === 'hud-watch') && f.dropWorker(job.job), t.signal);
  const supervisor = cliState(job.task_dir).supervisor_pid;
  f.exitAgent(job.job, 3);
  await until(() => cliState(job.task_dir)?.exit_reason === 'worker exited (code 3)', t.signal);
  writeFixtureFile(join(job.task_dir, 'report.md'), 'A late report must not overwrite root exit.\n');
  await worker.exit();
  await until(() => !procStat(supervisor) || procStat(supervisor)?.state === 'Z', t.signal);
  assert.equal(cliState(job.task_dir).state, 'failed');
  assert.equal(cliState(job.task_dir).exit_reason, 'worker exited (code 3)');
});

test('an unread declared report closes at the idle deadline and reaps leftovers', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'grace-bg-cli', 1, true);
  const graceJob = await f.call('hud_create', {
    role: 'grace-bg-cli',
    request_key: 'grace-bg-hold',
    task: 'Background child holds grace.',
  });
  await until(() => cliState(graceJob.task_dir)?.pid === worker.pid, t.signal);
  const child = await worker.start();
  writeFixtureFile(join(graceJob.task_dir, 'report.md'), 'Synthetic report with leftover child.\n');
  declareDone(f, graceJob);
  await until(() => cliState(graceJob.task_dir)?.state === 'idle_grace', t.signal);
  const quit = () => f.commands().some((c) => c.args[1] === 'prompt' && c.args[2] === `${graceJob.job}-primary` && c.args[3] === '/quit');
  const reaped = () => f.commands().some((c) => c.command === 'hud-reap' && c.args[0] === graceJob.task_dir);
  assert.ok(procStat(child));
  await until(() => cliState(graceJob.task_dir)?.state === 'closed', 2200);
  await until(reaped, t.signal);
  assert.ok(quit());
  await until(() => procStat(child) === null, t.signal);
});

test('exit is a /proc pid check: herdr errors keep working while pid lives, missed root exit is unknown even with a report', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const spawnDummy = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { env: f.env, stdio: 'ignore' });
    t.after(() => { try { child.kill('SIGKILL'); } catch {} });
    return child;
  };

  // 1. Live pid stays working across repeated herdr errors, then closes cleanly once herdr recovers.
  const liveProc = spawnDummy();
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(liveProc.pid));
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const keepAlive = await f.call('hud_create', {
    role: 'general',
    on: 'grok',
    request_key: 'herdr-errors-alive',
    task: 'Keep working when herdr errors while pid lives.',
  });
  await until(() => cliState(keepAlive.task_dir)?.pid === liveProc.pid, t.signal);
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  fs.unlinkSync(join(f.env.HOME, 'hold-turn'));
  await until(
    () =>
      f.socketRequests.filter((req) => req.method === 'agent.get' && req.params.target === `${keepAlive.job}-primary`).length >= 5,
    t.signal
  );
  assert.equal(cliState(keepAlive.task_dir).state, 'working');
  assert.equal(cliState(keepAlive.task_dir).pid, liveProc.pid);
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));
  await until(() => cliState(keepAlive.task_dir)?.state === 'closed', t.signal);

  // 2. Pid gone without a report -> failed.
  const procNoReport = spawnDummy();
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(procNoReport.pid));
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const failJob = await f.call('hud_create', {
    role: 'general',
    on: 'grok',
    request_key: 'pid-gone-fail',
    task: 'Pid dies without report.',
  });
  await until(() => cliState(failJob.task_dir)?.pid === procNoReport.pid, t.signal);
  procNoReport.kill('SIGKILL');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  await until(() => cliState(failJob.task_dir)?.state === 'failed', t.signal);
  assert.equal(cliState(failJob.task_dir).exit_reason, 'worker exited (exit unknown)');
  assert.equal(cliState(failJob.task_dir).output_written, false);
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));

  // 3. Missed root exit with a report -> failed (output_written true).
  const procWithReport = spawnDummy();
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(procWithReport.pid));
  const closeJob = await f.call('hud_create', {
    role: 'general',
    on: 'grok',
    request_key: 'pid-gone-report',
    task: 'Pid dies after writing report.',
  });
  await until(() => cliState(closeJob.task_dir)?.pid === procWithReport.pid, t.signal);
  writeFixtureFile(join(closeJob.task_dir, 'report.md'), 'Finished before exit.\n');
  procWithReport.kill('SIGKILL');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  await until(() => cliState(closeJob.task_dir)?.state === 'failed', t.signal);
  assert.equal(cliState(closeJob.task_dir).exit_reason, 'worker exited (exit unknown)');
  assert.equal(cliState(closeJob.task_dir).output_written, true);


});

test('hud_send restarts a dead supervisor only when the worker is confirmed alive', { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { watcherTickMs: 200 }); // Scale the orphan retry, not the supervisor death event.
  writeCliRole(f, 'respawn-cli', 1, true);
  const spawnDummy = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { env: f.env, stdio: 'ignore' });
    t.after(() => { try { child.kill('SIGKILL'); } catch {} });
    return child;
  };
  const dead = (pid) => procStat(pid) === null;

  // 1. Dead supervisor + live worker -> hud-watch marks waiting_orchestrator -> hud_send spawns a new supervisor and the turn settles.
  const liveWorker = spawnDummy();
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(liveWorker.pid));
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'respawn-cli', request_key: 'respawn-live', task: 'Respawn on live worker.' });
  await until(() => cliState(job.task_dir)?.pid === liveWorker.pid && cliState(job.task_dir)?.supervisor_pid, t.signal);
  const oldSupPid = cliState(job.task_dir).supervisor_pid;
  const startedAt = cliState(job.task_dir).started_at;
  process.kill(oldSupPid, 'SIGKILL');
  await until(() => dead(oldSupPid), t.signal);
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', t.signal);
  assert.equal(cliState(job.task_dir).reason, 'supervisor exited; worker still running');

  const sent = await f.call('hud_send', { job: job.job, message_key: 'respawn', text: 'Continue with new supervisor.' });
  assert.equal(sent.sent, true);
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.supervisor_pid !== oldSupPid, t.signal);
  const newSupPid = cliState(job.task_dir).supervisor_pid;
  assert.notEqual(newSupPid, oldSupPid);
  assert.equal(dead(newSupPid), false);
  assert.equal(fs.readFileSync(join(job.task_dir, 'supervisor.pid'), 'utf8').trim(), String(newSupPid));
  assert.equal(cliState(job.task_dir).pid, liveWorker.pid);
  assert.equal(cliState(job.task_dir).started_at, startedAt);
  assert.equal(cliState(job.task_dir).reason, null);
  fs.unlinkSync(join(f.env.HOME, 'hold-turn'));
  await until(() => cliState(job.task_dir)?.state === 'closed', t.signal);
  assert.equal(cliState(job.task_dir).output_written, true);
  assert.equal(cliState(job.task_dir).exit_reason, 'settled');
  await until(() => !fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')), t.signal);

  // 2. Dead supervisor + dead worker -> keeps today's hud_send behaviour without respawning.
  const dyingWorker = spawnDummy();
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(dyingWorker.pid));
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const goneJob = await f.call('hud_create', { role: 'respawn-cli', request_key: 'respawn-gone', task: 'No respawn when worker gone.' });
  await until(() => cliState(goneJob.task_dir)?.pid === dyingWorker.pid && cliState(goneJob.task_dir)?.supervisor_pid, t.signal);
  const goneSupPid = cliState(goneJob.task_dir).supervisor_pid;
  process.kill(goneSupPid, 'SIGKILL');
  dyingWorker.kill('SIGKILL');
  await until(() => dead(goneSupPid) && dead(dyingWorker.pid), t.signal);
  const sentGone = await f.call('hud_send', { job: goneJob.job, message_key: 'gone-before-watch', text: 'Worker already dead.' });
  // Socket close can settle the job before this send; neither ordering may respawn a supervisor.
  if (!sentGone.sent) assert.equal(sentGone.code, 'not_continuable');
  // hud_send publishes any replacement supervisor PID before it returns.
  assert.equal(fs.readFileSync(join(goneJob.task_dir, 'supervisor.pid'), 'utf8').trim(), String(goneSupPid));
  await until(() => cliState(goneJob.task_dir)?.state === 'failed', t.signal);
  // The watcher may have settled before or after the previous reply advanced the change cursor.
  const { changes, ...rejected } = await f.call('hud_send', { job: goneJob.job, message_key: 'gone-after-watch', text: 'Still dead.' });
  assert.deepEqual(rejected, { ok: false, code: 'not_continuable' });
  if (changes) assert.deepEqual(changes, [`${goneJob.job} respawn-cli: failed | worker exited (exit unknown)`]);
  assert.equal(fs.readFileSync(join(goneJob.task_dir, 'supervisor.pid'), 'utf8').trim(), String(goneSupPid));


});
