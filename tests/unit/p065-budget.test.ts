import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CallBudget, CallBudgetExpired } from '../../src/ledger/call-budget.js';
import { Ledger, LedgerCommitUncertain, LedgerCleanupFailed } from '../../src/ledger/ledger.js';
import { acceptIntent } from '../../src/ledger/intents.js';
import { budgetFixture, TestBudgetClock } from './p065-budget-fixture.js';

for (const elapsed of [29.999, 30, 30.001])
  test(`P065 original boundary ${elapsed} ms; zero remains intentional only for numeric API`, async () => {
    const f = await budgetFixture();
    try {
      const b = f.clock.budget();
      f.clock.advance(elapsed);
      let calls = 0;
      const operation = f.ledger.transaction(() => ++calls, b);
      if (elapsed < 30) assert.equal(await operation, 1);
      else {
        await assert.rejects(operation, CallBudgetExpired);
        assert.equal(calls, 0);
      }
      assert.equal(await f.ledger.transaction(() => 'legacy nonblocking', 0), 'legacy nonblocking');
    } finally {
      await f.close();
    }
  });

test('P065 earlier trusted cap tightens without reset; unknown timing adds nothing', () => {
  const clock = new TestBudgetClock(),
    b = clock.budget();
  clock.advance(7);
  b.tighten(25);
  b.tighten(1000);
  assert.equal(b.remaining(), 18);
  clock.advance(18);
  assert.throws(() => b.check(), CallBudgetExpired);
  const unknown = clock.budget();
  assert.equal(unknown.diagnostics().enclosingDeadline, 'unavailable');
  assert.equal(unknown.remaining(), 30);
  assert.throws(() => new CallBudget(clock, clock.time + 1), /invalid_budget_clock/);
});

test('P065 acquire-await handoff owns cleanup before a queued expiry', async () => {
  const f = await budgetFixture();
  try {
    let callbacks = 0,
      rollback = 0;
    f.db.exec = (sql: string) => {
      f.exec(sql);
      if (sql === 'BEGIN IMMEDIATE') queueMicrotask(() => f.clock.advance(30));
      if (sql === 'ROLLBACK') rollback++;
    };
    await assert.rejects(
      f.ledger.transaction(() => callbacks++, f.clock.budget()),
      CallBudgetExpired
    );
    assert.equal(callbacks, 0);
    assert.equal(rollback, 1);
    const other = new DatabaseSync(f.file);
    other.exec('BEGIN IMMEDIATE; ROLLBACK');
    other.close();
  } finally {
    await f.close();
  }
});

test('P065 queued expiry never enters the protected callback', async () => {
  const f = await budgetFixture();
  try {
    const blocker = new DatabaseSync(f.file);
    blocker.exec('BEGIN IMMEDIATE');
    const first = f.ledger.transaction(() => 1);
    let called = false;
    const second = f.ledger.transaction(() => {
      called = true;
    }, f.clock.budget());
    f.clock.advance(31);
    blocker.exec('ROLLBACK');
    blocker.close();
    await first;
    await assert.rejects(second, CallBudgetExpired);
    assert.equal(called, false);
  } finally {
    await f.close();
  }
});

test('P065 one cumulative contention allowance across transactions, actual oversleep retained', async () => {
  const f = await budgetFixture();
  try {
    const blocker = new DatabaseSync(f.file);
    blocker.exec('BEGIN IMMEDIATE');
    const b = f.clock.budget();
    f.clock.sleepExtra = 25;
    await assert.rejects(
      f.ledger.transaction(() => assert.fail('body'), b),
      CallBudgetExpired
    );
    assert.equal(b.diagnostics().waitMs, 26);
    blocker.exec('ROLLBACK');
    blocker.close();
    await assert.rejects(
      f.ledger.transaction(() => assert.fail('reset allowance'), b),
      CallBudgetExpired
    );
    assert.equal(b.diagnostics().attempts, 1);
  } finally {
    await f.close();
  }
});

test('P065 preparation is charged to 30 ms, not mislabeled as lock waiting', async () => {
  const f = await budgetFixture();
  try {
    const b = f.clock.budget();
    f.clock.advance(29);
    await f.ledger.transaction(() => 1, b);
    assert.equal(b.diagnostics().waitMs, 0);
    f.clock.advance(1);
    await assert.rejects(
      f.ledger.transaction(() => 2, b),
      CallBudgetExpired
    );
  } finally {
    await f.close();
  }
});

