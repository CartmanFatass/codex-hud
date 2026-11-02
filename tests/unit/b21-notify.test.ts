import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as notify from '../../src/ledger/notify-events.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import type { LedgerTransaction } from '../../src/ledger/transaction.js';

import { notifyFixture, retire } from './b21-fixture.js';

test(
  'B21 events.v1.1 strict whitelist: each new kind accepts valid payload and rejects extra keys, text, enum and stamp defects atomically',
  { skip: !ledgerRuntimeSupported() },
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    const reg = await f.ledger.transaction((tx) => notify.recordWakeRegistered(tx, 'link-a', f.registration, 1020));
    const cases: Array<{
      name: string;
      write: (tx: LedgerTransaction, p: any, at?: number) => number;
      valid: any;
      invalid: any[];
    }> = [
      {
        name: 'wake.registered',
        write: (tx, p, at = 1020) => notify.recordWakeRegistered(tx, 'link-a', p, at),
        valid: f.registration,
        invalid: [
          { ...f.registration, adapter: 'free text' },
          { ...f.registration, parentStamp: { pid: 1, proc_start: 'x', boot_id: 'boot', pid_domain: 'domain' } },
          { ...f.registration, adapter: 'none', target: {}, reason: 'free text' },
          { ...f.registration, target: { codexHome: f.root, threadId: 'wrong' } },
        ],
      },
      {
        name: 'wake.revoked',
        write: (tx, p, at = 1020) => notify.recordWakeRevoked(tx, 'link-a', p, at),
        valid: { registrationSeq: reg, reason: 'generation_changed' },
        invalid: [
          { registrationSeq: reg, reason: 'free text' },
          { registrationSeq: 0, reason: 'link_closed' },
          { registrationSeq: reg, reason: 'WRONG' },
        ],
      },
      {
        name: 'wake.delivered',
        write: (tx, p, at = 1020) => notify.recordWakeDelivered(tx, 'link-a', p, at),
        valid: { registrationSeq: reg, throughSeq: reg, result: 'accepted', attempt: 1 },
        invalid: [
          { registrationSeq: reg, throughSeq: reg, result: 'rejected', attempt: 1, reason: 'free text' },
          { registrationSeq: reg, throughSeq: reg, result: 'unknown', attempt: 3 },
          { registrationSeq: reg, throughSeq: reg, result: 'unknown', attempt: 2 },
          { registrationSeq: reg, throughSeq: reg, result: 'wait_return', attempt: 1 },
        ],
      },
      {
        name: 'retire.requested',
        write: (tx, p, at = 1020) => notify.recordRetireRequested(tx, 'run-a', p, at),
        valid: retire,
        invalid: [
          { ...retire, cause: 'free text' },
          { ...retire, cause: ['retire_after_report'] },
          { ...retire, cause: {} },
          { ...retire, cause: 1 },
          { ...retire, rule: ['after_report'] },
          { ...retire, rule: 'idle' },
          { ...retire, cause: 'retire_idle' },
          { ...retire, actor: { kind: 'user' } },
          { ...retire, graceMs: 60001 },
          { ...retire, eligibility: { ...retire.eligibility, newerWorkChecked: false } },
        ],
      },
      {
        name: 'surface.created',
        write: (tx, p, at = 1020) => notify.recordSurfaceCreated(tx, 'run-a', p, at),
        valid: {
          locator: {
            kind: 'tmux',
            server: 'synthetic-server',
            session: 'synthetic-session',
            pane: '%1',
            process: f.meta.supervisor,
            runId: 'run-a',
            bindingGeneration: 1,
          },
          occupantGeneration: 7,
        },
        invalid: [
          { locator: { kind: 'free text' }, occupantGeneration: 1 },
          {
            locator: {
              kind: 'tmux',
              server: 'synthetic',
              session: 'synthetic',
              pane: '%1',
              process: { ...f.meta.supervisor, pid: -1 },
              runId: 'run-a',
              bindingGeneration: 1,
            },
            occupantGeneration: 1,
          },
        ],
      },
      {
        name: 'handoff.recorded',
        write: (tx, p, at = 1020) => notify.recordHandoff(tx, 'link-a', p, at),
        valid: { sha256: 'a'.repeat(64), bytes: 12, retained: true, fromLinkId: 'synthetic-prior' },
        invalid: [
          { sha256: 'free text', bytes: 12, retained: true },
          { sha256: 'a'.repeat(64), bytes: -1, retained: true },
          { sha256: 'a'.repeat(64), bytes: 12, retained: false },
        ],
      },
    ];
    for (const c of cases) {
      for (const p of [{ ...c.valid, summary: 'untrusted prose' }, ...c.invalid]) {
        const before = f.ledger.snapshot((tx) => Number(tx.get('SELECT count(*) AS n FROM events')!.n));
        await assert.rejects(
          f.ledger.transaction((tx) => c.write(tx, p)),
          { name: 'TypeError' },
          c.name
        );
        assert.equal(
          f.ledger.snapshot((tx) => Number(tx.get('SELECT count(*) AS n FROM events')!.n)),
          before,
          c.name
        );
      }
      await assert.rejects(
        f.ledger.transaction((tx) => c.write(tx, c.valid, -1)),
        /notify_payload_invalid/,
        c.name + ' bad event timestamp'
      );
      await assert.rejects(
        f.ledger.transaction((tx) => c.write(tx, c.valid, Date.now() + 60000)),
        /notify_payload_invalid/
      );
      const seq = await f.ledger.transaction((tx) => c.write(tx, c.valid));
      const row = f.ledger.snapshot((tx) => tx.get('SELECT * FROM events WHERE seq=?', seq)!);
      assert.equal(row.kind, c.name);
      assert.equal(row.link_id, 'link-a');
      assert.equal(row.run_id, ['retire.requested', 'surface.created'].includes(c.name) ? 'run-a' : null);
    }
    for (const p of [
      { registrationSeq: reg, throughSeq: reg, result: 'wait_return' },
      { registrationSeq: reg, throughSeq: reg, result: 'rejected', attempt: 1, reason: 'stale_session' },
      { registrationSeq: reg, throughSeq: reg, result: 'unknown', attempt: 1 },
      { registrationSeq: reg, throughSeq: reg, result: 'unknown', attempt: 2, exhausted: true },
    ])
      await f.ledger.transaction((tx) => notify.recordWakeDelivered(tx, 'link-a', p as notify.WakeDelivery, 1020));
  }
);

