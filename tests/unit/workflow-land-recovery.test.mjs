import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { takeLease } from '../../dist/roles/lease.js';
import { isProcAlive, procStat, readBootId } from '../../dist/utils/proc.js';
import { until } from '../helpers/thin-mcp-harness.mjs';
import { stopChild } from '../helpers/process-cleanup.mjs';
import { bindSourceTab, checkout, job, jobDir, settle } from '../helpers/thin-mcp-land.mjs';

const interrupted = 'Land helper exited; inspect the checkout before retrying. No step was replayed.';
function killRunner(f, flow) {
  const row = f.flowState(flow);
  assert.ok(row.start && isProcAlive(row.pid, row.start));
  assert.equal(row.workflow.steps.land.admitted, true);
  process.kill(row.pid, 'SIGKILL');
}

async function failed(f, flow, signal) {
  await until(() => f.flowState(flow).state === 'failed', signal);
  const row = await f.call('hud_read', { job: flow });
  assert.equal(row.error, interrupted);
  assert.equal(row.landed_sha, undefined);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.base_head);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
  assert.equal(fs.existsSync(join(f.main, 'after-ran')), false);
  assert.equal(f.flowState(flow).workflow.steps.land.state, 'failed');
  assert.equal(row.changes.filter(line => line.startsWith(`${flow} `)).length, 1);
  assert.equal((await f.call('hud_read', { job: flow })).changes?.some(line => line.startsWith(`${flow} `)) ?? false, false);
  return row;
}

test('SIGKILL during the sealed gate leaves one failed result and never replays that attempt', async t => {
  const f = await checkout(t, ['echo gate >> "$HOME/gates"; while test ! -f "$HOME/release"; do sleep .05; done']);
  const { flow } = await f.call('hud_land', { job });
  await until(() => fs.existsSync(join(f.env.HOME, 'gates')), t.signal);
  killRunner(f, flow);
  const row = await failed(f, flow, t.signal);
  assert.match(row.step, /^gate\[1\]/);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'gates'), 'utf8'), 'gate\n');
  const saved = f.flowState(flow);

  // Only a fresh explicit attempt is permitted. Its result cannot overwrite the first one.
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  assert.equal((await f.call('hud_land', { job })).flow, `${flow}-2`);
  await until(() => f.flowState(`${flow}-2`).state === 'completed', t.signal);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.flowState(`${flow}-2`).landed_sha);
  assert.deepEqual(f.flowState(flow), saved);
});

test('an index-lock refusal leaves main unchanged and permits a fresh hud_land', async t => {
  const f = await checkout(t, []);
  const lock = join(f.main, '.git', 'index.lock');
  fs.writeFileSync(lock, 'synthetic lock', { flag: 'wx' });
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).state === 'failed', t.signal);
  const row = f.flowState(flow);
  assert.equal(row.step, 'fast-forward');
  assert.match(row.tail.join('\n'), /index\.lock/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.base_head);
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', 'tracked'), '');
  assert.equal(row.publish_pending, undefined);

  fs.unlinkSync(lock);
  const retry = await f.call('hud_land', { job });
  assert.equal(retry.flow, `${flow}-2`);
  await until(() => f.flowState(retry.flow).state === 'completed', t.signal);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.flowState(retry.flow).landed_sha);
});

test('SIGKILL at fast-forward keeps the unknown-result interlock even when HEAD is unchanged', async t => {
  const preload = `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const exec = cp.execFile;
cp.execFile = (bin, args, ...rest) => {
  if (bin === 'git' && args.includes('merge') && args.includes('--ff-only')) process.kill(process.pid, 'SIGSTOP');
  return exec(bin, args, ...rest);
};
syncBuiltinESMExports();`;
  const f = await checkout(t, [], {
    probe: `process.env.NODE_OPTIONS += ${JSON.stringify(' --import=data:text/javascript,' + encodeURIComponent(preload))};`,
  });
  const { flow } = await f.call('hud_land', { job });
  await until(() => procStat(f.flowState(flow).pid)?.state === 'T', t.signal);
  const pending = f.flowState(flow).publish_pending;
  assert.match(pending, /^[a-f0-9]{40}$/);
  killRunner(f, flow);
  await failed(f, flow, t.signal);
  assert.equal(f.flowState(flow).publish_pending, pending);
  assert.equal((await f.call('hud_land', { job })).flow, flow);
  assert.equal(fs.existsSync(join(f.home, 'flows', `${flow}-2.json`)), false);
});

