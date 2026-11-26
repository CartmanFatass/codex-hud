import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { main } from '../../dist/cli/hud-main.js';
import { reapStubOptions } from '../helpers/reap-stub.mjs';
import { watchingMod } from '../../dist/roles/notify.js';
import { appendPanelAction } from '../../dist/collectors/panel-actions.js';
import { appendTry } from '../../dist/collectors/try-records.js';
import { watchCommand } from '../../dist/cli/watch.js';
import { procStat } from '../../dist/mcp/cli-judge.js';
import { notifyQuestion, publishQuestion } from '../../dist/worker/qa.js';
import { archiveJob } from '../../dist/roles/job-archive.js';
import { cachedReportSignature, writeReportMeta } from '../../dist/roles/report-meta.js';
import { notify, watching } from '../../packages/hud-mcp/bin/hud-notify.mjs';
import { git, initRepo } from '../fixtures/managed-worktree.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { cleanupFixture, stopChild } from '../helpers/process-cleanup.mjs';
import { until as waitUntil } from '../helpers/until.mjs';
import { workSummaryPath } from '../../dist/collectors/work-summary-snapshot.js';

const readHint = (job) => `hud_read job=${job} (mode: "full" for the whole report)`;

function writeJob(hudHome, id, pane, pkg, status, report = false, parent_job) {
  const dir = join(hudHome, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  writeFixtureFile(
    join(dir, 'job.json'),
    JSON.stringify({
      job: id,
      role: 'imp',
      package: pkg,
      herdr_pane: pane,
      created_at: new Date().toISOString(),
      cli: { agent: 'claude' },
      dispatch_exit_code: 0,
      stderr_tail: '',
      parent_job,
    })
  );
  if (status !== null) {
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify(status));
  }
  if (report) {
    writeFixtureFile(join(dir, 'report.md'), 'Synthetic report.');
  }
  return dir;
}

function observeStats(t, file) {
  let count = 0;
  const stat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    if (String(path) === file) count++;
    return stat(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => count;
}

const until = (check, signalOrLimit) => waitUntil(check, signalOrLimit, 'timed out waiting for expected watcher output');

for (const scenario of ['merged', 'picked', 'picked later', 'amended', 'dirty', 'disposable', 'mixed ignored', 'unmerged', 'nested']) test(`watcher preserves data when cleaning a ${scenario} managed worktree`, (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-worktree-'));
  cleanupFixture(t, { root: home });
  const main_root = initRepo(home);
  if (scenario === 'nested') {
    fs.mkdirSync(join(main_root, 'vendor'));
    fs.writeFileSync(join(main_root, 'vendor', 'tracked.txt'), 'parent baseline\n');
    git(main_root, 'add', 'vendor');
    git(main_root, 'commit', '-qm', 'track the vendor file');
  }
  const base_head = git(main_root, 'rev-parse', 'HEAD');
  const id = 'j00000000000000f1', branch = 'wt/imp-0000f1', root = join(home, 'demo-wt', 'imp-0000f1');
  git(main_root, 'worktree', 'add', '-qb', branch, root, base_head);
  const vendor = join(root, 'vendor');
  let nestedCommit;
  if (scenario === 'nested') {
    git(vendor, 'init', '-q');
    fs.writeFileSync(join(vendor, 'tracked.txt'), 'nested-only content\n');
    git(vendor, 'add', 'tracked.txt');
    git(vendor, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@invalid', 'commit', '-qm', 'nested-only commit');
    nestedCommit = git(vendor, 'rev-parse', 'HEAD');
    fs.writeFileSync(join(vendor, 'tracked.txt'), 'parent baseline\n');
    assert.equal(git(root, 'status', '--porcelain'), '', 'the parent status does not see the nested repo');
  } else {
    fs.appendFileSync(join(root, 'tracked.txt'), 'new commit\n');
    git(root, 'commit', '-qam', 'job work');
    if (scenario === 'merged') git(main_root, 'merge', '-q', branch);
    else if (scenario !== 'unmerged') {
      fs.appendFileSync(join(root, 'tracked.txt'), 'second commit\n');
      git(root, 'commit', '-qam', 'more job work');
      git(main_root, 'commit', '--allow-empty', '-qm', 'advance base before integration');
      if (scenario !== 'picked later') git(main_root, 'cherry-pick', `${base_head}..${branch}`);
      if (scenario === 'amended') {
        fs.appendFileSync(join(main_root, 'tracked.txt'), 'integration adjustment\n');
        git(main_root, 'commit', '-qa', '--amend', '--no-edit');
      }
      if (scenario === 'dirty') fs.writeFileSync(join(root, 'ignored.txt'), 'keep this ignored file');
    }
  }
  fs.mkdirSync(join(main_root, 'node_modules'));
  fs.symlinkSync(join(main_root, 'node_modules'), join(root, 'node_modules'));
  fs.writeFileSync(join(home, 'hud-reap'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const env = { ...process.env, HOME: home, HUD_HOME: join(home, 'hud'), NODE_OPTIONS: reapStubOptions(home), PATH: `${home}:${process.env.PATH}` };
  const dir = writeJob(env.HUD_HOME, id, 'w4E:p1', 'imp', { state: 'closed', ended_at: new Date().toISOString() });
  if (scenario === 'disposable' || scenario === 'mixed ignored') {
    fs.mkdirSync(join(main_root, '.hud'));
    fs.writeFileSync(join(main_root, '.hud/project.json'), JSON.stringify({ worktree: { disposable: ['ignored.txt'] } }));
    fs.writeFileSync(join(env.HUD_HOME, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: main_root }] }));
    fs.writeFileSync(join(root, 'ignored.txt'), 'generated');
    if (scenario === 'mixed ignored') {
      fs.appendFileSync(join(main_root, '.git/info/exclude'), '\nprivate.txt\n');
      fs.writeFileSync(join(root, 'private.txt'), 'keep');
    }
  }
  const file = join(dir, 'job.json'), job = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...job, cwd: root, worktree: { main_root, root, branch, base_head } }));
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'TAB=w4E:t2\n');
  const scan = () => {
    const watcher = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(watcher.status, 0, watcher.stderr || String(watcher.error));
    return JSON.parse(fs.readFileSync(file));
  };
  let result = scan();
  if (scenario === 'picked later') {
    assert.match(result.worktree_kept_reason, /unmerged/);
    assert.equal(result.worktree_checked_head, git(main_root, 'rev-parse', 'HEAD'));
    const stub = join(home, 'git');
    fs.writeFileSync(stub, '#!/bin/sh\ntouch "$HOME/git-called"; exit 1\n', { mode: 0o700 });
    assert.deepEqual(scan(), result);
    assert.equal(fs.existsSync(join(home, 'git-called')), false, 'unchanged base does not spawn Git');
    fs.unlinkSync(stub);
    git(main_root, 'cherry-pick', `${base_head}..${branch}`);
    result = scan();
  }
  assert.ok(result.reaped_at);
  const removed = ['merged', 'picked', 'picked later', 'disposable'].includes(scenario);
  assert.equal(fs.existsSync(root), !removed);
  assert.equal(!!git(main_root, 'branch', '--list', branch), !removed);
  assert.ok(fs.statSync(join(main_root, 'node_modules')).isDirectory());
  if (removed) {
    assert.equal(result.worktree_checked_head, undefined);
    assert.equal(result.worktree_kept_reason, undefined);
    assert.ok(result.worktree_removed_at);
  } else {
    assert.match(result.worktree_kept_reason, new RegExp(scenario === 'amended' ? 'unmerged' : scenario === 'mixed ignored' ? 'dirty' : scenario));
    if (scenario === 'dirty') assert.equal(result.worktree_checked_head, undefined);
    assert.equal(fs.readlinkSync(join(root, 'node_modules')), join(main_root, 'node_modules'));
  }
  if (nestedCommit) {
    assert.equal(result.worktree_removed_at, undefined);
    assert.equal(git(vendor, 'rev-parse', 'HEAD'), nestedCommit);
    assert.equal(git(vendor, 'show', `${nestedCommit}:tracked.txt`), 'nested-only content');
    assert.equal(git(main_root, 'rev-parse', branch), base_head);
  }
});

test('ordinary owner holds keep expired jobs, reports and worktrees until resolved, stopped or superseded', (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-owner-hold-'));
  cleanupFixture(t, { root: home });
  const hud = join(home, 'hud'), flows = join(hud, 'flows'), main_root = initRepo(home);
  fs.mkdirSync(flows, { recursive: true });
  const oldMs = Date.now() - 48 * 3600_000, at = new Date(oldMs).toISOString(), oldDate = new Date(oldMs);
  const putQueue = q => writeFixtureFile(join(flows, `${q.flow}.json`), JSON.stringify(q));
  const seed = (n, held) => {
    const job = `j000000000000000${n}`, flow = `q000000000000000${n}`, path = join(home, `ticket-${n}.md`);
    writeFixtureFile(path, '**Status:** ready-for-agent\n');
    const dir = writeJob(hud, job, '', 'imp', { state: 'closed', ended_at: at, output_written: true }, true);
    const q = { flow, state: held ? 'paused' : 'completed', root: main_root, feature: `synthetic-${n}`, created_at: at,
      tickets: [{ ticket: `synthetic-${n}/01`, path, job, role: 'imp', ...(held && { held: { at, reason: 'Owner approval', owner_approval: 'feature-deletion' } }) }],
    };
    putQueue(q);
    return { job, dir, path, q };
  };
  const resolved = seed(1, true), stopped = seed(2, true), superseded = seed(3, true), ordinary = seed(4, false), missingTicket = seed(5, true);
  const ordinaryLand = `f${ordinary.job.slice(1)}`, ordinaryReceipt = join(flows, `${ordinaryLand}.json`);
  const ordinaryLog = `${ordinaryReceipt}.gate-1.log`;
  writeFixtureFile(ordinary.path, '**Status:** done\n');
  writeFixtureFile(ordinaryReceipt, JSON.stringify({ flow: ordinaryLand, job: ordinary.job, ticket_queue: ordinary.q.flow, state: 'completed', step: 'done' }));
  writeFixtureFile(ordinaryLog, 'Synthetic gate output.\n');
  for (const file of [ordinaryReceipt, ordinaryLog]) fs.utimesSync(file, oldDate, oldDate);
  ordinary.q.tickets[0].land = ordinaryLand;
  ordinary.q.tickets[0].landed = true;
  putQueue({ ...ordinary.q, state: 'paused', handback_to: 'main', steps: { accept: { state: 'asking' } } });

  const attachWorktree = (entry) => {
    const name = `imp-${entry.job.slice(-6)}`, root = join(home, 'demo-wt', name), branch = `wt/${name}`;
    const base_head = git(main_root, 'rev-parse', 'HEAD');
    git(main_root, 'worktree', 'add', '-qb', branch, root, base_head);
    const receipt = join(entry.dir, 'job.json');
    writeFixtureFile(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt, 'utf8')), cwd: root, reaped_at: at,
      worktree: { main_root, root, branch, base_head },
    }));
    return root;
  };
  const resolvedWt = attachWorktree(resolved);
  const missingWt = attachWorktree(missingTicket);

  // Unattended hold with a missing ticket keeps existing unattended semantics (releases pin).
  const unattendedJob = 'j0000000000000006', unattendedFlow = 'q0000000000000006', unattendedTicket = join(home, 'ticket-6.md');
  const unattendedDir = writeJob(hud, unattendedJob, '', 'imp', { state: 'closed', ended_at: at, output_written: true }, true);
  putQueue({ flow: unattendedFlow, state: 'completed', root: main_root, feature: 'selected', created_at: at,
    unattended: { objective: 'selected' },
    tickets: [{ ticket: 'selected/01', path: unattendedTicket, job: unattendedJob, role: 'imp', held: { at, reason: 'spec change' } }],
  });
  writeFixtureFile(join(hud, 'unattended-runs.json'), JSON.stringify([unattendedFlow]));

  // Simulate a branch switch hiding the ordinary held item's ticket file during the scan.
  fs.unlinkSync(missingTicket.path);

  const scan = () => {
    const watcher = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], {
      env: { ...process.env, HOME: home, HUD_HOME: hud }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(watcher.status, 0, watcher.stderr || String(watcher.error));
  };

  scan();
  for (const { dir } of [resolved, stopped, superseded, missingTicket]) {
    assert.ok(fs.existsSync(join(dir, 'job.json')));
    assert.ok(fs.existsSync(join(dir, 'report.md')));
  }
  assert.ok(fs.existsSync(resolvedWt), 'hold protects a checkout otherwise eligible for cleanup');
  assert.ok(fs.existsSync(missingWt), 'a temporarily missing ticket file keeps the ordinary hold and checkout pinned');
  assert.equal(fs.existsSync(ordinary.dir), false, 'a normally landed job ages out even while its queue waits for acceptance');
  const archive = fs.readFileSync(join(hud, 'archive', `${at.slice(0, 7)}.jsonl`), 'utf8');
  assert.ok(archive.trim().split('\n').some(line => JSON.parse(line).job === ordinary.job), 'the landed job was archived');
  for (const file of [ordinaryReceipt, ordinaryLog]) assert.equal(fs.existsSync(file), false, 'the normal land family also ages out');
  assert.ok(fs.existsSync(join(flows, `${ordinary.q.flow}.json`)), 'the paused queue itself is kept');
  assert.equal(fs.existsSync(unattendedDir), false, 'unattended hold semantics for missing ticket files are unchanged');

  // Once a manual land completes while the paused queue still holds the item, release the checkout
  // but retain the job report and aged land receipt until the queue is superseded or stopped.
  const land = `f${resolved.job.slice(1)}`, landFile = join(flows, `${land}.json`);
  writeFixtureFile(resolved.path, '**Status:** ready-for-human\n');
  writeFixtureFile(landFile, JSON.stringify({ flow: land, job: resolved.job, state: 'completed', step: 'done' }));
  fs.utimesSync(landFile, oldDate, oldDate);
  putQueue({ ...stopped.q, state: 'cancelled' });
  putQueue({ ...superseded.q, superseded_by: 'q0000000000000009' }); // The successor need not still be on disk.
  // Positive closure without a matching land releases the previously missing-ticket hold.
  writeFixtureFile(missingTicket.path, '**Status:** wontfix\n');
  scan();
  assert.equal(fs.existsSync(resolvedWt), false, 'completed manual land releases the checkout');
  assert.ok(fs.existsSync(join(resolved.dir, 'report.md')), 'paused queue retains the report until resume, stop or supersession');
  assert.ok(fs.existsSync(landFile), 'paused queue retains the aged land receipt until resume, stop or supersession');
  for (const { dir } of [stopped, superseded, missingTicket]) assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(missingWt), false);

  // Superseding (or stopping) the paused queue releases both the retained job report and aged land receipt.
  putQueue({ ...resolved.q, superseded_by: 'q000000000000000a' });
  scan();
  assert.equal(fs.existsSync(resolved.dir), false);
  assert.equal(fs.existsSync(landFile), false);
});