test(
  'B21 shared wake-worthy predicate accepts all report outcomes, terminal states and linked uncertainty only',
  { skip: !ledgerRuntimeSupported() },
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    const { reportFor } = await import('./b21-fixture.js');
    for (const status of ['completed', 'failed', 'blocked', 'interrupted'] as const) {
      await reportFor(f, status);
      const event = f.ledger.snapshot((tx) => {
        const row = tx.get("SELECT * FROM events WHERE kind='report.received' ORDER BY seq DESC LIMIT 1")!;
        return {
          kind: String(row.kind),
          linkId: String(row.link_id),
          runId: String(row.run_id),
          payload: JSON.parse(String(row.payload)),
        };
      });
      assert.equal(notify.isWakeWorthyEvent(event), true, status);
    }
    const base = { linkId: 'link-a', runId: 'run-a' };
    for (const state of ['ended', 'failed', 'cancelled'])
      assert.equal(notify.isWakeWorthyEvent({ ...base, kind: 'run.terminal', payload: { state } }), true);
    assert.equal(notify.isWakeWorthyEvent({ ...base, kind: 'run.state', payload: { state: 'uncertain' } }), true);
    const rejected: Array<Parameters<typeof notify.isWakeWorthyEvent>[0]> = [
      { ...base, kind: 'run.state', payload: { state: 'running' } },
      { ...base, kind: 'run.terminal', payload: { state: 'unknown' } },
      { ...base, kind: 'report.rejected', payload: { reportId: 'synthetic' } },
      { ...base, kind: 'report.received', payload: {} },
      { ...base, kind: 'supervisor.signal', payload: { signal: 'SIGINT' } },
      { ...base, kind: 'command.exited', payload: {} },
      { ...base, kind: 'native.agent_completed', payload: {} },
      { ...base, kind: 'wake.delivered', payload: {} },
      { ...base, kind: 'future.opaque', payload: { state: 'ended' } },
      { ...base, kind: 'run.state', payload: { state: 'uncertain' }, linkId: null },
      { ...base, kind: 'run.state', payload: { state: 'uncertain' }, runId: null },
    ];
    for (const event of rejected) assert.equal(notify.isWakeWorthyEvent(event), false, event.kind);
  }
);
