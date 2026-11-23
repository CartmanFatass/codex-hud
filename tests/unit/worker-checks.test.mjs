import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readReportMeta } from '../../dist/roles/report-meta.js';
import { procStat } from '../../dist/utils/proc.js';
import { runWorkerChecks } from '../../dist/worker/checks.js';
import { git, initRepo } from '../fixtures/managed-worktree.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { fixture, cliToken, resultValue, runProgress, until, waitFixtureJob, workerClient } from '../helpers/thin-mcp-harness.mjs';

async function setup(t, { role = 'imp', committed = true, registered = true } = {}) {
  const f = await fixture(t), main_root = initRepo(f.root);
  const root = join(f.root, 'demo-wt', 'synthetic-000001'), branch = 'wt/synthetic-000001';
  const base_head = git(main_root, 'rev-parse', 'HEAD');
  git(main_root, 'worktree', 'add', '-qb', branch, root);
  if (committed) git(root, 'commit', '--allow-empty', '-qm', 'Synthetic worker commit');
  if (registered) writeFixtureFile(join(f.env.HUD_HOME, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: main_root }] }));
  const worktree = { root, branch, main_root, base_head };
  const { job, dir, receipt, status } = waitFixtureJob(f, 1, 'working', undefined, root);
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ ...receipt, cli: true, role, worktree }));
  writeFixtureFile(join(dir, 'turn.json'), JSON.stringify({ seq: 1, sent_at: receipt.created_at }));
  fs.mkdirSync(join(main_root, '.hud'));
  const configure = (commands, land) => writeFixtureFile(join(main_root, '.hud', 'project.json'), JSON.stringify({ worker_checks: { [role]: commands }, land }));
  return { f, job, dir, status, worktree, configure, turn: cliToken(dir), root, main_root,
    report: join(dir, 'report.md'), done: join(dir, 'done.json'), marker: join(root, 'ignored.txt') };
}

function toolError(result) {
  assert.equal(result.isError, true);
  return JSON.parse(result.content[0].text).error;
}

const text = 'Synthetic implementation report.\n';

test('red worker checks refuse without publishing; a fixed commit passes the same report turn', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(join(s.main_root, 'wrapper'), '#!/bin/sh\ntest -z "$HUD_JOB_DIR" || exit 88\necho wrapped >> ignored.txt\nexec "$@"\n', { mode: 0o700 });
  s.configure([
    "grep -q fixed tracked.txt || { echo 'Discarded opening line'; head -c 4096 /dev/zero | tr '\\000' X; echo 'Synthetic error at the end'; exit 17; } >&2",
    'echo second >> ignored.txt',
  ], { wrapper: 'wrapper' });
  const call = workerClient(t, s.f, s.dir);
  const submit = () => call('hud_report', { text, turn: s.turn });
  const error = toolError(await submit());
  assert.match(error, /failed \(exit 17\)/);
  const tail = error.split('Output tail:\n')[1];
  assert.match(tail, /Synthetic error at the end$/);
  assert.doesNotMatch(tail, /Discarded opening line/);
  assert.ok(Buffer.byteLength(tail) <= 2048);
  assert.equal(fs.existsSync(s.report), false);
  assert.equal(fs.existsSync(s.done), false);
  assert.equal(fs.readFileSync(s.marker, 'utf8'), 'wrapped\n');
  assert.equal(fs.existsSync(join(s.main_root, 'ignored.txt')), false);
  assert.match(toolError(await submit()), /failed \(exit 17\)/, 'retry without a fix does not bypass checks');

  fs.writeFileSync(join(s.root, 'tracked.txt'), 'fixed\n');
  git(s.root, 'commit', '-qam', 'Fix the synthetic check');
  assert.deepEqual(resultValue(await submit()), { path: s.report });
  assert.equal(JSON.parse(fs.readFileSync(s.done, 'utf8')).seq, 1);
  assert.equal(fs.readFileSync(s.report, 'utf8'), text);
  assert.equal(fs.readFileSync(s.marker, 'utf8'), 'wrapped\nwrapped\nwrapped\nwrapped\nsecond\n');
});

