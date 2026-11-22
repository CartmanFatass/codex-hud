import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { procStat } from '../../dist/mcp/cli-judge.js';
import {
  fixture,
  until,
  fakeCliWithChild,
  statusQueries,
  readCloseQuit,
  readCloseReaped,
  withoutCallerLookups,
  declareDone,
  writeCliRole,
  cliState,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

test('supervisor events: renewed idle and stale scrollback do not settle a draft with an in-turn child', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'background-events', 4);
  const job = await f.call('hud_create', { role: 'background-events', request_key: 'background-events', task: 'Synthetic background work.' });
  await until(() => cliState(job.task_dir)?.pid === worker.pid && cliState(job.task_dir)?.agent_session_id);
  assert.equal(cliState(job.task_dir).pid_start_time, procStat(worker.pid).start);
  const child = await worker.start();
  const report = join(job.task_dir, 'report.md');
  const marker = `⏺ report written: ${report}\n`;
  f.push(job.job, 'idle');
  writeFixtureFile(join(f.env.HOME, 'pane-read'), marker.repeat(2));
  writeFixtureFile(report, 'Report while tests finish.\n');
  writeFixtureFile(join(f.env.HOME, 'pane-read'), marker);
  const queries = statusQueries(f, job);
  await until(() => statusQueries(f, job) >= queries + 2);
  assert.ok(procStat(child));
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).output_written, false);
});

