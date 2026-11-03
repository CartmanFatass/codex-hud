import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallBudgetExpired } from '../../src/ledger/call-budget.js';
import { LedgerCommitUncertain } from '../../src/ledger/ledger.js';
import { PrivateLedgerGate } from '../../src/ledger/local-manager.js';
import { readReconcileSnapshot, commitReconcile } from '../../src/ledger/reconcile.js';
import { HudMcpServer, serveStdio } from '../../packages/hud-mcp/src/server.js';
import { DelegationService, type DelegationOptions } from '../../packages/hud-mcp/src/delegation.js';
import { HandshakeService } from '../../packages/hud-mcp/src/handshake.js';
import { ReadControlService } from '../../packages/hud-mcp/src/read-control.js';
import { delegationBenchmarkFixture } from '../unit/b45-delegation-fixture.js';
import { handshakeFixture } from '../unit/b45-handshake-fixture.js';
import { TestBudgetClock } from '../unit/p065-budget-fixture.js';

const request = (name: string, args: object = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});
const optionsOf = (service: DelegationService) => (service as unknown as { options: DelegationOptions }).options;
function counts(f: Awaited<ReturnType<typeof delegationBenchmarkFixture>>) {
  return f.ledger.snapshot((tx) => ({
    runs: tx.get('SELECT count(*) AS n FROM runs')!.n,
    claims: tx.get('SELECT count(*) AS n FROM claims')!.n,
    slots: tx.get('SELECT count(*) AS n FROM slots')!.n,
    accepted: tx.get("SELECT count(*) AS n FROM events WHERE kind='intent.accepted'")!.n,
    rejected: tx.get("SELECT count(*) AS n FROM events WHERE kind='intent.rejected'")!.n,
    launches: f.launches.length,
  }));
}

test('P065 actual MCP source expiry precedes root authorization and returns existing busy shape', async () => {
  const clock = new TestBudgetClock(),
    f = await delegationBenchmarkFixture(true, clock);
  try {
    const before = counts(f),
      events = f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM events')!.n);
    const server = new HudMcpServer(
      {
        resolve: async () => {
          const source = f.source();
          clock.advance(30);
          return source;
        },
      },
      f.service,
      () => true,
      { clock }
    );
    const result = (await server.handle(request('delegate_spawn', f.spawnArgs))) as any;
    assert.deepEqual(result.result.structuredContent, {
      ok: false,
      code: 'busy',
      advice: result.result.structuredContent.advice,
    });
    assert.equal(result.result.isError, true);
    assert.deepEqual(counts(f), before);
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM events')!.n),
      events
    );
  } finally {
    await f.service.close();
    await f.close();
  }
});

test('P065 preparation expiry preserves earlier root bookkeeping but no intent, claim, slot or dispatch', async () => {
  const clock = new TestBudgetClock(),
    f = await delegationBenchmarkFixture(true, clock);
  try {
    const before = counts(f);
    const options = optionsOf(f.service);
    const service = new DelegationService({
      ...options,
      capability: {
        verify: () => {
          clock.advance(30);
          return { ok: true, reason: null };
        },
      },
    });
    await assert.rejects(service.invoke(f.source(), 'delegate_spawn', f.spawnArgs), CallBudgetExpired);
    assert.deepEqual(counts(f), before);
    await service.close();
  } finally {
    await f.service.close();
    await f.close();
  }
});

test('P065 actual mapper retains internal_error for uncertain COMMIT without dispatch or retry-safe fields', async () => {
  const clock = new TestBudgetClock(),
    f = await delegationBenchmarkFixture(true, clock);
  try {
    const original = f.ledger.transaction.bind(f.ledger);
    f.ledger.transaction = async (callback, budget) => {
      const result = await original(callback, budget);
      if (result && typeof result === 'object' && 'replayed' in result && !result.replayed)
        throw new LedgerCommitUncertain(new Error('synthetic acknowledgement loss'));
      return result;
    };
    const server = new HudMcpServer({ resolve: async () => f.source() }, f.service, () => true, { clock });
    const first = (await server.handle(request('delegate_spawn', f.spawnArgs))) as any;
    assert.equal(first.result.structuredContent.code, 'internal_error');
    assert.equal('accepted' in first.result.structuredContent, false);
    assert.equal('notAccepted' in first.result.structuredContent, false);
    assert.equal(f.launches.length, 0);
    const second = (await server.handle(request('delegate_spawn', f.spawnArgs))) as any;
    assert.equal(second.result.structuredContent.status, 'accepted');
    assert.equal(f.launches.length, 0);
    assert.equal(
      f.ledger.snapshot((tx) => tx.get("SELECT count(*) AS n FROM events WHERE kind='intent.rejected'")!.n),
      0
    );
  } finally {
    await f.service.close();
    await f.close();
  }
});