for (const timedOut of [true, false]) test(`fast-forward ${timedOut ? 'timeout' : 'error with a changed path'} keeps the interlock`, async t => {
  const script = timedOut ? 'setInterval(() => {}, 1000)' : "require('node:fs').appendFileSync('tracked', 'partial merge\\n'); process.exit(1)";
  const preload = `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const exec = cp.execFile;
cp.execFile = (bin, args, options, done) => {
  if (bin === 'git' && args.includes('merge') && args.includes('--ff-only')) {
    return exec(process.execPath, ['-e', ${JSON.stringify(script)}], { ...options, timeout: ${timedOut ? 100 : 5000} }, done);
  }
  return exec(bin, args, options, done);
};
syncBuiltinESMExports();`;
  const f = await checkout(t, [], {
    probe: `process.env.NODE_OPTIONS += ${JSON.stringify(' --import=data:text/javascript,' + encodeURIComponent(preload))};`,
  });
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).state === 'failed', t.signal);
  assert.equal(f.flowState(flow).step, 'fast-forward');
  assert.match(f.flowState(flow).publish_pending, /^[a-f0-9]{40}$/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.base_head);
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', 'tracked'), timedOut ? '' : 'M tracked');
  assert.equal((await f.call('hud_land', { job })).flow, flow);
  assert.equal(fs.existsSync(join(f.home, 'flows', `${flow}-2.json`)), false);
});

