import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import {
  collectAndRecordLandFlakes, collectGateFlakes, flakeDispatchKey, retryPendingFlakeCollections,
} from '../../dist/mcp/land-flakes.js';
import { landNotice } from '../../dist/mcp/land-state.js';
import { cleanupFixture } from '../helpers/process-cleanup.mjs';
import { until } from '../helpers/thin-mcp-harness.mjs';
import { checkout } from '../helpers/thin-mcp-land.mjs';

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
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.flowState(flow).landed_sha);
  assert.deepEqual(listFlakeJobs(f), []);
});

test('rerun-pass gate appends one entry, repeat dispatches one imp job, and next flake opens a new ticket', { timeout: 45_000 }, async t => {
  const f = await checkout(t, ['npm run test:sample'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });

  // First rerun-pass gate: creates running-list ticket 01 (needs-triage), commits only that ticket, no dispatch.
  const job1 = 'j0000000000000301';
  addFlakyTestJob(f, {
    id: job1,
    branchName: 'flake-1',
    testFile: 'alpha.test.mjs',
    testName: 'alpha recovers',
    markerName: 'repeat-alpha-1',
  });
  const { flow: flow1 } = await f.call('hud_land', { job: job1 });
  await until(() => f.flowState(flow1).state === 'completed' && listTickets(f).length === 1 &&
    f.git(f.main, 'log', '-1', '--format=%s') === 'tickets: test-flakes/01 flake', t.signal);

  const [t1] = listTickets(f);
  const log1 = f.flowState(flow1).reruns[0].output_path;
  assert.match(t1.text, /\*\*Status:\*\* needs-triage/);
  assert.ok(t1.text.includes('`alpha recovers` (sample/alpha.test.mjs)'), t1.text);
  assert.ok(t1.text.includes(flow1), t1.text);
  assert.ok(t1.text.includes(log1), t1.text);
  assert.deepEqual(
    f.git(f.main, 'show', '--format=%s', '--name-only', 'HEAD').split('\n').filter(Boolean),
    ['tickets: test-flakes/01 flake', t1.rel],
  );
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', t1.rel), '');
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

  const [t1After] = listTickets(f);
  const log2 = f.flowState(flow2).reruns[0].output_path;
  assert.match(t1After.text, /\*\*Status:\*\* ready-for-agent/);
  assert.ok(t1After.text.includes(flow1) && t1After.text.includes(flow2), t1After.text);
  assert.ok(t1After.text.includes(log2), t1After.text);
  assert.deepEqual(
    f.git(f.main, 'show', '--format=%s', '--name-only', 'HEAD').split('\n').filter(Boolean),
    ['tickets: test-flakes/01 flake', t1After.rel],
  );
  const [dispatched] = listFlakeJobs(f);
  assert.equal(dispatched.role, 'imp');
  assert.equal(dispatched.ticket, 'test-flakes/01');
  assert.ok(dispatched.worktree?.root, 'dispatched in a managed worktree');
  const brief = fs.readFileSync(join(f.home, 'jobs', dispatched.job, 'brief.md'), 'utf8');
  assert.ok(brief.includes('alpha recovers'), brief);

  // Third rerun-pass gate while ticket 01 is claimed by the live job: opens a NEW running-list ticket 02.
  const job3 = 'j0000000000000303';
  addFlakyTestJob(f, {
    id: job3,
    branchName: 'flake-3',
    testFile: 'beta.test.mjs',
    testName: 'beta recovers',
    markerName: 'repeat-beta-3',
  });
  const { flow: flow3 } = await f.call('hud_land', { job: job3 });
  await until(() => f.flowState(flow3).state === 'completed' && listTickets(f).length === 2 &&
    f.git(f.main, 'log', '-1', '--format=%s') === 'tickets: test-flakes/02 flake', t.signal);

  const [, t2] = listTickets(f);
  assert.match(t2.text, /\*\*Status:\*\* needs-triage/);
  assert.ok(t2.text.includes('`beta recovers` (sample/beta.test.mjs)'), t2.text);
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
  assert.match(listTickets(f)[0].text, /\*\*Status:\*\* needs-triage/);

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
  assert.match(listTickets(f)[0].text, /\*\*Status:\*\* ready-for-agent/);

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
  assert.match(listTickets(f)[1].text, /\*\*Status:\*\* ready-for-agent/);

  // Once job 1 finishes and lands via hud_land, ticket 01 becomes done and ticket 02 dispatches automatically.
  fs.writeFileSync(join(f.home, 'jobs', 'j0000000000000401', 'STATUS.json'),
    JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  const { flow: landFix1 } = await f.call('hud_land', { job: 'j0000000000000401' });
  await until(() => f.flowState(landFix1).state === 'completed' &&
    listFlakeJobs(f).some(j => j.ticket === 'test-flakes/02' && j.worktree?.root), t.signal);
  assert.match(listTickets(f)[0].text, /\*\*Status:\*\* done/);
  const jobFor02 = listFlakeJobs(f).find(j => j.ticket === 'test-flakes/02');
  assert.equal(jobFor02.role, 'imp');
});

test('no flake ticket edit occurs while the main-checkout lease is held (by land or another caller)', { timeout: 30_000 }, async t => {
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
  assert.equal(listTickets(f).length, 0, 'must not edit flake ticket while land holds main-checkout');

  fs.writeFileSync(join(f.env.HOME, 'release-gate2'), '');
  await until(() => f.flowState(flow).state === 'completed' && listTickets(f).length === 1 &&
    f.git(f.main, 'log', '-1', '--format=%s') === 'tickets: test-flakes/01 flake', t.signal);

  // Part B: another caller holds main-checkout lease while collectGateFlakes runs.
  const granted = await f.call('hud_lease', { name: 'main-checkout', wait_s: 2 });
  assert.equal(granted.granted, true);
  const headBefore = f.git(f.main, 'rev-parse', 'HEAD');
  const ticketBefore = listTickets(f)[0].text;

  let settled = false;
  const pending = collectGateFlakes(f.home, f.main, [{
    name: 'delta recovers',
    file: 'sample/delta.test.mjs',
    flow: 'f0000000000000502',
    log: join(f.home, 'flows', 'f0000000000000502.json.gate-1.log'),
  }], f.env.HERDR_PANE_ID).finally(() => { settled = true; });

  // Confirm lease is genuinely held by verifying another 0s attempt is rejected, and no edit occurred.
  const checkLease = await f.call('hud_lease', { name: 'main-checkout', wait_s: 0 });
  assert.equal(checkLease.granted, true, 'main session still holds main-checkout');
  assert.equal(settled, false);
  assert.equal(listTickets(f)[0].text, ticketBefore, 'no ticket edit while external lease is held');
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), headBefore);

  await f.call('hud_lease', { name: 'main-checkout', release: true });
  const res = await pending;
  assert.equal(res.ticket, 'test-flakes/01');
  assert.ok(listTickets(f)[0].text.includes('`delta recovers` (sample/delta.test.mjs)'));
  assert.notEqual(f.git(f.main, 'rev-parse', 'HEAD'), headBefore);
});