test('P065 compiled service local binding supports resume and replay, and refuses missing/wrong/unsafe binding without audit', async () => {
  const clock = new TestBudgetClock(),
    f = await delegationBenchmarkFixture(true, clock);
  try {
    await f.bindAndEnd();
    const options = optionsOf(f.service),
      args = { ...f.resumeArgs, expectedRun: 'run-a', mode: 'headless' as const };
    const binding = new PrivateLedgerGate(f.root).bind(f.ledger);
    const local = new DelegationService({
      ...options,
      localBinding: binding,
      registration: undefined,
      reader: undefined,
    });
    const accepted = await local.resumeLocal(args);
    assert.deepEqual(await local.resumeLocal(args), accepted);
    assert.equal(f.launches.length, 1);
    const before = counts(f);
    const missing = new DelegationService({ ...options, registration: undefined, reader: undefined });
    await assert.rejects(missing.resumeLocal(args), /local_store_proof_failed/);
    const serialized = new DelegationService({
      ...options,
      localBinding: JSON.parse(JSON.stringify(binding)),
      registration: undefined,
      reader: undefined,
    });
    await assert.rejects(serialized.resumeLocal(args), /local_store_proof_failed/);
    await serialized.close();
    chmodSync(f.root, 0o755);
    await assert.rejects(local.resumeLocal(args), /local_store_proof_failed/);
    chmodSync(f.root, 0o700);
    await assert.rejects(local.resumeLocal(args), /local_store_proof_failed/);
    assert.deepEqual(counts(f), before);
    await local.close();
    await missing.close();
  } finally {
    await f.service.close();
    await f.close();
  }
});

test('P065 handshake and no-key report preserve successful-late COMMIT; no automatic report deduplication', async () => {
  const clock = new TestBudgetClock(),
    f = await handshakeFixture();
  try {
    await f.startup();
    const service = new HandshakeService({
      ledger: f.ledger,
      registration: f.child.registration,
      reader: f.reader,
      env: { HUD_CLAIM: f.claim },
      now: f.now,
      home: f.root,
    });
    // Execute the actual SQLite COMMIT, then delay its acknowledgement.
    const db = f.ledger['db'];
    const exec = db.exec.bind(db);
    let write = false;
    db.exec = (sql: string) => {
      if (sql === 'BEGIN IMMEDIATE') write = true;
      if (sql === 'BEGIN') write = false;
      exec(sql);
      if (sql === 'COMMIT' && write) {
        write = false;
        clock.advance(31);
      }
    };
    const who = await service.whoami({}, f.child.authority, clock.budget());
    assert.equal(who.ok && who.state, 'bound');
    const args = { runId: 'run-a', status: 'completed' as const, summary: 'Synthetic report' };
    const one = await service.report(args, f.child.authority, clock.budget());
    const two = await service.report(args, f.child.authority, clock.budget());
    assert.equal(one.ok, true);
    assert.equal(two.ok, true);
    if (one.ok && two.ok) assert.notEqual(one.reportId, two.reportId);
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM reports')!.n),
      2
    );
  } finally {
    await f.close();
  }
});

test('P065 death reconciliation remains durable when later cancel budget expires', async () => {
  const clock = new TestBudgetClock(),
    f = await handshakeFixture();
  try {
    const original = f.ledger.transaction.bind(f.ledger);
    f.ledger.transaction = async (callback, budget) => {
      const result = await original(callback, budget);
      if (result && typeof result === 'object' && 'decision' in result) clock.advance(30);
      return result;
    };
    const reads = new ReadControlService(f.ledger, f.root, undefined, { supervisorState: () => 'dead' });
    await assert.rejects(reads.cancel('run-a', 10, f.parent.authority, clock.budget()), CallBudgetExpired);
    const row = f.ledger.snapshot((tx) => ({
      run: tx.get("SELECT state,cancel_requested_at FROM runs WHERE run_id='run-a'"),
      slots: tx.get('SELECT count(*) AS n FROM slots')!.n,
      cancel: tx.get("SELECT count(*) AS n FROM events WHERE kind='cancel.accepted'")!.n,
    }));
    assert.equal(row.run!.state, 'uncertain');
    assert.equal(row.run!.cancel_requested_at, null);
    assert.equal(row.slots, 1);
    assert.equal(row.cancel, 0);
  } finally {
    await f.close();
  }
});

