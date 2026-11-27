import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import {
  collectAndRecordLandFlakes, collectGateFlakes, flakeDispatchKey, retryPendingFlakeCollections, settleAutoLandFlakeJob,
} from '../../dist/mcp/land-flakes.js';
import { runningListAdmission } from '../../dist/mcp/flake-admission.js';
import { procStat } from '../../dist/utils/proc.js';
import { startSessionWatch } from '../../dist/cli/watch.js';
import { installTabLifecycle } from '../../dist/harness/pi/worker/tab-lifecycle.js';
import { landNotice } from '../../dist/mcp/land-state.js';
import { ensureJobWatcher } from '../../dist/mcp/watch-pid.js';
import { workflowEvents } from '../../dist/workflows/events.js';
import { clearExhausted, markExhausted } from '../../dist/roles/exhausted.js';
import { JOB_RETENTION_MS, pruneLandFlows } from '../../dist/runtime/work-retention.js';
import { runUnattendedScanStep } from '../../dist/unattended/service.js';
import { controlPath } from '../../dist/unattended/state.js';
import { publishQuestion } from '../../dist/worker/qa.js';
import { cleanupFixture } from '../helpers/process-cleanup.mjs';
import { until } from '../helpers/thin-mcp-harness.mjs';
import { checkout, seedJsonTickets } from '../helpers/thin-mcp-land.mjs';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function setFlakesConfig(f, flakes) {
  const file = join(f.main, '.hud', 'project.json');
  const cfg = readJson(file);
  if (flakes === undefined) delete cfg.flakes;
  else cfg.flakes = flakes;
  fs.writeFileSync(file, JSON.stringify(cfg));
  f.git(f.main, 'add', '.hud/project.json');
  f.git(f.main, 'commit', '-qm', 'configure flakes');
  f.git(f.main, 'push', '-q', 'origin', 'base');
}

function addFlakyTestJob(f, { id, testFile, testName, markerName }) {
  const base = f.git(f.main, 'rev-parse', 'HEAD');
  const wtName = `imp-${id.slice(-6)}`;
  const wtRoot = join(`${f.main}-wt`, wtName);
  const branch = `wt/${wtName}`;
  f.git(f.main, 'worktree', 'add', '-qb', branch, wtRoot, base);
  fs.mkdirSync(join(wtRoot, 'sample'), { recursive: true });
  fs.writeFileSync(join(wtRoot, 'package.json'), JSON.stringify({
    scripts: { 'test:sample': 'node --test -- sample/*.test.mjs' },
  }));
  fs.writeFileSync(join(wtRoot, 'sample', testFile), `
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
const marker = join(process.env.HOME, ${JSON.stringify(markerName)});
const seen = existsSync(marker);
writeFileSync(marker, 'ran\\n');
test(${JSON.stringify(testName)}, () => assert.ok(seen, 'synthetic flake: ' + ${JSON.stringify(testName)}));
`);
  f.git(wtRoot, 'add', 'package.json', 'sample');
  f.git(wtRoot, 'commit', '-qm', `add ${testFile}`);
  const dir = join(f.home, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
    job: id,
    cwd: wtRoot,
    project_root: f.main,
    role: 'imp',
    herdr_pane: f.env.HERDR_PANE_ID,
    created_at: now,
    dispatch_exit_code: 0,
    worktree: { main_root: f.main, root: wtRoot, base_head: base, branch },
  }));
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: now }));
  return { id, wtRoot };
}

function listFlakeJobs(f, feature = 'test-flakes') {
  const root = join(f.home, 'jobs');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap(id => {
    const file = join(root, id, 'job.json');
    if (!fs.existsSync(file)) return [];
    const receipt = readJson(file);
    return typeof receipt.ticket === 'string' && receipt.ticket.startsWith(`${feature}/`) ? [receipt] : [];
  });
}

function readFlakeDoc(f, feature = 'test-flakes') {
  const file = join(f.main, '.hud', 'tickets', `${feature}.json`);
  return fs.existsSync(file) ? readJson(file) : null;
}

function listFlakeRecords(f, feature = 'test-flakes') {
  return readFlakeDoc(f, feature)?.tickets ?? [];
}

function listTickets(f, feature = 'test-flakes') {
  const dir = join(f.main, '.scratch', feature, 'issues');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^\d+-.+\.md$/.test(name)).sort().map(name => ({
    name,
    path: join(dir, name),
    rel: relative(f.main, join(dir, name)),
    text: fs.readFileSync(join(dir, name), 'utf8'),
  }));
}

test('absent flakes config does nothing when a land gate passes on immediate rerun', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['npm run test:sample'], { after: [] });
  const jobId = 'j0000000000000201';
  addFlakyTestJob(f, {
    id: jobId,
    branchName: 'absent-cfg',
    testFile: 'alpha.test.mjs',
    testName: 'alpha recovers once',
    markerName: 'absent-alpha',
  });
  const { flow } = await f.call('hud_land', { job: jobId });
  await until(() => f.flowState(flow).state === 'completed', t.signal);
  assert.equal(f.flowState(flow).reruns?.length, 1);
  assert.equal(f.flowState(flow).reruns[0].rerun_ok, true);
  assert.equal(fs.existsSync(join(f.main, '.scratch')), false);
  assert.equal(fs.existsSync(join(f.main, '.hud', 'tickets')), false);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.flowState(flow).landed_sha);
  assert.deepEqual(listFlakeJobs(f), []);
});

test('rerun-pass gate appends one JSON flake-list entry, repeat dispatches one imp job, and next flake opens a new ticket', { timeout: 45_000 }, async t => {
  const f = await checkout(t, ['npm run test:sample'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });

  // First rerun-pass gate: creates JSON running-list ticket 01 (kind: flake-list, needs-triage), no separate tickets commit, no dispatch.
  const job1 = 'j0000000000000301';
  addFlakyTestJob(f, {
    id: job1,
    branchName: 'flake-1',
    testFile: 'alpha.test.mjs',
    testName: 'alpha recovers',
    markerName: 'repeat-alpha-1',
  });
  const { flow: flow1 } = await f.call('hud_land', { job: job1 });
  await until(() => f.flowState(flow1).state === 'completed' && f.flowState(flow1).flake_collection?.state === 'done', t.signal);

  const [t1] = listFlakeRecords(f);
  const log1 = f.flowState(flow1).reruns[0].output_path;
  assert.equal(t1.number, 1);
  assert.equal(t1.kind, 'flake-list');
  assert.equal(t1.status, 'needs-triage');
  assert.equal(t1.cases.length, 1);
  assert.equal(t1.cases[0].case_name, 'alpha recovers');
  assert.equal(t1.cases[0].test, 'sample/alpha.test.mjs');
  assert.equal(t1.cases[0].flow, flow1);
  assert.equal(t1.cases[0].log, log1);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.flowState(flow1).landed_sha, 'no separate tickets commit');
  assert.deepEqual(listFlakeJobs(f), []);

  // Second rerun-pass gate with the SAME test: appends repeat, promotes to ready-for-agent, dispatches ONE imp job.
  const job2 = 'j0000000000000302';
  addFlakyTestJob(f, {
    id: job2,
    branchName: 'flake-2',
    testFile: 'alpha.test.mjs',
    testName: 'alpha recovers',
    markerName: 'repeat-alpha-2',
  });
  const { flow: flow2 } = await f.call('hud_land', { job: job2 });
  await until(() => f.flowState(flow2).state === 'completed' &&
    listFlakeJobs(f).some(j => j.ticket === 'test-flakes/01' && j.worktree?.root && fs.existsSync(join(f.home, 'jobs', j.job, 'brief.md'))), t.signal);

  const [t1After] = listFlakeRecords(f);
  const log2 = f.flowState(flow2).reruns[0].output_path;
  assert.equal(t1After.status, 'ready-for-agent');
  assert.equal(t1After.cases.length, 2);
  assert.equal(t1After.cases[0].flow, flow1);
  assert.equal(t1After.cases[1].flow, flow2);
  assert.equal(t1After.cases[1].log, log2);
  const [dispatched] = listFlakeJobs(f);
  assert.equal(dispatched.role, 'imp');
  assert.equal(dispatched.ticket, 'test-flakes/01');
  assert.ok(dispatched.worktree?.root, 'dispatched in a managed worktree');
  const brief = fs.readFileSync(join(f.home, 'jobs', dispatched.job, 'brief.md'), 'utf8');
  assert.ok(brief.includes('alpha recovers'), brief);

  // Third rerun-pass gate while ticket 01 is claimed by the live job: opens a NEW JSON running-list ticket 02.
  const job3 = 'j0000000000000303';
  addFlakyTestJob(f, {
    id: job3,
    branchName: 'flake-3',
    testFile: 'beta.test.mjs',
    testName: 'beta recovers',
    markerName: 'repeat-beta-3',
  });
  const { flow: flow3 } = await f.call('hud_land', { job: job3 });
  await until(() => f.flowState(flow3).state === 'completed' && f.flowState(flow3).flake_collection?.state === 'done', t.signal);

  const [, t2] = listFlakeRecords(f);
  assert.equal(t2.number, 2);
  assert.equal(t2.kind, 'flake-list');
  assert.equal(t2.status, 'needs-triage');
  assert.equal(t2.cases[0].case_name, 'beta recovers');
  assert.equal(t2.cases[0].test, 'sample/beta.test.mjs');
  assert.equal(listFlakeJobs(f).length, 1, 'still only one flake job dispatched');
});

test('fourth distinct case dispatches one job, enforces one-at-a-time, and dispatches waiting ticket after first lands', { timeout: 30_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });

  const dispatches = [];
  const fakeDispatch = async (input, pane) => {
    const id = `j000000000000040${dispatches.length + 1}`;
    const wtName = `imp-${id.slice(-6)}`;
    const wtRoot = join(`${f.main}-wt`, wtName);
    const branch = `wt/${wtName}`;
    const base = f.git(f.main, 'rev-parse', 'HEAD');
    f.git(f.main, 'worktree', 'add', '-qb', branch, wtRoot, base);
    fs.appendFileSync(join(wtRoot, 'tracked'), `fix ${input.ticket}\n`);
    f.git(wtRoot, 'commit', '-qam', `fix ${input.ticket}`);
    const dir = join(f.home, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
      job: id,
      cwd: wtRoot,
      project_root: f.main,
      role: input.role,
      ticket: input.ticket,
      request_key: input.request_key,
      herdr_pane: pane ?? f.env.HERDR_PANE_ID,
      created_at: new Date().toISOString(),
      dispatch_exit_code: 0,
      worktree: { main_root: f.main, root: wtRoot, base_head: base, branch },
    }));
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
    dispatches.push({ id, input, pane });
    return { job: id };
  };

  for (let i = 1; i <= 3; i++) {
    const r = await collectGateFlakes(f.home, f.main, [{
      name: `case ${i}`,
      file: `tests/unit/case-${i}.test.mjs`,
      flow: `f000000000000040${i}`,
      log: join(f.home, 'flows', `f000000000000040${i}.json.gate-1.log`),
    }], f.env.HERDR_PANE_ID, { dispatch: fakeDispatch });
    assert.equal(r.promoted, false);
    assert.equal(r.dispatchedJob, undefined);
  }
  assert.equal(dispatches.length, 0);
  assert.equal(listFlakeRecords(f)[0].status, 'needs-triage');

  // 4th distinct case promotes ticket 01 and dispatches one imp job.
  const r4 = await collectGateFlakes(f.home, f.main, [{
    name: 'case 4',
    file: 'tests/unit/case-4.test.mjs',
    flow: 'f0000000000000404',
    log: join(f.home, 'flows', 'f0000000000000404.json.gate-1.log'),
  }], f.env.HERDR_PANE_ID, { dispatch: fakeDispatch });
  assert.equal(r4.promoted, true);
  assert.equal(r4.dispatchedJob, 'j0000000000000401');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].input.ticket, 'test-flakes/01');
  assert.equal(listFlakeRecords(f)[0].status, 'ready-for-agent');

  // While job 1 is still active, a new repeat creates and promotes ticket 02, but does NOT dispatch a 2nd concurrent job.
  await collectGateFlakes(f.home, f.main, [{
    name: 'case 5',
    file: 'tests/unit/case-5.test.mjs',
    flow: 'f0000000000000405',
    log: join(f.home, 'flows', 'f0000000000000405.json.gate-1.log'),
  }], f.env.HERDR_PANE_ID, { dispatch: fakeDispatch });
  const r6 = await collectGateFlakes(f.home, f.main, [{
    name: 'case 5',
    file: 'tests/unit/case-5.test.mjs',
    flow: 'f0000000000000406',
    log: join(f.home, 'flows', 'f0000000000000406.json.gate-1.log'),
  }], f.env.HERDR_PANE_ID, { dispatch: fakeDispatch });
  assert.equal(r6.ticket, 'test-flakes/02');
  assert.equal(r6.promoted, true);
  assert.equal(r6.dispatchedJob, undefined, 'one flake imp job at a time');
  assert.equal(dispatches.length, 1);
  assert.equal(listFlakeRecords(f)[1].status, 'ready-for-agent');

  // Once job 1 finishes and lands via hud_land, ticket 01 becomes done and ticket 02 dispatches automatically.
  fs.writeFileSync(join(f.home, 'jobs', 'j0000000000000401', 'STATUS.json'),
    JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  const { flow: landFix1 } = await f.call('hud_land', { job: 'j0000000000000401' });
  await until(() => f.flowState(landFix1).state === 'completed' &&
    listFlakeJobs(f).some(j => j.ticket === 'test-flakes/02' && j.worktree?.root), t.signal);
  assert.equal(listFlakeRecords(f)[0].status, 'done');
  const jobFor02 = listFlakeJobs(f).find(j => j.ticket === 'test-flakes/02');
  assert.equal(jobFor02.role, 'imp');
});

