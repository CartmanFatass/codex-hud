import { acceptIntent } from '../../src/ledger/intents.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { chmodSync, copyFileSync, linkSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { PrivateLedgerGate, LocalStoreProofFailed } from '../../src/ledger/local-manager.js';
import { CallBudgetExpired } from '../../src/ledger/call-budget.js';
import type { IntentAuthority } from '../../src/ledger/types.js';
import { budgetFixture } from './p065-budget-fixture.js';
const actor = (): IntentAuthority => ({
  kind: 'local_user',
  uid: process.getuid!(),
  ownerUid: process.getuid!(),
  invocationId: 'synthetic-local',
  hudHomeOwned: true,
  ledgerOwned: true,
  privatePaths: true,
});

test('P065 fixed local guard: lstat first, at most one lstat/realpath per home/main/WAL/SHM in actual lock interval', async () => {
  const f = await budgetFixture();
  const originalLstat = fs.lstatSync,
    originalRealpath = fs.realpathSync;
  const binding = new PrivateLedgerGate(f.home).bind(f.ledger);
  const operations: string[] = [];
  let locked = false;
  try {
    f.db.exec = (sql: string) => {
      f.exec(sql);
      if (sql === 'BEGIN IMMEDIATE') locked = true;
      if (sql === 'ROLLBACK' || sql === 'COMMIT') locked = false;
    };
    Object.defineProperty(fs, 'lstatSync', {
      value: ((path: fs.PathLike, ...rest: unknown[]) => {
        if (locked) operations.push('lstat:' + path);
        return (originalLstat as Function)(path, ...rest);
      }) as typeof fs.lstatSync,
    });
    fs.realpathSync = ((path: fs.PathLike, ...rest: unknown[]) => {
      if (locked) operations.push('realpath:' + path);
      return (originalRealpath as Function)(path, ...rest);
    }) as typeof fs.realpathSync;
    syncBuiltinESMExports();
    const b = f.clock.budget();
    assert.equal(
      await f.ledger.transaction(() => {
        binding.check(f.ledger, actor(), b);
        return 7;
      }, b),
      7
    );
    assert.deepEqual(
      operations,
      [f.home, f.file, f.file + '-wal', f.file + '-shm'].flatMap((path) => ['lstat:' + path, 'realpath:' + path])
    );
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: originalLstat });
    fs.realpathSync = originalRealpath;
    syncBuiltinESMExports();
    await f.close();
  }
});

test('P065 original connection identity cannot be replaced by same SQL ledgerId or missing binding data', async () => {
  const f = await budgetFixture();
  try {
    const binding = new PrivateLedgerGate(f.home).bind(f.ledger);
    await assert.rejects(
      f.ledger.transaction(
        () => binding.check({ ...f.ledger } as typeof f.ledger, actor(), f.clock.budget()),
        f.clock.budget()
      ),
      LocalStoreProofFailed
    );
    await assert.rejects(
      f.ledger.transaction(() => binding.check(f.ledger, actor(), f.clock.budget()), f.clock.budget()),
      LocalStoreProofFailed
    );
    assert.equal(typeof JSON.parse(JSON.stringify(binding)).check, 'undefined');
  } finally {
    await f.close();
  }
});

test('P065 same-ledgerId main inode replacement invalidates original binding; new invocation can revalidate restored store', async () => {
  const f = await budgetFixture();
  const saved = join(f.home, 'original.sqlite');
  try {
    f.exec('PRAGMA wal_checkpoint(FULL)');
    const binding = new PrivateLedgerGate(f.home).bind(f.ledger);
    renameSync(f.file, saved);
    copyFileSync(saved, f.file);
    chmodSync(f.file, 0o600);
    let body = 0;
    await assert.rejects(
      f.ledger.transaction(() => {
        binding.check(f.ledger, actor(), f.clock.budget());
        body++;
      }, f.clock.budget()),
      LocalStoreProofFailed
    );
    assert.equal(body, 0);
    unlinkSync(f.file);
    renameSync(saved, f.file);
    await assert.rejects(
      f.ledger.transaction(() => binding.check(f.ledger, actor(), f.clock.budget()), f.clock.budget()),
      LocalStoreProofFailed
    );
    const fresh = new PrivateLedgerGate(f.home).bind(f.ledger);
    await f.ledger.transaction(() => fresh.check(f.ledger, actor(), f.clock.budget()), f.clock.budget());
  } finally {
    await f.close();
  }
});

