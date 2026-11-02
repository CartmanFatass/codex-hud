import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { notifyFixture, retire, factEvidence, completion } from './b21-fixture.js';
import * as notify from '../../src/ledger/notify-events.js';
import { insertRecord } from '../../src/ledger/records.js';
import { readDelegationIn } from '../../src/ledger/delegation-read.js';
import { readReconcileSnapshot, commitReconcile } from '../../src/ledger/reconcile.js';
import { ReadControlService } from '../../packages/hud-mcp/src/read-control.js';
import { openLedgerReader } from '../../src/core/ledger-read.js';
import { queryDelegationExport } from '../../src/core/export-query.js';
import { decodeDelegationExport } from '../../src/core/export.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { goldenExportInput } from '../fixtures/contracts/observation-export.js';
import { serializeDelegationExport } from '../../src/core/export.js';
const opts = { skip: !ledgerRuntimeSupported() };
test(
  'B21 D15 mixed events.v1.1 and unknown kinds remain opaque to status, fixed-run wait, B16 inputs, export and reconcile',
  opts,
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    const before = f.ledger.snapshot((tx) => ({
      run: tx.get("SELECT * FROM runs WHERE run_id='run-a'"),
      link: tx.get("SELECT * FROM links WHERE link_id='link-a'"),
    }));
    const afterSeq = f.ledger.snapshot((tx) => Number(tx.get('SELECT max(seq) AS n FROM events')!.n));
    await f.ledger.transaction((tx) => {
      const seq = notify.recordWakeRegistered(tx, 'link-a', f.registration, 1020);
      notify.recordWakeDelivered(
        tx,
        'link-a',
        { registrationSeq: seq, throughSeq: seq, result: 'accepted', attempt: 1 },
        1020
      );
      notify.recordWakeRevoked(tx, 'link-a', { registrationSeq: seq, reason: 'generation_changed' }, 1020);
      notify.recordRetireRequested(tx, 'run-a', retire, 1020);
      notify.recordSurfaceCreated(
        tx,
        'run-a',
        {
          locator: {
            kind: 'tmux',
            server: 'synthetic',
            session: 'synthetic',
            pane: '%1',
            process: f.meta.supervisor,
            runId: 'run-a',
            bindingGeneration: 1,
          },
          occupantGeneration: 9,
        },
        1020
      );
      notify.recordHandoff(tx, 'link-a', { sha256: 'b'.repeat(64), bytes: 100, retained: true }, 1020);
      insertRecord(tx, 'events', {
        runId: 'run-a',
        linkId: 'link-a',
        kind: 'future.opaque',
        payload: { state: 'cancelled', terminalNote: 'free text' },
        at: 1020,
      });
    });
    const service = new ReadControlService(f.ledger, f.root);
    t.after(() => service.close());
    const status = await service.status({ runId: 'run-a' }, () => f.parent.authority);
    assert.equal(status.currentRun.state, before.run!.state);
    assert.equal(status.link.state, before.link!.state);
    const waited = await service.wait(
      { runId: 'run-a', afterSeq, until: ['report', 'run_terminal', 'uncertain'], timeoutMs: 0 },
      () => f.parent.authority,
      { clientToolTimeoutMs: 1000, responseMarginMs: 100, verified: true }
    );
    assert.equal(waited.matched, false);
    assert.ok(waited.events.some((e) => e.kind === 'future.opaque'));
    assert.equal(
      waited.events.filter((e) => e.kind.startsWith('wake.')).length,
      0,
      'link-only events do not satisfy fixed-run wait'
    );
    const reader = await openLedgerReader(join(f.root, 'ledger.sqlite'));
    try {
      const input = reader.snapshot();
      assert.ok(input.events.some((e) => e.kind === 'future.opaque'));
      assert.equal(input.runs[0].state, before.run!.state);
      assert.equal(input.links[0].state, before.link!.state);
    } finally {
      reader.close();
    }
    assert.deepEqual(
      f.ledger.snapshot((tx) => ({
        run: tx.get("SELECT * FROM runs WHERE run_id='run-a'"),
        link: tx.get("SELECT * FROM links WHERE link_id='link-a'"),
      })),
      before
    );
    const end = await commitReconcile(
      f.ledger,
      readReconcileSnapshot(f.ledger, 'run-a'),
      [factEvidence(f, 'done', completion, 1050)],
      1060
    );
    assert.ok(end.committed);
    assert.equal(end.decision.state, 'ended');
    const terminal = await service.status({ runId: 'run-a' }, () => f.parent.authority);
    assert.equal(terminal.terminalNote, 'retire_timing_unknown');
    assert.equal(terminal.termination?.requestedCause, 'retire_after_report');
    for (const paths of ['none', 'local'] as const) {
      const exported = await queryDelegationExport(f.root, { schemaVersion: 1, paths });
      assert.ok(exported.ok);
      if (!exported.ok) continue;
      const parsed = decodeDelegationExport(JSON.parse(exported.value.json));
      assert.ok(parsed.ok);
      if (!parsed.ok) continue;
      assert.equal(parsed.value.records[0].terminalNote, 'retire_timing_unknown');
      assert.ok(!exported.value.json.includes('codexHome'));
      assert.ok(!exported.value.json.includes('free text'));
    }
    const snapshot = readReconcileSnapshot(f.ledger, 'run-a');
    assert.equal(snapshot.terminalNote, 'retire_timing_unknown');
    const again = await commitReconcile(f.ledger, snapshot, [], 1070);
    assert.ok(again.committed);
    assert.equal(again.decision.row, 'R-02-0');
    await f.ledger.transaction((tx) =>
      tx.run("UPDATE events SET payload=json_set(payload,'$.terminalNote','future_note') WHERE kind='run.terminal'")
    );
    assert.equal(
      f.ledger.snapshot((tx) => readDelegationIn(tx, { runId: 'run-a' }, f.parent.authority)).terminalNote,
      null
    );
    assert.equal(readReconcileSnapshot(f.ledger, 'run-a').terminalNote, null);
  }
);
test('B21 export v1 optional closed terminalNote preserves absence/null, recognizes both codes, normalizes unknown strings, rejects nonstrings', () => {
  for (const paths of ['none', 'local'] as const) {
    const golden = goldenExportInput();
    const encoded = serializeDelegationExport({ ...golden, paths }, { readElapsedMs: 0, assemblyElapsedMs: 0 });
    assert.ok(encoded.ok);
    if (!encoded.ok) continue;
    const base: any = JSON.parse(encoded.value.json);
    for (const note of ['cancel_timing_unknown', 'retire_timing_unknown', null, 'future_note', 'private prose']) {
      const copy = structuredClone(base);
      copy.records[0].terminalNote = note;
      const result = decodeDelegationExport(copy);
      assert.ok(result.ok);
      if (!result.ok) continue;
      assert.equal(
        result.value.records[0].terminalNote,
        note === 'cancel_timing_unknown' || note === 'retire_timing_unknown' ? note : null
      );
    }
    for (const note of [true, 1, {}, []]) {
      const copy = structuredClone(base);
      copy.records[0].terminalNote = note;
      assert.equal(decodeDelegationExport(copy).ok, false);
    }
    const decoded = decodeDelegationExport(base);
    assert.ok(decoded.ok);
    if (decoded.ok) assert.equal(Object.hasOwn(decoded.value.records[0], 'terminalNote'), false);
  }
});