test('flake collection runs after land completes and writes JSON store without taking the main-checkout lease', { timeout: 30_000 }, async t => {
  // Part A: land holds main-checkout during gate[2] after gate[1] passed on immediate rerun.
  const f = await checkout(t, [
    'npm run test:sample',
    'touch "$HOME/gate2-started"; while test ! -f "$HOME/release-gate2"; do sleep .05; done',
  ], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });
  const jobId = 'j0000000000000501';
  addFlakyTestJob(f, {
    id: jobId,
    branchName: 'lease-land',
    testFile: 'gamma.test.mjs',
    testName: 'gamma recovers',
    markerName: 'lease-gamma',
  });

  const { flow } = await f.call('hud_land', { job: jobId });
  await until(() => fs.existsSync(join(f.env.HOME, 'gate2-started')), t.signal);
  // gate[1] already passed on immediate rerun, while land still holds main-checkout in gate[2].
  assert.equal(f.flowState(flow).reruns?.[0]?.rerun_ok, true);
  assert.equal(listFlakeRecords(f).length, 0, 'must not edit flake ticket while land is still running');

  fs.writeFileSync(join(f.env.HOME, 'release-gate2'), '');
  await until(() => f.flowState(flow).state === 'completed' && f.flowState(flow).flake_collection?.state === 'done', t.signal);
  assert.equal(listFlakeRecords(f).length, 1);

  // Part B: another caller holds main-checkout lease while collectGateFlakes writes to the JSON store without waiting or committing.
  const granted = await f.call('hud_lease', { name: 'main-checkout', wait_s: 2 });
  assert.equal(granted.granted, true);
  const headBefore = f.git(f.main, 'rev-parse', 'HEAD');
  try {
    const res = await collectGateFlakes(f.home, f.main, [{
      name: 'delta recovers',
      file: 'sample/delta.test.mjs',
      flow: 'f0000000000000502',
      log: join(f.home, 'flows', 'f0000000000000502.json.gate-1.log'),
    }], f.env.HERDR_PANE_ID);
    assert.equal(res.ticket, 'test-flakes/01');
    assert.ok(listFlakeRecords(f)[0].cases.some(c => c.case_name === 'delta recovers'));
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), headBefore, 'JSON flake edit makes no git commit');
  } finally {
    await f.call('hud_lease', { name: 'main-checkout', release: true });
  }
});

test('creates a new running-list ticket when newest is done or claimed, and appends to open JSON running lists', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });

  const at = '2026-01-01T00:00:00.000Z';
  const rel = seedJsonTickets(f, 'test-flakes', [
    { number: 1, title: 'Gate flakes running list', kind: 'flake-list', status: 'done', what: 'Running list.' },
    { number: 2, title: 'Gate flakes collected after test-flakes/01', kind: 'flake-list', status: 'claimed', what: 'Running list.' },
  ]);
  f.git(f.main, 'add', rel);
  f.git(f.main, 'commit', '-qm', 'seed flake tickets');

  const r1 = await collectGateFlakes(f.home, f.main, [{
    name: 'epsilon recovers',
    file: 'tests/unit/epsilon.test.mjs',
    flow: 'f0000000000000601',
    log: join(f.home, 'flows', 'f0000000000000601.json.gate-1.log'),
  }], null);
  assert.equal(r1.created, true);
  assert.equal(r1.ticket, 'test-flakes/03');
  assert.equal(listFlakeRecords(f)[2].title, 'Gate flakes collected after test-flakes/02');

  // Seed a newer open running-list ticket (04) with 3 existing cases so the 4th promotes it.
  const doc = readFlakeDoc(f);
  doc.tickets.push({
    number: 4, title: 'Gate flakes collected after test-flakes/03', kind: 'flake-list', status: 'needs-triage',
    owner_try: false, live_try: 'none', approved_removals: [], blocked_by: [], what: 'Running list.',
    cases: [
      { step: 'gate[1]', test: 'tests/unit/one.test.mjs', case_name: 'legacy one', flow: 'f1111111111111111', recorded_at: at },
      { step: 'gate[1]', test: 'tests/unit/two.test.mjs', case_name: 'legacy two', flow: 'f2222222222222222', recorded_at: at },
      { step: 'gate[1]', test: 'tests/unit/three.test.mjs', case_name: 'legacy three', flow: 'f2222222222222222', recorded_at: at },
    ],
    acceptance: [{ id: 1, text: 'Each listed case passes 20 consecutive runs', done: false }],
    comments: [], created_at: at, updated_at: at,
  });
  fs.writeFileSync(join(f.main, rel), JSON.stringify(doc, null, 2) + '\n');
  f.git(f.main, 'add', rel);
  f.git(f.main, 'commit', '-qm', 'seed open running list');

  const dispatched = [];
  const r2 = await collectGateFlakes(f.home, f.main, [{
    name: 'legacy four',
    file: 'tests/unit/four.test.mjs',
    flow: 'f0000000000000602',
    log: join(f.home, 'flows', 'f0000000000000602.json.gate-1.log'),
  }], null, {
    dispatch: async (input) => { dispatched.push(input); return { job: 'j0000000000000699' }; },
  });
  assert.equal(r2.created, false);
  assert.equal(r2.ticket, 'test-flakes/04');
  assert.equal(r2.promoted, true);
  assert.equal(r2.dispatchedJob, 'j0000000000000699');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].ticket, 'test-flakes/04');
  const ticket04 = listFlakeRecords(f).find(item => item.number === 4);
  assert.equal(ticket04.status, 'ready-for-agent');
  assert.ok(ticket04.cases.some(c => c.case_name === 'legacy four' && c.test === 'tests/unit/four.test.mjs'));
});

test('promoted running-list ticket dispatches one imp with shipped settings (auto-prewalk on), from a pane and pane-less', { timeout: 60_000 }, async t => {
  for (const inHerdr of [true, false]) {
    const f = await checkout(t, ['npm run test:sample'], { after: [], inHerdr, autoPrewalk: true });
    assert.equal(fs.existsSync(f.env.HUD_SETTINGS_PATH), false, 'shipped defaults must leave autoPrewalk on');
    assert.equal(Boolean(f.env.HERDR_PANE_ID), inHerdr);
    setFlakesConfig(f, { feature: 'test-flakes' });

    const job1 = inHerdr ? 'j0000000000000701' : 'j0000000000000711';
    addFlakyTestJob(f, {
      id: job1,
      testFile: 'shipped.test.mjs',
      testName: 'shipped flake recovers',
      markerName: `shipped-1-${inHerdr}`,
    });
    const { flow: flow1 } = await f.call('hud_land', { job: job1 });
    await until(() => f.flowState(flow1).state === 'completed' &&
      f.flowState(flow1).flake_collection?.state === 'done', t.signal);
    assert.equal(f.flowState(flow1).pane, inHerdr ? 'w4E:p1' : null);
    assert.deepEqual(listFlakeJobs(f), []);

    const job2 = inHerdr ? 'j0000000000000702' : 'j0000000000000712';
    addFlakyTestJob(f, {
      id: job2,
      testFile: 'shipped.test.mjs',
      testName: 'shipped flake recovers',
      markerName: `shipped-2-${inHerdr}`,
    });
    const { flow: flow2 } = await f.call('hud_land', { job: job2 });
    await until(() => f.flowState(flow2).state === 'completed' &&
      f.flowState(flow2).flake_collection?.state === 'done' &&
      listFlakeJobs(f).some(j => j.ticket === 'test-flakes/01' && j.dispatch_exit_code === 0), t.signal);

    const [dispatched] = listFlakeJobs(f);
    assert.equal(dispatched.role, 'imp');
    assert.equal(dispatched.ticket, 'test-flakes/01');
    assert.equal(dispatched.request_key, flakeDispatchKey(f.main, 'test-flakes/01', 1));
    assert.equal(dispatched.ticket_queue, undefined, 'standalone flake imp keeps normal watcher/main delivery');
    assert.ok(dispatched.worktree?.root, 'dispatched in a managed worktree');
    assert.equal(f.flowState(flow2).flake_collection?.job, dispatched.job);
    const brief = fs.readFileSync(join(f.home, 'jobs', dispatched.job, 'brief.md'), 'utf8');
    assert.ok(brief.includes('shipped flake recovers'), brief);
  }
});

test('unidentified gate failures are recorded as evidence but never trigger the repeat rule', { timeout: 45_000 }, async t => {
  // Non-Node gate command: fails once per land with plain stdout, then passes on immediate rerun.
  const gateCmd = 'n=$(cat "$HOME/gate-seq" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$HOME/gate-seq"; if [ $((n % 2)) -eq 1 ]; then echo "plain failure #$n"; exit 1; fi';
  const f = await checkout(t, [gateCmd], { after: [], autoPrewalk: true });
  setFlakesConfig(f, { feature: 'test-flakes' });

  const makePlainJob = (id, tag) => {
    const base = f.git(f.main, 'rev-parse', 'HEAD');
    const wtName = `imp-${id.slice(-6)}`;
    const wtRoot = join(`${f.main}-wt`, wtName);
    const branch = `wt/${wtName}`;
    f.git(f.main, 'worktree', 'add', '-qb', branch, wtRoot, base);
    fs.appendFileSync(join(wtRoot, 'tracked'), `${tag}\n`);
    f.git(wtRoot, 'commit', '-qam', tag);
    const dir = join(f.home, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
      job: id,
      cwd: wtRoot,
      project_root: f.main,
      role: 'imp',
      herdr_pane: f.env.HERDR_PANE_ID,
      created_at: now,
      dispatch_exit_code: 0,
      worktree: { main_root: f.main, root: wtRoot, base_head: base, branch },
    }));
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: now }));
  };

  // Three unidentified failures under the same gate command must be recorded but NOT trigger repeat dispatch.
  const flows = [];
  for (let i = 1; i <= 3; i++) {
    const id = `j000000000000080${i}`;
    makePlainJob(id, `plain-${i}`);
    const { flow } = await f.call('hud_land', { job: id });
    await until(() => f.flowState(flow).state === 'completed' &&
      f.flowState(flow).flake_collection?.state === 'done', t.signal);
    flows.push(flow);
    assert.equal(listFlakeRecords(f).length, 1);
    assert.equal(listFlakeRecords(f)[0].status, 'needs-triage', `must not promote after ${i} unidentified failures`);
    assert.deepEqual(listFlakeJobs(f), [], `must not dispatch after ${i} unidentified failures`);
  }

  const cases = listFlakeRecords(f)[0].cases;
  assert.equal(cases.length, 3);
  for (const [idx, flow] of flows.entries()) {
    assert.equal(cases[idx].case_name, undefined, 'unidentified failure has no case_name');
    assert.equal(cases[idx].step, `gate[1]: ${gateCmd}`);
    assert.equal(cases[idx].flow, flow);
    assert.equal(cases[idx].log, f.flowState(flow).reruns[0].output_path);
  }

  // The 4th case reaches the 4-case list threshold and dispatches one imp.
  makePlainJob('j0000000000000804', 'plain-4');
  const { flow: flow4 } = await f.call('hud_land', { job: 'j0000000000000804' });
  await until(() => f.flowState(flow4).state === 'completed' &&
    f.flowState(flow4).flake_collection?.state === 'done' &&
    listFlakeJobs(f).length === 1, t.signal);
  assert.equal(listFlakeRecords(f)[0].status, 'ready-for-agent');
});

