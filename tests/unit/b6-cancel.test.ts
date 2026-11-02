import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { processState } from '../../src/core/run/process.js';
const skip = !ledgerRuntimeSupported()
  ? 'B6 requires Node 22.x >=22.13 or >=24'
  : process.env.B6_PROCESS !== '1'
    ? 'Run B6_PROCESS=1 node --test dist-test/tests/unit/b6-cancel.test.js for the isolated real hud-run matrix'
    : false;
const helpers = () => import(pathToFileURL(resolve('tests/int/b6-real.mjs')).href);

test(
  'B6 real hud-run headless ladder consumes MCP intent; duplicate cancel keeps original grace/seq',
  { skip },
  async () => {
    const { realRun, until } = await helpers();
    const f = await realRun("process.on('SIGINT',()=>{});setTimeout(()=>{},60000)");
    try {
      await f.ready();
      const one = await f.service.cancel(f.input.runId, 0, f.authority);
      const two = await f.service.cancel(f.input.runId, 60000, f.authority);
      assert.equal(one.accepted, true);
      assert.equal(two.cancelRequestedAt, one.cancelRequestedAt);
      const end = await until(async () => {
        const s = await f.port.read(f.input.runId);
        return ['ended', 'cancelled'].includes(s.run.state) && s;
      }, 15000);
      assert.equal(end.slotHeld, false);
      const cancels = end.events.filter((e: any) => e.kind === 'cancel.accepted');
      assert.equal(cancels.length, 1);
      assert.equal(cancels[0].payload.graceMs, 0);
      assert.equal(cancels[0].payload.actor.kind, 'mcp');
      assert.ok(end.events.some((e: any) => e.kind === 'cancel.step' && e.payload.signal === 'SIGTERM'));
      assert.equal((await f.done).code, 0);
    } finally {
      await f.cleanup();
    }
  }
);

test('B6 cancel racing real natural exit cannot invent cancelled or already_ended evidence', { skip }, async () => {
  const { realRun, until } = await helpers();
  const f = await realRun('setTimeout(()=>{},900)');
  try {
    await f.ready();
    const result = await f.service.cancel(f.input.runId, 10, f.authority);
    assert.equal(result.accepted, true);
    // Natural exit precedes the next 5s heartbeat/control wake: chronology remains unknown.
    const s = await until(async () => {
      const s = await f.port.read(f.input.runId);
      return s.run.state === 'ended' && s;
    });
    assert.equal(s.status.terminalNote, 'cancel_timing_unknown');
    assert.equal(s.slotHeld, false);
    assert.equal(
      s.events.some((e: any) => e.kind === 'cancel.step'),
      false
    );
    assert.equal((await f.service.cancel(f.input.runId, 100, f.authority)).accepted, false);
  } finally {
    await f.cleanup();
  }
});

