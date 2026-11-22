import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { main } from '../../dist/cli/hud-main.js';
import { watchCommand } from '../../dist/cli/watch.js';
import { procStat } from '../../dist/mcp/cli-judge.js';
import { cachedReportSignature, writeReportMeta } from '../../dist/roles/report-meta.js';
import { notify, watching } from '../../packages/hud-mcp/bin/hud-notify.mjs';
import { git, initRepo } from '../fixtures/managed-worktree.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await wait(25);
  }
  assert.fail('timed out waiting for expected watcher output');
}

for (const scenario of ['merged', 'dirty', 'unmerged', 'nested']) test(`watcher preserves data when cleaning a ${scenario} managed worktree`, (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-worktree-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
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
  } else if (scenario === 'dirty') fs.writeFileSync(join(root, 'ignored.txt'), 'keep this ignored file');
  else {
    fs.appendFileSync(join(root, 'tracked.txt'), 'new commit\n');
    git(root, 'commit', '-qam', 'job work');
    if (scenario === 'merged') git(main_root, 'merge', '-q', branch);
  }
  fs.mkdirSync(join(main_root, 'node_modules'));
  fs.symlinkSync(join(main_root, 'node_modules'), join(root, 'node_modules'));
  fs.writeFileSync(join(home, 'pi-role-reap'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const env = { ...process.env, HOME: home, HUD_HOME: join(home, 'hud'), PATH: `${home}:${process.env.PATH}` };
  const dir = writeJob(env.HUD_HOME, id, 'w4E:p1', 'imp', { state: 'closed', ended_at: new Date().toISOString() });
  const file = join(dir, 'job.json'), job = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...job, cwd: root, worktree: { main_root, root, branch, base_head } }));
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'TAB=w4E:t2\n');
  const watcher = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(watcher.status, 0, watcher.stderr || String(watcher.error));
  const result = JSON.parse(fs.readFileSync(file));
  assert.ok(result.reaped_at);
  assert.equal(fs.existsSync(root), scenario !== 'merged');
  assert.equal(!!git(main_root, 'branch', '--list', branch), scenario !== 'merged');
  assert.ok(fs.statSync(join(main_root, 'node_modules')).isDirectory());
  if (scenario === 'merged') {
    assert.equal(result.worktree_kept_reason, undefined);
    assert.ok(result.worktree_removed_at);
  } else {
    assert.match(result.worktree_kept_reason, new RegExp(scenario));
    assert.equal(fs.readlinkSync(join(root, 'node_modules')), join(main_root, 'node_modules'));
  }
  if (nestedCommit) {
    assert.equal(result.worktree_removed_at, undefined);
    assert.equal(git(vendor, 'rev-parse', 'HEAD'), nestedCommit);
    assert.equal(git(vendor, 'show', `${nestedCommit}:tracked.txt`), 'nested-only content');
    assert.equal(git(main_root, 'rev-parse', branch), base_head);
  }
});