test('watcher preserves a shared worktree while a continuation job is active and removes it once both finish', { timeout: 30000 }, async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-shared-wt-'));
  let watcher, exited;
  cleanupFixture(t, { root: home }, () => watcher && stopChild(watcher, exited, { killMs: 500 }));
  const main_root = initRepo(home);
  const sourceId = 'j0000000000000a01', contId = 'j0000000000000a02';
  const name = `imp-${sourceId.slice(-6)}`, root = join(home, 'demo-wt', name), branch = `wt/${name}`;
  const base_head = git(main_root, 'rev-parse', 'HEAD');
  git(main_root, 'worktree', 'add', '-qb', branch, root, base_head);
  fs.writeFileSync(join(home, 'hud-reap'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const env = { ...process.env, HOME: home, HUD_HOME: join(home, 'hud'), NODE_OPTIONS: reapStubOptions(home), PATH: `${home}:${process.env.PATH}` };
  const now = new Date().toISOString();
  const wt = { main_root, root, branch, base_head };
  const sourceDir = writeJob(env.HUD_HOME, sourceId, 'w4E:p1', 'imp', { state: 'closed', ended_at: now });
  const sourceFile = join(sourceDir, 'job.json');
  writeFixtureFile(sourceFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(sourceFile)), cwd: root, reaped_at: now, worktree: wt }));
  const contDir = writeJob(env.HUD_HOME, contId, 'w4E:p1', 'imp', { state: 'working' });
  const contFile = join(contDir, 'job.json');
  writeFixtureFile(contFile, JSON.stringify({
    ...JSON.parse(fs.readFileSync(contFile)),
    cwd: root, repair_of: sourceId, worktree: { ...wt, owner: sourceId },
  }));

  watcher = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { env, stdio: 'ignore' });
  exited = once(watcher, 'exit');
  // The initial finished scan must keep watching while the continuation protects the shared worktree.
  await until(() => ['watch.pid', 'jobs-revision.json'].every((file) => fs.existsSync(join(env.HUD_HOME, file))) &&
    fs.existsSync(workSummaryPath(env.HUD_HOME)), t.signal);
  assert.equal(fs.existsSync(root), true);
  assert.equal(JSON.parse(fs.readFileSync(sourceFile)).worktree_removed_at, undefined);

  // Once the continuation closes and is reaped, the watcher removes the clean unchanged worktree and exits.
  writeFixtureFile(join(contDir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: now }));
  writeFixtureFile(contFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(contFile)), reaped_at: now }));
  await until(() => !fs.existsSync(root) && git(main_root, 'branch', '--list', branch) === '', 15000);
  assert.equal(fs.existsSync(root), false);
  assert.equal(git(main_root, 'branch', '--list', branch), '');
});

test('dead supervisor watcher preserves a live worker; both gone fail or close by the explicit report baseline', { timeout: 60000 }, async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'dead-supervisor-'));
  const hudHome = join(home, 'hud');
  let watcher, watcherExited, worker, workerExited, supervisor, supervisorExited;
  cleanupFixture(t, { root: home, hudHome }, async () => {
    if (watcher) await stopChild(watcher, watcherExited, { killMs: 300 });
    await Promise.all([
      worker && stopChild(worker, workerExited, { killMs: 100 }),
      supervisor && stopChild(supervisor, supervisorExited, { killMs: 100 }),
    ]);
  });
  const env = { ...process.env, HOME: home, HUD_HOME: hudHome, HUD_WATCH_CLI_CHECK_MS: '30' };
  worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env, stdio: 'ignore' });
  workerExited = once(worker, 'exit');
  supervisor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env, stdio: 'ignore' });
  supervisorExited = once(supervisor, 'exit');
  await until(() => procStat(worker.pid) !== null, t.signal);
  const initial = { state: 'working', pid: worker.pid, pid_start_time: procStat(worker.pid).start, supervisor_pid: supervisor.pid };
  const failed = writeJob(env.HUD_HOME, 'j00000000000000f1', 'w4E:p1', 'no-report', initial);
  const closed = writeJob(env.HUD_HOME, 'j00000000000000f2', 'w4E:p1', 'with-report', initial, true);
  for (const dir of [failed, closed]) fs.writeFileSync(join(dir, 'turn.json'), JSON.stringify({ seq: 1, sent_at: new Date().toISOString(), report_sig: null }));
  watcher = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { env, stdio: 'ignore' });
  watcherExited = once(watcher, 'exit');
  supervisor.kill('SIGKILL');
  await supervisorExited;
  const status = (dir) => JSON.parse(fs.readFileSync(join(dir, 'STATUS.json')));
  await until(() => status(failed).state === 'waiting_orchestrator', t.signal);
  assert.equal(status(failed).reason, 'supervisor exited; worker still running');
  assert.equal(status(failed).error, null);
  // The watcher updates the two jobs one after the other.
  await until(() => status(closed).state === 'waiting_orchestrator', t.signal);
  const stamp = fs.statSync(join(failed, 'STATUS.json')).mtimeMs;
  const summary = workSummaryPath(hudHome);
  await until(() => fs.existsSync(summary), t.signal);
  fs.rmSync(summary, { force: true });
  writeFixtureFile(join(closed, 'report.md'), 'Synthetic report.');
  await until(() => fs.existsSync(summary), t.signal);
  assert.equal(fs.statSync(join(failed, 'STATUS.json')).mtimeMs, stamp, 'unchanged observation does not rewrite STATUS');
  worker.kill('SIGKILL');
  await workerExited;
  await until(() => status(failed).state === 'failed' && status(closed).state === 'closed', t.signal);
  assert.equal(status(failed).exit_reason, 'worker exited');
  assert.equal(status(closed).output_written, true);
});

test('hud watch --verbose retains the existing MCP change lines', async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-'));
  t.after(() => fs.rmSync(hudHome, { recursive: true, force: true }));

  const callerDir = writeJob(hudHome, 'j00000000000000a1', 'w4E:p1', 'pkg-a', { state: 'working' });
  const foreignDir = writeJob(hudHome, 'j00000000000000b2', 'w4E:p9', 'pkg-b', { state: 'working' });

  const env = { ...process.env, HUD_HOME: hudHome, HERDR_PANE_ID: 'w4E:p1' };
  const scans = observeStats(t, join(callerDir, 'STATUS.json'));
  const lines = [];
  const ac = new AbortController();
  t.after(() => ac.abort());
  const running = watchCommand(
    ['--verbose'],
    {
      env,
      stdout: (text) => {
        lines.push(text.replace(/\n$/, ''));
      },
      stderr: () => {},
    },
    { rescanMs: 30000, signal: ac.signal }
  );

  await until(() => scans() > 0, t.signal);
  assert.deepEqual(lines, []);

  // Foreign-pane changes must stay silent, and mutating HERDR_PANE_ID after startup must not switch panes.
  env.HERDR_PANE_ID = 'w4E:p9';
  const before = scans();
  fs.writeFileSync(join(foreignDir, 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'tab closed' }));
  // The foreign change may not wake a pane-scoped watch; use a silent, in-scope write to force the scan.
  writeFixtureFile(join(callerDir, 'STATUS.json'), '{"state":"working"}');
  await until(() => scans() > before, t.signal);
  assert.deepEqual(lines, []);

  // 1: working -> waiting_orchestrator
  fs.writeFileSync(
    join(callerDir, 'STATUS.json'),
    JSON.stringify({ state: 'waiting_orchestrator', blocked: false, reason: 'quiet', harness: 'cli' })
  );
  await until(() => lines.length === 1, t.signal);

  // 2: qa/q1.md appears -> QUESTION
  fs.mkdirSync(join(callerDir, 'qa'), { recursive: true });
  fs.writeFileSync(join(callerDir, 'qa', 'q1.md'), 'Synthetic question?\n');
  await until(() => lines.length === 2, t.signal);

  // 3: qa/q1.answer.md + report.md -> report (QUESTION cleared)
  fs.writeFileSync(join(callerDir, 'qa', 'q1.answer.md'), 'Proceed.\n');
  fs.writeFileSync(join(callerDir, 'report.md'), 'Done report.\n');
  await until(() => lines.length === 3, t.signal);

  // 4: STATUS -> done
  fs.writeFileSync(join(callerDir, 'STATUS.json'), JSON.stringify({ state: 'done', exit_reason: null }));
  await until(() => lines.length === 4, t.signal);

  // New job appearing already failed after startup also prints.
  writeJob(hudHome, 'j00000000000000c3', 'w4E:p1', 'pkg-c', { state: 'failed', exit_reason: 'tab closed' });
  await until(() => lines.length === 5, t.signal);

  ac.abort();
  assert.equal(await running, 0);

  assert.deepEqual(lines, [
    'j00000000000000a1 imp pkg-a: waiting_orchestrator | quiet',
    'j00000000000000a1 imp pkg-a: waiting_orchestrator | quiet | QUESTION',
    `j00000000000000a1 imp pkg-a: waiting_orchestrator | quiet | report | ${readHint('j00000000000000a1')}`,
    `j00000000000000a1 imp pkg-a: done | report | ${readHint('j00000000000000a1')}`,
    'j00000000000000c3 imp pkg-c: failed | tab closed',
  ]);
  assert.equal(fs.existsSync(join(hudHome, 'display')), false);
  assert.equal(fs.existsSync(join(hudHome, 'watch.pid')), false);
  assert.equal(fs.existsSync(join(hudHome, 'watch.log')), false);
  assert.equal(fs.existsSync(join(hudHome, 'watchers', 'w4E:p1.pid')), false);
});

for (const verbose of [false, true]) test(`a single queued sonic and its routine checkpoint (${verbose ? 'verbose' : 'quiet'})`, async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-checkpoint-')), pane = 'w4E:p1', id = 'j0000000000000001';
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = join(home, 'jobs', id), status = join(dir, 'STATUS.json'), scans = observeStats(t, status);
  const ac = new AbortController(), lines = [];
  const run = watchCommand(verbose ? ['--all', '--verbose'] : ['--all'], { env: { HUD_HOME: home },
    stdout: s => lines.push(s.trim()), stderr: assert.fail }, { signal: ac.signal, rescanMs: 50 });
  try {
    writeJob(home, id, pane, 'query', { state: 'queued' });
    const receipt = join(dir, 'job.json');
    writeFixtureFile(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), role: 'sonic' }));
    await until(() => scans() > 0, t.signal);
    const before = scans();
    const text = 'still working at 10 min: tool read';
    writeFixtureFile(join(dir, 'progress.jsonl'), JSON.stringify({ at: new Date().toISOString(), source: 'checkpoint', text }));
    writeFixtureFile(status, '{"state":"working"}');
    await until(() => scans() > before, t.signal);
    assert.deepEqual(lines, verbose ? [`${id} sonic query: queued (#1)`, `${id} sonic query: working`, `[sonic ${id}] ${text}`] : []);
  } finally { ac.abort(); assert.equal(await run, 0); }
});

