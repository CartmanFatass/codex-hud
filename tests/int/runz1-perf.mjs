// Synthetic retained-zombie proof cost. Run after npm run build, on an otherwise idle host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, release, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectGroup, processState, proveGroupGone, readProcess } from '../../dist/core/run/process.js';
import { readProcessCensus } from '../../dist/core/run/process-census.js';

const home = mkdtempSync(join(tmpdir(), 'hud-runz1-perf-'));
const fixture = spawn('/usr/bin/python3', [resolve('tests/unit/runz1-fixture.py'), home, 'pair'], {
  detached: true,
  env: { ...process.env, HOME: home, HUD_HOME: join(home, 'hud') },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const exited = once(fixture, 'exit');
let churn;
try {
  await once(fixture.stdout, 'data');
  const leader = readProcess(Number(readFileSync(join(home, 'leader'), 'utf8')));
  assert.ok(leader);
  const harness = readProcess(Number(readFileSync(join(home, 'worker'), 'utf8')));
  assert.ok(harness);
  const scope = {
    scope_id: 'synthetic-perf',
    scope_kind: 'pgid',
    pgid: leader.pgid,
    sid: leader.sid,
    group_leader: leader.stamp,
    boot_id: leader.stamp.boot_id,
    pid_domain: leader.stamp.pid_domain,
  };
  writeFileSync(join(home, 'terminate'), 'go');
  const cell = new Int32Array(new SharedArrayBuffer(4)),
    deadline = Date.now() + 5000;
  while (readProcess(leader.stamp.pid)?.state !== 'Z' || readProcess(harness.stamp.pid)?.state !== 'Z') {
    assert.ok(Date.now() < deadline);
    Atomics.wait(cell, 0, 0, 1);
  }
  const n = 1000,
    warmup = 100;
  function sample(fn) {
    for (let i = 0; i < warmup; i++) {
      try {
        fn();
      } catch {}
    }
    const times = [];
    let refusals = 0;
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      try {
        if (fn() === false) refusals++;
      } catch {
        refusals++;
      }
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const rank = (p) => times[Math.ceil(p * n) - 1];
    return { n, warmup, p50_ms: rank(0.5), p95_ms: rank(0.95), p99_ms: rank(0.99), max_ms: times.at(-1), refusals };
  }
  const censusSize = () => readdirSync('/proc').filter((name) => /^\d+$/.test(name)).length;
  const proof = () => proveGroupGone(scope, harness.stamp, [leader.stamp, harness.stamp]);
  const results = {
    host: { name: hostname(), kernel: release(), arch: arch(), node: process.version },
    timing:
      'wall-clock performance.now; nearest-rank; sequential populations; no explicit GC; full proof includes existing inspection and both new censuses plus visibility/thread checks',
    subject_stamps: { total: 3, unique: 2 },
    census_size_before: censusSize(),
    full_proof: sample(proof),
    additional_complete_scan: sample(() => readProcessCensus(scope)),
    existing_inspection: sample(() => {
      processState(harness.stamp);
      processState(leader.stamp);
      processState(harness.stamp);
      return inspectGroup(scope);
    }),
  };
  // Independent, owned process churn; no traffic in the managed synthetic session.
  churn = spawn(
    '/usr/bin/python3',
    [
      '-c',
      `import os,select,sys,time
while not select.select([sys.stdin],[],[],0)[0]:
 p=os.fork()
 if p==0:
  time.sleep(0.002)
  os._exit(0)
 os.waitpid(p,0)
`,
    ],
    {
      detached: true,
      env: { ...process.env, HOME: home, HUD_HOME: join(home, 'hud') },
      stdio: ['pipe', 'ignore', 'inherit'],
    }
  );
  results.churn_full_proof = sample(proof);
  results.census_size_after = censusSize();
  const churnExited = once(churn, 'exit');
  churn.stdin.end('stop\n');
  await churnExited;
  churn = undefined;
  fixture.stdin.write('reap-all\n');
  const reapDeadline = Date.now() + 5000;
  while (!existsSync(join(home, 'reaped-all'))) {
    assert.ok(Date.now() < reapDeadline);
    Atomics.wait(cell, 0, 0, 1);
  }
  assert.throws(() => process.kill(-scope.pgid, 0), { code: 'ESRCH' });
  results.esrch_full_proof = sample(proof);
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (churn) {
    const done = once(churn, 'exit');
    churn.stdin.end('stop\n');
    await done;
  }
  fixture.stdin.end('cleanup\n');
  const timeout = setTimeout(() => fixture.kill('SIGKILL'), 5000);
  const [code] = await exited;
  clearTimeout(timeout);
  assert.equal(code, 0);
  rmSync(home, { recursive: true, force: true });
}
