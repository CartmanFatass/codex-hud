import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { handshakeFixture } from './b45-handshake-fixture.js';
import { ReadControlService } from '../../packages/hud-mcp/src/read-control.js';
import { DelegationService } from '../../packages/hud-mcp/src/delegation.js';
import { scopeSnapshot } from '../../src/ledger/call-context.js';
import { insertRecord, insertRun, refValue, readRun } from '../../src/ledger/records.js';
import { openLedger } from '../../src/ledger/ledger.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { openObservationStore } from '../../src/core/observation-store.js';
import { StatusWriter } from '../../src/core/status/writer.js';
import { initialParserState } from '../../src/core/observation.js';
import type { MergeInput } from '../../src/core/status/merge.js';
import type { ReaderResult } from '../../src/core/interfaces/harness-adapter.js';
import type { SubscribeWait } from '../../src/core/wait/index.js';
import type { WaitUntil } from '../../src/core/types/lifecycle.js';

const skip = ledgerRuntimeSupported() ? false : 'B6 requires Node 22.x >=22.13 or >=24';
const timing = { clientToolTimeoutMs: 10000, responseMarginMs: 1000, verified: true };
async function fixture(t: import('node:test').TestContext, subscribe?: SubscribeWait) {
  const f = await handshakeFixture();
  const service = new ReadControlService(f.ledger, f.root, subscribe);
  const authority = () => f.parent.authority;
  const cursor = () => f.ledger.snapshot((tx) => Number(tx.get('SELECT max(seq) AS n FROM events')!.n));
  t.after(async () => {
    service.close();
    await f.close();
  });
  return { ...f, service, authority, cursor };
}
async function event(f: Awaited<ReturnType<typeof fixture>>, kind = 'test.progress', runId = 'run-a', at = 1000) {
  await f.ledger.transaction((tx) => insertRecord(tx, 'events', { runId, linkId: 'link-a', kind, payload: {}, at }));
}
function waitArgs(afterSeq: number, until: WaitUntil[] = ['uncertain'], timeoutMs = 80) {
  return { runId: 'run-a', afterSeq, until, timeoutMs };
}

test(
  'B6 wait registration race commits between first snapshot and subscribe; fresh snapshot finds event',
  { skip },
  async (t) => {
    let fired = false;
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture(t, () => {
      fired = true;
      const committed = spawnSync(
        process.execPath,
        [resolve('tests/int/b6-commit.mjs'), join(f.root, 'ledger.sqlite')],
        { encoding: 'utf8', timeout: 5000 }
      );
      assert.equal(committed.status, 0, committed.stderr);
      return { unavailable: false, close() {} };
    });
    let reads = 0;
    const read = f.ledger.readSnapshot.bind(f.ledger);
    f.ledger.readSnapshot = <T>(callback: (tx: import('../../src/ledger/transaction.js').LedgerTransaction) => T) => {
      reads++;
      return read(callback);
    };
    const result = await f.service.wait(waitArgs(f.cursor(), ['uncertain'], 2000), f.authority, timing);
    assert.ok(fired);
    assert.equal(result.matched, true);
    assert.equal(result.current.state, 'uncertain');
    assert.equal(result.events.at(-1)?.kind, 'run.state');
    assert.equal(reads, 2);
  }
);