test('P065 status has zero writes; framed output delay cannot falsify accepted truth', async () => {
  const clock = new TestBudgetClock(),
    f = await delegationBenchmarkFixture(true, clock);
  try {
    const before = f.ledger.snapshot((tx) => tx.get('SELECT total_changes() AS n')!.n);
    await f.service.invoke(f.source(), 'delegate_status', { runId: 'run-a' });
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT total_changes() AS n')!.n),
      before
    );
    const input = new PassThrough();
    let bytes = '';
    const timings: any[] = [];
    let delivered!: () => void;
    const flushed = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, done) {
        clock.advance(60);
        bytes += String(chunk);
        done();
        delivered();
      },
    });
    const server = new HudMcpServer({ resolve: async () => f.source() }, f.service, () => true, {
      clock,
      observe: (sample) => timings.push(sample),
    });
    const serving = serveStdio(server, input, output);
    input.write(JSON.stringify(request('delegate_spawn', f.spawnArgs)) + '\n');
    await flushed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.end();
    await serving;
    assert.equal(JSON.parse(bytes).result.structuredContent.status, 'accepted');
    assert.equal(f.launches.length, 1);
    assert.equal(timings.length, 1);
    assert.ok(timings[0].elapsedMs >= 60);
  } finally {
    await f.service.close();
    await f.close();
  }
});

test('P065 unsafe proof permits no rejection-audit attempt, and audit rechecks a later store change without replacing primary refusal', async () => {
  const clock = new TestBudgetClock(),
    f = await delegationBenchmarkFixture(true, clock);
  try {
    await f.bindAndEnd();
    const base = optionsOf(f.service);
    const binding = new PrivateLedgerGate(f.root).bind(f.ledger);
    const local = new DelegationService({ ...base, localBinding: binding, registration: undefined, reader: undefined });
    const original = f.ledger.transaction.bind(f.ledger);
    let attempts = 0;
    f.ledger.transaction = (callback, budget) => {
      attempts++;
      return original(callback, budget);
    };
    chmodSync(f.root, 0o755);
    await assert.rejects(
      local.resumeLocal({ ...f.resumeArgs, expectedRun: 'run-a', mode: 'headless' }),
      /local_store_proof_failed/
    );
    assert.equal(attempts, 1);
    assert.equal(f.launches.length, 0);
    chmodSync(f.root, 0o700);
    await local.close();
    const safe = new DelegationService({
      ...base,
      localBinding: new PrivateLedgerGate(f.root).bind(f.ledger),
      registration: undefined,
      reader: undefined,
    });
    attempts = 0;
    f.ledger.transaction = async (callback, budget) => {
      attempts++;
      try {
        return await original(callback, budget);
      } catch (error) {
        if ((error as Error).message === 'expected_run_mismatch') chmodSync(f.root, 0o755);
        throw error;
      }
    };
    const before = counts(f);
    await assert.rejects(
      safe.resumeLocal({ ...f.resumeArgs, request_key: 'stale-audit', expectedRun: 'stale-run', mode: 'headless' }),
      /expected_run_mismatch/
    );
    assert.equal(attempts, 2);
    assert.deepEqual(counts(f), before);
    await safe.close();
  } finally {
    chmodSync(f.root, 0o700);
    await f.service.close();
    await f.close();
  }
});

test('P065 late cancel COMMIT and optional advice/hint errors retain durable outcomes', async () => {
  const clock = new TestBudgetClock(),
    f = await delegationBenchmarkFixture(true, clock);
  try {
    const db = f.ledger['db'],
      exec = db.exec.bind(db);
    let write = false;
    db.exec = (sql: string) => {
      if (sql === 'BEGIN IMMEDIATE') write = true;
      if (sql === 'BEGIN') write = false;
      exec(sql);
      if (sql === 'COMMIT' && write) {
        write = false;
        clock.advance(31);
      }
    };
    const reads = new ReadControlService(f.ledger, f.root, undefined, { supervisorState: () => 'alive' });
    const cancel = await reads.cancel('run-a', 10, f.parent.authority, clock.budget());
    assert.equal(cancel.accepted, true);
    assert.notEqual(cancel.cancelRequestedAt, null);
    db.exec = exec;
    (f.service as any).cache.model = () => {
      throw new Error('synthetic_optional_advice');
    };
    const accepted = (await f.service.invoke(f.source(), 'delegate_spawn', f.spawnArgs)) as any;
    assert.equal(accepted.status, 'accepted');
    assert.equal(f.launches.length, 1);
    assert.equal(((await f.service.invoke(f.source(), 'delegate_spawn', f.spawnArgs)) as any).runId, accepted.runId);
    assert.equal(f.launches.length, 1);
  } finally {
    await f.service.close();
    await f.close();
  }
});

