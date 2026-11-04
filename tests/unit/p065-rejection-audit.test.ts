import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CallBudgetExpired, type CallBudget } from '../../src/ledger/call-budget.js';
import { acceptIntent } from '../../src/ledger/intents.js';
import type { LedgerTransaction } from '../../src/ledger/transaction.js';
import type { PreparedIntent } from '../../src/ledger/types.js';
import { budgetFixture } from './p065-budget-fixture.js';

type Fixture = Awaited<ReturnType<typeof budgetFixture>>;
const options = { concurrency: false };
const protectedTables = ['links', 'runs', 'claims', 'slots', 'idempotency'] as const;

async function withFixture(body: (f: Fixture) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'p065-rejection-audit-'));
  const previous = { HOME: process.env.HOME, HUD_HOME: process.env.HUD_HOME, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { HOME: home, HUD_HOME: home, TMPDIR: home });
  let f: Fixture | undefined;
  try {
    f = await budgetFixture();
    await body(f);
  } finally {
    try {
      if (f) {
        await f.close();
        assert.equal(existsSync(f.home), false);
      }
    } finally {
      for (const key of ['HOME', 'HUD_HOME', 'TMPDIR'] as const) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      rmSync(home, { recursive: true, force: true });
    }
  }
}

function completeState(f: Fixture) {
  return {
    rows: protectedTables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    accepted: f.db.prepare("SELECT * FROM events WHERE kind='intent.accepted' ORDER BY seq").all(),
  };
}

function rejectedRows(f: Fixture) {
  return f.db.prepare("SELECT * FROM events WHERE kind='intent.rejected' ORDER BY seq").all();
}

function assertUnchanged(f: Fixture, before: ReturnType<typeof completeState>) {
  assert.deepEqual(completeState(f), before);
  for (const rows of before.rows) assert.equal(rows.length, 1);
  assert.equal(before.accepted.length, 1);
  assert.deepEqual(f.ledger.checkIntegrity(), { integrity: ['ok'], foreignKeys: [] });
}

function assertRejection(f: Fixture, input: PreparedIntent) {
  const rows = rejectedRows(f);
  assert.equal(rows.length, 1, 'eligible rejection must commit exactly one audit event');
  assert.equal(rows[0].link_id, null);
  assert.equal(rows[0].run_id, null);
  assert.equal(rows[0].at, input.run.createdAt);
  assert.deepEqual(JSON.parse(String(rows[0].payload)), {
    requestKey: input.requestKey,
    reason: 'idempotency_conflict',
  });
}

async function winnerAndConflict(f: Fixture) {
  const winner = await acceptIntent(f.ledger, f.input, f.clock.budget());
  assert.equal(winner.replayed, false);
  assert.equal(winner.runId, f.input.run.runId);
  const fixtures = await import(pathToFileURL(resolve('tests/ledger/fixtures.mjs')).href);
  const conflict: PreparedIntent = fixtures.intent('audit-loser', true);
  assert.equal(conflict.requestKey, f.input.requestKey);
  assert.notEqual(conflict.params.briefPath, f.input.params.briefPath);
  return { conflict, before: completeState(f) };
}

/** Observe actual calls and successful SQL only; every callback and SQL operation calls through. */
function observe(
  f: Fixture,
  hooks: { afterConflictRollback?: () => void; afterAuditQueued?: () => void } = {}
) {
  const transaction = f.ledger.transaction;
  const exec = f.db.exec;
  const trace: string[] = [];
  const budgets: Array<number | CallBudget | undefined> = [];
  const callbackErrors: unknown[] = [];
  const transactionErrors: unknown[] = [];
  let rollbacks = 0;
  f.db.exec = (sql: string) => {
    const result = exec.call(f.db, sql);
    if (['BEGIN IMMEDIATE', 'ROLLBACK', 'COMMIT'].includes(sql)) trace.push(sql);
    if (sql === 'ROLLBACK' && ++rollbacks === 1) hooks.afterConflictRollback?.();
    return result;
  };
  f.ledger.transaction = <T>(
    callback: (tx: LedgerTransaction) => T,
    budgetMs?: number | CallBudget
  ): Promise<T> => {
    const invocation = budgets.length + 1;
    budgets.push(budgetMs);
    trace.push(`invoke:${invocation}`);
    const result = transaction.call(
      f.ledger,
      (tx) => {
        trace.push(`callback:${invocation}`);
        try {
          return callback(tx);
        } catch (error) {
          callbackErrors.push(error);
          throw error;
        }
      },
      budgetMs
    ) as Promise<T>;
    // The real transaction has joined the ledger queue but cannot acquire until a later microtask.
    if (invocation === 2) hooks.afterAuditQueued?.();
    return result.catch((error: unknown) => {
      transactionErrors.push(error);
      throw error;
    });
  };
  return {
    trace,
    budgets,
    callbackErrors,
    transactionErrors,
    restore() {
      f.ledger.transaction = transaction;
      f.db.exec = exec;
    },
  };
}