test('a nonblank skip reason bypasses checks and is signature-bound in the report digest', async (t) => {
  const s = await setup(t, { role: 'frontend-imp' });
  s.configure(['touch ignored.txt; exit 17']);
  const call = workerClient(t, s.f, s.dir);
  const submit = (skip_checks_reason) => call('hud_report', { text, turn: s.turn, skip_checks_reason });
  assert.match(toolError(await submit('  \n ')), /invalid_arguments: skip_checks_reason/);
  assert.deepEqual(resultValue(await submit('Synthetic fixture\n is unavailable.')), { path: s.report });
  assert.equal(fs.existsSync(s.marker), false);
  assert.equal(readReportMeta(s.dir)?.skip_checks_reason, 'Synthetic fixture is unavailable.');
  s.status('closed');
  const digest = (await s.f.call('hud_read', { job: s.job })).digest;
  assert.equal(digest.skip_checks_reason, 'Synthetic fixture is unavailable.');
  assert.equal(digest.result, text.trim());
  writeFixtureFile(s.report, 'Rewritten synthetic report.\n');
  assert.equal(readReportMeta(s.dir), null);
});

test('the report fallback can skip a failed check with a reason', async (t) => {
  const s = await setup(t);
  s.configure(['echo "Synthetic failure" >&2; exit 17']);
  writeFixtureFile(s.report, text);
  const red = runProgress(s.f, s.dir, '--done', '--turn', s.turn);
  assert.equal(red.status, 1);
  assert.match(red.stderr, /Output tail:\nSynthetic failure/);
  assert.equal(fs.existsSync(s.done), false);
  const skip = runProgress(s.f, s.dir, '--done', '--turn', s.turn, '--skip-checks-reason', 'Synthetic blocker.');
  assert.equal(skip.status, 0, skip.stderr);
  assert.equal(readReportMeta(s.dir)?.skip_checks_reason, 'Synthetic blocker.');
});

for (const [label, options] of [
  ['a worktree without new commits', { committed: false }],
  ['a read-only worker', { role: 'reviewer' }],
  ['an unregistered project', { registered: false }],
]) {
  test(`worker checks skip ${label}`, async (t) => {
    const s = await setup(t, options);
    s.configure(['touch ignored.txt; exit 17']);
    const result = await workerClient(t, s.f, s.dir)('hud_report', { text, turn: s.turn });
    assert.deepEqual(resultValue(result), { path: s.report });
    assert.equal(fs.existsSync(s.marker), false);
  });
}

test('worker checks share a 60-second deadline and timeouts kill the command process group', { timeout: 15_000 }, async (t) => {
  const s = await setup(t);
  s.configure(['true', 'sleep 600 & echo "$!" > ignored.txt; wait']);
  const schedule = globalThis.setTimeout, delays = [];
  let now = 100, expire;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms !== 60_000 && ms !== 35_000) return schedule(fn, ms, ...args);
    delays.push(ms);
    now += 25_000;
    expire = () => fn(...args);
    return schedule(fn, 5000, ...args); // Safety net if the child fails to start.
  });
  const rejected = assert.rejects(runWorkerChecks(s.f.env.HUD_HOME, 'imp', s.worktree), /timed out \(60 s total limit\)/);
  await until(() => fs.existsSync(s.marker) && fs.readFileSync(s.marker, 'utf8').trim(), t.signal);
  const pid = Number(fs.readFileSync(s.marker, 'utf8'));
  assert.ok(procStat(pid), 'the child started before the deadline');
  assert.deepEqual(delays, [60_000, 35_000]);
  expire();
  await rejected;
  await until(() => !procStat(pid) || procStat(pid).state === 'Z', t.signal);
});
