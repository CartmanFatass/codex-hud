import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { waitUntilFs } from '../../dist/utils/fs-wait.js';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

function makeTempDir(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'fs-wait-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function trackWatches(t, wrap) {
  const realWatch = fs.watch;
  const stats = { opened: 0, closed: 0, active: 0, dirs: [] };
  fs.watch = function patchedWatch(target, options, listener) {
    if (typeof options === 'function') {
      listener = options;
      options = undefined;
    }
    stats.dirs.push(String(target));
    const watcher = wrap
      ? wrap(realWatch, target, options, listener, stats)
      : realWatch.call(this, target, options, listener);
    stats.opened++;
    stats.active++;
    const realClose = watcher.close.bind(watcher);
    let closed = false;
    watcher.close = function trackedClose() {
      if (!closed) {
        closed = true;
        stats.closed++;
        stats.active--;
      }
      return realClose();
    };
    return watcher;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.watch = realWatch;
    syncBuiltinESMExports();
  });
  return stats;
}

test('waitUntilFs fast-path and timeoutMs<=0 allocate zero watchers', async (t) => {
  const dir = makeTempDir(t);
  const stats = trackWatches(t);

  const immediate = await waitUntilFs({
    targets: [{ dir }],
    timeoutMs: 5000,
    check: ({ reason, timedOut }) => {
      assert.equal(reason, 'initial');
      assert.equal(timedOut, false);
      return { done: true, value: 'ready' };
    },
  });
  assert.equal(immediate, 'ready');
  assert.equal(stats.opened, 0);

  const zeroBudget = await waitUntilFs({
    targets: [{ dir }],
    timeoutMs: 0,
    check: ({ reason, timedOut }) => {
      assert.equal(reason, 'initial');
      assert.equal(timedOut, true);
      return { done: true, value: 'snapshot' };
    },
  });
  assert.equal(zeroBudget, 'snapshot');
  assert.equal(stats.opened, 0);
  assert.equal(stats.active, 0);
});

test('waitUntilFs wakes within 100 ms of a file change and closes all watchers', { timeout: 30000 }, async (t) => {
  const dir = makeTempDir(t);
  const stats = trackWatches(t);
  const file = join(dir, 'STATUS.json');

  const armed = Promise.withResolvers(), delivered = Promise.withResolvers();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = waitUntilFs({
    targets: [{ dir, filter: (name) => {
      if (name !== null && name !== 'STATUS.json') return false;
      delivered.resolve();
      return true;
    } }],
    timeoutMs: Infinity, signal: t.signal,
    check: ({ reason }) => {
      if (reason === 'catchup') armed.resolve();
      if (reason === 'event') return { done: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
      return { done: false };
    },
  });

  await armed.promise;
  assert.equal(stats.active, 1);
  writeFixtureFile(file, JSON.stringify({ state: 'done' }));
  await delivered.promise; // Real fs.watch delivery; only the wake-up timers use virtual time.
  t.mock.timers.tick(99);
  const result = await Promise.race([waiting, new Promise(resolve => setImmediate(resolve))]);
  assert.deepEqual(result, { state: 'done' }, 'must wake in <100 ms without a fallback tick');
  assert.equal(stats.active, 0);
  assert.equal(stats.closed, stats.opened);
});

test('waitUntilFs settles on timeout after full budget and closes all watchers', async (t) => {
  const dir = makeTempDir(t);
  const stats = trackWatches(t);
  const reasons = [];

  const start = performance.now();
  const result = await waitUntilFs({
    targets: [{ dir }],
    timeoutMs: 120,
    fallbackIntervalMs: 5000,
    check: ({ timedOut, reason }) => {
      reasons.push(reason);
      if (timedOut) return { done: true, value: 'timed-out' };
      return { done: false };
    },
  });
  const elapsed = performance.now() - start;

  assert.equal(result, 'timed-out');
  assert.ok(elapsed >= 120, `expected elapsed >= 120 ms, got ${elapsed.toFixed(1)} ms`);
  assert.equal(reasons.at(-1), 'timeout');
  assert.equal(stats.active, 0);
  assert.equal(stats.closed, stats.opened);
});

test('waitUntilFs catchup eliminates the setup race between initial check and fs.watch', async (t) => {
  const dir = makeTempDir(t);
  const file = join(dir, 'STATUS.json');
  const reasons = [];
  const stats = trackWatches(t, (realWatch, target, options, listener) => {
    const watcher = realWatch(target, options, listener);
    // Simulate a peer writing right as the watcher is attached.
    writeFixtureFile(file, JSON.stringify({ state: 'closed' }));
    return watcher;
  });

  const start = performance.now();
  const result = await waitUntilFs({
    targets: [{ dir }],
    timeoutMs: 5000,
    fallbackIntervalMs: 5000,
    check: ({ timedOut, reason }) => {
      reasons.push(reason);
      if (fs.existsSync(file)) return { done: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
      if (timedOut) return { done: true, value: null };
      return { done: false };
    },
  });

  assert.deepEqual(result, { state: 'closed' });
  assert.deepEqual(reasons, ['initial', 'catchup']);
  assert.ok(performance.now() - start < 100);
  assert.equal(stats.active, 0);
});

test('waitUntilFs coalesces bursty atomic renames with a non-sliding window', async (t) => {
  const dir = makeTempDir(t);
  const file = join(dir, 'STATUS.json');
  const stats = trackWatches(t);
  let eventChecks = 0;
  const ready = Promise.withResolvers();

  const waiting = waitUntilFs({
    targets: [{ dir, filter: (name) => name === null || name === 'STATUS.json' }],
    timeoutMs: 5000,
    coalesceMs: 25,
    check: ({ timedOut, reason }) => {
      if (reason === 'catchup') ready.resolve();
      if (reason === 'event') eventChecks++;
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed.seq === 20) return { done: true, value: parsed };
      }
      if (timedOut) return { done: true, value: null };
      return { done: false };
    },
  });

  await ready.promise;
  for (let i = 1; i <= 20; i++) {
    writeFixtureFile(file, JSON.stringify({ seq: i }));
  }

  const result = await waiting;
  assert.deepEqual(result, { seq: 20 });
  assert.ok(eventChecks >= 1 && eventChecks <= 3, `expected coalesced checks (<=3), got ${eventChecks}`);
  assert.equal(stats.active, 0);
});

