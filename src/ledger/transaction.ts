import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

export type SqlRow = Record<string, SQLOutputValue>;
export class LedgerBusyError extends Error {
  readonly code = 'ledger_busy';
  constructor() {
    super('Ledger busy: no operation was accepted within the write-lock budget');
  }
}
function isBusy(error: unknown): boolean {
  return error instanceof Error && /database (?:is )?(?:locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/.test(error.message);
}
/** Busy timeout stays zero. Only lock acquisition retries; user callbacks run at most once. */
export async function acquireWriteLock(db: DatabaseSync, budgetMs = 20): Promise<void> {
  if (!Number.isFinite(budgetMs) || budgetMs < 0 || budgetMs > 20) throw new TypeError('invalid_busy_budget');
  const deadline = performance.now() + budgetMs;
  const backoffs = [1, 2, 4, 4, 4, 4];
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec('BEGIN IMMEDIATE');
      return;
    } catch (error) {
      if (!isBusy(error)) throw error;
      const remaining = deadline - performance.now();
      if (attempt >= backoffs.length || remaining <= backoffs[attempt] + 1) throw new LedgerBusyError();
      await delay(backoffs[attempt]);
      if (performance.now() >= deadline) throw new LedgerBusyError();
    }
  }
}

/** Internal writer port. SQL/table shapes are not a supported external consumer API. */
export class LedgerTransaction {
  #active = true;
  constructor(private readonly db: DatabaseSync) {}
  finish(): void {
    this.#active = false;
  }
  #check(): void {
    if (!this.#active) throw new Error('transaction_finished');
  }
  get(sql: string, ...params: SQLInputValue[]): SqlRow | undefined {
    this.#check();
    return this.db.prepare(sql).get(...params);
  }
  all(sql: string, ...params: SQLInputValue[]): SqlRow[] {
    this.#check();
    return this.db.prepare(sql).all(...params);
  }
  run(sql: string, ...params: SQLInputValue[]): number {
    this.#check();
    return Number(this.db.prepare(sql).run(...params).changes);
  }
}

export function synchronousResult<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value)
    throw new TypeError('ledger_transaction_callback_must_be_synchronous');
  return value;
}
