import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordRunLocator } from '../../src/ledger/locator.js';
import { insertRun } from '../../src/ledger/records.js';
import { openLedger } from '../../src/ledger/ledger.js';
import { readProcess } from '../../src/core/run/process.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import type { HostLocator } from '../../src/core/types/capabilities.js';
const skip = ledgerRuntimeSupported() ? false : 'B7 SQLite tests need Node 22.x >=22.13 or >=24';
const helpers = () => import(pathToFileURL(resolve('tests/int/fixture.mjs')).href);

test('B7 real SQLite H08 first write / same value / conflict / unauthorized / stale generation', { skip }, async () => {
  const { fixture } = await helpers();
  const f = await fixture(['/bin/true']);
  try {
    const stamp = readProcess(process.pid)!.stamp;
    const id = f.input.runId;
    const locator: HostLocator = {
      kind: 'herdr',
      server: 'synthetic-server',
      workspace: 'w1',
      tab: 'w1:t1',
      pane: 'w1:p1',
      process: stamp,
      runId: id,
      bindingGeneration: 1,
    };
    await assert.rejects(recordRunLocator(f.ledger, id, stamp, locator), /writer_not_registered/);
    await f.port.register(id, f.ticket, f.prepared.run.launchDigest, stamp);
    await recordRunLocator(f.ledger, id, stamp, locator);
    await recordRunLocator(f.ledger, id, stamp, locator);
    assert.deepEqual((await f.port.read(id)).run.locator, locator);
    await assert.rejects(recordRunLocator(f.ledger, id, stamp, { ...locator, pane: 'w1:p2' }), /locator_conflict/);
    await assert.rejects(recordRunLocator(f.ledger, id, stamp, { ...locator, bindingGeneration: 2 }), /stale_run/);
    await assert.rejects(
      recordRunLocator(f.ledger, id, { ...stamp, proc_start: 'different' }, locator),
      /writer_not_registered/
    );
    await assert.rejects(
      recordRunLocator(f.ledger, id, stamp, { ...locator, env: { HUD_CLAIM: 'synthetic' } } as HostLocator),
      /locator_invalid/
    );
    await f.ledger.transaction((tx: any) =>
      insertRun(tx, { ...f.prepared.run, runId: 'synthetic-new-run', runSeq: 2, launchTokenHash: 'b'.repeat(64) })
    );
    await assert.rejects(recordRunLocator(f.ledger, id, stamp, locator), /stale_run/);
    assert.deepEqual((await f.port.read(id)).run.locator, locator);
  } finally {
    await f.cleanup();
  }
});

