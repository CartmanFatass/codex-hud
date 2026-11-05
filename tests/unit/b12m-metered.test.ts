// B12M failure-mode acceptance: metered recovery reads on real SQLite in a temporary HUD_HOME. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryGrant, RecoveryReadError } from '../../src/core/observation-store.js';
import { RecoveryIndexOverlay, RecoveryPageCursor, attachRecoveryIndex } from '../../src/core/checkpoint.js';
import type { ObservationRecovery, RecoveryIndexLookup } from '../../src/core/types/checkpoint.js';
import { BUDGET, REF, commit, setup, skip } from './b12m-helpers.js';
import {
  RecoveryMap,
  RecoverySet,
  RecoveryClearCoordinator,
  RecoveryClearPending,
} from '../../src/harness/codex/recovery-index.js';

type Fixture = Awaited<ReturnType<typeof setup>>;
/** Real-clock grants whose deadline is not under test: wide enough to span fsync'd publishes on a loaded host. */
const WIDE = { ...BUDGET, budgetMs: 60_000 };

/** Publishes commit 1 with a 300-entry recovery index; returns the reader overlay and its ACK lookup. */
async function indexed(t: import('node:test').TestContext) {
  const f = await setup(t);
  const overlay = new RecoveryIndexOverlay('synthetic-index-1');
  for (let n = 0; n < 300; n++)
    overlay.set('synthetic.ids', String(n).padStart(5, '0'), JSON.stringify({ n, pad: 'x'.repeat(n % 7) }));
  overlay.set('synthetic.big', 'large', JSON.stringify('y'.repeat(4096)));
  const acks: RecoveryIndexLookup[] = [];
  const first = commit();
  attachRecoveryIndex(first.checkpoint, overlay, (lookup) => acks.push(lookup));
  f.publish(first);
  return { ...f, overlay, acks };
}

