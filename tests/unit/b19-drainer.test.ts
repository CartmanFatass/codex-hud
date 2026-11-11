import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync, readdirSync, utimesSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { notifyFixture, completion, factEvidence, reportFor } from './b21-fixture.js';
import { recordWakeRegistered, recordWakeDelivered } from '../../src/ledger/notify-events.js';
import { insertRecord, readLink } from '../../src/ledger/records.js';
import { authorizeRootCall, scopeSnapshot } from '../../src/ledger/call-context.js';
import { acceptIntent } from '../../src/ledger/intents.js';
import { commitReconcile, readReconcileSnapshot } from '../../src/ledger/reconcile.js';
import { WakeDrainer } from '../../packages/hud-mcp/src/wake-drainer.js';
import { WakeAdapters } from '../../src/core/wake/adapters.js';
import { ReadControlService } from '../../packages/hud-mcp/src/read-control.js';
import { readWakeState, wakeProjection } from '../../packages/hud-mcp/src/wake-state.js';
import { touchHint } from '../../src/core/wait/hints.js';
import { openLedger } from '../../src/ledger/ledger.js';
import { createServer } from 'node:net';
import { makeProcessKey, makeSourceId, sessionOwnerKey, sessionRefKey } from '../../src/core/identity.js';
async function until(predicate: () => boolean | Promise<boolean>, ms = 2500) {
  const deadline = performance.now() + ms;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error('b19 condition timeout');
    await delay(5);
  }
}
function calls(root: string): any[] {
  try {
    return readFileSync(join(root, 'sent'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((s) => JSON.parse(s));
  } catch {
    return [];
  }
}
function executable(f: Fixture, slow = 0) {
  const path = join(f.root, 'codex.cjs');
  writeFileSync(
    path,
    `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(join(f.root, 'sent'))},JSON.stringify({pid:process.pid,args:process.argv.slice(2),at:Date.now()})+'\\n');${slow ? `setTimeout(()=>{},${slow})` : ''}`
  );
  chmodSync(path, 0o700);
  return path;
}
async function drainer(f: Fixture, exe: string, extra: Partial<ConstructorParameters<typeof WakeDrainer>[0]> = {}) {
  const d = new WakeDrainer({
    ledger: f.ledger,
    home: f.root,
    processKey: f.parent.authority.evidence.processKey,
    recoveryMs: 80,
    callerId: f.parent.registration.caller.callerId,
    adapters: new WakeAdapters({ codexExecutable: exe }),
    ...extra,
  });
  await d.settled();
  return d;
}
function deliveries(f: Fixture) {
  return f.ledger.snapshot((tx) =>
    tx
      .all("SELECT * FROM events WHERE kind='wake.delivered' ORDER BY seq")
      .map((row) => JSON.parse(String(row.payload)))
  );
}

test(
  'B19 commit before hint, lost watch and duplicate/reordered hints recover within strict page allowance',
  { skip },
  async (t) => {
    const f = await notifyFixture();
    await register(f);
    const exe = executable(f);
    const d = await drainer(f, exe, { subscribe: () => ({ unavailable: true, close() {} }) });
    t.after(async () => {
      await d.close();
      await f.close();
    });
    const before = d.metrics.pages;
    const seqs = await event(f, 3);
    // No hint: simulate a committing writer dying before exclusive creation.
    await until(() => calls(f.root).length === 1);
    assert.equal(d.metrics.pages, before + 1);
    assert.equal(deliveries(f).at(-1).throughSeq, seqs.at(-1));
    for (const seq of [...seqs].reverse()) touchHint(f.root, 'run-a', seq);
    d.request();
    await d.settled();
    assert.equal(calls(f.root).length, 1);
    await delay(100);
    await d.settled();
    assert.equal(calls(f.root).length, 1);
  }
);

test(
  'B19 401 reordered multi-page events coalesce once per page, preserve throughSeq and share all-trigger budget',
  { skip },
  async (t) => {
    const f = await notifyFixture();
    await register(f);
    const seqs = await event(f, 401);
    const d = await drainer(f, executable(f));
    t.after(async () => {
      await d.close();
      await f.close();
    });
    await until(() => deliveries(f).filter((x) => x.result === 'accepted').length === 3, 4000);
    const accepted = deliveries(f).filter((x) => x.result === 'accepted');
    assert.deepEqual(
      accepted.map((x) => x.throughSeq),
      [seqs[199], seqs[399], seqs[400]]
    );
    const times = calls(f.root).map((x) => x.at);
    assert.ok(times[1] - times[0] >= 50);
    assert.ok(times[2] - times[1] >= 50);
    assert.ok(d.metrics.pages <= 4);
    for (const row of calls(f.root)) assert.ok(Buffer.byteLength(row.args.at(-1)) <= 512);
  }
);

test('B19 unknown retries only after recovery, reaches exhausted attempt 2, never a third', { skip }, async (t) => {
  const f = await notifyFixture();
  await register(f);
  await event(f);
  const d = await drainer(f, executable(f, 10000), {
    recoveryMs: 70,
    adapters: new WakeAdapters({ codexExecutable: join(f.root, 'codex.cjs') }),
  });
  t.after(async () => {
    await d.close();
    await f.close();
  });
  await until(() => deliveries(f).filter((x) => x.result === 'unknown' && x.attempt === 2).length === 2, 6500);
  await delay(180);
  assert.equal(calls(f.root).length, 2);
  assert.ok(calls(f.root)[1].at - calls(f.root)[0].at >= 100);
  assert.equal(deliveries(f).at(-1).exhausted, true);
  const projection = f.ledger.snapshot((tx) =>
    wakeProjection(readWakeState(tx, readLink(tx, 'link-a')), f.root, 'run-a', 0)
  );
  assert.equal(projection.wake.state, 'unconfirmed');
});

test(
  'B19 a parent call during transport or after unknown permanently suppresses that batch retry',
  { skip },
  async (_t) => {
    for (const during of [true, false]) {
      const f = await notifyFixture();
      await register(f);
      await event(f);
      const exe = executable(f, 10000);
      const d = new WakeDrainer({
        ledger: f.ledger,
        home: f.root,
        processKey: f.parent.authority.evidence.processKey,
        recoveryMs: 80,
        adapters: new WakeAdapters({ codexExecutable: exe, timeoutMs: 400 }),
      });
      try {
        await until(() => calls(f.root).length === 1);
        if (!during) await d.settled();
        d.parentCall();
        await delay(250);
        await d.settled();
        assert.equal(calls(f.root).length, 1);
        assert.equal(
          deliveries(f).some((x) => x.attempt === 2),
          false
        );
      } finally {
        await d.close();
        await f.close();
      }
    }
  }
);

test(
  'B19 in-flight delegate_wait returns its actual page as wait_return with zero native sends',
  { skip },
  async (t) => {
    const f = await notifyFixture();
    await register(f);
    const exe = executable(f);
    const d = await drainer(f, exe);
    const service = new ReadControlService(f.ledger, f.root, undefined, {}, {}, d);
    t.after(async () => {
      service.close();
      await d.close();
      await f.close();
    });
    const afterSeq = f.ledger.snapshot((tx) => Number(tx.get('SELECT max(seq) AS n FROM events')!.n));
    const waiting = service.wait(
      { runId: 'run-a', afterSeq, until: ['uncertain'], timeoutMs: 500 },
      () => f.parent.authority,
      { clientToolTimeoutMs: 1000, responseMarginMs: 100, verified: true }
    );
    await delay(15);
    const [seq] = await event(f);
    await f.ledger.transaction((tx) => tx.run("UPDATE runs SET state='uncertain' WHERE run_id='run-a'"));
    touchHint(f.root, 'run-a', seq);
    const returned = await waiting;
    assert.equal(returned.matched, true);
    await until(() => deliveries(f).some((x) => x.result === 'wait_return'));
    assert.equal(calls(f.root).length, 0);
  }
);

test(
  'B19 no registrations has zero page reads/no timer; bounded terminal tail suspends and explicit read reactivates',
  { skip },
  async (t) => {
    const f = await notifyFixture();
    const exe = executable(f);
    let now = Date.now() - 300001;
    const d = await drainer(f, exe, { now: () => now });
    t.after(async () => {
      await d.close();
      await f.close();
    });
    await delay(170);
    assert.equal(d.metrics.pages, 0);
    assert.equal(d.timerArmed, false);
    await register(f);
    await f.startup();
    await commitReconcile(
      f.ledger,
      readReconcileSnapshot(f.ledger, 'run-a'),
      [factEvidence(f, 'terminal', completion, now)],
      now
    );
    d.parentCall();
    await d.settled();
    assert.equal(calls(f.root).length, 1);
    assert.equal(d.timerArmed, true);
    now += 300001;
    d.request();
    await d.settled();
    assert.equal(d.timerArmed, false);
    const pages = d.metrics.pages;
    await event(f);
    await delay(100);
    assert.equal(d.metrics.pages, pages);
    now += 80; // The final tail sweep used the previous allowance.
    d.parentCall();
    await d.settled();
    assert.equal(calls(f.root).length, 2);
  }
);

test('B19 empty real HUD_HOME with no delegations has zero recovery reads and no timer', { skip }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'b19-empty-'));
  const ledger = await openLedger(join(home, 'ledger.sqlite'));
  const d = new WakeDrainer({
    ledger,
    home,
    processKey: 'synthetic-no-parent',
    recoveryMs: 40,
    adapters: new WakeAdapters(),
  });
  try {
    await d.settled();
    const snapshots = d.metrics.metadataSnapshots;
    await delay(170);
    assert.equal(
      ledger.snapshot((tx) => Number(tx.get('SELECT count(*) AS n FROM links')!.n)),
      0
    );
    assert.equal(d.metrics.pages, 0);
    assert.equal(d.metrics.metadataSnapshots, snapshots);
    assert.equal(d.timerArmed, false);
  } finally {
    await d.close();
    await ledger.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('B19 generation revocation after a reserved slot refuses the stale send', { skip }, async (t) => {
  const f = await notifyFixture();
  const reg = await register(f);
  await event(f);
  const exe = executable(f);
  const d = await drainer(f, exe, {
    afterReservation: () => {
      // Real competing connection commits while the delivery worker is outside SQLite.
      const script = `import {openLedger} from './dist-test/src/ledger/ledger.js';import {recordWakeRevoked} from './dist-test/src/ledger/notify-events.js';const l=await openLedger(${JSON.stringify(join(f.root, 'ledger.sqlite'))});await l.transaction(tx=>recordWakeRevoked(tx,'link-a',{registrationSeq:${reg},reason:'generation_changed'},Date.now()));await l.close();`;
      const { spawnSync } = requireChild();
      const p = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      assert.equal(p.status, 0, p.stderr);
    },
  });
  t.after(async () => {
    await d.close();
    await f.close();
  });
  assert.equal(calls(f.root).length, 0);
});
import { spawnSync } from 'node:child_process';
function requireChild() {
  return { spawnSync };
}

test(
  'B19 real crash after reservation/before send and accepted/before outcome never creates a third send across restarts',
  { skip, timeout: 10000 },
  async (_t) => {
    for (const fault of ['reserve', 'transport']) {
      const f = await notifyFixture();
      await register(f);
      await event(f);
      const exe = executable(f);
      const child = spawn(
        process.execPath,
        [resolve('tests/int/b19-drain.mjs'), f.root, f.parent.authority.evidence.processKey, exe, fault],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
      );
      let errors = '';
      child.stderr?.on('data', (data) => (errors += data.toString()));
      const [code] = await once(child, 'exit');
      assert.equal(code, fault === 'reserve' ? 71 : 72, errors);
      const sent = calls(f.root).length;
      assert.equal(sent, fault === 'reserve' ? 0 : 1);
      for (let i = 0; i < 3; i++) {
        const replacement = await drainer(f, exe);
        await delay(180);
        await replacement.close();
        assert.equal(
          calls(f.root).length,
          sent,
          'inherited unknown cannot prove silence and never reuses a charged slot'
        );
      }
      await f.close();
    }
  }
);

test(
  'B19 competing real drainer processes atomically charge only one first attempt',
  { skip, timeout: 5000 },
  async (t) => {
    const f = await notifyFixture();
    await register(f);
    await event(f);
    const exe = executable(f);
    const children = [0, 1].map(() =>
      spawn(
        process.execPath,
        [resolve('tests/int/b19-drain.mjs'), f.root, f.parent.authority.evidence.processKey, exe, 'none'],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
      )
    );
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode === null) {
          const done = once(child, 'exit');
          child.kill('SIGTERM');
          await done;
        }
      }
      await f.close();
    });
    await until(() => deliveries(f).some((x) => x.result === 'accepted'));
    await delay(250);
    assert.equal(calls(f.root).length, 1);
  }
);

