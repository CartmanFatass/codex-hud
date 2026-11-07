import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

import { JevFailure } from '../../src/jev/ask/error.js';
import {
  HEARTBEAT_MS,
  TEMP_MAX_AGE_MS,
  acquireBrowserLock,
  acquireWaitLease,
  probePid,
  readPidNamespace,
  tryAcquireBrowserLock,
  type LeaseDeps,
  type LockBody,
} from '../../src/jev/ask/lease.js';

function workspace(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'hud-jev-lease-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function deps(now: () => number, extra: Partial<LeaseDeps> = {}): Partial<LeaseDeps> {
  return {
    now,
    pid: () => 4242,
    pidns: () => 'pid:[box]',
    probePid: () => ({ alive: '99' }),
    random: () => 'nonce-new',
    sleep: async () => undefined,
    fsync: () => undefined,
    ...extra,
  };
}

const STALE_EDGE_MS = 30_000;

function body(over: Partial<LockBody> & { nonce: string }): LockBody {
  return {
    holder: 'hud',
    pid: 4242,
    pidns: 'pid:[box]',
    pidStart: '99',
    jobId: 'held',
    phase: 'send',
    since: 1_000_000,
    heartbeat: 1_000_000,
    ...over,
  };
}

function writeLock(file: string, value: LockBody | string): void {
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

test('heartbeat rewrites in place and release is idempotent', (t) => {
  const dir = workspace(t);
  let now = 1_000_000;
  const lease = tryAcquireBrowserLock({
    stateDir: dir,
    jobId: 'job',
    phase: 'send',
    heartbeat: false,
    deps: deps(() => now, { random: () => 'nonce-a' }),
  });
  const file = lease.path;
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const before = JSON.parse(readFileSync(file, 'utf8')) as LockBody;
  now += 5_000;
  lease.beat();
  const after = JSON.parse(readFileSync(file, 'utf8')) as LockBody;
  assert.equal(after.nonce, 'nonce-a');
  assert.equal(after.heartbeat, before.heartbeat + 5_000);
  assert.equal(after.pidStart, before.pidStart);
  assert.equal(after.pid, before.pid);

  writeLock(file, body({ nonce: 'successor', heartbeat: now, since: now }));
  lease.beat();
  assert.equal(lease.lost, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).nonce, 'successor');
  lease.release();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).nonce, 'successor');
  lease.release();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).nonce, 'successor');
});

test('a live lock is busy and a foreign nonce is not unlinked', (t) => {
  const dir = workspace(t);
  const now = 5_000_000;
  writeLock(
    join(dir, 'browser.lock'),
    body({ nonce: 'live', holder: 'cli', phase: 'reconcile', since: 42, heartbeat: now })
  );
  let slept = 0;
  assert.throws(
    () =>
      tryAcquireBrowserLock({
        stateDir: dir,
        jobId: 'other',
        phase: 'send',
        heartbeat: false,
        deps: deps(() => now, {
          sleep: async () => {
            slept += 1;
          },
        }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof JevFailure);
      assert.equal(error.code, 'browser_busy');
      assert.equal(error.details.holder, 'cli');
      assert.equal(error.details.phase, 'reconcile');
      assert.equal(error.details.since, 42);
      return true;
    }
  );
  assert.equal(slept, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'browser.lock'), 'utf8')).nonce, 'live');
});

test('pid start time is /proc stat field 22', () => {
  const live = probePid(process.pid);
  assert.equal(typeof live === 'object', true);
  if (typeof live === 'object') assert.match(live.alive, /^\d+$/);
  assert.equal(probePid(2147483646), 'dead');
  assert.equal(typeof readPidNamespace(), 'string');
});