for (const target of ['home', 'main'] as const)
  test(`P065 ${target} privacy and hard-link predicates remain enforced`, async () => {
    const f = await budgetFixture();
    try {
      const binding = new PrivateLedgerGate(f.home).bind(f.ledger),
        path = target === 'home' ? f.home : f.file;
      chmodSync(path, target === 'home' ? 0o755 : 0o644);
      await assert.rejects(
        f.ledger.transaction(() => binding.check(f.ledger, actor(), f.clock.budget()), f.clock.budget()),
        LocalStoreProofFailed
      );
      chmodSync(path, target === 'home' ? 0o700 : 0o600);
      if (target === 'main') {
        const fresh = new PrivateLedgerGate(f.home).bind(f.ledger);
        linkSync(f.file, join(f.home, 'hardlink.sqlite'));
        await assert.rejects(
          f.ledger.transaction(() => fresh.check(f.ledger, actor(), f.clock.budget()), f.clock.budget()),
          LocalStoreProofFailed
        );
      }
    } finally {
      await f.close();
    }
  });

test('P065 dangling sidecar symlink is not ENOENT absence', async () => {
  const f = await budgetFixture();
  const sidecar = f.file + '-shm',
    saved = sidecar + '.saved';
  try {
    const binding = new PrivateLedgerGate(f.home).bind(f.ledger);
    renameSync(sidecar, saved);
    symlinkSync(join(f.home, 'missing'), sidecar);
    assert.throws(() => binding.check(f.ledger, actor(), f.clock.budget()), LocalStoreProofFailed);
    unlinkSync(sidecar);
    renameSync(saved, sidecar);
  } finally {
    await f.close();
  }
});

test('P065 post-metadata deadline denies body but ordinary expiry does not invalidate safe binding', async () => {
  const f = await budgetFixture();
  const original = fs.realpathSync;
  try {
    const binding = new PrivateLedgerGate(f.home).bind(f.ledger);
    fs.realpathSync = ((path: fs.PathLike, ...rest: unknown[]) => {
      const result = (original as Function)(path, ...rest);
      if (String(path) === f.file + '-shm') f.clock.advance(30);
      return result;
    }) as typeof fs.realpathSync;
    syncBuiltinESMExports();
    const b = f.clock.budget();
    let body = 0;
    await assert.rejects(
      f.ledger.transaction(() => {
        binding.check(f.ledger, actor(), b);
        body++;
      }, b),
      CallBudgetExpired
    );
    assert.equal(body, 0);
    fs.realpathSync = original;
    syncBuiltinESMExports();
    const next = f.clock.budget();
    await f.ledger.transaction(() => binding.check(f.ledger, actor(), next), next);
  } finally {
    fs.realpathSync = original;
    syncBuiltinESMExports();
    await f.close();
  }
});

test('P065 shared legacy manager gate still validates trusted_local actor and original inodes', async () => {
  const f = await budgetFixture();
  try {
    const gate = new PrivateLedgerGate(f.home);
    gate.check(gate.actor());
    assert.throws(
      () => gate.check({ kind: 'trusted_local', uid: process.getuid!() + 1, invocationId: 'synthetic' }),
      /unauthorized_local_manager/
    );
  } finally {
    await f.close();
  }
});

test('P065 real CLI runtime-to-independent MCP build carries original proof/budget and preserves one-launch replay', async () => {
  const { delegationBenchmarkFixture } = await import('./b45-delegation-fixture.js');
  const { runCommand } = await import('../../src/cli/run.js');
  const { mcpModule } = await import('../../src/cli/runtime.js');
  const { TestBudgetClock } = await import('./p065-budget-fixture.js');
  const clock = new TestBudgetClock(),
    f = await delegationBenchmarkFixture(true, clock);
  let launches = 0;
  try {
    await f.bindAndEnd();
    const profile = f.service['options'].config.profiles[0];
    fs.writeFileSync(join(f.root, 'delegate.json'), JSON.stringify({ version: 1, profiles: [profile] }), {
      mode: 0o600,
    });
    const { DelegationService: CompiledService } = await mcpModule('delegation');
    const args = [
      'resume',
      'link-a',
      '--request-key',
      'p065-compiled',
      '--expected-run',
      'run-a',
      '--mode',
      'headless',
    ];
    const values: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const b = clock.budget();
      clock.advance(9);
      await runCommand(
        args,
        f.root,
        {
          env: { HUD_HOME: f.root },
          stdout: async (text) => {
            values.push(JSON.parse(text));
          },
          stderr: async () => {},
        },
        {
          budget: b,
          capability: { verify: () => ({ ok: true, reason: null }) },
          resumeService: (options) => {
            assert.equal(options.callBudget, b);
            assert.equal(options.callBudget.remaining(), 21);
            assert.equal(options.localBinding.home, f.root);
            return new CompiledService({
              ...options,
              launch: async () => {
                launches++;
                return { pid: 123, completion: Promise.resolve({ code: 0, signal: null }) };
              },
            } as typeof options);
          },
        }
      );
    }
    assert.deepEqual(values[0], values[1]);
    assert.equal(launches, 1);
  } finally {
    await f.service.close();
    await f.close();
  }
});