test('dead supervisor watcher preserves a live worker; both gone fail or close by the explicit report baseline', { timeout: 10000 }, async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'dead-supervisor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, HUD_HOME: join(home, 'hud'), HUD_WATCH_CLI_CHECK_MS: '30' };
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env, stdio: 'ignore' });
  const supervisor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env, stdio: 'ignore' });
  t.after(() => { worker.kill('SIGKILL'); supervisor.kill('SIGKILL'); });
  await until(() => procStat(worker.pid) !== null);
  const initial = { state: 'working', pid: worker.pid, pid_start_time: procStat(worker.pid).start, supervisor_pid: supervisor.pid };
  const failed = writeJob(env.HUD_HOME, 'j00000000000000f1', 'w4E:p1', 'no-report', initial);
  const closed = writeJob(env.HUD_HOME, 'j00000000000000f2', 'w4E:p1', 'with-report', initial, true);
  for (const dir of [failed, closed]) fs.writeFileSync(join(dir, 'turn.json'), JSON.stringify({ seq: 1, sent_at: new Date().toISOString(), report_sig: null }));
  const watcher = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { env, stdio: 'ignore' });
  t.after(() => watcher.kill('SIGKILL'));
  supervisor.kill('SIGKILL');
  await new Promise((r) => supervisor.once('exit', r));
  const status = (dir) => JSON.parse(fs.readFileSync(join(dir, 'STATUS.json')));
  await until(() => status(failed).state === 'waiting_orchestrator');
  assert.equal(status(failed).reason, 'supervisor exited; worker still running');
  assert.equal(status(failed).error, null);
  // The watcher updates the two jobs one after the other.
  await until(() => status(closed).state === 'waiting_orchestrator');
  const stamp = fs.statSync(join(failed, 'STATUS.json')).mtimeMs;
  await wait(120);
  assert.equal(fs.statSync(join(failed, 'STATUS.json')).mtimeMs, stamp, 'unchanged observation does not rewrite STATUS');
  worker.kill('SIGKILL');
  await new Promise((r) => worker.once('exit', r));
  await until(() => status(failed).state === 'failed' && status(closed).state === 'closed');
  assert.equal(status(failed).exit_reason, 'worker exited');
  assert.equal(status(closed).output_written, true);
});

test('hud watch --verbose retains the existing MCP change lines', async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-'));
  t.after(() => fs.rmSync(hudHome, { recursive: true, force: true }));

  const callerDir = writeJob(hudHome, 'j00000000000000a1', 'w4E:p1', 'pkg-a', { state: 'working' });
  const foreignDir = writeJob(hudHome, 'j00000000000000b2', 'w4E:p9', 'pkg-b', { state: 'working' });

  const env = { ...process.env, HUD_HOME: hudHome, HERDR_PANE_ID: 'w4E:p1' };
  const lines = [];
  const ac = new AbortController();
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

  await wait(80);
  assert.deepEqual(lines, []);

  // Foreign-pane changes must stay silent, and mutating HERDR_PANE_ID after startup must not switch panes.
  env.HERDR_PANE_ID = 'w4E:p9';
  fs.writeFileSync(join(foreignDir, 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'tab closed' }));
  await wait(80);
  assert.deepEqual(lines, []);

  // 1: working -> waiting_orchestrator
  fs.writeFileSync(
    join(callerDir, 'STATUS.json'),
    JSON.stringify({ state: 'waiting_orchestrator', blocked: false, reason: 'quiet', harness: 'cli' })
  );
  await until(() => lines.length === 1);

  // 2: qa/q1.md appears -> QUESTION
  fs.mkdirSync(join(callerDir, 'qa'), { recursive: true });
  fs.writeFileSync(join(callerDir, 'qa', 'q1.md'), 'Synthetic question?\n');
  await until(() => lines.length === 2);

  // 3: qa/q1.answer.md + report.md -> report (QUESTION cleared)
  fs.writeFileSync(join(callerDir, 'qa', 'q1.answer.md'), 'Proceed.\n');
  fs.writeFileSync(join(callerDir, 'report.md'), 'Done report.\n');
  await until(() => lines.length === 3);

  // 4: STATUS -> done
  fs.writeFileSync(join(callerDir, 'STATUS.json'), JSON.stringify({ state: 'done', exit_reason: null }));
  await until(() => lines.length === 4);

  // New job appearing already failed after startup also prints.
  writeJob(hudHome, 'j00000000000000c3', 'w4E:p1', 'pkg-c', { state: 'failed', exit_reason: 'tab closed' });
  await until(() => lines.length === 5);

  ac.abort();
  assert.equal(await running, 0);

  assert.deepEqual(lines, [
    'j00000000000000a1 imp pkg-a: waiting_orchestrator | quiet',
    'j00000000000000a1 imp pkg-a: waiting_orchestrator | quiet | QUESTION',
    'j00000000000000a1 imp pkg-a: waiting_orchestrator | quiet | report',
    'j00000000000000a1 imp pkg-a: done | report',
    'j00000000000000c3 imp pkg-c: failed | tab closed',
  ]);
  assert.equal(fs.existsSync(join(hudHome, 'display')), false);
  assert.equal(fs.existsSync(join(hudHome, 'watch.pid')), false);
  assert.equal(fs.existsSync(join(hudHome, 'watch.log')), false);
  assert.equal(fs.existsSync(join(hudHome, 'watchers', 'w4E:p1.pid')), false);
});