test(
  'B6 lost hints recover at deadline, duplicate hints coalesce and unrelated hints are filtered',
  { skip },
  async (t) => {
    const f = await fixture(t);
    mkdirSync(join(f.root, 'hints'), { mode: 0o700 });
    const before = f.cursor();
    const pending = f.service.wait(waitArgs(before, ['uncertain'], 100), f.authority, timing);
    await sleep(15);
    await f.ledger.transaction((tx) => tx.run("UPDATE runs SET state='uncertain' WHERE run_id='run-a'"));
    // No hint at all: final reread still observes it.
    assert.equal((await pending).matched, true);
    await f.ledger.transaction((tx) => tx.run("UPDATE runs SET state='running' WHERE run_id='run-a'"));
    const next = f.service.wait(waitArgs(before, ['uncertain'], 2000), f.authority, timing);
    await sleep(15);
    writeFileSync(join(f.root, 'hints', 'unrelated.999'), '');
    await f.ledger.transaction((tx) => tx.run("UPDATE runs SET state='uncertain' WHERE run_id='run-a'"));
    for (let i = 0; i < 10; i++) writeFileSync(join(f.root, 'hints', 'run-a.999'), String(i));
    assert.equal((await next).matched, true);
  }
);

test(
  'B6 reordered multi-page events retain ordered durable cursors and never skip a later matching page',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const start = f.cursor();
    for (let i = 0; i < 405; i++) await event(f, 'test.progress', 'run-a', 2000 - i);
    let cursor = start;
    const received: number[] = [];
    for (let page = 0; page < 3; page++) {
      const result = await f.service.wait(waitArgs(cursor, [], 0), f.authority, timing);
      assert.equal(result.events.length, page < 2 ? 200 : 5);
      assert.equal(result.hasMore, page < 2);
      received.push(...result.events.map((e) => e.seq));
      cursor = result.nextSeq;
    }
    assert.equal(new Set(received).size, 405);
    assert.deepEqual(
      received,
      [...received].sort((a, b) => a - b)
    );
  }
);

test(
  'B6 old-run late events cannot satisfy new run wait; link entry fixes run before later resume',
  { skip },
  async (t) => {
    let f: Awaited<ReturnType<typeof fixture>>;
    let registrationWrite: Promise<unknown> | undefined;
    f = await fixture(t, () => {
      registrationWrite = f.ledger.transaction((tx) => {
        const old = readRun(tx, 'run-a');
        // Synthetic new round: preserve all schema/foreign keys, no external launch.
        insertRun(tx, {
          ...old,
          runId: 'run-b',
          runSeq: 2,
          operation: 'resume',
          expectedGeneration: 2,
          targetSessionRef: f.child.ref,
          launchTokenHash: 'b'.repeat(64),
          launchPhase: 'reserved',
          launchCallId: 'call-b',
          launchCorrelationId: 'correlation-b',
          state: 'starting',
          supervisor: null,
          heartbeatAt: null,
          heartbeatSeq: 0,
          heartbeatMonoMs: null,
          scopeRef: null,
          startedAt: null,
        });
        tx.run("UPDATE runs SET state='uncertain' WHERE run_id='run-a'");
      });
      return { unavailable: false, close() {} };
    });
    const first = await f.service.wait(
      { linkId: 'link-a', afterSeq: f.cursor(), until: ['uncertain'], timeoutMs: 1000 },
      f.authority,
      timing
    );
    await registrationWrite;
    assert.equal(first.runId, 'run-a');
    assert.equal(first.matched, true);
    const later = await f.service.wait(
      { linkId: 'link-a', afterSeq: f.cursor(), until: ['report'], timeoutMs: 0 },
      f.authority,
      timing
    );
    assert.equal(later.runId, 'run-b');
    assert.equal(later.matched, false);
    assert.equal(later.status.latestReportForRun, null);
  }
);