test('hud watch shows the signed settlement summary and ignores metadata-only writes', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-summary-'));
  const pane = 'w4E:p1', id = 'j00000000000000a1', staleId = 'j00000000000000b2';
  const dir = writeJob(home, id, pane, 'summary', { state: 'working' }, true);
  const stale = writeJob(home, staleId, pane, 'stale', { state: 'working' }, true);
  const ac = new AbortController(), lines = [];
  const original = fs.readdirSync, watch = fs.watch;
  let scans = 0;
  const metadataSeen = Promise.withResolvers();
  const timers = t.mock.method(globalThis, 'setTimeout');
  t.mock.method(fs, 'readdirSync', (path, ...args) => {
    if (path === join(home, 'jobs')) scans++;
    return original(path, ...args);
  });
  t.mock.method(fs, 'watch', (path, options, listener) => watch(path, options,
    path === join(home, 'jobs') ? (event, name) => {
      const before = timers.mock.callCount();
      listener(event, name);
      if (name?.toString() === `${id}/report-meta.json`) metadataSeen.resolve(timers.mock.callCount() - before);
    } : listener));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const running = watchCommand(['--all'], {
    env: { HUD_HOME: home }, stdout: (s) => lines.push(s.trim()), stderr: () => {},
  }, { signal: ac.signal, rescanMs: 30000, settlementWindowMs: 30 });
  try {
    await until(() => scans > 0, t.signal);
    const initial = scans;
    writeReportMeta(dir, cachedReportSignature(dir), { summary: '«Synthetic» work completed.' });
    assert.equal(await metadataSeen.promise, 0, 'the metadata event did not schedule a debounce scan');
    assert.equal(scans, initial, 'report-meta.json writes do not rescan jobs');
    assert.deepEqual(lines, []);
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    await until(() => lines.length > 0, t.signal);
    assert.deepEqual(lines, [`${id} imp summary: idle_grace | report | Synthetic work completed. | ${readHint(id)}`]);
    writeReportMeta(stale, cachedReportSignature(stale), { summary: 'Stale synthetic metadata.' });
    writeFixtureFile(join(stale, 'report.md'), 'Rewritten synthetic report.');
    writeFixtureFile(join(stale, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    await until(() => lines.length > 1, t.signal);
    assert.deepEqual(lines.slice(1), [`${staleId} imp stale: idle_grace | report | ${readHint(staleId)}`]);
  } finally {
    ac.abort();
    assert.equal(await running, 0);
  }
});

test('hud watch skips child completion and report, but delivers questions and failure', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-sonic-'));
  const id = 'j0000000000000002', pane = 'w4E:p1', ac = new AbortController(), lines = [];
  t.after(() => { ac.abort(); fs.rmSync(home, { recursive: true, force: true }); });
  const dir = writeJob(home, id, pane, 'sonic', { state: 'closed' }, true, 'j0000000000000001');
  const running = watchCommand([], { env: { HUD_HOME: home, HERDR_PANE_ID: pane },
    stdout: (line) => lines.push(line), stderr: () => {} }, { signal: ac.signal, rescanMs: 100 });
  fs.mkdirSync(join(dir, 'qa'));
  fs.writeFileSync(join(dir, 'qa/q1.md'), 'Synthetic question?');
  await until(() => lines.length > 0, t.signal);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /QUESTION q1/);
  fs.writeFileSync(join(dir, 'qa/q1.answer.md'), 'Answer.');
  fs.writeFileSync(join(dir, 'STATUS.json'), '{"state":"failed","exit_reason":"synthetic failure"}');
  await until(() => lines.length > 1, t.signal);
  assert.match(lines[1], /failed \| synthetic failure$/m);
  assert.ok(lines.every((line) => !line.includes(' | report')));
  ac.abort();
  assert.equal(await running, 0);
});

for (const verbose of [false, true]) test(`hud watch scripted lifecycle (${verbose ? 'verbose' : 'quiet'})`, { timeout: 60000 }, async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-life-'));
  const ac = new AbortController();
  const lines = [], id = 'j00000000000000a1', head = `${id} imp life:`;
  const dir = join(home, 'jobs', id), statusFile = join(dir, 'STATUS.json');
  let scans = 0;
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === statusFile) scans++;
    return lstat(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(home, { recursive: true, force: true });
  });
  // Keep all three settlements in one logical window regardless of wall-clock scan latency.
  const settlementWindowMs = 1000;
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const running = watchCommand(verbose ? ['--verbose'] : [], {
    env: { HUD_HOME: home, HERDR_PANE_ID: 'w4E:p1' }, stdout: (s) => lines.push(s.trim()), stderr: () => {},
  }, { signal: ac.signal, rescanMs: 50, settlementWindowMs });
  // Silent transitions still need to reach the watcher's baseline before the next write.
  const step = async (change) => {
    const before = scans;
    change();
    await until(() => scans > before, t.signal);
  };
  const status = (state, reason) => writeFixtureFile(statusFile, JSON.stringify({ state, reason }));
  const qfile = join(dir, 'qa/q1.md');
  try {
    await step(() => writeJob(home, id, 'w4E:p1', 'life', { state: 'working' }));
    await step(() => {
      fs.mkdirSync(join(dir, 'qa'));
      writeFixtureFile(qfile, '# Question q1 from imp@demo\n\nWhich\nlayout?\n\nOptions:\n- rows\n- columns\n\nDefault if unanswered: rows\n');
      status('waiting_orchestrator', 'question');
    });
    await step(() => writeFixtureFile(join(dir, 'qa/q1.answer.md'), 'rows'));
    await step(() => status('working'));
    const receipt = JSON.parse(fs.readFileSync(join(dir, 'job.json')));
    for (const report of ['First report', 'Second report']) {
      await step(() => {
        writeFixtureFile(join(dir, 'report.md'), report);
        status('idle_grace');
      });
      await step(() => writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ ...receipt, read_at: new Date().toISOString() })));
      await step(() => status('working'));
    }
    await step(() => status('idle_grace')); // A new settlement is actionable even without rewriting the already-read report.
    await step(() => status('closed'));
    now += settlementWindowMs;
    await until(() => lines.length >= (verbose ? 10 : 2), t.signal);
  } finally {
    ac.abort();
    assert.equal(await running, 0);
  }
  const report = `${head} idle_grace | report | ${readHint(id)}`;
  assert.deepEqual(lines, verbose ? [
    `${head} working`, `${head} waiting_orchestrator | question | QUESTION`,
    `${head} waiting_orchestrator | question`, `${head} working`, report,
    `${head} working`, report, `${head} working`, `${head} idle_grace`, `${head} closed`,
  ] : [
    `[imp@demo] QUESTION q1: Which layout? | options: rows / columns | default: rows | full text: ${qfile} | reply: hud_respond job=${id} request_id=q1`,
    `${report}\n${report}\n${head} idle_grace`,
  ]);
});

test('hud watch holds unconfigured settlements for exactly 3000ms', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-default-window-'));
  const ac = new AbortController(), writes = [];
  t.after(() => { ac.abort(); fs.rmSync(home, { recursive: true, force: true }); });
  const id = 'j0000000000000001';
  writeJob(home, id, 'w4E:p1', 'default', { state: 'done' }, true);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = watchCommand(['--all'], { env: { HUD_HOME: home },
    stdout: (text) => writes.push(text), stderr: () => {} }, { signal: ac.signal });
  assert.deepEqual(writes, []);
  now = 2999;
  t.mock.timers.tick(2999);
  await Promise.resolve();
  assert.deepEqual(writes, []);
  now = 3000;
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(writes, [`${id} imp default: done | report | ${readHint(id)}\n`]);
  ac.abort();
  assert.equal(await running, 0);
});

test('hud watch batches jobs settling within the settlement window into one notice', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-batch-'));
  const ac = new AbortController(), writes = [], pane = 'w4E:p1';
  t.after(() => { ac.abort(); fs.rmSync(home, { recursive: true, force: true }); });
  const ids = ['j0000000000000001', 'j0000000000000002', 'j0000000000000003'];
  const dirs = ids.map((id, i) => writeJob(home, id, pane, i < 2 ? 'batch' : 'other', { state: 'working' }));
  const scans = observeStats(t, join(dirs[0], 'STATUS.json'));
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const running = watchCommand([], { env: { HUD_HOME: home, HERDR_PANE_ID: pane },
    stdout: (text) => writes.push(text), stderr: () => {} }, { signal: ac.signal, rescanMs: 50, settlementWindowMs: 450 });
  for (const dir of dirs) {
    const before = scans();
    writeFixtureFile(join(dir, 'STATUS.json'), '{"state":"done"}');
    await until(() => scans() > before, t.signal);
    assert.deepEqual(writes, [], 'hold settlements across scans');
    now += 80;
  }
  now = 450;
  await until(() => writes.length > 0, t.signal);
  ac.abort();
  assert.equal(await running, 0);
  assert.deepEqual(writes, [ids.map((id, i) => `${id} imp ${i < 2 ? 'batch' : 'other'}: done\n`).join('')]);
});

test('quiet watch rolls up a package from its third live member until the last settlement', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-package-'));
  const ac = new AbortController(), writes = [], pane = 'w4E:p1';
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ids = Array.from({ length: 6 }, (_, i) => `j${String(i + 1).padStart(16, '0')}`);
  const create = (i, state) => writeJob(home, ids[i], pane, 'labels', { state });
  const first = create(0, 'working'), receipt = join(first, 'job.json');
  writeFixtureFile(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), role: 'sonic' }));
  const file = (i, name) => join(home, 'jobs', ids[i], name);
  const status = (i, state, reason) => writeFixtureFile(file(i, 'STATUS.json'), JSON.stringify({ state, reason }));
  const scans = observeStats(t, file(0, 'STATUS.json'));
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const run = watchCommand(['--all'], { env: { HUD_HOME: home }, stdout: s => writes.push(s.trim()), stderr: assert.fail },
    { signal: ac.signal, rescanMs: 50 });
  const step = async (change) => {
    const before = scans(); change(); await until(() => scans() > before, t.signal);
    return writes.splice(0);
  };
  try {
    assert.deepEqual(await step(() => create(1, 'queued')), []); // Below the batch threshold.
    assert.deepEqual(await step(() => { create(2, 'queued'); create(3, 'queued'); create(4, 'working'); }), []);
    const checkpoint = (time, text) => writeFixtureFile(file(0, 'progress.jsonl'), JSON.stringify({ at: new Date(time).toISOString(), source: 'checkpoint', text }));
    assert.deepEqual(await step(() => checkpoint(1, 'still working at 10 min: tool read')), []);
    assert.deepEqual(await step(() => checkpoint(2, 'ended a silent tool after 90 s: read')), [`[sonic ${ids[0]}] ended a silent tool after 90 s: read`]);
    const [question] = await step(() => {
      fs.mkdirSync(file(4, 'qa')); writeFixtureFile(file(4, 'qa/q1.md'), 'Proceed?');
      status(4, 'waiting_orchestrator', 'question');
    });
    assert.match(question, /QUESTION q1: Proceed\?/);
    assert.deepEqual(await step(() => { writeFixtureFile(file(4, 'qa/q1.answer.md'), 'yes'); status(4, 'working'); }), []);
    assert.deepEqual(await step(() => status(0, 'closed')), ['labels batch: 1 done, 0 failed, 1 running, 3 queued']);
    assert.deepEqual(await step(() => status(1, 'done')), []);
    assert.deepEqual(await step(() => status(2, 'failed', 'stalled')), [`${ids[2]} imp labels: failed | stalled`]);
    assert.deepEqual(await step(() => { now = 299_999; }), []);
    assert.deepEqual(await step(() => { now++; }), ['labels batch: 2 done, 1 failed, 1 running, 1 queued']);
    assert.deepEqual(await step(() => status(3, 'closed')), []);
    assert.deepEqual(await step(() => status(4, 'idle_grace')), ['labels batch: 4 done, 1 failed, 0 running, 0 queued — final; list unread reports: hud_read view:compact']);
    assert.deepEqual(await step(() => { status(4, 'closed'); writeFixtureFile(file(4, 'report.md'), 'Later publication.'); }), []);
    const job = JSON.parse(fs.readFileSync(file(4, 'job.json')));
    assert.equal(job.read_at, undefined);
    const checks = await step(() => {
      writeFixtureFile(file(4, 'job.json'), JSON.stringify({ ...job, cli: null, checks: ['synthetic-check'] }));
      writeFixtureFile(file(4, 'checks.json'), JSON.stringify({ state: 'done', turn: job.created_at,
        report_sig: cachedReportSignature(file(4, '.')), results: [{ command: 'synthetic-check', exit_code: 1 }] }));
    });
    assert.equal(checks.length, 1); assert.match(checks[0], /checks 0\/1/);
    assert.deepEqual(await step(() => create(5, 'queued')), []);
    assert.deepEqual(await step(() => status(5, 'stopped')), [`${ids[5]} imp labels: stopped`]); // No latch on a reused label.
  } finally { ac.abort(); assert.equal(await run, 0); }
});