test('hud watch shows the signed settlement summary and ignores metadata-only writes', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-summary-'));
  const pane = 'w4E:p1', id = 'j00000000000000a1', staleId = 'j00000000000000b2';
  const dir = writeJob(home, id, pane, 'summary', { state: 'working' }, true);
  const stale = writeJob(home, staleId, pane, 'stale', { state: 'working' }, true);
  const ac = new AbortController(), lines = [];
  const original = fs.readdirSync;
  let scans = 0;
  fs.readdirSync = (path, ...args) => {
    if (path === join(home, 'jobs')) scans++;
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readdirSync = original;
    syncBuiltinESMExports();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const running = watchCommand(['--all'], {
    env: { HUD_HOME: home }, stdout: (s) => lines.push(s.trim()), stderr: () => {},
  }, { signal: ac.signal, rescanMs: 30000, settlementWindowMs: 30 });
  try {
    await until(() => scans > 0);
    const initial = scans;
    writeReportMeta(dir, cachedReportSignature(dir), { summary: '«Synthetic» work completed.' });
    await wait(180);
    assert.equal(scans, initial, 'report-meta.json writes do not rescan jobs');
    assert.deepEqual(lines, []);
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    await until(() => lines.length > 0);
    assert.deepEqual(lines, [`${id} imp summary: idle_grace | report | Synthetic work completed.`]);
    writeReportMeta(stale, cachedReportSignature(stale), { summary: 'Stale synthetic metadata.' });
    writeFixtureFile(join(stale, 'report.md'), 'Rewritten synthetic report.');
    writeFixtureFile(join(stale, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    await until(() => lines.length > 1);
    assert.deepEqual(lines.slice(1), [`${staleId} imp stale: idle_grace | report`]);
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
  await until(() => lines.length > 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /QUESTION q1/);
  fs.writeFileSync(join(dir, 'qa/q1.answer.md'), 'Answer.');
  fs.writeFileSync(join(dir, 'STATUS.json'), '{"state":"failed","exit_reason":"synthetic failure"}');
  await until(() => lines.length > 1);
  assert.match(lines[1], /failed \| synthetic failure$/m);
  assert.ok(lines.every((line) => !line.includes(' | report')));
  ac.abort();
  assert.equal(await running, 0);
});

for (const verbose of [false, true]) test(`hud watch scripted lifecycle (${verbose ? 'verbose' : 'quiet'})`, async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-life-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ac = new AbortController();
  t.after(() => ac.abort());
  const lines = [], id = 'j00000000000000a1', head = `${id} imp life:`;
  const running = watchCommand(verbose ? ['--verbose'] : [], {
    env: { HUD_HOME: home, HERDR_PANE_ID: 'w4E:p1' }, stdout: (s) => lines.push(s.trim()), stderr: () => {},
  }, { signal: ac.signal, rescanMs: 100, settlementWindowMs: 1800 });
  const dir = writeJob(home, id, 'w4E:p1', 'life', { state: 'working' });
  const status = async (state, reason) => {
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state, reason }));
    await wait(180);
  };
  await wait(180);
  fs.mkdirSync(join(dir, 'qa'));
  const qfile = join(dir, 'qa/q1.md');
  writeFixtureFile(qfile, '# Question q1 from imp@demo\n\nWhich\nlayout?\n\nOptions:\n- rows\n- columns\n\nDefault if unanswered: rows\n');
  await status('waiting_orchestrator', 'question');
  writeFixtureFile(join(dir, 'qa/q1.answer.md'), 'rows');
  await wait(180);
  await status('working');
  writeFixtureFile(join(dir, 'report.md'), 'First report');
  await status('idle_grace');
  const receipt = JSON.parse(fs.readFileSync(join(dir, 'job.json')));
  const markRead = async () => {
    writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ ...receipt, read_at: new Date().toISOString() }));
    await wait(180);
  };
  await markRead();
  await status('working');
  writeFixtureFile(join(dir, 'report.md'), 'Second report');
  await status('idle_grace');
  await markRead();
  await status('working');
  await status('idle_grace'); // A new settlement is actionable even without rewriting the already-read report.
  await status('closed');
  if (!verbose) await until(() => lines.length > 1, 6000);
  ac.abort();
  assert.equal(await running, 0);
  assert.deepEqual(lines, verbose ? [
    `${head} working`, `${head} waiting_orchestrator | question | QUESTION`,
    `${head} waiting_orchestrator | question`, `${head} working`, `${head} idle_grace | report`,
    `${head} working`, `${head} idle_grace | report`, `${head} working`, `${head} idle_grace`, `${head} closed`,
  ] : [
    `[imp@demo] QUESTION q1: Which layout? | options: rows / columns | default: rows | full text: ${qfile} | reply: hud_respond job=${id} request_id=q1`,
    `${head} idle_grace | report\n${head} idle_grace | report\n${head} idle_grace`,
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
  assert.deepEqual(writes, [`${id} imp default: done | report\n`]);
  ac.abort();
  assert.equal(await running, 0);
});