test(
  'B6 idle wait has zero writes, no polling, and timeout leaves empty cursor/state unchanged',
  { skip },
  async (t) => {
    let reads = 0,
      closed = 0;
    const f = await fixture(t, () => ({
      unavailable: true,
      close() {
        closed++;
      },
    }));
    const read = f.ledger.readSnapshot.bind(f.ledger);
    f.ledger.readSnapshot = <T>(callback: (tx: import('../../src/ledger/transaction.js').LedgerTransaction) => T) => {
      reads++;
      return read(callback);
    };
    const before = f.ledger.snapshot((tx) => ({
      changes: tx.get('SELECT total_changes() AS n')!.n,
      state: readRun(tx, 'run-a').state,
    }));
    const cursor = f.cursor();
    const result = await f.service.wait(waitArgs(cursor, [], 100), f.authority, timing);
    assert.equal(reads, 3); // entry, post-registration, deadline
    assert.equal(closed, 1);
    assert.equal(result.watchUnavailable, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.nextSeq, cursor);
    assert.deepEqual(
      f.ledger.snapshot((tx) => ({
        changes: tx.get('SELECT total_changes() AS n')!.n,
        state: readRun(tx, 'run-a').state,
      })),
      before
    );
  }
);

test(
  'B6 status and wait revalidate existing caller/scope read-only and do not establish missing authority',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const service = new DelegationService({
      ledger: f.ledger,
      home: f.root,
      config: { version: 1, profiles: [] },
      registration: f.parent.registration,
      reader: f.reader,
      capability: { verify: () => ({ ok: false, reason: 'capability_unverified' }) },
      hudRunPath: '/synthetic/hud-run',
    });
    t.after(() => service.close());
    const source = () => ({
      ok: true as const,
      callId: 'call-status',
      sessionRef: f.parent.ref,
      processKey: f.parent.authority.evidence.processKey,
      evidenceDigest: 'a'.repeat(64),
      scopePremise: f.ledger.snapshot((tx) =>
        scopeSnapshot(tx, f.ledger.ledgerId, f.parent.authority.evidence.processKey)
      ),
    });
    const before = f.ledger.snapshot((tx) => tx.get('SELECT total_changes() AS n')!.n);
    const status = (await service.invoke(source(), 'delegate_status', { runId: 'run-a' })) as any;
    assert.equal(status.ok, true);
    const wait = (await service.invoke(source(), 'delegate_wait', {
      runId: 'run-a',
      afterSeq: f.cursor(),
      timeoutMs: 20,
    })) as any;
    assert.equal(wait.reason, 'timeout_configuration_unverified');
    assert.equal(wait.timedOut, true);
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT total_changes() AS n')!.n),
      before
    );
    await f.ledger.transaction((tx) => tx.run("UPDATE caller_contexts SET closed_at=2000 WHERE caller_id='parent'"));
    await assert.rejects(service.invoke(source(), 'delegate_status', { runId: 'run-a' }), /stale_context/);
  }
);

