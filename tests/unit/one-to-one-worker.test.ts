import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PublicationWorker } from '../../src/core/link/publication-worker.js';
import { openObservationStore } from '../../src/core/observation-store.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { notifyFixture, reportFor } from './b21-fixture.js';

const options = { skip: !ledgerRuntimeSupported() };

test('owned publication worker captures a real observation, coalesces and releases its lease', options, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  await reportFor(f, 'completed');
  const dir = join(f.root, 'sessions', '2026', '11', '02');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const ref of [f.parent.ref, f.child.ref]) {
    writeFileSync(
      join(dir, `rollout-${ref.sessionId}.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        timestamp: new Date(now).toISOString(),
        payload: {
          id: ref.sessionId,
          cwd: '/synthetic',
          timestamp: new Date(now).toISOString(),
          cli_version: 'synthetic',
        },
      }) + '\n'
    );
  }
  const events: { changed: boolean; error: string | null }[] = [];
  let wake: (() => void) | undefined;
  const worker = new PublicationWorker(f.root, f.root, (changed, error) => {
    events.push({ changed, error });
    wake?.();
  });
  const limits = (worker as any).worker.resourceLimits;
  assert.equal(limits.maxOldGenerationSizeMb, 64);
  assert.equal(limits.maxYoungGenerationSizeMb, 8);
  assert.equal(limits.stackSizeMb, 4);
  let closed = false;
  t.after(async () => {
    if (!closed) await worker.close();
  });
  const next = async () => {
    const before = events.length;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        wake = undefined;
        reject(new Error('worker_result_timeout'));
      }, 5000);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
      if (events.length > before) {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
    });
  };
  for (let n = 0; n < 30; n++) worker.request();
  await next();
  assert.equal(events.length, 1, 'refreshes before worker readiness coalesce');
  for (let n = 0; n < 30; n++) worker.request();
  await next();
  await next();
  assert.equal(events.length, 3, 'an active operation retains only one coalesced request');
  let observed = false;
  let leaseHeld = false;
  for (let n = 0; n < 40 && !observed; n++) {
    const file = join(f.root, 'sources', f.child.ref.sourceId, 'observation.sqlite');
    if (existsSync(file)) {
      const store = await openObservationStore({ hudHome: f.root, sourceId: f.child.ref.sourceId, readOnly: true });
      try {
        observed = store.readProjection(f.child.ref) !== null;
        leaseHeld ||= !!store.readLease(f.child.ref)?.holder;
      } finally {
        store.close();
      }
    }
    if (!observed) {
      worker.request();
      await next();
    }
  }
  assert.ok(observed, `the real worker did not publish: ${JSON.stringify(events)}`);
  assert.ok(leaseHeld, 'the publisher used a real collection lease');
  const before = await openObservationStore({ hudHome: f.root, sourceId: f.child.ref.sourceId, readOnly: true });
  const originalHolder = before.readLease(f.child.ref)?.holder;
  before.close();
  assert.ok(originalHolder);
  let competitorWake: (() => void) | undefined;
  const competitor = new PublicationWorker(f.root, f.root, () => competitorWake?.());
  let competitorClosed = false;
  t.after(async () => {
    if (!competitorClosed) await competitor.close();
  });
  for (let n = 0; n < 4; n++) {
    competitor.request(f.child.ref.sessionId);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        competitorWake = undefined;
        reject(new Error('competitor_result_timeout'));
      }, 5000);
      competitorWake = () => {
        clearTimeout(timer);
        competitorWake = undefined;
        resolve();
      };
    });
  }
  const during = await openObservationStore({ hudHome: f.root, sourceId: f.child.ref.sourceId, readOnly: true });
  try {
    assert.equal(during.readLease(f.child.ref)?.holder, originalHolder, 'another HUD cannot replace the live owner');
  } finally {
    during.close();
  }
  assert.equal(await competitor.close(), true);
  competitorClosed = true;
  assert.equal(await worker.close(), true, 'owned worker reports confirmed cleanup');
  closed = true;
  const store = await openObservationStore({ hudHome: f.root, sourceId: f.child.ref.sourceId, readOnly: true });
  try {
    assert.equal(store.readLease(f.child.ref), null);
  } finally {
    store.close();
  }
});

test('a failed worker remains stopped and reports read-only degradation', options, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  const errors: (string | null)[] = [];
  const owner = new PublicationWorker(f.root, f.root, (_changed, error) => errors.push(error));
  const worker = (owner as any).worker as import('node:worker_threads').Worker;
  await worker.terminate();
  assert.ok(errors.includes('observation_worker_unavailable'));
  owner.request();
  assert.equal((owner as any).worker, null, 'requests do not restart a failed worker');
  assert.equal(await owner.close(), false);
});

test('worker shutdown timeout reports uncertainty and terminates the owned thread', options, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  const owner = new PublicationWorker(f.root, f.root, () => {});
  const worker = (owner as any).worker as import('node:worker_threads').Worker;
  const exited = once(worker, 'exit');
  worker.postMessage = () => {};
  assert.equal(await owner.close(), false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exited,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('worker_termination_timeout')), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
});

test('real hud panel owns its publisher and releases its lease on exit', options, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  await reportFor(f, 'completed');
  const dir = join(f.root, 'sessions', '2026', '11', '02');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const ref of [f.parent.ref, f.child.ref])
    writeFileSync(
      join(dir, `rollout-${ref.sessionId}.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        timestamp: new Date(now).toISOString(),
        payload: {
          id: ref.sessionId,
          cwd: '/synthetic',
          timestamp: new Date(now).toISOString(),
          cli_version: 'synthetic',
        },
      }) + '\n'
    );
  const child = spawn(process.execPath, [resolve('bin/hud'), 'panel'], {
    cwd: f.root,
    env: { PATH: '/usr/bin:/bin', HOME: f.root, CODEX_HOME: f.root, HUD_HOME: f.root },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    output = (output + chunk).slice(-256_000);
  });
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr += chunk;
  });
  let childClosed = false;
  try {
    const file = join(f.root, 'sources', f.child.ref.sourceId, 'observation.sqlite');
    const deadline = Date.now() + 12_000;
    let observed = false;
    while (Date.now() < deadline && child.exitCode === null && !observed) {
      if (existsSync(file)) {
        const store = await openObservationStore({ hudHome: f.root, sourceId: f.child.ref.sourceId, readOnly: true });
        try {
          observed = store.readProjection(f.child.ref) !== null;
        } finally {
          store.close();
        }
      }
      if (!observed) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.ok(observed, `panel did not publish a child observation: ${stderr}`);
    assert.match(output, /implementer|Synthetic B21 task outcome/, 'the real panel also renders the delegation');
    const closed = once(child, 'close');
    child.stdin!.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const [code] = await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('panel_close_timeout')), 5000);
      }),
    ]).finally(() => clearTimeout(timer));
    childClosed = true;
    assert.equal(code, 0, stderr);
    const store = await openObservationStore({ hudHome: f.root, sourceId: f.child.ref.sourceId, readOnly: true });
    try {
      assert.equal(store.readLease(f.child.ref), null);
    } finally {
      store.close();
    }
  } finally {
    if (!childClosed && child.exitCode === null) {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
      await once(child, 'close');
    }
  }
});