test('P065 actual local writer interval permits only the bounded metadata pass; preparation and hints stay outside', async () => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const clock = new TestBudgetClock(),
    f = await delegationBenchmarkFixture(true, clock);
  const originals = new Map<string, Function>();
  const asyncOriginals = new Map<string, Function>();
  let locked = false;
  const calls: { method: string; path: string }[] = [];
  try {
    await f.bindAndEnd();
    const base = optionsOf(f.service);
    const local = new DelegationService({
      ...base,
      localBinding: new PrivateLedgerGate(f.root).bind(f.ledger),
      registration: undefined,
      reader: undefined,
      launch: async (...args) => {
        assert.equal(locked, false);
        return base.launch!(...args);
      },
    });
    const db = f.ledger['db'],
      exec = db.exec.bind(db);
    db.exec = (sql: string) => {
      exec(sql);
      if (sql === 'BEGIN IMMEDIATE') locked = true;
      if (sql === 'COMMIT' || sql === 'ROLLBACK') locked = false;
    };
    for (const name of [
      'lstatSync',
      'realpathSync',
      'readFileSync',
      'writeFileSync',
      'openSync',
      'readSync',
      'writeSync',
      'statSync',
      'accessSync',
      'readlinkSync',
      'opendirSync',
      'mkdirSync',
      'unlinkSync',
      'renameSync',
    ]) {
      const original = (fs as any)[name];
      originals.set(name, original);
      Object.defineProperty(fs, name, {
        value: (...args: unknown[]) => {
          if (locked) calls.push({ method: name, path: String(args[0]) });
          return original(...args);
        },
      });
    }
    for (const name of ['realpath', 'open', 'stat', 'access', 'readFile', 'writeFile', 'mkdir', 'unlink']) {
      const original = (fs.promises as any)[name];
      asyncOriginals.set(name, original);
      (fs.promises as any)[name] = (...args: unknown[]) => {
        if (locked) calls.push({ method: 'promises.' + name, path: String(args[0]) });
        return original(...args);
      };
    }
    syncBuiltinESMExports();
    const args = { ...f.resumeArgs, request_key: 'p065-io', expectedRun: 'run-a', mode: 'headless' as const };
    const accepted = await local.resumeLocal(args);
    assert.ok(accepted);
    assert.equal(calls.length, 8);
    assert.deepEqual(
      calls,
      [
        f.root,
        join(f.root, 'ledger.sqlite'),
        join(f.root, 'ledger.sqlite-wal'),
        join(f.root, 'ledger.sqlite-shm'),
      ].flatMap((path) => [
        { method: 'lstatSync', path },
        { method: 'realpathSync', path },
      ])
    );
    calls.length = 0;
    assert.deepEqual(await local.resumeLocal(args), accepted);
    assert.equal(calls.length, 8);
    assert.equal(f.launches.length, 1);
    await local.close();
  } finally {
    for (const [name, value] of originals) Object.defineProperty(fs, name, { value });
    for (const [name, value] of asyncOriginals) (fs.promises as any)[name] = value;
    syncBuiltinESMExports();
    await f.service.close();
    await f.close();
  }
});

test('P065 source refusal decision excludes later advice and flush from authorization timing', async () => {
  const clock = new TestBudgetClock();
  let sample: any;
  const server = new HudMcpServer(
    {
      resolve: async () => {
        clock.advance(7);
        return { ok: false, code: 'identity_source_missing' };
      },
    },
    {
      invoke: async () => assert.fail('refused source entered body'),
      decorateFailure: (_tool, _args, outcome) => {
        clock.advance(10);
        return outcome;
      },
    },
    () => true,
    {
      clock,
      observe: (value) => {
        sample = value;
      },
    }
  );
  const response = await server.handle(request('delegate_status', { runId: 'run-a' }));
  clock.advance(50);
  server.flushed(response);
  assert.equal(sample.authorizationMs, 7);
  assert.equal(sample.elapsedMs, 67);
});