function assertBudgetCalls(observed: ReturnType<typeof observe>, budget: CallBudget, count: number) {
  assert.equal(observed.budgets.length, count, 'only the eligible audit may schedule another transaction');
  for (const actual of observed.budgets) assert.equal(actual, budget, 'every transaction uses the original budget');
}

async function assertOriginalConflict(
  f: Fixture,
  conflict: PreparedIntent,
  budget: CallBudget,
  observed: ReturnType<typeof observe>
) {
  await assert.rejects(acceptIntent(f.ledger, conflict, budget), (error: unknown) => {
    assert.equal(observed.callbackErrors.length >= 1, true, 'real conflict callback must throw');
    assert.equal(error, observed.callbackErrors[0], 'the original callback error must remain primary');
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'idempotency_conflict');
    return true;
  });
}

for (const elapsed of [29.999, 30, 30.001])
  test(`P065 rejection audit: conflict rollback at ${elapsed} ms preserves the original refusal`, options, async () => {
    await withFixture(async (f) => {
      const { conflict, before } = await winnerAndConflict(f);
      const budget = f.clock.budget();
      const observed = observe(f, { afterConflictRollback: () => f.clock.advance(elapsed) });
      try {
        await assertOriginalConflict(f, conflict, budget, observed);
        if (elapsed < 30) {
          assertBudgetCalls(observed, budget, 2);
          assert.deepEqual(observed.trace, [
            'invoke:1',
            'BEGIN IMMEDIATE',
            'callback:1',
            'ROLLBACK',
            'invoke:2',
            'BEGIN IMMEDIATE',
            'callback:2',
            'COMMIT',
          ]);
          assertRejection(f, conflict);
        } else {
          assertBudgetCalls(observed, budget, 1);
          assert.deepEqual(observed.trace, ['invoke:1', 'BEGIN IMMEDIATE', 'callback:1', 'ROLLBACK']);
          assert.equal(rejectedRows(f).length, 0);
        }
        assertUnchanged(f, before);
      } finally {
        observed.restore();
      }
    });
  });

test('P065 rejection audit: eligible audit keeps the identical budget and actual spent lock wait', options, async () => {
  await withFixture(async (f) => {
    const { conflict, before } = await winnerAndConflict(f);
    const blocker = new DatabaseSync(f.file);
    const sleep = f.clock.sleep;
    const budget = f.clock.budget();
    const observed = observe(f);
    try {
      blocker.exec('BEGIN IMMEDIATE');
      f.clock.sleep = async (ms) => {
        f.clock.advance(ms);
        if (f.clock.time === 7) blocker.exec('ROLLBACK');
      };
      await assertOriginalConflict(f, conflict, budget, observed);
      assertBudgetCalls(observed, budget, 2);
      assert.equal(budget.diagnostics().waitMs, 7);
      assert.ok(budget.diagnostics().attempts > 2, 'real SQLITE_BUSY must cause acquisition retries');
      assert.deepEqual(observed.trace, [
        'invoke:1',
        'BEGIN IMMEDIATE',
        'callback:1',
        'ROLLBACK',
        'invoke:2',
        'BEGIN IMMEDIATE',
        'callback:2',
        'COMMIT',
      ]);
      assertRejection(f, conflict);
      assertUnchanged(f, before);
    } finally {
      observed.restore();
      f.clock.sleep = sleep;
      blocker.close();
    }
  });
});

