import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { binScript } from '../../dist/mcp/paths.js';
import { procStat, reapWorkerTree, tabTreeGrant } from '../../dist/roles/worker-tree.js';
import { isProcAlive } from '../../dist/utils/proc.js';

test('stopping through another jobs-root alias excludes a separately registered detached Sonic', async t => {
  const temp = fs.mkdtempSync(join(tmpdir(), 'hud-sonic-alias-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const jobs = join(temp, 'jobs'), a = join(temp, 'launch-jobs'), b = join(temp, 'stop-jobs');
  const dir = join(jobs, 'parent'), childDir = join(jobs, 'child');
  fs.mkdirSync(join(dir, '.sonic'), { recursive: true }); fs.mkdirSync(childDir);
  fs.symlinkSync(jobs, a); fs.symlinkSync(jobs, b);
  fs.writeFileSync(join(dir, '.sonic', 'child'), ''); fs.writeFileSync(join(dir, 'SESSION.txt'), 'LEFT=worker\nORCH=caller\n');

  // A real sonic-run, blocked on its launch handshake. Never send the start command.
  const script = `const child = require('node:child_process').spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: ['pipe','ignore','ignore'] });
    process.on('message', () => child.stdin.end()); child.on('exit', () => process.disconnect()); process.send(child.pid);`;
  const root = spawn(process.execPath, ['-e', script, binScript('sonic-run'), childDir], { stdio: ['ignore','ignore','ignore','ipc'] });
  const exit = once(root, 'exit');
  t.after(async () => { if (root.connected) root.send('finish'); await exit; });
  const [pid] = await once(root, 'message'), start = procStat(pid).start;
  const status = { slot: 'primary', task_dir: join(a, 'parent'), pid: root.pid, pid_start_time: procStat(root.pid).start };
  const result = await reapWorkerTree(join(b, 'parent'), status, () => ({ reason: 'ok', stdout: `tree-owner ${root.pid}:${status.pid_start_time}\n` }),
    r => r.reason === 'ok', { treeGrant: tabTreeGrant });
  assert.equal(result.complete, true); assert.deepEqual(result.snapshot.members, []);
  assert.ok(isProcAlive(pid, start), 'the Sonic remains owned by its own reaper');
});

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