test('B19 startup janitor unlinks only terminal-run hints older than one hour', { skip }, async (t) => {
  const f = await notifyFixture();
  const d = await drainer(f, executable(f));
  await d.close();
  await f.startup();
  await commitReconcile(
    f.ledger,
    readReconcileSnapshot(f.ledger, 'run-a'),
    [factEvidence(f, 'terminal', completion, Date.now())],
    Date.now()
  );
  for (const [run, seq] of [
    ['run-a', 1],
    ['run-a', 2],
    ['unknown', 1],
  ] as const)
    touchHint(f.root, run, seq);
  const old = new Date(Date.now() - 3600001);
  utimesSync(join(f.root, 'hints', 'run-a.1'), old, old);
  utimesSync(join(f.root, 'hints', 'unknown.1'), old, old);
  const cleanup = await drainer(f, join(f.root, 'codex.cjs'));
  t.after(async () => {
    await cleanup.close();
    await f.close();
  });
  await until(() => !readdirSync(join(f.root, 'hints')).includes('run-a.1'));
  assert.deepEqual(readdirSync(join(f.root, 'hints')).sort(), ['run-a.2', 'unknown.1']);
});

test(
  'B19 pi stale/no-endpoint rejection revokes atomically, degrades status and triggers no turn',
  { skip },
  async (_t) => {
    for (const absent of [true, false]) {
      const f = await notifyFixture();
      const sourceId = makeSourceId('pi', f.root);
      const ref = { harness: 'pi' as const, sourceId, sessionId: 'synthetic-pi-session', threadId: null };
      const processKey = makeProcessKey('pi', sourceId, 'synthetic-domain', 31000, '31000');
      const context = {
        ...f.parent.context,
        contextId: 'pi-context',
        callerId: 'pi-caller',
        harness: 'pi',
        sourceId,
        processKey,
        sessionRef: ref,
      };
      await f.ledger.transaction((tx) => {
        insertRecord(tx, 'sources', { sourceId, harness: 'pi', rootPath: f.root, label: 'Synthetic pi' });
        tx.run(
          'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
          sessionRefKey(ref),
          'pi',
          sourceId,
          ref.sessionId,
          ''
        );
        insertRecord(tx, 'callers', {
          ...f.parent.registration.caller,
          callerId: 'pi-caller',
          harness: 'pi',
          sourceId,
          pid: 31001,
          procStart: '31001',
        });
        insertRecord(tx, 'caller_scopes', {
          processKey,
          generation: 1,
          harness: 'pi',
          sourceId,
          pidDomain: 'synthetic-domain',
          harnessPid: 31000,
          harnessProcStart: '31000',
          sessionRef: ref,
          boundBy: 'trusted_session',
          bindingEvidenceId: f.parent.context.bindingEvidenceId,
          createdAt: 1000,
          closedAt: null,
        });
        insertRecord(tx, 'caller_contexts', context);
        tx.run(
          "UPDATE links SET parent_caller='pi-caller',parent_context_id='pi-context',parent_ref=? WHERE link_id='link-a'",
          sessionRefKey(ref)
        );
      });
      const socketPath = join(f.root, 'pi.sock');
      let requests = 0;
      const server = absent
        ? null
        : createServer((socket) => {
            socket.on('data', () => {
              requests++;
              socket.end(JSON.stringify({ result: 'rejected', reason: 'stale_session' }) + '\n');
            });
          });
      if (server) await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      await f.ledger.transaction((tx) =>
        recordWakeRegistered(
          tx,
          'link-a',
          {
            adapter: 'pi_extension_v1',
            adapterVersion: 1,
            ownerKey: sessionOwnerKey(ref),
            contextGeneration: 1,
            parentRef: ref,
            parentStamp: null,
            target: { socketPath },
          },
          Date.now()
        )
      );
      await event(f);
      const d = new WakeDrainer({
        ledger: f.ledger,
        home: f.root,
        processKey,
        recoveryMs: 50,
        adapters: new WakeAdapters(),
      });
      try {
        await until(() => f.ledger.snapshot((tx) => !!tx.get("SELECT 1 FROM events WHERE kind='wake.revoked'")));
        const projection = f.ledger.snapshot((tx) =>
          wakeProjection(readWakeState(tx, readLink(tx, 'link-a')), f.root, 'run-a', 0)
        );
        assert.equal(projection.wake.state, 'degraded');
        assert.equal(projection.wake.reason, absent ? 'no_endpoint' : 'stale_session');
        assert.equal(requests, absent ? 0 : 1);
      } finally {
        await d.close();
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
        await f.close();
      }
    }
  }
);