test(
  'B6 supervisor killed before cancel becomes uncertain and keeps slot, with no automatic child action',
  { skip },
  async () => {
    const { realRun, until } = await helpers();
    const f = await realRun();
    try {
      const running = await f.ready();
      f.child.kill('SIGKILL');
      await f.done;
      const accepted = await until(async () => {
        try {
          return await f.service.cancel(f.input.runId, 0, f.authority);
        } catch (error: any) {
          if (error.code === 'ledger_busy') return false;
          throw error;
        }
      });
      assert.equal(accepted.accepted, true);
      const s = await f.port.read(f.input.runId);
      assert.equal(s.run.state, 'uncertain');
      assert.equal(s.slotHeld, true);
      assert.equal(processState(running.meta.harness), 'alive');
      assert.equal(
        s.events.some((e: any) => e.kind === 'cancel.step'),
        false
      );
      assert.equal(s.events.filter((e: any) => e.kind === 'launch.submitting').length, 1);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'B6 visible real TTY hud-run cancellation honestly returns unavailable, unconfirmed and holds slot',
  { skip },
  async () => {
    const { visibleRun, until } = await helpers();
    const f = await visibleRun();
    try {
      const s = await f.ready();
      const result = await f.service.cancel(f.input.runId, 0, f.authority);
      assert.equal(result.code, 'visible_scope_control_unavailable');
      assert.equal(result.cancellation, 'unconfirmed');
      const refused = await until(async () => {
        const s = await f.port.read(f.input.runId);
        return s.events.some((e: any) => e.kind === 'cancel.unconfirmed') && s;
      }, 12000);
      assert.equal(refused.slotHeld, true);
      assert.equal(processState(s.meta.harness), 'alive');
      assert.ok(
        refused.events.some(
          (e: any) => e.kind === 'cancel.unconfirmed' && e.payload.reason === 'visible_scope_control_unavailable'
        )
      );
    } finally {
      await f.cleanup();
    }
  }
);

test('B6 old-format cancel.accepted without grace uses 10000ms, never NaN/immediate TERM', { skip }, async () => {
  const { realRun, until } = await helpers();
  const f = await realRun("process.on('SIGINT',()=>{});setTimeout(()=>{},60000)");
  try {
    await f.ready();
    await f.service.cancel(f.input.runId, 10000, f.authority);
    await f.ledger.transaction((tx: any) =>
      tx.run(
        "UPDATE events SET payload=json_remove(payload,'$.graceMs') WHERE run_id=? AND kind='cancel.accepted'",
        f.input.runId
      )
    );
    await until(
      async () => (await f.port.read(f.input.runId)).events.some((e: any) => e.kind === 'cancel.step'),
      12000
    );
    // Once SIGINT has been consumed, a missing grace must retain a live process for 10s.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const s = await f.port.read(f.input.runId);
    assert.equal(s.events.filter((e: any) => e.kind === 'cancel.step').length, 1);
    assert.equal(processState(s.meta.harness), 'alive');
  } finally {
    await f.cleanup();
  }
});

test(
  'B6 cancel budget exhausted after death reconciliation stops before intent with no late transaction',
  { skip },
  async () => {
    const { realRun } = await helpers();
    const f = await realRun();
    try {
      await f.ready();
      f.child.kill('SIGKILL');
      await f.done;
      let transactions = 0;
      const transaction = f.ledger.transaction.bind(f.ledger);
      f.ledger.transaction = async (callback: any, budget: number) => {
        transactions++;
        const result = await transaction(callback, budget);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return result;
      };
      await assert.rejects(
        f.service.cancel(f.input.runId, 0, f.authority),
        (error: any) => error.code === 'ledger_busy'
      );
      assert.equal(transactions, 1);
      const s = await f.port.read(f.input.runId);
      assert.equal(s.run.state, 'uncertain');
      assert.equal(s.run.cancelRequestedAt, null);
      assert.equal(
        s.events.some((e: any) => e.kind === 'cancel.accepted'),
        false
      );
      assert.equal(processState(s.meta.harness), 'alive');
    } finally {
      await f.cleanup();
    }
  }
);

test('B6 cancel refuses local resume authority before persisting a dead-supervisor observation', { skip }, async () => {
  const { realRun } = await helpers();
  const { refValue } = await import('../../src/ledger/records.js');
  const f = await realRun();
  try {
    await f.ready();
    f.child.kill('SIGKILL');
    await f.done;
    const ref = f.authority.evidence.sessionRef;
    await f.ledger.transaction((tx: any) => {
      tx.run(
        'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
        refValue(ref),
        ref.harness,
        ref.sourceId,
        ref.sessionId,
        ''
      );
      tx.run('UPDATE links SET parent_ref=? WHERE link_id=?', refValue(ref), f.prepared.link.linkId);
    });
    const before = await f.port.read(f.input.runId);
    await assert.rejects(
      f.service.cancel(f.input.runId, 0, {
        kind: 'local_user',
        uid: process.getuid!(),
        ownerUid: process.getuid!(),
        invocationId: 'synthetic-local-resume',
        hudHomeOwned: true,
        ledgerOwned: true,
        privatePaths: true,
      }),
      /unsupported/
    );
    const after = await f.port.read(f.input.runId);
    assert.equal(after.run.state, before.run.state);
    assert.deepEqual(after.facts, before.facts);
    assert.deepEqual(after.events, before.events);
  } finally {
    await f.cleanup();
  }
});

test('B6 replaced supervisor stamp never signals the live reused-PID process or releases slot', { skip }, async () => {
  const { realRun } = await helpers();
  const f = await realRun();
  try {
    const running = await f.ready();
    const oldStart = String(BigInt(running.run.supervisor.proc_start) - 1n);
    await f.ledger.transaction((tx: any) => {
      tx.run('UPDATE runs SET supervisor_proc_start=? WHERE run_id=?', oldStart, f.input.runId);
      tx.run('UPDATE claims SET supervisor_proc_start=? WHERE run_id=?', oldStart, f.input.runId);
      tx.run(
        "UPDATE events SET payload=json_set(payload,'$.supervisor.proc_start',?) WHERE run_id=? AND kind='supervisor.registered'",
        oldStart,
        f.input.runId
      );
    });
    const { until } = await helpers();
    await until(async () => {
      try {
        return await f.service.cancel(f.input.runId, 0, f.authority);
      } catch (e: any) {
        if (e.code === 'ledger_busy') return false;
        throw e;
      }
    });
    const s = await f.port.read(f.input.runId);
    assert.equal(s.run.state, 'uncertain');
    assert.equal(s.slotHeld, true);
    assert.equal(processState(running.meta.supervisor), 'alive');
    assert.equal(processState(running.meta.harness), 'alive');
    assert.equal(
      s.events.some((e: any) => e.kind === 'cancel.step'),
      false
    );
  } finally {
    await f.cleanup();
  }
});

test('B6 unknown supervisor probe adds no death fact or automatic action', { skip }, async () => {
  const { realRun, until } = await helpers();
  const f = await realRun();
  const { ReadControlService } = await import('../../packages/hud-mcp/src/read-control.js');
  let probes = 0;
  const service = new ReadControlService(f.ledger, f.home, undefined, {
    supervisorState: () => {
      probes++;
      return 'unknown';
    },
  });
  try {
    await f.ready();
    const before = await f.port.read(f.input.runId);
    await until(async () => {
      try {
        return await service.cancel(f.input.runId, 0, f.authority);
      } catch (e: any) {
        if (e.code === 'ledger_busy') return false;
        throw e;
      }
    });
    const s = await f.port.read(f.input.runId);
    assert.ok(probes > 0);
    assert.deepEqual(s.facts, before.facts);
    assert.equal(s.slotHeld, true);
    assert.equal(
      s.events.some((e: any) => e.kind === 'cancel.step'),
      false
    );
  } finally {
    service.close();
    await f.cleanup();
  }
});

test('B6 authority changes after dead-supervisor probe are rechecked before evidence commit', { skip }, async () => {
  const { realRun } = await helpers();
  const f = await realRun();
  const { ReadControlService } = await import('../../packages/hud-mcp/src/read-control.js');
  let changed: Promise<unknown> | undefined;
  let probes = 0;
  const service = new ReadControlService(f.ledger, f.home, undefined, {
    supervisorState: (stamp) => {
      probes++;
      const observed = processState(stamp);
      changed = f.ledger.transaction((tx: any) =>
        tx.run('UPDATE caller_contexts SET closed_at=? WHERE context_id=?', Date.now(), f.authority.contextId)
      );
      return observed;
    },
  });
  try {
    await f.ready();
    f.child.kill('SIGKILL');
    await f.done;
    const before = await f.port.read(f.input.runId);
    await assert.rejects(
      service.cancel(f.input.runId, 0, f.authority),
      (e: any) => e.message === 'stale_context' || e.code === 'ledger_busy'
    );
    await changed;
    const after = await f.port.read(f.input.runId);
    assert.equal(probes, 1);
    assert.equal(after.run.state, before.run.state);
    assert.deepEqual(after.facts, before.facts);
    assert.deepEqual(after.events, before.events);
  } finally {
    service.close();
    await f.cleanup();
  }
});
