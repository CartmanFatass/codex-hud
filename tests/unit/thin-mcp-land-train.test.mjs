import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { tryAbstractLock, withAbstractLock } from '../../dist/utils/abstract-lock.js';
import { stopChild } from '../helpers/process-cleanup.mjs';
import { until } from '../helpers/thin-mcp-harness.mjs';
import { assertLandingRecord, checkout, job, jobDir, repair, seedJsonTickets, settle } from '../helpers/thin-mcp-land.mjs';

const timeout = 60_000;

async function trainCheckout(t, gate = 'true') {
  const f = await checkout(t, [`if test ! -f "$HOME/started"; then
    touch "$HOME/started"; while test ! -f "$HOME/release"; do sleep .05; done
  fi
  git rev-parse HEAD >> "$HOME/gate-heads"
  ${gate}`], { after: ['git rev-parse HEAD >> "$HOME/after-heads"'] });
  const log = file => fs.readFileSync(join(f.env.HOME, file), 'utf8').trim().split('\n');
  const rows = [];
  const add = (name, { ticket, conflict, start = f.base_head } = {}) => {
    const suffix = (0x345 - rows.length).toString(16).padStart(6, '0'), id = `j${suffix.padStart(16, '0')}`;
    const label = `train-${suffix}`, root = join(`${f.main}-wt`, label), branch = `wt/${label}`;
    f.git(f.main, 'worktree', 'add', '-qb', branch, root, start);
    fs.writeFileSync(join(root, name), `${name}\n`);
    f.git(root, 'add', name); f.git(root, 'commit', '-qm', name);
    if (conflict) {
      fs.writeFileSync(join(root, 'overlap'), `${name}\n`);
      f.git(root, 'commit', '-qam', `overlap ${name}`);
    }
    const dir = jobDir(f, id); fs.mkdirSync(dir, { recursive: true });
    const receipt = JSON.parse(fs.readFileSync(join(jobDir(f), 'job.json')));
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ ...receipt, job: id, cwd: root, ticket,
      worktree: { main_root: f.main, root, branch, base_head: start } }));
    settle(f, id, 'Synthetic result.');
    const row = { id, root, source: f.git(root, 'rev-parse', 'HEAD') }; rows.push(row);
    return row;
  };
  const start = async id => (await f.call('hud_land', { job: id })).flow;
  const release = async list => {
    const blocker = await start(job);
    await until(() => fs.existsSync(join(f.env.HOME, 'started')), t.signal);
    const flows = [];
    for (const { id } of list) {
      const flow = await start(id);
      assert.equal(f.flowState(flow).state, 'queued');
      flows.push(flow);
    }
    fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
    return { blocker, flows };
  };
  const complete = async flows => {
    await until(() => flows.every(flow => ['completed', 'failed', 'cancelled'].includes(f.flowState(flow).state)), t.signal);
    return flows.map(flow => {
      const row = f.flowState(flow); assert.equal(row.state, 'completed', JSON.stringify(row)); return row;
    });
  };
  return { ...f, add, start, release, complete, log };
}

test('land train gates and pushes two queued jobs once, with a ticket record and receipt per job', { timeout }, async t => {
  const f = await trainCheckout(t);
  const ticketFile = seedJsonTickets(f, 'train', [
    { number: 1, title: 'Sample 1', status: 'ready-for-agent', owner_try: false },
    { number: 2, title: 'Sample 2', status: 'ready-for-agent', owner_try: false },
  ]);
  f.git(f.main, 'add', ticketFile); f.git(f.main, 'commit', '-qm', 'seed tickets');
  const jobs = ['alpha', 'beta'].map((name, i) => f.add(name, { ticket: `train/0${i + 1}` }));
  const { blocker, flows } = await f.release(jobs);
  const [first, ...rows] = await f.complete([blocker, ...flows]);
  const tip = f.git(f.remote, 'rev-parse', 'base');
  assert.deepEqual(f.log('gate-heads'), [first.landed_sha, rows[0].tested_sha]);
  assert.deepEqual(f.log('after-heads'), [first.landed_sha, tip]);
  assert.equal(f.git(f.main, 'rev-parse', 'base'), tip);
  assert.equal(f.git(f.main, 'log', '--format=%s', '--reverse', `${first.landed_sha}..base`), 'alpha\nbeta');
  for (const [i, row] of rows.entries()) {
    assert.equal(row.train, flows[0]); assert.equal(row.job, jobs[i].id); assert.equal(row.source_sha, jobs[i].source);
    assert.equal(row.tested_sha, rows[0].tested_sha); assert.equal(row.published_sha, tip);
    assert.equal(row.tested_tree, f.git(f.main, 'rev-parse', `${row.tested_sha}^{tree}`));
    assert.equal(row.published_tree, f.git(f.remote, 'rev-parse', 'base^{tree}'));
    assertLandingRecord(f, ticketFile, first.landed_sha, tip, i + 1);
    assert.equal(fs.existsSync(jobs[i].root), false);
    const view = await f.call('hud_land', { job: row.job });
    assert.equal(view.flow, flows[i]); assert.equal(view.train, flows[0]);
  }
  assert.equal(rows[1].landed_sha, tip);
  assert.equal(fs.readdirSync(join(f.home, 'flows')).filter(name => name.endsWith('.json')).length, 3);
});