test('P065 CLI proof from opening refuses unchanged-SQL chmod after opening rather than repinning', async () => {
  const { delegationBenchmarkFixture } = await import('./b45-delegation-fixture.js');
  const { runCommand } = await import('../../src/cli/run.js');
  const { mcpModule } = await import('../../src/cli/runtime.js');
  const { TestBudgetClock } = await import('./p065-budget-fixture.js');
  const clock = new TestBudgetClock(),
    f = await delegationBenchmarkFixture(true, clock);
  try {
    await f.bindAndEnd();
    fs.writeFileSync(
      join(f.root, 'delegate.json'),
      JSON.stringify({ version: 1, profiles: f.service['options'].config.profiles }),
      { mode: 0o600 }
    );
    const { DelegationService: CompiledService } = await mcpModule('delegation');
    const before = f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM events')!.n);
    let dispatched = 0;
    await assert.rejects(
      runCommand(
        ['resume', 'link-a', '--request-key', 'p065-unsafe-compiled', '--expected-run', 'run-a', '--mode', 'headless'],
        f.root,
        {
          env: {},
          stdout: async () => assert.fail('unsafe accepted'),
          stderr: async () => {},
        },
        {
          budget: clock.budget(),
          capability: { verify: () => ({ ok: true, reason: null }) },
          resumeService: (options) => {
            chmodSync(f.root, 0o755);
            return new CompiledService({
              ...options,
              launch: async () => {
                dispatched++;
                return { pid: 123, completion: Promise.resolve({ code: 0, signal: null }) };
              },
            } as typeof options);
          },
        }
      ),
      /local_store_proof_failed/
    );
    assert.equal(dispatched, 0);
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM events')!.n),
      before
    );
  } finally {
    chmodSync(f.root, 0o700);
    await f.service.close();
    await f.close();
  }
});

for (const stage of ['queue', 'backoff', 'acquired'] as const)
  test(`P065 unchanged-SQL privacy mutation at ${stage} refuses original binding before body`, async () => {
    const f = await budgetFixture();
    const { DatabaseSync } = await import('node:sqlite');
    const binding = new PrivateLedgerGate(f.home).bind(f.ledger);
    let blocker: InstanceType<typeof DatabaseSync> | undefined;
    let changed = false,
      body = 0,
      rollbacks = 0;
    const mutate = () => {
      if (!changed) {
        chmodSync(f.home, 0o755);
        changed = true;
      }
    };
    try {
      if (stage === 'backoff') {
        blocker = new DatabaseSync(f.file);
        blocker.exec('BEGIN IMMEDIATE');
        f.clock.sleep = async (ms) => {
          f.clock.advance(ms);
          mutate();
          blocker!.exec('ROLLBACK');
        };
      }
      f.db.exec = (sql: string) => {
        f.exec(sql);
        if (sql === 'BEGIN IMMEDIATE' && stage === 'acquired') mutate(); // Explicit fixture adversary, not production I/O.
        if (sql === 'ROLLBACK') rollbacks++;
      };
      const b = f.clock.budget();
      const operation = f.ledger.transaction((tx) => {
        binding.check(f.ledger, actor(), b);
        body++;
        tx.run('UPDATE callers SET last_seen_at=3');
      }, b);
      if (stage === 'queue') mutate();
      await assert.rejects(operation, LocalStoreProofFailed);
      assert.equal(body, 0);
      assert.equal(rollbacks, 1);
      assert.equal(f.db.prepare('SELECT last_seen_at FROM callers').get()!.last_seen_at, 1000);
      chmodSync(f.home, 0o700);
      await assert.rejects(
        f.ledger.transaction(() => binding.check(f.ledger, actor(), f.clock.budget()), f.clock.budget()),
        LocalStoreProofFailed
      );
    } finally {
      blocker?.close();
      chmodSync(f.home, 0o700);
      await f.close();
    }
  });

for (const defect of ['wrong-owner', 'nonregular', 'eacces', 'uid-euid'] as const)
  test(`P065 ${defect} metadata observation fails closed and is not treated as absent`, async () => {
    const f = await budgetFixture();
    const binding = new PrivateLedgerGate(f.home).bind(f.ledger);
    const original = fs.lstatSync,
      originalEuid = process.geteuid;
    try {
      if (defect === 'uid-euid') process.geteuid = () => process.getuid!() + 1;
      else
        Object.defineProperty(fs, 'lstatSync', {
          value: (path: fs.PathLike, ...rest: unknown[]) => {
            if (String(path) !== f.file + '-wal') return (original as Function)(path, ...rest);
            if (defect === 'eacces') throw Object.assign(new Error('synthetic_denied'), { code: 'EACCES' });
            const stat = Object.create((original as Function)(path, ...rest));
            if (defect === 'wrong-owner') Object.defineProperty(stat, 'uid', { value: process.getuid!() + 1 });
            else stat.isFile = () => false;
            return stat;
          },
        });
      syncBuiltinESMExports();
      await assert.rejects(
        f.ledger.transaction(() => binding.check(f.ledger, actor(), f.clock.budget()), f.clock.budget()),
        LocalStoreProofFailed
      );
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: original });
      process.geteuid = originalEuid;
      syncBuiltinESMExports();
      await f.close();
    }
  });

