import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createServer } from 'node:net';
import { watchCommand } from '../../dist/cli/watch.js';
import { projectWorkCard } from '../../dist/collectors/work-card.js';
import { workStateInk } from '../../dist/render/work-card.js';
import { theme } from '../../dist/render/colors.js';
import { procStat } from '../../dist/mcp/cli-judge.js';
import { readReportMeta } from '../../dist/roles/report-meta.js';
import {
  workerFor,
  cardText,
  legacyFixture as fixture,
  workerClient,
  resultValue,
  until,
  fakeCliWithChild,
  statusQueries,
  readCloseQuit,
  readCloseReaped,
  reapAttempts,
  cliToken,
  runProgress,
  declareDone,
  publishPiGrace,
  writeCliRole,
  cliState,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

test('TERM during the watcher startup dist-lock wait leaves no advertised PID', async (t) => {
  // Model another publisher holding the dist lock without stalling unrelated test processes.
  const preload = `if (process.argv[1]?.endsWith('/hud-watch.mjs')) {
    const { Server } = await import('node:net');
    const fs = await import('node:fs');
    const listen = Server.prototype.listen;
    Server.prototype.listen = function(name, ...args) {
      if (!String(name).startsWith('\\0myhud-dist-')) return listen.call(this, name, ...args);
      queueMicrotask(() => this.emit('error', Object.assign(new Error('busy'), {code:'EADDRINUSE'})));
      setImmediate(() => {
        fs.writeFileSync(process.env.HOME + '/waiting-on-dist', String(process.pid));
        process.kill(process.pid, 'SIGTERM');
      });
      return this;
    };
  }`;
  const url = 'data:text/javascript,' + encodeURIComponent(preload);
  const f = await fixture(t, true, `process.env.NODE_OPTIONS += ' --import=' + ${JSON.stringify(url)};`);
  await f.call('hud_create', { role: 'imp', task: 'Synthetic startup.' });
  const waiting = join(f.env.HOME, 'waiting-on-dist');
  await until(() => fs.existsSync(waiting) && !procStat(Number(fs.readFileSync(waiting, 'utf8'))));
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')), false);
});

test('hud_close during Pi startup records stopped without relying on the watcher', { timeout: 10000 }, async (t) => {
  const skipWatcher = 'data:text/javascript,' + encodeURIComponent(
    `if (process.argv[1]?.endsWith('/hud-watch.mjs')) process.exit(0);`);
  const f = await fixture(t, true, `process.env.NODE_OPTIONS += ' --import=' + ${JSON.stringify(skipWatcher)};`);
  fs.writeFileSync(join(f.env.HOME, 'hold-pi-start'), '');
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const launching = f.call('hud_create', { role: 'imp', task: 'Synthetic startup stop.' });
  const jobs = join(f.env.HUD_HOME, 'jobs');
  let dir, id, closing;
  try {
    await until(() => {
      if (!fs.existsSync(jobs)) return false;
      [id] = fs.readdirSync(jobs);
      if (!id) return false;
      dir = join(jobs, id);
      return cliState(dir)?.state === 'working';
    });
    assert.equal(procStat(cliState(dir).pid)?.start, cliState(dir).pid_start_time);
    closing = f.call('hud_close', { job: id });
  } finally {
    fs.writeFileSync(join(f.env.HOME, 'release-prompt-result'), '');
    await launching;
  }
  assert.equal((await closing).exit_code, 0);
  assert.ok(fs.existsSync(join(dir, 'STATUS.json.stop-requested')));
  assert.equal(cliState(dir).state, 'stopped');
  assert.equal(cliState(dir).exit_reason, 'stop requested');
  assert.ok(cliState(dir).ended_at);
  assert.equal((await f.call('hud_read', {})).jobs.some((job) => job.job === id), false);
});

test('read-close: hud_read closes settled CLI and pi workers within one tick', { timeout: 35000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'read-close-cli', 30);
  for (const role of ['read-close-cli', 'imp']) {
    const job = await f.call('hud_create', { role, request_key: `close-on-read-${role}`, task: 'Synthetic task.', package: 'Original package' });
    if (role === 'imp') await publishPiGrace(job); // Fake pi settles only after the initial prompt.
    await until(() => cliState(job.task_dir)?.state === 'idle_grace', 15000);
    const grace = cliState(job.task_dir);
    let queries = statusQueries(f, job);
    assert.equal(readCloseReaped(job), undefined);
    const read = await f.call('hud_read', { job: job.job });
    assert.match(read.digest.result, /^Synthetic /);
    // For CLI, exclude safety ticks that fired while hud_read waited on CPU before writing read_at.
    if (role !== 'imp') queries = statusQueries(f, job);
    // One-tick settlement is checked via agent.get count and ended_at < idle_deadline_at, not wall time.
    await until(() => cliState(job.task_dir)?.state === 'closed', 15000);
    const closed = cliState(job.task_dir);
    assert.equal(closed.exit_reason, 'closed after report read');
    assert.equal(closed.output_written, true);
    assert.equal(closed.settled_at, grace.settled_at);
    assert.ok(Date.parse(closed.ended_at) < Date.parse(grace.idle_deadline_at));
    const after = statusQueries(f, job);
    assert.ok(after <= queries + 1, `${role}: agent.get ${queries} -> ${after}`);
    if (role !== 'imp') assert.ok(readCloseQuit(f, job));
    await until(() => readCloseReaped(job), 15000);
    assert.ok(f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir));
    const send = { job: job.job, text: 'Synthetic repair.' };
    const repair = await f.call('hud_send', send);
    assert.equal(repair.continued_as, repair.job);
    assert.notEqual(repair.job, job.job);
    assert.equal(repair.role, role);
    assert.equal(repair.package, 'Original package');
    const brief = fs.readFileSync(join(repair.task_dir, 'brief.md'), 'utf8');
    assert.ok(brief.startsWith(`${send.text}\n\n## Context References\n`));
    assert.ok(brief.includes(`${job.job} brief: ${JSON.stringify(join(job.task_dir, 'brief.md'))}`));
    assert.ok(brief.includes(`${job.job} report: ${JSON.stringify(join(job.task_dir, 'report.md'))}`));
    assert.equal((await f.call('hud_send', send)).continued_as, repair.job);
  }
});