test('hud watch batches three settled jobs into one notice', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-batch-'));
  const ac = new AbortController(), writes = [], pane = 'w4E:p1';
  t.after(() => { ac.abort(); fs.rmSync(home, { recursive: true, force: true }); });
  const ids = ['j0000000000000001', 'j0000000000000002', 'j0000000000000003'];
  const dirs = ids.map((id) => writeJob(home, id, pane, 'batch', { state: 'working' }));
  const running = watchCommand([], { env: { HUD_HOME: home, HERDR_PANE_ID: pane },
    stdout: (text) => writes.push(text), stderr: () => {} }, { signal: ac.signal, rescanMs: 100, settlementWindowMs: 500 });
  for (const dir of dirs) {
    writeFixtureFile(join(dir, 'STATUS.json'), '{"state":"done"}');
    await wait(150);
    assert.deepEqual(writes, [], 'hold settlements across scans');
  }
  await until(() => writes.length > 0, 6000);
  ac.abort();
  assert.equal(await running, 0);
  assert.deepEqual(writes, [ids.map((id) => `${id} imp batch: done\n`).join('')]);
});

test('hud watch flushes a held settlement with an immediate question', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-batch-question-'));
  const ac = new AbortController(), writes = [], pane = 'w4E:p1';
  t.after(() => { ac.abort(); fs.rmSync(home, { recursive: true, force: true }); });
  const done = writeJob(home, 'j0000000000000001', pane, 'batch', { state: 'working' });
  const ask = writeJob(home, 'j0000000000000002', pane, 'batch', { state: 'working' });
  fs.mkdirSync(join(ask, 'qa'));
  const running = watchCommand([], { env: { HUD_HOME: home, HERDR_PANE_ID: pane },
    stdout: (text) => writes.push(text), stderr: () => {} }, { signal: ac.signal, rescanMs: 100, settlementWindowMs: 250 });
  writeFixtureFile(join(done, 'STATUS.json'), '{"state":"done"}');
  await wait(100);
  assert.deepEqual(writes, []);
  writeFixtureFile(join(ask, 'qa/q1.md'), 'Synthetic question?');
  await until(() => writes.length > 0, 1500);
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
  await wait(240);
  assert.equal(lines.length, 5);
  assert.equal(lines.filter((s) => s.includes('QUESTION q')).length, 2);
  assert.equal(lines.filter((s) => s.includes('idle_grace | report')).length, 1);
  assert.equal(lines.filter((s) => s.includes('failed | gone')).length, 1);
  assert.equal(lines.filter((s) => s.includes('working | input')).length, 1);
  // Answer and next question can coalesce into one scan with the same count: never lose the new id.
  fs.writeFileSync(join(question, 'qa/q1.answer.md'), 'yes');
  fs.writeFileSync(join(question, 'qa/q3.md'), '# Question q3 from imp@demo\n\nNext question?\n\nDefault if unanswered: yes\n\nContext: ' + 'x'.repeat(2200) + 'NOT IN LINE');
  await until(() => lines.length === 6);
  assert.match(lines.at(-1), /QUESTION q3: Next question\?/);
  assert.doesNotMatch(lines.at(-1), /NOT IN LINE/);
  ac.abort();
  await running;
});