test('dispatch keys are project- and attempt-scoped and a failed earlier attempt does not block later admission', { timeout: 45_000 }, async t => {
  const f = await checkout(t, ['npm run test:sample'], { after: [], autoPrewalk: true });
  setFlakesConfig(f, { feature: 'test-flakes' });

  // Project B shares the same HUD_HOME and promotes test-flakes/01 too.
  const otherMain = join(f.root, 'other-project');
  fs.mkdirSync(otherMain);
  cleanupFixture(t, { root: `${otherMain}-wt` });
  f.git(otherMain, 'init', '-qb', 'base');
  f.git(otherMain, 'config', 'user.name', 'Synthetic');
  f.git(otherMain, 'config', 'user.email', 'sample@example.invalid');
  fs.mkdirSync(join(otherMain, '.hud'));
  fs.writeFileSync(join(otherMain, '.hud/project.json'), JSON.stringify({
    land: { base: 'base', gate: ['true'], after: [], push: false },
    flakes: { feature: 'test-flakes' },
  }));
  f.git(otherMain, 'add', '.hud');
  f.git(otherMain, 'commit', '-qm', 'init other');

  const keyA1 = flakeDispatchKey(f.main, 'test-flakes/01', 1);
  const keyB1 = flakeDispatchKey(otherMain, 'test-flakes/01', 1);
  const keyA2 = flakeDispatchKey(f.main, 'test-flakes/01', 2);
  assert.notEqual(keyA1, keyB1, 'different projects must get distinct request keys');
  assert.notEqual(keyA1, keyA2, 'different attempts must get distinct request keys');

  // Seed an active job for otherMain's test-flakes/01 in the shared HUD_HOME.
  const otherJobId = 'j0000000000000900';
  const otherDir = join(f.home, 'jobs', otherJobId);
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(join(otherDir, 'job.json'), JSON.stringify({
    job: otherJobId,
    cwd: otherMain,
    project_root: otherMain,
    role: 'imp',
    ticket: 'test-flakes/01',
    request_key: keyB1,
    created_at: new Date().toISOString(),
    dispatch_exit_code: 0,
  }));
  fs.writeFileSync(join(otherDir, 'STATUS.json'), JSON.stringify({ state: 'working' }));

  // Also seed a FAILED attempt 1 job for f.main's test-flakes/01 in the same HUD_HOME.
  const failedJobId = 'j0000000000000901';
  const failedDir = join(f.home, 'jobs', failedJobId);
  fs.mkdirSync(failedDir, { recursive: true });
  fs.writeFileSync(join(failedDir, 'job.json'), JSON.stringify({
    job: failedJobId,
    cwd: f.main,
    project_root: f.main,
    role: 'imp',
    ticket: 'test-flakes/01',
    request_key: keyA1,
    created_at: new Date().toISOString(),
    dispatch_exit_code: 1,
    dispatch_code: 'dispatch_failed',
  }));
  fs.writeFileSync(join(failedDir, 'STATUS.json'), JSON.stringify({
    state: 'failed',
    exit_reason: 'dispatch_failed',
    ended_at: new Date().toISOString(),
  }));

  // Verify a failed dispatch response (even with a job ID) is NOT treated as a successful admission.
  const rel = seedJsonTickets(f, 'test-flakes', [{
    number: 1, title: 'Gate flakes running list', kind: 'flake-list', status: 'needs-triage', what: 'Running list.',
    cases: [{ step: 'gate[1]', test: 'sample/retry.test.mjs', case_name: 'retry case', flow: 'f0000000000000901',
      log: '~/.hud/flows/f0000000000000901.json.gate-1.log', recorded_at: '2026-01-01T00:00:00.000Z' }],
  }]);
  f.git(f.main, 'add', rel);
  f.git(f.main, 'commit', '-qm', 'seed flake 01');

  const seenKeys = [];
  const refused = await collectGateFlakes(f.home, f.main, [{
    name: 'retry case',
    file: 'sample/retry.test.mjs',
    flow: 'f0000000000000902',
    log: join(f.home, 'flows', 'f0000000000000902.json.gate-1.log'),
  }], f.env.HERDR_PANE_ID, {
    dispatch: async (input) => {
      seenKeys.push(input.request_key);
      return { ok: false, code: 'dispatch_failed', job: failedJobId, state: 'failed', reason: 'synthetic launch error' };
    },
  });
  assert.equal(seenKeys[0], keyA2, 'attempt advances past prior failed attempt 1');
  assert.equal(refused.dispatchedJob, undefined, 'failed job must not be returned as successful admission');
  assert.equal(refused.pending?.stage, 'dispatch');
  assert.match(refused.pending?.error ?? '', /synthetic launch error/);

  // Real admission via hud_land on f.main (while otherMain's test-flakes/01 job is working and f.main attempt 1 failed)
  // dispatches a brand-new imp job for f.main with attempt 2 key.
  const jobLand = 'j0000000000000903';
  addFlakyTestJob(f, {
    id: jobLand,
    testFile: 'other.test.mjs',
    testName: 'other recovers',
    markerName: 'scoped-key-1',
  });
  const { flow: landFlow } = await f.call('hud_land', { job: jobLand });
  // Simulate retryDispatch on the promoted ticket through real dispatch via a clean land of a flake ticket, or via pending receipt.
  await until(() => f.flowState(landFlow).state === 'completed', t.signal);
  // Seed a pending dispatch receipt for f.main so real land-runner retries it with real dispatchTicketJob.
  const pendingFlowId = 'f0000000000000999';
  fs.writeFileSync(join(f.home, 'flows', `${pendingFlowId}.json`), JSON.stringify({
    flow: pendingFlowId,
    job: jobLand,
    pane: f.env.HERDR_PANE_ID,
    task: false,
    wt: { main_root: f.main, root: join(`${f.main}-wt`, 'gone'), base_head: f.base_head, branch: 'wt/gone' },
    config: { base: 'base', gate: ['true'], after: [], push: false },
    state: 'completed',
    step: 'done',
    pid: process.pid,
    start: '1',
    created_at: new Date(Date.now() - 5000).toISOString(),
    updated_at: new Date(Date.now() - 5000).toISOString(),
    source_sha: f.base_head,
    flake_collection: { state: 'pending', stage: 'dispatch', ticket: 'test-flakes/01', error: 'prior refusal', attempts: 1, updated_at: new Date().toISOString() },
  }));
  const cleanJob = 'j0000000000000904';
  const base = f.git(f.main, 'rev-parse', 'HEAD');
  const wtRoot = join(`${f.main}-wt`, 'imp-000904');
  f.git(f.main, 'worktree', 'add', '-qb', 'wt/imp-000904', wtRoot, base);
  fs.appendFileSync(join(wtRoot, 'tracked'), 'clean land triggers pending dispatch\n');
  f.git(wtRoot, 'commit', '-qam', 'clean land');
  const cleanDir = join(f.home, 'jobs', cleanJob);
  fs.mkdirSync(cleanDir, { recursive: true });
  fs.writeFileSync(join(cleanDir, 'job.json'), JSON.stringify({
    job: cleanJob, cwd: wtRoot, project_root: f.main, role: 'imp', herdr_pane: f.env.HERDR_PANE_ID,
    created_at: new Date().toISOString(), dispatch_exit_code: 0,
    worktree: { main_root: f.main, root: wtRoot, base_head: base, branch: 'wt/imp-000904' },
  }));
  fs.writeFileSync(join(cleanDir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  const { flow: cleanLand } = await f.call('hud_land', { job: cleanJob });
  await until(() => f.flowState(cleanLand).state === 'completed' &&
    f.flowState(pendingFlowId).flake_collection?.state === 'done', t.signal);

  const admittedJobId = f.flowState(pendingFlowId).flake_collection.job;
  assert.ok(admittedJobId && admittedJobId !== otherJobId && admittedJobId !== failedJobId, `expected new imp job, got ${admittedJobId}`);
  const admittedJob = readJson(join(f.home, 'jobs', admittedJobId, 'job.json'));
  assert.equal(admittedJob.project_root, f.main);
  assert.equal(admittedJob.ticket, 'test-flakes/01');
  assert.equal(admittedJob.request_key, keyA2);
  assert.equal(admittedJob.dispatch_exit_code, 0);
});

test('refused ticket edit and refused dispatch are recorded on the land receipt and retried idempotently without gate rerun', { timeout: 60_000 }, async t => {
  const f = await checkout(t, ['echo ran >> "$HOME/gate-runs.log"; npm run test:sample'], { after: [], autoPrewalk: true });
  setFlakesConfig(f, { feature: 'test-flakes' });

  // Part A: malformed JSON store file causes ticket edit refusal (stage: edit) while keeping the file intact.
  const ticketsDir = join(f.main, '.hud', 'tickets');
  fs.mkdirSync(ticketsDir, { recursive: true });
  const jsonPath = join(ticketsDir, 'test-flakes.json');
  const at = new Date().toISOString();
  const validDoc = JSON.stringify({
    version: 1,
    feature: 'test-flakes',
    tickets: [{
      number: 1,
      title: 'Gate flakes running list',
      kind: 'flake-list',
      status: 'needs-triage',
      owner_try: false,
      live_try: 'none',
      approved_removals: [],
      blocked_by: [],
      what: 'Running list.',
      cases: [{ step: 'gate[1]', test: 'sample/initial.test.mjs', case_name: 'initial case', flow: 'f0000000000000001', log: '~/.hud/flows/f0000000000000001.json.gate-1.log', recorded_at: at }],
      acceptance: [{ id: 1, text: 'Each listed case passes 20 consecutive runs', done: false }],
      comments: [{ at, author: 'owner', text: 'Owner hand note' }],
      created_at: at,
      updated_at: at,
    }],
  }, null, 2) + '\n';
  const brokenText = validDoc + '{broken hand edit\n';
  fs.writeFileSync(jsonPath, brokenText);

  const job1 = 'j0000000000000a01';
  addFlakyTestJob(f, {
    id: job1,
    testFile: 'alpha.test.mjs',
    testName: 'alpha recovers',
    markerName: 'pending-edit-1',
  });
  const { flow: flow1 } = await f.call('hud_land', { job: job1 });
  await until(() => f.flowState(flow1).state === 'completed' &&
    f.flowState(flow1).flake_collection?.state === 'pending', 10_000);

  const f1 = f.flowState(flow1);
  assert.equal(f1.state, 'completed', 'land stays green on ticket edit refusal');
  assert.equal(f1.flake_collection.stage, 'edit');
  assert.equal(f1.flake_collection.attempts, 1);
  assert.match(f1.flake_collection.error, /Cannot read ticket feature test-flakes/);
  assert.match(landNotice(f1), /Flake collection pending \(edit\)/);
  assert.equal(fs.readFileSync(jsonPath, 'utf8'), brokenText, 'owner broken file stays intact');
  const gateRunsAfterLand1 = fs.readFileSync(join(f.env.HOME, 'gate-runs.log'), 'utf8').trim().split('\n').length;

  // Owner fixes the JSON file, then the next clean land retries flow1 from its recorded rerun (no gate rerun for flow1).
  fs.writeFileSync(jsonPath, validDoc);

  // Force a clean gate on job2 (marker already exists so test passes on first try).
  fs.writeFileSync(join(f.env.HOME, 'pending-clean-2'), 'ran\n');
  const job2 = 'j0000000000000a02';
  addFlakyTestJob(f, {
    id: job2,
    testFile: 'alpha.test.mjs',
    testName: 'alpha recovers',
    markerName: 'pending-clean-2',
  });
  const { flow: flow2 } = await f.call('hud_land', { job: job2 });
  await until(() => f.flowState(flow2).state === 'completed' &&
    f.flowState(flow1).flake_collection?.state === 'done', 10_000);

  assert.equal(f.flowState(flow1).flake_collection.ticket, 'test-flakes/01');
  assert.equal(f.flowState(flow1).flake_collection.attempts, 2);
  const t01AfterRetry = listFlakeRecords(f)[0];
  assert.ok(t01AfterRetry.comments.some(c => c.text === 'Owner hand note'), 'owner comment preserved');
  assert.ok(t01AfterRetry.cases.some(c => c.case_name === 'alpha recovers' && c.flow === flow1));
  const gateRunsAfterLand2 = fs.readFileSync(join(f.env.HOME, 'gate-runs.log'), 'utf8').trim().split('\n').length;
  assert.equal(gateRunsAfterLand2, gateRunsAfterLand1 + 1, 'only job2 ran its gate once; flow1 retry did not rerun the gate');

  // Calling retryPendingFlakeCollections / collectAndRecordLandFlakes again is an idempotent no-op.
  const headBeforeIdemp = f.git(f.main, 'rev-parse', 'HEAD');
  const again = await retryPendingFlakeCollections(f.home, f.main, f.env.HERDR_PANE_ID);
  assert.deepEqual(again, { retried: 0, resolved: 0, pending: 0 });
  await collectAndRecordLandFlakes(f.home, f.main, f.flowState(flow1));
  assert.equal(f.flowState(flow1).flake_collection.state, 'done', 'replaying an unpromoted list does not create a pending dispatch');
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), headBeforeIdemp, 'idempotent retry makes no extra commit');
  assert.equal(listFlakeRecords(f)[0].cases.filter(c => c.flow === flow1).length, 1, 'flow1 recorded once');

  // Part B: dispatch refusal recorded on land receipt, then retried idempotently by unattended service wake (no gate rerun).
  // Temporarily disable pi harness so real dispatchTicketJob refuses admission (no_available_place).
  const harnessSwitches = join(f.home, 'harnesses.json');
  fs.writeFileSync(harnessSwitches, JSON.stringify({ disabled: ['pi'] }));

  const job3 = 'j0000000000000a03';
  addFlakyTestJob(f, {
    id: job3,
    testFile: 'alpha.test.mjs',
    testName: 'alpha recovers',
    markerName: 'pending-dispatch-3',
  });
  const { flow: flow3 } = await f.call('hud_land', { job: job3 });
  await until(() => f.flowState(flow3).state === 'completed' &&
    f.flowState(flow3).flake_collection?.state === 'pending', 10_000);

  const f3 = f.flowState(flow3);
  assert.equal(f3.state, 'completed', 'land stays green on dispatch refusal');
  assert.equal(f3.flake_collection.stage, 'dispatch');
  assert.equal(f3.flake_collection.ticket, 'test-flakes/01');
  assert.match(landNotice(f3), /Flake collection pending \(dispatch\)/);
  assert.equal(listFlakeRecords(f)[0].status, 'ready-for-agent');
  assert.deepEqual(listFlakeJobs(f), [], 'no flake imp created while dispatch refused');
  const gateRunsBeforeService = fs.readFileSync(join(f.env.HOME, 'gate-runs.log'), 'utf8').trim().split('\n').length;
  const ticketCountBeforeService = listFlakeRecords(f).length;

  // Re-enable pi harness and start the unattended service so service wake retries the pending dispatch.
  fs.unlinkSync(harnessSwitches);
  fs.writeFileSync(join(f.main, '.hud', 'objectives.md'), '# Objectives\n\n## synth-obj: Synthetic Objective\n\n**State:** active\n**Features:** synth\n');
  f.git(f.main, 'add', '.hud/objectives.md');
  f.git(f.main, 'commit', '-qm', 'add synthetic objective');
  const unattendedEnv = { ...f.env, HUD_UNATTENDED_RECONCILE_MS: '500' };
  const hudBin = resolve('bin/hud');
  t.after(() => {
    try { execFileSync(process.execPath, [hudBin, 'unattended', 'off'], { cwd: f.main, env: unattendedEnv, stdio: 'ignore', timeout: 10_000 }); }
    catch {}
  });
  execFileSync(process.execPath, [hudBin, 'unattended', 'on', '--objective', 'synth-obj'], {
    cwd: f.main, env: unattendedEnv, encoding: 'utf8', timeout: 15_000,
  });

  await until(() => f.flowState(flow3).flake_collection?.state === 'done' &&
    listFlakeJobs(f).some(j => j.ticket === 'test-flakes/01' && j.dispatch_exit_code === 0), 15_000);

  const [dispatched] = listFlakeJobs(f);
  assert.equal(f.flowState(flow3).flake_collection.job, dispatched.job);
  assert.equal(listFlakeRecords(f).length, ticketCountBeforeService, 'retry did not duplicate into a new ticket');
  assert.equal(fs.readFileSync(join(f.env.HOME, 'gate-runs.log'), 'utf8').trim().split('\n').length, gateRunsBeforeService, 'service wake retry did not rerun any gate');
});