test('read-close: reading the old Pi report after an admitted continuation does not reap', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  await f.startCliSocket();
  const job = await f.call('hud_create', { role: 'imp', request_key: 'pi-continuation', task: 'Synthetic task.' });
  await publishPiGrace(job);
  const sent = await f.call('hud_send', { job: job.job, message_key: 'next', text: 'Synthetic continuation.' });
  assert.equal(sent.sent, true);
  assert.equal(sent.queued, undefined, 'the continuation was admitted from idle grace');
  assert.match((await f.call('hud_read', { job: job.job })).digest.result, /^Synthetic /);
  await new Promise((done) => setTimeout(done, 450));
  assert.equal(reapAttempts(f, job), 0);
  assert.equal(cliState(job.task_dir).state, 'idle_grace');
  assert.equal((await f.call('hud_send', { job: job.job, text: 'Do not repair the already continued report.' })).code, 'not_continuable');

  await publishPiGrace(job);
  assert.match((await f.call('hud_read', { job: job.job })).digest.result, /^Synthetic /);
  await until(() => readCloseReaped(job));
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
});

test('read-close: aborts Pi reap when fresh Herdr status has turned working', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  await f.startCliSocket();
  const job = await f.call('hud_create', { role: 'imp', request_key: 'pi-resumed', task: 'Synthetic task.' });
  await publishPiGrace(job, worker);
  let state = 'idle';
  f.piStatus(() => (state = 'working')); // The worker resumes during the automatic reap preflight.
  assert.match((await f.call('hud_read', { job: job.job })).digest.result, /^Synthetic /);
  await until(() => statusQueries(f, job) > 0);
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(state, 'working');
  assert.ok(procStat(worker.pid));
  assert.equal(cliState(job.task_dir).state, 'idle_grace', 'the on-disk status is still stale');
  assert.equal(reapAttempts(f, job), 0);
  assert.equal(readCloseReaped(job), undefined);

  writeFixtureFile(join(job.task_dir, 'STATUS.json'), JSON.stringify({ ...cliState(job.task_dir), state: 'working' }));
  assert.equal((await f.call('hud_close', { job: job.job })).exit_code, 0);
  assert.equal(reapAttempts(f, job), 1, 'explicit close still invokes the reaper on a working job');
  assert.ok(fs.existsSync(join(job.task_dir, 'STATUS.json.stop-requested')));
});