test(
  'B19 EOF while a slow adapter owns a child kills/reaps it and closes the real ledger within 2 s',
  { skip, timeout: 5000 },
  async (t) => {
    const f = await notifyFixture();
    await register(f);
    await event(f);
    const exe = executable(f, 10000);
    const child = spawn(
      process.execPath,
      [resolve('tests/int/b19-drain.mjs'), f.root, f.parent.authority.evidence.processKey, exe, 'lifetime'],
      { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }
    );
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      await f.close();
    });
    await until(() => calls(f.root).length === 1);
    const pid = calls(f.root)[0].pid;
    const start = performance.now();
    child.stdin!.end();
    await exited;
    assert.ok(performance.now() - start < 2000);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(child.pid!, 0), { code: 'ESRCH' });
  }
);

test(
  'B19 shorter competing reservation rebases a longer scan without skipping the uncovered suffix',
  { skip, timeout: 5000 },
  async (t) => {
    const f = await notifyFixture();
    await register(f);
    await event(f, 5);
    const exe = executable(f);
    const ledgerB = await openLedger(join(f.root, 'ledger.sqlite'));
    const transactionB = ledgerB.transaction.bind(ledgerB);
    let heldB = false;
    let releaseB!: () => void;
    const barrierB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    ledgerB.transaction = async (callback, budget) => {
      if (!heldB) {
        heldB = true;
        await barrierB;
      }
      return transactionB(callback, budget);
    };
    const b = new WakeDrainer({
      ledger: ledgerB,
      home: f.root,
      processKey: f.parent.authority.evidence.processKey,
      recoveryMs: 80,
      adapters: new WakeAdapters({ codexExecutable: exe }),
    });
    await until(() => heldB);
    const suffix = await event(f, 5);
    const transactionA = f.ledger.transaction.bind(f.ledger);
    let heldA = false;
    let releaseA!: () => void;
    const barrierA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    f.ledger.transaction = async (callback, budget) => {
      if (!heldA) {
        heldA = true;
        await barrierA;
      }
      return transactionA(callback, budget);
    };
    const a = new WakeDrainer({
      ledger: f.ledger,
      home: f.root,
      processKey: f.parent.authority.evidence.processKey,
      recoveryMs: 80,
      adapters: new WakeAdapters({ codexExecutable: exe }),
    });
    t.after(async () => {
      releaseA();
      releaseB();
      await a.close();
      await b.close();
      await ledgerB.close();
      await f.close();
    });
    await until(() => heldA);
    releaseB();
    await b.settled();
    await b.close();
    releaseA();
    await a.settled();
    await until(() => deliveries(f).some((row) => row.result === 'accepted' && row.throughSeq === suffix.at(-1)));
    assert.equal(calls(f.root).length, 2);
  }
);

