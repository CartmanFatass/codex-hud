/** Finite cloud-functional controls. Fake monotonic time is not performance qualification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerRuntimeSupported } from '../../dist/ledger/runtime.js';
import { Readable, Writable } from 'node:stream';
import { CallBudget, sharedRenewalBudget } from '../../dist/ledger/call-budget.js';
import { Ledger, LedgerCommitUncertain, LedgerCleanupFailed } from '../../dist/ledger/ledger.js';
import { acquireWriteLock } from '../../dist/ledger/transaction.js';
import { HudMcpServer, serveStdio } from '../../dist-test/packages/hud-mcp/src/server.js';

// Root npm test builds dist and dist-test, not the separate hud-mcp output.
// Keep Node 18/20 compatible: never resolve node:sqlite on unsupported runtimes.
const supported = ledgerRuntimeSupported();
const { DatabaseSync } = supported ? await import('node:sqlite') : { DatabaseSync: null };
const sqliteTest = (name, run) =>
  test(
    name,
    {
      skip: supported ? false : `Ledger requires Node 22.13+ or >=24 (23 unsupported); found ${process.versions.node}`,
    },
    run
  );

function clock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    advance: (ms) => {
      time += ms;
    },
  };
}
function fixture(intercept = () => {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE values_test (value INTEGER)');
  const calls = [];
  const adapter = {
    exec(sql) {
      calls.push(sql);
      intercept(sql, db);
      return db.exec(sql);
    },
    prepare: (sql) => db.prepare(sql),
    close: () => db.close(),
  };
  return { db, calls, ledger: new Ledger(adapter, 'synthetic', 20) };
}

test('one original 250ms deadline, tightening never extends, malformed clock refuses', () => {
  const c = clock();
  const b = new CallBudget(c);
  c.advance(249);
  b.check();
  c.advance(1);
  assert.throws(() => b.check(), /ledger_busy/);
  const earlier = new CallBudget(c, 100);
  earlier.tighten(300);
  earlier.tighten(999);
  c.advance(50);
  assert.throws(() => earlier.check(), /ledger_busy/);
  assert.throws(() => new CallBudget(c, 301), /invalid_budget_clock/);
  assert.throws(() => sharedRenewalBudget({ check() {} }), /invalid_shared_call_budget/);
});

sqliteTest('preparation beyond old 30ms succeeds, expired receipt runs no callback', async () => {
  const c = clock();
  const b = new CallBudget(c);
  const f = fixture();
  let callbacks = 0;
  try {
    c.advance(150);
    await f.ledger.transaction((tx) => {
      callbacks++;
      tx.run('INSERT INTO values_test VALUES (1)');
    }, b);
    c.advance(100);
    await assert.rejects(
      f.ledger.transaction(() => {
        callbacks++;
      }, b),
      /ledger_busy/
    );
    assert.equal(callbacks, 1);
    assert.equal(f.calls.filter((x) => x === 'COMMIT').length, 1);
  } finally {
    await f.ledger.close();
  }
});

sqliteTest('queue consumes cumulative contention and refuses at100ms before BEGIN', async () => {
  const c = clock();
  const b = new CallBudget(c);
  const f = fixture();
  try {
    const pending = f.ledger.transaction(() => assert.fail('callback must not run'), b);
    c.advance(100);
    await assert.rejects(pending, /ledger_busy/);
    assert.deepEqual(f.calls, []);
    assert.equal(b.diagnostics().waitMs, 100);
  } finally {
    await f.ledger.close();
  }
});

sqliteTest('BEGIN retries can exceed old seven attempts but all waits share100ms across transactions', async () => {
  const c = clock();
  const b = new CallBudget(c);
  let busy = 12;
  const f = fixture((sql) => {
    if (sql === 'BEGIN IMMEDIATE' && busy-- > 0) throw new Error('database is locked');
  });
  try {
    await f.ledger.transaction((tx) => tx.run('INSERT INTO values_test VALUES (1)'), b);
    const spent = b.diagnostics().waitMs;
    assert.equal(spent, 43);
    busy = 1000;
    await assert.rejects(
      f.ledger.transaction(() => assert.fail('no second callback'), b),
      /ledger_busy/
    );
    assert.ok(b.diagnostics().waitMs >= 95 && b.diagnostics().waitMs <= 100);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM values_test').get().n, 1);
  } finally {
    await f.ledger.close();
  }
});

sqliteTest('callback overrun rolls back without COMMIT, late COMMIT preserves committed truth', async () => {
  const c = clock();
  let late = false;
  const f = fixture((sql) => {
    if (sql === 'COMMIT' && late) c.advance(300);
  });
  try {
    await assert.rejects(
      f.ledger.transaction((tx) => {
        tx.run('INSERT INTO values_test VALUES (1)');
        c.advance(300);
      }, new CallBudget(c)),
      /ledger_busy/
    );
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM values_test').get().n, 0);
    assert.equal(f.calls.includes('COMMIT'), false);
    late = true;
    const b = new CallBudget(c);
    const result = await f.ledger.transaction((tx) => {
      tx.run('INSERT INTO values_test VALUES (2)');
      return 'accepted';
    }, b);
    assert.equal(result, 'accepted');
    assert.equal(b.diagnostics().overrunMs, 50);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM values_test').get().n, 1);
  } finally {
    await f.ledger.close();
  }
});

sqliteTest('unknown COMMIT is not retry-safe busy; rollback failure poisons connection', async () => {
  const c = clock();
  const f = fixture((sql, db) => {
    if (sql === 'COMMIT') {
      db.exec(sql);
      throw new Error('response lost');
    }
  });
  await assert.rejects(
    f.ledger.transaction((tx) => tx.run('INSERT INTO values_test VALUES (1)'), new CallBudget(c)),
    LedgerCommitUncertain
  );
  await assert.rejects(
    f.ledger.transaction(() => assert.fail('must be poisoned'), new CallBudget(c)),
    /ledger_closed/
  );
  await f.ledger.close();
  const g = fixture((sql) => {
    if (sql === 'ROLLBACK') throw new Error('cleanup failed');
  });
  await assert.rejects(
    g.ledger.transaction(() => {
      throw new Error('primary');
    }, new CallBudget(c)),
    LedgerCleanupFailed
  );
  await assert.rejects(
    g.ledger.transaction(() => assert.fail('must be poisoned')),
    /ledger_closed/
  );
  await g.ledger.close();
});

sqliteTest(
  'late authenticated prior result returns without new COMMIT, cannot mark mutated result durable',
  async () => {
    const c = clock();
    const f = fixture();
    try {
      assert.equal(
        await f.ledger.transaction((tx) => {
          c.advance(300);
          return tx.priorDurableResult('original');
        }, new CallBudget(c)),
        'original'
      );
      assert.equal(f.calls.includes('COMMIT'), false);
      await assert.rejects(
        f.ledger.transaction((tx) => {
          tx.run('INSERT INTO values_test VALUES (1)');
          return tx.priorDurableResult('new');
        }, new CallBudget(c)),
        /prior_result_depends_on_transaction/
      );
    } finally {
      await f.ledger.close();
    }
  }
);

test('numeric ledger API stays capped20ms; zero budget retains immediate attempt', async () => {
  let attempts = 0;
  const db = {
    exec() {
      attempts++;
    },
  };
  await acquireWriteLock(db, 0);
  assert.equal(attempts, 1);
  await assert.rejects(acquireWriteLock(db, 100), /invalid_busy_budget/);
});

test('MCP receipt includes parent callback and source work, read-only tools never get writer budget', async () => {
  const c = clock();
  let sourceCalls = 0;
  let bodyCalls = 0;
  let parentDelay = 251;
  const server = new HudMcpServer(
    {
      resolve: async () => {
        sourceCalls++;
        c.advance(100);
        return { ok: true };
      },
    },
    {
      parentCall() {
        c.advance(parentDelay);
      },
      async invoke(_source, tool, _args, started, _signal, budget) {
        bodyCalls++;
        if (tool === 'delegate_whoami') {
          assert.equal(started, 251);
          assert.equal(budget.started, 251);
          budget.check();
        } else assert.equal(budget, undefined);
        return { ok: true };
      },
    },
    () => true,
    c
  );
  const request = (name, args = {}) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  let response = await server.handle(request('delegate_whoami'));
  assert.equal(response.result.structuredContent.code, 'busy');
  assert.equal(sourceCalls, 0);
  parentDelay = 0;
  response = await server.handle(request('delegate_whoami'));
  assert.equal(response.result.structuredContent.ok, true);
  assert.equal(bodyCalls, 1);
  parentDelay = 500;
  response = await server.handle(request('delegate_list'));
  assert.equal(response.result.structuredContent.ok, true);
  server.shutdown();
});

sqliteTest('pre-acceptance read queue shares contention allowance and never runs expired callback', async () => {
  const c = clock();
  const b = new CallBudget(c);
  const f = fixture();
  try {
    const pending = f.ledger.readSnapshot(() => assert.fail('expired queued read'), b);
    c.advance(100);
    await assert.rejects(pending, /ledger_busy/);
    assert.deepEqual(f.calls, []);
    assert.equal(b.diagnostics().queueMs, 100);
  } finally {
    await f.ledger.close();
  }
});

sqliteTest(
  'production delegation passes one shared budget through authorization and atomic intent, replay launches once',
  async () => {
    const { delegationBenchmarkFixture } = await import('../../dist-test/tests/unit/b45-delegation-fixture.js');
    const f = await delegationBenchmarkFixture();
    const c = clock();
    const b = new CallBudget(c);
    c.advance(150);
    try {
      const first = await f.service.invoke(f.source(), 'delegate_spawn', f.spawnArgs, b.started, undefined, b);
      assert.equal(first.ok, true);
      assert.equal(f.launches.length, 1);
      const replay = await f.service.invoke(f.source(), 'delegate_spawn', f.spawnArgs, b.started, undefined, b);
      assert.equal(replay.ok, true);
      assert.equal(f.launches.length, 1);
      const before = f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM runs').n);
      c.advance(100);
      await assert.rejects(
        f.service.invoke(
          f.source(),
          'delegate_spawn',
          { ...f.spawnArgs, request_key: 'synthetic-expired' },
          b.started,
          undefined,
          b
        ),
        /ledger_busy/
      );
      assert.equal(
        f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM runs').n),
        before
      );
      assert.equal(f.launches.length, 1);
    } finally {
      f.service.close();
      await f.close();
    }
  }
);

test('multiple MCP calls in one chunk retain the same original receipt', async () => {
  const c = clock();
  const responses = [];
  const server = new HudMcpServer(
    { resolve: async () => ({ ok: true }) },
    {
      parentCall() {
        c.advance(150);
      },
      async invoke() {
        return { ok: true };
      },
    },
    () => true,
    c
  );
  const calls =
    [1, 2]
      .map((id) =>
        JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'delegate_whoami', arguments: {} } })
      )
      .join('\n') + '\n';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      responses.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  await serveStdio(server, Readable.from([Buffer.from(calls)]), output);
  assert.equal(responses.find((r) => r.id === 1).result.structuredContent.ok, true);
  assert.equal(responses.find((r) => r.id === 2).result.structuredContent.code, 'busy');
});