test('read-close: failed Pi reap is retried on the slow safety tick without a file event', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 350);
  await f.startCliSocket();
  const job = await f.call('hud_create', { role: 'imp', request_key: 'pi-retry', task: 'Synthetic task.' });
  await publishPiGrace(job);
  fs.writeFileSync(join(job.task_dir, 'fail-reap-once'), '');
  assert.match((await f.call('hud_read', { job: job.job })).digest.result, /^Synthetic /);
  const log = join(f.env.HUD_HOME, 'watch.log');
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes(`reap ${job.job} state=idle_grace exit=1`));
  assert.equal(cliState(job.task_dir).state, 'idle_grace');
  assert.equal(readCloseReaped(job), undefined);
  await until(() => readCloseReaped(job));
  assert.equal(reapAttempts(f, job), 2);
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
});

for (const rewrite of [false, true]) test(`read-close: Pi retries captured children after root exit and snapshot ENOSPC (rewrite=${rewrite})`, { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 350);
  const worker = fakeCliWithChild(t, f);
  await f.startCliSocket();
  const job = await f.call('hud_create', { role: 'imp', request_key: 'pi-partial-reap', task: 'Synthetic task.' });
  const child = await worker.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], true);
  const start = procStat(child).start;
  t.after(() => { if (procStat(child)?.start === start) process.kill(child, 'SIGKILL'); });
  await publishPiGrace(job, worker);
  const flag = join(f.env.HOME, 'snapshot-enospc');
  writeFixtureFile(flag, String(child));
  fs.writeFileSync(join(job.task_dir, 'reap-worker'), '');
  f.piStatus(() => procStat(worker.pid) ? 'idle' : 'agent_not_found');
  assert.match((await f.call('hud_read', { job: job.job })).digest.result, /^Synthetic /);
  const log = join(f.env.HUD_HOME, 'watch.log');
  // The watcher creates watch.log on its first write; under load that can follow the read.
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('synthetic ENOSPC'));
  assert.equal(procStat(worker.pid), null);
  assert.equal(procStat(child)?.start, start);
  assert.equal(cliState(job.task_dir).state, 'idle_grace');
  assert.equal(readCloseReaped(job), undefined);
  if (rewrite) {
    const report = join(job.task_dir, 'report.md');
    writeFixtureFile(report, 'Synthetic rewritten report.\n');
    assert.ok(Math.floor(fs.statSync(report).mtimeMs) > Date.parse(cliState(job.task_dir).settled_at));
    await until(() => Date.now() > fs.statSync(report).mtimeMs);
    assert.match((await f.call('hud_read', { job: job.job })).digest.result, /rewritten report/);
  }
  // No relevant file event on fault removal: the slow retry must work without a live agent or eligible report.
  fs.unlinkSync(flag);
  await until(() => readCloseReaped(job));
  assert.ok(reapAttempts(f, job) >= 2);
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
  assert.ok(!procStat(child) || procStat(child).state === 'Z');
});

for (const trigger of ['native deadline', 'native one-shot']) test(`pi reap: ${trigger} retains ancestry captured before shutdown`, { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  const worker = fakeCliWithChild(t, f);
  const job = await f.call('hud_create', { role: 'imp', request_key: trigger, task: 'Synthetic task.' });
  const child = await worker.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], true);
  const start = procStat(child).start;
  t.after(() => { if (procStat(child)?.start === start) process.kill(child, 'SIGKILL'); });
  await publishPiGrace(job, worker);
  if (trigger === 'native one-shot') writeFixtureFile(join(job.task_dir, 'STATUS.json'), JSON.stringify({ ...cliState(job.task_dir), state: 'working' }));
  declareDone(f, job, false);
  process.kill(worker.pid, 'SIGTERM');
  await until(() => !procStat(worker.pid));
  assert.equal(procStat(child)?.start, start);
  const file = join(job.task_dir, 'STATUS.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...cliState(job.task_dir), state: 'closed', exit_reason: 'settled' }));
  fs.renameSync(`${file}.tmp`, file);
  await until(() => readCloseReaped(job));
  assert.ok(!procStat(child) || procStat(child).state === 'Z');
});