test(
  'B19 retry retains its exact page after more than 200 preceding non-wake rows',
  { skip, timeout: 7500 },
  async (t) => {
    const f = await notifyFixture();
    await register(f);
    await f.ledger.transaction((tx) => {
      for (let i = 0; i < 201; i++)
        insertRecord(tx, 'events', {
          runId: 'run-a',
          linkId: 'link-a',
          kind: 'synthetic.progress',
          payload: {},
          at: Date.now(),
        });
    });
    const [last] = await event(f);
    const exe = executable(f, 10000);
    const d = await drainer(f, exe, { recoveryMs: 80 });
    t.after(async () => {
      await d.close();
      await f.close();
    });
    await until(() => deliveries(f).filter((row) => row.result === 'unknown' && row.attempt === 2).length === 2, 6500);
    assert.equal(calls(f.root).length, 2);
    assert.equal(deliveries(f).at(-1).throughSeq, last);
  }
);

test(
  'B19 physical second MCP without a logical context suppresses retry observation',
  { skip, timeout: 5000 },
  async (t) => {
    const f = await notifyFixture();
    await register(f);
    await event(f);
    const exe = executable(f, 10000);
    await f.ledger.transaction((tx) =>
      insertRecord(tx, 'callers', {
        ...f.parent.registration.caller,
        callerId: 'unselected-second-mcp',
        pid: 10002,
        procStart: '10002',
        startedAt: Date.now(),
      })
    );
    const d = await drainer(f, exe, { recoveryMs: 80 });
    t.after(async () => {
      await d.close();
      await f.close();
    });
    await delay(250);
    await d.settled();
    assert.equal(calls(f.root).length, 1);
    assert.equal(
      deliveries(f).some((row) => row.attempt === 2),
      false
    );
  }
);

