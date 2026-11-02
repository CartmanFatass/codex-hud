import { existsSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { openLedger } from '../../dist-test/src/ledger/ledger.js';
import { acceptIntent } from '../../dist-test/src/ledger/intents.js';
import { insertRecord } from '../../dist-test/src/ledger/records.js';
import { LedgerTransaction } from '../../dist-test/src/ledger/transaction.js';
import { at, evidence, intent, seedCaller, staleCandidate } from './fixtures.mjs';

const ledger = await openLedger(process.argv[2]);
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
let cut = null;
let busyBarrier = null;
let busyAttempts = 0;
let expected;
let inserts = new Map();

function pauseAt(label) {
  if (cut !== label) return;
  process.send({ type: 'cut', label });
  // Only the owned child is stopped here. The parent kills it with SIGKILL.
  Atomics.wait(sleepCell, 0, 0, 10000);
  throw new Error(`parent_did_not_kill_at:${label}`);
}

// Observe real production SQL without adding fault hooks to the ledger API.
const run = LedgerTransaction.prototype.run;
LedgerTransaction.prototype.run = function (sql, ...params) {
  const result = run.call(this, sql, ...params);
  const table = /^INSERT INTO (\w+)/i.exec(sql)?.[1];
  if (table) {
    const count = (inserts.get(table) ?? 0) + 1;
    inserts.set(table, count);
    pauseAt(`insert:${table}${count > 1 ? `:${count}` : ''}`);
  }
  return result;
};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (sql === 'COMMIT') pauseAt('before:commit');
  try {
    const result = exec.call(this, sql);
    if (sql === 'COMMIT') pauseAt('after:commit');
    return result;
  } catch (error) {
    if (sql === 'BEGIN IMMEDIATE' && /locked|busy/i.test(error.message) && busyBarrier) {
      busyAttempts++;
      // Wake the holder immediately; an IPC round trip would consume retry budget.
      writeFileSync(busyBarrier, 'actual SQLITE_BUSY', { mode: 0o600 });
    }
    throw error;
  }
};

process.on('message', async (message) => {
  const { id, action } = message;
  try {
    let result;
    if (action === 'seed') await seedCaller(ledger);
    else if (action === 'intent') {
      cut = message.cut ?? null;
      inserts = new Map();
      const prepared = intent(message.variant, message.changed);
      if (message.workspace)
        prepared.run.workspaceSnapshot = {
          cwdSource: 'explicit',
          cwdAsOf: at,
          gitCapturedAt: null,
          gitMissingReason: 'not_a_repository',
          worktreeRoot: null,
          gitCommonDir: null,
          repoId: null,
          identityKind: 'git-common-dir-v1',
          scope: 'local',
        };
      result = await acceptIntent(ledger, prepared);
      cut = null;
    } else if (action === 'inspect') {
      result = ledger.snapshot((tx) =>
        Object.fromEntries(
          ['links', 'runs', 'claims', 'slots', 'idempotency', 'events', 'evidence'].map((table) => [
            table,
            tx.all(`SELECT * FROM ${table}`),
          ])
        )
      );
      result.integrity = ledger.checkIntegrity();
      result.ledgerId = ledger.ledgerId;
    } else if (action === 'snapshot') {
      const { readReconcileSnapshot } = await import('../../dist-test/src/ledger/reconcile.js');
      expected = readReconcileSnapshot(ledger, 'run-one');
      result = { version: expected.version };
    } else if (action === 'reconcile') {
      const { commitReconcile } = await import('../../dist-test/src/ledger/reconcile.js');
      busyBarrier = message.barrier;
      busyAttempts = 0;
      try {
        result = await commitReconcile(ledger, expected, staleCandidate(), at + 20);
      } catch (error) {
        if (error.code !== 'ledger_busy') throw error;
        result = { lockBudgetExhausted: true };
      }
      result = { ...result, busyAttempts };
      busyBarrier = null;
    } else if (action === 'hold') {
      await ledger.transaction((tx) => {
        if (message.mutation === 'cancel') {
          tx.run("UPDATE runs SET state='cancelling',cancel_requested_at=? WHERE run_id='run-one'", at + 5);
        } else if (message.mutation === 'terminate') {
          insertRecord(tx, 'evidence', evidence('new-terminal', 'exit_receipt'));
          tx.run(
            "UPDATE runs SET state='ended',ended_at=?,submission_fenced_at=?,terminal_evidence_id='new-terminal',exit_code=0,exit_source='wait_status' WHERE run_id='run-one'",
            at + 5,
            at + 5
          );
          tx.run("DELETE FROM slots WHERE run_id='run-one'");
        } else if (message.mutation === 'conflict') {
          insertRecord(tx, 'evidence', evidence('new-conflict', 'conflict'));
        } else throw new Error('unknown_mutation');
        process.send({ type: 'locked' });
        const deadline = performance.now() + 5000;
        while (!existsSync(message.barrier)) {
          if (performance.now() >= deadline) throw new Error('no_actual_busy_attempt');
          Atomics.wait(sleepCell, 0, 0, 1);
        }
      });
    } else if (action === 'close') {
      await ledger.close();
      process.send({ id, result: true }, () => process.disconnect());
      return;
    } else throw new Error('unknown_action');
    process.send({ id, result: result ?? null });
  } catch (error) {
    cut = null;
    process.send({
      id,
      error: error.message,
      code: error.code,
      stack: `${error.stack}\nbusyAttempts=${busyAttempts} barrier=${busyBarrier}`,
    });
  }
});
process.send({ type: 'ready' });