test('stale rules: sandbox pid, dead pid, start time, age, unknown probe', (t) => {
  const dir = workspace(t);
  const now = 8_000_000;
  const lock = join(dir, 'browser.lock');

  writeLock(lock, body({ nonce: 'sand', pid: 1, pidns: 'pid:[1]', heartbeat: now }));
  assert.throws(
    () =>
      tryAcquireBrowserLock({
        stateDir: dir,
        jobId: 'x',
        phase: 'send',
        heartbeat: false,
        deps: deps(() => now, { probePid: () => 'dead' }),
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'browser_busy'
  );
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'sand');

  writeLock(lock, body({ nonce: 'dead-pid', pid: 2147483646, heartbeat: now }));
  const replacedDead = tryAcquireBrowserLock({
    stateDir: dir,
    jobId: 'x',
    phase: 'send',
    heartbeat: false,
    deps: deps(() => now, {
      probePid: (pid) => (pid === 2147483646 ? 'dead' : { alive: '99' }),
      random: () => 'after-dead',
    }),
  });
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'after-dead');
  replacedDead.release();

  writeLock(lock, body({ nonce: 'old-start', pidStart: '1', heartbeat: now }));
  const replacedStart = tryAcquireBrowserLock({
    stateDir: dir,
    jobId: 'x',
    phase: 'send',
    heartbeat: false,
    deps: deps(() => now, { random: () => 'after-start' }),
  });
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'after-start');
  replacedStart.release();

  writeLock(lock, body({ nonce: 'fresh', heartbeat: now }));
  assert.throws(
    () =>
      tryAcquireBrowserLock({
        stateDir: dir,
        jobId: 'x',
        phase: 'send',
        heartbeat: false,
        deps: deps(() => now, { random: () => 'should-not' }),
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'browser_busy'
  );
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'fresh');

  writeLock(lock, body({ nonce: 'aged', heartbeat: now - 31_000 }));
  const replacedAge = tryAcquireBrowserLock({
    stateDir: dir,
    jobId: 'x',
    phase: 'send',
    heartbeat: false,
    deps: deps(() => now, { random: () => 'after-age' }),
  });
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'after-age');
  replacedAge.release();

  writeLock(lock, body({ nonce: 'unknown', heartbeat: now }));
  assert.throws(
    () =>
      tryAcquireBrowserLock({
        stateDir: dir,
        jobId: 'x',
        phase: 'send',
        heartbeat: false,
        deps: deps(() => now, { probePid: () => 'unknown' }),
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'browser_busy'
  );
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'unknown');
});