test(
  'B19 parent call after attempt2 slot is charged suppresses its transport and never refunds the slot',
  { skip, timeout: 5000 },
  async (t) => {
    const f = await notifyFixture();
    await register(f);
    await event(f);
    const exe = executable(f, 10000);
    let d!: WakeDrainer;
    let interrupted = false;
    d = await drainer(f, exe, {
      recoveryMs: 80,
      afterReservation: (work) => {
        if (work.attempt === 2) {
          interrupted = true;
          d.parentCall();
        }
      },
    });
    t.after(async () => {
      await d.close();
      await f.close();
    });
    await until(() => interrupted);
    await delay(250);
    await d.settled();
    assert.equal(calls(f.root).length, 1);
    assert.equal(deliveries(f).filter((row) => row.attempt === 2).length, 1);
    assert.equal(deliveries(f).at(-1).exhausted, true);
  }
);

test(
  'B19 parent call queued after the final SQLite snapshot still suppresses attempt2 transport',
  { skip, timeout: 5000 },
  async (t) => {
    const f = await notifyFixture();
    await register(f);
    await event(f);
    const exe = executable(f, 10000);
    let d!: WakeDrainer;
    let callsAfterSnapshot = 0;
    const read = f.ledger.readSnapshot.bind(f.ledger);
    f.ledger.readSnapshot = <T>(callback: (tx: import('../../src/ledger/transaction.js').LedgerTransaction) => T) =>
      read((tx) => {
        const result = callback(tx);
        if (
          result === true &&
          !callsAfterSnapshot &&
          tx.get("SELECT 1 FROM events WHERE kind='wake.delivered' AND json_extract(payload,'$.attempt')=2")
        ) {
          callsAfterSnapshot++;
          queueMicrotask(() => d.parentCall());
        }
        return result;
      });
    d = await drainer(f, exe, { recoveryMs: 80 });
    t.after(async () => {
      await d.close();
      await f.close();
    });
    await until(() => callsAfterSnapshot === 1);
    await delay(250);
    await d.settled();
    assert.equal(calls(f.root).length, 1);
    assert.equal(deliveries(f).filter((row) => row.attempt === 2).length, 1);
  }
);