function seedWaitingFlake(f) {
  const dir = join(f.main, '.scratch', 'test-flakes', 'issues');
  fs.mkdirSync(dir, { recursive: true });
  for (const number of ['01', '02']) {
    fs.writeFileSync(join(dir, `${number}-running-list.md`), [
      `# ${number}: Gate flakes running list`, '', `**Status:** ${number === '01' ? 'claimed' : 'ready-for-agent'}`,
      '**Owner try:** no', '**Live try:** none', '**Blocked by:** none', '',
      '**What to build:** Fix the synthetic flake.', '', '- [ ] Pass', '', '## Comments', '',
    ].join('\n'));
  }
  f.git(f.main, 'add', '.scratch');
  f.git(f.main, 'commit', '-qm', 'seed running lists');

  const job = 'j0000000000000b01';
  const jobDir = join(f.home, 'jobs', job);
  const status = join(jobDir, 'STATUS.json');
  const now = new Date().toISOString();
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(join(jobDir, 'job.json'), JSON.stringify({
    job, cwd: f.main, project_root: f.main, role: 'imp', ticket: 'test-flakes/01',
    request_key: flakeDispatchKey(f.main, 'test-flakes/01', 1), created_at: now, dispatch_exit_code: 0,
  }));
  fs.writeFileSync(status, JSON.stringify({ state: 'working' }));

  const flow = 'f0000000000000b02';
  const flowsDir = join(f.home, 'flows');
  fs.mkdirSync(flowsDir, { recursive: true });
  fs.writeFileSync(join(flowsDir, `${flow}.json`), JSON.stringify({
    flow, job: 'j0000000000000b02', pane: f.env.HERDR_PANE_ID, task: false,
    wt: { main_root: f.main, root: f.worktree, base_head: f.base_head, branch: f.branch },
    config: { base: 'base', gate: ['true'], after: [], push: false },
    state: 'completed', step: 'done', pid: process.pid, start: '1',
    created_at: now, updated_at: now, source_sha: f.base_head,
    flake_collection: { state: 'pending', stage: 'dispatch', ticket: 'test-flakes/02',
      error: 'waiting for active flake job', attempts: 1, updated_at: now },
  }));
  return { flow, status };
}

test('selected Objective cannot admit a promoted running list until the active flake imp stops', { timeout: 40_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });
  const { flow, status } = seedWaitingFlake(f);
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ autoPrewalk: false, roleCaps: { imp: 3 } }));

  // The later-sorting ordinary ticket proves the selected Objective's queue has had a chance to admit work.
  fs.writeFileSync(join(f.main, '.hud', 'objectives.md'), '# Objectives\n\n## synth-obj: Synthetic Objective\n\n**State:** active\n**Features:** test-flakes, zz-probe\n');
  const probeDir = join(f.main, '.scratch', 'zz-probe', 'issues');
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(join(probeDir, '01-probe.md'), [
    '# 01: Probe', '', '**Status:** ready-for-agent', '**Live try:** none', '**Blocked by:** none', '',
    '**What to build:** Prove ordinary work is admitted.', '', '- [ ] Pass', '',
  ].join('\n'));
  f.git(f.main, 'add', '.hud/objectives.md', probeDir);
  f.git(f.main, 'commit', '-qm', 'add objective and probe');

  const env = { ...f.env, HUD_UNATTENDED_RECONCILE_MS: '500' };
  const hudBin = resolve('bin/hud');
  t.after(() => {
    try { execFileSync(process.execPath, [hudBin, 'unattended', 'off'], { cwd: f.main, env, stdio: 'ignore', timeout: 10_000 }); }
    catch {}
  });
  execFileSync(process.execPath, [hudBin, 'unattended', 'on', '--objective', 'synth-obj'], {
    cwd: f.main, env, encoding: 'utf8', timeout: 15_000,
  });
  await until(() => listFlakeJobs(f, 'zz-probe').some(j => j.dispatch_exit_code === 0), t.signal);
  assert.equal(readJson(status).state, 'working');
  assert.deepEqual(listFlakeJobs(f).map(j => j.ticket), ['test-flakes/01']);
  assert.equal(f.flowState(flow).flake_collection.state, 'pending');

  fs.writeFileSync(status, JSON.stringify({ state: 'stopped', ended_at: new Date().toISOString() }));
  const jobsFor02 = () => listFlakeJobs(f).filter(j => j.ticket === 'test-flakes/02');
  await until(() => f.flowState(flow).flake_collection.state === 'done' &&
    jobsFor02().some(j => j.dispatch_exit_code === 0), t.signal);
  assert.equal(jobsFor02().length, 1);
});

test('an unrelated clean land admits a waiting flake list after the active imp fails', { timeout: 30_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });
  const { flow, status } = seedWaitingFlake(f);
  fs.writeFileSync(status, JSON.stringify({ state: 'failed', exit_reason: 'synthetic failure', ended_at: new Date().toISOString() }));
  const { flow: cleanLand } = await f.call('hud_land', { job: 'j0000000000000123' });
  await until(() => f.flowState(cleanLand).state === 'completed' &&
    f.flowState(flow).flake_collection.state === 'done', t.signal);
  const admitted = listFlakeJobs(f).filter(j => j.ticket === 'test-flakes/02');
  assert.equal(admitted.length, 1);
  assert.equal(f.flowState(flow).flake_collection.job, admitted[0].job);
});

test('waiting-dispatch state is acknowledged only on admission or independent resolution (done, claimed, wontfix)', { timeout: 30_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });

  // Seed an active flake imp for test-flakes/01.
  const activeJobId = 'j0000000000000c01';
  const activeDir = join(f.home, 'jobs', activeJobId);
  fs.mkdirSync(activeDir, { recursive: true });
  fs.writeFileSync(join(activeDir, 'job.json'), JSON.stringify({
    job: activeJobId,
    cwd: f.main,
    project_root: f.main,
    role: 'imp',
    ticket: 'test-flakes/01',
    request_key: flakeDispatchKey(f.main, 'test-flakes/01', 1),
    created_at: new Date().toISOString(),
    dispatch_exit_code: 0,
  }));
  fs.writeFileSync(join(activeDir, 'STATUS.json'), JSON.stringify({ state: 'working' }));

  const rel = seedJsonTickets(f, 'test-flakes', [{
    number: 1, title: 'Gate flakes running list', kind: 'flake-list', status: 'ready-for-agent', what: 'Running list.',
    cases: [{ step: 'gate[1]', test: 'sample/seed.test.mjs', case_name: 'seed case', flow: 'f0000000000000c00', recorded_at: '2026-01-01T00:00:00.000Z' }],
  }]);
  f.git(f.main, 'add', rel);
  f.git(f.main, 'commit', '-qm', 'seed flake 01');

  const seedWaitingFlow = async (flowId, testName) => {
    fs.mkdirSync(join(f.home, 'flows'), { recursive: true });
    const now = new Date().toISOString();
    const flow = {
      flow: flowId,
      job: 'j0000000000000c99',
      pane: f.env.HERDR_PANE_ID,
      task: false,
      wt: { main_root: f.main, root: join(`${f.main}-wt`, 'gone'), base_head: f.base_head, branch: 'wt/gone' },
      config: { base: 'base', gate: ['true'], after: [], push: false },
      state: 'completed',
      step: 'done',
      pid: process.pid,
      start: '1',
      created_at: now,
      updated_at: now,
      source_sha: f.base_head,
      reruns: [{
        step: 'gate[1]',
        tests: [`${testName} 1`, `${testName} 2`, `${testName} 3`, `${testName} 4`],
        cases: [
          { name: `${testName} 1`, file: 'sample/wait.test.mjs' },
          { name: `${testName} 2`, file: 'sample/wait.test.mjs' },
          { name: `${testName} 3`, file: 'sample/wait.test.mjs' },
          { name: `${testName} 4`, file: 'sample/wait.test.mjs' },
        ],
        rerun_ok: true,
      }],
    };
    fs.writeFileSync(join(f.home, 'flows', `${flowId}.json`), JSON.stringify(flow));
    await collectAndRecordLandFlakes(f.home, f.main, flow, { dispatch: async () => { throw Error('must not dispatch while active'); } });
    return f.flowState(flowId);
  };

  // Independent resolution cases: done, claimed, wontfix.
  const resolutions = [
    { flowId: 'f0000000000000c11', testName: 'res done', ticketNum: '02', status: 'done' },
    { flowId: 'f0000000000000c12', testName: 'res claimed', ticketNum: '03', status: 'claimed' },
    { flowId: 'f0000000000000c13', testName: 'res wontfix', ticketNum: '04', status: 'wontfix' },
  ];
  for (const r of resolutions) {
    const waiting = await seedWaitingFlow(r.flowId, r.testName);
    assert.equal(waiting.flake_collection?.state, 'pending');
    assert.equal(waiting.flake_collection?.stage, 'dispatch');
    assert.equal(waiting.flake_collection?.ticket, `test-flakes/${r.ticketNum}`);

    // Retrying while activeJobId is still working and ticket is still ready-for-agent must NOT acknowledge.
    const stillPending = await retryPendingFlakeCollections(f.home, f.main, f.env.HERDR_PANE_ID, {
      dispatch: async () => { throw Error('must not dispatch while active'); },
    });
    assert.deepEqual(stillPending, { retried: 1, resolved: 0, pending: 1 });
    assert.equal(f.flowState(r.flowId).flake_collection?.state, 'pending');
    assert.equal(f.flowState(r.flowId).flake_collection?.attempts, 1, 'unchanged wait does not bump attempts');

    // Independently resolve the ticket -> waiting state is acknowledged without dispatching a job.
    const doc = readFlakeDoc(f);
    doc.tickets.find(item => item.number === Number(r.ticketNum)).status = r.status;
    fs.writeFileSync(join(f.main, rel), JSON.stringify(doc, null, 2) + '\n');
    const resolved = await retryPendingFlakeCollections(f.home, f.main, f.env.HERDR_PANE_ID, {
      dispatch: async () => { throw Error('must not dispatch resolved ticket'); },
    });
    assert.deepEqual(resolved, { retried: 1, resolved: 1, pending: 0 });
    assert.equal(f.flowState(r.flowId).flake_collection?.state, 'done');
    assert.equal(f.flowState(r.flowId).flake_collection?.ticket, `test-flakes/${r.ticketNum}`);
    assert.equal(f.flowState(r.flowId).flake_collection?.job, undefined);
  }

  // Admission case: waiting ticket 05 stays pending while active, then is acknowledged with job id upon admission.
  const admitFlowId = 'f0000000000000c14';
  const waitingAdmit = await seedWaitingFlow(admitFlowId, 'res admit');
  assert.equal(waitingAdmit.flake_collection?.state, 'pending');
  assert.equal(waitingAdmit.flake_collection?.ticket, 'test-flakes/05');

  fs.writeFileSync(join(activeDir, 'STATUS.json'), JSON.stringify({ state: 'stopped', ended_at: new Date().toISOString() }));
  const dispatched = [];
  const admitted = await retryPendingFlakeCollections(f.home, f.main, f.env.HERDR_PANE_ID, {
    dispatch: async (input) => {
      dispatched.push(input.ticket);
      return { job: 'j0000000000000c55' };
    },
  });
  assert.deepEqual(admitted, { retried: 1, resolved: 1, pending: 0 });
  assert.deepEqual(dispatched, ['test-flakes/05']);
  assert.equal(f.flowState(admitFlowId).flake_collection?.state, 'done');
  assert.equal(f.flowState(admitFlowId).flake_collection?.ticket, 'test-flakes/05');
  assert.equal(f.flowState(admitFlowId).flake_collection?.job, 'j0000000000000c55');
});

