import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { queryDelegationExport } from '../../src/core/export-query.js';
import { EXPORT_LIMITS } from '../../src/core/export.js';
import { exportFixture } from '../fixtures/export/ledger.js';
const entry = resolve('tests/fixtures/export/entry.mjs');

test(
  'B18 10001-run scope refuses without partial stdout; explicit smaller scope succeeds',
  { skip: runtimeSkip },
  async () => {
    const records = Array.from({ length: 10001 }, (_, i) => ({ ...base, linkId: `link-${i}`, runId: `run-${i}` }));
    const fixture = await exportFixture(records);
    try {
      assert.deepEqual(await queryDelegationExport(fixture.home, { schemaVersion: 1 }), {
        ok: false,
        reason: 'export_record_budget_exceeded',
      });
      const command = spawnSync(process.execPath, [entry, 'export', fixture.home], { encoding: 'utf8' });
      assert.equal(command.status, 1);
      assert.equal(command.stdout, '');
      assert.match(command.stderr, /export_record_budget_exceeded/);
      const scoped = await queryDelegationExport(fixture.home, {
        schemaVersion: 1,
        scope: { kind: 'links', linkIds: ['link-0'] },
      });
      assert.ok(scoped.ok, JSON.stringify(scoped));
      assert.equal(scoped.value.recordCount, 1);
      assert.equal(scoped.value.envelope.asOfSeq, 10001);
    } finally {
      await fixture.cleanup();
    }
  }
);

test(
  'B18 byte budget: exactly 16 MiB succeeds, one byte over fails with empty stdout',
  { skip: benchmarkSkip },
  async () => {
    const initial = await exportFixture([base]);
    let filler: number;
    try {
      const measured = await queryDelegationExport(initial.home, { schemaVersion: 1, paths: 'local' });
      assert.ok(measured.ok);
      filler = EXPORT_LIMITS.bytes - measured.value.bytes;
    } finally {
      await initial.cleanup();
    }
    for (const excess of [0, 1]) {
      const fixture = await exportFixture([{ ...base, launchCwd: base.launchCwd + 'x'.repeat(filler + excess) }]);
      try {
        const result = await queryDelegationExport(fixture.home, { schemaVersion: 1, paths: 'local' });
        if (excess === 0) {
          assert.ok(result.ok, JSON.stringify(result));
          assert.equal(result.value.bytes, EXPORT_LIMITS.bytes);
        } else {
          assert.deepEqual(result, { ok: false, reason: 'export_byte_budget_exceeded' });
          const command = spawnSync(
            process.execPath,
            [entry, 'export', fixture.home, '{"schemaVersion":1,"paths":"local"}'],
            { encoding: 'utf8' }
          );
          assert.equal(command.status, 1);
          assert.equal(command.stdout, '');
          assert.match(command.stderr, /export_byte_budget_exceeded/);
        }
        const noPaths = await queryDelegationExport(fixture.home, { schemaVersion: 1 });
        assert.ok(noPaths.ok);
        assert.equal(Object.hasOwn(noPaths.value.envelope.records[0], 'launchCwd'), false);
      } finally {
        await fixture.cleanup();
      }
    }
  }
);
import { runtimeSkip, benchmarkSkip, base } from '../fixtures/b18-budgets-perf.js';

test(
  'semantic residue: small export reports complete records and exact encoded byte count',
  { skip: runtimeSkip },
  async () => {
    const fixture = await exportFixture([base, { ...base, linkId: 'link-2', runId: 'run-2' }]);
    try {
      const result = await queryDelegationExport(fixture.home, { schemaVersion: 1 });
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.value.recordCount, 2);
      assert.equal(result.value.envelope.coverage.recordCount, 2);
      assert.equal(result.value.bytes, Buffer.byteLength(result.value.json));
      assert.ok(result.value.bytes <= EXPORT_LIMITS.bytes);
    } finally {
      await fixture.cleanup();
    }
  }
);