for (const fault of ['rename', 'open']) test(`pi reap: --done snapshot ${fault} ENOSPC before native shutdown`, { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  const worker = fakeCliWithChild(t, f);
  const job = await f.call('hud_create', { role: 'imp', request_key: `pi-done-${fault}`, task: 'Synthetic task.' });
  const child = await worker.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], true);
  const start = procStat(child).start;
  t.after(() => { if (procStat(child)?.start === start) process.kill(child, 'SIGKILL'); });
  await publishPiGrace(job, worker);
  const file = join(job.task_dir, 'STATUS.json');
  writeFixtureFile(file, JSON.stringify({ ...cliState(job.task_dir), state: 'working' }));
  fs.writeFileSync(join(f.env.HOME, 'progress-snapshot-enospc'), fault);
  const done = runProgress(f, job.task_dir, '--done');
  assert.equal(fs.existsSync(join(job.task_dir, 'worker-tree.json')), false);
  process.kill(worker.pid, 'SIGTERM');
  await until(() => !procStat(worker.pid));
  assert.equal(procStat(child)?.start, start);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...cliState(job.task_dir), state: 'closed', exit_reason: 'settled' }));
  fs.renameSync(`${file}.tmp`, file);
  if (fault === 'rename') {
    await until(() => readCloseReaped(job));
    assert.ok(!procStat(child) || procStat(child).state === 'Z', 'watcher recovered the captured orphan');
  } else {
    const log = join(f.env.HUD_HOME, 'watch.log');
    await until(() => readCloseReaped(job) && fs.existsSync(log) &&
      fs.readFileSync(log, 'utf8').includes('worker-tree snapshot unresolved'));
    assert.equal(reapAttempts(f, job), 1, 'missing proof cannot be recovered by another reap');
    assert.equal(fs.readFileSync(log, 'utf8').match(/worker-tree snapshot unresolved/g)?.length, 1);
    assert.equal(procStat(child)?.start, start, 'unprovable child was left alone');
  }
  assert.equal(done.status, 1, done.stderr);
  assert.match(done.stderr, /synthetic ENOSPC in hud-progress/);
});

test('read-close: rejected CLI quit keeps closed while the watcher retries terminal reap', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 450);
  const worker = fakeCliWithChild(t, f);
  writeCliRole(f, 'cli-retry', 8);
  const job = await f.call('hud_create', { role: 'cli-retry', request_key: 'cli-retry', task: 'Synthetic cleanup retry.' });
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  fs.writeFileSync(join(f.env.HOME, 'reject-quit'), '');
  fs.writeFileSync(join(job.task_dir, 'fail-reap-once'), '');
  fs.writeFileSync(join(job.task_dir, 'reap-worker'), '');
  assert.match((await f.call('hud_read', { job: job.job })).digest.result, /^Synthetic /);
  const log = join(f.env.HUD_HOME, 'watch.log');
  await until(() => fs.readFileSync(log, 'utf8').includes(`reap ${job.job} state=closed exit=1`));
  assert.ok(procStat(worker.pid), 'the rejected quit and failed reap did not stop the worker');
  assert.equal(readCloseReaped(job), undefined);
  assert.equal(cliState(job.task_dir).state, 'closed');
  assert.ok(readCloseQuit(f, job));
  await until(() => readCloseReaped(job));
  assert.equal(reapAttempts(f, job), 2);
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
  await until(() => !procStat(worker.pid));
});

