import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import {
  isActiveProcState,
  isProcAlive,
  isValidPid,
  listProcPids,
  parseProcStat,
  procStartTimeSec,
  procStat,
  readBootId,
  readBootTimeSec,
  readProcChildren,
  readProcCmdline,
  readProcComm,
  readProcEnviron,
  readProcEnvValue,
  readProcStat,
  readProcUid,
} from '../../dist/utils/proc.js';

async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(child, 'exit');
  return child.pid;
}

test('parseProcStat handles spaces and parentheses in comm and rejects malformed records', () => {
  const stat = parseProcStat('42 (Web Content (1)) S 10 42 42 0 0 0 0 0 0 0 0 0 0 0 0 0 3 0 987654 0\n');
  assert.deepEqual(stat, { state: 'S', ppid: 10, pgrp: 42, session: 42, threads: 3, start: '987654' });
  assert.equal(parseProcStat('42 broken without parens'), null);
  assert.equal(parseProcStat('42 (short) S 1'), null);
  assert.equal(isActiveProcState('S'), true);
  assert.equal(isActiveProcState('R'), true);
  assert.equal(isActiveProcState('Z'), false);
  assert.equal(isActiveProcState('X'), false);
  assert.equal(isActiveProcState('x'), false);
  assert.equal(isValidPid(process.pid), true);
  assert.equal(isValidPid(1), false);
  assert.equal(isValidPid(0), false);
  assert.equal(isValidPid('12'), false);
});

test('reads stat, cmdline, environ, comm, uid, boot info and alive state for the test process', async () => {
  const self = procStat(process.pid);
  assert.ok(self);
  assert.equal(self.ppid, process.ppid);
  assert.match(self.start, /^\d+$/);
  assert.equal(isActiveProcState(self.state), true);
  assert.equal(isProcAlive(process.pid), true);
  assert.equal(isProcAlive(process.pid, self.start), true);
  assert.equal(isProcAlive(process.pid, '0'), false);

  const argv = readProcCmdline(process.pid);
  assert.ok(Array.isArray(argv) && argv.length >= 1);
  assert.ok(argv[0].includes('node'));

  assert.equal(readProcComm(process.pid)?.length > 0, true);
  assert.equal(readProcUid(process.pid), process.getuid?.());
  assert.ok(readBootId()?.length > 0);
  const bootSec = readBootTimeSec();
  const startSec = procStartTimeSec(process.pid);
  assert.ok(typeof bootSec === 'number' && bootSec > 0);
  assert.ok(typeof startSec === 'number' && startSec >= bootSec);
  assert.ok(listProcPids().includes(process.pid));

  const marker = 'SYNTHETIC=VALUE=WITH=EQUALS';
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { ...process.env, HUD_PROC_TEST_MARKER: marker },
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  try {
    const env = readProcEnviron(child.pid);
    assert.equal(env.HUD_PROC_TEST_MARKER, marker);
    assert.equal(Object.hasOwn(env, ''), false);
    assert.equal(readProcEnvValue(child.pid, 'HUD_PROC_TEST_MARKER'), marker);
    assert.equal(readProcEnvValue(child.pid, 'HUD_PROC_TEST_ABSENT'), null);
    const children = readProcChildren(process.pid);
    assert.ok(children);
    assert.equal(children.truncated, false);
    assert.ok(children.pids.includes(child.pid));
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
});

test('treats a dead or invalid pid as absent and distinguishes unreadable /proc in strict mode', async (t) => {
  const gone = await deadPid();
  assert.equal(procStat(gone), null);
  assert.equal(readProcStat(gone, { strict: true }), null);
  assert.equal(isProcAlive(gone), false);
  assert.equal(isProcAlive(gone, '1'), false);
  assert.equal(readProcCmdline(gone), null);
  assert.equal(readProcEnviron(gone), null);
  assert.equal(readProcEnvValue(gone, 'PATH'), null);
  assert.equal(readProcComm(gone), null);
  assert.equal(readProcUid(gone), null);
  assert.equal(procStartTimeSec(gone), null);
  assert.equal(readProcChildren(gone), null);
  assert.equal(procStat(0), null);
  assert.equal(isProcAlive(-1), false);

  const { readFileSync } = fs;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (String(path) === `/proc/${process.pid}/stat`) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return readFileSync(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  assert.equal(procStat(process.pid), null);
  assert.throws(() => readProcStat(process.pid, { strict: true }), { code: 'EACCES' });
  // Without expectedStart, alive check falls back to kill(pid, 0) when /proc is unreadable.
  assert.equal(isProcAlive(process.pid), true);
  assert.equal(isProcAlive(process.pid, '1'), false);
});
