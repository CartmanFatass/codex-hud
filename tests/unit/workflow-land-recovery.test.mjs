import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { takeLease, terminateCommandGroup } from '../../dist/roles/lease.js';
import { isProcAlive, procStat, readBootId } from '../../dist/utils/proc.js';
import { until } from '../helpers/thin-mcp-harness.mjs';
import { stopChild } from '../helpers/process-cleanup.mjs';
import { checkout, job, jobDir, settle } from '../helpers/thin-mcp-land.mjs';

const interrupted = 'Land helper exited; inspect the checkout before retrying. No step was replayed.';
function killRunner(f, flow) {
  const row = f.flowState(flow);
  assert.equal(procStat(row.pid)?.start, row.start);
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
  fs.writeFileSync(join(jobDir(f), 'SESSION.txt'), 'PRIMARY=source-agent\n');
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

function killExact(pid, start) {
  const stat = procStat(pid);
  if (stat?.start === start) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
}

test('SIGKILL during a gate command: next land terminates the orphan command group before starting its own gate', async t => {
  const gateScript = [
    'if test ! -f "$HOME/orphan-started"; then',
    '  sleep 60 &',
    '  child=$!',
    '  echo "$$" > "$HOME/orphan-leader"',
    '  echo "$child" > "$HOME/orphan-child"',
    '  touch "$HOME/orphan-started"',
    '  while true; do sleep 0.2; done',
    'else',
    '  leader=$(cat "$HOME/orphan-leader")',
    '  child=$(cat "$HOME/orphan-child")',
    '  if kill -0 "$leader" 2>/dev/null || kill -0 "$child" 2>/dev/null; then',
    '    echo still-alive > "$HOME/second-gate-status"',
    '    exit 1',
    '  fi',
    '  echo dead > "$HOME/second-gate-status"',
    'fi',
  ].join('\n');
  const f = await checkout(t, [gateScript]);
  const job2 = addSecondJob(f);
  const { flow: flow1 } = await f.call('hud_land', { job });
  await until(() => fs.existsSync(join(f.env.HOME, 'orphan-started')), t.signal);
  const leaderPid = Number(fs.readFileSync(join(f.env.HOME, 'orphan-leader'), 'utf8').trim());
  const childPid = Number(fs.readFileSync(join(f.env.HOME, 'orphan-child'), 'utf8').trim());
  const leaderStart = procStat(leaderPid)?.start;
  const childStart = procStat(childPid)?.start;
  assert.ok(leaderStart && childStart);
  t.after(() => { killExact(childPid, childStart); killExact(leaderPid, leaderStart); });

  killRunner(f, flow1);
  // Wait for the killed land helper to exit and confirm the orphaned gate command group is still alive.
  const runner = f.flowState(flow1);
  await until(() => !isProcAlive(runner.pid, runner.start), t.signal);
  assert.equal(isProcAlive(leaderPid, leaderStart), true);
  assert.equal(isProcAlive(childPid, childStart), true);

  // Without calling hud_read on flow1, start a second land: it must terminate flow1's command group first.
  const { flow: flow2 } = await f.call('hud_land', { job: job2 });
  await until(() => ['completed', 'failed'].includes(f.flowState(flow2).state), 15_000);
  assert.equal(f.flowState(flow2).state, 'completed', JSON.stringify(f.flowState(flow2)));
  assert.equal(fs.readFileSync(join(f.env.HOME, 'second-gate-status'), 'utf8').trim(), 'dead');
  assert.equal(isProcAlive(leaderPid, leaderStart), false);
  assert.equal(isProcAlive(childPid, childStart), false);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.flowState(flow2).landed_sha);
});