test('land train rolls back every pick of the conflicting job, which repairs and lands alone', { timeout }, async t => {
  const f = await trainCheckout(t);
  fs.writeFileSync(join(f.main, 'overlap'), 'base\n');
  f.git(f.main, 'add', 'overlap'); f.git(f.main, 'commit', '-qm', 'seed overlap');
  const start = f.git(f.main, 'rev-parse', 'HEAD');
  const jobs = ['alpha', 'beta', 'gamma'].map(name => f.add(name, { start, conflict: name !== 'gamma' }));
  const { blocker, flows: [a, b, c] } = await f.release(jobs);
  const [first, alpha, gamma] = await f.complete([blocker, a, c]);
  const repairJob = await repair(f, b, 0);
  assert.match(fs.readFileSync(join(jobDir(f, repairJob), 'brief.md'), 'utf8'), /cherry-pick[\s\S]*CONFLICT/);
  assert.equal(alpha.train, a); assert.equal(gamma.train, a);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), gamma.landed_sha);
  assert.throws(() => f.git(f.remote, 'cat-file', '-e', 'base:beta')); // Even beta's first, clean pick was rolled back.
  assert.deepEqual(f.log('gate-heads'), [first.landed_sha, gamma.landed_sha]);
  const root = jobs[1].root;
  assert.throws(() => f.git(root, 'rebase', 'base'));
  fs.writeFileSync(join(root, 'overlap'), 'alpha and beta\n'); f.git(root, 'add', 'overlap');
  f.git(root, '-c', 'core.editor=true', 'rebase', '--continue');
  settle(f, repairJob, 'Synthetic conflict resolved.');
  const [beta] = await f.complete([b]);
  assert.equal(beta.train, undefined); assert.equal(beta.repairs[0].outcome, 'gate passed');
  assert.deepEqual(f.log('gate-heads'), [first.landed_sha, gamma.landed_sha, beta.tested_sha]);
  assert.equal(f.git(f.remote, 'show', 'base:overlap'), 'alpha and beta');
});

test('red land train falls back to single gates, without a train rerun or repair', { timeout }, async t => {
  const f = await trainCheckout(t, `if test -f alpha && test -f beta &&
    ! git cat-file -e base:alpha 2>/dev/null && ! git cat-file -e base:beta 2>/dev/null; then
    git rev-parse base >> "$HOME/rejected-on"; exit 7
  fi`);
  const { blocker, flows } = await f.release(['alpha', 'beta'].map(name => f.add(name)));
  const [first, ...rows] = await f.complete([blocker, ...flows]);
  const [initial, rejected, ...singles] = f.log('gate-heads');
  assert.equal(initial, first.landed_sha);
  assert.equal(singles.length, 2);
  assert.deepEqual(f.log('rejected-on'), [initial]);
  assert.equal(f.git(f.main, 'show', `${rejected}:alpha`), 'alpha');
  assert.equal(f.git(f.main, 'show', `${rejected}:beta`), 'beta');
  // The final single may independently create and gate the same commit as the rejected train.
  assert.deepEqual(new Set(singles), new Set(rows.map(row => row.landed_sha)));
  assert.deepEqual(f.log('after-heads'), [initial, ...singles]);
  const failedTrain = rows.flatMap(row => row.timings.filter(e => e.train));
  assert.equal(failedTrain.length, 1); assert.equal(failedTrain[0].ok, false);
  for (const row of rows) {
    assert.equal(row.train, undefined); assert.equal(row.reruns, undefined); assert.equal(row.repairs, undefined);
    assert.equal(row.tested_tree, row.published_tree);
  }
});