test('read-close: CLI pre-quit snapshot failure hands cleanup to the watcher and retries', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 350);
  const worker = fakeCliWithChild(t, f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'cli-snapshot-failure', 30);
  const job = await f.call('hud_create', { role: 'cli-snapshot-failure', request_key: 'cli-snapshot-failure', task: 'Synthetic task.' });
  await until(() => cliState(job.task_dir)?.pid === worker.pid);
  const child = await worker.start();
  writeFixtureFile(join(job.task_dir, 'report.md'), 'Synthetic report.\n');
  declareDone(f, job);
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  const flag = join(f.env.HOME, 'snapshot-enospc');
  fs.writeFileSync(flag, '');
  assert.match((await f.call('hud_read', { job: job.job })).digest.result, /^Synthetic /);
  await until(() => fs.existsSync(join(f.env.HUD_HOME, 'watch.log')) && fs.readFileSync(join(f.env.HUD_HOME, 'watch.log'), 'utf8').includes('synthetic ENOSPC'));
  assert.equal(readCloseQuit(f, job), false, 'keep the root in place for the watcher to capture');
  assert.equal(cliState(job.task_dir).state, 'closed');
  assert.equal(readCloseReaped(job), undefined);
  await until(() => !procStat(child)); // Verified descendants are cleaned even though capture cannot persist yet.
  fs.unlinkSync(flag);
  await until(() => readCloseReaped(job));
  assert.ok(reapAttempts(f, job) >= 2);
});

