import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { collectGateFlakes } from '../../dist/mcp/land-flakes.js';
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
