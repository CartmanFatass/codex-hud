import { closeSync, openSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_V1_DDL } from './schema.js';
import { requireLedgerRuntime, loadLedgerSqlite } from './runtime.js';
import { acquireWriteLock, LedgerBusyError, LedgerTransaction, synchronousResult } from './transaction.js';
import { isCallBudget, type CallBudget } from './call-budget.js';

export interface LedgerOptions {
  busyBudgetMs?: number;
  callBudget?: CallBudget;
}

/** Internal only: unknown COMMIT truth is not a retry-safe lock refusal. */
export class LedgerCommitUncertain extends Error {
  readonly auditUnsafe = true;
  constructor(cause: unknown) {
    super('ledger_commit_uncertain', { cause });
  }
}
export class LedgerCleanupFailed extends Error {
  readonly auditUnsafe = true;
  constructor(cause: unknown) {
    super('ledger_cleanup_failed', { cause });
  }
}

/** Shared writer library; no scheduler, recovery process, or external action is started here. */
export class Ledger {
  #tail: Promise<unknown> = Promise.resolve();
  #active = false;
  #closed = false;
  #unusable = false;
  constructor(
    private readonly db: DatabaseSync,
    readonly ledgerId: string,
    readonly busyBudgetMs: number
  ) {}

  transaction<T>(
    callback: (tx: LedgerTransaction) => T,
    budgetMs: number | CallBudget = this.busyBudgetMs
  ): Promise<T> {
    if (isCallBudget(budgetMs)) return this.#budgetTransaction(callback, budgetMs);
    if (!Number.isFinite(budgetMs) || budgetMs < 0 || budgetMs > 20)
      return Promise.reject(new TypeError('invalid_busy_budget'));
    const deadline = performance.now() + Math.min(this.busyBudgetMs, budgetMs);
    const execute = async (): Promise<T> => {
      if (this.#closed || this.#unusable) throw new Error('ledger_closed');
      const remaining = Math.max(0, deadline - performance.now());
      if (budgetMs > 0 && remaining === 0) throw new LedgerBusyError();
      this.#active = true;
      let begun = false;
      const tx = new LedgerTransaction(this.db);
      try {
        await acquireWriteLock(this.db, remaining);
        begun = true;
        const result = synchronousResult(callback(tx));
        this.db.exec('COMMIT');
        begun = false;
        return result;
      } finally {
        tx.finish();
        if (begun) this.db.exec('ROLLBACK');
        this.#active = false;
      }
    };
    const result = this.#tail.then(execute);
    this.#tail = result.catch(() => {});
    return result;
  }

  #budgetTransaction<T>(callback: (tx: LedgerTransaction) => T, budget: CallBudget): Promise<T> {
    const queued = budget.now();
    const execute = async (): Promise<T> => {
      if (this.#closed || this.#unusable) throw new Error('ledger_closed');
      budget.chargeWait(queued, true);
      budget.check('queue');
      this.#active = true;
      let begun = false;
      let tx: LedgerTransaction | undefined;
      let prior = false;
      let value: T | undefined;
      let primary: unknown;
      let failed = false;
      const note = (phase: 'commit' | 'rollback' | 'complete') => {
        try {
          budget.note(phase);
        } catch {
          /* Diagnostics cannot change durable truth. */
        }
      };
      try {
        await acquireWriteLock(this.db, budget, () => {
          begun = true;
        });
        budget.check('acquire');
        budget.checkLockSpent();
        tx = new LedgerTransaction(this.db);
        budget.check('callback');
        value = synchronousResult(callback(tx));
        prior = tx.isPriorDurableResult(value);
        // A replay requires no new commit. Its incidental work must not escape cleanup.
        if (!prior) {
          budget.check('commit');
          try {
            this.db.exec('COMMIT');
          } catch (cause) {
            throw new LedgerCommitUncertain(cause);
          }
          begun = false; // Set known committed before any clock/observer work.
          note('commit');
        }
      } catch (error) {
        primary = error;
        failed = true;
      } finally {
        tx?.finish();
        if (begun) {
          note('rollback');
          try {
            this.db.exec('ROLLBACK');
          } catch (cause) {
            // Do not allow queued work to accidentally commit a leftover transaction.
            this.#unusable = true;
            if (!(primary instanceof LedgerCommitUncertain) && !prior) {
              primary = new LedgerCleanupFailed(new AggregateError([primary, cause], 'rollback_failed'));
              failed = true;
            }
          }
          note('rollback');
        }
        this.#active = false;
        if (this.#unusable) {
          try {
            this.db.close();
            this.#closed = true;
          } catch {
            /* Isolated, never reused. */
          }
        }
        note('complete');
      }
      if (failed) throw primary;
      return value as T;
    };
    const result = this.#tail.then(execute);
    this.#tail = result.catch(() => {});
    return result;
  }

  /** Internal short consistent read, including rows that do not emit events (H). */
  snapshot<T>(callback: (tx: LedgerTransaction) => T): T {
    if (this.#closed || this.#unusable) throw new Error('ledger_closed');
    if (this.#active) throw new Error('ledger_connection_busy');
    this.db.exec('BEGIN');
    const tx = new LedgerTransaction(this.db);
    try {
      const result = synchronousResult(callback(tx));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      tx.finish();
    }
  }

  /** Queue a consistent read behind writes sharing this connection. No write lock. */
  readSnapshot<T>(callback: (tx: LedgerTransaction) => T, budget?: CallBudget): Promise<T> {
    const queued = budget?.now();
    const result = this.#tail.then(() => {
      if (budget) {
        budget.chargeWait(queued!, true);
        budget.check('queue');
        budget.checkLockSpent();
      }
      return this.snapshot(callback);
    });
    this.#tail = result.catch(() => {});
    return result;
  }

  /** SQLite WAL recovery happens on open. Never recreate metadata or reset execution tickets. */
  checkIntegrity(): { integrity: string[]; foreignKeys: object[] } {
    return this.snapshot((tx) => ({
      integrity: tx.all('PRAGMA integrity_check').map((row) => String(row.integrity_check)),
      foreignKeys: tx.all('PRAGMA foreign_key_check'),
    }));
  }
  async close(): Promise<void> {
    await this.#tail;
    if (!this.#closed) {
      this.db.close();
      this.#closed = true;
    }
  }
}

export async function openLedger(path: string, options: LedgerOptions = {}): Promise<Ledger> {
  const call = options.callBudget;
  call?.check();
  requireLedgerRuntime();
  const budget = options.busyBudgetMs ?? 20;
  if (!Number.isFinite(budget) || budget < 0 || budget > 20) throw new TypeError('invalid_busy_budget');
  const { DatabaseSync } = await loadLedgerSqlite();
  call?.check();
  if (path !== ':memory:') {
    try {
      closeSync(openSync(path, 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const db = new DatabaseSync(path);
  try {
    call?.check();
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version !== 0 && version !== 1) throw new Error(`unsupported_ledger_version:${version}`);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
    // Journal mode negotiation can itself contend. It returns busy, never waits without a budget.
    db.exec('PRAGMA journal_mode=WAL');
    let begun = false;
    try {
      await acquireWriteLock(db, call ?? budget, () => {
        begun = true;
      });
      call?.check('acquire');
      call?.checkLockSpent();
      const current = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (current === 0) {
        if (db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())
          throw new Error('unversioned_nonempty_ledger');
        // Execute exactly the frozen block's body, under the already acquired/rechecked init lock.
        const body = SCHEMA_V1_DDL.split('BEGIN IMMEDIATE;\n')[1].replace(/COMMIT;\n$/, '');
        db.exec(body);
      } else if (current !== 1) throw new Error(`unsupported_ledger_version:${current}`);
      call?.check('commit');
      try {
        db.exec('COMMIT');
      } catch (cause) {
        if (call) throw new LedgerCommitUncertain(cause);
        throw cause;
      }
      begun = false;
    } catch (error) {
      if (begun) {
        try {
          db.exec('ROLLBACK');
        } catch (cause) {
          if (!(error instanceof LedgerCommitUncertain)) throw new LedgerCleanupFailed(cause);
        }
      }
      throw error;
    }
    const metadata = db.prepare('SELECT ledger_id FROM ledger_metadata WHERE singleton=1').get();
    if (!metadata || typeof metadata.ledger_id !== 'string' || !metadata.ledger_id)
      throw new Error('ledger_metadata_missing');
    return new Ledger(db, metadata.ledger_id, budget);
  } catch (error) {
    db.close();
    throw error;
  }
}