test(
  'B6 observation reads preserve B16 stamps/continuity/notices and reject an old run summary',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const step = JSON.parse(
      readFileSync('tests/fixtures/status-merge/C30.json', 'utf8')
        .replaceAll('run-b', 'run-a')
        .replaceAll('a'.repeat(64), f.source.sourceId)
    ).steps[0] as { input: MergeInput; ruleVersion: string; nowMs: number };
    const ref = f.child.ref;
    step.input.target = {
      ...step.input.target,
      nodeIdentity: { kind: 'session', ref },
      runId: 'run-a',
      bindingGeneration: 1,
      sourceGeneration: 1,
    };
    step.input.sources = step.input.sources.map((s) =>
      s.evidence.origin === 'ledger'
        ? s
        : { ...s, evidence: { ...s.evidence, ref, runId: 'run-a', bindingGeneration: 1, sourceGeneration: 1 } }
    );
    await f.ledger.transaction((tx) =>
      tx.run('UPDATE runs SET target_session_ref=? WHERE run_id=?', refValue(ref), 'run-a')
    );
    const store = await openObservationStore({ hudHome: f.root, sourceId: ref.sourceId, now: () => step.nowMs });
    t.after(() => store.close());
    const lease = store.acquire(ref, 'synthetic-b6');
    const writer = new StatusWriter(store, ref, lease);
    const reading: ReaderResult = {
      checkpoint: {
        schemaVersion: 1,
        readerVersion: 'synthetic',
        ref,
        sourceGeneration: 1,
        fileId: { dev: 1, inode: 2 },
        offset: 1,
        parserState: initialParserState(),
      },
      observation: {
        nodeIdentity: { kind: 'session', ref },
        statusProjection: {} as any,
        conflict: null,
        workspace: null,
        spent: {
          tokens: { value: null, quality: 'unknown', source: 'synthetic', asOf: 1000 },
          costUsd: { value: null, quality: 'unknown', source: 'synthetic', asOf: 1000 },
        },
        coverage: { state: 'complete', gaps: [], skipped: {}, loaded: true },
        loaded: true,
        depth: 0,
        evidenceStamp: 'synthetic',
      },
    };
    const native = step.input.sources.filter((s) => s.evidence.origin === 'transcript');
    const publication = writer.publish(
      writer.prepare(reading, native, step.input.target),
      { ...step.input, sources: step.input.sources.filter((s) => s.evidence.origin !== 'transcript') },
      step.ruleVersion,
      step.nowMs
    );
    const one = await f.service.status({ runId: 'run-a' }, f.authority);
    const two = await f.service.status({ runId: 'run-a' }, f.authority);
    assert.deepEqual(one.observationStamp, publication.committed.observationStamp);
    assert.deepEqual(one.statusProjection, publication.committed.summary.statusProjection);
    assert.deepEqual(one.continuity, two.continuity);
    assert.deepEqual(one.notices, two.notices);
    assert.equal(one.seqDomain, publication.committed.seqDomain);
    assert.equal(one.freshnessNow?.state, 'stale');
    assert.equal(one.observationAvailability, 'stale');
    assert.equal(one.statusProjection?.pendingReason, 'needs_human');
    assert.equal(one.isRunTerminal, false);
    assert.equal(one.slotHeld, true);
    await f.ledger.transaction((tx) => {
      tx.run('PRAGMA defer_foreign_keys=ON');
      tx.run('UPDATE runs SET expected_generation=2 WHERE run_id=?', 'run-a');
      tx.run('UPDATE claims SET expected_generation=2 WHERE run_id=?', 'run-a');
    });
    const stale = await f.service.status({ runId: 'run-a' }, f.authority);
    assert.equal(stale.statusProjection, null);
    assert.equal(stale.observationUnavailableReason, 'binding_generation_mismatch');
    await f.ledger.transaction((tx) => {
      const old = readRun(tx, 'run-a');
      insertRun(tx, {
        ...old,
        runId: 'run-next',
        runSeq: 2,
        operation: 'resume',
        targetSessionRef: ref,
        expectedGeneration: 3,
        launchTokenHash: 'd'.repeat(64),
        launchPhase: 'reserved',
        launchCallId: 'call-next',
        launchCorrelationId: 'corr-next',
        supervisor: null,
        heartbeatAt: null,
        heartbeatSeq: 0,
        heartbeatMonoMs: null,
        scopeRef: null,
        startedAt: null,
      });
    });
    const newRun = await f.service.status({ linkId: 'link-a' }, f.authority);
    assert.equal(newRun.currentRun.runId, 'run-next');
    assert.equal(newRun.statusProjection, null);
    assert.equal(newRun.continuity, null);
    assert.equal(newRun.observationUnavailableReason, 'run_mismatch');
    assert.deepEqual(newRun.rejectedObservationStamp, publication.committed.observationStamp);
  }
);