test('late check results wake quiet watch immediately only on failure', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-checks-')), pane = 'w4E:p1';
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const checks = [0, 1].map(exit_code => {
    const dir = writeJob(home, `j000000000000000${exit_code}`, pane, 'checks', { state: 'closed' }, true);
    const file = join(dir, 'job.json'), job = JSON.parse(fs.readFileSync(file));
    writeFixtureFile(file, JSON.stringify({ ...job, cli: null, checks: ['synthetic-check'], read_at: new Date(Date.now() + 1000).toISOString() }));
    return () => writeFixtureFile(join(dir, 'checks.json'), JSON.stringify({ state: 'done', turn: job.created_at,
      report_sig: cachedReportSignature(dir), results: [{ command: 'synthetic-check', exit_code }] }));
  });
  const ac = new AbortController(), lines = [];
  t.mock.method(performance, 'now', () => 0); // No settlement window can expire.
  const run = watchCommand(['--all'], { env: { HUD_HOME: home }, stdout: s => lines.push(s.trim()), stderr: assert.fail },
    { signal: ac.signal, rescanMs: 50 });
  try {
    for (const finish of checks) finish();
    await until(() => lines.length > 0, t.signal);
    assert.deepEqual(lines, ['j0000000000000001 imp checks: closed | checks 0/1']);
  } finally { ac.abort(); assert.equal(await run, 0); }
});

test('mod catch-up folds pending reports for a live package without replaying them on rescan', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-package-catchup-')), pane = 'w4E:p1';
  const ac = new AbortController(), lines = [];
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const create = (i, state, report) => writeJob(home, `j${String(i).padStart(16, '0')}`, pane, 'labels', { state }, report);
  const dir = create(1, 'working'); create(2, 'queued'); create(3, 'queued');
  create(4, 'closed', true); create(5, 'idle_grace', true);
  const scans = observeStats(t, join(dir, 'STATUS.json'));
  const run = watchCommand(['--mod'], { env: { HUD_HOME: home, HERDR_PANE_ID: pane },
    stdout: s => lines.push(...JSON.parse(s).lines), stderr: assert.fail }, { signal: ac.signal, rescanMs: 50 });
  try {
    await until(() => lines.length > 0, t.signal);
    const before = scans(); await until(() => scans() > before, t.signal);
    assert.deepEqual(lines, ['labels batch: 2 done, 0 failed, 1 running, 2 queued']);
  } finally { ac.abort(); assert.equal(await run, 0); }
});

test('hud watch flushes a held settlement with an immediate question', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-batch-question-'));
  const ac = new AbortController(), writes = [], pane = 'w4E:p1';
  t.after(() => { ac.abort(); fs.rmSync(home, { recursive: true, force: true }); });
  const done = writeJob(home, 'j0000000000000001', pane, 'batch', { state: 'working' });
  const ask = writeJob(home, 'j0000000000000002', pane, 'batch', { state: 'working' });
  fs.mkdirSync(join(ask, 'qa'));
  const scans = observeStats(t, join(done, 'STATUS.json'));
  // Hold logical time at zero so the question, not expiry of the 250 ms window, flushes the settlement.
  t.mock.method(performance, 'now', () => 0);
  const running = watchCommand([], { env: { HUD_HOME: home, HERDR_PANE_ID: pane },
    stdout: (text) => writes.push(text), stderr: () => {} }, { signal: ac.signal, rescanMs: 100, settlementWindowMs: 250 });
  const before = scans();
  writeFixtureFile(join(done, 'STATUS.json'), '{"state":"done"}');
  await until(() => scans() > before, t.signal);
  assert.deepEqual(writes, []);
  writeFixtureFile(join(ask, 'qa/q1.md'), 'Synthetic question?');
  await until(() => writes.length > 0, t.signal);
  ac.abort();
  assert.equal(await running, 0);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /^j0000000000000001 imp batch: done\n\[imp\] QUESTION q1: Synthetic question\?/);
});

test('hud watch catch-up prints pending questions, unread settlements and unread failures/blocks once', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-catchup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const question = writeJob(home, 'j0000000000000001', 'w4E:p1', 'ask', { state: 'waiting_orchestrator' });
  fs.mkdirSync(join(question, 'qa'));
  for (const n of [1, 2]) fs.writeFileSync(join(question, `qa/q${n}.md`), `# Question q${n} from imp@demo\n\nQuestion ${n}?\n\nDefault if unanswered: yes\n`);
  writeJob(home, 'j0000000000000002', 'w4E:p1', 'unread', { state: 'idle_grace' }, true);
  writeJob(home, 'j0000000000000003', 'w4E:p1', 'failed', { state: 'failed', reason: 'gone' });
  writeJob(home, 'j0000000000000004', 'w4E:p1', 'blocked', { state: 'working', blocked: true, reason: 'input' });
  const read = writeJob(home, 'j0000000000000005', 'w4E:p1', 'read', { state: 'closed' }, true);
  const job = JSON.parse(fs.readFileSync(join(read, 'job.json')));
  fs.writeFileSync(join(read, 'job.json'), JSON.stringify({ ...job, read_at: new Date(Date.now() + 1000).toISOString() }));
  const lines = [], ac = new AbortController();
  t.after(() => ac.abort());
  const running = watchCommand([], { env: { HUD_HOME: home, HERDR_PANE_ID: 'w4E:p1' }, stdout: (s) => lines.push(...s.trim().split('\n')), stderr: () => {} }, { signal: ac.signal, rescanMs: 60 });
  await until(() => lines.length >= 5, t.signal);
  assert.equal(lines.length, 5);
  assert.equal(lines.filter((s) => s.includes('QUESTION q')).length, 2);
  assert.equal(lines.filter((s) => s.includes('idle_grace | report')).length, 1);
  assert.equal(lines.filter((s) => s.includes('failed | gone')).length, 1);
  assert.equal(lines.filter((s) => s.includes('working | input')).length, 1);
  // Answer and next question can coalesce into one scan with the same count: never lose the new id.
  fs.writeFileSync(join(question, 'qa/q1.answer.md'), 'yes');
  fs.writeFileSync(join(question, 'qa/q3.md'), '# Question q3 from imp@demo\n\nNext question?\n\nDefault if unanswered: yes\n\nContext: ' + 'x'.repeat(2200) + 'NOT IN LINE');
  await until(() => lines.length === 6, t.signal);
  assert.match(lines.at(-1), /QUESTION q3: Next question\?/);
  assert.doesNotMatch(lines.at(-1), /NOT IN LINE/);
  ac.abort();
  await running;
});

test('quiet watch emits new blocks and quiet reasons but never working/resume chatter', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-attention-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = writeJob(home, 'j0000000000000001', 'w4E:p1', 'attention', { state: 'working' });
  const scans = observeStats(t, join(dir, 'STATUS.json'));
  const lines = [], ac = new AbortController();
  t.after(() => ac.abort());
  const running = watchCommand([], { env: { HUD_HOME: home, HERDR_PANE_ID: 'w4E:p1' }, stdout: (s) => lines.push(s.trim()), stderr: () => {} }, { signal: ac.signal, rescanMs: 60 });
  for (const state of [
    { state: 'working', reason: 'tool' }, { state: 'working', blocked: true, reason: 'input' },
    { state: 'working' }, { state: 'waiting_orchestrator', reason: 'quiet' },
    { state: 'waiting_orchestrator', reason: 'worker not found' }, { state: 'working' },
  ]) {
    const before = scans();
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify(state));
    await until(() => scans() > before, t.signal);
  }
  ac.abort(); await running;
  assert.deepEqual(lines.map((s) => s.split(': ').at(-1)), ['working | input', 'waiting_orchestrator | quiet', 'waiting_orchestrator | worker not found']);
});

test('hud watch --all watches every pane and exits cleanly on help, usage errors, and EPIPE', async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-all-'));
  t.after(() => fs.rmSync(hudHome, { recursive: true, force: true }));

  let helpText = '';
  const helpCode = await main(['watch', '--help'], {
    env: { ...process.env, HUD_HOME: hudHome },
    stdout: (text) => {
      helpText += text;
    },
    stderr: () => {},
  });
  assert.equal(helpCode, 0);
  assert.match(helpText, /hud watch \[--all\]/);

  let errText = '';
  const badCode = await main(['watch', '--unknown'], {
    env: { ...process.env, HUD_HOME: hudHome },
    stdout: () => {},
    stderr: (text) => {
      errText += text;
    },
  });
  assert.equal(badCode, 2);
  assert.match(errText, /usage: hud watch \[--all\]/);

  const otherDir = writeJob(hudHome, 'j00000000000000d4', 'w9X:p2', 'pkg-other', { state: 'working' });
  const seen = [];
  const ac = new AbortController();
  const running = watchCommand(
    ['--all'],
    {
      env: { ...process.env, HUD_HOME: hudHome },
      stdout: (text) => {
        seen.push(text.trim());
        const epipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
        throw epipe;
      },
      stderr: () => {},
    },
    { rescanMs: 30000, signal: ac.signal }
  );

  // The all-pane watcher captures its baseline synchronously before its first wait.
  fs.writeFileSync(join(otherDir, 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'tab closed' }));
  assert.equal(await running, 0);
  assert.deepEqual(seen, ['j00000000000000d4 imp pkg-other: failed | tab closed']);
});

test('CLI and pi question pushes use only watch while live, and fall back with missing or stale watcher PIDs', { timeout: 60000 }, async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-push-'));
  let child, childExited, closeFork;
  cleanupFixture(t, { root: home }, async () => {
    if (child) await stopChild(child, childExited, { killMs: 300 });
    await closeFork?.();
  });
  const bin = join(home, 'bin'), log = join(home, 'pushes');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nimport fs from 'node:fs'; if (process.argv[2] === 'agent') fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, HUD_HOME: home, HERDR_PANE_ID: 'w4E:p1', PATH: `${bin}:${process.env.PATH}` };
  await promptFork({ home, env, onCleanup: fn => { closeFork = fn; } }, () => legacyPong);
  const id = 'j0000000000000001';
  const dir = writeJob(home, id, 'w4E:p1', 'push', { state: 'working' });
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'ORCH=w4E:p1\n');
  child = spawn(process.execPath, [resolve('bin/hud'), 'watch'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  childExited = once(child, 'exit');
  const pidFile = join(home, 'watchers', 'w4E:p1.pid');
  await until(() => fs.existsSync(pidFile), t.signal);
  assert.equal(Number(fs.readFileSync(pidFile)), child.pid);
  const pushBoth = async () => {
    await runCli('hud-ask', ['--dir', dir, '--question', 'Which layout?', '--default', 'rows', '--timeout', '0'], env);
    await runCli('hud-notify', [home, 'w4E:p1', id, '[imp@demo] QUESTION q99: Which layout? | reply: write /synthetic/q99.answer.md'], env);
  };
  await pushBoth();
  assert.equal(fs.existsSync(log), false);
  child.kill('SIGTERM');
  await childExited;
  assert.equal(fs.existsSync(pidFile), false);
  for (const pid of [null, 99999999, process.pid]) {
    if (pid !== null) fs.writeFileSync(pidFile, String(pid));
    await pushBoth();
  }
  const pushes = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(pushes.length, 6);
  assert.ok(pushes.every((args) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'w4E:p1'));
  assert.match(pushes[1][3], /reply: hud_respond job=j0000000000000001 request_id=q99$/);
  writeJob(home, id, 'w4E:p1', 'push', { state: 'closed' }, true, 'j0000000000000002');
  await runCli('hud-notify', [home, 'w4E:p1', id, '[sonic@demo] DONE /synthetic/report.md'], env);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 6, 'opt-in child DONE is also quiet');
});