test('persistent refusal does not self-wake unattended service; attempts and receipt writes stay bounded until refusal clears', { timeout: 60_000 }, async t => {
  const f = await checkout(t, ['npm run test:sample'], { after: [], autoPrewalk: true });
  setFlakesConfig(f, { feature: 'test-flakes' });

  // Part A: persistent edit refusal (invalid JSON in ticket store).
  const ticketsDir = join(f.main, '.hud', 'tickets');
  fs.mkdirSync(ticketsDir, { recursive: true });
  const jsonPath = join(ticketsDir, 'test-flakes.json');
  const at = new Date().toISOString();
  const validDoc = JSON.stringify({
    version: 1,
    feature: 'test-flakes',
    tickets: [{
      number: 1,
      title: 'Gate flakes running list',
      kind: 'flake-list',
      status: 'needs-triage',
      owner_try: false,
      live_try: 'none',
      approved_removals: [],
      blocked_by: [],
      what: 'Running list.',
      cases: [{ step: 'gate[1]', test: 'sample/initial.test.mjs', case_name: 'initial case', flow: 'f0000000000000d00', log: '~/.hud/flows/f0000000000000d00.json.gate-1.log', recorded_at: at }],
      acceptance: [{ id: 1, text: 'Each listed case passes 20 consecutive runs', done: false }],
      comments: [{ at, author: 'owner', text: 'Owner hand edit stays intact' }],
      created_at: at,
      updated_at: at,
    }],
  }, null, 2) + '\n';
  fs.writeFileSync(join(f.main, '.hud', 'objectives.md'), '# Objectives\n\n## synth-obj: Synthetic Objective\n\n**State:** active\n**Features:** synth\n');
  f.git(f.main, 'add', '.hud/objectives.md');
  f.git(f.main, 'commit', '-qm', 'seed objective');

  const dirtyText = validDoc + '{invalid\n';
  fs.writeFileSync(jsonPath, dirtyText);

  addFlakyTestJob(f, { id: 'j0000000000000d01', testFile: 'alpha.test.mjs', testName: 'alpha bounded', markerName: 'bounded-edit-1' });
  const { flow: flow1 } = await f.call('hud_land', { job: 'j0000000000000d01' });
  await until(() => f.flowState(flow1).state === 'completed' &&
    f.flowState(flow1).flake_collection?.state === 'pending', 10_000);

  const flow1Path = join(f.home, 'flows', `${flow1}.json`);
  const stat1Before = fs.statSync(flow1Path);
  const fc1Before = f.flowState(flow1).flake_collection;
  assert.equal(fc1Before.stage, 'edit');
  assert.equal(fc1Before.attempts, 1);
  assert.equal(fs.readFileSync(jsonPath, 'utf8'), dirtyText, 'owner broken file stays intact');

  // Start unattended service with short reconcile interval and wait across multiple fallback + event wakes.
  const unattendedEnv = { ...f.env, HUD_UNATTENDED_RECONCILE_MS: '500' };
  const hudBin = resolve('bin/hud');
  t.after(() => {
    try { execFileSync(process.execPath, [hudBin, 'unattended', 'off'], { cwd: f.main, env: unattendedEnv, stdio: 'ignore', timeout: 10_000 }); }
    catch {}
  });
  execFileSync(process.execPath, [hudBin, 'unattended', 'on', '--objective', 'synth-obj'], {
    cwd: f.main, env: unattendedEnv, encoding: 'utf8', timeout: 15_000,
  });

  await new Promise(r => setTimeout(r, 700));
  // Trigger an unrelated .scratch event wake while refusal is unchanged.
  fs.mkdirSync(join(f.main, '.scratch', 'unrelated', 'issues'), { recursive: true });
  fs.writeFileSync(join(f.main, '.scratch', 'unrelated', 'issues', '01-noise.md'), '# 01: Noise\n');
  await new Promise(r => setTimeout(r, 900));

  const stat1After = fs.statSync(flow1Path);
  const fc1After = f.flowState(flow1).flake_collection;
  assert.equal(fc1After.state, 'pending');
  assert.equal(fc1After.attempts, 1, 'attempts must stay bounded while edit refusal is unchanged');
  assert.equal(fc1After.updated_at, fc1Before.updated_at, 'receipt must not be rewritten while refusal is unchanged');
  assert.equal(stat1After.ino, stat1Before.ino);
  assert.equal(stat1After.mtimeMs, stat1Before.mtimeMs);
  assert.equal(fs.readFileSync(jsonPath, 'utf8'), dirtyText, 'owner broken file still intact');

  // Clear edit refusal by restoring valid JSON -> service appends exactly once.
  fs.writeFileSync(jsonPath, validDoc);
  await until(() => f.flowState(flow1).flake_collection?.state === 'done', 15_000);

  assert.equal(f.flowState(flow1).flake_collection.attempts, 2);
  assert.equal(f.flowState(flow1).flake_collection.ticket, 'test-flakes/01');
  const t01Resolved = listFlakeRecords(f)[0];
  assert.ok(t01Resolved.comments.some(c => c.text === 'Owner hand edit stays intact'), 'owner comment preserved');
  assert.equal(t01Resolved.cases.filter(c => c.flow === flow1).length, 1, 'flow1 appended once');

  // Part B: every Imp place is quota-exhausted. Exhaustion is neither watched nor stamped by the service.
  const roles = join(f.home, 'roles');
  fs.mkdirSync(roles, { recursive: true });
  fs.writeFileSync(join(roles, 'imp.json'), JSON.stringify({ role: 'imp', instructions: 'implementer', can_continue: true,
    run: [{ harness: 'pi', pi_role: 'implementer', model: 'synthetic/quota-test' }],
  }));
  const key = 'pi:synthetic/quota-test';
  markExhausted(f.home, key, 'synthetic quota exhausted');
  const refused = await f.call('hud_create', { role: 'imp', task: 'Synthetic quota probe', scouts: [] });
  assert.equal(refused.code, 'no_available_place', JSON.stringify(refused));

  addFlakyTestJob(f, { id: 'j0000000000000d02', testFile: 'alpha.test.mjs', testName: 'alpha bounded', markerName: 'bounded-dispatch-2' });
  const { flow: flow2 } = await f.call('hud_land', { job: 'j0000000000000d02' });
  await until(() => f.flowState(flow2).flake_collection !== undefined, t.signal);
  assert.equal(f.flowState(flow2).state, 'completed');

  const flow2Path = join(f.home, 'flows', `${flow2}.json`);
  const stat2Before = fs.statSync(flow2Path);
  const fc2Before = f.flowState(flow2).flake_collection;
  assert.equal(fc2Before.stage, 'dispatch', JSON.stringify(fc2Before));
  assert.equal(fc2Before.ticket, 'test-flakes/01');
  assert.equal(fc2Before.attempts, 1);
  assert.match(fc2Before.error, /synthetic quota exhausted/);
  assert.deepEqual(listFlakeJobs(f), []);

  await new Promise(r => setTimeout(r, 700));
  fs.writeFileSync(join(f.main, '.scratch', 'unrelated', 'issues', '01-noise.md'), '# 01: Noise 2\n');
  await new Promise(r => setTimeout(r, 900));

  const stat2After = fs.statSync(flow2Path);
  const fc2After = f.flowState(flow2).flake_collection;
  assert.equal(fc2After.state, 'pending');
  assert.equal(fc2After.attempts, 1, 'attempts must stay bounded while dispatch refusal is unchanged');
  assert.equal(fc2After.updated_at, fc2Before.updated_at, 'receipt must not be rewritten while dispatch refusal is unchanged');
  assert.equal(stat2After.ino, stat2Before.ino);
  assert.equal(stat2After.mtimeMs, stat2Before.mtimeMs);
  assert.deepEqual(listFlakeJobs(f), []);

  // Clear only the exhaustion mark: no new land, job, ticket edit or watched input change.
  assert.equal(clearExhausted(f.home, key), true);
  await until(() => f.flowState(flow2).flake_collection?.state === 'done' &&
    listFlakeJobs(f).some(j => j.ticket === 'test-flakes/01' && j.dispatch_exit_code === 0), 15_000);

  await new Promise(r => setTimeout(r, 600));
  const flakeJobs = listFlakeJobs(f);
  assert.equal(flakeJobs.length, 1, 'admits exactly once after refusal clears');
  assert.equal(f.flowState(flow2).flake_collection.attempts, 2);
  assert.equal(f.flowState(flow2).flake_collection.job, flakeJobs[0].job);
});

test('retention keeps expired pending flake receipt and gate log after source job removal until collected or resolved', { timeout: 30_000 }, async t => {
  const f = await checkout(t, ['npm run test:sample'], { after: [], autoPrewalk: true });
  setFlakesConfig(f, { feature: 'test-flakes' });

  const ticketsDir = join(f.main, '.hud', 'tickets');
  fs.mkdirSync(ticketsDir, { recursive: true });
  const jsonPath = join(ticketsDir, 'test-flakes.json');
  const at = new Date().toISOString();
  const validDoc = JSON.stringify({
    version: 1,
    feature: 'test-flakes',
    tickets: [{
      number: 1,
      title: 'Gate flakes running list',
      kind: 'flake-list',
      status: 'needs-triage',
      owner_try: false,
      live_try: 'none',
      approved_removals: [],
      blocked_by: [],
      what: 'Running list.',
      cases: [{ step: 'gate[1]', test: 'sample/initial.test.mjs', case_name: 'initial case', flow: 'f0000000000000e00', log: '~/.hud/flows/f0000000000000e00.json.gate-1.log', recorded_at: at }],
      acceptance: [{ id: 1, text: 'Each listed case passes 20 consecutive runs', done: false }],
      comments: [{ at, author: 'owner', text: 'Owner hand edit before retention' }],
      created_at: at,
      updated_at: at,
    }],
  }, null, 2) + '\n';
  fs.writeFileSync(jsonPath, validDoc + '{invalid\n');

  const jobId = 'j0000000000000e01';
  addFlakyTestJob(f, { id: jobId, testFile: 'alpha.test.mjs', testName: 'alpha survives retention', markerName: 'retain-edit-1' });
  const { flow } = await f.call('hud_land', { job: jobId });
  await until(() => f.flowState(flow).state === 'completed' &&
    f.flowState(flow).flake_collection?.state === 'pending', 10_000);

  const flowReceipt = f.flowState(flow);
  assert.equal(flowReceipt.flake_collection.stage, 'edit');
  const gateLog = flowReceipt.reruns?.[0]?.output_path;
  assert.ok(gateLog && fs.existsSync(gateLog), 'referenced gate log exists');

  // Seed an expired completed land whose collection is already done (bound check: must be pruned).
  const doneFlow = 'f0000000000000e02';
  const doneReceiptPath = join(f.home, 'flows', `${doneFlow}.json`);
  const doneGateLog = join(f.home, 'flows', `${doneFlow}.json.gate-1.log`);
  fs.writeFileSync(doneGateLog, 'expired done gate excerpt\n');
  fs.writeFileSync(doneReceiptPath, JSON.stringify({
    ...flowReceipt, flow: doneFlow, job: 'j0000000000000e02',
    flake_collection: { state: 'done', ticket: 'test-flakes/01', attempts: 1, updated_at: flowReceipt.updated_at },
  }));

  // Remove the source job directory (as job retention does after 24h) and age all flow family artifacts past cutoff.
  fs.rmSync(join(f.home, 'jobs', jobId), { recursive: true, force: true });
  const now = Date.now();
  const expiredSec = (now - JOB_RETENTION_MS - 120_000) / 1000;
  for (const name of fs.readdirSync(join(f.home, 'flows'))) {
    if (!name.startsWith(flow) && !name.startsWith(doneFlow)) continue;
    const p = join(f.home, 'flows', name);
    fs.utimesSync(p, expiredSec, expiredSec);
    if (fs.lstatSync(p).isDirectory()) {
      for (const child of fs.readdirSync(p)) fs.utimesSync(join(p, child), expiredSec, expiredSec);
    }
  }

  // Prune: pending receipt and its referenced gate log survive; expired done family is pruned.
  pruneLandFlows(f.home, now);
  const receiptPath = join(f.home, 'flows', `${flow}.json`);
  assert.equal(fs.existsSync(receiptPath), true, 'pending flow receipt kept through pruneLandFlows');
  assert.equal(fs.existsSync(gateLog), true, 'referenced gate log kept through pruneLandFlows');
  assert.equal(fs.existsSync(doneReceiptPath), false, 'expired done receipt pruned');
  assert.equal(fs.existsSync(doneGateLog), false, 'expired done gate log pruned');

  // Clear refusal (restore valid JSON) -> exactly one collection from the retained evidence.
  fs.writeFileSync(jsonPath, validDoc);
  const firstRetry = await retryPendingFlakeCollections(f.home, f.main, f.env.HERDR_PANE_ID);
  assert.deepEqual(firstRetry, { retried: 1, resolved: 1, pending: 0 });
  assert.equal(f.flowState(flow).flake_collection?.state, 'done');
  assert.equal(f.flowState(flow).flake_collection?.ticket, 'test-flakes/01');
  const t01After = listFlakeRecords(f)[0];
  assert.ok(t01After.comments.some(c => c.text === 'Owner hand edit before retention'), 'owner comment preserved');
  assert.equal(t01After.cases.filter(c => c.case_name === 'alpha survives retention' && c.flow === flow).length, 1, 'collected once');

  const secondRetry = await retryPendingFlakeCollections(f.home, f.main, f.env.HERDR_PANE_ID);
  assert.deepEqual(secondRetry, { retried: 0, resolved: 0, pending: 0 });
  assert.equal(listFlakeRecords(f)[0].cases.length, t01After.cases.length, 'no duplicate collection');

  // Once collection succeeds, the next prune past retention removes the family as before.
  pruneLandFlows(f.home, Date.now() + JOB_RETENTION_MS + 60_000);
  assert.equal(fs.existsSync(receiptPath), false, 'collected receipt pruned');
  assert.equal(fs.existsSync(gateLog), false, 'collected gate log pruned');

  // Independent ticket resolution (done/claimed/wontfix) unpins an expired pending dispatch family on the next prune.
  const docNow = readFlakeDoc(f);
  for (const [idx, resolution] of ['done', 'claimed', 'wontfix'].entries()) {
    const num = idx + 2;
    const numStr = String(num).padStart(2, '0');
    docNow.tickets.push({
      number: num,
      title: 'Gate flakes running list',
      kind: 'flake-list',
      status: 'ready-for-agent',
      owner_try: false,
      live_try: 'none',
      approved_removals: [],
      blocked_by: [],
      what: 'Running list.',
      cases: [{ step: 'gate[1]', test: 'sample/a.test.mjs', case_name: 'case', flow: 'f0000000000000e00', recorded_at: at }],
      acceptance: [{ id: 1, text: 'Pass', done: false }],
      comments: [],
      created_at: at,
      updated_at: at,
    });
    fs.writeFileSync(jsonPath, JSON.stringify(docNow, null, 2) + '\n');
    const dispatchFlow = `f0000000000000e1${idx}`;
    const dispatchReceipt = join(f.home, 'flows', `${dispatchFlow}.json`);
    const dispatchLog = join(f.home, 'flows', `${dispatchFlow}.json.gate-1.log`);
    fs.writeFileSync(dispatchLog, 'synthetic gate excerpt\n');
    fs.writeFileSync(dispatchReceipt, JSON.stringify({
      ...flowReceipt, flow: dispatchFlow, job: `j0000000000000e1${idx}`,
      reruns: [{ step: 'gate[1]', tests: ['case'], output_path: dispatchLog, rerun_ok: true }],
      flake_collection: { state: 'pending', stage: 'dispatch', ticket: `test-flakes/${numStr}`, error: 'waiting for active flake job', attempts: 1, updated_at: flowReceipt.updated_at },
    }));
    fs.utimesSync(dispatchReceipt, expiredSec, expiredSec);
    fs.utimesSync(dispatchLog, expiredSec, expiredSec);

    pruneLandFlows(f.home, now);
    assert.equal(fs.existsSync(dispatchReceipt), true, `pending dispatch kept while ready (${resolution})`);
    assert.equal(fs.existsSync(dispatchLog), true, `pending dispatch gate log kept while ready (${resolution})`);

    docNow.tickets.find(t => t.number === num).status = resolution;
    fs.writeFileSync(jsonPath, JSON.stringify(docNow, null, 2) + '\n');
    pruneLandFlows(f.home, now);
    assert.equal(fs.existsSync(dispatchReceipt), false, `pending dispatch receipt pruned after ${resolution}`);
    assert.equal(fs.existsSync(dispatchLog), false, `pending dispatch gate log pruned after ${resolution}`);
  }
});

