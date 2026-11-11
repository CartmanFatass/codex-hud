/// <reference path="../../src/types/node-sqlite.d.ts" />
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { join } from 'node:path';
import { ledgerRuntimeSupported, loadLedgerSqlite } from '../../src/ledger/runtime.js';
import { authorizeRootCall, scopeSnapshot } from '../../src/ledger/call-context.js';
import { LedgerBusyError } from '../../src/ledger/transaction.js';
import { HandshakeService } from '../../packages/hud-mcp/src/handshake.js';
import { handshakeFixture, hashClaim } from '../unit/b45-handshake-fixture.js';
const skip = !ledgerRuntimeSupported()
  ? 'Ledger requires Node 22 >=22.13 or >=24'
  : process.env.HUD_B45_BENCH !== '1'
    ? 'Set HUD_B45_BENCH=1 and run this benchmark alone to measure without parallel test I/O'
    : false;
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(3));
  return {
    n: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: Number(sorted.at(-1)!.toFixed(3)),
  };
}

test(
  'B45 synthetic whoami/report success refusal busy distributions with real SQLite writer contention',
  { skip },
  async () => {
    const f = await handshakeFixture();
    const { DatabaseSync } = await loadLedgerSqlite();
    const blocker = new DatabaseSync(join(f.root, 'ledger.sqlite'));
    blocker.exec('PRAGMA busy_timeout=0');
    try {
      await f.startup();
      const service = new HandshakeService({
        ledger: f.ledger,
        registration: f.child.registration,
        reader: f.reader,
        env: { HUD_CLAIM: f.claim },
        now: f.now,
      });
      await service.whoami({}, f.child.authority);
      const parentService = new HandshakeService({
        ledger: f.ledger,
        registration: f.parent.registration,
        reader: f.reader,
        env: { HUD_CLAIM: f.claim },
        now: f.now,
      });
      for (const tool of ['whoami', 'report'] as const)
        for (const outcome of ['success', 'refusal', 'busy'] as const) {
          const internal: number[] = [],
            authTx: number[] = [],
            serviceOnly: number[] = [];
          for (let n = 0; n < 200; n++) {
            const actor = outcome === 'refusal' ? f.parent : f.child;
            const started = performance.now();
            const authority = await authorizeRootCall(f.ledger, {
              callerId: actor.registration.caller.callerId,
              processKey: actor.context.kind === 'dedicated' ? actor.context.processKey : '',
              sessionRef: actor.ref,
              evidenceDigest: hashClaim('synthetic-independent-call-proof'),
              premise: f.ledger.snapshot((tx) =>
                scopeSnapshot(tx, f.ledger.ledgerId, actor.authority.evidence.processKey)
              ),
              at: f.now(),
            });
            const authorized = performance.now();
            let held = false;
            try {
              if (outcome === 'busy') {
                blocker.exec('BEGIN IMMEDIATE');
                held = true;
              }
              const budget = { deadline: started + 30, lockBudgetMs: Math.max(0, 20 - (authorized - started)) };
              const target = outcome === 'refusal' ? parentService : service;
              if (tool === 'whoami') {
                if (outcome === 'refusal')
                  await assert.rejects(target.whoami({}, authority, budget), /claim_anchor_mismatch/);
                else if (outcome === 'busy')
                  await assert.rejects(target.whoami({}, authority, budget), LedgerBusyError);
                else assert.equal((await target.whoami({}, authority, budget)).ok, true);
              } else {
                const report = () =>
                  target.report(
                    { runId: 'run-a', status: 'completed', summary: 'Synthetic benchmark report' },
                    authority,
                    budget
                  );
                if (outcome === 'busy') await assert.rejects(report(), LedgerBusyError);
                else assert.equal((await report()).ok, outcome === 'success');
              }
              const ended = performance.now();
              internal.push(ended - started);
              authTx.push(ended - started);
              serviceOnly.push(ended - authorized);
            } finally {
              if (held) blocker.exec('ROLLBACK');
            }
          }
          const result = {
            kind: 'synthetic',
            tool,
            outcome,
            mcpInternalMs: stats(internal),
            authorizationPlusTransactionUpperBoundMs: stats(authTx),
            serviceMs: stats(serviceOnly),
            profile:
              'real ledger; authorizeRootCall; independently checked synthetic source, process stamp and ppid chain; service includes proof I/O; excludes stdio and real harness resolver',
          };
          process.stdout.write(JSON.stringify(result) + '\n');
          assert.ok(result.mcpInternalMs.p95 < 50, `${tool}/${outcome} MCP-internal p95`);
          assert.ok(
            result.authorizationPlusTransactionUpperBoundMs.p95 <= 30,
            `${tool}/${outcome} auth+tx upper bound p95`
          );
        }
    } finally {
      blocker.close();
      await f.close();
    }
  }
);
