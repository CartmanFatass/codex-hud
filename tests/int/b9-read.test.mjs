import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { ledgerReadRuntimeSupported } from '../../dist/core/ledger-read.js';
import { openLinkLedgerReader } from '../../dist/core/link-ledger-read.js';
import { projectLinkTree } from '../../dist/core/link/index.js';
import { fixture, hash, launchEvidence } from './b9-fixture.mjs';

const skip = ledgerReadRuntimeSupported() ? false : 'B9 ledger tests require Node 22.x >=22.13 or >=24';

test('B9 all table reads and ledger high-water stay in one snapshot across a concurrent commit', { skip }, async () => {
  const f = await fixture();
  try {
    const result = spawnSync(process.execPath, ['tests/int/b9-snapshot-race.mjs', f.path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /snapshot race: passed/);
  } finally {
    f.cleanup();
  }
});

test('B9 read adapter compares claim fingerprints in one snapshot without exposing them', { skip }, async () => {
  const f = await fixture();
  const reader = await openLinkLedgerReader(f.path);
  try {
    const result = reader.read([launchEvidence(), { ...launchEvidence(), claimFingerprint: hash('wrong') }]);
    assert.equal(result.state, 'available');
    assert.deepEqual(
      result.claimChecks.map((c) => c.result),
      ['verified', 'mismatch']
    );
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(hash('claim-a')), 'claim fingerprint must stay inside the adapter');
    assert.ok(!serialized.includes('claimHash'));
    assert.ok(!serialized.includes('launchTokenHash'));
    assert.equal(result.snapshot.links.length, 1);
    assert.equal(result.snapshot.asOfSeq, 2);
  } finally {
    reader.close();
    f.cleanup();
  }
});

test('B9 missing ledger degrades without creating a database', { skip }, async () => {
  const f = await fixture({ links: 0 });
  const path = join(f.home, 'missing.sqlite');
  const reader = await openLinkLedgerReader(path);
  try {
    const result = reader.read();
    assert.equal(result.state, 'degraded');
    assert.equal(projectLinkTree({ ledger: result, roots: [], sessions: [], nowMs: 12000 }).ledger.asOfSeq, null);
    assert.equal(existsSync(path), false);
  } finally {
    reader.close();
    f.cleanup();
  }
});

test('B9 schema mismatch degrades without migrating', { skip }, async () => {
  const f = await fixture();
  f.db.exec('PRAGMA user_version=2');
  const before = readFileSync(f.path);
  const reader = await openLinkLedgerReader(f.path);
  try {
    const result = reader.read();
    assert.equal(result.state, 'degraded');
    assert.equal(result.reason, 'ledger_unsupported_schema');
    assert.equal(projectLinkTree({ ledger: result, roots: [], sessions: [], nowMs: 12000 }).ledger.state, 'degraded');
    assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.deepEqual(readFileSync(f.path), before);
  } finally {
    reader.close();
    f.cleanup();
  }
});

test('B9 busy ledger degrades immediately and recovers on the next snapshot', { skip }, async () => {
  const f = await fixture();
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
  const reader = await openLinkLedgerReader(f.path);
  try {
    f.db.exec('BEGIN EXCLUSIVE');
    const result = reader.read();
    assert.equal(result.state, 'degraded');
    assert.equal(result.reason, 'ledger_busy');
    assert.equal(projectLinkTree({ ledger: result, roots: [], sessions: [], nowMs: 12000 }).ledger.state, 'degraded');
    f.db.exec('ROLLBACK');
    assert.equal(reader.read().state, 'available');
  } finally {
    if (f.db.isTransaction) f.db.exec('ROLLBACK');
    reader.close();
    f.cleanup();
  }
});

test(
  'B9 full projection leaves ledger hash and data_version unchanged and opens zero writer connections',
  { skip },
  async () => {
    const f = await fixture();
    try {
      f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const before = readFileSync(f.path);
      const walBefore = readFileSync(`${f.path}-wal`);
      const version = f.db.prepare('PRAGMA data_version').get().data_version;
      const run = spawnSync(process.execPath, ['tests/int/b9-read-audit.mjs', f.path], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const audit = JSON.parse(run.stdout);
      assert.equal(audit.state, 'available');
      assert.ok(audit.opens.length >= 2);
      assert.ok(audit.opens.every((o) => o.readOnly));
      assert.equal(audit.readStatements, 11, 'fixed schema/metadata/high-water plus eight bulk table reads');
      assert.deepEqual(readFileSync(f.path), before);
      assert.deepEqual(readFileSync(`${f.path}-wal`), walBefore);
      assert.equal(f.db.prepare('PRAGMA data_version').get().data_version, version);
    } finally {
      f.cleanup();
    }
  }
);