test('B7 real SQLite concurrent locator writers choose one and preserve it', { skip }, async () => {
  const { fixture } = await helpers();
  const f = await fixture(['/bin/true']);
  let other: Awaited<ReturnType<typeof openLedger>> | undefined;
  try {
    const stamp = readProcess(process.pid)!.stamp;
    const id = f.input.runId;
    await f.port.register(id, f.ticket, f.prepared.run.launchDigest, stamp);
    other = await openLedger(resolve(f.home, 'ledger.sqlite'));
    const locator: HostLocator = {
      kind: 'herdr',
      server: 'synthetic-server',
      workspace: 'w1',
      tab: 'w1:t1',
      pane: 'w1:p1',
      process: stamp,
      runId: id,
      bindingGeneration: 1,
    };
    const results = await Promise.allSettled([
      recordRunLocator(f.ledger, id, stamp, locator),
      recordRunLocator(other, id, stamp, { ...locator, pane: 'w1:p2' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    // A bounded lock loser may be busy before it can inspect the committed winner.
    assert.ok(rejected.reason.code === 'ledger_busy' || rejected.reason.message === 'locator_conflict');
    const saved = (await f.port.read(id)).run.locator;
    assert.ok(saved.pane === 'w1:p1' || saved.pane === 'w1:p2');
    await recordRunLocator(other, id, stamp, { ...locator, pane: saved.pane });
    await assert.rejects(
      recordRunLocator(other, id, stamp, { ...locator, pane: saved.pane === 'w1:p1' ? 'w1:p2' : 'w1:p1' }),
      /locator_conflict/
    );
    assert.deepEqual((await f.port.read(id)).run.locator, saved);
  } finally {
    await other?.close();
    await f.cleanup();
  }
});

test(
  'B7 real SQLite held writer lock exhausts bounded budget without a locator commit',
  { skip, timeout: 5000 },
  async () => {
    const { spawn } = await import('node:child_process');
    const { fixture } = await helpers();
    const f = await fixture(['/bin/true']);
    let child: import('node:child_process').ChildProcess | undefined;
    let done: Promise<unknown> | undefined;
    try {
      const stamp = readProcess(process.pid)!.stamp;
      const id = f.input.runId;
      await f.port.register(id, f.ticket, f.prepared.run.launchDigest, stamp);
      child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.stdout.write('locked\\n');process.stdin.once('data',()=>{db.exec('ROLLBACK');db.close();process.exit(0)});`,
          resolve(f.home, 'ledger.sqlite'),
        ],
        { stdio: ['pipe', 'pipe', 'ignore'] }
      );
      done = new Promise((resolve) => {
        child!.once('exit', resolve);
        child!.once('error', resolve);
      });
      await new Promise<void>((resolve, reject) => {
        child!.stdout!.once('data', () => resolve());
        child!.once('error', reject);
        child!.once('exit', () => reject(new Error('lock_child_exited')));
      });
      const locator: HostLocator = {
        kind: 'herdr',
        server: 'synthetic-server',
        workspace: 'w1',
        tab: 'w1:t1',
        pane: 'w1:p1',
        process: stamp,
        runId: id,
        bindingGeneration: 1,
      };
      const start = performance.now();
      await assert.rejects(recordRunLocator(f.ledger, id, stamp, locator), /Ledger busy/);
      assert.ok(performance.now() - start < 100, 'lock acquisition exceeded bounded budget plus scheduler tolerance');
      assert.equal((await f.port.read(id)).run.locator, null);
      child.stdin!.end('release');
      await done;
      await recordRunLocator(f.ledger, id, stamp, locator);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done;
      await f.cleanup();
    }
  }
);

test('B7 review: real SQLite registered run with no own slot cannot borrow another run slot', { skip }, async () => {
  const { fixture } = await helpers();
  const f = await fixture(['/bin/true']);
  try {
    const { insertClaim, insertRecord, readRun } = await import('../../src/ledger/records.js');
    const { supervisorRegistrationEvent } = await import('../../src/core/supervision.js');
    const stamp = readProcess(process.pid)!.stamp;
    const id = 'synthetic-missing-slot';
    const run = {
      ...f.prepared.run,
      runId: id,
      runSeq: 2,
      launchTokenHash: 'd'.repeat(64),
      supervisor: stamp,
      launchPhase: 'armed' as const,
      heartbeatAt: Date.now(),
      heartbeatSeq: 1,
      heartbeatMonoMs: 0,
    };
    await f.ledger.transaction((tx: any) => {
      insertRun(tx, run);
      insertClaim(tx, { ...f.prepared.claim, runId: id, claimHash: 'e'.repeat(64), state: 'armed', supervisor: stamp });
      insertRecord(tx, 'events', supervisorRegistrationEvent(run, stamp, run.createdAt));
    });
    const before = await f.ledger.readSnapshot((tx: any) => ({
      run: readRun(tx, id),
      slots: tx.all('SELECT * FROM slots'),
    }));
    assert.deepEqual(before.run.supervisor, stamp);
    assert.equal(before.slots.length, 1);
    assert.notEqual(before.slots[0].run_id, id);
    const locator: HostLocator = {
      kind: 'herdr',
      server: 'synthetic-server',
      workspace: 'w1',
      tab: 'w1:t1',
      pane: 'w1:p1',
      process: stamp,
      runId: id,
      bindingGeneration: 1,
    };
    await assert.rejects(recordRunLocator(f.ledger, id, stamp, locator), /stale_run/);
    assert.equal((await f.ledger.readSnapshot((tx: any) => readRun(tx, id))).locator, null);
    assert.deepEqual(await f.ledger.readSnapshot((tx: any) => tx.all('SELECT * FROM slots')), before.slots);
  } finally {
    await f.cleanup();
  }
});