test('SIGKILL during an after command in main: next land terminates the orphan command group before proceeding', async t => {
  const gateScript = [
    'if test -f "$HOME/after-started"; then',
    '  leader=$(cat "$HOME/after-leader")',
    '  child=$(cat "$HOME/after-child")',
    '  if kill -0 "$leader" 2>/dev/null || kill -0 "$child" 2>/dev/null; then',
    '    echo still-alive > "$HOME/second-gate-after-status"',
    '    exit 1',
    '  fi',
    '  echo dead > "$HOME/second-gate-after-status"',
    'fi',
  ].join('\n');
  const afterScript = [
    'if test ! -f "$HOME/after-started"; then',
    '  sleep 60 &',
    '  child=$!',
    '  echo "$$" > "$HOME/after-leader"',
    '  echo "$child" > "$HOME/after-child"',
    '  touch "$HOME/after-started"',
    '  while true; do echo tick >> "$PWD/after-heartbeat"; sleep 0.05; done',
    'else',
    '  echo ok > "$HOME/second-after-ran"',
    'fi',
  ].join('\n');
  const f = await checkout(t, [gateScript], { after: [afterScript] });
  const job2 = addSecondJob(f);
  const { flow: flow1 } = await f.call('hud_land', { job });
  await until(() => fs.existsSync(join(f.env.HOME, 'after-started')), t.signal);
  const leaderPid = Number(fs.readFileSync(join(f.env.HOME, 'after-leader'), 'utf8').trim());
  const childPid = Number(fs.readFileSync(join(f.env.HOME, 'after-child'), 'utf8').trim());
  const leaderStart = procStat(leaderPid)?.start;
  const childStart = procStat(childPid)?.start;
  assert.ok(leaderStart && childStart);
  assert.match(f.flowState(flow1).step, /^after\[1\]:/);
  t.after(() => { killExact(childPid, childStart); killExact(leaderPid, leaderStart); });

  killRunner(f, flow1);
  const runner = f.flowState(flow1);
  await until(() => !isProcAlive(runner.pid, runner.start), t.signal);
  assert.equal(isProcAlive(leaderPid, leaderStart), true);
  assert.equal(isProcAlive(childPid, childStart), true);

  // Next land must terminate the dead holder's after command group before starting its own gate.
  const { flow: flow2 } = await f.call('hud_land', { job: job2 });
  await until(() => ['completed', 'failed'].includes(f.flowState(flow2).state), 15_000);
  assert.equal(f.flowState(flow2).state, 'completed', JSON.stringify(f.flowState(flow2)));
  assert.equal(fs.readFileSync(join(f.env.HOME, 'second-gate-after-status'), 'utf8').trim(), 'dead');
  assert.equal(fs.readFileSync(join(f.env.HOME, 'second-after-ran'), 'utf8').trim(), 'ok');
  assert.equal(isProcAlive(leaderPid, leaderStart), false);
  assert.equal(isProcAlive(childPid, childStart), false);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.flowState(flow2).landed_sha);
});

