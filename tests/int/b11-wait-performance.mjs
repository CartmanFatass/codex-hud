// Synthetic real SQLite and real CLI waiter; measure only after its blocking subscription is live.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { handshakeFixture } from '../../dist-test/tests/unit/b45-handshake-fixture.js';
import { until } from './fixture.mjs';
import { PARENT_LIVENESS_INTERVAL_MS } from '../../dist/cli/run-wait.js';
const f = await handshakeFixture();
const cursor = f.ledger.snapshot((tx) => Number(tx.get('SELECT max(seq) AS n FROM events').n));
mkdirSync(join(f.root, 'hints'), { mode: 0o700 });
const child = spawn(
  process.execPath,
  [
    resolve('bin/hud'),
    'run',
    'wait',
    'run-a',
    '--after-seq',
    String(cursor),
    '--timeout-ms',
    String(PARENT_LIVENESS_INTERVAL_MS * 3 + 500),
    '--json',
  ],
  {
    env: { PATH: '/usr/bin:/bin', HOME: f.root, HUD_HOME: f.root },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
let stdout = '',
  stderr = '';
child.stdout.on('data', (data) => (stdout += data));
child.stderr.on('data', (data) => (stderr += data));
const done = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
const ticks = () => {
  const stat = readFileSync('/proc/' + child.pid + '/stat', 'utf8');
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  return Number(fields[11]) + Number(fields[12]);
};
try {
  await until(() => {
    try {
      return readdirSync('/proc/' + child.pid + '/fd').some((fd) => {
        try {
          return readlinkSync('/proc/' + child.pid + '/fd/' + fd) === 'anon_inode:inotify';
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  });
  await delay(100);
  const before = ticks(),
    start = performance.now();
  await delay(PARENT_LIVENESS_INTERVAL_MS * 2 + 250);
  const idleCpuTicks = ticks() - before,
    sampleMs = performance.now() - start;
  assert.ok(idleCpuTicks <= 1, 'unexpected idle waiter CPU: ' + idleCpuTicks);
  const result = await done;
  assert.equal(result.code, 0, stderr);
  assert.equal(JSON.parse(stdout).timedOut, true);
  assert.equal(
    f.ledger.snapshot((tx) => Number(tx.get('SELECT max(seq) AS n FROM events').n)),
    cursor
  );
  console.log(
    JSON.stringify({
      scenario: 'B11 idle CLI wait',
      sampleMs,
      idleCpuTicks,
      parentLivenessIntervalMs: PARENT_LIVENESS_INTERVAL_MS,
      logicalLedgerWrites: 0,
      node: process.versions.node,
      result: 'passed',
    })
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await done;
  await f.close();
}