test('changing flakes.feature preserves waiting old-feature receipt and evidence; removing config prunes only resolved tickets', { timeout: 30_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [], crossProject: true });
  setFlakesConfig(f, { feature: 'flakes-a' });

  const oldIssues = join(f.main, '.scratch', 'flakes-a', 'issues');
  fs.mkdirSync(oldIssues, { recursive: true });
  const seedReady = (num) => {
    const path = join(oldIssues, `${num}-gate-flakes-running-list.md`);
    fs.writeFileSync(path, [
      `# ${num}: Gate flakes running list`, '', '**Status:** ready-for-agent', '**Owner try:** no', '**Live try:** none', '**Blocked by:** none',
      '', '**What to build:** Running list.', '', '### Cases', '',
      `- \`case ${num}\` (sample/a.test.mjs) — flow \`f0000000000000f0${num}\``, '', '- [ ] Pass', '', '## Comments', '',
    ].join('\n'));
    return path;
  };
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiredSec = (now - JOB_RETENTION_MS - 120_000) / 1000;
  const seedPendingFlow = (flowId, ticket) => {
    const flowsDir = join(f.home, 'flows');
    fs.mkdirSync(flowsDir, { recursive: true });
    const receiptPath = join(flowsDir, `${flowId}.json`);
    const logPath = join(flowsDir, `${flowId}.json.gate-1.log`);
    fs.writeFileSync(logPath, 'synthetic gate excerpt\n');
    fs.writeFileSync(receiptPath, JSON.stringify({
      flow: flowId, job: `j${flowId.slice(1)}`, pane: f.env.HERDR_PANE_ID, task: false,
      wt: { main_root: f.main, root: join(`${f.main}-wt`, 'gone'), base_head: f.base_head, branch: 'wt/gone' },
      config: { base: 'base', gate: ['true'], after: [], push: false },
      state: 'completed', step: 'done', pid: process.pid, start: '1',
      created_at: nowIso, updated_at: nowIso, source_sha: f.base_head,
      reruns: [{ step: 'gate[1]', tests: ['case'], output_path: logPath, rerun_ok: true }],
      flake_collection: {
        state: 'pending', stage: 'dispatch', ticket,
        error: 'waiting for active flake job', attempts: 1, updated_at: nowIso,
      },
    }));
    fs.utimesSync(receiptPath, expiredSec, expiredSec);
    fs.utimesSync(logPath, expiredSec, expiredSec);
    return { receiptPath, logPath };
  };

  // Part A: the configured feature takes precedence over the old ticket's blockers.
  const t02Path = seedReady('02');
  fs.writeFileSync(t02Path, fs.readFileSync(t02Path, 'utf8').replace('**Blocked by:** none', '**Blocked by:** flakes-a/01'));
  f.git(f.main, 'add', '.scratch');
  f.git(f.main, 'commit', '-qm', 'seed flakes-a/02');
  const flowA = 'f0000000000000f02';
  const { receiptPath: receiptA, logPath: logA } = seedPendingFlow(flowA, 'flakes-a/02');

  setFlakesConfig(f, { feature: 'flakes-b' });
  const dispatched = [];
  const retryChanged = await retryPendingFlakeCollections(f.home, f.main, f.env.HERDR_PANE_ID, {
    dispatch: async (input) => { dispatched.push(input.ticket); return { job: 'j0000000000000f99' }; },
  });
  assert.deepEqual(retryChanged, { retried: 1, resolved: 0, pending: 1 });
  assert.deepEqual(dispatched, [], 'must not dispatch old-feature ticket under a different configured feature');
  assert.equal(f.flowState(flowA).flake_collection?.state, 'pending', 'must not acknowledge unresolved old-feature ticket');
  assert.equal(f.flowState(flowA).flake_collection?.ticket, 'flakes-a/02');
  assert.equal(f.flowState(flowA).flake_collection?.error, 'waiting for configured flakes feature');

  // Re-age after retry's receipt update and run retention: evidence must survive.
  fs.utimesSync(receiptA, expiredSec, expiredSec);
  fs.utimesSync(logA, expiredSec, expiredSec);
  pruneLandFlows(f.home, now);
  assert.equal(fs.existsSync(receiptA), true, 'old-feature pending receipt must survive retention while unresolved');
  assert.equal(fs.existsSync(logA), true, 'old-feature gate log must survive retention while unresolved');

  // Independently resolving flakes-a/02 while configured for flakes-b acknowledges the receipt and lets it prune.
  fs.writeFileSync(t02Path, fs.readFileSync(t02Path, 'utf8').replace('**Status:** ready-for-agent', '**Status:** wontfix'));
  const retryResolved = await retryPendingFlakeCollections(f.home, f.main, f.env.HERDR_PANE_ID, {
    dispatch: async () => { throw Error('must not dispatch resolved ticket'); },
  });
  assert.deepEqual(retryResolved, { retried: 1, resolved: 1, pending: 0 });
  assert.equal(f.flowState(flowA).flake_collection?.state, 'done');
  assert.equal(f.flowState(flowA).flake_collection?.job, undefined);
  fs.utimesSync(receiptA, expiredSec, expiredSec);
  fs.utimesSync(logA, expiredSec, expiredSec);
  pruneLandFlows(f.home, now);
  assert.equal(fs.existsSync(receiptA), false, 'resolved old-feature receipt prunes');
  assert.equal(fs.existsSync(logA), false, 'resolved old-feature gate log prunes');

  // Part B: remove flakes config entirely — no worker starts, ready tickets stay pinned,
  // and independently resolved (wontfix/done/claimed) tickets prune.
  setFlakesConfig(f, undefined);
  for (const [idx, resolution] of ['wontfix', 'done', 'claimed'].entries()) {
    const num = String(idx + 3).padStart(2, '0');
    const ticketPath = seedReady(num);
    const flowId = `f0000000000000f1${idx}`;
    const { receiptPath, logPath } = seedPendingFlow(flowId, `flakes-a/${num}`);

    const retryOff = await retryPendingFlakeCollections(f.home, f.main, f.env.HERDR_PANE_ID, {
      dispatch: async () => { throw Error('must not start worker when flakes config is removed'); },
    });
    assert.deepEqual(retryOff, { retried: 0, resolved: 0, pending: 0 });
    assert.equal(f.flowState(flowId).flake_collection?.state, 'pending');

    pruneLandFlows(f.home, now);
    assert.equal(fs.existsSync(receiptPath), true, `ready ticket kept with config removed (${resolution})`);
    assert.equal(fs.existsSync(logPath), true, `ready ticket gate log kept with config removed (${resolution})`);

    if (resolution === 'wontfix') {
      for (const [label, path] of [['checkout', f.main], ['issues directory', oldIssues], ['ticket file', ticketPath]]) {
        const hidden = `${path}.offline`;
        fs.renameSync(path, hidden);
        try {
          pruneLandFlows(f.home, now);
          assert.equal(fs.existsSync(receiptPath), true, `pending receipt kept with missing ${label}`);
          assert.equal(fs.existsSync(logPath), true, `pending gate log kept with missing ${label}`);
        } finally {
          fs.renameSync(hidden, path);
        }
      }
    }

    fs.writeFileSync(ticketPath, fs.readFileSync(ticketPath, 'utf8').replace('**Status:** ready-for-agent', `**Status:** ${resolution}`));
    pruneLandFlows(f.home, now);
    assert.equal(fs.existsSync(receiptPath), false, `receipt prunes with config removed after ${resolution}`);
    assert.equal(fs.existsSync(logPath), false, `gate log prunes with config removed after ${resolution}`);
  }
});

test('a pending dispatch waits for the ticket and its dependency rollup entry', { timeout: 30_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });
  const issuesDir = join(f.main, '.scratch', 'test-flakes', 'issues');
  fs.mkdirSync(issuesDir, { recursive: true });
  const path = join(issuesDir, '01-gate-flakes-running-list.md');
  const ticket = 'test-flakes/01';
  const dispatched = [];
  const retry = () => collectGateFlakes(f.home, f.main, [], f.env.HERDR_PANE_ID, {
    retryDispatch: true,
    pendingTicket: ticket,
    dispatch: async (input) => { dispatched.push(input.ticket); return { job: 'j0000000000000f99' }; },
  });

  // Without the Blocked by field the file is readable but isn't in the dependency rollup.
  const text = '# 01: Gate flakes running list\n\n**Status:** ready-for-agent\n';
  fs.writeFileSync(path, text);
  const withoutRollup = await retry();
  assert.equal(withoutRollup.pending?.ticket, ticket);
  assert.deepEqual(dispatched, [], 'missing readiness evidence must not dispatch');

  fs.renameSync(path, `${path}.offline`);
  const withoutTicket = await retry();
  assert.equal(withoutTicket.pending?.ticket, ticket);
  assert.deepEqual(dispatched, [], 'missing ticket must keep the dispatch pending');

  fs.renameSync(`${path}.offline`, path);
  fs.writeFileSync(path, text + '**Blocked by:** none\n');
  const ready = await retry();
  assert.equal(ready.pending, undefined);
  assert.equal(ready.dispatchedJob, 'j0000000000000f99');
  assert.deepEqual(dispatched, [ticket]);
});

test('running list whose Blocked by names a landed ticket (reference left in place) dispatches exactly one imp', { timeout: 30_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });

  const at = '2026-01-01T00:00:00.000Z';
  const rel = seedJsonTickets(f, 'test-flakes', [
    { number: 1, title: 'Prerequisite', status: 'ready-for-agent', what: 'Prerequisite fix.' },
    {
      number: 2, title: 'Gate flakes running list', kind: 'flake-list', status: 'needs-triage',
      blocked_by: ['test-flakes/01'], what: 'Running list.',
      cases: [{ step: 'gate[1]', test: 'sample/dep.test.mjs', case_name: 'dep flake', flow: 'f0000000000000g01', recorded_at: at }],
    },
  ]);
  f.git(f.main, 'add', rel);
  f.git(f.main, 'commit', '-qm', 'seed prerequisite and blocked running list');

  // While 01 has not landed, reaching threshold promotes 02 but keeps dispatch pending (blocked).
  const dispatched = [];
  const fakeDispatch = async (input) => {
    const id = `j0000000000000e9${dispatched.length + 1}`;
    const dir = join(f.home, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
      job: id, cwd: f.main, project_root: f.main, role: input.role, ticket: input.ticket,
      request_key: input.request_key, created_at: new Date().toISOString(), dispatch_exit_code: 0,
    }));
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
    dispatched.push({ id, ticket: input.ticket });
    return { job: id };
  };

  const blockedRes = await collectGateFlakes(f.home, f.main, [{
    name: 'dep flake',
    file: 'sample/dep.test.mjs',
    flow: 'f0000000000000g02',
    log: join(f.home, 'flows', 'f0000000000000g02.json.gate-1.log'),
  }], f.env.HERDR_PANE_ID, { dispatch: fakeDispatch });
  assert.equal(blockedRes.promoted, true);
  assert.equal(blockedRes.dispatchedJob, undefined);
  assert.equal(blockedRes.pending?.stage, 'dispatch');
  assert.equal(blockedRes.pending?.error, 'ticket is blocked');
  assert.deepEqual(dispatched, []);

  // Land 01 (status done, reference left untouched in 02): retry dispatches exactly one imp for 02.
  const docAfterBlocked = readFlakeDoc(f);
  docAfterBlocked.tickets[0].status = 'done';
  docAfterBlocked.tickets[0].acceptance[0].done = true;
  docAfterBlocked.tickets[0].landing = { at, job: 'j0000000000000001', flow: 'f0000000000000001', replay_base: 'abcdef1', gates: 1, commit: 'abcdef1' };
  fs.writeFileSync(join(f.main, rel), JSON.stringify(docAfterBlocked, null, 2) + '\n');
  const retry = () => collectGateFlakes(f.home, f.main, [], f.env.HERDR_PANE_ID, {
    retryDispatch: true, pendingTicket: 'test-flakes/02', dispatch: fakeDispatch,
  });
  const results = await Promise.all([retry(), retry()]);
  const admittedJobs = results.flatMap(res => res.dispatchedJob ? [res.dispatchedJob] : []);
  assert.deepEqual(admittedJobs, ['j0000000000000e91']);
  assert.ok(results.every(res => res.pending === undefined), 'both retries resolve once the ticket is claimed');
  const claimedRes = await retry();
  assert.equal(claimedRes.pending, undefined);
  assert.equal(claimedRes.dispatchedJob, undefined);
  assert.deepEqual(dispatched.map(d => d.ticket), ['test-flakes/02'], 'concurrent and later retries do not dispatch a duplicate');
  assert.deepEqual(readFlakeDoc(f).tickets[1].blocked_by, ['test-flakes/01'], 'Blocked by reference left in place');

  // Stop job 1 and verify a new running list 03 whose Blocked by already names landed 01
  // dispatches immediately on reaching its threshold (exactly one imp).
  fs.writeFileSync(join(f.home, 'jobs', admittedJobs[0], 'STATUS.json'),
    JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  const docWith03 = readFlakeDoc(f);
  docWith03.tickets.push({
    number: 3, title: 'Gate flakes running list', kind: 'flake-list', status: 'needs-triage',
    owner_try: false, live_try: 'none', approved_removals: [], blocked_by: ['test-flakes/01'], what: 'Running list.',
    cases: [{ step: 'gate[1]', test: 'sample/dep2.test.mjs', case_name: 'ready dep flake', flow: 'f0000000000000g03', recorded_at: at }],
    acceptance: [{ id: 1, text: 'Pass', done: false }], comments: [], created_at: at, updated_at: at,
  });
  fs.writeFileSync(join(f.main, rel), JSON.stringify(docWith03, null, 2) + '\n');
  f.git(f.main, 'add', rel);
  f.git(f.main, 'commit', '-qm', 'seed running list 03 with satisfied Blocked by');

  const directRes = await collectGateFlakes(f.home, f.main, [{
    name: 'ready dep flake',
    file: 'sample/dep2.test.mjs',
    flow: 'f0000000000000g04',
    log: join(f.home, 'flows', 'f0000000000000g04.json.gate-1.log'),
  }], f.env.HERDR_PANE_ID, { dispatch: fakeDispatch });
  assert.equal(directRes.promoted, true);
  assert.equal(directRes.pending, undefined);
  assert.equal(directRes.dispatchedJob, 'j0000000000000e92');
  assert.deepEqual(dispatched.map(d => d.ticket), ['test-flakes/02', 'test-flakes/03']);
  assert.deepEqual(readFlakeDoc(f).tickets[2].blocked_by, ['test-flakes/01'], 'Blocked by reference left in place');
});