function queueFixture(t, agent = 'codex', thread = '00000000-0000-4000-8000-000000000001', fail = false) {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-queue-'));
  const cleanups = [];
  cleanupFixture(t, { root: home }, async () => {
    for (const cleanup of [...cleanups].reverse()) await cleanup();
  });
  const bin = join(home, 'bin'), log = join(home, 'deliveries'), agentFile = join(home, 'agent'), statusFile = join(home, 'agent-status');
  fs.mkdirSync(bin);
  fs.writeFileSync(agentFile, agent);
  fs.writeFileSync(statusFile, 'idle');
  const fake = `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'get') {
  console.log(JSON.stringify({ result: { pane: { agent: fs.readFileSync(${JSON.stringify(agentFile)}, 'utf8'), agent_status: fs.readFileSync(${JSON.stringify(statusFile)}, 'utf8'), agent_session: { value: ${JSON.stringify(thread)} } } } }));
} else if (args[0] === 'pane' && args[1] === 'process-info') {
  console.log(JSON.stringify({ result: { process_info: { foreground_processes: [{ name: 'codex', pid: ${process.pid} }] } } }));
} else {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, home: process.env.CODEX_HOME }) + '\\n');
  if (args[0] === 'queue' && ${fail}) { console.error('no rollout found'); process.exit(1); }
}
`;
  for (const name of ['herdr', 'codex']) fs.writeFileSync(join(bin, name), fake, { mode: 0o700 });
  const env = { ...process.env, HOME: home, HUD_HOME: home, CODEX_HOME: join(home, 'wrong-account'), HERDR_PANE_ID: 'w4E:p1', PATH: `${bin}:${process.env.PATH}` };
  delete env.HERDR_SOCKET_PATH; // This CLI-only fixture has no server unless the test starts one.
  const deliveries = () => {
    if (!fs.existsSync(log)) return [];
    const text = fs.readFileSync(log, 'utf8');
    const end = text.lastIndexOf('\n');
    // A fake command may have created the log or started appending its next row.
    return end < 0 ? [] : text.slice(0, end).split('\n').map(JSON.parse);
  };
  return { home, env, agentFile, statusFile, deliveries, onCleanup: (fn) => cleanups.push(fn) };
}

test('mod watcher marker requires the live --mod process, start time, pane and home', async (t) => {
  const f = queueFixture(t), pane = f.env.HERDR_PANE_ID, file = join(f.home, 'watchers', `${pane}.pid`);
  const child = spawn(process.execPath, [resolve('bin/hud'), 'watch', '--mod'], { env: f.env, stdio: 'ignore' });
  const exited = once(child, 'exit');
  f.onCleanup(() => stopChild(child, exited));
  await until(() => fs.existsSync(file), t.signal);
  const marker = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(marker, { pid: child.pid, start: procStat(child.pid).start, home: f.home, pane, client: 'claude-mod' });
  assert.equal(watchingMod(pane, f.home), true);
  assert.equal(watching(pane, f.home), true);
  for (const bad of [{ start: '0' }, { pane: 'w4E:p2' }, { home: join(f.home, 'other') }, { client: 'other' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...marker, ...bad }));
    assert.equal(watchingMod(pane, f.home), false);
  }
  fs.writeFileSync(file, JSON.stringify(marker));
  child.kill('SIGKILL'); await exited;
  assert.equal(watchingMod(pane, f.home), false);
});

test('mod catch-up lists two fresh reports, summarizes history and old failures, and preserves questions and fresh failures', async (t) => {
  const f = queueFixture(t), pane = f.env.HERDR_PANE_ID, now = Date.now();
  const old = { state: 'closed', settled_at: new Date(now - 4 * 60 * 60_000).toISOString() };
  const recent = { state: 'closed', settled_at: new Date(now - 10 * 60_000).toISOString() };
  for (let i = 0; i < 30; i++) writeJob(f.home, `j${i.toString(16).padStart(16, '0')}`, pane, 'old', old, true);
  const fresh = ['j00000000000000b1', 'j00000000000000b2'];
  for (const id of fresh) writeJob(f.home, id, pane, 'fresh', recent, true);
  const foreign = 'j00000000000000b3';
  writeJob(f.home, foreign, 'w4E:p2', 'foreign', recent, true);
  const failed = 'j00000000000000a1', ask = 'j00000000000000a2', active = 'j00000000000000a3';
  writeJob(f.home, failed, pane, 'failure', { state: 'failed', reason: 'needs repair' }, true);
  writeJob(f.home, 'j00000000000000a5', pane, 'stale', { state: 'failed', reason: 'timeout', settled_at: old.settled_at });
  const observed = writeJob(f.home, 'j00000000000000a4', pane, 'seen', { state: 'failed' });
  const receipt = join(observed, 'job.json');
  writeFixtureFile(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), observed_at: new Date(Date.now() + 1000).toISOString() }));
  const question = writeJob(f.home, ask, pane, 'ask', { state: 'waiting_orchestrator' });
  fs.mkdirSync(join(question, 'qa'));
  writeFixtureFile(join(question, 'qa/q1.md'), '# Question q1 from imp\n\nProceed?\n\nDefault if unanswered: yes\n');
  const working = writeJob(f.home, active, pane, 'new', { state: 'working' });
  fs.mkdirSync(join(f.home, 'flows'));
  for (const [flow, state] of [['f00000000000000a1', 'completed'], ['f00000000000000a2', 'failed']]) {
    writeFixtureFile(join(f.home, 'flows', `${flow}.json`), JSON.stringify({ flow, state, step: 'gate', job: failed, pane, wt: { main_root: process.cwd() } }));
  }
  const ac = new AbortController(), wakes = [];
  const run = watchCommand(['--mod'], { env: f.env, stdout: s => wakes.push(JSON.parse(s).lines), stderr: s => assert.fail(s) },
    { signal: ac.signal, rescanMs: 50, settlementWindowMs: 40 });
  try {
    await until(() => wakes.length > 0, t.signal);
    const [lines] = wakes;
    assert.equal(lines.length, 6);
    for (const id of fresh) assert.ok(lines.includes(`${id} imp fresh: closed | report | ${readHint(id)}`));
    assert.ok(lines.every(line => !line.includes(foreign)));
    assert.ok(lines.includes(`f00000000000000a2 (land ${failed}) — failed: gate`));
    assert.ok(lines.includes('30 older unread reports, 1 older failure — hud_read view:compact'));
    assert.ok(lines.every(line => !line.includes('j00000000000000a5')));
    assert.ok(lines.some(s => s.startsWith(`${failed} imp failure: failed | needs repair`)));
    assert.ok(lines.some(s => s.startsWith('[imp] QUESTION q1: Proceed?')));
    writeFixtureFile(join(working, 'STATUS.json'), JSON.stringify({ state: 'done' }));
    await until(() => wakes.length > 1, t.signal);
    assert.deepEqual(wakes.slice(1), [[`${active} imp new: done`]]);
  } finally { ac.abort(); await run; }
});

test('mod catch-up uses the recorded delivery instead of the two-hour default', async (t) => {
  const f = queueFixture(t), now = Date.now(), hour = 60 * 60_000;
  const id = 'j0000000000000001';
  writeJob(f.home, id, f.env.HERDR_PANE_ID, 'newer', { state: 'closed', settled_at: new Date(now - 3 * hour).toISOString() }, true);
  writeJob(f.home, 'j0000000000000002', f.env.HERDR_PANE_ID, 'older', { state: 'closed', settled_at: new Date(now - 5 * hour).toISOString() }, true);
  const ac = new AbortController(), wakes = [];
  const run = watchCommand(['--mod'], { env: { ...f.env, HUD_MOD_LAST_DELIVERY: String(now - 4 * hour) },
    stdout: s => wakes.push(JSON.parse(s)), stderr: s => assert.fail(s) }, { signal: ac.signal });
  try {
    await until(() => wakes.length > 0, t.signal);
    assert.deepEqual(wakes[0].lines, [`${id} imp newer: closed | report | ${readHint(id)}`, '1 older unread report — hud_read view:compact']);
    assert.ok(Number.isSafeInteger(wakes[0].at) && wakes[0].at >= now);
  } finally { ac.abort(); await run; }
});

test('mod JSONL uses shared actionable lines, sleeps only once clear, and resumes panel logs', { timeout: 60000 }, async (t) => {
  const f = queueFixture(t), pane = f.env.HERDR_PANE_ID, id = 'j0000000000000001';
  const dir = writeJob(f.home, id, pane, 'mod', { state: 'closed', settled_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }, true);
  const ac = new AbortController();
  t.after(() => ac.abort());
  const records = [], run = (env) => watchCommand(['--mod'], { env, stdout: s => { const r = JSON.parse(s); if (r.type !== 'band') records.push(r); }, stderr: s => assert.fail(s) },
    { signal: ac.signal, rescanMs: 50, queueIdleMs: 100, settlementWindowMs: 40 });
  const scans = observeStats(t, join(dir, 'STATUS.json'));
  const realNow = Date.now;
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const running = run({ ...f.env, HUD_MOD_CURSOR: '' });
  await until(() => records.some(r => r.type === 'wake'), t.signal);
  const before = scans();
  offset += 150; // Advance beyond queueIdleMs while the unread settlement is still present.
  await until(() => scans() >= before + 2, t.signal);
  assert.deepEqual(records.map(({ at, ...record }) => record), [
    { type: 'ready' }, { type: 'wake', lines: ['1 older unread report — hud_read view:compact'] },
  ]);
  const receipt = join(dir, 'job.json');
  writeFixtureFile(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), read_at: new Date().toISOString() }));
  assert.equal(await running, 0);
  const sleep = records.at(-1);
  assert.deepEqual(sleep, { type: 'sleep', cursor: '0:0', sizes: [0, 0] });
  assert.equal(fs.existsSync(join(f.home, 'watchers', `${pane}.pid`)), false);
  appendPanelAction(f.home, { type: 'retry', job: id });
  appendTry(f.home, process.cwd(), 'accept', { milestone: 'M1', slices: [{ id: 'ONE' }] });
  records.length = 0;
  assert.equal(await run({ ...f.env, HUD_MOD_CURSOR: sleep.cursor }), 0);
  assert.deepEqual(records.filter(r => r.type === 'wake').flatMap(r => r.lines), [
    `try accepted ${process.cwd().split('/').at(-1)} M1: ONE`, `[${id}] Retry requested from panel`,
  ]);
});

test('mod retention does not announce old settlements entering the watch window', async (t) => {
  const f = queueFixture(t), pane = f.env.HERDR_PANE_ID;
  const past = new Date(Date.now() - 25 * 3600_000), newer = new Date(+past + 1000);
  const id = (i) => `j${i.toString(16).padStart(16, '0')}`;
  const status = { state: 'closed', ended_at: past.toISOString() };
  const oldJob = (i, stamp, marks = {}, state = status) => {
    const dir = writeJob(f.home, id(i), pane, 'retained', state, true);
    const file = join(dir, 'job.json');
    const receipt = { ...JSON.parse(fs.readFileSync(file)), created_at: past.toISOString(), ...marks };
    writeFixtureFile(file, JSON.stringify(receipt));
    for (const path of ['report.md', 'STATUS.json', 'job.json', '.']) fs.utimesSync(join(dir, path), stamp, stamp);
    return { dir, receipt };
  };
  const seen = new Date(+newer + 1000).toISOString();
  oldJob(1, past, { read_at: seen });
  oldJob(2, past, { observed_at: seen }); // Delivered/observed, but report still unread.
  const active = oldJob(3, past, {}, { state: 'working' });
  const newerJobs = Array.from({ length: 200 }, (_, i) => oldJob(i + 4, newer, { read_at: seen }));
  const ac = new AbortController(), records = [];
  const run = watchCommand(['--mod'], { env: { ...f.env, HUD_MOD_CURSOR: '' },
    stdout: s => { const r = JSON.parse(s); if (r.type !== 'band') records.push(r); }, stderr: s => assert.fail(s) },
    { signal: ac.signal, rescanMs: 50, settlementWindowMs: 40 });
  try {
    await until(() => records.some(r => r.type === 'ready'), t.signal);
    assert.deepEqual(records, [{ type: 'ready' }]);
    for (const { dir, receipt } of newerJobs.slice(0, 3)) {
      archiveJob(f.home, dir, receipt.job, receipt, status, Date.now(), (s) => assert.fail(s));
      fs.rmSync(dir, { recursive: true });
    }
    // A real settlement outside the previous window still arrives, even on the same rescan.
    writeFixtureFile(join(active.dir, 'STATUS.json'), JSON.stringify({ state: 'done' }));
    await until(() => records.some(r => r.type === 'wake'), t.signal);
    assert.deepEqual(records.slice(1).map(({ type, lines }) => ({ type, lines })), [
      { type: 'wake', lines: [`${id(3)} imp retained: done | report | ${readHint(id(3))}`] },
    ]);
  } finally { ac.abort(); await run; }
});

