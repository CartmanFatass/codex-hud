import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Ledger, openLedger } from '../../src/ledger/ledger.js';
import { CallBudget, type BudgetClock } from '../../src/ledger/call-budget.js';
import type { PreparedIntent } from '../../src/ledger/types.js';

/** Trusted deterministic dependency, not a global clock or request timestamp. */
export class TestBudgetClock implements BudgetClock {
  time = 0;
  sleepExtra = 0;
  now = () => this.time;
  sleep = async (ms: number) => {
    this.time += ms + this.sleepExtra;
  };
  advance(ms: number) {
    this.time += ms;
  }
  budget() {
    return new CallBudget(this);
  }
}
export async function budgetFixture() {
  const home = mkdtempSync(join(tmpdir(), 'p065-synthetic-'));
  const file = join(home, 'ledger.sqlite');
  const original = await openLedger(file);
  const id = original.ledgerId;
  await original.close();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
  const ledger = new Ledger(db, id, 20);
  const fixtures = await import(pathToFileURL(resolve('tests/ledger/fixtures.mjs')).href);
  await fixtures.seedCaller(ledger);
  const clock = new TestBudgetClock();
  const input: PreparedIntent = fixtures.intent();
  const exec = db.exec.bind(db);
  const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  return {
    home,
    file,
    db,
    ledger,
    clock,
    input,
    exec,
    count,
    async close() {
      await ledger.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