test('P065 fresh intent expiry rolls back every requested row and acceptance event', async () => {
  const f = await budgetFixture();
  try {
    const b = f.clock.budget();
    await assert.rejects(
      acceptIntent(f.ledger, f.input, b, undefined, {}, () => f.clock.advance(30)),
      CallBudgetExpired
    );
    for (const table of ['runs', 'links', 'claims', 'slots', 'idempotency', 'events'])
      assert.equal(f.count(table), 0, table);
  } finally {
    await f.close();
  }
});

test('P065 authorized canonical replay survives late lookup, rolls back incidental work and bypasses new admission', async () => {
  const f = await budgetFixture();
  try {
    const original = await acceptIntent(f.ledger, f.input);
    const base = f.ledger.transaction.bind(f.ledger);
    f.ledger.transaction = (callback, budget) =>
      base((tx) => {
        const result = callback(tx);
        if (tx.isPriorDurableResult(result)) {
          tx.run('UPDATE callers SET last_seen_at=12345');
          f.clock.advance(31);
        }
        return result;
      }, budget);
    const b = f.clock.budget();
    const replay = await acceptIntent(f.ledger, { ...f.input, capabilityVerified: false }, b, undefined, {
      maxActiveRunsPerOwner: 1,
      maxActiveRuns: 1,
    });
    assert.deepEqual(replay, { ...original, replayed: true });
    assert.equal(f.db.prepare('SELECT last_seen_at FROM callers').get()!.last_seen_at, 1000);
    assert.equal(f.count('runs'), 1);
    assert.equal(f.count('idempotency'), 1);
    assert.equal(f.count('events'), 1);
    assert.equal(b.diagnostics().overrunMs, 1);
  } finally {
    await f.close();
  }
});

test('P065 marker cannot preserve a newly written row or rescue a failing/thenable callback', async () => {
  const f = await budgetFixture();
  try {
    await assert.rejects(
      f.ledger.transaction((tx) => {
        tx.get('UPDATE callers SET last_seen_at=2 RETURNING caller_id');
        return tx.priorDurableResult({ ok: true });
      }, f.clock.budget()),
      /prior_result_depends_on_transaction/
    );
    await assert.rejects(
      f.ledger.transaction((tx) => {
        tx.priorDurableResult({ ok: true });
        throw new Error('after_marker');
      }, f.clock.budget()),
      /after_marker/
    );
    await assert.rejects(
      f.ledger.transaction((tx) => tx.priorDurableResult(Promise.resolve(1)), f.clock.budget()),
      /must_be_synchronous/
    );
    assert.equal(f.db.prepare('SELECT last_seen_at FROM callers').get()!.last_seen_at, 1000);
  } finally {
    await f.close();
  }
});

test('P065 even a falsy callback exception rolls back and cannot return a marker', async () => {
  const f = await budgetFixture();
  try {
    for (const failure of [undefined, null, false, 0, '']) {
      let rejected = false;
      try {
        await f.ledger.transaction((tx) => {
          tx.priorDurableResult({ ok: true });
          tx.run('UPDATE callers SET last_seen_at=77');
          throw failure;
        }, f.clock.budget());
      } catch (error) {
        rejected = true;
        assert.equal(error, failure);
      }
      assert.equal(rejected, true);
      assert.equal(f.db.prepare('SELECT last_seen_at FROM callers').get()!.last_seen_at, 1000);
    }
  } finally {
    await f.close();
  }
});

test('P065 successful-late COMMIT preserves result and is never rolled back', async () => {
  const f = await budgetFixture();
  try {
    let rollbacks = 0;
    f.db.exec = (sql: string) => {
      f.exec(sql);
      if (sql === 'COMMIT') f.clock.advance(31);
      if (sql === 'ROLLBACK') rollbacks++;
    };
    const b = f.clock.budget();
    const result = await acceptIntent(f.ledger, f.input, b);
    assert.equal(result.replayed, false);
    assert.equal(f.count('runs'), 1);
    assert.equal(rollbacks, 0);
    assert.equal(b.diagnostics().overrunMs, 1);
    f.db.exec = f.exec;
    assert.equal((await acceptIntent(f.ledger, f.input, f.clock.budget())).replayed, true);
  } finally {
    await f.close();
  }
});