test('a reused PID with a different start time is never killed during lease reclaim or command-group termination', async t => {
  const f = await checkout(t, ['true']);
  // Spawn a synthetic detached bystander process in its own process group and session.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const bystanderExited = once(bystander, 'exit');
  t.after(() => stopChild(bystander, bystanderExited));
  const bystanderStat = procStat(bystander.pid);
  const bootId = readBootId();
  assert.ok(bystanderStat && bootId);
  assert.equal(bystanderStat.pgrp, bystander.pid);
  assert.equal(bystanderStat.session, bystander.pid);

  // Spawn and await a short-lived process to get a guaranteed dead lease holder PID + start.
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const deadStart = procStat(dead.pid)?.start;
  await once(dead, 'exit');
  assert.ok(deadStart);

  // Seed a dead main-checkout lease pointing at bystander's PID with a DIFFERENT start time.
  const leasesDir = join(f.home, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true, mode: 0o700 });
  const project = fs.realpathSync(f.main);
  const entry = createHash('sha256').update(JSON.stringify([project, 'main-checkout'])).digest('hex') + '.json';
  const differentStart = String(BigInt(bystanderStat.start) + 1n);
  fs.writeFileSync(join(leasesDir, entry), JSON.stringify({
    project,
    name: 'main-checkout',
    holder: 'f0000000000000999',
    kind: 'main',
    since: new Date().toISOString(),
    pid: dead.pid,
    pid_start_time: deadStart,
    command_group: { pid: bystander.pid, start: differentStart, boot_id: bootId },
  }), { mode: 0o600 });

  // Direct unit checks on terminateCommandGroup safety boundaries.
  assert.equal(await terminateCommandGroup({ pid: bystander.pid, start: differentStart, boot_id: bootId }), 'reused');
  assert.equal(await terminateCommandGroup({ pid: bystander.pid, start: bystanderStat.start, boot_id: '00000000-0000-0000-0000-000000000000' }), 'other-boot');
  assert.equal(isProcAlive(bystander.pid, bystanderStat.start), true);

  // Non-detached child (not its own group/session leader) must be refused and left alive.
  const nonDetached = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false, stdio: 'ignore' });
  const nonDetachedExited = once(nonDetached, 'exit');
  t.after(() => stopChild(nonDetached, nonDetachedExited));
  const nonDetachedStat = procStat(nonDetached.pid);
  assert.ok(nonDetachedStat);
  await assert.rejects(
    terminateCommandGroup({ pid: nonDetached.pid, start: nonDetachedStat.start, boot_id: bootId }),
    /not a detached command group leader/,
  );
  assert.equal(isProcAlive(nonDetached.pid, nonDetachedStat.start), true);

  // Protected caller PID and malformed records must be refused.
  const selfStat = procStat(process.pid);
  await assert.rejects(
    terminateCommandGroup({ pid: process.pid, start: selfStat.start, boot_id: bootId }),
    /protected/,
  );
  await assert.rejects(terminateCommandGroup({ pid: -1, start: '1', boot_id: bootId }), /incomplete/);
  await assert.rejects(terminateCommandGroup({ pid: bystander.pid, start: 'bad', boot_id: bootId }), /incomplete/);
  await assert.rejects(terminateCommandGroup('bad'), /malformed/);

  // Dead leader with an unverified remaining group member must refuse both to kill and to proceed.
  const orphanMarker = join(f.env.HOME, 'dead-leader-child');
  const shortLeader = spawn('sh', ['-c', `sleep 60 & echo $! > ${JSON.stringify(orphanMarker)}; exit 0`], { detached: true, stdio: 'ignore' });
  const shortLeaderStart = procStat(shortLeader.pid)?.start;
  assert.ok(shortLeaderStart);
  await once(shortLeader, 'exit');
  await until(() => fs.existsSync(orphanMarker) && fs.readFileSync(orphanMarker, 'utf8').trim().length > 0, t.signal);
  const orphanChildPid = Number(fs.readFileSync(orphanMarker, 'utf8').trim());
  const orphanChildStart = procStat(orphanChildPid)?.start;
  assert.ok(orphanChildStart);
  t.after(() => killExact(orphanChildPid, orphanChildStart));
  await assert.rejects(
    terminateCommandGroup({ pid: shortLeader.pid, start: shortLeaderStart, boot_id: bootId }),
    /leader exited with unverified members remaining/,
  );
  assert.equal(isProcAlive(orphanChildPid, orphanChildStart), true);
  killExact(orphanChildPid, orphanChildStart);

  // End-to-end: hud_land reclaims the dead lease without killing the bystander process.
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), 15_000);
  assert.equal(f.flowState(flow).state, 'completed', JSON.stringify(f.flowState(flow)));
  assert.equal(isProcAlive(bystander.pid, bystanderStat.start), true);
  assert.equal(procStat(bystander.pid)?.start, bystanderStat.start);

  // Refusal path through takeLease: malformed command_group refuses to grant and keeps the dead lease intact.
  fs.writeFileSync(join(leasesDir, entry), JSON.stringify({
    project,
    name: 'main-checkout',
    holder: 'f0000000000000998',
    kind: 'main',
    since: new Date().toISOString(),
    pid: dead.pid,
    pid_start_time: deadStart,
    command_group: { pid: bystander.pid, start: 'not-ticks', boot_id: bootId },
  }), { mode: 0o600 });
  await assert.rejects(
    takeLease({ name: 'main-checkout', wait_s: 0 }, { home: f.home, cwd: f.main, holder: 'f0000000000000997' }),
    /incomplete/,
  );
  assert.equal(fs.existsSync(join(leasesDir, entry)), true);
  assert.equal(isProcAlive(bystander.pid, bystanderStat.start), true);
});

test('SIGKILL during a gate command: hud_read recovery terminates the orphan command group before retry', async t => {
  const f = await checkout(t, [
    'if test ! -f "$HOME/rec-started"; then sleep 60 & echo "$$" > "$HOME/rec-leader"; echo "$!" > "$HOME/rec-child"; touch "$HOME/rec-started"; while true; do sleep 0.2; done; fi',
  ]);
  const { flow } = await f.call('hud_land', { job });
  await until(() => fs.existsSync(join(f.env.HOME, 'rec-started')), t.signal);
  const leaderPid = Number(fs.readFileSync(join(f.env.HOME, 'rec-leader'), 'utf8').trim());
  const childPid = Number(fs.readFileSync(join(f.env.HOME, 'rec-child'), 'utf8').trim());
  const leaderStart = procStat(leaderPid)?.start;
  const childStart = procStat(childPid)?.start;
  assert.ok(leaderStart && childStart);
  t.after(() => { killExact(childPid, childStart); killExact(leaderPid, leaderStart); });

  killRunner(f, flow);
  const runner = f.flowState(flow);
  await until(() => !isProcAlive(runner.pid, runner.start), t.signal);
  assert.equal(isProcAlive(leaderPid, leaderStart), true);
  assert.equal(isProcAlive(childPid, childStart), true);

  // Recovery via hud_read terminates the dead holder's command group without starting a second land.
  const row = await failed(f, flow, t.signal);
  assert.match(row.step, /^gate\[1\]/);
  assert.equal(isProcAlive(leaderPid, leaderStart), false);
  assert.equal(isProcAlive(childPid, childStart), false);
});
