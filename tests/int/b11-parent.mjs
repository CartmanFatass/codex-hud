// Synthetic run_in_background-style process contract: detached waiter, owned file output.
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
const [home, runId] = process.argv.slice(2);
const stdout = openSync(join(home, 'wait.stdout'), 'wx', 0o600);
const stderr = openSync(join(home, 'wait.stderr'), 'wx', 0o600);
const child = spawn(
  process.execPath,
  [resolve('bin/hud'), 'run', 'wait', runId, '--timeout-ms', '120000', '--notify'],
  {
    detached: true,
    env: { PATH: '/usr/bin:/bin', HOME: home, HUD_HOME: home },
    stdio: ['ignore', stdout, stderr],
  }
);
closeSync(stdout);
closeSync(stderr);
child.once('spawn', () => process.send({ pid: child.pid }));
child.unref();
// IPC keeps this real parent alive until the test kills it at a checked startup point.
process.on('message', () => {});