test(
  'B6 report match is computed on each returned page, including hasMore and orphan rejection',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const { HandshakeService } = await import('../../packages/hud-mcp/src/handshake.js');
    await f.startup();
    const handshake = new HandshakeService({
      ledger: f.ledger,
      registration: f.child.registration,
      reader: f.reader,
      env: { HUD_CLAIM: f.claim },
      now: f.now,
    });
    await handshake.whoami({}, f.child.authority);
    const start = f.cursor();
    for (let i = 0; i < 199; i++) await event(f);
    await handshake.report(
      { runId: 'run-a', status: 'blocked', summary: 'Synthetic external attention required' },
      f.child.authority
    );
    for (let i = 0; i < 210; i++) await event(f);
    const first = await f.service.wait(waitArgs(start, ['report'], 0), f.authority, timing);
    assert.equal(first.matched, true);
    assert.equal(first.hasMore, true);
    assert.equal(first.events.length, 200);
    assert.equal(first.events.at(-1)?.kind, 'report.received');
    assert.equal(first.status.latestReportForRun?.status, 'blocked');
    assert.equal(first.status.isRunTerminal, false);
    assert.equal(first.status.slotHeld, true);
    const before201 = await f.service.wait(waitArgs(start - 1, ['report'], 0), f.authority, timing);
    assert.equal(before201.matched, false);
    assert.equal(before201.hasMore, true);
    const at201 = await f.service.wait(waitArgs(before201.nextSeq, ['report'], 0), f.authority, timing);
    assert.equal(at201.events[0].kind, 'report.received');
    assert.equal(at201.matched, true);
    const later = await f.service.wait(waitArgs(first.nextSeq, ['report'], 0), f.authority, timing);
    assert.equal(later.matched, false);
    assert.equal(later.hasMore, true);
    const end = f.cursor();
    await f.ledger.transaction((tx) =>
      insertRecord(tx, 'events', {
        runId: 'run-a',
        linkId: 'link-a',
        kind: 'report.received',
        payload: { reportId: 'absent' },
        at: 1100,
      })
    );
    const orphan = await f.service.wait(waitArgs(end, ['report'], 0), f.authority, timing);
    assert.equal(orphan.matched, false);
    assert.equal(orphan.events[0].kind, 'report.received');
    assert.equal(orphan.nextSeq, end + 1);
  }
);

test(
  'B6 historical owner can read own handed-over link; foreign owner and stale scope cannot read',
  { skip },
  async (t) => {
    const f = await fixture(t);
    await f.ledger.transaction((tx) =>
      tx.run("UPDATE links SET state='handed_over',current_owner=0 WHERE link_id='link-a'")
    );
    assert.equal((await f.service.status({ linkId: 'link-a' }, f.authority)).currentRun.runId, 'run-a');
    await assert.rejects(
      f.service.status({ runId: 'run-a' }, () => f.child.authority),
      /unauthorized/
    );
    await assert.rejects(f.service.cancel('run-a', 0, f.parent.authority), /unauthorized/);
    await f.ledger.transaction((tx) =>
      tx.run('UPDATE caller_scopes SET closed_at=2000 WHERE process_key=?', f.parent.authority.evidence.processKey)
    );
    await assert.rejects(f.service.status({ runId: 'run-a' }, f.authority), /stale_context/);
  }
);

test(
  'B6 unverified timeout uses a short wait with a flag; explicit shorter deadline and elapsed budget cap it',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const start = performance.now();
    const result = await f.service.wait(waitArgs(f.cursor(), [], 40), f.authority, {
      clientToolTimeoutMs: null,
      responseMarginMs: null,
      verified: false,
      started: start,
    });
    assert.ok(performance.now() - start >= 25);
    assert.equal(result.reason, 'timeout_configuration_unverified');
    assert.equal(result.timeoutVerified, false);
    const expired = await f.service.wait(waitArgs(f.cursor(), [], 120000), f.authority, {
      clientToolTimeoutMs: 2100,
      responseMarginMs: 100,
      verified: false,
      started: performance.now() - 200,
    });
    assert.equal(expired.timedOut, true);
    const verified = await f.service.wait(waitArgs(f.cursor(), [], 0), f.authority, {
      clientToolTimeoutMs: 180000,
      responseMarginMs: 1000,
      verified: true,
    });
    assert.equal(verified.timeoutVerified, true);
    assert.equal(verified.reason, null);
  }
);