async function fakeMcpBootstrap(f, worker, generic = false) {
  const files = Object.fromEntries(['launch', 'ready', 'pids', 'start-work', 'work-pid'].map((key) => [key, join(f.root, key)]));
  const spec = generic ? '@synthetic/mcp-demo' : 'chrome-devtools-mcp@1.11.0';
  const entry = generic ? 'demo-mcp' : 'chrome-devtools-mcp';
  const bin = join(f.root, generic ? 'node_modules/.bin' : 'bin');
  const watchdog = join(f.root, 'node_modules/chrome-devtools-mcp/build/src/telemetry/watchdog/main.js');
  if (!generic) {
    fs.mkdirSync(join(watchdog, '..'), { recursive: true });
    fs.writeFileSync(watchdog, 'setTimeout(() => {}, 30000)');
  }
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(join(bin, entry), `#!${process.execPath}
const { spawn } = require('node:child_process');
const fs = require('node:fs'), files = ${JSON.stringify(files)};
const publish = (file, data) => {
  fs.writeFileSync(file + '.tmp', data);
  fs.renameSync(file + '.tmp', file);
};
const pids = [process.ppid, process.pid];
${generic ? '' : `process.title = 'chrome-devtools-mcp';
pids.push(spawn(process.execPath, [${JSON.stringify(watchdog)}, '--parent-pid', String(process.pid)], { stdio: 'ignore' }).pid);`}
publish(files.pids, JSON.stringify(pids));
setInterval(() => {
  if (!fs.existsSync(files['start-work']) || fs.existsSync(files['work-pid'])) return;
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  publish(files['work-pid'], String(child.pid));
}, 10);
`, { mode: 0o700 });
  const launcher = await worker.start(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs'), files = ${JSON.stringify(files)};
    process.title = ${JSON.stringify(`npm exec ${spec}`)};
    fs.writeFileSync(files.ready, '');
    const poll = setInterval(() => {
      if (!fs.existsSync(files.launch)) return;
      clearInterval(poll);
      // As npm exec does: the bin name single-quoted (seen live 2026-11-18: sh -c 'playwright-mcp').
      spawn('/bin/sh', ['-c', ${JSON.stringify(`'${entry}'`)}], {
        stdio: 'ignore', env: { ...process.env, PATH: ${JSON.stringify(bin + ':')} + process.env.PATH },
      });
    }, 10);
  `], true);
  await until(() => fs.existsSync(files.ready));
  return {
    async launch() {
      fs.writeFileSync(files.launch, '');
      await until(() => fs.existsSync(files.pids) && fs.statSync(files.pids).size > 0);
      const pids = JSON.parse(fs.readFileSync(files.pids, 'utf8'));
      const [shell, server, watchdogPid] = pids;
      assert.equal(procStat(shell)?.ppid, launcher);
      assert.equal(procStat(server)?.ppid, shell);
      if (generic) assert.equal(fs.readFileSync(`/proc/${server}/cmdline`, 'utf8').split('\0')[1], join(bin, entry));
      else assert.equal(procStat(watchdogPid)?.ppid, server);
      return [launcher, ...pids];
    },
    async work() {
      fs.writeFileSync(files['start-work'], '');
      await until(() => fs.existsSync(files['work-pid']) && fs.statSync(files['work-pid']).size > 0);
      return Number(fs.readFileSync(files['work-pid'], 'utf8'));
    },
  };
}

for (const scenario of ['bootstrap only', 'generic package', 'no report', 'direct sleep', 'sleep under old MCP server', 'same-named runner']) {
  test(`supervisor MCP bootstrap: ${scenario}`, { timeout: 20000 }, async (t) => {
    const f = await fixture(t);
    const worker = fakeCliWithChild(t, f);
    const mcp = await fakeMcpBootstrap(f, worker, scenario === 'generic package');
    fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
    writeCliRole(f, 'mcp-bootstrap', 8);
    const job = await f.call('hud_create', { role: 'mcp-bootstrap', request_key: scenario, task: 'Synthetic task.' });
    const dir = job.task_dir, report = join(dir, 'report.md');
    await until(() => cliState(dir)?.pid === worker.pid && cliState(dir)?.agent_session_id, 10000);
    assert.equal((await f.call('hud_read')).jobs.find((row) => row.job === job.job).state, 'working');
    const pids = await mcp.launch();
    assert.ok(Number(procStat(pids[1]).start) > Number(procStat(pids[0]).start));
    if (scenario === 'no report') {
      f.push(job.job, 'idle');
      await until(() => cliState(dir)?.state === 'waiting_orchestrator');
      assert.match(cliState(dir).reason, /quiet without a report/);
      assert.equal(readCloseQuit(f, job), false);
      return;
    }
    // Exercise non-shell work on a continuation, where no direct child gets a launch exemption.
    if (['sleep under old MCP server', 'direct sleep', 'same-named runner'].includes(scenario)) {
      writeFixtureFile(report, 'First synthetic report.\n');
      f.push(job.job, 'idle');
      await until(() => cliState(dir)?.state === 'idle_grace');
      assert.equal((await f.call('hud_send', { job: job.job, message_key: 'repair', text: 'Synthetic continuation.' })).sent, true);
    }
    let work;
    if (scenario === 'sleep under old MCP server') {
      work = await mcp.work();
      assert.equal(procStat(work)?.ppid, pids[2]);
    } else if (scenario === 'direct sleep') work = await worker.start('sleep', ['30']);
    else if (scenario === 'same-named runner') work = await worker.start(process.execPath, ['-e',
      `process.title = 'chrome-devtools-mcp'; setTimeout(() => {}, 30000);`]);
    if (work) {
      const reads = () => f.commands().filter((c) => c.command === 'herdr' && c.args[0] === 'pane' && c.args[1] === 'read').length;
      const before = reads(), queries = statusQueries(f, job);
      f.push(job.job, 'working'); f.push(job.job, 'idle');
      await until(() => statusQueries(f, job) > queries);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(reads(), before, 'no quiet decision while the worker has a live child');
      assert.equal(cliState(dir).state, 'working');
    }
    writeFixtureFile(report, 'Synthetic fresh report with MCP infrastructure still alive.\n');
    f.push(job.job, 'idle');
    if (work) {
      assert.match((await f.call('hud_read', { job: job.job })).digest.result, /Synthetic fresh report/);
      assert.ok(procStat(work));
      declareDone(f, job);
    } else {
      await until(() => cliState(dir)?.state === 'idle_grace');
      const listing = await f.call('hud_read');
      assert.match(listing.changes.find((line) => line.startsWith(job.job)), /: idle_grace \| report/);
      assert.equal(cliState(dir).output_written, true);
      assert.match((await f.call('hud_read', { job: job.job })).digest.result, /Synthetic fresh report/);
    }
    await until(() => cliState(dir)?.state === 'closed', 1700);
    assert.equal(cliState(dir).exit_reason, 'closed after report read');
    assert.equal(cliState(dir).output_written, true);
    assert.match((await f.call('hud_read')).changes.find((line) => line.startsWith(job.job)), /: closed/);
    await until(() => readCloseReaped(job));
    assert.ok([...pids, ...(work ? [work] : [])].every((pid) => !procStat(pid) || procStat(pid)?.state === 'Z'),
      'cleanup reaps both bootstrap helpers and turn work');
  });
}

test('supervisor events: 60s at rest means zero spawns and zero STATUS writes; socket loss stays working', { timeout: 30000 }, async (t) => {
  const clockScale = 20;
  const f = await fixture(t, { clockScale });
  // Keep the 10 s real-time grace headroom during flaps instead of grok's 10 s virtual turn-trust deadline.
  writeFixtureFile(join(f.env.HUD_HOME, 'harnesses.json'), JSON.stringify({ grok: { state_trust: 'advisory' } }));
  writeFixtureFile(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'rest-events', 10);
  const job = await f.call('hud_create', { role: 'rest-events', request_key: 'rest-events', task: 'Synthetic rest.' });
  // Wait for both supervisor startup queries and the watcher's one-time subscription before snapshotting baselines.
  await until(() =>
    cliState(job.task_dir)?.agent_session_id &&
    cliState(job.task_dir)?.pid_start_time &&
    f.socketRequests.some((r) => r.id === 'hud-cli-events') &&
    f.socketRequests.some((r) => r.id === 'hud-watch')
  );
  const writes = fs.readFileSync(join(f.env.HOME, 'status-writes'), 'utf8');
  // The MCP can still be doing its asynchronous caller-pane delivery lookup.
  const supervisorCommands = () => withoutCallerLookups(f.commands());
  const commands = supervisorCommands(), requests = f.socketRequests.length;
  // Observe two actual 30 s safety ticks rather than assuming the test timer
  // and the supervisor's accelerated clock get the same scheduling time.
  // Running the rest ticks first also aligns the flap loop right after a tick,
  // away from the next 30 s safety tick's quiet-status descendant scan.
  const beforeRest = statusQueries(f, job);
  await until(() => statusQueries(f, job) >= beforeRest + 2);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(supervisorCommands(), commands);
  const extra = f.socketRequests.slice(requests);
  assert.ok(extra.every((r) => r.method === 'agent.get'), JSON.stringify(extra));
  assert.equal(fs.existsSync(join(f.env.HOME, 'proc-scans')), false, 'working ticks never sample descendants');
  assert.equal(fs.readFileSync(join(f.env.HOME, 'status-writes'), 'utf8'), writes);
  assert.equal(cliState(job.task_dir).state, 'working');
  for (let i = 0; i < 6; i++) {
    f.push(job.job, i % 2 ? 'working' : 'done');
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.equal(fs.readFileSync(join(f.env.HOME, 'status-writes'), 'utf8'), writes, 'no-report status flaps do not write STATUS');
  assert.equal(fs.existsSync(join(f.env.HOME, 'proc-scans')), false, 'flaps never sample descendants');
  assert.deepEqual(supervisorCommands(), commands);
  writeFixtureFile(join(f.env.HOME, 'herdr-errors'), '');
  const beforeDrop = statusQueries(f, job);
  f.drop();
  await until(() => statusQueries(f, job) >= beforeDrop + 3); // Reconnect seed plus two safety ticks.
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).error, null);
  assert.deepEqual(supervisorCommands(), commands);
});

test('supervisor edges: stalled submission stays supervised; pre-input rejection closes its tab', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  fs.writeFileSync(join(f.env.HOME, 'stalled-prompt'), '');
  const live = await f.call('hud_create', { role: 'imp', on: 'agy', request_key: 'stalled', task: 'Synthetic stall.' });
  assert.notEqual(live.ok, false);
  await until(() => cliState(live.task_dir)?.state === 'working');
  assert.equal(JSON.parse(fs.readFileSync(join(live.task_dir, 'turn.json'))).seq, 1);
  assert.ok(fs.existsSync(join(live.task_dir, 'supervisor.pid')));
  assert.equal(f.commands().some((c) => c.args[0] === 'tab' && c.args[1] === 'close'), false);
  fs.unlinkSync(join(f.env.HOME, 'stalled-prompt'));
  fs.writeFileSync(join(f.env.HOME, 'rejected-prompt'), '');
  const rejected = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'rejected', task: 'Synthetic rejection.' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'dispatch_failed');
  assert.equal(fs.existsSync(join(rejected.task_dir, 'supervisor.pid')), false);
  assert.ok(f.commands().some((c) => c.args[0] === 'tab' && c.args[1] === 'close'));
});

test('supervisor edges: outage with a report settles at 60s, PID death closes with report or fails without quota scans', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'outage-events', 10);
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: f.env, stdio: 'ignore' });
  t.after(() => worker.kill('SIGKILL'));
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(worker.pid));
  const job = await f.call('hud_create', { role: 'outage-events', request_key: 'outage-report', task: 'Synthetic outage.' });
  await until(() => cliState(job.task_dir)?.pid === worker.pid);
  writeFixtureFile(join(job.task_dir, 'report.md'), 'Report survives a socket outage.\n');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  f.drop();
  await until(() => cliState(job.task_dir)?.state === 'idle_grace', 5000);
  assert.equal(cliState(job.task_dir).output_written, true);
  worker.kill('SIGKILL');
  await until(() => cliState(job.task_dir)?.state === 'closed', 3000);
  assert.equal(cliState(job.task_dir).exit_reason, 'settled');
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));
  const worker2 = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: f.env, stdio: 'ignore' });
  t.after(() => worker2.kill('SIGKILL'));
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(worker2.pid));
  const failed = await f.call('hud_create', { role: 'outage-events', request_key: 'no-report-death', task: 'Task text says quota but that is not a quota fact.' });
  await until(() => cliState(failed.task_dir)?.pid === worker2.pid);
  writeFixtureFile(join(f.env.HOME, 'pane-read'), 'quota exceeded');
  worker2.kill('SIGKILL');
  await until(() => cliState(failed.task_dir)?.state === 'failed', 3000);
  assert.equal(cliState(failed.task_dir).exit_reason, 'worker exited');
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
  assert.equal(f.commands().filter((c) => c.args[0] === 'pane' && c.args[1] === 'read').length, 2, 'only the two dispatch trust reads, no exit scan');
});

test('a cli that exits fails, and a closed tab fails', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-exit'), '');
  const exited = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-exit', task: 'Synthetic exit.' });
  await until(() => cliState(exited.task_dir)?.state === 'failed');
  assert.equal(cliState(exited.task_dir).error, 'worker exited');
  fs.unlinkSync(join(f.env.HOME, 'cli-exit'));
  fs.writeFileSync(join(f.env.HOME, 'cli-gone'), '');
  const missing = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-gone', task: 'Synthetic gone.' });
  await until(() => cliState(missing.task_dir)?.state === 'failed');
  assert.equal(cliState(missing.task_dir).error, 'worker exited');
});

for (const first of ['watcher', 'supervisor']) {
  for (const fact of ['stop', 'exit with report']) {
    test(`CLI tab-close: ${first} writes first for ${fact}`, { timeout: 10000 }, async (t) => {
      const f = await fixture(t);
      const worker = fakeCliWithChild(t, f);
      fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
      writeCliRole(f, 'tab-fact', 8);
      const job = await f.call('hud_create', { role: 'tab-fact', request_key: fact, task: 'Synthetic tab race.' });
      const dir = job.task_dir;
      await until(() => cliState(dir)?.pid === worker.pid && f.socketRequests.some((r) => r.id === 'hud-watch'));
      const supervisor = cliState(dir).supervisor_pid;
      const watcher = Number(fs.readFileSync(join(f.env.HUD_HOME, 'watch.pid'), 'utf8'));
      const second = first === 'watcher' ? supervisor : watcher;
      process.kill(second, 'SIGSTOP');
      let terminal;
      try {
        writeFixtureFile(join(dir, 'report.md'), 'Synthetic report before loss of tab.\n');
        if (fact === 'stop') fs.writeFileSync(join(dir, 'STATUS.json.stop-requested'), '');
        else { await worker.exit(); assert.equal(procStat(worker.pid), null); }
        f.closeTab();
        await until(() => cliState(dir)?.ended_at);
        terminal = cliState(dir);
        assert.equal(terminal.state, fact === 'stop' ? 'stopped' : 'closed');
        assert.equal(terminal.exit_reason, fact === 'stop' ? 'stop requested' : 'settled');
        assert.equal(terminal.output_written, true);
      } finally {
        process.kill(second, 'SIGCONT');
      }
      await until(() => readCloseReaped(job));
      await until(() => !procStat(supervisor) || procStat(supervisor)?.state === 'Z');
      assert.deepEqual(cliState(dir), terminal);
    });
  }
}

test('supervisor preserves the watcher tab-close fact when its own push socket was lost', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'lost-close', 10);
  const job = await f.call('hud_create', { role: 'lost-close', request_key: 'lost-close', task: 'Synthetic tab-close outage.' });
  await until(() => cliState(job.task_dir)?.pid);
  f.dropWorker(job.job);
  f.closeTab();
  await until(() => cliState(job.task_dir)?.exit_reason === 'tab closed');
  writeFixtureFile(join(job.task_dir, 'report.md'), 'A late report must not overwrite tab closure.\n');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(cliState(job.task_dir).state, 'failed');
  assert.equal(cliState(job.task_dir).exit_reason, 'tab closed');
});

test('an unread declared report closes at the idle deadline and reaps leftovers', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'grace-bg-cli', 1, true);
  const graceJob = await f.call('hud_create', {
    role: 'grace-bg-cli',
    request_key: 'grace-bg-hold',
    task: 'Background child holds grace.',
  });
  await until(() => cliState(graceJob.task_dir)?.pid === worker.pid);
  const child = await worker.start();
  writeFixtureFile(join(graceJob.task_dir, 'report.md'), 'Synthetic report with leftover child.\n');
  declareDone(f, graceJob);
  await until(() => cliState(graceJob.task_dir)?.state === 'idle_grace');
  const quit = () => f.commands().some((c) => c.args[1] === 'prompt' && c.args[2] === `${graceJob.job}-primary` && c.args[3] === '/quit');
  const reaped = () => f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === graceJob.task_dir);
  assert.ok(procStat(child));
  await until(() => cliState(graceJob.task_dir)?.state === 'closed', 2200);
  await until(reaped);
  assert.ok(quit());
  await until(() => procStat(child) === null);
});

test('exit is a /proc pid check: herdr errors keep working while pid lives, PID gone closes or fails, unknown PID asks after 3 ticks', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const spawnDummy = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { env: f.env, stdio: 'ignore' });
    t.after(() => { try { child.kill('SIGKILL'); } catch {} });
    return child;
  };

  // 1. Live pid stays working across repeated herdr errors, then closes cleanly once herdr recovers.
  const liveProc = spawnDummy();
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(liveProc.pid));
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  const keepAlive = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'herdr-errors-alive',
    task: 'Keep working when herdr errors while pid lives.',
  });
  await until(
    () =>
      f.socketRequests.filter((req) => req.method === 'agent.get' && req.params.target === `${keepAlive.job}-primary`).length >= 5,
    5000
  );
  assert.equal(cliState(keepAlive.task_dir).state, 'working');
  assert.equal(cliState(keepAlive.task_dir).pid, liveProc.pid);
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));
  await until(() => cliState(keepAlive.task_dir)?.state === 'closed', 8000);

  // 2. Pid gone without a report -> failed.
  const procNoReport = spawnDummy();
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(procNoReport.pid));
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const failJob = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'pid-gone-fail',
    task: 'Pid dies without report.',
  });
  await until(() => cliState(failJob.task_dir)?.pid === procNoReport.pid);
  procNoReport.kill('SIGKILL');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  await until(() => cliState(failJob.task_dir)?.state === 'failed', 5000);
  assert.equal(cliState(failJob.task_dir).exit_reason, 'worker exited');
  assert.equal(cliState(failJob.task_dir).output_written, false);
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));

  // 3. Pid gone with a report -> closed (output_written true).
  const procWithReport = spawnDummy();
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(procWithReport.pid));
  const closeJob = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'pid-gone-report',
    task: 'Pid dies after writing report.',
  });
  await until(() => cliState(closeJob.task_dir)?.pid === procWithReport.pid);
  writeFixtureFile(join(closeJob.task_dir, 'report.md'), 'Finished before exit.\n');
  procWithReport.kill('SIGKILL');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  await until(() => cliState(closeJob.task_dir)?.state === 'closed', 5000);
  assert.equal(cliState(closeJob.task_dir).exit_reason, 'settled');
  assert.equal(cliState(closeJob.task_dir).output_written, true);

  // 4. Unknown PID and three consecutive missing ticks hand off, never fail.
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));
  fs.unlinkSync(join(f.env.HOME, 'cli-pid'));
  fs.writeFileSync(join(f.env.HOME, 'no-pid'), '');
  const nullPidJob = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'null-pid-3-misses',
    task: 'Null pid requires 3 consecutive misses.',
  });
  await until(() => cliState(nullPidJob.task_dir)?.state === 'waiting_orchestrator', 6000);
  const agentGets = f.socketRequests.filter((req) => req.method === 'agent.get' && req.params.target === `${nullPidJob.job}-primary`);
  assert.ok(agentGets.length >= 4);
  assert.equal(cliState(nullPidJob.task_dir).reason, 'worker not found');
});

test('hud_send restarts a dead supervisor only when the worker is confirmed alive', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
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
  await until(() => cliState(job.task_dir)?.pid === liveWorker.pid && cliState(job.task_dir)?.supervisor_pid);
  const oldSupPid = cliState(job.task_dir).supervisor_pid;
  const startedAt = cliState(job.task_dir).started_at;
  process.kill(oldSupPid, 'SIGKILL');
  await until(() => dead(oldSupPid));
  fs.utimesSync(join(job.task_dir, 'STATUS.json'), new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 5000);
  assert.equal(cliState(job.task_dir).reason, 'supervisor exited; worker still running');

  const sent = await f.call('hud_send', { job: job.job, message_key: 'respawn', text: 'Continue with new supervisor.' });
  assert.equal(sent.sent, true);
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.supervisor_pid !== oldSupPid, 5000);
  const newSupPid = cliState(job.task_dir).supervisor_pid;
  assert.notEqual(newSupPid, oldSupPid);
  assert.equal(dead(newSupPid), false);
  assert.equal(fs.readFileSync(join(job.task_dir, 'supervisor.pid'), 'utf8').trim(), String(newSupPid));
  assert.equal(cliState(job.task_dir).pid, liveWorker.pid);
  assert.equal(cliState(job.task_dir).started_at, startedAt);
  assert.equal(cliState(job.task_dir).reason, null);
  fs.unlinkSync(join(f.env.HOME, 'hold-turn'));
  await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
  assert.equal(cliState(job.task_dir).output_written, true);
  assert.equal(cliState(job.task_dir).exit_reason, 'settled');
  await until(() => !fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));

  // 2. Dead supervisor + dead worker -> keeps today's hud_send behaviour without respawning.
  const dyingWorker = spawnDummy();
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(dyingWorker.pid));
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const goneJob = await f.call('hud_create', { role: 'respawn-cli', request_key: 'respawn-gone', task: 'No respawn when worker gone.' });
  await until(() => cliState(goneJob.task_dir)?.pid === dyingWorker.pid && cliState(goneJob.task_dir)?.supervisor_pid);
  const goneSupPid = cliState(goneJob.task_dir).supervisor_pid;
  process.kill(goneSupPid, 'SIGKILL');
  dyingWorker.kill('SIGKILL');
  await until(() => dead(goneSupPid) && dead(dyingWorker.pid));
  const sentGone = await f.call('hud_send', { job: goneJob.job, message_key: 'gone-before-watch', text: 'Worker already dead.' });
  assert.equal(sentGone.sent, true);
  // hud_send publishes any replacement supervisor PID before it returns.
  assert.equal(fs.readFileSync(join(goneJob.task_dir, 'supervisor.pid'), 'utf8').trim(), String(goneSupPid));
  fs.utimesSync(join(goneJob.task_dir, 'STATUS.json'), new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  await until(() => cliState(goneJob.task_dir)?.state === 'failed', 5000);
  // The watcher may have settled before or after the previous reply advanced the change cursor.
  const { changes, ...rejected } = await f.call('hud_send', { job: goneJob.job, message_key: 'gone-after-watch', text: 'Still dead.' });
  assert.deepEqual(rejected, { ok: false, code: 'not_continuable' });
  if (changes) assert.deepEqual(changes, [`${goneJob.job} respawn-cli: failed | worker exited`]);
  assert.equal(fs.readFileSync(join(goneJob.task_dir, 'supervisor.pid'), 'utf8').trim(), String(goneSupPid));

  // 3. Dead supervisor + unknown worker liveness -> keeps today's hud_send behaviour without respawning.
  fs.unlinkSync(join(f.env.HOME, 'cli-pid'));
  fs.unlinkSync(join(f.env.HOME, 'hold-turn'));
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  fs.writeFileSync(join(f.env.HOME, 'no-pid'), '');
  const unknownJob = await f.call('hud_create', { role: 'respawn-cli', request_key: 'respawn-unknown', task: 'No respawn when liveness unknown.' });
  await until(() => cliState(unknownJob.task_dir)?.state === 'waiting_orchestrator', 6000);
  const unknownSupPid = cliState(unknownJob.task_dir).supervisor_pid;
  process.kill(unknownSupPid, 'SIGKILL');
  await until(() => dead(unknownSupPid));
  const sentUnknown = await f.call('hud_send', { job: unknownJob.job, message_key: 'unknown-worker', text: 'Worker liveness unknown.' });
  assert.equal(sentUnknown.sent, true);
  assert.equal(fs.readFileSync(join(unknownJob.task_dir, 'supervisor.pid'), 'utf8').trim(), String(unknownSupPid));
});