test('quiet watch emits new blocks and quiet reasons but never working/resume chatter', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-attention-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = writeJob(home, 'j0000000000000001', 'w4E:p1', 'attention', { state: 'working' });
  const lines = [], ac = new AbortController();
  t.after(() => ac.abort());
  const running = watchCommand([], { env: { HUD_HOME: home, HERDR_PANE_ID: 'w4E:p1' }, stdout: (s) => lines.push(s.trim()), stderr: () => {} }, { signal: ac.signal, rescanMs: 60 });
  for (const state of [
    { state: 'working', reason: 'tool' }, { state: 'working', blocked: true, reason: 'input' },
    { state: 'working' }, { state: 'waiting_orchestrator', reason: 'quiet' },
    { state: 'waiting_orchestrator', reason: 'worker not found' }, { state: 'working' },
  ]) {
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify(state));
    await wait(150);
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

  await wait(60);
  fs.writeFileSync(join(otherDir, 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'tab closed' }));
  assert.equal(await running, 0);
  assert.deepEqual(seen, ['j00000000000000d4 imp pkg-other: failed | tab closed']);
});

test('CLI and pi question pushes use only watch while live, and fall back with missing or stale watcher PIDs', { timeout: 10000 }, async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-push-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin'), log = join(home, 'pushes');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nimport fs from 'node:fs'; if (process.argv[2] === 'agent') fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, HUD_HOME: home, HERDR_PANE_ID: 'w4E:p1', PATH: `${bin}:${process.env.PATH}` };
  const id = 'j0000000000000001';
  const dir = writeJob(home, id, 'w4E:p1', 'push', { state: 'working' });
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'ORCH=w4E:p1\n');
  const child = spawn(process.execPath, [resolve('bin/hud'), 'watch'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const pidFile = join(home, 'watchers', 'w4E:p1.pid');
  await until(() => fs.existsSync(pidFile));
  assert.equal(Number(fs.readFileSync(pidFile)), child.pid);
  const pushBoth = () => {
    const ask = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-ask.mjs'), '--dir', dir, '--question', 'Which layout?', '--default', 'rows', '--timeout', '0'], { env, encoding: 'utf8' });
    assert.equal(ask.status, 0, ask.stderr);
    const pi = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-notify.mjs'), home, 'w4E:p1', id, '[imp@demo] QUESTION q99: Which layout? | reply: write /synthetic/q99.answer.md'], { env, encoding: 'utf8' });
    assert.equal(pi.status, 0, pi.stderr);
  };
  pushBoth();
  assert.equal(fs.existsSync(log), false);
  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
  assert.equal(fs.existsSync(pidFile), false);
  for (const pid of [null, 99999999, process.pid]) {
    if (pid !== null) fs.writeFileSync(pidFile, String(pid));
    pushBoth();
  }
  const pushes = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(pushes.length, 6);
  assert.ok(pushes.every((args) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'w4E:p1'));
  assert.match(pushes[1][3], /reply: hud_respond job=j0000000000000001 request_id=q99$/);
  writeJob(home, id, 'w4E:p1', 'push', { state: 'closed' }, true, 'j0000000000000002');
  const done = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-notify.mjs'), home, 'w4E:p1', id, '[sonic@demo] DONE /synthetic/report.md'], { env, encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 6, 'opt-in child DONE is also quiet');
});