test('waitUntilFs retries transient SyntaxError without aborting the wait', async (t) => {
  const dir = makeTempDir(t);
  const file = join(dir, 'STATUS.json');
  const stats = trackWatches(t);
  let sawTruncated = false;
  const ready = Promise.withResolvers();
  const truncatedSeen = Promise.withResolvers();

  const waiting = waitUntilFs({
    targets: [{ dir, filter: (name) => name === null || name === 'STATUS.json' }],
    timeoutMs: 5000,
    coalesceMs: 5,
    isTransientError: (error) => error instanceof SyntaxError,
    check: ({ timedOut, reason }) => {
      if (reason === 'catchup') ready.resolve();
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        try {
          const parsed = JSON.parse(raw);
          return { done: true, value: parsed };
        } catch (error) {
          sawTruncated = true;
          truncatedSeen.resolve();
          throw error;
        }
      }
      if (timedOut) return { done: true, value: null };
      return { done: false };
    },
  });

  await ready.promise;
  fs.writeFileSync(file, '{"state":');
  await truncatedSeen.promise;
  writeFixtureFile(file, JSON.stringify({ state: 'done' }));

  const result = await waiting;
  assert.equal(sawTruncated, true);
  assert.deepEqual(result, { state: 'done' });
  assert.equal(stats.active, 0);
});