test('unattended scan error with a pending flake fallback backs off instead of rescheduling every 1 ms', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });
  seedWaitingFlake(f);

  const control = { enabled: true, root: f.main, objectives: [] };
  fs.writeFileSync(controlPath(f.home), JSON.stringify(control));
  fs.writeFileSync(join(f.home, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: f.main }] }));

  const flakeRetryMs = 30_000;
  const state = { liveJobIds: [], lastIssues: [] };

  // Initial scan sees the pending flake flow and arms flakeRetryAt.
  const first = await runUnattendedScanStep(f.home, control, state, false, flakeRetryMs);
  assert.deepEqual(first.issues, []);
  assert.ok(state.flakeRetryAt !== undefined, 'pending flake fallback armed');
  assert.ok(first.recheckMs !== undefined && first.recheckMs > 20_000 && first.recheckMs <= flakeRetryMs,
    `expected backoff near ${flakeRetryMs}ms, got ${first.recheckMs}`);

  // Registration disappears while the flake fallback deadline has elapsed.
  fs.writeFileSync(join(f.home, 'projects.json'), JSON.stringify({ version: 1, projects: [] }));
  state.flakeRetryAt = performance.now() - 100;

  const afterError = await runUnattendedScanStep(f.home, control, state, false, flakeRetryMs);
  assert.equal(afterError.issues.length, 1);
  assert.match(afterError.issues[0].reason, /no longer registered/i);
  assert.ok(afterError.recheckMs !== undefined && afterError.recheckMs > 20_000 && afterError.recheckMs <= flakeRetryMs,
    `expected scan error to back off near ${flakeRetryMs}ms instead of 1ms, got ${afterError.recheckMs}`);
  assert.ok(state.flakeRetryAt > performance.now(), 'stale deadline advanced past now');
});

function settleDispatchedFlakeJob(f, jobId, reportText, { state = 'idle_grace', timedOutQuestion = false } = {}) {
  const dir = join(f.home, 'jobs', jobId);
  const jobFile = join(dir, 'job.json');
  const receipt = readJson(jobFile);
  // Ensure report mtime is strictly after created_at even when written within the same ms in fast tests.
  const createdMs = Date.parse(receipt.created_at);
  if (Number.isFinite(createdMs)) receipt.created_at = new Date(createdMs - 5_000).toISOString();
  fs.writeFileSync(jobFile, JSON.stringify(receipt));
  const reportFile = join(dir, 'report.md');
  if (timedOutQuestion) {
    const handlers = new Map();
    const statusFile = join(dir, 'STATUS.json');
    let now = 0, timer, idle = false;
    const tab = installTabLifecycle({
      on: (event, fn) => handlers.set(event, fn),
      getThinkingLevel: () => 'high',
      sendMessage: () => assert.fail('a moot timeout must not deliver a default or start a turn'),
    }, {
      taskDir: dir, role: 'imp', profile: 'implementer',
      timing: {
        now: () => now,
        schedule: callback => (timer = callback),
        cancel: () => { timer = undefined; },
      },
    });
    const ctx = {
      mode: 'tui', model: { provider: 'fake', id: 'model', promptCache: { short: 60, long: 60 } },
      sessionManager: { getSessionId: () => 'synthetic-flake-worker', getSessionFile: () => undefined },
      isIdle: () => idle,
    };
    const emit = event => handlers.get(event)({}, ctx);
    emit('session_start');
    emit('before_agent_start');
    const question = publishQuestion(join(dir, 'qa'), { tag: 'imp@demo', question: 'Use the synthetic layout?', default: 'Yes' });
    tab.trackQuestion(ctx, question, 1000);
    fs.writeFileSync(reportFile, reportText);
    tab.reportPublished(ctx);
    idle = true;
    emit('agent_settled');
    assert.equal(readJson(statusFile).state, 'waiting_orchestrator');
    now = 1000;
    timer();
    assert.equal(readJson(statusFile).state, 'idle_grace');
    assert.equal(readJson(statusFile).output_written, true);
    assert.equal(fs.existsSync(question.qfile), true);
    assert.equal(fs.existsSync(question.afile), false);
    assert.deepEqual(readJson(jobFile).timed_out_questions, ['q1']);
    assert.deepEqual(readJson(jobFile).moot_timed_out_questions, ['q1']);
    return;
  }
  fs.writeFileSync(reportFile, reportText);
  const reportStat = fs.statSync(reportFile);
  const settledAt = new Date(Math.max(Date.now(), Math.ceil(reportStat.mtimeMs) + 1000)).toISOString();
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({
    state,
    output_written: true,
    settled_at: settledAt,
    updated_at: settledAt,
  }));
}

function seedAutoFlakeJob(f, { id, ticket, commitFix = true }) {
  const base = f.git(f.main, 'rev-parse', 'HEAD');
  const wtName = `imp-${id.slice(-6)}`;
  const wtRoot = join(`${f.main}-wt`, wtName);
  const branch = `wt/${wtName}`;
  f.git(f.main, 'worktree', 'add', '-qb', branch, wtRoot, base);
  if (commitFix) {
    fs.appendFileSync(join(wtRoot, 'tracked'), `flake fix ${ticket}\n`);
    f.git(wtRoot, 'commit', '-qam', `fix ${ticket}`);
  }
  const dir = join(f.home, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  const createdAt = new Date(Date.now() - 5_000).toISOString();
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
    job: id,
    cwd: wtRoot,
    project_root: f.main,
    role: 'imp',
    ticket,
    request_key: flakeDispatchKey(f.main, ticket, 1),
    auto_land: true,
    caller_pane: f.env.HERDR_PANE_ID,
    herdr_pane: f.env.HERDR_PANE_ID,
    created_at: createdAt,
    dispatch_exit_code: 0,
    worktree: { main_root: f.main, root: wtRoot, base_head: base, branch },
  }));
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', updated_at: createdAt }));
  return { id, dir, jobFile: join(dir, 'job.json'), wtRoot };
}

test('a caller-supplied flakes request key does not auto-land a manual worktree job', { timeout: 35_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });
  const base = f.git(f.main, 'rev-parse', 'HEAD');
  const request_key = 'flakes:investigate';
  const { job } = await f.call('hud_create', {
    role: 'imp', cwd: f.main, isolation: 'worktree', task: 'Investigate a synthetic flake.', request_key,
  });
  assert.ok(job);
  const receipt = readJson(join(f.home, 'jobs', job, 'job.json'));
  assert.equal(receipt.request_key, request_key);
  assert.equal(receipt.auto_land, undefined);
  fs.appendFileSync(join(receipt.worktree.root, 'tracked'), 'manual flake fix\n');
  f.git(receipt.worktree.root, 'commit', '-qam', 'fix synthetic flake');
  settleDispatchedFlakeJob(f, job, 'Fixed a synthetic flake.\nBlockers: none\n', { state: 'closed' });

  // Run the same settlement the watcher uses, without depending on when its scan runs.
  assert.deepEqual(await settleAutoLandFlakeJob(f.home, job), { action: 'noop' });
  assert.equal(fs.existsSync(join(f.home, 'flows', `f${job.slice(1)}.json`)), false);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), base);
  assert.equal(f.git(f.main, 'rev-parse', 'origin/base'), base);

  const { flow } = await f.call('hud_land', { job });
  assert.ok(flow);
  await until(() => f.flowState(flow).state === 'completed', t.signal);
  assert.notEqual(f.flowState(flow).auto_land, true);
  assert.match(fs.readFileSync(join(f.main, 'tracked'), 'utf8'), /manual flake fix/);
});

test('a promoted flake that asks, reports, then times out lands without a main call or completion notice', { timeout: 45_000 }, async t => {
  const f = await checkout(t, ['npm run test:sample'], { after: ['test "$WRAPPED" = yes && pwd > after-ran'] });
  setFlakesConfig(f, { feature: 'test-flakes' });

  // Trigger two rerun-pass gates on the same test so test-flakes/01 promotes and dispatches automatically.
  for (const [idx, id] of ['j0000000000000a11', 'j0000000000000a12'].entries()) {
    addFlakyTestJob(f, {
      id,
      testFile: 'alpha.test.mjs',
      testName: 'alpha recovers',
      markerName: `auto-land-alpha-${idx + 1}`,
    });
    const { flow } = await f.call('hud_land', { job: id });
    await until(() => f.flowState(flow).state === 'completed' && f.flowState(flow).flake_collection?.state === 'done', t.signal);
  }

  await until(() => listFlakeJobs(f).some(j => j.ticket === 'test-flakes/01' && j.worktree?.root && fs.existsSync(join(f.home, 'jobs', j.job, 'brief.md'))), t.signal);
  const [dispatched] = listFlakeJobs(f);
  assert.equal(dispatched.auto_land, true);
  assert.match(fs.readFileSync(join(f.home, 'jobs', dispatched.job, 'brief.md'), 'utf8'), /Auto-land rule:/);

  // Start watching main notices after initial setup lands have already settled.
  const mainNotices = [];
  const stopWatch = startSessionWatch(f.home, f.env.HERDR_PANE_ID, f.main, lines => mainNotices.push(...lines), 50);
  t.after(stopWatch);
  await until(() => mainNotices.length >= 0, t.signal);
  mainNotices.length = 0;

  // Worker fixes the flaky test in its managed worktree, commits, writes a clean report, and settles in idle_grace.
  fs.writeFileSync(join(dispatched.worktree.root, 'sample', 'alpha.test.mjs'), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "test('alpha recovers', () => assert.ok(true));",
    '',
  ].join('\n'));
  f.git(dispatched.worktree.root, 'add', 'sample/alpha.test.mjs');
  f.git(dispatched.worktree.root, 'commit', '-qm', 'fix alpha flake');
  settleDispatchedFlakeJob(f, dispatched.job, 'Fixed alpha flake.\nAssumed: kept synthetic test layout\nBlockers: none\n', { timedOutQuestion: true });

  // Without any hud_land call from main, HUD starts the land flow through the project's land block.
  const autoFlow = `f${dispatched.job.slice(1)}`;
  const flowFile = join(f.home, 'flows', `${autoFlow}.json`);
  await until(() => fs.existsSync(flowFile) && f.flowState(autoFlow).state === 'completed', t.signal);

  const landedFlow = f.flowState(autoFlow);
  assert.equal(landedFlow.auto_land, true);
  assert.equal(landedFlow.landed_sha, f.git(f.main, 'rev-parse', 'HEAD'));
  assert.equal(f.git(f.main, 'rev-parse', 'origin/base'), landedFlow.landed_sha);
  assert.equal(fs.existsSync(join(f.main, 'after-ran')), true, 'project land after command ran');
  assert.equal(listFlakeRecords(f).find(r => r.number === 1)?.status, 'done');
  assert.deepEqual(workflowEvents(f.home, f.env.HERDR_PANE_ID, false, f.main).lines, [], 'no completion notice for auto-landed flake');
  // The question itself can be announced before it times out; the clean land is silent.
  assert.equal(mainNotices.some(line => line.includes(autoFlow) ||
    (line.includes(dispatched.job) && !line.includes('QUESTION q1:'))), false,
    `expected no completion notice on clean auto-land, got: ${JSON.stringify(mainNotices)}`);
});

