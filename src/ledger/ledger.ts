import { closeSync, openSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_V1_DDL } from './schema.js';
import { requireLedgerRuntime, loadLedgerSqlite } from './runtime.js';
import { acquireWriteLock, LedgerBusyError, LedgerTransaction, synchronousResult } from './transaction.js';

export interface LedgerOptions {
  busyBudgetMs?: number;
}

/** Shared writer library; no scheduler, recovery process, or external action is started here. */
export class Ledger {
  #tail: Promise<unknown> = Promise.resolve();
  #active = false;
  #closed = false;
  constructor(
    private readonly db: DatabaseSync,
    readonly ledgerId: string,
    readonly busyBudgetMs: number
  ) {}

  transaction<T>(callback: (tx: LedgerTransaction) => T, budgetMs = this.busyBudgetMs): Promise<T> {
    if (!Number.isFinite(budgetMs) || budgetMs < 0 || budgetMs > 20)
      return Promise.reject(new TypeError('invalid_busy_budget'));
    const deadline = performance.now() + Math.min(this.busyBudgetMs, budgetMs);
    const execute = async (): Promise<T> => {
      if (this.#closed) throw new Error('ledger_closed');
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

  /** Internal short consistent read, including rows that do not emit events (H). */
  snapshot<T>(callback: (tx: LedgerTransaction) => T): T {
    if (this.#closed) throw new Error('ledger_closed');
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
  requireLedgerRuntime();
  const budget = options.busyBudgetMs ?? 20;
  if (!Number.isFinite(budget) || budget < 0 || budget > 20) throw new TypeError('invalid_busy_budget');
  const { DatabaseSync } = await loadLedgerSqlite();
  if (path !== ':memory:') {
    try {
      closeSync(openSync(path, 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const db = new DatabaseSync(path);
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version !== 0 && version !== 1) throw new Error(`unsupported_ledger_version:${version}`);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
    // Journal mode negotiation can itself contend. It returns busy, never waits without a budget.
    db.exec('PRAGMA journal_mode=WAL');
    await acquireWriteLock(db, budget);
    try {
      const current = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (current === 0) {
        if (db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())
          throw new Error('unversioned_nonempty_ledger');
        // Execute exactly the frozen block's body, under the already acquired/rechecked init lock.
        const body = SCHEMA_V1_DDL.split('BEGIN IMMEDIATE;\n')[1].replace(/COMMIT;\n$/, '');
        db.exec(body);
      } else if (current !== 1) throw new Error(`unsupported_ledger_version:${current}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
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