test(
  'B6 drain pins run/high-water across pages while a real concurrent writer adds later events',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const { drainWaitPages } = await import('../../src/core/wait/index.js');
    const { readDelegationEventsIn, readDelegationIn } = await import('../../src/ledger/delegation-read.js');
    const { waitPage } = await import('../../src/core/lifecycle.js');
    const start = f.cursor();
    for (let i = 0; i < 405; i++) await event(f);
    const seen: number[] = [];
    let boundary: number | undefined;
    for await (const page of drainWaitPages(
      async (afterSeq, throughSeq) =>
        f.ledger.readSnapshot((tx) => {
          const asOfSeq = readDelegationIn(tx, { runId: 'run-a' }, f.authority()).asOfSeq!;
          const highWaterSeq = throughSeq ?? asOfSeq;
          const page = waitPage(
            { runId: 'run-a', afterSeq, until: [], timeoutMs: 0 },
            {
              run: readRun(tx, 'run-a'),
              highWaterSeq,
              events: readDelegationEventsIn(tx, 'run-a', afterSeq, highWaterSeq).events,
            }
          );
          return { ...page, asOfSeq };
        }),
      start
    )) {
      boundary ??= page.asOfSeq;
      assert.ok(page.asOfSeq >= boundary!);
      assert.equal(page.throughSeq, boundary);
      seen.push(...page.events.map((e) => e.seq));
      await event(f, 'test.after-boundary');
    }
    assert.equal(seen.length, 405);
    assert.equal(seen.at(-1), boundary);
    assert.ok(f.cursor() > boundary!);
  }
);

test('B6 shared hints watcher is one per home and detects replaced directory as unavailable', { skip }, async (t) => {
  const f = await fixture(t);
  const { hintSubscription } = await import('../../src/core/wait/index.js');
  const directory = join(f.root, 'hints');
  mkdirSync(directory, { mode: 0o700 });
  const count = () => process.getActiveResourcesInfo().filter((name) => name === 'FSEventWrap').length;
  const before = count();
  let hints = 0;
  const subscribe = hintSubscription(f.root);
  const a = subscribe('run-a', () => hints++),
    b = subscribe('run-a', () => hints++);
  try {
    assert.equal(count(), before + 1);
    await f.ledger.transaction((tx) => tx.run("UPDATE runs SET state='uncertain' WHERE run_id='run-a'"));
    writeFileSync(join(directory, 'run-a.10'), '');
    await sleep(20);
    assert.equal(hints, 2);
    for (let i = 0; i < 5; i++) writeFileSync(join(directory, 'run-a.10'), 'duplicate');
    await sleep(20);
    assert.equal(hints, 2);
    renameSync(directory, join(f.root, 'hints-old'));
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, 'run-a.11'), '');
    await sleep(20);
    assert.equal(a.unavailable, true);
    assert.equal(b.unavailable, true);
  } finally {
    a.close();
    b.close();
  }
  await sleep(10);
  assert.equal(count(), before);
  const recovered = subscribe('run-a', () => {});
  assert.equal(recovered.unavailable, false);
  recovered.close();
});

test('B6 null filename hint wakes a real SQLite wait without treating hint data as truth', { skip }, async (t) => {
  const f = await fixture(t);
  const { hintSubscription } = await import('../../src/core/wait/index.js');
  const { watch } = await import('node:fs');
  mkdirSync(join(f.root, 'hints'), { mode: 0o700 });
  let watcher: import('node:fs').FSWatcher | undefined;
  const subscribe = hintSubscription(f.root, (directory, listener) => {
    watcher = watch(directory, listener);
    return watcher;
  });
  const service = new ReadControlService(f.ledger, f.root, subscribe);
  t.after(() => service.close());
  const pending = service.wait(waitArgs(f.cursor(), ['uncertain'], 2000), f.authority, timing);
  await sleep(20);
  await f.ledger.transaction((tx) => tx.run("UPDATE runs SET state='uncertain' WHERE run_id='run-a'"));
  watcher!.emit('change', 'rename', null);
  const result = await pending;
  assert.equal(result.matched, true);
  assert.equal(result.current.state, 'uncertain');
  assert.equal(result.watchUnavailable, false);
});