test('P065 CLI original-opening binding refuses equivalent-SQL inode swap before canonical replay', async () => {
  const { delegationBenchmarkFixture } = await import('./b45-delegation-fixture.js');
  const { runCommand } = await import('../../src/cli/run.js');
  const { mcpModule } = await import('../../src/cli/runtime.js');
  const { TestBudgetClock } = await import('./p065-budget-fixture.js');
  const clock = new TestBudgetClock(),
    f = await delegationBenchmarkFixture(true, clock);
  const file = join(f.root, 'ledger.sqlite'),
    saved = file + '.original';
  let replaced = false,
    launches = 0;
  try {
    await f.bindAndEnd();
    fs.writeFileSync(
      join(f.root, 'delegate.json'),
      JSON.stringify({ version: 1, profiles: f.service['options'].config.profiles }),
      { mode: 0o600 }
    );
    const { DelegationService: CompiledService } = await mcpModule('delegation');
    const command = [
      'resume',
      'link-a',
      '--request-key',
      'p065-original-pin',
      '--expected-run',
      'run-a',
      '--mode',
      'headless',
    ];
    const values: unknown[] = [];
    const io = {
      env: {},
      stdout: async (text: string) => {
        values.push(JSON.parse(text));
      },
      stderr: async () => {},
    };
    await runCommand(command, f.root, io, {
      budget: clock.budget(),
      capability: { verify: () => ({ ok: true, reason: null }) },
      resumeService: (supplied) =>
        new CompiledService({
          ...supplied,
          launch: async () => {
            launches++;
            return { pid: 123, completion: Promise.resolve({ code: 0, signal: null }) };
          },
        } as typeof supplied),
    });
    assert.equal(values.length, 1);
    assert.equal(launches, 1);
    f.ledger['db'].exec('PRAGMA wal_checkpoint(FULL)');
    await assert.rejects(
      runCommand(command, f.root, io, {
        budget: clock.budget(),
        capability: { verify: () => ({ ok: true, reason: null }) },
        resumeService: (supplied) => {
          renameSync(file, saved);
          copyFileSync(saved, file);
          chmodSync(file, 0o600);
          replaced = true;
          return new CompiledService({
            ...supplied,
            launch: async () => assert.fail('duplicate launch'),
          } as typeof supplied);
        },
      }),
      /local_store_proof_failed/
    );
    assert.equal(values.length, 1);
    assert.equal(launches, 1);
  } finally {
    if (replaced) {
      unlinkSync(file);
      renameSync(saved, file);
    }
    await f.service.close();
    await f.close();
  }
});

test('P065 typed local actor does not accept coercible invocation identifiers or manager aliases', async () => {
  const f = await budgetFixture();
  try {
    for (const changes of [
      { invocationId: undefined },
      { invocationId: 123 },
      { kind: 'trusted_local' },
      { admin: true },
    ]) {
      const binding = new PrivateLedgerGate(f.home).bind(f.ledger);
      const b = f.clock.budget();
      await assert.rejects(
        f.ledger.transaction(() => {
          binding.check(f.ledger, { ...actor(), ...changes } as IntentAuthority, b);
          assert.fail('invalid actor entered body');
        }, b),
        LocalStoreProofFailed
      );
    }
  } finally {
    await f.close();
  }
});

test('P065 a serialized local binding refuses before authority and starts no rejection audit', async () => {
  const f = await budgetFixture();
  try {
    const serialized = JSON.parse(JSON.stringify(new PrivateLedgerGate(f.home).bind(f.ledger)));
    const original = f.ledger.transaction.bind(f.ledger);
    let attempts = 0;
    f.ledger.transaction = (callback, budget) => {
      attempts++;
      return original(callback, budget);
    };
    await assert.rejects(
      acceptIntent(f.ledger, { ...f.input, authority: actor() }, f.clock.budget(), serialized),
      LocalStoreProofFailed
    );
    assert.equal(attempts, 1);
    assert.equal(f.count('events'), 0);
    assert.equal(f.count('runs'), 0);
  } finally {
    await f.close();
  }
});