test('read-close: a settled Pi with a fresh report closes and reaps a current-turn child', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  const worker = fakeCliWithChild(t, f);
  await f.startCliSocket();
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const job = await f.call('hud_create', { role: 'imp', request_key: 'pi-new-child', task: 'Synthetic task.' });
  const child = await worker.start();
  writeFixtureFile(join(job.task_dir, 'STATUS.json'), JSON.stringify({
    slot: 'primary', task_dir: job.task_dir, state: 'working', pid: worker.pid, pid_start_time: procStat(worker.pid).start,
  }));
  const report = 'Synthetic native Pi tool report.\n';
  const native = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import hud from ${JSON.stringify(pathToFileURL(resolve('integrations/pi/package/extensions/hud.mjs')).href)};
    process.argv.push('--hud-worker-tools');
    const tools = new Map();
    await hud({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } });
    const tool = tools.get('hud_report');
    const result = await tool.execute('report', {
      text: ${JSON.stringify(report)}, summary: 'Synthetic native result.', files: ['./src/native.ts'],
    });
    console.log(JSON.stringify({ result, schema: tool.parameters }));
  `], { env: { ...f.env, HUD_JOB_DIR: job.task_dir }, encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  const { result, schema } = JSON.parse(native.stdout);
  assert.deepEqual(schema.required, ['text']);
  assert.equal(schema.properties.summary.type, 'string');
  assert.equal(schema.properties.files.type, 'array');
  assert.equal(result.details.path, join(job.task_dir, 'report.md'));
  assert.equal(result.terminate, true);
  assert.equal(fs.existsSync(join(job.task_dir, 'done.json')), false);
  const meta = readReportMeta(job.task_dir);
  assert.equal(meta.summary, 'Synthetic native result.');
  assert.deepEqual(meta.files, ['src/native.ts']);
  assert.equal(fs.statSync(join(job.task_dir, 'report-meta.json')).mode & 0o777, 0o600);
  assert.equal(cliState(job.task_dir).state, 'working', 'publication alone does not declare pi settlement');
  await publishPiGrace(job, worker, false); // Synthetic pi-roles native turn end.
  assert.equal((await f.call('hud_read', { job: job.job, mode: 'full' })).report, report);
  await until(() => readCloseReaped(job));
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
  await until(() => procStat(child) === null);
});

test('read-close: listing an unread report leaves the CLI grace deadline in place', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'unread-close-cli', 2);
  const job = await f.call('hud_create', { role: 'unread-close-cli', request_key: 'unread-close', task: 'Synthetic task.' });
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  const { idle_deadline_at } = cliState(job.task_dir);
  for (const args of [{}, { view: 'recent' }]) {
    assert.equal((await f.call('hud_read', args)).jobs.find((row) => row.job === job.job).report_unread, true);
  }
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(cliState(job.task_dir).state, 'idle_grace');
  assert.equal(readCloseQuit(f, job), false);
  assert.equal(readCloseReaped(job), undefined);
  await until(() => cliState(job.task_dir)?.state === 'closed');
  const closed = cliState(job.task_dir);
  assert.equal(closed.exit_reason, 'settled');
  assert.ok(Date.parse(closed.ended_at) >= Date.parse(idle_deadline_at));
  assert.ok(readCloseQuit(f, job));
  await until(() => readCloseReaped(job));
});

test('read-close: the CLI receipt survives a shell-counter change and needs no pane read', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'child-read-cli', 8, true, 'claude');
  const job = await f.call('hud_create', { role: 'child-read-cli', request_key: 'child-read-close', task: 'Synthetic task.' });
  await until(() => cliState(job.task_dir)?.pid === worker.pid);
  const child = await worker.start();
  const report = join(job.task_dir, 'report.md'), pane = join(f.env.HOME, 'pane-read');
  writeFixtureFile(pane, `⏺ report written: ${report}\n2 shells still running\n`);
  const call = workerClient(t, f, job.task_dir);
  assert.deepEqual(resultValue(await call('hud_report', { text: 'Synthetic report.\n', turn: cliToken(job.task_dir) })), { path: report });
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  assert.ok(procStat(child));
  writeFixtureFile(pane, `⏺ report written: ${report}\n1 shell still running\n`);
  fs.writeFileSync(join(f.env.HOME, 'pane-read-timeout'), '');
  assert.match((await f.call('hud_read', { job: job.job })).digest.result, /^Synthetic /);
  await until(() => readCloseReaped(job));
  assert.ok(readCloseQuit(f, job));
  assert.equal(f.socketRequests.filter(({ method }) => method === 'pane.read').length, 0);
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
  await until(() => procStat(child) === null);
});

test('read-close: a live pre-turn CLI child does not block settlement or close', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  const child = await worker.start();
  writeCliRole(f, 'pre-turn-cli', 20);
  const job = await f.call('hud_create', { role: 'pre-turn-cli', request_key: 'pre-turn-read-close', task: 'Synthetic task.' });
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  assert.match((await f.call('hud_read', { job: job.job })).digest.result, /^Synthetic /);
  await until(() => readCloseReaped(job));
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
  assert.ok(readCloseQuit(f, job));
  await until(() => procStat(child) === null);
});

test('startup failure closes the tab, reports the pi-roles cause instead of the timeout, and is reaped', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'fail-start'), 'timed out waiting for agent startup');
  fs.writeFileSync(join(f.env.HOME, 'pane-read'), '[roles] synthetic start failed: unsupported thinking\n');
  const job = await f.call('hud_create', { role: 'general', on: 'pi', request_key: 'failed-launch', task: 'Synthetic task.' });
  assert.equal(job.ok, false);
  assert.equal(job.code, 'dispatch_failed');
  assert.match(job.reason, /synthetic start failed/);
  const status = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json')));
  assert.equal(status.state, 'failed');
  assert.equal(status.exit_reason, 'dispatch_failed');
  assert.match(status.error, /synthetic start failed/);
  assert.ok(Number.isFinite(Date.parse(status.ended_at)));
  assert.match(cardText(workerFor(f, job.job)), /synthetic start failed/);
  assert.deepEqual(f.commands().find(({ args }) => args[0] === 'tab' && args[1] === 'close')?.args,
    ['tab', 'close', 'w4E:t2']);
  assert.equal(f.commands().some(({ args }) => args[0] === 'agent' && args[1] === 'prompt'), false);
  await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
  assert.ok(f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir));
  await until(() => !fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
});

test('stopped jobs read immediately, render neutral and are terminal to the watcher', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  const job = await f.call('hud_create', { role: 'imp', request_key: 'stopped', task: 'Synthetic stop.' });
  writeFixtureFile(
    join(job.task_dir, 'STATUS.json'),
    JSON.stringify({ state: 'stopped', ended_at: new Date().toISOString() })
  );
  assert.equal((await f.call('hud_read', { job: job.job, wait_ms: 120000 })).state, 'stopped');
  const worker = workerFor(f, job.job);
  assert.equal(worker.state, 'stopped');
  assert.equal(worker.work.failed, false);
  assert.equal(projectWorkCard(worker, Date.now()).state, 'done');
  assert.equal(workStateInk(projectWorkCard(worker, Date.now())), theme.board.muted);
  assert.match(cardText(worker), /stopped/);
  await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
  await until(() => !fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
});

const failedRetentionMs = 250;

test('failed STATUS uses its mtime when ended_at is absent or invalid', { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { failedRetentionMs });
  for (const ended_at of [undefined, 'not-a-date']) {
    const job = await f.call('hud_create', { role: 'imp', request_key: String(ended_at), task: 'Synthetic task.' });
    const pidFile = join(f.env.HUD_HOME, 'watch.pid');
    await until(() => fs.existsSync(pidFile));
    const file = join(job.task_dir, 'STATUS.json');
    writeFixtureFile(file, JSON.stringify({ state: 'failed', ended_at }));
    const mtime = fs.statSync(file).mtimeMs;
    const reapedAt = () => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at;
    await until(reapedAt);
    // Retention is a product deadline: compare the reaper's receipt to the actual
    // file mtime, not to a sleep that can overshoot when the observer is descheduled.
    assert.ok(Date.parse(reapedAt()) >= mtime + failedRetentionMs - 1);
    await until(() => !fs.existsSync(pidFile));
  }
});

test('watcher subscribes to herdr and fails only a nonfinal job whose tab closes', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  let socket, request;
  const server = createServer((client) => {
    socket = client;
    createInterface({ input: client }).on('line', (line) => {
      request = JSON.parse(line);
      client.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
    });
  });
  t.after(() => {
    socket?.destroy();
    server.close();
  });
  server.listen(f.env.HERDR_SOCKET_PATH);
  await once(server, 'listening');
  const job = await f.call('hud_create', { role: 'imp', request_key: 'tab-close', task: 'Synthetic task.' });
  await until(() => request);
  assert.equal(request.method, 'events.subscribe');
  assert.deepEqual(request.params, { subscriptions: [{ type: 'tab.closed' }] });
  const statusFile = join(job.task_dir, 'STATUS.json');
  const emit = (tab_id) =>
    socket.write(
      JSON.stringify({
        event: 'tab.closed',
        data: {
          type: 'tab_closed',
          tab_id,
          workspace_id: 'w4E',
        },
      }) + '\n'
    );
  emit('foreign-tab');
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(JSON.parse(fs.readFileSync(statusFile)).state, 'working');
  const finalDir = join(f.env.HUD_HOME, 'jobs', 'j0000000000000000');
  fs.mkdirSync(finalDir);
  writeFixtureFile(join(finalDir, 'SESSION.txt'), 'TAB=w4E:t2\n');
  writeFixtureFile(
    join(finalDir, 'STATUS.json'),
    JSON.stringify({ state: 'failed', exit_reason: 'original', ended_at: new Date().toISOString() })
  );
  emit('w4E:t2');
  await until(() => JSON.parse(fs.readFileSync(statusFile)).state === 'failed');
  assert.equal(JSON.parse(fs.readFileSync(statusFile)).exit_reason, 'tab closed');
  assert.equal(JSON.parse(fs.readFileSync(join(finalDir, 'STATUS.json'))).exit_reason, 'original');
  await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
  await until(() => !fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
  assert.ok(f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir));
  assert.ok(!f.commands().some((c) => c.command === 'herdr' && c.args[1] === 'get' && c.args[2] !== 'w4E:p1'));
});

test('the watcher settles a dead stop-requested Pi worker on its initial scan', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f), start = procStat(worker.pid).start;
  await worker.exit();
  const id = 'j0000000000000001', dir = join(f.env.HUD_HOME, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ job: id, dispatch_exit_code: 0 }));
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', pid: worker.pid, pid_start_time: start }));
  fs.writeFileSync(join(dir, 'STATUS.json.stop-requested'), '');
  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { env: f.env, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = once(child, 'exit');
  await until(() => cliState(dir)?.state === 'stopped', 4000);
  assert.equal(cliState(dir).exit_reason, 'stop requested');
  assert.ok(cliState(dir).ended_at);
  assert.deepEqual(await exited, [0, null]);
});

test(
  'thin watcher starts once, catches up, respects grace and failed deadline, then exits',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { failedRetentionMs });
    const jobs = join(f.env.HUD_HOME, 'jobs');
    const caught = join(jobs, 'j0000000000000000');
    fs.mkdirSync(caught, { recursive: true });
    writeFixtureFile(join(caught, 'job.json'), JSON.stringify({ job: 'j0000000000000000' }));
    writeFixtureFile(join(caught, 'SESSION.txt'), 'TAB=synthetic-catchup\n');
    writeFixtureFile(join(caught, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
    const first = await f.call('hud_create', { role: 'imp', request_key: 'watch-one', task: 'Synthetic task.' });
    const reaped = (dir) => f.commands().filter((c) => c.command === 'pi-role-reap' && c.args[0] === dir).length;
    await until(() => reaped(caught) === 1);
    const pidFile = join(f.env.HUD_HOME, 'watch.pid');
    const pid = fs.readFileSync(pidFile, 'utf8');
    process.kill(Number(pid), 0);
    assert.ok(fs.readFileSync(`/proc/${pid.trim()}/cmdline`, 'utf8').includes('hud-watch.mjs'));
    const second = await f.call('hud_create', { role: 'imp', request_key: 'watch-two', task: 'Synthetic task.' });
    assert.equal(fs.readFileSync(pidFile, 'utf8'), pid);
    const watchLog = () => fs.readFileSync(join(f.env.HUD_HOME, 'watch.log'), 'utf8');
    assert.equal(
      watchLog()
        .split('\n')
        .filter((l) => l.includes('start pid=')).length,
      1
    );
    writeFixtureFile(join(first.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    writeFixtureFile(join(second.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(reaped(first.task_dir), 0);
    assert.equal(fs.existsSync(pidFile), true, 'grace jobs must keep the watcher alive');
    assert.equal(watchLog().match(/herdr events unavailable/g)?.length, 1);
    writeFixtureFile(join(second.task_dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
    writeFixtureFile(join(first.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
    await until(() => reaped(first.task_dir) === 1);
    const ended = Date.now();
    writeFixtureFile(
      join(second.task_dir, 'STATUS.json'),
      JSON.stringify({ state: 'failed', ended_at: new Date(ended).toISOString() })
    );
    await new Promise((done) => setTimeout(done, 75));
    assert.equal(reaped(second.task_dir), 0);
    assert.equal(fs.existsSync(pidFile), true);
    await until(() => reaped(second.task_dir) === 1);
    assert.ok(Date.now() >= ended + failedRetentionMs);
    await until(() => !fs.existsSync(pidFile));
    await until(() => {
      try {
        process.kill(Number(pid), 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.match(watchLog(), /no open jobs or failed deadlines/);
    assert.equal(JSON.parse(fs.readFileSync(join(second.task_dir, 'job.json'))).reaped_at !== undefined, true);
    console.log('Synthetic watch.log:\n' + watchLog());
  }
);

test('hud watch catch-up does not replay reportless failures after hud_read or hud_close', async (t) => {
  const f = await fixture(t);
  const cwd = join(f.root, 'untrusted checkout');
  fs.mkdirSync(cwd);
  const jobs = [];
  for (const method of ['hud_read', 'hud_close', 'unhandled']) {
    const job = await f.call('hud_create', { role: 'general', on: 'claude', request_key: method, task: 'Synthetic attempt.', cwd });
    assert.equal(job.code, 'untrusted_cwd');
    jobs.push(job);
    if (method === 'hud_read') {
      // A failed dispatch can also have only a job receipt, not a STATUS file.
      fs.unlinkSync(join(job.task_dir, 'STATUS.json'));
      assert.equal((await f.call(method, { job: job.job })).state, 'failed');
    } else if (method === 'hud_close') {
      assert.equal((await f.call(method, { job: job.job })).exit_code, 0);
    }
  }
  for (let i = 0; i < 2; i++) {
    const lines = [], ac = new AbortController();
    t.after(() => ac.abort());
    const watch = watchCommand([], { env: f.env, stdout: (line) => lines.push(line.trim()), stderr: () => {} }, { signal: ac.signal });
    await until(() => lines.length);
    ac.abort();
    await watch;
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(jobs[2].job));
  }
});