test('auto-land hands back without calling startLand when QA cannot be read', async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });
  const seeded = seedAutoFlakeJob(f, { id: 'j0000000000000a20', ticket: 'test-flakes/01' });
  const base = f.git(f.main, 'rev-parse', 'origin/base');
  fs.writeFileSync(join(seeded.dir, 'qa'), 'not a directory\n');
  settleDispatchedFlakeJob(f, seeded.id, 'Fixed flake.\nBlockers: none\n');

  const startLandFn = t.mock.fn();
  const result = await settleAutoLandFlakeJob(f.home, seeded.id, { startLandFn });
  assert.equal(result.action, 'blocked');
  assert.equal(result.reason, 'questions could not be read');
  assert.ok(result.sig);
  assert.equal(readJson(seeded.jobFile).auto_land_blocked?.sig, result.sig);
  assert.deepEqual(await settleAutoLandFlakeJob(f.home, seeded.id, { startLandFn }), { action: 'noop' });
  assert.equal(startLandFn.mock.callCount(), 0);
  assert.equal(f.git(f.main, 'rev-parse', 'origin/base'), base);
});

test('promoted flake auto-land notifies main on land failure', { timeout: 35_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });

  const seeded = seedAutoFlakeJob(f, { id: 'j0000000000000a21', ticket: 'test-flakes/01', commitFix: true });
  // Make main dirty on a file touched by the worker so fast-forward fails deterministically without repair rounds.
  fs.appendFileSync(join(f.main, 'tracked'), 'dirty owner edit\n');

  const mainNotices = [];
  const stopWatch = startSessionWatch(f.home, f.env.HERDR_PANE_ID, f.main, lines => mainNotices.push(...lines), 50);
  t.after(stopWatch);

  settleDispatchedFlakeJob(f, seeded.id, 'Fixed flake.\nBlockers: none\n');
  ensureJobWatcher(f.home);

  const autoFlow = `f${seeded.id.slice(1)}`;
  const flowFile = join(f.home, 'flows', `${autoFlow}.json`);
  await until(() => fs.existsSync(flowFile) && f.flowState(autoFlow).state === 'failed', t.signal);
  assert.equal(f.flowState(autoFlow).auto_land, true);

  await until(() => mainNotices.some(line => line.includes(autoFlow) && line.includes('failed')), t.signal);
  assert.ok(mainNotices.some(line => line.includes(autoFlow) && line.includes(seeded.id) && line.includes('failed')),
    `expected land failure notice to main, got: ${JSON.stringify(mainNotices)}`);
});

test('flake report with a Blockers line or scope assumption does not land and notifies main', { timeout: 35_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });

  const mainNotices = [];
  const stopWatch = startSessionWatch(f.home, f.env.HERDR_PANE_ID, f.main, lines => mainNotices.push(...lines), 50);
  t.after(stopWatch);

  const cases = [
    {
      id: 'j0000000000000a31',
      ticket: 'test-flakes/01',
      commitFix: true,
      timedOutQuestion: true,
      report: 'Investigated flake.\nBlockers: needs an owner decision on relaxing the timeout bound\n',
      expectedReason: /Blockers: needs an owner decision/i,
    },
    {
      id: 'j0000000000000a32',
      ticket: 'test-flakes/02',
      commitFix: true,
      report: 'Fixed flake.\nAssumed: scope: also refactored unrelated polling loop\nBlockers: none\n',
      expectedReason: /scope assumption/i,
    },
    {
      id: 'j0000000000000a33',
      ticket: 'test-flakes/03',
      commitFix: false,
      report: 'Could not reproduce the flake locally.\nBlockers: none\n',
      expectedReason: /without a commit/i,
    },
  ];

  for (const item of cases) {
    const seeded = seedAutoFlakeJob(f, { id: item.id, ticket: item.ticket, commitFix: item.commitFix });
    settleDispatchedFlakeJob(f, seeded.id, item.report, { timedOutQuestion: item.timedOutQuestion });
    ensureJobWatcher(f.home);

    await until(() => Boolean(readJson(seeded.jobFile).auto_land_blocked), t.signal);
    const receipt = readJson(seeded.jobFile);
    assert.match(receipt.auto_land_blocked.reason, item.expectedReason);
    assert.equal(fs.existsSync(join(f.home, 'flows', `f${seeded.id.slice(1)}.json`)), false,
      `must not start land flow for ${item.ticket}`);

    await until(() => mainNotices.some(line => line.includes(seeded.id) && item.expectedReason.test(line)), t.signal);

    // Re-evaluating the same report signature is a no-op and does not start a land.
    const again = await settleAutoLandFlakeJob(f.home, seeded.id);
    assert.deepEqual(again, { action: 'noop' });
  }
});

test('after an actual partial flake land (item left under Not done), the ticket appears in hud_tickets ready, is admitted by a queue run, and stays eligible after retention', { timeout: 45_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });

  const at = '2026-01-01T00:00:00.000Z';
  const rel = seedJsonTickets(f, 'test-flakes', [{
    number: 1,
    title: 'Gate flakes running list',
    kind: 'flake-list',
    status: 'ready-for-agent',
    what: 'Running list of synthetic gate flakes.',
    cases: [
      { step: 'gate[1]', test: 'sample/alpha.test.mjs', case_name: 'alpha flake', flow: 'f0000000000000a40', recorded_at: at },
      { step: 'gate[1]', test: 'sample/beta.test.mjs', case_name: 'beta flake', flow: 'f0000000000000a41', recorded_at: at },
    ],
    acceptance: [
      { id: 1, text: 'Each listed case passes 20 consecutive runs under parallel load', done: false },
      { id: 2, text: 'No assertion or product bound weakened', done: false },
    ],
  }]);
  f.git(f.main, 'add', rel);
  f.git(f.main, 'commit', '-qm', 'seed flake list');
  f.git(f.main, 'push', '-q', 'origin', 'base');

  const first = seedAutoFlakeJob(f, { id: 'j0000000000000a41', ticket: 'test-flakes/01', commitFix: true });
  settleDispatchedFlakeJob(f, first.id, [
    'Fixed beta flake only.',
    '',
    '## Not done',
    '- #1 Each listed case passes 20 consecutive runs under parallel load',
    '',
    'Blockers: none',
    '',
  ].join('\n'), { state: 'closed' });

  const { flow } = await f.call('hud_land', { job: first.id });
  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), t.signal);
  const landed = f.flowState(flow);
  assert.equal(landed.state, 'completed', JSON.stringify(landed));
  assert.deepEqual(landed.unfinished_acceptance, [
    { id: 1, text: 'Each listed case passes 20 consecutive runs under parallel load' },
  ]);

  const [record] = listFlakeRecords(f);
  assert.equal(record.status, 'ready-for-agent');
  assert.equal(record.landing?.flow, flow);
  assert.deepEqual(record.acceptance.map(item => [item.id, item.done]), [[1, false], [2, true]]);
  assert.equal(listFlakeJobs(f).length, 1, 'partial land must not immediately auto-loop another flake dispatch');

  // While the closed source job and land receipt are still retained, the ticket appears in hud_tickets ready
  // and advances the flake dispatch attempt counter for any follow-up collector dispatch.
  const admission = runningListAdmission(f.home, f.main, 'test-flakes');
  assert.equal(admission.eligible('test-flakes/01'), true);
  assert.equal(admission.nextAttempt('test-flakes/01'), 2);
  const ready = await f.call('hud_tickets', { op: 'ready', cwd: f.main });
  assert.equal(ready.tickets.some(item => item.ticket === 'test-flakes/01'), true, JSON.stringify(ready));

  // A queue run admits the partially landed flake list for its remaining item.
  const started = await f.call('hud_tickets', { op: 'run', feature: 'test-flakes', max_parallel: 1, cwd: f.main });
  assert.ok(started.flow, JSON.stringify(started));
  await until(() => {
    const q = f.flowState(started.flow);
    assert.equal(q.state, 'working', JSON.stringify(q));
    return q.tickets.some(item => item.ticket === 'test-flakes/01' && item.job && item.job !== first.id);
  }, t.signal);
  const admitted = f.flowState(started.flow).tickets.find(item => item.ticket === 'test-flakes/01');
  assert.ok(admitted?.job && admitted.job !== first.id, JSON.stringify(admitted));
  const followUpJob = readJson(join(f.home, 'jobs', admitted.job, 'job.json'));
  assert.equal(followUpJob.ticket, 'test-flakes/01');
  assert.equal(followUpJob.dispatch_exit_code, 0);

  // While the follow-up queue job is active, hud_tickets ready hides the ticket again.
  const whileActive = await f.call('hud_tickets', { op: 'ready', cwd: f.main });
  assert.equal(whileActive.tickets.some(item => item.ticket === 'test-flakes/01'), false, JSON.stringify(whileActive));

  // Stop the queue run and remove job/flow receipts to simulate post-retention state:
  // the collector must still treat the partial record.landing as ready (not resolved).
  const cancelled = await f.call('hud_tickets', { op: 'run', feature: 'test-flakes', cancel: true, cwd: f.main });
  assert.equal(cancelled.cancel_requested, true, JSON.stringify(cancelled));
  await until(() => f.flowState(started.flow).state === 'cancelled', t.signal);
  for (const id of [first.id, admitted.job]) {
    fs.rmSync(join(f.home, 'jobs', id), { recursive: true, force: true });
  }
  fs.rmSync(join(f.home, 'flows', `${flow}.json`), { force: true });

  const dispatched = [];
  const retry = await collectGateFlakes(f.home, f.main, [], f.env.HERDR_PANE_ID, {
    retryDispatch: true,
    pendingTicket: 'test-flakes/01',
    dispatch: async (input) => {
      dispatched.push(input);
      return { job: 'j0000000000000a49' };
    },
  });
  assert.equal(retry.pending, undefined);
  assert.equal(retry.dispatchedJob, 'j0000000000000a49');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].ticket, 'test-flakes/01');

  const scanned = await collectGateFlakes(f.home, f.main, [], f.env.HERDR_PANE_ID, {
    landedTickets: ['test-flakes/99'],
    dispatch: async (input) => {
      dispatched.push(input);
      return { job: 'j0000000000000a4a' };
    },
  });
  assert.equal(scanned.pending, undefined);
  assert.equal(scanned.dispatchedJob, 'j0000000000000a4a');
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[1].ticket, 'test-flakes/01');
});

test('an active flake attempt still blocks a duplicate dispatch', { timeout: 35_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });

  const at = '2026-01-01T00:00:00.000Z';
  const rel = seedJsonTickets(f, 'test-flakes', [{
    number: 1,
    title: 'Gate flakes running list',
    kind: 'flake-list',
    status: 'ready-for-agent',
    what: 'Running list of synthetic gate flakes.',
    cases: [
      { step: 'gate[1]', test: 'sample/alpha.test.mjs', case_name: 'alpha flake', flow: 'f0000000000000a50', recorded_at: at },
    ],
    acceptance: [
      { id: 1, text: 'Each listed case passes 20 consecutive runs under parallel load', done: false },
      { id: 2, text: 'No assertion or product bound weakened', done: false },
    ],
  }]);
  f.git(f.main, 'add', rel);
  f.git(f.main, 'commit', '-qm', 'seed flake list');
  f.git(f.main, 'push', '-q', 'origin', 'base');

  const active = seedAutoFlakeJob(f, { id: 'j0000000000000a51', ticket: 'test-flakes/01', commitFix: true });
  const statusFile = join(active.dir, 'STATUS.json');
  const activeFlowId = `f${active.id.slice(1)}`;
  const activeFlowFile = join(f.home, 'flows', `${activeFlowId}.json`);

  const assertBlocked = async (label) => {
    const ready = await f.call('hud_tickets', { op: 'ready', cwd: f.main });
    assert.equal(ready.tickets.some(item => item.ticket === 'test-flakes/01'), false, `${label}: hidden from hud_tickets ready`);

    let collectorDispatched = 0;
    const collectorRes = await collectGateFlakes(f.home, f.main, [], f.env.HERDR_PANE_ID, {
      retryDispatch: true,
      pendingTicket: 'test-flakes/01',
      dispatch: async () => {
        collectorDispatched++;
        return { job: 'j0000000000000a59' };
      },
    });
    assert.equal(collectorDispatched, 0, `${label}: collector must not dispatch a duplicate`);
    assert.equal(collectorRes.dispatchedJob, undefined, `${label}: no duplicate job returned`);

    const runRes = await f.call('hud_tickets', { op: 'run', feature: 'test-flakes', max_parallel: 1, cwd: f.main });
    if (runRes.flow) {
      await until(() => ['completed', 'failed', 'cancelled'].includes(f.flowState(runRes.flow).state), t.signal);
      assert.deepEqual(f.flowState(runRes.flow).tickets, [], `${label}: queue run must not admit a duplicate for an active flake attempt`);
    }
    assert.equal(listFlakeJobs(f).length, 1, `${label}: still only the original flake job exists`);
  };

  // 1. Worker actively working.
  await assertBlocked('working');

  // 2. Worker settled in idle_grace, not yet landed.
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'idle_grace', output_written: true, settled_at: new Date().toISOString() }));
  await assertBlocked('idle_grace');

  // 3. Worker closed with an active land flow in progress.
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  fs.mkdirSync(join(f.home, 'flows'), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(activeFlowFile, JSON.stringify({
    flow: activeFlowId,
    job: active.id,
    pane: f.env.HERDR_PANE_ID,
    task: false,
    wt: { main_root: f.main, root: active.wtRoot, base_head: f.base_head, branch: `wt/imp-${active.id.slice(-6)}` },
    config: { base: 'base', gate: ['true'], after: [], push: false },
    state: 'running',
    step: 'gate[1]',
    pid: process.pid,
    start: procStat(process.pid).start,
    created_at: now,
    updated_at: now,
    source_sha: f.base_head,
  }));
  await assertBlocked('active-land');

  // 4. Worker closed with no completed landing yet.
  fs.rmSync(activeFlowFile, { force: true });
  await assertBlocked('closed-unlanded');
});
