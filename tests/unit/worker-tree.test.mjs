import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { procStat, reapWorkerTree, tabTreeGrant } from '../../dist/roles/worker-tree.js';
import { isProcAlive } from '../../dist/utils/proc.js';

test('tree cleanup through real path captures a detached descendant of an aliased browser receipt', async t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-tree-alias-')), dir = join(home, 'real'), alias = join(home, 'link');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(dir); fs.symlinkSync(dir, alias);
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'LEFT=worker-pane\nORCH=caller\n');
  const root = spawn(process.execPath, ['-e', `const child = require('node:child_process').spawn('/bin/sleep', ['600'], {detached:true,stdio:'ignore'}); process.send(child.pid);`], { stdio: ['ignore','ignore','ignore','ipc'] });
  const exit = once(root, 'exit'); t.after(() => root.kill('SIGKILL'));
  const [pid] = await once(root, 'message'), start = procStat(pid).start;
  t.after(() => { if (isProcAlive(pid, start)) process.kill(pid, 'SIGKILL'); });
  const status = { version: 1, task_dir: alias, slot: 'primary', state: 'working', harness: 'bro', pid: root.pid, pid_start_time: procStat(root.pid).start };
  const wrong = await reapWorkerTree(dir, { ...status, task_dir: home }, () => true, Boolean);
  assert.equal(wrong.complete, false); assert.match(wrong.issue, /task directory mismatch/); assert.ok(isProcAlive(pid, start));
  const result = await reapWorkerTree(dir, status, async () => {
    root.kill('SIGTERM'); await exit; assert.ok(isProcAlive(pid, start));
    return { reason: 'ok', stdout: `tree-owner ${root.pid}:${status.pid_start_time}\n` };
  }, r => r.reason === 'ok', { treeGrant: tabTreeGrant });
  assert.equal(result.complete, true); assert.deepEqual(result.snapshot.members, [{ pid, start }]); assert.equal(isProcAlive(pid, start), false);
});