test('mod watcher does not replay old settled unread jobs from other callers across a runtime reload', { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'watch-reload-adopt-'));
  const hudHome = join(root, 'hud');
  let runtime, runtimeExited, mod, modExited;
  cleanupFixture(t, { root, hudHome }, async () => {
    await Promise.all([
      mod && stopChild(mod, modExited, { killMs: 500 }),
      runtime && stopChild(runtime, runtimeExited, { killMs: 500 }),
    ]);
  });
  for (const name of ['bin/hud', 'dist', 'packages/hud-mcp', 'scripts/dist-lock.mjs', 'package.json'])
    fs.cpSync(resolve(name), join(root, name), { recursive: true });
  fs.symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  const bin = join(root, 'bin-stub'), panesFile = join(root, 'panes.json');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(hudHome, { mode: 0o700 });
  fs.writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'list') {
  const panes = JSON.parse(fs.readFileSync(${JSON.stringify(panesFile)}, 'utf8')).map((pane_id) => ({ pane_id }));
  console.log(JSON.stringify({ result: { panes } }));
}
`, { mode: 0o700 });
  const pane = 'w4E:p1', otherPane = 'w4E:p8', projectCwd = process.cwd();
  const past = new Date(Date.now() - 12 * 3600_000);
  const id = (i) => `j${i.toString(16).padStart(16, '0')}`;
  const writeOld = (i, status, report, extra = {}) => {
    const dir = writeJob(hudHome, id(i), otherPane, 'old-other', status, report, extra.parent_job);
    const file = join(dir, 'job.json');
    const receipt = { ...JSON.parse(fs.readFileSync(file)), created_at: past.toISOString(), cwd: projectCwd, ...extra };
    writeFixtureFile(file, JSON.stringify(receipt));
    for (const rel of [...(report ? ['report.md'] : []), 'STATUS.json', 'job.json', '.'])
      fs.utimesSync(join(dir, rel), past, past);
    return dir;
  };
  // 20 old settled unread/unobserved jobs from another caller: 18 closed top-level, 1 failed child, 1 closed child.
  for (let i = 1; i <= 18; i++) writeOld(i, { state: 'closed', settled_at: past.toISOString(), ended_at: past.toISOString() }, true);
  const oldFailedChild = writeOld(19, { state: 'failed', exit_reason: 'sonic exited', settled_at: past.toISOString(), ended_at: past.toISOString() }, false,
    { role: 'sonic', parent_job: 'j0000000000000099' });
  const oldClosedChild = writeOld(20, { state: 'closed', settled_at: past.toISOString(), ended_at: past.toISOString() }, true,
    { role: 'sonic', parent_job: 'j0000000000000099' });

  const duringId = 'j0000000000000a01', afterId = 'j0000000000000a02';
  const duringDir = writeJob(hudHome, duringId, pane, 'during', { state: 'working' });
  const afterDir = writeJob(hudHome, afterId, pane, 'after', { state: 'working' });
  for (const dir of [duringDir, afterDir]) {
    const file = join(dir, 'job.json');
    writeFixtureFile(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), cwd: projectCwd }));
  }

  writeFixtureFile(panesFile, JSON.stringify([pane, otherPane]));
  const env = { ...process.env, HOME: root, HUD_HOME: hudHome, HERDR_PANE_ID: pane, HUD_WATCH_SETTLEMENT_MS: '40', PATH: `${bin}:${process.env.PATH}` };
  delete env.HUD_HEAP_CAPS;
  runtime = spawn(process.execPath, [join(root, 'packages/hud-mcp/bin/hud-watch.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  runtimeExited = once(runtime, 'exit');
  const logFile = join(hudHome, 'watch.log');
  await until(() => ['watch.pid', 'watch.log', 'jobs-revision.json'].every((name) => fs.existsSync(join(hudHome, name))) &&
    fs.readFileSync(logFile, 'utf8').includes('start pid='), t.signal);

  const records = [];
  let buf = '', modStderr = '';
  mod = spawn(process.execPath, [join(root, 'bin/hud'), 'watch', '--mod'], {
    cwd: projectCwd, env: { ...env, HUD_MOD_CURSOR: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  modExited = once(mod, 'exit');
  mod.stdout.setEncoding('utf8').on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const record = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (record.type !== 'band') records.push(record);
    }
  });
  mod.stderr.setEncoding('utf8').on('data', (chunk) => { modStderr += chunk; });
  await until(() => records.some((r) => r.type === 'ready'), t.signal);

  let step = 0;
  const triggerBuildReload = () => {
    const tmp = join(root, `dist/index.js.${++step}.tmp`);
    fs.writeFileSync(tmp, fs.readFileSync(join(root, 'dist/index.js')));
    fs.renameSync(tmp, join(root, 'dist/index.js'));
  };
  const reloadCount = () => (fs.readFileSync(logFile, 'utf8').match(/reloaded pid=/g) ?? []).length;

  // Reload 1 while the other caller is still live: no adoption, no replay.
  triggerBuildReload();
  await until(() => reloadCount() === 1, t.signal);
  assert.deepEqual(records.filter((r) => r.type === 'wake'), []);

  // Other caller disappears, then Reload 2 (same after-build path) runs and a real job settles during reload.
  writeFixtureFile(panesFile, JSON.stringify([pane]));
  triggerBuildReload();
  writeFixtureFile(join(duringDir, 'report.md'), 'Genuine settlement during reload.');
  writeFixtureFile(join(duringDir, 'STATUS.json'), JSON.stringify({ state: 'done' }));
  await until(() => reloadCount() === 2 &&
    JSON.parse(fs.readFileSync(join(hudHome, 'jobs', id(1), 'job.json'), 'utf8')).herdr_pane === pane &&
    records.some((r) => r.type === 'wake' && r.lines.some((line) => line.includes(duringId))), t.signal);

  // A second job settling right after the reload is also delivered once.
  writeFixtureFile(join(afterDir, 'report.md'), 'Genuine settlement after reload.');
  writeFixtureFile(join(afterDir, 'STATUS.json'), JSON.stringify({ state: 'done' }));
  await until(() => records.some((r) => r.type === 'wake' && r.lines.some((line) => line.includes(afterId))), t.signal);

  assert.equal(modStderr, '');
  const wakeLines = records.filter((r) => r.type === 'wake').flatMap((r) => r.lines);
  assert.deepEqual(wakeLines, [
    `${duringId} imp during: done | report | ${readHint(duringId)}`,
    `${afterId} imp after: done | report | ${readHint(afterId)}`,
  ]);
  assert.equal(JSON.parse(fs.readFileSync(join(oldFailedChild, 'job.json'), 'utf8')).herdr_pane, pane);
  assert.equal(JSON.parse(fs.readFileSync(join(oldClosedChild, 'job.json'), 'utf8')).herdr_pane, otherPane,
    'settled closed child jobs are not mass-adopted');
});

test('mod sleep-resume folds old adopted unread jobs into one summary line and delivers a fresh settlement', async (t) => {
  const f = queueFixture(t), pane = f.env.HERDR_PANE_ID, otherPane = 'w4E:p8', now = Date.now();
  const past = new Date(now - 12 * 3600_000), projectCwd = process.cwd();
  fs.writeFileSync(join(f.home, 'bin/herdr'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'list') console.log(JSON.stringify({ result: { panes: [{ pane_id: ${JSON.stringify(pane)} }] } }));
`, { mode: 0o700 });
  for (let i = 1; i <= 20; i++) {
    const dir = writeJob(f.home, `j${i.toString(16).padStart(16, '0')}`, otherPane, 'old',
      { state: 'closed', settled_at: past.toISOString(), ended_at: past.toISOString() }, true);
    const file = join(dir, 'job.json');
    writeFixtureFile(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), created_at: past.toISOString(), cwd: projectCwd }));
    for (const rel of ['report.md', 'STATUS.json', 'job.json', '.']) fs.utimesSync(join(dir, rel), past, past);
  }
  const freshId = 'j0000000000000b01';
  const freshDir = writeJob(f.home, freshId, pane, 'fresh', { state: 'closed', settled_at: new Date(now - 5_000).toISOString() }, true);
  const freshFile = join(freshDir, 'job.json');
  writeFixtureFile(freshFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(freshFile)), cwd: projectCwd }));

  const ac = new AbortController(), wakes = [];
  const run = watchCommand(['--mod'], {
    env: { ...f.env, HUD_MOD_CURSOR: '0:0', HUD_MOD_LAST_DELIVERY: String(now - 60_000) },
    stdout: (s) => { const r = JSON.parse(s); if (r.type === 'wake') wakes.push(r.lines); },
    stderr: (s) => assert.fail(s),
  }, { signal: ac.signal, rescanMs: 50, settlementWindowMs: 40 });
  try {
    await until(() => wakes.length > 0, t.signal);
    const lines = wakes.flat();
    assert.deepEqual(lines, [
      `${freshId} imp fresh: closed | report | ${readHint(freshId)}`,
      '20 older unread reports — hud_read view:compact',
    ]);
  } finally { ac.abort(); await run; }
});