function queueFixture(t, agent = 'codex', thread = '00000000-0000-4000-8000-000000000001', fail = false) {
  const home = fs.mkdtempSync(join(tmpdir(), 'watch-queue-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin'), log = join(home, 'deliveries'), agentFile = join(home, 'agent');
  fs.mkdirSync(bin);
  fs.writeFileSync(agentFile, agent);
  const fake = `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'get') {
  console.log(JSON.stringify({ result: { pane: { agent: fs.readFileSync(${JSON.stringify(agentFile)}, 'utf8'), agent_session: { value: ${JSON.stringify(thread)} } } } }));
} else if (args[0] === 'pane' && args[1] === 'process-info') {
  console.log(JSON.stringify({ result: { process_info: { foreground_processes: [{ name: 'codex', pid: ${process.pid} }] } } }));
} else {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, home: process.env.CODEX_HOME }) + '\\n');
  if (args[0] === 'queue' && ${fail}) { console.error('no rollout found'); process.exit(1); }
}
`;
  for (const name of ['herdr', 'codex']) fs.writeFileSync(join(bin, name), fake, { mode: 0o700 });
  const env = { ...process.env, HOME: home, HUD_HOME: home, CODEX_HOME: join(home, 'wrong-account'), HERDR_PANE_ID: 'w4E:p1', PATH: `${bin}:${process.env.PATH}` };
  const deliveries = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { home, env, agentFile, deliveries };
}

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
  t.after(() => child.kill('SIGKILL'));
  await until(() => fs.existsSync(pidFile));
  const marker = fs.readFileSync(pidFile, 'utf8'), pi = JSON.parse(marker);
  assert.equal(pi.pid, child.pid);
  assert.equal(watching(pane, f.home), true);
  assert.deepEqual(notify(pane, 'Synthetic question', f.home, { env: f.env }), { status: 0, skipped: true });
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
  assert.equal(notify(pane, 'Synthetic question', f.home, { env: f.env }).status, 0);
  assert.deepEqual(f.deliveries().map((d) => d.args), [['agent', 'prompt', pane, 'Synthetic question']]);
});

for (const [label, agent, thread, fail] of [
  ['Codex queue', 'codex', '00000000-0000-4000-8000-000000000001', false],
  ['queue failure types', 'codex', '00000000-0000-4000-8000-000000000001', true],
  ['no thread types', 'codex', null, false],
  ['other agents type', 'claude', null, false],
]) test(`CLI and pi questions: ${label}`, (t) => {
  const f = queueFixture(t, agent, thread, fail), id = 'j0000000000000001';
  const dir = writeJob(f.home, id, 'w4E:p1', 'queue', { state: 'working' });
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'ORCH=w4E:p1\n');
  const ask = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-ask.mjs'), '--dir', dir, '--question', 'Which layout?', '--default', 'rows', '--timeout', '0'], { env: f.env, encoding: 'utf8' });
  assert.equal(ask.status, 0, ask.stderr);
  if (fail) assert.match(ask.stdout, /codex queue failed.*fell back to typing/);
  const pi = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-notify.mjs'), f.home, 'w4E:p1', id, '[imp@demo] QUESTION q99: Which layout? | reply: write /synthetic/q99.answer.md'], { env: f.env, encoding: 'utf8' });
  assert.equal(pi.status, 0, pi.stderr);
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
  await until(() => fs.existsSync(join(f.home, 'watchers/w4E:p1.pid')));
  writeFixtureFile(join(dir, 'report.md'), 'Done.');
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  await until(() => f.deliveries().length > 0, 6000);
  assert.deepEqual(f.deliveries().map((d) => d.args), [
    ['queue', '--thread', '00000000-0000-4000-8000-000000000001', '--message',
      'j0000000000000001 imp catchup: idle_grace | report\nj0000000000000002 imp settlement: idle_grace | report'],
  ]);
  writeFixtureFile(f.agentFile, 'claude');
  assert.equal(await running, 0);
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, []);
  assert.equal(fs.existsSync(join(f.home, 'watchers/w4E:p1.pid')), false);
});