test('creates a new running-list ticket when newest is done or claimed, and appends to legacy hand-written running lists', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  setFlakesConfig(f, { feature: 'test-flakes' });

  const issuesDir = join(f.main, '.scratch', 'test-flakes', 'issues');
  fs.mkdirSync(issuesDir, { recursive: true });
  // Seed a done ticket (01) and a claimed ticket (02).
  fs.writeFileSync(join(issuesDir, '01-gate-flakes-running-list.md'), [
    '# 01: Gate flakes running list', '', '**Status:** done', '**Owner try:** no', '**Live try:** none', '**Blocked by:** none',
    '', '**What to build:** Running list.', '', '- [x] Done', '', '## Comments', '',
  ].join('\n'));
  fs.writeFileSync(join(issuesDir, '02-gate-flakes-collected-after-test-flakes-01.md'), [
    '# 02: Gate flakes collected after test-flakes/01', '', '**Status:** claimed', '**Owner try:** no', '**Live try:** none', '**Blocked by:** none',
    '', '**What to build:** Running list.', '', '- [ ] Pending', '', '## Comments', '',
  ].join('\n'));
  f.git(f.main, 'add', '.scratch');
  f.git(f.main, 'commit', '-qm', 'seed flake tickets');

  const r1 = await collectGateFlakes(f.home, f.main, [{
    name: 'epsilon recovers',
    file: 'tests/unit/epsilon.test.mjs',
    flow: 'f0000000000000601',
    log: join(f.home, 'flows', 'f0000000000000601.json.gate-1.log'),
  }], null);
  assert.equal(r1.created, true);
  assert.equal(r1.ticket, 'test-flakes/03');
  assert.match(listTickets(f)[2].text, /# 03: Gate flakes collected after test-flakes\/02/);

  // Seed a legacy hand-written running-list ticket (04) with 3 inline cases in What to build.
  fs.writeFileSync(join(issuesDir, '04-gate-flakes-collected-after-test-flakes-03.md'), [
    '# 04: Gate flakes collected after test-flakes/03',
    '',
    '**Status:** needs-triage',
    '**Owner try:** no',
    '**Blocked by:** none',
    '',
    '**What to build:** Running list; dispatch when it has a few entries or a case repeats. Cases: (1) `legacy one` (tests/unit/one.test.mjs), gate f1111111111111111. (2) `legacy two` (tests/unit/two.test.mjs) and `legacy three` (tests/unit/three.test.mjs), gate f2222222222222222.',
    '',
    '- [ ] Each listed case passes 20 consecutive runs',
    '- [ ] Live try: none',
    '',
    '## Comments',
    '',
  ].join('\n'));
  f.git(f.main, 'add', '.scratch');
  f.git(f.main, 'commit', '-qm', 'seed legacy running list');

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
  assert.match(listTickets(f)[3].text, /\*\*Status:\*\* ready-for-agent/);
  assert.ok(listTickets(f)[3].text.includes('### Cases\n\n- `legacy four` (tests/unit/four.test.mjs)'));
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
    assert.equal(listTickets(f).length, 1);
    assert.match(listTickets(f)[0].text, /\*\*Status:\*\* needs-triage/, `must not promote after ${i} unidentified failures`);
    assert.deepEqual(listFlakeJobs(f), [], `must not dispatch after ${i} unidentified failures`);
  }

  const ticketText = listTickets(f)[0].text;
  for (const flow of flows) {
    assert.ok(ticketText.includes(`unidentified failure (\`gate[1]: ${gateCmd}\`) — flow \`${flow}\``), ticketText);
    assert.ok(ticketText.includes(f.flowState(flow).reruns[0].output_path), ticketText);
  }

  // The 4th case reaches the 4-case list threshold and dispatches one imp.
  makePlainJob('j0000000000000804', 'plain-4');
  const { flow: flow4 } = await f.call('hud_land', { job: 'j0000000000000804' });
  await until(() => f.flowState(flow4).state === 'completed' &&
    f.flowState(flow4).flake_collection?.state === 'done' &&
    listFlakeJobs(f).length === 1, t.signal);
  assert.match(listTickets(f)[0].text, /\*\*Status:\*\* ready-for-agent/);
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
  const issuesDir = join(f.main, '.scratch', 'test-flakes', 'issues');
  fs.mkdirSync(issuesDir, { recursive: true });
  const t01Path = join(issuesDir, '01-gate-flakes-running-list.md');
  fs.writeFileSync(t01Path, [
    '# 01: Gate flakes running list', '', '**Status:** needs-triage', '**Owner try:** no', '**Live try:** none', '**Blocked by:** none',
    '', '**What to build:** Running list.', '', '### Cases', '',
    '- `retry case` (sample/retry.test.mjs) — flow `f0000000000000901`, log `~/.hud/flows/f0000000000000901.json.gate-1.log`', '',
    '- [ ] Each listed case passes 20 consecutive runs', '', '## Comments', '',
  ].join('\n'));
  f.git(f.main, 'add', '.scratch');
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

  // Part A: hand edit on the open running-list ticket causes ticket edit refusal.
  const issuesDir = join(f.main, '.scratch', 'test-flakes', 'issues');
  fs.mkdirSync(issuesDir, { recursive: true });
  const t01Path = join(issuesDir, '01-gate-flakes-running-list.md');
  fs.writeFileSync(t01Path, [
    '# 01: Gate flakes running list', '', '**Status:** needs-triage', '**Owner try:** no', '**Live try:** none', '**Blocked by:** none',
    '', '**What to build:** Running list.', '', '### Cases', '',
    '- `initial case` (sample/initial.test.mjs) — flow `f0000000000000001`, log `~/.hud/flows/f0000000000000001.json.gate-1.log`', '',
    '- [ ] Each listed case passes 20 consecutive runs', '', '## Comments', '',
  ].join('\n'));
  f.git(f.main, 'add', '.scratch');
  f.git(f.main, 'commit', '-qm', 'seed flake 01');

  const ownerEdit = '\n- Owner hand note\n';
  fs.appendFileSync(t01Path, ownerEdit);
  const dirtyText = fs.readFileSync(t01Path, 'utf8');

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
  assert.match(f1.flake_collection.error, /uncommitted or hidden changes/);
  assert.match(landNotice(f1), /Flake collection pending \(edit\)/);
  assert.equal(fs.readFileSync(t01Path, 'utf8'), dirtyText, 'owner hand edit stays intact');
  const gateRunsAfterLand1 = fs.readFileSync(join(f.env.HOME, 'gate-runs.log'), 'utf8').trim().split('\n').length;

  // Owner commits their hand edit, then the next clean land retries flow1 from its recorded rerun (no gate rerun for flow1).
  f.git(f.main, 'add', t01Path);
  f.git(f.main, 'commit', '-qm', 'owner hand edit');

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
  const t01AfterRetry = fs.readFileSync(t01Path, 'utf8');
  assert.ok(t01AfterRetry.includes('Owner hand note'), 'owner hand edit preserved');
  assert.ok(t01AfterRetry.includes(`\`alpha recovers\` (sample/alpha.test.mjs) — flow \`${flow1}\``), t01AfterRetry);
  const gateRunsAfterLand2 = fs.readFileSync(join(f.env.HOME, 'gate-runs.log'), 'utf8').trim().split('\n').length;
  assert.equal(gateRunsAfterLand2, gateRunsAfterLand1 + 1, 'only job2 ran its gate once; flow1 retry did not rerun the gate');

  // Calling retryPendingFlakeCollections / collectAndRecordLandFlakes again is an idempotent no-op.
  const headBeforeIdemp = f.git(f.main, 'rev-parse', 'HEAD');
  const again = await retryPendingFlakeCollections(f.home, f.main, f.env.HERDR_PANE_ID);
  assert.deepEqual(again, { retried: 0, resolved: 0, pending: 0 });
  await collectAndRecordLandFlakes(f.home, f.main, f.flowState(flow1));
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), headBeforeIdemp, 'idempotent retry makes no extra commit');
  assert.equal(fs.readFileSync(t01Path, 'utf8').split(flow1).length - 1, 2, 'flow1 appears once in flow id and once in log path');

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
  assert.match(fs.readFileSync(t01Path, 'utf8'), /\*\*Status:\*\* ready-for-agent/);
  assert.deepEqual(listFlakeJobs(f), [], 'no flake imp created while dispatch refused');
  const gateRunsBeforeService = fs.readFileSync(join(f.env.HOME, 'gate-runs.log'), 'utf8').trim().split('\n').length;
  const ticketCountBeforeService = listTickets(f).length;

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
  assert.equal(listTickets(f).length, ticketCountBeforeService, 'retry did not duplicate into a new ticket');
  assert.equal(fs.readFileSync(join(f.env.HOME, 'gate-runs.log'), 'utf8').trim().split('\n').length, gateRunsBeforeService, 'service wake retry did not rerun any gate');
});
