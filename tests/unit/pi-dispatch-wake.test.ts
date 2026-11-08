import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import { waitDispatch } from '../../src/roles/pi-dispatch-status.js';

function fixture(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-dispatch-wake-')));
  fs.mkdirSync(join(directory, 'qa'));
  fs.mkdirSync(join(directory, '.dispatch'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const live = new Set<fs.FSWatcher>();
  const paths: string[] = [];
  const watch = (path: string, changed: () => void) => {
    const watcher = fs.watch(path, changed);
    paths.push(path);
    live.add(watcher);
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      live.delete(watcher);
      return close();
    };
    return watcher;
  };
  return { directory, watch, live, paths };
}

for (const source of ['STATUS', 'qa', 'helper']) {
  test(`file-event wake observes ${source} in under a second and closes all watchers`, async (t) => {
    const f = fixture(t);
    let ready = false;
    let polls = 0;
    const started = performance.now();
    const waiting = waitDispatch(
      async (_remaining, poll) => {
        if (poll) polls++;
        return ready ? { event: 'DONE' as const } : {};
      },
      2000,
      f
    );
    const timer = setTimeout(() => {
      if (source === 'helper') {
        fs.mkdirSync(join(f.directory, '.dispatch', 'sonic-1'));
        // The parent event attaches a helper watcher before its own STATUS changes.
        setTimeout(() => {
          ready = true;
          fs.writeFileSync(join(f.directory, '.dispatch', 'sonic-1', 'STATUS.json'), '{}');
        }, 100);
      } else {
        ready = true;
        const target = source === 'qa' ? join(f.directory, 'qa', 'q1.md') : join(f.directory, 'STATUS.json');
        fs.writeFileSync(`${target}.tmp`, 'synthetic');
        fs.renameSync(`${target}.tmp`, target);
      }
    }, 40);
    t.after(() => clearTimeout(timer));
    const result = await waiting;
    assert.equal(result.event, 'DONE');
    assert.ok(performance.now() - started < 800);
    assert.equal(polls, 1, 'event reads do not add supplementary herdr polls');
    assert.equal(f.live.size, 0);
    if (source === 'helper') assert.ok(f.paths.includes(join(f.directory, '.dispatch', 'sonic-1')));
  });
}

test('watch failure falls back to bounded polling and timeout disposes watchers', async (t) => {
  const f = fixture(t);
  let attempts = 0;
  const result = await waitDispatch(async () => ({}), 25, {
    directory: f.directory,
    watch() {
      attempts++;
      throw Object.assign(new Error('synthetic watch exhaustion'), { code: 'ENOSPC' });
    },
  });
  assert.equal(result.event, 'timeout');
  assert.equal(attempts, 3);
  assert.equal((await waitDispatch(async () => ({}), 25, f)).event, 'timeout');
  assert.equal(f.live.size, 0);
});

test('poll fallback sees settlement when all fs.watch calls throw', async (t) => {
  const f = fixture(t);
  let reads = 0;
  const result = await waitDispatch(async () => (++reads > 1 ? { event: 'DONE' as const } : {}), 1500, {
    directory: f.directory,
    watch() {
      throw Object.assign(new Error('synthetic limit'), { code: 'ENOSPC' });
    },
  });
  assert.equal(result.event, 'DONE');
  assert.equal(reads, 2);
});

test('watchers close when observation throws and when first read is already terminal', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    waitDispatch(
      async () => {
        throw new Error('synthetic read error');
      },
      25,
      f
    ),
    /synthetic read error/
  );
  assert.equal(f.live.size, 0);
  assert.equal((await waitDispatch(async () => ({ event: 'FAILED' as const }), 25, f)).event, 'FAILED');
  assert.equal(f.live.size, 0);
});

test('one event burst coalesces to one bounded reread', async (t) => {
  const f = fixture(t);
  let reads = 0;
  const waiting = waitDispatch(
    async () => {
      reads++;
      return reads >= 2 ? { event: 'QUESTION' as const } : {};
    },
    1000,
    f
  );
  setTimeout(() => {
    for (let i = 0; i < 40; i++) fs.writeFileSync(join(f.directory, 'STATUS.json'), String(i));
  }, 10);
  assert.equal((await waiting).event, 'QUESTION');
  assert.equal(reads, 2);
  assert.equal(f.live.size, 0);
});