test(
  'B19 reopened parent ProcessKey and generation2 resume binds to accepted initiator, then clear revokes it',
  { skip },
  async (t) => {
    const f = await notifyFixture();
    await reportFor(f, 'completed');
    const at = Date.now();
    await commitReconcile(
      f.ledger,
      readReconcileSnapshot(f.ledger, 'run-a'),
      [factEvidence(f, 'old-complete', completion, at)],
      at
    );
    const reopened = await f.actor('reopened', 30000, 'synthetic-before-reopen');
    const processKey = reopened.authority.evidence.processKey;
    const authority = await authorizeRootCall(f.ledger, {
      callerId: reopened.context.callerId,
      processKey,
      sessionRef: f.parent.ref,
      evidenceDigest: 'a'.repeat(64),
      premise: f.ledger.snapshot((tx) => scopeSnapshot(tx, f.ledger.ledgerId, processKey)),
      at: Date.now(),
    });
    assert.equal(authority.generation, 2);
    const input = structuredClone(f.input);
    input.requestKey = 'reopened-resume';
    input.authority = authority;
    input.newSession = false;
    input.params = { ...input.params, linkId: 'link-a', expectedRun: 'run-a' };
    input.link = f.ledger.snapshot((tx) => readLink(tx, 'link-a'));
    input.run = {
      ...input.run,
      runId: 'run-reopened',
      operation: 'resume',
      runSeq: 2,
      expectedGeneration: 2,
      targetSessionRef: f.child.ref,
      launchTokenHash: 'b'.repeat(64),
      launchCallId: 'reopened-call',
      launchCorrelationId: 'reopened-correlation',
      createdAt: Date.now(),
    };
    input.claim = {
      ...input.claim,
      runId: 'run-reopened',
      expectedGeneration: 2,
      claimHash: 'c'.repeat(64),
      issuedAt: input.run.createdAt,
      expiresAt: input.run.createdAt + 1800000,
    };
    let registration = 0;
    await acceptIntent(f.ledger, input, 20, undefined, {}, (tx) => {
      registration = recordWakeRegistered(tx, 'link-a', { ...f.registration, contextGeneration: 2 }, Date.now());
    });
    await f.ledger.transaction((tx) =>
      insertRecord(tx, 'events', {
        runId: 'run-reopened',
        linkId: 'link-a',
        kind: 'run.state',
        payload: { state: 'uncertain' },
        at: Date.now(),
      })
    );
    const state = f.ledger.snapshot((tx) => readWakeState(tx, readLink(tx, 'link-a')))!;
    assert.equal(state.valid, true);
    assert.equal(state.context?.contextId, authority.contextId);
    assert.equal(state.link.parentContextId, f.parent.context.contextId);
    const d = new WakeDrainer({
      ledger: f.ledger,
      home: f.root,
      processKey,
      callerId: reopened.context.callerId,
      recoveryMs: 80,
      adapters: new WakeAdapters({ codexExecutable: executable(f) }),
    });
    t.after(async () => {
      await d.close();
      await f.close();
    });
    await until(() => deliveries(f).some((row) => row.result === 'accepted'));
    assert.equal(calls(f.root).length, 1);
    await authorizeRootCall(f.ledger, {
      callerId: reopened.context.callerId,
      processKey,
      sessionRef: { ...f.parent.ref, sessionId: 'synthetic-after-clear' },
      evidenceDigest: 'd'.repeat(64),
      premise: f.ledger.snapshot((tx) => scopeSnapshot(tx, f.ledger.ledgerId, processKey)),
      at: Date.now(),
    });
    assert.equal(
      f.ledger.snapshot(
        (tx) =>
          tx.get(
            "SELECT json_extract(payload,'$.reason') AS reason FROM events WHERE kind='wake.revoked' AND json_extract(payload,'$.registrationSeq')=?",
            registration
          )?.reason
      ),
      'generation_changed'
    );
  }
);

