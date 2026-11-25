import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { procStat } from '../../dist/utils/proc.js';
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