for (const committed of [false, true])
  test(`P065 COMMIT acknowledgement failure committed=${committed} is uncertain, never busy/audited/retried`, async () => {
    const f = await budgetFixture();
    try {
      let commits = 0;
      f.db.exec = (sql: string) => {
        if (sql === 'COMMIT') {
          commits++;
          if (committed) f.exec(sql);
          throw new Error('SQLITE_BUSY acknowledgement lost');
        }
        f.exec(sql);
      };
      await assert.rejects(acceptIntent(f.ledger, f.input, f.clock.budget()), LedgerCommitUncertain);
      assert.equal(commits, 1);
      const db = new DatabaseSync(f.file),
        fresh = new Ledger(db, f.ledger.ledgerId, 20);
      try {
        assert.equal(Number(db.prepare("SELECT count(*) AS n FROM events WHERE kind='intent.rejected'").get()!.n), 0);
        assert.equal(Number(db.prepare('SELECT count(*) AS n FROM runs').get()!.n), committed ? 1 : 0);
        const result = await acceptIntent(fresh, f.input, f.clock.budget());
        assert.equal(result.replayed, committed);
        assert.equal(Number(db.prepare('SELECT count(*) AS n FROM runs').get()!.n), 1);
      } finally {
        await fresh.close();
      }
    } finally {
      await f.close();
    }
  });

test('P065 rollback failure isolates connection and cannot masquerade as clean budget refusal', async () => {
  const f = await budgetFixture();
  try {
    f.db.exec = (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('rollback_fault');
      f.exec(sql);
    };
    await assert.rejects(
      f.ledger.transaction((tx) => {
        tx.run('UPDATE callers SET last_seen_at=7');
        f.clock.advance(31);
      }, f.clock.budget()),
      LedgerCleanupFailed
    );
    await assert.rejects(
      f.ledger.transaction(() => assert.fail('dirty reuse')),
      /ledger_closed/
    );
    const other = new DatabaseSync(f.file);
    assert.equal(other.prepare('SELECT last_seen_at FROM callers').get()!.last_seen_at, 1000);
    other.close();
  } finally {
    await f.close();
  }
});

test('P065 known prior result survives incidental rollback failure only with connection isolation', async () => {
  const f = await budgetFixture();
  try {
    f.db.exec = (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('rollback_fault');
      f.exec(sql);
    };
    const prior = { id: 'already-durable' };
    assert.equal(
      await f.ledger.transaction((tx) => {
        const result = tx.priorDurableResult(prior);
        tx.run('UPDATE callers SET last_seen_at=8');
        return result;
      }, f.clock.budget()),
      prior
    );
    await assert.rejects(
      f.ledger.transaction(() => 1),
      /ledger_closed/
    );
  } finally {
    await f.close();
  }
});

test('P065 earlier committed transaction and later writer share cumulative waiting without resetting 20 ms', async () => {
  const f = await budgetFixture();
  const blocker = new DatabaseSync(f.file);
  try {
    const b = f.clock.budget();
    blocker.exec('BEGIN IMMEDIATE');
    f.clock.sleep = async (ms) => {
      f.clock.advance(ms);
      if (f.clock.time >= 7) blocker.exec('ROLLBACK');
    };
    await f.ledger.transaction((tx) => tx.run('UPDATE callers SET last_seen_at=1001'), b);
    assert.equal(b.diagnostics().waitMs, 7);
    blocker.exec('BEGIN IMMEDIATE');
    f.clock.sleep = async (ms) => {
      f.clock.advance(ms);
    };
    await assert.rejects(
      f.ledger.transaction(() => assert.fail('late operation body'), b),
      /ledger_busy|Ledger busy/
    );
    assert.equal(f.db.prepare('SELECT last_seen_at FROM callers').get()!.last_seen_at, 1001);
    assert.ok(b.diagnostics().waitMs <= 20);
    assert.ok(b.diagnostics().waitMs >= 14);
    blocker.exec('ROLLBACK');
  } finally {
    blocker.close();
    await f.close();
  }
});

test('P065 bounded diagnostics retain phase totals and mandatory rollback overrun', async () => {
  const f = await budgetFixture();
  try {
    const b = f.clock.budget();
    for (let n = 0; n < 100; n++) b.note('prepare');
    f.db.exec = (sql: string) => {
      f.exec(sql);
      if (sql === 'ROLLBACK') f.clock.advance(5);
    };
    await assert.rejects(
      f.ledger.transaction(() => {
        f.clock.advance(30);
      }, b),
      CallBudgetExpired
    );
    const d = b.diagnostics();
    assert.equal(d.phases.length, 64);
    assert.equal(d.phaseCounts.prepare, 100);
    assert.equal(d.phaseMs.rollback, 5);
    assert.equal(d.authorizationMs, 35);
    assert.equal(d.overrunMs, 5);
  } finally {
    await f.close();
  }
});
