import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { pruneLandFlows } from '../../dist/runtime/work-retention.js';
import { sonicState } from '../../dist/worker/sonic-jobs.js';
import { fixture, hour } from '../helpers/job-retention-fixture.mjs';

const now = Date.parse('2030-01-04T12:00:00Z');
const day = 24 * hour;
async function scan(f, at) {
  const run = f.start(`Date.now = () => ${at};`);
  await run.exited;
  assert.equal(run.child.exitCode, 0, run.stderr());
}

const logs = ['stdout.jsonl', 'stderr.log'];
const put = (file, text = 'Synthetic output.\n') => {
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const exists = (path) => Boolean(fs.lstatSync(path, { throwIfNoEntry: false }));

test('later scans drop only clean raw logs after the configured or default window', async (t) => {
  const f = fixture(t), ended_at = new Date(now).toISOString();
  const closed = { state: 'closed', ended_at, output_written: true };
  const sonic = f.job({ ...closed, stdout_bytes: 18, stderr_bytes: 18 }, { headless: true });
  const worker = f.job(closed, { resume_s: 60, reaped_at: ended_at }, true);
  const done = f.job({ state: 'done', ended_at }, { resume_s: 60 });
  const linked = f.job(closed, { resume_s: 60 });
  const failed = f.job({ state: 'failed', ended_at, exit_reason: 'synthetic failure' }, { headless: true });
  const stopped = f.job({ state: 'stopped', ended_at }, { resume_s: 60 });
  const quiet = f.job({ ...closed, output_written: false }, { resume_s: 0 });
  const missingReport = f.job(closed, { resume_s: 0 });
  fs.unlinkSync(join(missingReport, 'report.md'));
  fs.unlinkSync(join(done, 'report.md'));
  const dirs = [sonic, worker, done, linked, failed, stopped, quiet, missingReport];
  for (const dir of dirs) for (const name of logs) put(join(dir, name));
  const target = put(join(f.home, 'unrelated.log'));
  fs.unlinkSync(join(linked, logs[1]));
  fs.symlinkSync(target, join(linked, logs[1]));
  const check = (dir, stdout, stderr = stdout) => {
    assert.deepEqual(logs.map((name) => exists(join(dir, name))), [stdout, stderr], dir);
  };

  await scan(f, now + 59_999);
  for (const dir of dirs) check(dir, true);
  await scan(f, now + 60_000);
  check(worker, false);
  check(done, false);
  check(linked, false, true);
  check(sonic, true);
  await scan(f, now + 1_620_000);
  check(sonic, false);
  for (const dir of [failed, stopped, quiet, missingReport]) check(dir, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Synthetic output.\n');
  assert.equal(fs.readFileSync(join(sonic, 'report.md'), 'utf8'), 'Synthetic report.');
  assert.deepEqual(sonicState(sonic), { state: 'settled' });
  assert.deepEqual(sonicState(failed), { state: 'failed', reason: 'synthetic failure' });

  await scan(f, now + day + 1);
  const archive = fs.readFileSync(join(f.home, 'archive', '2030-01.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const dir of [sonic, worker, failed, stopped]) {
    assert.ok(!exists(dir));
    assert.ok(archive.some((row) => row.job === basename(dir)), dir);
  }
});

test('expired ticket queues archive only structured facts before unlinking and never append twice', (t) => {
  const { home } = fixture(t);
  const flow = 'q0000000000000001', worker = 'j0000000000000001';
  const created_at = '2029-12-30T00:00:00.000Z', updated_at = '2029-12-31T00:00:00.000Z';
  const project = join(home, 'synthetic-project'), feature = 'sample', state = 'completed';
  const tickets = [
    { ticket: 'sample/01', role: 'imp', job: worker, land: 'f0000000000000001', landed: true, round: 0 },
    { ticket: 'sample/02', role: 'imp', job: 'j0000000000000004', land: 'f0000000000000004', landed: true, round: 1, repairs: ['sample/01'] },
  ];
  const decisions = [{ step: 'tickets', kind: 'assumption', job: 'j0000000000000002', decision: 'continue',
    at: created_at, ticket: 'sample/01', worker_job: worker }];
  const reviews = [{ round: 0, job: 'j0000000000000003', findings: { blocker: 0, major: 1, minor: 2 },
    reviewed: { base: 'a'.repeat(40), head: 'b'.repeat(40) } }];
  const secret = 'Synthetic prose must not be archived';
  const receipt = put(join(home, 'flows', `${flow}.json`), JSON.stringify({
    flow, root: join(project, 'subdir'), project_root: project, feature, state, created_at, updated_at,
    reason: secret, verdict: secret, todo: [{ text: secret }],
    tickets: tickets.map(item => ({ ...item, path: secret, failed: { reason: secret } })),
    decisions: decisions.map(item => ({ ...item, reason: secret, close_error: secret })),
    reviews: reviews.map(item => ({ ...item, summary: secret, reviewed: { ...item.reviewed, summary: secret } })),
  }));
  fs.utimesSync(receipt, new Date(updated_at), new Date(updated_at));
  const marker = `${receipt}.archived`;
  const otherEvent = { v: 1, kind: 'objective' };
  const other = put(join(home, 'other.jsonl'), JSON.stringify(otherEvent) + '\n');
  const archive = join(home, 'events', '2029-12.jsonl');
  fs.mkdirSync(dirname(archive));
  fs.symlinkSync(other, archive);
  pruneLandFlows(home, now);
  assert.ok(exists(receipt), 'an append failure must keep the receipt');
  assert.ok(!exists(marker), 'a known no-write failure permits a retry');
  assert.equal(fs.readFileSync(other, 'utf8'), JSON.stringify(otherEvent) + '\n');
  fs.unlinkSync(archive);
  put(archive, JSON.stringify(otherEvent) + '\n');
  fs.chmodSync(archive, 0o644);

  const readEvents = () => fs.readFileSync(archive, 'utf8').trimEnd().split('\n').map(JSON.parse);
  const expected = [otherEvent, { v: 1, kind: 'ticket_queue', flow, project, feature, state, created_at,
    updated_at, repair_rounds: 0, tickets, decisions, reviews }];
  let eventsBeforeUnlink;
  const unlink = fs.unlinkSync;
  const mock = t.mock.method(fs, 'unlinkSync', path => {
    if (basename(path) !== basename(receipt)) return unlink(path);
    eventsBeforeUnlink = readEvents();
    throw Object.assign(new Error('Synthetic unlink failure'), { code: 'EACCES' });
  });
  syncBuiltinESMExports();
  try {
    pruneLandFlows(home, now);
    assert.ok(exists(receipt));
    assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
    assert.equal(fs.statSync(archive).mode & 0o777, 0o600);
    assert.deepEqual(eventsBeforeUnlink, expected);
    pruneLandFlows(home, now);
    assert.deepEqual(readEvents(), expected);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  pruneLandFlows(home, now);
  assert.ok(!exists(receipt));
  assert.ok(!exists(marker));
  assert.deepEqual(readEvents(), expected);
});

test('scratch retention only prunes old top-level entries under registered, non-symlinked paths', async (t) => {
  const f = fixture(t), project = join(f.home, 'repo'), outside = `${project}-other`;
  const scratch = join(project, 'tmp', 'tasks'), tuned = join(f.home, 'tuned');
  const age = (path, days) => {
    fs.utimesSync(path, (now - days * day) / 1000, (now - days * day) / 1000);
    return path;
  };
  const old = (file) => age(put(file), 8);
  const policy = (root, paths, extra = {}) => put(join(root, '.hud/project.json'), JSON.stringify({ scratch: { paths, ...extra } }));
  const escaped = old(join(outside, 'tasks/escaped'));
  const rootSentinel = old(join(project, 'root-sentinel'));
  const keepProject = old(join(project, 'other/nested/keep'));
  const linkedRoot = join(f.home, 'linked-root');
  fs.symlinkSync(outside, linkedRoot);
  fs.symlinkSync(outside, join(project, 'linked-out'));
  fs.symlinkSync(join(project, 'other'), join(project, 'linked-in'));
  policy(outside, ['tasks'], { keep_days: 1 });
  policy(tuned, [join(tuned, 'tasks')], { keep_days: 1 });
  policy(project, ['tmp/tasks', '.', '../repo-other/tasks', join(outside, 'tasks'),
    'linked-out/tasks', 'linked-in/nested', 'linked-out/../other/nested']);
  const tunedOld = age(put(join(tuned, 'tasks/outdated')), 2);
  const stale = old(join(scratch, 'stale'));
  const staleTree = join(scratch, 'stale-tree');
  old(join(staleTree, 'nested/old-file'));
  const nestedLink = join(staleTree, 'link');
  fs.symlinkSync(escaped, nestedLink);
  fs.lutimesSync(nestedLink, (now - 8 * day) / 1000, (now - 8 * day) / 1000);
  const newer = age(put(join(scratch, 'mixed/nested/new')), 1);
  const mixedOld = old(join(scratch, 'mixed/old'));
  const boundary = age(put(join(scratch, 'boundary')), 7);
  put(join(f.home, 'projects.json'), JSON.stringify({ version: 1, projects: [project, linkedRoot, tuned].map((root) => ({ root })) }));

  await scan(f, now);
  for (const path of [stale, staleTree, tunedOld]) assert.ok(!exists(path), path);
  for (const path of [escaped, rootSentinel, keepProject, newer, mixedOld, boundary]) assert.ok(exists(path), path);
  assert.match(f.log(), /pruned project scratch entries: 3\n/);
  assert.equal(fs.statSync(join(f.home, 'scratch-pruned')).mode & 0o777, 0o600);

  // An entirely new watcher still respects the hourly floor.
  await scan(f, now + hour - 1);
  assert.ok(exists(boundary));
  assert.equal(f.log().match(/pruned project scratch entries:/g).length, 1);
  await scan(f, now + hour);
  assert.ok(!exists(boundary));
  assert.match(f.log(), /pruned project scratch entries: 1\n/);
});