test('hud watch --queue typed fallback keeps running and exits after injectable empty idle interval', async (t) => {
  const f = queueFixture(t, 'codex', 'synthetic-thread', true);
  const dir = writeJob(f.home, 'j0000000000000001', 'w4E:p1', 'fallback', { state: 'closed' }, true);
  const ac = new AbortController(), stdout = [], stderr = [];
  t.after(() => ac.abort());
  const running = watchCommand(['--queue'], { env: f.env, stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) }, { signal: ac.signal, rescanMs: 60, queueIdleMs: 100, settlementWindowMs: 250 });
  await until(() => f.deliveries().length === 2, 6000);
  await wait(180);
  assert.equal(fs.existsSync(join(f.home, 'watchers/w4E:p1.pid')), true, 'unread report prevents idle exit');
  const job = JSON.parse(fs.readFileSync(join(dir, 'job.json')));
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ ...job, read_at: new Date(Date.now() + 1000).toISOString() }));
  assert.equal(await running, 0);
  assert.deepEqual(f.deliveries().map((d) => d.args[0]), ['queue', 'agent']);
  assert.equal(f.deliveries()[0].args[4], f.deliveries()[1].args[3]);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join(''), /codex queue failed.*fell back to typing/);
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
  t.after(() => { Object.assign(fs, originals); syncBuiltinESMExports(); });

  const { watchCommand: freshWatch } = await import('../../dist/cli/watch.js?idle');
  const ac = new AbortController();
  t.after(() => ac.abort());
  const running = freshWatch([], { env: { HUD_HOME: hudHome, HERDR_PANE_ID: 'w4E:p1' }, stdout: () => {}, stderr: () => {} }, { rescanMs: 400, signal: ac.signal });

  // The baseline scan and the recursive watch's one-time attach may read the directory; after that, nothing.
  await wait(60);
  const lists = jobLists, stats = statusStats;
  assert.equal(stats, 1, 'one baseline read of STATUS.json');
  await wait(200);
  assert.equal(jobLists, lists, 'idle watch must not list jobs between rescans');
  assert.equal(statusStats, stats, 'idle watch must not stat STATUS.json between rescans');

  await until(() => statusStats > stats, 1000);
  assert.equal(statusStats, stats + 1, 'safety rescan reads once after rescanMs');

  ac.abort();
  assert.equal(await running, 0);
});

test('bin/hud watch flushes already-failed arrivals and exits cleanly on SIGTERM', { timeout: 10000 }, async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-bin-'));
  t.after(() => fs.rmSync(hudHome, { recursive: true, force: true }));
  writeJob(hudHome, 'j00000000000000e5', 'w4E:p1', 'baseline', { state: 'working' });

  const child = spawn(process.execPath, [resolve('bin/hud'), 'watch'], {
    env: { ...process.env, HUD_HOME: hudHome, HERDR_PANE_ID: 'w4E:p1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });

  await wait(300);
  assert.equal(stdout, '');

  writeJob(hudHome, 'j00000000000000f6', 'w4E:p1', 'tab-gone', { state: 'failed', exit_reason: 'tab closed' });
  await until(() => stdout.includes('j00000000000000f6 imp tab-gone: failed | tab closed\n'), 6000);

  child.kill('SIGTERM');
  const [code, signal] = await new Promise((resolveExit) => child.once('exit', (c, s) => resolveExit([c, s])));
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.equal(stderr, '');
});

test('hud watch on a fresh home without jobs/ hears the first job at once, not at the rescan', { timeout: 10000 }, async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-fresh-'));
  t.after(() => fs.rmSync(hudHome, { recursive: true, force: true }));
  const ac = new AbortController();
  t.after(() => ac.abort());
  const seen = [];
  const running = watchCommand(['--all'], {
    env: { HUD_HOME: hudHome },
    stdout: (text) => { seen.push(...text.trim().split('\n')); },
    stderr: () => {},
  }, { rescanMs: 30000, signal: ac.signal });
  await wait(50);
  writeJob(hudHome, 'j00000000000000f1', 'w4E:p1', 'pkg-fresh', { state: 'failed', exit_reason: 'tab closed' });
  await until(() => seen.length > 0, 3000);
  assert.match(seen[0], /^j00000000000000f1 imp pkg-fresh: failed/);
  ac.abort();
  assert.equal(await running, 0);
});