async function sizes(f: Fixture) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(f.store.databasePath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT octet_length(b.body) AS body, octet_length(b.identity) AS identity,
          (SELECT octet_length(i.lineage) FROM recovery_indexes i
            WHERE i.id = json_extract(b.identity, '$.recoveryReferences[0].indexId')) AS lineage
        FROM observation_current c JOIN checkpoint_blobs b ON b.id=c.checkpoint_id`
      )
      .get()!;
    return { body: Number(row.body), identity: Number(row.identity), lineage: Number(row.lineage ?? 0) };
  } finally {
    db.close();
  }
}

/** Monotonic fake clock: every read advances it by one millisecond. */
function tickingClock(start = 1000) {
  let now = start;
  return { now: () => now++, peek: () => now };
}

test(
  'B12M oversized checkpoint body/identity: admission refuses before any fetch, with stats; projection never selected',
  { skip },
  async (t) => {
    const f = await indexed(t);
    const size = await sizes(f);
    const needed = size.body + size.identity + size.lineage;
    assert.ok(size.identity > 0 && size.lineage > 0);
    const projection = f.store.readProjection(REF)!;
    // An oversized projection body cannot be charged: the metered path never selects it.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(f.store.databasePath);
    t.after(() => db.close());
    const original = db.prepare('SELECT projection_body FROM observation_current').get()!.projection_body!;
    db.prepare('UPDATE observation_current SET projection_body=?').run(
      String(original).slice(0, -1) + `,"zzSyntheticPad":"${'p'.repeat(1024 * 1024)}"}`
    );

    // One byte short of body + identity + index lineage: a typed continuation and zero payload bytes read.
    const short = new RecoveryGrant({ maxBytes: needed - 1, maxRecords: 10, budgetMs: 1000 });
    const refused = f.store.readRecoveryMetered(projection, short);
    assert.equal(refused.kind, 'continuation');
    assert.deepEqual(refused.kind === 'continuation' && refused.continuation, {
      kind: 'record_needs_larger_slice',
      minimumBytes: needed,
    });
    assert.equal(refused.stats.bytesRead, 0);
    assert.equal(refused.stats.recordsRead, 0);
    assert.ok(refused.stats.elapsedMs >= 0);
    assert.deepEqual(short.charged, refused.stats);
    assert.equal(short.remaining().maxBytes, needed - 1);

    // A body that alone fits but whose identity does not still refuses (identity is admitted too).
    const bodyOnly = new RecoveryGrant({ maxBytes: size.body, maxRecords: 10, budgetMs: 1000 });
    const second = f.store.readRecoveryMetered(projection, bodyOnly);
    assert.equal(second.kind, 'continuation');
    assert.equal(second.stats.bytesRead, 0);

    // A corrupt body that does not fit is not even decoded: proof that no fetch happened.
    const body = db.prepare('SELECT body FROM checkpoint_blobs').get()!.body!;
    db.prepare('UPDATE checkpoint_blobs SET body=?').run('{' + ' '.repeat(Buffer.byteLength(String(body)) - 2) + '}');
    assert.equal(f.store.readRecoveryMetered(projection, short).kind, 'continuation');
    assert.throws(() => f.store.readRecovery(projection, BUDGET));
    db.prepare('UPDATE checkpoint_blobs SET body=?').run(body);

    // Exact fit: recovered, charged exactly the probed payload bytes and one record.
    const exact = new RecoveryGrant({ maxBytes: needed, maxRecords: 10, budgetMs: 1000 });
    const recovered = f.store.readRecoveryMetered(projection, exact);
    assert.equal(recovered.kind, 'recovered');
    assert.equal(recovered.stats.bytesRead, needed);
    assert.equal(recovered.stats.recordsRead, 1);
    assert.equal(exact.remaining().maxBytes, 0);
    assert.deepEqual(exact.drain(), recovered.stats);
    assert.deepEqual(exact.drain(), { bytesRead: 0, recordsRead: 0, elapsedMs: 0 });
    // The metered recovery equals the legacy recovery (same enumerable data, same lookup reads).
    const legacy = f.store.readRecovery(projection, BUDGET) as ObservationRecovery;
    db.prepare('UPDATE observation_current SET projection_body=?').run(original);
    assert.equal(recovered.kind === 'recovered' && JSON.stringify(recovered.recovery), JSON.stringify(legacy));

    // Exhausted records or time: catching-up continuation, stats still reported and charged once.
    const noRecords = new RecoveryGrant({ maxBytes: needed, maxRecords: 0, budgetMs: 1000 });
    const catching = f.store.readRecoveryMetered(projection, noRecords);
    assert.equal(catching.kind === 'continuation' && catching.continuation.kind, 'recovery_catching_up');
    assert.deepEqual(noRecords.charged, catching.stats);
    const clock = tickingClock();
    const late = new RecoveryGrant({ maxBytes: needed, maxRecords: 1, budgetMs: 0 }, { now: clock.now });
    const expired = f.store.readRecoveryMetered(projection, late);
    assert.equal(expired.kind === 'continuation' && expired.continuation.kind, 'recovery_catching_up');
    assert.equal(expired.stats.bytesRead, 0);
    assert.ok(expired.stats.elapsedMs > 0);

    // An oversized single index value: refused with minimumBytes, nothing fetched.
    const lookup = (recovered as { recovery: ObservationRecovery }).recovery.checkpoint.recoveryIndex!.lookup!;
    const small = new RecoveryGrant({ maxBytes: 1024, maxRecords: 10, budgetMs: 1000 });
    const big = lookup.getMetered!(small, 'synthetic.big', 'large');
    assert.equal(big.kind, 'refused');
    assert.equal(big.kind === 'refused' && big.reason, 'bytes');
    assert.equal(big.kind === 'refused' && big.minimumBytes, Buffer.byteLength(JSON.stringify('y'.repeat(4096))));
    assert.equal(big.stats.bytesRead, 0);
    const page = lookup.pageMetered!(small, 'synthetic.ids', null, 128);
    assert.equal(page.kind, 'refused');
    assert.ok(page.kind === 'refused' && page.minimumBytes! > 1024);
    assert.equal(page.stats.bytesRead, 0);
    assert.equal(small.remaining().maxBytes, 1024);
    const fits = lookup.getMetered!(small, 'synthetic.ids', '00003');
    assert.deepEqual(fits.kind === 'value' && fits.value, JSON.stringify({ n: 3, pad: 'xxx' }));
    assert.equal(fits.stats.bytesRead, Buffer.byteLength(JSON.stringify({ n: 3, pad: 'xxx' })));
    assert.equal(fits.stats.recordsRead, 1);
  }
);

test('B12M deadline inside page(): stops at the deadline with stats and no partial page', { skip }, async (t) => {
  const f = await indexed(t);
  const lookup = f.acks[0];
  // Every grant clock read advances 1 ms; 128 size-probe rows consume ~130 ms, so the deadline falls in the fetch.
  const clock = tickingClock();
  const grant = new RecoveryGrant(BUDGET, { now: clock.now, deadline: 1000 + 200 });
  const result = lookup.pageMetered!(grant, 'synthetic.ids', null, 128);
  assert.equal(result.kind, 'refused');
  assert.equal(result.kind === 'refused' && result.reason, 'deadline');
  assert.equal('value' in result, false);
  assert.ok(result.stats.recordsRead > 0 && result.stats.recordsRead < 128, String(result.stats.recordsRead));
  assert.ok(result.stats.bytesRead > 0);
  assert.ok(result.stats.elapsedMs >= 128);
  assert.deepEqual(grant.charged, result.stats);
  assert.ok(clock.peek() <= 1000 + 200 + 3, 'no row is fetched after the deadline');
  // A deadline hit inside the size probe stops there, before any payload is fetched.
  const early = tickingClock();
  const probeGrant = new RecoveryGrant(BUDGET, { now: early.now, deadline: 1000 + 40 });
  const probed = lookup.pageMetered!(probeGrant, 'synthetic.ids', null, 128);
  assert.equal(probed.kind === 'refused' && probed.reason, 'deadline');
  assert.equal(probed.stats.bytesRead, 0);
  // The legacy page() under the same kind of grant throws instead of returning a short page that looks final.
  const legacyClock = tickingClock();
  const end = f.store.activateRecoveryGrant(new RecoveryGrant(BUDGET, { now: legacyClock.now, deadline: 1000 + 200 }));
  assert.throws(
    () => [...f.overlay.entries('synthetic.ids')],
    (error: unknown) =>
      error instanceof RecoveryReadError &&
      error.code === 'recovery_deadline_exceeded' &&
      error.stats.bytesRead > 0 &&
      error.stats.recordsRead > 0
  );
  end();
  assert.equal([...f.overlay.entries('synthetic.ids')].length, 300);
});

test('B12M lookup after a replacing commit: typed stale result, no data from the new commit', { skip }, async (t) => {
  const f = await indexed(t);
  const recovered = f.store.readRecoveryMetered(f.store.readProjection(REF)!, new RecoveryGrant(WIDE));
  assert.equal(recovered.kind, 'recovered');
  const fromRecovery = (recovered as { recovery: ObservationRecovery }).recovery.checkpoint.recoveryIndex!.lookup!;
  const fromAck = f.acks[0];
  const grant = new RecoveryGrant(WIDE);
  const cursor = new RecoveryPageCursor(fromAck, 'synthetic.ids');
  assert.equal(cursor.next(grant).kind, 'value');
  for (const lookup of [fromRecovery, fromAck]) {
    const value = lookup.getMetered!(grant, 'synthetic.ids', '00001');
    assert.equal(value.kind === 'value' && value.value, JSON.stringify({ n: 1, pad: 'x' }));
  }
  // Commit 2 changes key 00001 and deletes 00002.
  f.overlay.set('synthetic.ids', '00001', JSON.stringify('synthetic-new-commit-value'));
  f.overlay.delete('synthetic.ids', '00002');
  const second = commit(2);
  attachRecoveryIndex(second.checkpoint, f.overlay, (lookup) => f.acks.push(lookup));
  f.publish(second);
  assert.equal(cursor.next(grant).kind, 'stale', 'buffered rows cannot cross a replaced head even within one grant');
  assert.equal(cursor.next(new RecoveryGrant(WIDE)).kind, 'stale');
  const before = grant.charged;
  for (const lookup of [fromRecovery, fromAck]) {
    const got = lookup.getMetered!(grant, 'synthetic.ids', '00001');
    assert.equal(got.kind, 'stale');
    assert.equal(got.stats.bytesRead, 0);
    assert.equal(got.stats.recordsRead, 0);
    const page = lookup.pageMetered!(grant, 'synthetic.ids', null, 5);
    assert.equal(page.kind, 'stale');
    assert.equal('value' in page, false);
  }
  assert.equal(grant.charged.bytesRead, before.bytesRead);
  // Under an active grant the legacy get() of a stale lookup throws; it never returns the new commit's value.
  const end = f.store.activateRecoveryGrant(grant);
  assert.throws(
    () => fromAck.get('synthetic.ids', '00001'),
    (error: unknown) => error instanceof RecoveryReadError && error.code === 'recovery_snapshot_stale'
  );
  // The new ACK lookup reads commit 2 (the reader's overlay already switched to it).
  assert.equal(f.acks.length, 2);
  assert.equal(f.acks[1].get('synthetic.ids', '00001'), JSON.stringify('synthetic-new-commit-value'));
  assert.equal(f.overlay.get('synthetic.ids', '00002'), undefined);
  end();
  // A summary-only commit that reuses the same checkpoint still replaces the pinned commit.
  const edge = commit(3);
  edge.checkpoint = second.checkpoint;
  edge.checkpoint.recoveryIndex = undefined;
  attachRecoveryIndex(edge.checkpoint, f.overlay, (lookup) => f.acks.push(lookup));
  f.publish(edge);
  assert.equal(f.acks[1].getMetered!(grant, 'synthetic.ids', '00001').kind, 'stale');
  assert.equal(f.acks[2].getMetered!(grant, 'synthetic.ids', '00001').kind, 'value');
  // A recovery target that is no longer current: typed stale (the legacy null), stats charged.
  const old = recovered.kind === 'recovered' ? recovered.recovery.target : undefined;
  const stale = f.store.readRecoveryMetered({ ...f.store.readProjection(REF)!, ...old! }, new RecoveryGrant(WIDE));
  assert.equal(stale.kind, 'stale');
  assert.equal(stale.stats.bytesRead, 0);
});

test(
  'B12M lazy use after ACK under an active grant is charged once (reader and collector both drain)',
  { skip },
  async (t) => {
    const f = await indexed(t);
    const grant = new RecoveryGrant(WIDE);
    const endFirst = f.store.activateRecoveryGrant(grant);
    // The reader's overlay already holds the ACK lookup; these are ordinary reader-side lazy reads.
    const values = ['00007', '00042', 'absent'].map((key) => f.overlay.get('synthetic.ids', key));
    const readerShare = grant.drain();
    const expectedGets = Buffer.byteLength(values[0]!) + Buffer.byteLength(values[1]!);
    assert.deepEqual([readerShare.bytesRead, readerShare.recordsRead], [expectedGets, 2]);
    const all = [...f.overlay.entries('synthetic.ids')];
    assert.equal(all.length, 300);
    const collectorShare = grant.drain();
    const expectedPages = all.reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0);
    assert.deepEqual([collectorShare.bytesRead, collectorShare.recordsRead], [expectedPages, 300]);
    // Nothing is left to drain, and the shared allowance was reduced exactly once by the sum.
    assert.deepEqual(grant.drain(), { bytesRead: 0, recordsRead: 0, elapsedMs: 0 });
    assert.equal(grant.charged.bytesRead, readerShare.bytesRead + collectorShare.bytesRead);
    assert.equal(grant.charged.recordsRead, 302);
    assert.equal(grant.remaining().maxBytes, BUDGET.maxBytes - expectedGets - expectedPages);
    assert.ok(Math.abs(grant.charged.elapsedMs - (readerShare.elapsedMs + collectorShare.elapsedMs)) < 1e-9);
    // A new collection operation activates a new grant; later lazy use is charged to it, not to the old one.
    endFirst();
    const next = new RecoveryGrant(WIDE);
    const endNext = f.store.activateRecoveryGrant(next);
    f.overlay.get('synthetic.ids', '00001');
    assert.equal(next.charged.recordsRead, 1);
    assert.equal(grant.charged.recordsRead, 302);
    endNext();
    f.overlay.get('synthetic.ids', '00001');
    assert.equal(next.charged.recordsRead, 1);
    // An exhausted shared allowance refuses the lazy read through the legacy API too.
    const tight = new RecoveryGrant({ ...WIDE, maxBytes: 4 });
    const endTight = f.store.activateRecoveryGrant(tight);
    assert.throws(
      () => f.overlay.get('synthetic.ids', '00100'),
      (error: unknown) =>
        error instanceof RecoveryReadError &&
        error.code === 'recovery_budget_exhausted' &&
        error.minimumBytes === Buffer.byteLength(JSON.stringify({ n: 100, pad: 'xx' }))
    );
    assert.equal(tight.charged.bytesRead, 0);
    endTight();
  }
);

test('recovery index admits exact reads and whole pages against the shared record allowance', { skip }, async (t) => {
  const f = await indexed(t);
  const lookup = f.acks[0];
  const grant = new RecoveryGrant({ ...WIDE, maxRecords: 1 });
  const first = lookup.getMetered!(grant, 'synthetic.ids', '00007');
  assert.equal(first.kind, 'value');
  assert.equal(grant.charged.recordsRead, 1);
  const consumedBytes = grant.charged.bytesRead;
  const refused = lookup.getMetered!(grant, 'synthetic.ids', '00042');
  assert.equal(refused.kind, 'refused');
  if (refused.kind === 'refused') {
    assert.equal(refused.reason, 'records');
    assert.equal(refused.minimumBytes, undefined);
    assert.equal(refused.stats.bytesRead, 0);
    assert.equal(refused.stats.recordsRead, 0);
  }
  assert.equal(grant.charged.bytesRead, consumedBytes);
  assert.equal(grant.charged.recordsRead, 1);
  const absent = lookup.getMetered!(grant, 'synthetic.ids', 'absent');
  assert.equal(absent.kind, 'value');
  if (absent.kind === 'value') assert.equal(absent.value, undefined);

  const oneRecord = new RecoveryGrant({ ...WIDE, maxRecords: 1 });
  const page = lookup.pageMetered!(oneRecord, 'synthetic.ids', null, 2);
  assert.equal(page.kind, 'refused');
  if (page.kind === 'refused') {
    assert.equal(page.reason, 'records');
    assert.equal(page.stats.bytesRead, 0);
    assert.equal(page.stats.recordsRead, 0);
  }
  assert.equal(oneRecord.charged.recordsRead, 0, 'no partial page is materialized');
  const exact = new RecoveryGrant({ ...WIDE, maxRecords: 2 });
  const admitted = lookup.pageMetered!(exact, 'synthetic.ids', null, 2);
  assert.equal(admitted.kind, 'value');
  if (admitted.kind === 'value') assert.equal(admitted.value.length, 2);
  assert.equal(exact.charged.recordsRead, 2);
  const empty = lookup.pageMetered!(exact, 'missing-namespace', null, 2);
  assert.equal(empty.kind, 'value');
  if (empty.kind === 'value') assert.deepEqual(empty.value, []);

  const none = new RecoveryGrant({ ...WIDE, maxRecords: 0 });
  const end = f.store.activateRecoveryGrant(none);
  try {
    assert.throws(
      () => f.overlay.get('synthetic.ids', '00001'),
      (error: unknown) =>
        error instanceof RecoveryReadError &&
        error.code === 'recovery_budget_exhausted' &&
        error.minimumBytes === undefined
    );
    assert.equal(none.charged.recordsRead, 0);
  } finally {
    end();
  }
});

test(
  'overlay pages use remaining record allowance without mistaking a short request for end of history',
  { skip },
  async (t) => {
    const f = await indexed(t);
    const grant = new RecoveryGrant({ ...WIDE, maxRecords: 300 });
    const end = f.store.activateRecoveryGrant(grant);
    try {
      const entries = [...f.overlay.entries('synthetic.ids')];
      assert.equal(entries.length, 300);
      assert.equal(entries[299][0], '00299');
      assert.equal(grant.charged.recordsRead, 300);
    } finally {
      end();
    }
    const small = new RecoveryGrant({ ...WIDE, maxRecords: 2 });
    const endSmall = f.store.activateRecoveryGrant(small);
    const seen: string[] = [];
    try {
      assert.throws(() => {
        for (const [key] of f.overlay.entries('synthetic.ids')) seen.push(key);
      }, /recovery_budget_exhausted/);
      assert.deepEqual(seen, ['00000', '00001']);
      assert.equal(small.charged.recordsRead, 2);
    } finally {
      endSmall();
    }
  }
);

test('metered page cursor resumes five SQLite rows across 2/2/1 grants', { skip }, async (t) => {
  const f = await setup(t);
  const overlay = new RecoveryIndexOverlay('synthetic-index-1');
  for (let n = 0; n < 5; n++) overlay.set('synthetic.five', String(n), String(n));
  const acks: RecoveryIndexLookup[] = [];
  const first = commit();
  attachRecoveryIndex(first.checkpoint, overlay, (lookup) => acks.push(lookup));
  f.publish(first);
  const cursor = new RecoveryPageCursor(acks[0], 'synthetic.five');
  const keys: string[] = [];
  for (const count of [2, 2, 1]) {
    const grant = new RecoveryGrant({ ...WIDE, maxRecords: count });
    for (let n = 0; n < count; n++) {
      const result = cursor.next(grant);
      assert.equal(result.kind, 'value');
      if (result.kind === 'value') keys.push(result.value.key);
    }
    assert.equal(grant.charged.recordsRead, count);
  }
  assert.deepEqual(keys, ['0', '1', '2', '3', '4']);
  assert.equal(cursor.next(new RecoveryGrant(WIDE)).kind, 'done');
});

test('RecoverySet.clear resumes SQLite pages without publishing partial deletes', { skip }, async (t) => {
  const f = await setup(t);
  const overlay = new RecoveryIndexOverlay('synthetic-index-1');
  for (let n = 0; n < 5; n++) overlay.set('synthetic.five', String(n), 'true');
  const first = commit();
  attachRecoveryIndex(first.checkpoint, overlay);
  f.publish(first);
  const slice = overlay.fork();
  const map = new RecoveryMap<true>(slice, 'synthetic.five', 5, JSON.stringify, () => true);
  const set = new RecoverySet(map);
  const coordinator = new RecoveryClearCoordinator();
  set.coordinate(coordinator);
  for (let n = 0; n < 2; n++) {
    const grant = new RecoveryGrant({ ...WIDE, maxRecords: 2 });
    coordinator.begin('same-record-and-source', grant);
    assert.throws(() => set.clear(), RecoveryClearPending);
    assert.equal(set.size, 5);
    assert.equal(grant.charged.recordsRead, 2);
    assert.equal(overlay.get('synthetic.five', '0'), 'true');
  }
  const last = new RecoveryGrant({ ...WIDE, maxRecords: 2 });
  coordinator.begin('same-record-and-source', last);
  set.clear();
  assert.equal(set.size, 0);
  assert.equal(last.charged.recordsRead, 1);
  map.commit();
  const completed = slice.commit();
  const second = commit(2);
  attachRecoveryIndex(second.checkpoint, completed);
  f.publish(second);
  assert.deepEqual([...completed.entries('synthetic.five')], []);
});

test('pending RecoverySet.clear refuses a replaced SQLite head', { skip }, async (t) => {
  const f = await indexed(t);
  const slice = f.overlay.fork();
  const map = new RecoveryMap<true>(slice, 'synthetic.ids', 300, JSON.stringify, () => true);
  const set = new RecoverySet(map);
  const coordinator = new RecoveryClearCoordinator();
  set.coordinate(coordinator);
  coordinator.begin('same-record-and-source', new RecoveryGrant({ ...WIDE, maxRecords: 2 }));
  assert.throws(() => set.clear(), RecoveryClearPending);
  f.overlay.set('synthetic.ids', '00000', JSON.stringify('changed'));
  const replacement = commit(2);
  attachRecoveryIndex(replacement.checkpoint, f.overlay);
  f.publish(replacement);
  coordinator.begin('same-record-and-source', new RecoveryGrant({ ...WIDE, maxRecords: 2 }));
  assert.throws(() => set.clear(), /recovery_snapshot_stale/);
  assert.equal(set.size, 300);
  assert.equal(f.overlay.get('synthetic.ids', '00000'), JSON.stringify('changed'));
});

test(
  'B12M grant activation is scoped: no interleaved activation, stale deactivators never clear a live grant, close',
  { skip },
  async (t) => {
    const f = await indexed(t);
    const first = new RecoveryGrant(WIDE);
    const second = new RecoveryGrant(WIDE);
    const endFirst = f.store.activateRecoveryGrant(first);
    // An interleaved collect on the same store is refused and does not re-point the active grant.
    assert.throws(
      () => f.store.activateRecoveryGrant(second),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'recovery_grant_active'
    );
    f.overlay.get('synthetic.ids', '00001');
    assert.deepEqual([first.charged.recordsRead, second.charged.recordsRead], [1, 0]);
    endFirst();
    // Non-LIFO / repeated restore: the first operation's deactivator, called again after a second operation has
    // started, must not clear the second operation's grant (a dead grant must never stay or become active).
    const endSecond = f.store.activateRecoveryGrant(second);
    endFirst();
    f.overlay.get('synthetic.ids', '00002');
    assert.deepEqual([first.charged.recordsRead, second.charged.recordsRead], [1, 1]);
    endSecond();
    endSecond();
    f.overlay.get('synthetic.ids', '00003');
    assert.deepEqual([first.charged.recordsRead, second.charged.recordsRead], [1, 1]);
    // close() drops the active grant; the deactivator (from a collector's finally) is then a silent no-op.
    const third = new RecoveryGrant(WIDE);
    const endThird = f.store.activateRecoveryGrant(third);
    f.store.close();
    assert.doesNotThrow(() => endThird());
    assert.throws(() => f.store.activateRecoveryGrant(third), /observation_store_closed/);
  }
);

test('B12M metered reads inside an open write transaction run in it instead of nesting BEGIN', { skip }, async (t) => {
  const f = await indexed(t);
  const { openObservationStore } = await import('../../src/core/observation-store.js');
  // A second store on the same HUD_HOME whose lease clock performs a metered lookup: #sampleNow runs inside the
  // BEGIN IMMEDIATE of acquire(), so the lookup executes inside an open write transaction.
  const lookupHolder: { lookup?: RecoveryIndexLookup; result?: unknown; error?: unknown } = {};
  let clockNow = 1_700_000_100_000;
  const other = await openObservationStore({
    hudHome: f.root,
    sourceId: REF.sourceId,
    now: () => {
      if (lookupHolder.lookup && lookupHolder.result === undefined && lookupHolder.error === undefined) {
        try {
          lookupHolder.result = lookupHolder.lookup.getMetered!(new RecoveryGrant(WIDE), 'synthetic.ids', '00004');
        } catch (error) {
          lookupHolder.error = error;
        }
      }
      return clockNow++;
    },
  });
  t.after(() => other.close());
  const recovered = other.readRecoveryMetered(other.readProjection(REF)!, new RecoveryGrant(WIDE));
  assert.equal(recovered.kind, 'recovered');
  lookupHolder.lookup = (recovered as { recovery: ObservationRecovery }).recovery.checkpoint.recoveryIndex!.lookup!;
  other.acquire({ ...REF, sessionId: 'synthetic-b12m-other-session' }, 'synthetic-other-reader');
  assert.equal(lookupHolder.error, undefined, String(lookupHolder.error));
  const result = lookupHolder.result as { kind: string; value?: string };
  assert.equal(result.kind, 'value');
  assert.equal(result.value, JSON.stringify({ n: 4, pad: 'xxxx' }));
});

test('B12M a thrown read after partial work still reports and charges the work done', { skip }, async (t) => {
  const f = await indexed(t);
  const size = await sizes(f);
  const projection = f.store.readProjection(REF)!;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(f.store.databasePath);
  t.after(() => db.close());
  const body = String(db.prepare('SELECT body FROM checkpoint_blobs').get()!.body);
  // Same length, invalid content: fetched (admitted), then refused by decoding.
  db.prepare('UPDATE checkpoint_blobs SET body=?').run('{' + ' '.repeat(Buffer.byteLength(body) - 2) + '}');
  const grant = new RecoveryGrant(WIDE);
  assert.throws(
    () => f.store.readRecoveryMetered(projection, grant),
    (error: unknown) => {
      assert.ok(error instanceof RecoveryReadError);
      assert.equal(error.stats.bytesRead, size.body + size.identity);
      assert.equal(error.stats.recordsRead, 0);
      assert.ok(error.cause instanceof Error);
      return true;
    }
  );
  assert.equal(grant.charged.bytesRead, size.body + size.identity);
  assert.deepEqual(grant.drain(), grant.charged);
  // An identity mismatch after fetching is also charged.
  db.prepare('UPDATE checkpoint_blobs SET body=?').run(body);
  const identity = String(db.prepare('SELECT identity FROM checkpoint_blobs').get()!.identity);
  db.prepare('UPDATE checkpoint_blobs SET identity=?').run(identity.replace('"offset":10', '"offset":11'));
  const second = new RecoveryGrant(WIDE);
  assert.throws(
    () => f.store.readRecoveryMetered(projection, second),
    (error: unknown) =>
      error instanceof RecoveryReadError &&
      error.code === 'invalid_recovery_reference' &&
      error.stats.bytesRead === size.body + size.identity
  );
  assert.equal(second.charged.bytesRead, size.body + size.identity);
  db.prepare('UPDATE checkpoint_blobs SET identity=?').run(identity);
  // A row deleted by another connection between the page's size probe and its fetch is still read from the page's
  // single SQLite snapshot: probe, fetch and charge describe one consistent page.
  const victim = db
    .prepare("SELECT rowid AS rid FROM recovery_entries WHERE namespace='synthetic.ids' AND key='00003'")
    .get()!.rid;
  let reads = 0;
  let deleted = false;
  const base = tickingClock();
  const racing = new RecoveryGrant(WIDE, {
    now: () => {
      // Clock reads: grant construction, meter start, the initial deadline check, one per probed row (5), then one
      // per fetched row: the 10th read happens after row 00000 is fetched and before row 00003 is.
      if (++reads === 10) {
        db.prepare('DELETE FROM recovery_entries WHERE rowid=?').run(victim);
        deleted = true;
      }
      return base.now();
    },
  });
  const page = f.acks[0].pageMetered!(racing, 'synthetic.ids', null, 5);
  assert.ok(deleted);
  assert.equal(page.kind === 'value' && page.value.map((entry) => entry.key).join(), '00000,00001,00002,00003,00004');
  assert.equal(racing.charged.recordsRead, 5);
});