test(
  'B6 missing and incompatible real projection storage is unavailable and read paths never create/migrate it',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const { existsSync } = await import('node:fs');
    await f.ledger.transaction((tx) =>
      tx.run('UPDATE runs SET target_session_ref=? WHERE run_id=?', refValue(f.child.ref), 'run-a')
    );
    assert.equal(existsSync(join(f.root, 'sources')), false);
    const absent = await f.service.status({ runId: 'run-a' }, f.authority);
    assert.equal(absent.statusProjection, null);
    assert.equal(absent.observationAvailability, 'unavailable');
    assert.equal(existsSync(join(f.root, 'sources')), false);
    const store = await openObservationStore({ hudHome: f.root, sourceId: f.source.sourceId });
    const file = store.databasePath;
    store.close();
    const { loadLedgerSqlite } = await import('../../src/ledger/runtime.js');
    const { DatabaseSync } = await loadLedgerSqlite();
    let db = new DatabaseSync(file);
    db.exec('PRAGMA user_version=999');
    db.close();
    const incompatible = await f.service.status({ runId: 'run-a' }, f.authority);
    assert.equal(incompatible.statusProjection, null);
    assert.equal(incompatible.observationAvailability, 'unavailable');
    db = new DatabaseSync(file, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 999);
    db.close();
  }
);

test('B6 actual late old-run report is rejected and cannot fill a new run wait/status', { skip }, async (t) => {
  const f = await fixture(t);
  const { HandshakeService } = await import('../../packages/hud-mcp/src/handshake.js');
  await f.startup();
  const handshake = new HandshakeService({
    ledger: f.ledger,
    registration: f.child.registration,
    reader: f.reader,
    env: { HUD_CLAIM: f.claim },
    now: f.now,
  });
  await handshake.whoami({}, f.child.authority);
  await handshake.report({ runId: 'run-a', status: 'completed', summary: 'Synthetic old report' }, f.child.authority);
  await f.ledger.transaction((tx) => {
    const old = readRun(tx, 'run-a');
    insertRun(tx, {
      ...old,
      runId: 'run-new',
      runSeq: 2,
      operation: 'resume',
      expectedGeneration: 2,
      targetSessionRef: f.child.ref,
      launchTokenHash: 'c'.repeat(64),
      launchPhase: 'reserved',
      launchCallId: 'call-new',
      launchCorrelationId: 'corr-new',
      state: 'starting',
      supervisor: null,
      heartbeatAt: null,
      heartbeatSeq: 0,
      heartbeatMonoMs: null,
      scopeRef: null,
      startedAt: null,
    });
    tx.run('UPDATE child_bindings SET is_current=0,revoked_at=1021 WHERE run_id=?', 'run-a');
  });
  const before = f.cursor();
  const rejected = await handshake.report(
    { runId: 'run-a', status: 'failed', summary: 'Synthetic late old report' },
    f.child.authority
  );
  assert.equal(rejected.ok, false);
  const status = await f.service.status({ linkId: 'link-a' }, f.authority);
  assert.equal(status.currentRun.runId, 'run-new');
  assert.equal(status.latestReportForRun, null);
  const wait = await f.service.wait(
    { linkId: 'link-a', afterSeq: before, until: ['report'], timeoutMs: 0 },
    f.authority,
    timing
  );
  assert.equal(wait.runId, 'run-new');
  assert.equal(wait.matched, false);
  assert.equal(wait.events.length, 0);
  assert.equal((await f.service.status({ runId: 'run-a' }, f.authority)).latestReportForRun?.status, 'completed');
});