test('waitUntilFs dynamically adds qa/ watcher and closes removed targets', async (t) => {
  const dir = makeTempDir(t);
  const qaDir = join(dir, 'qa');
  const otherDir = join(dir, 'other');
  fs.mkdirSync(otherDir);
  const stats = trackWatches(t);
  let watchOther = true;
  const ready = Promise.withResolvers();
  const waitActive = async (expected) => {
    const end = Date.now() + 3000;
    while (stats.active !== expected && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  };

  const waiting = waitUntilFs({
    targets: () => [
      { dir, filter: (name) => name === null || name === 'qa' || name === 'drop-other' },
      ...(watchOther ? [{ dir: otherDir }] : []),
      ...(fs.existsSync(qaDir) ? [{ dir: qaDir, filter: (name) => name === null || /^q\d+\.md$/.test(name) }] : []),
    ],
    timeoutMs: 5000,
    check: ({ timedOut, reason }) => {
      if (reason === 'catchup') ready.resolve();
      if (fs.existsSync(join(dir, 'drop-other'))) watchOther = false;
      const q1 = join(qaDir, 'q1.md');
      if (fs.existsSync(q1)) return { done: true, value: fs.readFileSync(q1, 'utf8') };
      if (timedOut) return { done: true, value: null };
      return { done: false };
    },
  });

  await ready.promise;
  assert.equal(stats.active, 2);

  // Drop otherDir from targets and confirm its watcher is closed immediately.
  fs.writeFileSync(join(dir, 'drop-other'), '');
  await waitActive(1);
  assert.equal(stats.active, 1);

  // Create qa/ first, wait for watcher to attach, then write q1.md and check wakeup latency.
  fs.mkdirSync(qaDir);
  await waitActive(2);
  assert.equal(stats.active, 2);

  const writeAt = performance.now();
  writeFixtureFile(join(qaDir, 'q1.md'), 'Synthetic question');
  const result = await waiting;
  const latencyMs = performance.now() - writeAt;

  assert.equal(result, 'Synthetic question');
  assert.ok(latencyMs < 100, `expected qa wakeup < 100 ms, got ${latencyMs.toFixed(1)} ms`);
  assert.equal(stats.active, 0);
  assert.equal(stats.closed, stats.opened);
});

test('waitUntilFs degrades cleanly on watcher error storms and recovers without missing files', async (t) => {
  const dir = makeTempDir(t);
  const file = join(dir, 'STATUS.json');
  let watchAttempts = 0;
  let healthy = false;
  const errors = [];

  const stats = trackWatches(t, (realWatch, target, options, listener) => {
    watchAttempts++;
    if (watchAttempts === 1) {
      throw Object.assign(new Error('synthetic ELOOP'), { code: 'ELOOP' });
    }
    if (!healthy) {
      const fake = new EventEmitter();
      fake.close = () => {};
      process.nextTick(() => fake.emit('error', Object.assign(new Error('synthetic async error'), { code: 'EIO' })));
      return fake;
    }
    return realWatch(target, options, listener);
  });

  let checkCalls = 0;
  const twoErrors = Promise.withResolvers();
  const waiting = waitUntilFs({
    targets: () => [{ dir }],
    timeoutMs: 5000,
    degradedIntervalMs: 30,
    fallbackIntervalMs: 5000,
    onWatchError: (watchDir, err) => {
      errors.push([watchDir, err.code]);
      if (errors.length >= 2) twoErrors.resolve();
    },
    check: async ({ timedOut }) => {
      checkCalls++;
      // Make check async to verify async error emission during check cannot loop.
      await Promise.resolve();
      if (fs.existsSync(file)) return { done: true, value: fs.readFileSync(file, 'utf8') };
      if (timedOut) return { done: true, value: null };
      return { done: false };
    },
  });

  await twoErrors.promise;
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(watchAttempts <= 4, `error storm detected: ${watchAttempts} watch attempts`);
  assert.ok(checkCalls <= 6, `check storm detected: ${checkCalls} check calls`);
  assert.ok(errors.length >= 2);
  assert.equal(errors[0][1], 'ELOOP');
  assert.equal(errors[1][1], 'EIO');

  healthy = true;
  const recoverEnd = Date.now() + 3000;
  while (stats.active !== 1 && Date.now() < recoverEnd) await new Promise((r) => setTimeout(r, 5));
  const writeAt = performance.now();
  writeFixtureFile(file, 'recovered');
  const result = await waiting;
  const latencyMs = performance.now() - writeAt;

  assert.equal(result, 'recovered');
  assert.ok(latencyMs < 100, `expected post-recovery wakeup < 100 ms, got ${latencyMs.toFixed(1)} ms`);
  assert.equal(stats.active, 0);
  assert.equal(stats.closed, stats.opened);
});

test('waitUntilFs rejects on pre-aborted and mid-wait AbortSignal with zero leaked watchers', async (t) => {
  const dir = makeTempDir(t);
  const stats = trackWatches(t);

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(
    () =>
      waitUntilFs({
        targets: [{ dir }],
        timeoutMs: 5000,
        signal: pre.signal,
        check: () => ({ done: false }),
      }),
    (error) => error?.name === 'AbortError'
  );
  assert.equal(stats.opened, 0);

  const ac = new AbortController();
  const ready = Promise.withResolvers();
  const waiting = waitUntilFs({
    targets: [{ dir }],
    timeoutMs: 5000,
    signal: ac.signal,
    check: ({ reason }) => {
      if (reason === 'catchup') ready.resolve();
      return { done: false };
    },
  });

  await ready.promise;
  assert.equal(stats.active, 1);
  const abortAt = performance.now();
  ac.abort();

  await assert.rejects(
    () => waiting,
    (error) => error?.name === 'AbortError'
  );
  const abortLatencyMs = performance.now() - abortAt;
  assert.ok(abortLatencyMs < 50, `expected abort < 50 ms, got ${abortLatencyMs.toFixed(1)} ms`);
  assert.equal(stats.active, 0);
  assert.equal(stats.closed, stats.opened);
});

test('waitUntilFs performs zero extra checks while idle', async (t) => {
  const dir = makeTempDir(t);
  const stats = trackWatches(t);
  let checks = 0;

  const ac = new AbortController();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const ready = Promise.withResolvers();
  const waiting = waitUntilFs({
    targets: [{ dir }],
    timeoutMs: 5000,
    fallbackIntervalMs: 5000,
    signal: ac.signal,
    check: ({ reason }) => {
      checks++;
      if (reason === 'catchup') ready.resolve();
      return { done: false };
    },
  });

  await ready.promise;
  t.mock.timers.tick(250);
  await Promise.resolve();
  assert.equal(checks, 2, 'only initial + catchup while idle');
  assert.equal(stats.active, 1);

  ac.abort();
  await assert.rejects(() => waiting, (error) => error?.name === 'AbortError');
  assert.equal(stats.active, 0);
});
