import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, openSync, readFileSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchGroup,
  processState,
  readProcess,
  proveGroupGone,
  type GroupProcess,
} from '../../src/core/run/process.js';
import type { ProcessStamp } from '../../src/core/types/supervision.js';

test('sealing protocol input keeps existing stdout tee alive through final drain', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-chat-drain-'));
  const out = join(home, 'stdout.log');
  const fd = openSync(out, 'w', 0o600),
    err = openSync(join(home, 'stderr.log'), 'w', 0o600);
  let group: GroupProcess | undefined;
  let observed = 0,
    ended = false;
  try {
    group = await launchGroup({
      runId: 'synthetic-chat-drain',
      argv: [
        process.execPath,
        '-e',
        "process.stdin.resume();process.stdin.once('end',()=>process.stdout.write(Buffer.alloc(262144,'x'),()=>process.exit(0)));",
      ],
      cwd: home,
      env: { HOME: home, HUD_HOME: home, PATH: '/usr/bin:/bin' },
      stdin: null,
      stdoutFd: fd,
      stderrFd: err,
      duplex: {
        onData(chunk) {
          observed += chunk.length;
        },
        onClose() {
          ended = true;
        },
      },
    });
    group.close();
    await group.exited;
    assert.equal(ended, true);
    assert.equal(observed, 262144);
    assert.equal(readFileSync(out).length, 262144);
  } finally {
    if (group) {
      for (const stamp of [group.command, group.helper])
        if (stamp && processState(stamp) === 'alive') {
          try {
            process.kill(stamp.pid, 'SIGKILL');
          } catch {}
        }
      group.close();
      await group.exited;
    }
    closeSync(fd);
    closeSync(err);
    rmSync(home, { recursive: true, force: true });
  }
});

test('descendant-held stdout has a bounded drain and is not mistaken for scope completion', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-chat-held-pipe-'));
  const out = join(home, 'stdout.log'),
    stderr = join(home, 'stderr.log');
  const fd = openSync(out, 'w', 0o600),
    err = openSync(stderr, 'w', 0o600);
  let group: GroupProcess | undefined, descendant: ProcessStamp | undefined;
  let closed = 0;
  let deadline: NodeJS.Timeout | undefined;
  try {
    const script = `
      const {spawn}=require('node:child_process');
      const {writeFileSync}=require('node:fs');
      process.stdin.resume();
      process.stdin.once('end',()=>{
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,'ignore']});
        child.once('spawn',()=>{
          writeFileSync('descendant.pid',String(child.pid));
          process.stdout.write('drained-before-deadline',()=>process.exit(0));
        });
      });`;
    group = await launchGroup({
      runId: 'synthetic-chat-held-pipe',
      argv: [process.execPath, '-e', script],
      cwd: home,
      env: { HOME: home, HUD_HOME: home, PATH: '/usr/bin:/bin' },
      stdin: null,
      stdoutFd: fd,
      stderrFd: err,
      duplex: {
        onData() {},
        onClose() {
          closed++;
        },
      },
    });
    group.close();
    const pidDeadline = Date.now() + 2000;
    while (Date.now() < pidDeadline && !descendant) {
      try {
        descendant = readProcess(Number(readFileSync(join(home, 'descendant.pid'), 'utf8')))?.stamp;
      } catch {}
      if (!descendant) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(descendant, 'owned descendant must be identified before cleanup');
    await Promise.race([
      group.exited,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('stdout_drain_unbounded')), 4000);
      }),
    ]);
    assert.equal(closed, 1);
    assert.equal(readFileSync(out, 'utf8'), 'drained-before-deadline');
    assert.match(readFileSync(stderr, 'utf8'), /hud-run chat stdout drain incomplete/);
    assert.equal(processState(descendant), 'alive', 'bounded observation does not kill a descendant');
    assert.ok(group.scope && group.command);
    assert.equal(proveGroupGone(group.scope, group.command, [group.helper, group.command]), false);
  } finally {
    clearTimeout(deadline);
    for (const stamp of [descendant, group?.command, group?.helper]) {
      if (stamp && processState(stamp) === 'alive') {
        try {
          process.kill(stamp.pid, 'SIGKILL');
        } catch {}
      }
    }
    if (group) {
      group.close();
      await group.exited;
    }
    closeSync(fd);
    closeSync(err);
    rmSync(home, { recursive: true, force: true });
  }
});