test('create and break recheck the nonce and heartbeat', (t) => {
  const dir = workspace(t);
  const now = 9_000_000;
  const lock = join(dir, 'browser.lock');
  assert.throws(
    () =>
      tryAcquireBrowserLock({
        stateDir: dir,
        jobId: 'x',
        phase: 'send',
        heartbeat: false,
        hooks: {
          afterCreate() {
            writeLock(lock, body({ nonce: 'replaced', jobId: 'other', heartbeat: now, since: now }));
          },
        },
        deps: deps(() => now, { random: () => 'mine' }),
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'browser_busy'
  );
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'replaced');

  writeLock(lock, body({ nonce: 'stale', heartbeat: now - 31_000 }));
  assert.throws(
    () =>
      tryAcquireBrowserLock({
        stateDir: dir,
        jobId: 'x',
        phase: 'send',
        heartbeat: false,
        hooks: {
          afterBreakMutex() {
            const current = JSON.parse(readFileSync(lock, 'utf8')) as LockBody;
            current.heartbeat = now;
            writeLock(lock, current);
          },
        },
        deps: deps(() => now, { random: () => 'breaker' }),
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'browser_busy'
  );
  const kept = JSON.parse(readFileSync(lock, 'utf8')) as LockBody;
  assert.equal(kept.nonce, 'stale');
  assert.equal(kept.heartbeat, now);
  assert.throws(
    () => statSync(join(dir, 'browser.lock.break')),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
});

test('a live break file blocks, a dead or old one does not wedge', (t) => {
  const dir = workspace(t);
  const now = 7_000_000;
  const lock = join(dir, 'browser.lock');
  const brk = join(dir, 'browser.lock.break');
  const ours = deps(() => now);

  writeLock(lock, body({ nonce: 'stale-lock', heartbeat: now - 60_000 }));
  writeLock(brk, JSON.stringify({ pid: 4242, pidns: 'pid:[box]', pidStart: '99', since: now }));
  assert.throws(
    () => tryAcquireBrowserLock({ stateDir: dir, jobId: 'x', phase: 'send', heartbeat: false, deps: ours }),
    (error: unknown) => error instanceof JevFailure && error.code === 'browser_busy'
  );
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'stale-lock');
  assert.equal(JSON.parse(readFileSync(brk, 'utf8')).pid, 4242);

  writeLock(brk, JSON.stringify({ pid: 7, pidns: 'pid:[box]', pidStart: '', since: now }));
  const afterDead = tryAcquireBrowserLock({
    stateDir: dir,
    jobId: 'x',
    phase: 'send',
    heartbeat: false,
    deps: deps(() => now, {
      probePid: (pid) => (pid === 7 ? 'dead' : { alive: '99' }),
      random: () => 'took-dead-break',
    }),
  });
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'took-dead-break');
  assert.equal(
    readdirSync(dir).some((name) => name.endsWith('.stale')),
    false
  );
  afterDead.release();
  assert.throws(
    () => statSync(brk),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );

  writeLock(lock, body({ nonce: 'stale-again', heartbeat: now - 60_000 }));
  writeLock(brk, JSON.stringify({ pid: 1, pidns: 'pid:[other]', pidStart: '', since: now }));
  assert.throws(
    () =>
      tryAcquireBrowserLock({
        stateDir: dir,
        jobId: 'x',
        phase: 'send',
        heartbeat: false,
        deps: deps(() => now, { probePid: () => 'dead' }),
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'browser_busy'
  );
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'stale-again');
  assert.equal(JSON.parse(readFileSync(brk, 'utf8')).pidns, 'pid:[other]');

  writeLock(brk, JSON.stringify({ pid: 1, pidns: 'pid:[other]', pidStart: '', since: now - 31_000 }));
  const afterOld = tryAcquireBrowserLock({
    stateDir: dir,
    jobId: 'x',
    phase: 'send',
    heartbeat: false,
    deps: deps(() => now, { random: () => 'took-old-break' }),
  });
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'took-old-break');
  assert.equal(
    readdirSync(dir).some((name) => name.endsWith('.stale')),
    false
  );
  afterOld.release();
  assert.throws(
    () => statSync(brk),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
});

test('a fresh corrupt lock is busy and an old one can be broken', (t) => {
  const dir = workspace(t);
  const lock = join(dir, 'browser.lock');
  const now = Date.now();
  writeLock(lock, '{');
  assert.throws(
    () =>
      tryAcquireBrowserLock({
        stateDir: dir,
        jobId: 'x',
        phase: 'send',
        heartbeat: false,
        deps: deps(() => now, { random: () => 'fresh-corrupt' }),
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'browser_busy'
  );
  assert.equal(readFileSync(lock, 'utf8'), '{');

  utimesSync(lock, new Date(now - STALE_EDGE_MS), new Date(now - STALE_EDGE_MS));
  assert.throws(
    () =>
      tryAcquireBrowserLock({
        stateDir: dir,
        jobId: 'x',
        phase: 'send',
        heartbeat: false,
        deps: deps(() => now, { random: () => 'edge-corrupt' }),
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'browser_busy'
  );
  assert.equal(readFileSync(lock, 'utf8'), '{');

  utimesSync(lock, new Date(now - 31_000), new Date(now - 31_000));
  const lease = tryAcquireBrowserLock({
    stateDir: dir,
    jobId: 'x',
    phase: 'send',
    heartbeat: false,
    deps: deps(() => now, { random: () => 'from-corrupt' }),
  });
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'from-corrupt');
  lease.release();

  writeLock(lock, body({ nonce: 'under-break', heartbeat: now - 60_000 }));
  const brk = join(dir, 'browser.lock.break');
  writeFileSync(brk, '{', { mode: 0o600 });
  assert.throws(
    () =>
      tryAcquireBrowserLock({
        stateDir: dir,
        jobId: 'x',
        phase: 'send',
        heartbeat: false,
        deps: deps(() => now),
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'browser_busy'
  );
  assert.equal(readFileSync(brk, 'utf8'), '{');
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'under-break');

  utimesSync(brk, new Date(now - 31_000), new Date(now - 31_000));
  const afterBreak = tryAcquireBrowserLock({
    stateDir: dir,
    jobId: 'x',
    phase: 'send',
    heartbeat: false,
    deps: deps(() => now, { random: () => 'from-old-break' }),
  });
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'from-old-break');
  assert.equal(
    readdirSync(dir).some((name) => name.endsWith('.stale')),
    false
  );
  afterBreak.release();
  assert.throws(
    () => statSync(brk),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
});

test('the host polls and then reports browser_busy', async (t) => {
  const dir = workspace(t);
  let now = 0;
  writeLock(join(dir, 'browser.lock'), body({ nonce: 'held', heartbeat: 0, since: 7, holder: 'cli' }));
  const gained = acquireBrowserLock({
    stateDir: dir,
    jobId: 'host',
    phase: 'send',
    heartbeat: false,
    waitMs: 5_000,
    pollMs: 100,
    deps: deps(() => now, {
      sleep: async (ms) => {
        now += ms;
        rmSync(join(dir, 'browser.lock'));
      },
      random: () => 'host-nonce',
    }),
  });
  const lease = await gained;
  assert.equal(lease.nonce, 'host-nonce');
  lease.release();

  writeLock(join(dir, 'browser.lock'), body({ nonce: 'stuck', heartbeat: 0, since: 7, holder: 'cli' }));
  now = 0;
  let sleeps = 0;
  await assert.rejects(
    () =>
      acquireBrowserLock({
        stateDir: dir,
        jobId: 'host',
        phase: 'send',
        heartbeat: false,
        waitMs: 250,
        pollMs: 100,
        deps: deps(() => now, {
          sleep: async (ms) => {
            sleeps += 1;
            now += ms;
          },
        }),
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'browser_busy' && error.details.holder === 'cli'
  );
  assert.equal(sleeps, 3);
  assert.equal(JSON.parse(readFileSync(join(dir, 'browser.lock'), 'utf8')).nonce, 'stuck');
});

test('the second waiter tails and a stale wait lease can be owned', (t) => {
  const dir = workspace(t);
  const key = 'review-key';
  const owner = acquireWaitLease(dir, key, {
    jobId: 'owner',
    phase: 'wait',
    heartbeat: false,
    deps: deps(() => 100, { random: () => 'wait-owner' }),
  });
  assert.equal(owner.role, 'owner');
  if (owner.role !== 'owner') return;
  const tail = acquireWaitLease(dir, key, { jobId: 'tail', phase: 'wait', heartbeat: false, deps: deps(() => 100) });
  assert.equal(tail.role, 'tail');
  if (tail.role === 'tail') {
    assert.equal(tail.observe, false);
    assert.equal(tail.jobId, 'owner');
    assert.equal(tail.phase, 'wait');
  }
  assert.equal(JSON.parse(readFileSync(join(dir, 'operations', 'review-key.wait.lease'), 'utf8')).nonce, 'wait-owner');
  owner.lease.release();

  const stale = join(dir, 'operations', 'review-key.wait.lease');
  writeLock(stale, body({ nonce: 'old-wait', heartbeat: 0, phase: 'wait' }));
  const again = acquireWaitLease(dir, key, {
    jobId: 'next',
    phase: 'wait',
    heartbeat: false,
    deps: deps(() => 100_000, { random: () => 'wait-next' }),
  });
  assert.equal(again.role, 'owner');
  if (again.role === 'owner') {
    assert.equal(again.observe, true);
    assert.equal(again.lease.nonce, 'wait-next');
    again.lease.release();
  }
});

test('a missing state directory is not created', (t) => {
  const dir = workspace(t);
  const missing = join(dir, 'no-such-state');
  assert.throws(
    () => tryAcquireBrowserLock({ stateDir: missing, jobId: 'x', phase: 'send', heartbeat: false }),
    (error: unknown) => error instanceof JevFailure && error.code === 'jev_state_dir_missing'
  );
  assert.equal(existsSync(missing), false);
});

test('acquire sweeps temp files older than an hour', (t) => {
  const dir = workspace(t);
  const now = Date.now();
  const old = join(dir, 'browser.lock.1.old.tmp');
  const young = join(dir, 'browser.lock.1.young.tmp');
  const oldStale = join(dir, 'browser.lock.break.1.old.stale');
  const youngStale = join(dir, 'browser.lock.break.1.young.stale');
  writeFileSync(old, 'old');
  writeFileSync(young, 'young');
  writeFileSync(oldStale, 'old');
  writeFileSync(youngStale, 'young');
  const operations = join(dir, 'operations');
  mkdirSync(operations);
  const oldRecord = join(operations, 'review-key.1.old.tmp');
  const oldWaitStale = join(operations, 'review-key.wait.lease.break.1.old.stale');
  writeFileSync(oldRecord, 'old');
  writeFileSync(oldWaitStale, 'old');
  const aged = new Date(now - TEMP_MAX_AGE_MS - 1_000);
  utimesSync(old, aged, aged);
  utimesSync(oldRecord, aged, aged);
  utimesSync(oldStale, aged, aged);
  utimesSync(oldWaitStale, aged, aged);
  const lease = tryAcquireBrowserLock({
    stateDir: dir,
    jobId: 'x',
    phase: 'send',
    heartbeat: false,
    deps: deps(() => now),
  });
  t.after(() => lease.release());
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(oldRecord), false);
  assert.equal(existsSync(oldStale), false);
  assert.equal(existsSync(oldWaitStale), false);
  assert.equal(readFileSync(young, 'utf8'), 'young');
  assert.equal(readFileSync(youngStale, 'utf8'), 'young');
});

test('a stale break restore links and leaves a newer break file', (t) => {
  const dir = workspace(t);
  const now = 9_000_000;
  const lock = join(dir, 'browser.lock');
  const brk = join(dir, 'browser.lock.break');
  writeLock(lock, body({ nonce: 'still-held', heartbeat: now - 60_000 }));
  writeLock(brk, JSON.stringify({ pid: 7, pidns: 'pid:[box]', pidStart: '', since: now - 60_000 }));
  const newer = { pid: 8, pidns: 'pid:[other]', pidStart: '', since: now };
  assert.throws(
    () =>
      tryAcquireBrowserLock({
        stateDir: dir,
        jobId: 'x',
        phase: 'send',
        heartbeat: false,
        hooks: {
          afterStaleRename(stalePath) {
            writeFileSync(stalePath, '{"pid":1,"changed":true}\n');
            writeFileSync(brk, `${JSON.stringify(newer)}\n`, { mode: 0o600 });
          },
        },
        deps: deps(() => now, { random: () => 'restore-case' }),
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'browser_busy'
  );
  assert.deepEqual(JSON.parse(readFileSync(brk, 'utf8')), newer);
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'still-held');
  assert.equal(
    readdirSync(dir).some((name) => name.endsWith('.stale')),
    false
  );
});

test('a polling acquire sweeps old temps once', async (t) => {
  const dir = workspace(t);
  let now = 1_000_000_000;
  writeLock(join(dir, 'browser.lock'), body({ nonce: 'held', heartbeat: now, since: now, holder: 'cli' }));
  const planted = join(dir, 'browser.lock.9.late.tmp');
  let sleeps = 0;
  await assert.rejects(
    () =>
      acquireBrowserLock({
        stateDir: dir,
        jobId: 'host',
        phase: 'send',
        heartbeat: false,
        waitMs: 250,
        pollMs: 100,
        deps: deps(() => now, {
          sleep: async (ms) => {
            sleeps += 1;
            if (sleeps === 1) {
              writeFileSync(planted, 'late');
              const aged = new Date(now - TEMP_MAX_AGE_MS - 1_000);
              utimesSync(planted, aged, aged);
            }
            now += ms;
          },
        }),
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'browser_busy'
  );
  assert.ok(sleeps > 1);
  assert.equal(readFileSync(planted, 'utf8'), 'late');
});

test('a heartbeat file error marks the lease lost and does not throw', (t) => {
  const dir = workspace(t);
  let fail = false;
  const lease = tryAcquireBrowserLock({
    stateDir: dir,
    jobId: 'job',
    phase: 'send',
    heartbeat: false,
    deps: deps(() => 1_000, {
      fsync() {
        if (fail) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
    }),
  });
  fail = true;
  assert.doesNotThrow(() => lease.beat());
  assert.equal(lease.lost, true);
  lease.release();
  assert.equal(existsSync(lease.path), true);
  rmSync(lease.path);

  const blocked = tryAcquireBrowserLock({
    stateDir: dir,
    jobId: 'other',
    phase: 'send',
    heartbeat: false,
    deps: deps(() => 1_000, { random: () => 'open-error' }),
  });
  chmodSync(blocked.path, 0);
  assert.doesNotThrow(() => blocked.beat());
  assert.equal(blocked.lost, true);
  chmodSync(blocked.path, 0o600);
  blocked.release();
  assert.equal(JSON.parse(readFileSync(blocked.path, 'utf8')).nonce, 'open-error');
});

test('the heartbeat timer swallows a file error', (t) => {
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  const dir = workspace(t);
  let fail = false;
  const lease = tryAcquireBrowserLock({
    stateDir: dir,
    jobId: 'job',
    phase: 'send',
    deps: deps(() => 5_000, {
      fsync() {
        if (fail) throw new Error('EIO');
      },
    }),
  });
  t.after(() => lease.release());
  fail = true;
  assert.doesNotThrow(() => mock.timers.tick(HEARTBEAT_MS));
  assert.equal(lease.lost, true);
});

test('a disappeared wait lease is retried once and a fresh corrupt one is wait_busy', (t) => {
  const dir = workspace(t);
  const key = 'review-key';
  const owner = acquireWaitLease(dir, key, {
    jobId: 'owner',
    phase: 'wait',
    heartbeat: false,
    deps: deps(() => 100, { random: () => 'first' }),
  });
  assert.equal(owner.role, 'owner');
  if (owner.role !== 'owner') return;
  let releases = 0;
  const next = acquireWaitLease(dir, key, {
    jobId: 'next',
    phase: 'wait',
    heartbeat: false,
    hooks: {
      onBusy() {
        releases += 1;
        if (releases === 1) owner.lease.release();
      },
    },
    deps: deps(() => 100, { random: () => 'second' }),
  });
  assert.equal(releases, 1);
  assert.equal(next.role, 'owner');
  if (next.role === 'owner') {
    assert.equal(next.lease.nonce, 'second');
    next.lease.release();
  }

  const file = join(dir, 'operations', `${key}.wait.lease`);
  writeFileSync(file, '{', { mode: 0o600 });
  assert.throws(
    () => acquireWaitLease(dir, key, { jobId: 'x', phase: 'wait', heartbeat: false, deps: deps(() => Date.now()) }),
    (error: unknown) => error instanceof JevFailure && error.code === 'wait_busy'
  );
  assert.equal(readFileSync(file, 'utf8'), '{');
});

const childScript = `
import * as fs from 'node:fs';
import { tryAcquireBrowserLock } from ${JSON.stringify(new URL('../../src/jev/ask/lease.js', import.meta.url).href)};
import { persistClick } from ${JSON.stringify(new URL('../../src/jev/ask/records.js', import.meta.url).href)};

const [stateDir, key, role, mode, log] = process.argv.slice(1);
function line(event) {
  fs.appendFileSync(log, JSON.stringify(event) + '\\n');
}
function codeOf(error) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}
fs.writeFileSync(stateDir + '/ready-' + role, '1');
const deadline = Date.now() + 5_000;
while (!fs.existsSync(stateDir + '/ready-a') || !fs.existsSync(stateDir + '/ready-b')) {
  if (Date.now() > deadline) {
    console.error('ready barrier timed out');
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}
try {
  const lease = tryAcquireBrowserLock({
    stateDir,
    jobId: role,
    phase: 'send',
    heartbeat: false,
    holder: 'hud',
  });
  line({ event: 'hold', role, nonce: lease.nonce });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const again = JSON.parse(fs.readFileSync(lease.path, 'utf8'));
  if (again.nonce !== lease.nonce) line({ event: 'stolen', role, nonce: lease.nonce, saw: again.nonce });
  let click = 'skipped';
  if (mode === 'click') {
    try {
      persistClick(stateDir, key, { note: role }, lease);
      click = 'ok';
    } catch (error) {
      click = codeOf(error) || 'error';
    }
  }
  line({ event: 'drop', role, nonce: lease.nonce, click });
  lease.release();
} catch (error) {
  const code = codeOf(error);
  if (code === 'browser_busy' || code === 'wait_busy') {
    line({ event: 'busy', role, code });
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
}
`;

interface RaceEvent {
  event: string;
  role: string;
  click?: string;
  nonce?: string;
}

function runRacer(stateDir: string, key: string, role: string, mode: string, log: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, stateDir, key, role, mode, log], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`racer ${role} exited ${code}: ${stderr}`));
    });
  });
}

function raceEvents(log: string): RaceEvent[] {
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RaceEvent);
}

function assertExclusive(events: RaceEvent[]): void {
  let open = 0;
  for (const event of events) {
    assert.equal(event.event === 'stolen', false);
    if (event.event === 'hold') {
      open += 1;
      assert.equal(open, 1);
    } else if (event.event === 'drop') {
      open -= 1;
      assert.equal(open >= 0, true);
    }
  }
  assert.equal(open, 0);
}

test('two processes contend for the browser lock and one click wins', async (t) => {
  const dir = workspace(t);
  const key = 'review-key';
  const log = join(dir, 'race.log');
  writeFileSync(log, '');
  for (let round = 0; round < 10; round += 1) {
    rmSync(join(dir, 'ready-a'), { force: true });
    rmSync(join(dir, 'ready-b'), { force: true });
    await Promise.all([runRacer(dir, key, 'a', 'click', log), runRacer(dir, key, 'b', 'click', log)]);
  }
  const events = raceEvents(log);
  assertExclusive(events);
  assert.equal(events.filter((event) => event.click === 'ok').length, 1);
  const disk = JSON.parse(readFileSync(join(dir, 'operations', `${key}.json`), 'utf8')) as { send_attempted?: boolean };
  assert.equal(disk.send_attempted, true);
});

test('two processes contend for a stale lock and for an old corrupt lock', async (t) => {
  const dir = workspace(t);
  const log = join(dir, 'break.log');
  const lock = join(dir, 'browser.lock');
  for (let round = 0; round < 4; round += 1) {
    writeFileSync(log, '');
    rmSync(join(dir, 'ready-a'), { force: true });
    rmSync(join(dir, 'ready-b'), { force: true });
    const staleAt = Date.now() - 60_000;
    writeLock(
      lock,
      body({
        nonce: `stale-${round}`,
        pid: 1,
        pidns: 'pid:[other]',
        heartbeat: staleAt,
        since: staleAt,
      })
    );
    await Promise.all([runRacer(dir, 'review-key', 'a', 'lock', log), runRacer(dir, 'review-key', 'b', 'lock', log)]);
    const events = raceEvents(log);
    assertExclusive(events);
    assert.equal(events.filter((event) => event.event === 'hold').length, 1);
    assert.equal(events.filter((event) => event.event === 'busy').length, 1);
  }
  for (let round = 0; round < 4; round += 1) {
    writeFileSync(log, '');
    rmSync(join(dir, 'ready-a'), { force: true });
    rmSync(join(dir, 'ready-b'), { force: true });
    writeFileSync(lock, '{', { mode: 0o600 });
    const aged = new Date(Date.now() - 60_000);
    utimesSync(lock, aged, aged);
    await Promise.all([runRacer(dir, 'review-key', 'a', 'lock', log), runRacer(dir, 'review-key', 'b', 'lock', log)]);
    const events = raceEvents(log);
    assertExclusive(events);
    assert.equal(events.filter((event) => event.event === 'hold').length, 1);
    assert.equal(events.filter((event) => event.event === 'busy').length, 1);
  }
});