test('a live pi watcher suppresses fallback, but dead, reused and mismatched PIDs do not', async (t) => {
  const f = queueFixture(t, 'pi'), pane = f.env.HERDR_PANE_ID;
  const pidFile = join(f.home, 'watchers', `${pane}.pid`);
  const script = join(f.home, 'pi');
  fs.writeFileSync(script, `
    import { registerPiWatcher } from ${JSON.stringify(new URL('../../packages/hud-mcp/bin/hud-notify.mjs', import.meta.url).href)};
    registerPiWatcher(process.env.HERDR_PANE_ID, process.env.HUD_HOME);
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [script], { env: f.env, stdio: 'ignore' });
  const exited = once(child, 'exit');
  f.onCleanup(() => stopChild(child, exited));
  await until(() => fs.existsSync(pidFile), t.signal);
  const marker = fs.readFileSync(pidFile, 'utf8'), pi = JSON.parse(marker);
  assert.equal(pi.pid, child.pid);
  assert.equal(watching(pane, f.home), true);
  assert.deepEqual(await notify(pane, 'Synthetic question', f.home, { env: f.env }), { status: 0, skipped: true });
  assert.deepEqual(f.deliveries(), []);

  const otherPane = 'w4E:p9';
  fs.writeFileSync(join(f.home, 'watchers', `${otherPane}.pid`), JSON.stringify({ ...pi, pane: otherPane }));
  assert.equal(watching(otherPane, f.home), false, 'different launch pane');
  const otherHome = join(f.home, 'other');
  fs.mkdirSync(join(otherHome, 'watchers'), { recursive: true });
  fs.writeFileSync(join(otherHome, 'watchers', `${pane}.pid`), JSON.stringify({ ...pi, home: otherHome }));
  assert.equal(watching(pane, otherHome), false, 'different launch HUD home');
  fs.writeFileSync(pidFile, JSON.stringify({ ...pi, start: '0' }));
  assert.equal(watching(pane, f.home), false, 'stale process start time with otherwise matching identity');
  fs.writeFileSync(pidFile, marker);
  child.kill('SIGKILL');
  await exited;
  assert.equal(watching(pane, f.home), false);
  await promptFork(f, () => legacyPong);
  assert.equal((await notify(pane, 'Synthetic question', f.home, { env: f.env })).status, 0);
  assert.deepEqual(f.deliveries().map((d) => d.args), [['agent', 'prompt', pane, 'Synthetic question']]);
});

for (const [label, agent, thread, fail] of [
  ['Codex queue', 'codex', '00000000-0000-4000-8000-000000000001', false],
  ['queue failure types', 'codex', '00000000-0000-4000-8000-000000000001', true],
  ['no thread types', 'codex', null, false],
  ['other agents type', 'claude', null, false],
]) test(`CLI and pi questions: ${label}`, async (t) => {
  const f = queueFixture(t, agent, thread, fail), id = 'j0000000000000001';
  await promptFork(f, () => legacyPong);
  const dir = writeJob(f.home, id, 'w4E:p1', 'queue', { state: 'working' });
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'ORCH=w4E:p1\n');
  const ask = await runCli('hud-ask', ['--dir', dir, '--question', 'Which layout?', '--default', 'rows', '--timeout', '0'], f.env);
  if (fail) assert.match(ask.stdout, /codex queue failed.*fell back to typing/);
  await runCli('hud-notify', [f.home, 'w4E:p1', id, '[imp@demo] QUESTION q99: Which layout? | reply: write /synthetic/q99.answer.md'], f.env);
  const all = f.deliveries(), queued = all.filter((d) => d.args[0] === 'queue'), typed = all.filter((d) => d.args[0] === 'agent');
  const usesQueue = agent === 'codex' && thread !== null;
  assert.equal(queued.length, usesQueue ? 2 : 0);
  assert.equal(typed.length, usesQueue && !fail ? 0 : 2);
  const lines = [
    `[imp@${id}] QUESTION q1: Which layout? | default: rows | full text: ${join(dir, 'qa/q1.md')} | reply: hud_respond job=${id} request_id=q1`,
    `[imp@demo] QUESTION q99: Which layout? | reply: hud_respond job=${id} request_id=q99`,
  ];
  const procEnv = Object.fromEntries(fs.readFileSync('/proc/self/environ', 'utf8').split('\0').map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
  queued.forEach((d, i) => {
    assert.deepEqual(d.args, ['queue', '--thread', thread, '--message', lines[i]]);
    assert.equal(d.home, procEnv.CODEX_HOME || join(procEnv.HOME, '.codex'), 'use the pane process account, not notifier CODEX_HOME');
    assert.notEqual(d.home, f.env.CODEX_HOME);
  });
  typed.forEach((d, i) => assert.deepEqual(d.args, ['agent', 'prompt', 'w4E:p1', lines[i]]));
});

test('hud watch --queue queues catch-up and settlement silently and exits on agent change', async (t) => {
  const f = queueFixture(t);
  writeJob(f.home, 'j0000000000000001', 'w4E:p1', 'catchup', { state: 'idle_grace' }, true);
  const dir = writeJob(f.home, 'j0000000000000002', 'w4E:p1', 'settlement', { state: 'working' });
  const ac = new AbortController(), stdout = [], stderr = [];
  t.after(() => ac.abort());
  // Queue scans also run synthetic CLI subprocesses; keep headroom for the second scan.
  const running = watchCommand(['--queue'], { env: f.env, stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) }, { signal: ac.signal, rescanMs: 60, settlementWindowMs: 1000 });
  await until(() => fs.existsSync(join(f.home, 'watchers/w4E:p1.pid')), t.signal);
  writeFixtureFile(join(dir, 'report.md'), 'Done.');
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  await until(() => f.deliveries().length > 0, t.signal);
  const deliveries = f.deliveries();
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].args.slice(0, 4), ['queue', '--thread', '00000000-0000-4000-8000-000000000001', '--message']);
  // The update can land before or during the async catch-up scan.
  assert.deepEqual(deliveries[0].args[4].split('\n').sort(), [
    `j0000000000000001 imp catchup: idle_grace | report | ${readHint('j0000000000000001')}`,
    `j0000000000000002 imp settlement: idle_grace | report | ${readHint('j0000000000000002')}`,
  ]);
  writeFixtureFile(f.agentFile, 'claude');
  assert.equal(await running, 0);
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, []);
  assert.equal(fs.existsSync(join(f.home, 'watchers/w4E:p1.pid')), false);
});

test('hud watch --queue exits within 500 ms on SIGTERM during a hung Codex queue', async (t) => {
  const f = queueFixture(t), pane = f.env.HERDR_PANE_ID;
  const started = join(f.home, 'queue-start');
  fs.writeFileSync(join(f.home, 'bin/codex'), `#!${process.execPath}
import fs from 'node:fs';
import { setTimeout } from 'node:timers/promises';
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
await setTimeout(3000);
`, { mode: 0o700 });
  const dir = writeJob(f.home, 'j0000000000000001', pane, 'question', { state: 'working' });
  fs.mkdirSync(join(dir, 'qa'));
  fs.writeFileSync(join(dir, 'qa/q1.md'), 'Synthetic question.');
  const watcher = spawn(process.execPath, [resolve('bin/hud'), 'watch', '--queue'], { env: f.env, stdio: 'ignore' });
  const exited = once(watcher, 'exit');
  f.onCleanup(() => stopChild(watcher, exited, { killMs: 1000 }));
  await until(() => fs.existsSync(started), t.signal);
  const start = performance.now();
  watcher.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  const elapsed = performance.now() - start;
  t.diagnostic(`queue watcher SIGTERM: ${elapsed.toFixed(0)} ms`);
  assert.ok(elapsed < 500);
  assert.equal(fs.existsSync(join(f.home, 'watchers', `${pane}.pid`)), false);
  assert.equal(fs.existsSync(`/proc/${fs.readFileSync(started, 'utf8')}`), false, 'queue child exited');
  assert.deepEqual(f.deliveries(), [], 'cancellation does not fall back to typing');
});

test('hud watch --queue typed fallback keeps running and exits after injectable empty idle interval', async (t) => {
  const f = queueFixture(t, 'codex', 'synthetic-thread', true);
  await promptFork(f, () => legacyPong);
  const dir = writeJob(f.home, 'j0000000000000001', 'w4E:p1', 'fallback', { state: 'closed' }, true);
  const ac = new AbortController(), stdout = [], stderr = [];
  t.after(() => ac.abort());
  const scans = observeStats(t, join(dir, 'STATUS.json'));
  const realNow = Date.now;
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const running = watchCommand(['--queue'], { env: f.env, stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) }, { signal: ac.signal, rescanMs: 60, queueIdleMs: 100, settlementWindowMs: 250 });
  await until(() => f.deliveries().length === 2, t.signal);
  const before = scans();
  await until(() => scans() > before, t.signal);
  offset += 180;
  await until(() => scans() > before + 1, t.signal);
  assert.equal(fs.existsSync(join(f.home, 'watchers/w4E:p1.pid')), true, 'unread report prevents idle exit');
  const job = JSON.parse(fs.readFileSync(join(dir, 'job.json')));
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ ...job, read_at: new Date(Date.now() + 1000).toISOString() }));
  assert.equal(await running, 0);
  assert.deepEqual(f.deliveries().map((d) => d.args[0]), ['queue', 'agent']);
  assert.equal(f.deliveries()[0].args[4], f.deliveries()[1].args[3]);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join(''), /codex queue failed.*fell back to typing/);
});

async function promptFork(f, respond) {
  f.env.HERDR_SOCKET_PATH = join(f.home, 'fork.sock');
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const lines = createInterface({ input: socket });
    lines.on('line', line => {
      const { id, method, params } = JSON.parse(line);
      const payload = respond(method, params, socket);
      if (payload) socket.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  });
  server.listen(f.env.HERDR_SOCKET_PATH);
  await once(server, 'listening');
  f.onCleanup(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, 'close');
  });
}

const runCli = (name, args, env) => promisify(execFile)(process.execPath, [resolve(`packages/hud-mcp/bin/${name}.mjs`), ...args], { env });
const legacyPong = { result: { type: 'pong', capabilities: {} } };
const guardedPong = { result: { type: 'pong', capabilities: { guarded_prompt: true } } };
const prompted = { result: { type: 'agent_prompted' } };

test('advertised guard is required, but an older pong preserves the unguarded path', async (t) => {
  const f = queueFixture(t, 'claude'), pane = f.env.HERDR_PANE_ID;
  let ping = legacyPong;
  let dropPrompt = false;
  const prompts = [];
  await promptFork(f, (method, params, socket) => {
    if (method === 'ping') return ping;
    assert.equal(method, 'agent.prompt');
    prompts.push(params);
    if (dropPrompt) { socket.end(); return; }
    return prompted;
  });
  assert.equal((await notify(pane, 'Legacy notice', f.home, { env: f.env })).status, 0);
  ping = guardedPong;
  assert.equal((await notify(pane, 'Guarded notice', f.home, { env: f.env })).status, 0);
  dropPrompt = true;
  const lost = await notify(pane, 'Uncertain notice', f.home, { env: f.env });
  assert.equal(lost.uncertain, true);
  assert.equal(lost.retryPrompt, undefined);
  ping = { error: { code: 'unavailable' } };
  assert.ok((await notify(pane, 'Pending notice', f.home, { env: f.env })).retryPrompt);
  assert.ok((await notify(pane, 'No socket', f.home, { env: { ...f.env, HERDR_SOCKET_PATH: '' } })).retryPrompt);
  assert.deepEqual(f.deliveries().map(d => d.args), [['agent', 'prompt', pane, 'Legacy notice']]);
  assert.deepEqual(prompts, [
    { target: pane, text: 'Guarded notice', guarded: true },
    { target: pane, text: 'Uncertain notice', guarded: true },
  ]);
});

for (const [agent, refusal] of [
  ['agy', 'not_ready'], ['codex', 'scrolled_back'], ['codex', 'recent_input'],
  ['agy', 'draft_present'], ['codex', 'prompt_unknown'],
]) test(`guarded ${agent} watch retries ${refusal} without a duplicate wake`, async (t) => {
  const f = queueFixture(t, agent, 'synthetic-thread', true), pane = f.env.HERDR_PANE_ID;
  const dir = writeJob(f.home, 'j0000000000000001', pane, 'guard', { state: 'working' });
  fs.mkdirSync(join(dir, 'qa'));
  fs.writeFileSync(join(dir, 'qa/q1.md'), 'Synthetic question.');
  const sent = [], attempts = [], stderr = [], ac = new AbortController();
  let subscribed, ready = false;
  await promptFork(f, (method, params, socket) => {
    if (method === 'ping') return guardedPong;
    if (method === 'events.subscribe') { subscribed = socket; return { result: { type: 'subscription_started' } }; }
    assert.equal(method, 'agent.prompt');
    assert.deepEqual(params, { target: pane, text: params.text, guarded: true });
    attempts.push(params.text);
    if (!ready) return { error: { code: refusal } };
    sent.push(params.text);
    return prompted;
  });
  f.onCleanup(() => ac.abort());
  const scans = observeStats(t, join(dir, 'STATUS.json'));
  const running = watchCommand(['--queue'], { env: f.env, stdout: (s) => assert.fail(s), stderr: (s) => stderr.push(s) },
    { signal: ac.signal, rescanMs: 30_000 });
  await until(() => subscribed, t.signal);
  assert.equal(attempts.length, 1);
  assert.deepEqual(sent, []);
  if (agent === 'agy') assert.equal(fs.existsSync(agyPending(f)), true);
  ready = true;
  if (refusal === 'prompt_unknown') writeFixtureFile(join(dir, 'qa/q2.md'), 'A second synthetic question.');
  else if (refusal !== 'recent_input') subscribed.write(JSON.stringify({ event: 'pane.updated', data: { pane: { pane_id: pane } } }) + '\n');
  await until(() => sent.length === 1 && subscribed.destroyed, t.signal);
  const before = scans();
  writeFixtureFile(join(f.home, 'tries.jsonl'), '');
  await until(() => scans() > before, t.signal);
  ac.abort();
  assert.equal(await running, 0);
  assert.deepEqual(attempts, [sent[0].split('\n')[0], sent[0]]);
  assert.match(sent[0], /Synthetic question/);
  if (refusal === 'prompt_unknown') assert.match(sent[0], /A second synthetic question/);
  assert.deepEqual(f.deliveries().map(d => d.args[0]), agent === 'codex' ? ['queue'] : []);
  assert.deepEqual(stderr, []);
  if (agent === 'agy') assert.deepEqual(runAgyHook(f.env), {});
});

for (const end of ['timeout', 'pane exit']) test(`a pending Codex fallback stops on ${end}`, async (t) => {
  const f = queueFixture(t, 'codex', 'synthetic-thread', true), pane = f.env.HERDR_PANE_ID;
  const dir = writeJob(f.home, 'j0000000000000001', pane, 'guard', { state: 'working' });
  fs.mkdirSync(join(dir, 'qa'));
  fs.writeFileSync(join(dir, 'qa/q1.md'), 'Synthetic question.');
  let subscription, attempts = 0;
  const ac = new AbortController();
  await promptFork(f, (method, _params, socket) => {
    if (method === 'ping') return guardedPong;
    if (method === 'events.subscribe') { subscription = socket; return { result: { type: 'subscription_started' } }; }
    assert.equal(method, 'agent.prompt');
    attempts++;
    return { error: { code: 'draft_present' } };
  });
  f.onCleanup(() => ac.abort());
  const now = performance.now.bind(performance);
  let advance = 0;
  t.mock.method(performance, 'now', () => now() + advance);
  const running = watchCommand(['--queue'], { env: f.env, stdout: (s) => assert.fail(s), stderr: (s) => assert.fail(s) },
    { signal: ac.signal, rescanMs: 30_000 });
  await until(() => subscription, t.signal);
  if (end === 'timeout') advance = 10 * 60_000;
  const event = end === 'timeout' ? 'pane.scroll_changed' : 'pane.exited';
  subscription.write(JSON.stringify({ event, data: { pane_id: pane } }) + '\n');
  await until(() => subscription.destroyed, t.signal);
  const log = join(f.home, 'watchers/typed-expiry.log');
  if (end === 'timeout') {
    assert.match(fs.readFileSync(log, 'utf8'), /pending typed notice expired/);
    assert.equal(fs.statSync(log).mode & 0o777, 0o600);
    ac.abort();
  } else assert.equal(fs.existsSync(log), false);
  assert.equal(await running, 0);
  assert.equal(attempts, 1);
  assert.deepEqual(f.deliveries().map(d => d.args[0]), ['queue']);
});

test('resident question sender coalesces notices while a guarded refusal is pending', async (t) => {
  const f = queueFixture(t, 'pi'), pane = f.env.HERDR_PANE_ID;
  const id = 'j0000000000000001', dir = writeJob(f.home, id, pane, 'question', { state: 'working' });
  const job = JSON.parse(fs.readFileSync(join(dir, 'job.json')));
  const make = question => publishQuestion(join(dir, 'qa'), { question, default: 'Synthetic default.', tag: 'imp@demo' });
  let subscription, ready = false;
  const prompts = [];
  await promptFork(f, (method, params, socket) => {
    if (method === 'ping') return guardedPong;
    if (method === 'events.subscribe') { subscription = socket; return { result: { type: 'subscription_started' } }; }
    assert.equal(method, 'agent.prompt');
    assert.equal(params.guarded, true);
    prompts.push(params.text);
    return ready ? prompted : { error: { code: 'draft_present' } };
  });
  for (const key of ['HERDR_SOCKET_PATH', 'PATH']) {
    const original = process.env[key];
    process.env[key] = f.env[key];
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
  assert.equal(await notifyQuestion(dir, job, make('One-shot question.')), 'recorded for HUD reads');
  assert.equal(await notifyQuestion(dir, job, make('First resident question.'), undefined, true), 'pending for guarded typing');
  assert.equal(await notifyQuestion(dir, job, make('Latest resident question.'), undefined, true), 'pending for guarded typing');
  await until(() => subscription, t.signal);
  assert.equal(prompts.length, 2);
  ready = true;
  subscription.write(JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: pane, agent_status: 'idle' } }) + '\n');
  await until(() => subscription.destroyed, t.signal);
  assert.equal(prompts.length, 3);
  assert.match(prompts[2], /Latest resident question/);
  assert.deepEqual(f.deliveries(), []);
});

const agyHook = resolve('integrations/agy/pre-invocation.sh');
const agyPayload = JSON.stringify({ conversationId: 'synthetic-main', cwd: '/synthetic', hookEventName: 'PreInvocation',
  invocationNum: 3, transcriptPath: '/synthetic/transcript', modelName: 'synthetic-model' });
const agyPending = (f) => join(f.home, 'watchers', `${f.env.HERDR_PANE_ID}.agy-pending`);
const agyHookLines = (reply) => {
  if (!reply.injectSteps) { assert.deepEqual(reply, {}); return []; }
  assert.equal(reply.injectSteps.length, 1);
  const [head, ...lines] = reply.injectSteps[0].userMessage.split('\n');
  assert.equal(head, '[HUD job events]');
  return lines;
};

function runAgyHook(env) {
  const ran = spawnSync(agyHook, [], { env, input: agyPayload, encoding: 'utf8', timeout: 60000 });
  assert.equal(ran.status, 0, ran.stderr || ran.error?.message);
  return JSON.parse(ran.stdout);
}

test('agy watcher types when idle, injects while working, and flushes pending on the idle rescan', async (t) => {
  const f = queueFixture(t, 'agy'), pane = f.env.HERDR_PANE_ID, file = agyPending(f);
  await promptFork(f, () => legacyPong);
  const create = (n, name) => writeJob(f.home, `j${String(n).padStart(16, '0')}`, pane, name, { state: 'idle_grace' }, true);
  const ac = new AbortController(), stderr = [];
  t.after(() => ac.abort());
  create(1, 'idle event');
  const running = watchCommand(['--queue'], { env: f.env, stdout: (s) => assert.fail(s), stderr: (s) => stderr.push(s) },
    { signal: ac.signal, rescanMs: 80, settlementWindowMs: 30 });
  await until(() => f.deliveries().length === 1, t.signal);
  assert.deepEqual(f.deliveries()[0].args, ['agent', 'prompt', pane, `j0000000000000001 imp idle event: idle_grace | report | ${readHint('j0000000000000001')}`]);
  assert.deepEqual(runAgyHook(f.env), {});

  writeFixtureFile(f.statusFile, 'working');
  create(2, 'working "事件"');
  await until(() => fs.existsSync(file), t.signal);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(runAgyHook({ ...f.env, HERDR_PANE_ID: '' }), {});
  assert.deepEqual(runAgyHook({ ...f.env, HUD_HOME: '' }), {});
  assert.deepEqual(agyHookLines(runAgyHook(f.env)), [`j0000000000000002 imp working "事件": idle_grace | report | ${readHint('j0000000000000002')}`]);
  assert.deepEqual(runAgyHook(f.env), {});
  assert.equal(f.deliveries().length, 1);

  create(3, 'pending until idle');
  await until(() => fs.existsSync(file), t.signal);
  assert.equal(f.deliveries().length, 1);
  writeFixtureFile(f.statusFile, 'idle'); // Not under jobs/: only the safety rescan notices.
  await until(() => f.deliveries().length === 2, t.signal);
  assert.deepEqual(f.deliveries()[1].args, ['agent', 'prompt', pane, `j0000000000000003 imp pending until idle: idle_grace | report | ${readHint('j0000000000000003')}`]);
  assert.deepEqual(runAgyHook(f.env), {});
  ac.abort();
  assert.equal(await running, 0);
  assert.deepEqual(stderr, []);
});

test('agy hook processes and the watcher racing an idle flush deliver each event once', async (t) => {
  const f = queueFixture(t, 'agy'), pane = f.env.HERDR_PANE_ID, file = agyPending(f);
  await promptFork(f, () => legacyPong);
  const create = (n) => writeJob(f.home, `j${String(n).padStart(16, '0')}`, pane, `race-${n}`, { state: 'idle_grace' }, true);
  writeFixtureFile(f.statusFile, 'working');
  create(1);
  create(2);
  const watcher = spawn(process.execPath, ['--input-type=module', '-e', `
    import { watchCommand } from './dist/cli/watch.js';
    await watchCommand(['--queue'], { env: process.env, stdout: console.log, stderr: console.error },
      { rescanMs: 50, settlementWindowMs: 30 });
  `], { env: f.env, stdio: 'ignore' });
  const exited = once(watcher, 'exit');
  f.onCleanup(() => stopChild(watcher, exited, { killMs: 1000 }));
  await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('race-1') && fs.readFileSync(file, 'utf8').includes('race-2'), t.signal);
  const hooks = Array.from({ length: 6 }, async () => {
    const child = spawn(agyHook, [], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (s) => { out += s; });
    assert.deepEqual(await closed, [0, null]);
    return agyHookLines(JSON.parse(out));
  });
  writeFixtureFile(f.statusFile, 'idle');
  create(3);
  const injected = (await Promise.all(hooks)).flat();
  const typed = () => f.deliveries().flatMap(({ args }) => args[3].split('\n'));
  await until(() => typed().length + injected.length >= 3 && !fs.existsSync(file), t.signal);
  watcher.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  assert.deepEqual([...typed(), ...injected].sort(), [1, 2, 3].map((n) => {
    const id = `j${String(n).padStart(16, '0')}`;
    return `${id} imp race-${n}: idle_grace | report | ${readHint(id)}`;
  }));
  assert.deepEqual(runAgyHook(f.env), {});
});

test('hud watch without HERDR_PANE_ID or --all prints one error line and exits 1', async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-nopane-'));
  t.after(() => fs.rmSync(hudHome, { recursive: true, force: true }));
  let out = '';
  let err = '';
  const code = await main(['watch'], {
    env: { HUD_HOME: hudHome },
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
  });
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.equal(err.trim().split('\n').length, 1);
  assert.match(err, /no pane.*--all/i);
});

test('idle hud watch reads nothing between safety rescans', async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-idle-'));
  t.after(() => fs.rmSync(hudHome, { recursive: true, force: true }));
  const callerDir = writeJob(hudHome, 'j00000000000000e8', 'w4E:p1', 'pkg-idle', { state: 'working' });
  const jobsDir = join(hudHome, 'jobs');

  let jobLists = 0;
  let statusStats = 0;
  const originals = { readdirSync: fs.readdirSync, lstatSync: fs.lstatSync };
  fs.readdirSync = (file, ...args) => {
    if (String(file) === jobsDir) jobLists++;
    return originals.readdirSync(file, ...args);
  };
  fs.lstatSync = (file, ...args) => {
    if (String(file) === join(callerDir, 'STATUS.json')) statusStats++;
    return originals.lstatSync(file, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.timers.reset();
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  });

  const { watchCommand: freshWatch } = await import('../../dist/cli/watch.js?idle');
  const ac = new AbortController();
  t.after(() => ac.abort());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = freshWatch([], { env: { HUD_HOME: hudHome, HERDR_PANE_ID: 'w4E:p1' }, stdout: () => {}, stderr: () => {} }, { rescanMs: 400, signal: ac.signal });

  // Give the initial scan its first turn, then drive the safety timer without racing wall time.
  await new Promise(setImmediate);
  const lists = jobLists, stats = statusStats;
  assert.equal(stats, 1, 'one baseline read of STATUS.json');
  t.mock.timers.tick(399);
  await new Promise(setImmediate);
  assert.equal(jobLists, lists, 'idle watch must not list jobs between rescans');
  assert.equal(statusStats, stats, 'idle watch must not stat STATUS.json between rescans');

  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.equal(statusStats, stats + 1, 'safety rescan reads once after rescanMs');

  ac.abort();
  assert.equal(await running, 0);
});

test('bin/hud watch flushes already-failed arrivals and exits cleanly on SIGTERM', { timeout: 60000 }, async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-bin-'));
  let child, closed;
  cleanupFixture(t, { root: hudHome }, () => child && stopChild(child, closed));
  const baseline = writeJob(hudHome, 'j00000000000000e5', 'w4E:p1', 'baseline', { state: 'working' });
  // The marker is written before the CLI attaches its watches. Observe the first
  // baseline read instead, so the failed job is a new arrival, not catch-up.
  const probe = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const stat = fs.lstatSync;
fs.lstatSync = (file, ...args) => {
  if (file === ${JSON.stringify(join(baseline, 'STATUS.json'))}) {
    fs.lstatSync = stat;
    syncBuiltinESMExports();
    setImmediate(() => process.send('baseline', () => process.disconnect()));
  }
  return stat(file, ...args);
};
syncBuiltinESMExports();`;
  child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(probe), resolve('bin/hud'), 'watch'], {
    env: { ...process.env, HUD_HOME: hudHome, HERDR_PANE_ID: 'w4E:p1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  closed = once(child, 'close');
  const baselineRead = once(child, 'message', { signal: t.signal });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });

  const [ready] = await baselineRead;
  assert.equal(ready, 'baseline');
  assert.equal(stdout, '');

  // Publish the whole arrival at once so its directory event cannot precede STATUS.
  const failedId = 'j00000000000000f6';
  const failed = writeJob(join(hudHome, 'staging'), failedId, 'w4E:p1', 'tab-gone', { state: 'failed', exit_reason: 'tab closed' });
  fs.renameSync(failed, join(hudHome, 'jobs', failedId));
  await until(() => stdout.includes(`${failedId} imp tab-gone: failed | tab closed\n`), t.signal);

  child.kill('SIGTERM');
  const [code, signal] = await closed;
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.equal(stderr, '');
});

