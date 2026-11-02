import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ledgerReadRuntimeSupported } from '../../src/core/ledger-read.js';
import { openLedger } from '../../src/ledger/ledger.js';
import { requireLedgerRuntime, verifyReadOnlyCapability } from '../../src/ledger/runtime.js';
import { SCHEMA_V1_DDL } from '../../src/ledger/schema.js';

const skip = ledgerReadRuntimeSupported()
  ? false
  : `Ledger requires Node 22.x >=22.13 or >=24 (23 unsupported); found ${process.versions.node}`;

test('ledger schema v1 is byte-for-byte the frozen contract SQL block', () => {
  const contract = readFileSync('docs/contracts/02-execution.md', 'utf8');
  const blocks = [...contract.matchAll(/```sql\n([\s\S]*?)```/g)];
  assert.equal(blocks.length, 1);
  assert.equal(Buffer.compare(Buffer.from(SCHEMA_V1_DDL), Buffer.from(blocks[0][1])), 0);
  assert.equal((SCHEMA_V1_DDL.match(/CREATE TABLE /g) ?? []).length, 16);
});

test('ledger runtime floor is explicit and does not raise the bar runtime', () => {
  for (const version of ['18.20.0', '20.12.0', '22.4.9', '22.5.0', '22.12.0', '23.11.0'])
    assert.throws(() => requireLedgerRuntime(version), /requires Node 22.x >=22.13/);
  for (const version of ['22.13.0', '22.99.0', '24.22.1', '25.0.0']) requireLedgerRuntime(version);
});

test('ledger native readOnly capability probe rejects ignored flags using memory only', { skip }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  verifyReadOnlyCapability(DatabaseSync);
  class IgnoresReadOnly extends DatabaseSync {
    constructor(path: string) {
      assert.equal(path, ':memory:');
      super(path);
    }
  }
  assert.throws(() => verifyReadOnlyCapability(IgnoresReadOnly), /requested path was not opened/);
});

test('ledger initialize, reopen, WAL recovery and backup preserve private ledgerId', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-ledger-schema-'));
  try {
    const path = join(dir, 'ledger.sqlite');
    const first = await openLedger(path);
    const id = first.ledgerId;
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(first.checkIntegrity(), { integrity: ['ok'], foreignKeys: [] });
    const pragmas = first.snapshot((tx) => [
      tx.get('PRAGMA user_version')?.user_version,
      tx.get('PRAGMA journal_mode')?.journal_mode,
      tx.get('PRAGMA foreign_keys')?.foreign_keys,
      tx.get('PRAGMA busy_timeout')?.timeout,
    ]);
    assert.deepEqual(pragmas, [1, 'wal', 1, 0]);
    for (const sql of [
      "UPDATE ledger_metadata SET ledger_id='replacement'",
      'DELETE FROM ledger_metadata',
      "INSERT INTO ledger_metadata VALUES(1,'second')",
      "INSERT OR REPLACE INTO ledger_metadata VALUES(1,'replace')",
    ])
      await assert.rejects(
        first.transaction((tx) => tx.run(sql)),
        /immutable|already initialized/
      );
    await first.close();
    const reopened = await openLedger(path);
    assert.equal(reopened.ledgerId, id);
    await reopened.close();
    const restoredPath = join(dir, 'restore.sqlite');
    copyFileSync(path, restoredPath);
    const restored = await openLedger(restoredPath);
    assert.equal(restored.ledgerId, id);
    assert.deepEqual(restored.checkIntegrity(), { integrity: ['ok'], foreignKeys: [] });
    await restored.close();
    const independent = await openLedger(join(dir, 'independent.sqlite'));
    assert.notEqual(independent.ledgerId, id);
    await independent.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger rejects unknown or populated unversioned schema without replacing metadata', { skip }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'hud-ledger-version-'));
  try {
    const path = join(dir, 'future.sqlite');
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE future(value); INSERT INTO future VALUES('retained'); PRAGMA user_version=2");
    await assert.rejects(openLedger(path), /unsupported_ledger_version:2/);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.equal(db.prepare('SELECT value FROM future').get()?.value, 'retained');
    db.exec('PRAGMA user_version=0');
    await assert.rejects(openLedger(path), /unversioned_nonempty_ledger/);
    assert.equal(db.prepare('SELECT value FROM future').get()?.value, 'retained');
    db.close();
    const memory = await openLedger(':memory:');
    assert.deepEqual(memory.checkIntegrity(), { integrity: ['ok'], foreignKeys: [] });
    await memory.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