test(
  'B19 terminal empty drain removes a late recreated covered hint and retains an uncovered later hint',
  { skip },
  async (t) => {
    const f = await notifyFixture();
    await register(f);
    await f.startup();
    const at = Date.now();
    await commitReconcile(
      f.ledger,
      readReconcileSnapshot(f.ledger, 'run-a'),
      [factEvidence(f, 'terminal-late-hint', completion, at)],
      at
    );
    const d = await drainer(f, executable(f));
    t.after(async () => {
      await d.close();
      await f.close();
    });
    const through = deliveries(f).at(-1).throughSeq;
    touchHint(f.root, 'run-a', through);
    touchHint(f.root, 'run-a', through + 100000);
    d.request();
    await d.settled();
    await until(() => !readdirSync(join(f.root, 'hints')).includes(`run-a.${through}`));
    assert.equal(readdirSync(join(f.root, 'hints')).includes(`run-a.${through + 100000}`), true);
    assert.equal(calls(f.root).length, 1);
  }
);
import { skip, Fixture, register, event } from '../fixtures/b19-drainer-perf.js';

test('semantic residue: accepted wake batches cannot cover an older unconfirmed interval', { skip }, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  const reg = await register(f);
  const service = new ReadControlService(f.ledger, f.root);
  t.after(() => service.close());
  const first = (await event(f))[0];
  await f.ledger.transaction((tx) => {
    for (const result of ['unknown', 'accepted'] as const)
      recordWakeDelivered(tx, 'link-a', { registrationSeq: reg, throughSeq: first, result, attempt: 1 }, Date.now());
  });
  assert.equal((await service.status({ runId: 'run-a' }, () => f.parent.authority)).wake.state, 'registered');
  const events = await event(f, 2);
  await f.ledger.transaction((tx) => {
    recordWakeDelivered(
      tx,
      'link-a',
      { registrationSeq: reg, throughSeq: events[0], result: 'unknown', attempt: 1 },
      Date.now()
    );
    recordWakeDelivered(
      tx,
      'link-a',
      { registrationSeq: reg, throughSeq: events[1], result: 'accepted', attempt: 1 },
      Date.now()
    );
  });
  assert.equal((await service.status({ runId: 'run-a' }, () => f.parent.authority)).wake.state, 'unconfirmed');
});