test('land train timings count one paid gate for a synthetic three-job queue instead of three', { timeout }, async t => {
  const f = await trainCheckout(t, 'sleep .15');
  const { flows } = await f.release(['alpha', 'beta', 'gamma'].map(name => f.add(name)));
  const batch = await f.complete(flows);
  const singles = [];
  for (const name of ['delta', 'epsilon', 'zeta']) {
    const { id } = f.add(name);
    singles.push(...await f.complete([await f.start(id)]));
  }
  const gateTimings = rows => rows.flatMap(row => row.timings?.filter(e => /^gate\[/.test(e.step)) ?? []);
  const shared = gateTimings(batch), solo = gateTimings(singles);
  assert.deepEqual(shared.map(e => e.train), [flows[0]]);
  assert.equal(solo.length, 3);
  assert.ok([...shared, ...solo].every(e => e.ok && e.ms >= 150));
  t.diagnostic(`Fake gate, 3 jobs: ${shared[0].ms} ms in 1 shared run; ${solo.reduce((ms, e) => ms + e.ms, 0)} ms in 3 single runs.`);
});

async function grabAbstractLock(scope, key, signal) {
  for (;;) {
    signal?.throwIfAborted();
    const release = await tryAbstractLock(scope, key);
    if (release) return release;
    await sleep(5, undefined, { signal });
  }
}

test('four queued lands keep waiting across a land-queue lock hold longer than the default timeout and land in order', { timeout }, async t => {
  const f = await trainCheckout(t);
  const jobs = ['alpha', 'beta', 'gamma', 'delta'].map(name => f.add(name));
  const blocker = await f.start(job);
  await until(() => fs.existsSync(join(f.env.HOME, 'started')), t.signal);
  const flows = [];
  for (const { id } of jobs) {
    const flow = await f.start(id);
    assert.equal(f.flowState(flow).state, 'queued');
    flows.push(flow);
    await sleep(5, undefined, { signal: t.signal });
  }
  await until(() => flows.every(flow => f.flowState(flow).step.startsWith('waiting for ')), t.signal);

  const queueKey = `${f.home}\0${f.main}`;
  let releaseQueue = await grabAbstractLock('land-queue', queueKey, t.signal);
  t.after(() => releaseQueue?.());
  // Exceed takeLease wait_s (1s) + default abstract-lock timeout (1s) so every waiter retries instead of failing.
  await sleep(2200, undefined, { signal: t.signal });
  for (const flow of flows) assert.equal(f.flowState(flow).state, 'queued', JSON.stringify(f.flowState(flow)));
  await releaseQueue();
  releaseQueue = undefined;

  // Hold flow-state on the second candidate while the train claims: land-queue must stay free during runLock waits.
  let releaseFlow = await grabAbstractLock('flow-state', `${f.home}\0${flows[1]}`, t.signal);
  t.after(() => releaseFlow?.());
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => Boolean(f.flowState(flows[0]).boarded), t.signal);
  assert.equal(await withAbstractLock('land-queue', queueKey, () => 'free', { timeoutMs: 250 }), 'free');
  await sleep(1100, undefined, { signal: t.signal });
  for (const flow of flows.slice(2)) assert.equal(f.flowState(flow).state, 'queued', JSON.stringify(f.flowState(flow)));
  await releaseFlow();
  releaseFlow = undefined;

  const [first, ...rows] = await f.complete([blocker, ...flows]);
  assert.equal(f.git(f.main, 'log', '--format=%s', '--reverse', `${first.landed_sha}..base`), 'alpha\nbeta\ngamma\ndelta');
  assert.deepEqual(rows.map(row => row.train), flows.map(() => flows[0]));
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), rows.at(-1).landed_sha);
});

test('a crashed land-queue holder releases the lock and a waiting land recovers', { timeout }, async t => {
  const f = await checkout(t, ['true']);
  const queueKey = `${f.home}\0${f.main}`;
  const lockUrl = new URL('../../dist/utils/abstract-lock.js', import.meta.url).href;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { tryAbstractLock } from ${JSON.stringify(lockUrl)};
    const release = await tryAbstractLock('land-queue', process.argv[1] + '\\0' + process.argv[2]);
    if (!release) process.exit(2);
    process.stdout.write('locked\\n');
    setInterval(() => {}, 1000);
  `, f.home, f.main], { stdio: ['ignore', 'pipe', 'inherit'] });
  const holderExited = once(holder, 'exit');
  t.after(() => stopChild(holder, holderExited));
  let out = '';
  holder.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
  await until(() => out.includes('locked\n'), t.signal);
  assert.equal(await tryAbstractLock('land-queue', queueKey), undefined);

  const { flow } = await f.call('hud_land', { job });
  await sleep(1300, undefined, { signal: t.signal });
  assert.equal(f.flowState(flow).state, 'queued', JSON.stringify(f.flowState(flow)));

  holder.kill('SIGKILL');
  await holderExited;
  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), t.signal);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
});