test('P065 rejection audit: expired original budget never enters protected admission', options, async () => {
  await withFixture(async (f) => {
    const before = completeState(f);
    const budget = f.clock.budget();
    f.clock.advance(30);
    const observed = observe(f);
    let acceptedCallback = 0;
    try {
      await assert.rejects(
        acceptIntent(f.ledger, f.input, budget, undefined, undefined, () => acceptedCallback++),
        CallBudgetExpired
      );
      assert.equal(acceptedCallback, 0);
      assert.deepEqual(observed.budgets, []);
      assert.deepEqual(observed.trace, []);
      assert.deepEqual(completeState(f), before);
      for (const rows of before.rows) assert.equal(rows.length, 0);
      assert.equal(before.accepted.length, 0);
      assert.equal(rejectedRows(f).length, 0);
      assert.deepEqual(f.ledger.checkIntegrity(), { integrity: ['ok'], foreignKeys: [] });
    } finally {
      observed.restore();
    }
  });
});

test('P065 rejection audit: eligible queued audit expires before BEGIN without resetting the budget', options, async () => {
  await withFixture(async (f) => {
    const { conflict, before } = await winnerAndConflict(f);
    const budget = f.clock.budget();
    const observed = observe(f, {
      afterAuditQueued: () => {
        assert.equal(budget.remaining(), 30);
        f.clock.advance(30);
      },
    });
    try {
      await assertOriginalConflict(f, conflict, budget, observed);
      assertBudgetCalls(observed, budget, 2);
      assert.deepEqual(observed.trace, ['invoke:1', 'BEGIN IMMEDIATE', 'callback:1', 'ROLLBACK', 'invoke:2']);
      assert.equal(observed.callbackErrors.length, 1);
      assert.equal(observed.transactionErrors.length, 2);
      assert.ok(observed.transactionErrors[1] instanceof CallBudgetExpired);
      assert.equal(budget.diagnostics().queueMs, 30);
      assert.equal(budget.diagnostics().waitMs, 30);
      assert.equal(rejectedRows(f).length, 0);
      assertUnchanged(f, before);
    } finally {
      observed.restore();
    }
  });
});

test('P065 rejection audit: real SQLite audit failure rolls back and preserves the original conflict', options, async () => {
  await withFixture(async (f) => {
    const { conflict, before } = await winnerAndConflict(f);
    f.exec(`CREATE TEMP TRIGGER fail_rejection_audit BEFORE INSERT ON events
      WHEN NEW.kind='intent.rejected'
      BEGIN SELECT RAISE(ABORT, 'synthetic_rejection_audit_failure'); END`);
    const budget = f.clock.budget();
    const observed = observe(f);
    try {
      await assertOriginalConflict(f, conflict, budget, observed);
      assertBudgetCalls(observed, budget, 2);
      assert.deepEqual(observed.trace, [
        'invoke:1',
        'BEGIN IMMEDIATE',
        'callback:1',
        'ROLLBACK',
        'invoke:2',
        'BEGIN IMMEDIATE',
        'callback:2',
        'ROLLBACK',
      ]);
      assert.equal(observed.callbackErrors.length, 2);
      assert.match(String(observed.callbackErrors[1]), /synthetic_rejection_audit_failure/);
      assert.ok(budget.remaining() > 0);
      assert.equal(rejectedRows(f).length, 0);
      assertUnchanged(f, before);
    } finally {
      observed.restore();
      f.exec('DROP TRIGGER fail_rejection_audit');
    }
  });
});

test('P065 rejection audit: failed completion or eligibility observation cannot replace a real conflict', options, async () => {
  await withFixture(async (f) => {
    const { conflict, before } = await winnerAndConflict(f);
    const budget = f.clock.budget();
    const now = f.clock.now;
    const observed = observe(f, {
      afterConflictRollback: () => {
        f.clock.now = () => {
          throw new Error('synthetic_clock_observation_failure');
        };
      },
    });
    try {
      await assertOriginalConflict(f, conflict, budget, observed);
      assertBudgetCalls(observed, budget, 1);
      assert.deepEqual(observed.trace, ['invoke:1', 'BEGIN IMMEDIATE', 'callback:1', 'ROLLBACK']);
      assert.equal(rejectedRows(f).length, 0);
      assertUnchanged(f, before);
    } finally {
      f.clock.now = now;
      observed.restore();
    }
  });
});