test('the legacy land bootstrap refuses an old queue before ready', { timeout: 10000 }, async t => {
  const child = fork(resolve('packages/hud-mcp/bin/land-runner.mjs'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  const exited = once(child, 'exit');
  t.after(() => stopChild(child, exited));
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const [message] = await once(child, 'message', { signal: t.signal });
  // The old caller accepts only the bare 'ready' and publishes its load-failure receipt otherwise.
  assert.equal(message === 'ready' ? 'queued' : 'failed', 'failed');
  assert.equal(message, 'incompatible-generation');
  assert.deepEqual(await exited, [1, null]);
  assert.match(stderr, /incompatible generation/i);
});

test('SIGKILL after repair dispatch but before binding keeps the keyed repair and gate evidence', async t => {
  const preload = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync;
fs.renameSync = (source, target) => {
  if (target.endsWith('/f0000000000000123.json')) {
    const next = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (next.repairs?.[0]?.outcome === 'waiting for worker') {
      fs.writeFileSync(process.env.HOME + '/repair-dispatched', '');
      process.kill(process.pid, 'SIGSTOP');
    }
  }
  return rename(source, target);
};
syncBuiltinESMExports();`;
  const f = await checkout(t, ['grep fixed tracked || { echo synthetic-repair-needed; exit 1; }'], {
    probe: `process.env.NODE_OPTIONS += ${JSON.stringify(' --import=data:text/javascript,' + encodeURIComponent(preload))};`,
  });
  bindSourceTab(t, f);
  fs.writeFileSync(join(jobDir(f), 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  const { flow } = await f.call('hud_land', { job });
  await until(() => fs.existsSync(join(f.env.HOME, 'repair-dispatched')), t.signal);
  assert.equal(f.flowState(flow).repairs[0].outcome, 'dispatching');
  killRunner(f, flow);
  const row = await failed(f, flow, t.signal);
  assert.equal(row.step, 'repair 1');
  assert.equal(row.repairs[0].job, job);
  assert.deepEqual(row.tail, ['synthetic-repair-needed']);
  assert.match(fs.readFileSync(row.reruns[0].rerun_output_path, 'utf8'), /synthetic-repair-needed/);

  // A later worker result belongs to the job, not a replay of this failed run.
  settle(f, job, 'Synthetic repair result.');
  assert.equal((await f.call('hud_read', { job: flow })).state, 'failed');
  assert.equal(f.commands().filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt').length, 1);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
});

function addSecondJob(f, id = 'j0000000000000456', file = 'second-file') {
  const root = join(`${f.main}-wt`, `sample-${id.slice(-6)}`), branch = `wt/sample-${id.slice(-6)}`;
  f.git(f.main, 'worktree', 'add', '-qb', branch, root, f.base_head);
  fs.writeFileSync(join(root, file), 'synthetic second job\n');
  f.git(root, 'add', file);
  f.git(root, 'commit', '-qm', 'second job commit');
  const dir = join(f.home, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
    job: id, cwd: root, project_root: f.main, role: 'imp', herdr_pane: f.env.HERDR_PANE_ID,
    created_at: now, dispatch_exit_code: 0, worktree: { main_root: f.main, root, base_head: f.base_head, branch },
  }));
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: now }));
  return id;
}

function leaseFile(f) {
  const project = fs.realpathSync(f.main);
  const entry = createHash('sha256').update(JSON.stringify([project, 'main-checkout'])).digest('hex') + '.json';
  return join(f.home, 'leases', entry);
}
const readLease = f => JSON.parse(fs.readFileSync(leaseFile(f), 'utf8'));
const alive = ({ pid, start }) => isProcAlive(pid, start);
function identity(pid) {
  const stat = procStat(pid);
  assert.ok(stat?.start, `missing process identity for PID ${pid}`);
  return { pid, start: stat.start };
}
const markerPid = (f, name) => Number(fs.readFileSync(join(f.env.HOME, name), 'utf8'));
const watcher = '(trap "" TERM; exec sleep 60) & echo $! > "$HOME/watcher"';
const verifyStopped = `node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { isProcAlive } from "${new URL('../../dist/utils/proc.js', import.meta.url).href}";
  for (const { pid, start } of JSON.parse(readFileSync(process.env.HOME + "/old-group", "utf8"))) {
    if (isProcAlive(pid, start)) throw Error("old process still active: " + pid);
  }'`;

for (const kind of ['gate', 'after']) test(`SIGKILL during ${kind}: next land waits for the custodian before its own gate`, async t => {
  const hung = `${watcher}; echo $$ > "$HOME/shell"; touch "$HOME/started"; wait`;
  const check = `if test -f "$HOME/started"; then ${verifyStopped}; fi`;
  const f = kind === 'gate'
    ? await checkout(t, [`if test -f "$HOME/started"; then ${verifyStopped}; else ${hung}; fi`])
    : await checkout(t, [check], { after: [`if test ! -f "$HOME/started"; then ${hung}; fi`] });
  const job2 = addSecondJob(f);
  const { flow: flow1 } = await f.call('hud_land', { job });
  await until(() => fs.existsSync(join(f.env.HOME, 'started')), t.signal);
  const shell = identity(markerPid(f, 'shell'));
  const child = identity(markerPid(f, 'watcher'));
  const lease = readLease(f);
  assert.equal(lease.holder, flow1);
  assert.equal(lease.custodian.boot_id, readBootId());
  const group = identity(procStat(shell.pid).pgrp);
  assert.equal(procStat(child.pid).session, group.pid);
  assert.notEqual(group.pid, lease.custodian.pid);
  const old = [lease.custodian, group, shell, child];
  assert.ok(old.every(alive));
  fs.writeFileSync(join(f.env.HOME, 'old-group'), JSON.stringify(old));
  assert.ok(f.flowState(flow1).step.startsWith(`${kind}[1]:`));

  const { flow: flow2 } = await f.call('hud_land', { job: job2 });
  await until(() => f.flowState(flow2).step.startsWith('waiting for '), t.signal);
  killRunner(f, flow1);
  await until(() => ['completed', 'failed'].includes(f.flowState(flow2).state), 15_000);
  assert.equal(f.flowState(flow2).state, 'completed', JSON.stringify(f.flowState(flow2)));
  assert.ok(old.every(process => !alive(process)));
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.flowState(flow2).landed_sha);
});

test('a reused custodian PID is not treated as active during lease acquisition', async t => {
  const f = await checkout(t, ['true']);
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const bystanderExited = once(bystander, 'exit');
  t.after(() => stopChild(bystander, bystanderExited));
  const current = identity(bystander.pid);
  const bootId = readBootId();
  assert.ok(bootId);
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const owner = identity(dead.pid);
  await once(dead, 'exit');
  const file = leaseFile(f);
  fs.mkdirSync(join(f.home, 'leases'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({
    project: fs.realpathSync(f.main), name: 'main-checkout', holder: 'f0000000000000999',
    kind: 'main', since: new Date().toISOString(), pid: owner.pid, pid_start_time: owner.start,
    custodian: { pid: current.pid, start: String(BigInt(current.start) + 1n), boot_id: bootId },
  }), { mode: 0o600 });

  const { flow } = await f.call('hud_land', { job });
  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), 15_000);
  assert.equal(f.flowState(flow).state, 'completed', JSON.stringify(f.flowState(flow)));
  assert.ok(alive(current));
});

test('SIGKILL after the gate shell exits: recovery waits for its background watcher to stop', async t => {
  const f = await checkout(t, [
    `${watcher}; echo $$ > "$HOME/shell"; touch "$HOME/started";
    while ! test -f "$HOME/exit-shell"; do sleep .02; done`,
  ]);
  const { flow } = await f.call('hud_land', { job });
  await until(() => fs.existsSync(join(f.env.HOME, 'started')), t.signal);
  const shell = identity(markerPid(f, 'shell'));
  const child = identity(markerPid(f, 'watcher'));
  const group = identity(procStat(shell.pid).pgrp);
  const { custodian } = readLease(f);
  fs.writeFileSync(join(f.env.HOME, 'exit-shell'), '');
  await until(() => !alive(shell), t.signal);
  assert.ok([custodian, group, child].every(alive));

  killRunner(f, flow);
  const helper = f.flowState(flow);
  await until(() => !alive(helper), t.signal);
  const row = await f.call('hud_read', { job: flow });
  assert.equal(row.error, interrupted);
  assert.match(row.step, /^gate\[1\]/);
  assert.ok([custodian, group, child].every(process => !alive(process)));
});

test('an observer that cannot confirm cleanup records its refusal before exiting', { timeout: 15_000 }, async t => {
  const f = await checkout(t, ['echo $$ > "$HOME/shell"; touch "$HOME/started"; sleep 60']);
  const { flow } = await f.call('hud_land', { job });
  await until(() => fs.existsSync(join(f.env.HOME, 'started')), t.signal);
  const shell = identity(markerPid(f, 'shell'));
  const group = identity(procStat(shell.pid).pgrp);
  const { custodian } = readLease(f);
  assert.ok(alive(group));
  process.kill(group.pid, 'SIGSTOP'); // Synthetic group leader only; prevent it from handling EOF.
  await until(() => procStat(group.pid)?.state === 'T', t.signal);
  killRunner(f, flow);
  await until(() => !alive(custodian), t.signal);
  assert.ok(alive(shell));
  const expected = `Land custodian PID ${custodian.pid} could not confirm payload group ${group.pid} stopped`;
  assert.ok(readLease(f).custodian_error.startsWith(expected));
  await assert.rejects(f.call('hud_read', { job: flow }), error => error.message.includes(expected));
  await assert.rejects(
    takeLease({ name: 'main-checkout', wait_s: 0 }, { home: f.home, cwd: f.main, holder: 'f0000000000000999' }),
    error => error.message.startsWith(expected),
  );
});