test('hud watch on a fresh home without jobs/ hears the first job at once, not at the rescan', { timeout: 60000 }, async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-fresh-'));
  t.after(() => fs.rmSync(hudHome, { recursive: true, force: true }));
  const ac = new AbortController();
  t.after(() => ac.abort());
  const seen = [], ready = Promise.withResolvers(), timer = globalThis.setTimeout;
  const timers = t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === 30000) ready.resolve(); // The empty baseline has been scanned and the safety wait is armed.
    return timer(fn, ms, ...args);
  });
  const staged = join(hudHome, 'staging');
  const dir = writeJob(staged, 'j00000000000000f1', 'w4E:p1', 'pkg-fresh', { state: 'failed', exit_reason: 'tab closed' });
  const running = watchCommand(['--all'], {
    env: { HUD_HOME: hudHome },
    stdout: (text) => { seen.push(...text.trim().split('\n')); },
    stderr: () => {},
  }, { rescanMs: 30000, signal: ac.signal });
  await ready.promise;
  timers.mock.restore();
  // Publish a new failure, not an older row moving into the watch window. Explicitly order its mtime
  // after the baseline scan; a filesystem's timestamp resolution need not match Date.now().
  const publishedAt = new Date(Date.now() + 1);
  fs.utimesSync(join(dir, 'STATUS.json'), publishedAt, publishedAt);
  fs.renameSync(join(staged, 'jobs'), join(hudHome, 'jobs'));
  await until(() => seen.length > 0, 3000);
  assert.match(seen[0], /^j00000000000000f1 imp pkg-fresh: failed/);
  ac.abort();
  assert.equal(await running, 0);
});
