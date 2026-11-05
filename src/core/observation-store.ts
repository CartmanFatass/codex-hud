import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { canonicalJson, digest } from './canonical.js';
import { sessionRefKey, sameSessionRef } from './identity.js';
import { collectResource } from './observation.js';
import {
  COLLECT_LEASE_TTL_MS,
  COLLECT_RENEW_INTERVAL_MS,
  ObservationStoreError,
  requireCollectLease,
  requireLeaseRequest,
} from './collect-lease.js';
import {
  decodePublishedCommit,
  type ObservationCandidate,
  prepareCheckpoint,
  preparedCheckpointData,
  prepareProjectionCandidate,
  checkpointFormat,
  checkpointBoundary,
  decodeCheckpointBody,
  decodeProjectionBody,
} from './checkpoint.js';
import type { PreparedObservationCandidate } from './interfaces/observation-store.js';
import type { ReaderBudget } from './interfaces/harness-adapter.js';
import type {
  CheckpointPreparation,
  CheckpointIdentity,
  PreparedCheckpoint,
  MeteredLookupResult,
  MeteredRecoveryResult,
  ObservationProjection,
  ObservationRecovery,
  ObservationRecoveryTarget,
  RecoveryIndexReference,
  RecoveryIndexLookup,
  RecoveryIndexEntry,
  RecoveryReadGrant,
  RecoveryReadStats,
} from './types/checkpoint.js';
import type { SessionRef } from './types/identity.js';
import type { CollectLease, ObservationCommit, ReaderCheckpoint, ReaderContinuation } from './types/observation.js';

type Row = Record<string, SQLOutputValue>;
/** StatementSync.iterate (Node >=22.13, the store's floor) is missing from the pinned @types/node 20. */
type IterableStatement = { iterate(...params: (string | number | null)[]): IterableIterator<Row> };
const SCHEMA = `
CREATE TABLE collect_leases (
  ref TEXT PRIMARY KEY, holder TEXT, generation INTEGER NOT NULL,
  expires_at REAL NOT NULL, last_now REAL NOT NULL, renewed_at REAL NOT NULL
) STRICT;
CREATE TABLE observation_current (
  ref TEXT PRIMARY KEY, commit_seq INTEGER NOT NULL, source_generation INTEGER NOT NULL,
  reader_version TEXT NOT NULL, seq_domain TEXT NOT NULL, content_digest TEXT NOT NULL,
  projection_body TEXT NOT NULL, file_id TEXT NOT NULL, checkpoint_offset INTEGER NOT NULL,
  checkpoint_id TEXT NOT NULL
) STRICT;
CREATE TABLE checkpoint_blobs (
  id TEXT PRIMARY KEY, body TEXT NOT NULL, identity TEXT NOT NULL, index_lineage TEXT
) STRICT;
CREATE TABLE recovery_indexes (
  id TEXT PRIMARY KEY, ref TEXT NOT NULL, recovery_version TEXT NOT NULL,
  lineage TEXT NOT NULL, revision INTEGER NOT NULL, reference TEXT NOT NULL
) STRICT;
CREATE TABLE recovery_entries (
  lineage TEXT NOT NULL, revision INTEGER NOT NULL, namespace TEXT NOT NULL,
  key TEXT NOT NULL, value TEXT,
  PRIMARY KEY(lineage, namespace, key, revision)
) STRICT;
CREATE INDEX observation_checkpoint ON observation_current(checkpoint_id);
CREATE INDEX checkpoint_index_lineage ON checkpoint_blobs(index_lineage);
CREATE TABLE observation_legacy (
  ref TEXT PRIMARY KEY, commit_seq INTEGER NOT NULL, source_generation INTEGER NOT NULL,
  reader_version TEXT NOT NULL, seq_domain TEXT NOT NULL, content_digest TEXT NOT NULL,
  body TEXT NOT NULL, file_id TEXT NOT NULL, checkpoint_offset INTEGER NOT NULL
) STRICT;
CREATE TABLE retired_readers (ref TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(ref, version)) STRICT;
PRAGMA user_version=2;`;

export interface ObservationStoreOptions {
  /** Explicit HUD_HOME; this library never falls back to a user's live home. */
  hudHome: string;
  sourceId: string;
  readOnly?: boolean;
  /** Epoch clock, sampled again after obtaining the write lock. */
  now?: () => number;
}

export type PublishResult = { changed: boolean; commitSeq: number; bytes: number };
export interface ObservationHead {
  commitSeq: number;
  sourceGeneration: number;
  readerVersion: string;
  seqDomain: string;
}

function validBudget(budget: ReaderBudget): boolean {
  return (
    Number.isSafeInteger(budget.maxBytes) &&
    budget.maxBytes >= 0 &&
    Number.isSafeInteger(budget.maxRecords) &&
    budget.maxRecords >= 0 &&
    Number.isFinite(budget.budgetMs) &&
    budget.budgetMs >= 0
  );
}

/** A metered outcome before its statistics are attached (distributes over the result union). */
type Unmetered<R> = R extends unknown ? Omit<R, 'stats'> : never;

/**
 * B12M: one collection grant. It holds the remaining shared allowance (bytes, records) and an absolute cooperative
 * deadline on a monotonic clock, and accumulates every metered read charged to it. `drain()` returns the work
 * charged since the previous drain, so a reader and a collector that both drain never count the same work twice.
 */
export class RecoveryGrant implements RecoveryReadGrant {
  readonly deadline: number;
  readonly #budget: Readonly<ReaderBudget>;
  readonly #now: () => number;
  #charged = { bytesRead: 0, recordsRead: 0, elapsedMs: 0 };
  #undrained = { bytesRead: 0, recordsRead: 0, elapsedMs: 0 };
  /**
   * @param budget the allowance this grant may still spend; `budgetMs` sets the deadline from now.
   * @param options.deadline an absolute deadline on the same clock, for a grant that shares an existing deadline.
   * @param options.now a monotonic clock in ms (default `performance.now`).
   */
  constructor(budget: ReaderBudget, options: { deadline?: number; now?: () => number } = {}) {
    if (!validBudget(budget) || (options.deadline !== undefined && !Number.isFinite(options.deadline)))
      throw new ObservationStoreError('invalid_recovery_budget');
    this.#budget = Object.freeze({ ...budget });
    this.#now = options.now ?? (() => performance.now());
    this.deadline = options.deadline ?? this.#now() + budget.budgetMs;
  }
  now(): number {
    return this.#now();
  }
  remaining(): ReaderBudget {
    return {
      maxBytes: Math.max(0, this.#budget.maxBytes - this.#charged.bytesRead),
      maxRecords: Math.max(0, this.#budget.maxRecords - this.#charged.recordsRead),
      budgetMs: Math.max(0, this.deadline - this.#now()),
    };
  }
  charge(stats: RecoveryReadStats): void {
    for (const value of [stats.bytesRead, stats.recordsRead, stats.elapsedMs])
      if (!Number.isFinite(value) || value < 0) throw new ObservationStoreError('invalid_recovery_stats');
    for (const total of [this.#charged, this.#undrained]) {
      total.bytesRead += stats.bytesRead;
      total.recordsRead += stats.recordsRead;
      total.elapsedMs += stats.elapsedMs;
    }
  }
  drain(): RecoveryReadStats {
    const drained = Object.freeze(this.#undrained);
    this.#undrained = { bytesRead: 0, recordsRead: 0, elapsedMs: 0 };
    return drained;
  }
  /** Everything charged to this grant so far (drained or not). */
  get charged(): RecoveryReadStats {
    return Object.freeze({ ...this.#charged });
  }
}

/**
 * B12M: a metered read that threw (corrupt body, invalid reference, a refused or stale lazy read reached through the
 * legacy `get`/`page` while a grant is active). `stats` is the work done before the throw; it was already charged.
 */
export class RecoveryReadError extends ObservationStoreError {
  constructor(
    code: string,
    readonly stats: RecoveryReadStats,
    readonly minimumBytes?: number,
    options?: { cause?: unknown }
  ) {
    super(code);
    this.name = 'RecoveryReadError';
    if (options && 'cause' in options) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** The commit a lookup was created for (at recovery or commit ACK). */
interface LookupPin {
  readonly commitSeq: number;
  readonly sourceGeneration: number;
  readonly seqDomain: string;
  readonly checkpointId: string;
}

/** Collects one metered read's statistics and charges them to the grant exactly once. */
class ReadMeter {
  bytesRead = 0;
  recordsRead = 0;
  #charged: RecoveryReadStats | undefined;
  readonly #start: number;
  constructor(readonly grant: RecoveryReadGrant) {
    this.#start = grant.now();
  }
  text(value: SQLOutputValue): string {
    const text = String(value);
    this.bytesRead += Buffer.byteLength(text);
    return text;
  }
  expired(): boolean {
    return this.grant.remaining().budgetMs <= 0;
  }
  finish(): RecoveryReadStats {
    if (!this.#charged) {
      this.#charged = Object.freeze({
        bytesRead: this.bytesRead,
        recordsRead: this.recordsRead,
        elapsedMs: Math.max(0, this.grant.now() - this.#start),
      });
      this.grant.charge(this.#charged);
    }
    return this.#charged;
  }
  fail(error: unknown): RecoveryReadError {
    const stats = this.finish();
    if (error instanceof RecoveryReadError) return error;
    const code = error instanceof ObservationStoreError ? error.code : 'recovery_read_failed';
    return new RecoveryReadError(code, stats, undefined, { cause: error });
  }
}

function privateDirectory(directory: string): void {
  let created = false;
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new ObservationStoreError('observation_directory_not_private');
  if (created) {
    const parent = fs.openSync(path.dirname(directory), 'r');
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  }
}

function privateFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new ObservationStoreError('observation_file_not_private');
}

function verifyWritableSettings(db: DatabaseSync): void {
  if (
    Number(db.prepare('PRAGMA synchronous').get()?.synchronous) !== 2 ||
    Number(db.prepare('PRAGMA secure_delete').get()?.secure_delete) !== 1 ||
    Number(db.prepare('PRAGMA busy_timeout').get()?.timeout) !== 10 ||
    Number(db.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint) !== 1000
  )
    throw new ObservationStoreError('unsupported_observation_durability');
}

/** One source-local WAL + FULL database; legacy caches rebuild before the controlled journal switch. */
export class ObservationStore {
  #closed = false;
  #lastSampledNow = 0;
  #readingSnapshot = false;
  #activeGrant: RecoveryReadGrant | null = null;
  #inTransaction = false;
  #authority = new Map<string, { holder: string; generation: number }>();
  constructor(
    private readonly db: DatabaseSync,
    readonly sourceId: string,
    readonly databasePath: string,
    private readonly readOnly: boolean,
    private readonly now: () => number,
    private readonly unsafeRefs = new Set<string>()
  ) {}

  #key(ref: SessionRef): string {
    if (this.#closed) throw new ObservationStoreError('observation_store_closed');
    if (ref.sourceId !== this.sourceId) throw new ObservationStoreError('observation_source_mismatch');
    return sessionRefKey(ref);
  }

  #transaction<T>(work: () => T): T {
    if (this.readOnly) throw new ObservationStoreError('observation_read_only');
    let begun = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      begun = true;
      this.#inTransaction = true;
      const result = work();
      this.db.exec('COMMIT');
      begun = false;
      return result;
    } catch (error) {
      if (begun) this.db.exec('ROLLBACK');
      if (error instanceof Error && /database (?:is )?(?:locked|busy)/.test(error.message))
        throw new ObservationStoreError('observation_busy');
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }

  #read<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof Error && /database (?:is )?(?:locked|busy)/.test(error.message))
        throw new ObservationStoreError('observation_busy');
      throw error;
    }
  }

  #snapshot<T>(work: () => T): T {
    return this.#read(() => {
      if (this.#readingSnapshot) return work();
      this.db.exec('BEGIN');
      this.#readingSnapshot = true;
      try {
        const result = work();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      } finally {
        this.#readingSnapshot = false;
      }
    });
  }

  /**
   * B12M: one metered read in one read snapshot. Inside an open write transaction it runs in that transaction (no
   * nested BEGIN). The meter is finished after the snapshot's COMMIT, so `elapsedMs` includes it and a throw from
   * COMMIT is still charged.
   */
  #meteredSnapshot<R extends { readonly stats: RecoveryReadStats }>(meter: ReadMeter, work: () => Unmetered<R>): R {
    const result = this.#inTransaction ? this.#read(work) : this.#snapshot(work);
    return { ...result, stats: meter.finish() } as unknown as R;
  }

  #lease(row: Row | undefined, ref: SessionRef): CollectLease | null {
    return row && row.holder !== null
      ? {
          resource: collectResource(ref),
          holder: String(row.holder),
          generation: Number(row.generation),
          expires_at: Number(row.expires_at),
        }
      : null;
  }

  #sampleNow(persistedLowerBound: number): number {
    const now = this.now();
    if (!Number.isFinite(now) || now < Math.max(this.#lastSampledNow, persistedLowerBound))
      throw new ObservationStoreError('lease_time_unknown');
    // No-op ticks and refused expiry checks must not forget an observed clock
    // advance, even though they intentionally perform no persistent write.
    this.#lastSampledNow = now;
    return now;
  }

  #requireHeld(key: string, ref: SessionRef, lease: CollectLease): { row: Row; now: number } {
    const authority = this.#authority.get(key);
    if (!authority || authority.holder !== lease.holder || authority.generation !== lease.generation)
      throw new ObservationStoreError('lease_fenced');
    if (lease.resource !== collectResource(ref)) throw new ObservationStoreError('lease_fenced');
    const row = this.db.prepare('SELECT * FROM collect_leases WHERE ref=?').get(key);
    const now = this.#sampleNow(Number(row?.last_now ?? 0));
    requireCollectLease(this.#lease(row, ref), ref, lease.holder, lease.generation, now, Number(row?.last_now ?? 0));
    return { row: row!, now };
  }

  acquire(ref: SessionRef, holder: string, ttlMs = COLLECT_LEASE_TTL_MS): CollectLease {
    const key = this.#key(ref);
    requireLeaseRequest(holder, ttlMs);
    const lease = this.#transaction(() => {
      const row = this.db.prepare('SELECT * FROM collect_leases WHERE ref=?').get(key);
      const now = this.#sampleNow(Number(row?.last_now ?? 0));
      if (row?.holder !== null && row !== undefined && now < Number(row.expires_at))
        throw new ObservationStoreError('lease_held');
      const generation = Number(row?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new ObservationStoreError('lease_generation_exhausted');
      const lease = { resource: collectResource(ref), holder, generation, expires_at: now + ttlMs };
      this.db
        .prepare(
          'INSERT INTO collect_leases VALUES(?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET holder=excluded.holder, generation=excluded.generation, expires_at=excluded.expires_at, last_now=excluded.last_now, renewed_at=excluded.renewed_at'
        )
        .run(key, holder, generation, lease.expires_at, now, now);
      return lease;
    });
    // Only this instance's successful generation-bumping CAS grants authority.
    // Reopening a store never inherits a held lease, even for the same holder.
    this.#authority.set(key, { holder: lease.holder, generation: lease.generation });
    return lease;
  }

  renew(ref: SessionRef, lease: CollectLease, ttlMs = COLLECT_LEASE_TTL_MS): CollectLease {
    const key = this.#key(ref);
    requireLeaseRequest(lease.holder, ttlMs);
    return this.#transaction(() => {
      const { row, now } = this.#requireHeld(key, ref, lease);
      if (now - Number(row.renewed_at) < COLLECT_RENEW_INTERVAL_MS) return this.#lease(row, ref)!;
      const expires_at = Math.max(Number(row.expires_at), now + ttlMs);
      this.db
        .prepare('UPDATE collect_leases SET expires_at=?, last_now=?, renewed_at=? WHERE ref=?')
        .run(expires_at, now, now, key);
      return { ...this.#lease(row, ref)!, expires_at };
    });
  }

  release(ref: SessionRef, lease: CollectLease): void {
    const key = this.#key(ref);
    this.#transaction(() => {
      const { now } = this.#requireHeld(key, ref, lease);
      this.db.prepare('UPDATE collect_leases SET holder=NULL, expires_at=0, last_now=? WHERE ref=?').run(now, key);
    });
    this.#authority.delete(key);
  }

  readLease(ref: SessionRef): CollectLease | null {
    const key = this.#key(ref);
    return this.#read(() => this.#lease(this.db.prepare('SELECT * FROM collect_leases WHERE ref=?').get(key), ref));
  }

  /** Cheap, read-only projection: this query never selects checkpoint or index bodies. */
  readProjection(ref: SessionRef): ObservationProjection | null {
    const key = this.#key(ref);
    const row = this.#read(() =>
      this.db.prepare('SELECT projection_body FROM observation_current WHERE ref=?').get(key)
    );
    if (!row) return null;
    return decodeProjectionBody(String(row.projection_body), ref);
  }

  #indexRow(reference: RecoveryIndexReference): Row {
    const row = this.db.prepare('SELECT * FROM recovery_indexes WHERE id=?').get(reference.indexId);
    if (!row || row.reference !== canonicalJson(reference) || row.ref !== this.#key(reference.boundary.ref))
      throw new ObservationStoreError('invalid_recovery_reference');
    return row;
  }

  /**
   * B12M: lazy `get`/`page` calls on lookups created by this store are admitted against and charged to this grant
   * while it is active; refusals and stale pins then throw RecoveryReadError. With no active grant (the default) they
   * keep the unmetered pre-B12M behaviour.
   *
   * Scoped: at most one grant is active per store (one collection operation at a time on one store; interleaved
   * collects on one store are refused with `recovery_grant_active`, never silently re-pointed). The returned
   * deactivator ends exactly this activation: it is idempotent, a no-op after `close()`, and throws
   * `recovery_grant_mismatch` rather than clearing a grant it did not activate.
   */
  activateRecoveryGrant(grant: RecoveryReadGrant): () => void {
    if (this.#closed) throw new ObservationStoreError('observation_store_closed');
    if (this.#activeGrant !== null) throw new ObservationStoreError('recovery_grant_active');
    this.#activeGrant = grant;
    let ended = false;
    return () => {
      if (ended || this.#closed) {
        ended = true;
        return;
      }
      if (this.#activeGrant !== grant) throw new ObservationStoreError('recovery_grant_mismatch');
      ended = true;
      this.#activeGrant = null;
    };
  }

  /** Is the pinned commit still the current commit of its session? Evaluated in SQLite: no payload is fetched. */
  #pinCurrent(key: string, pin: LookupPin): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 AS current FROM observation_current WHERE ref=? AND commit_seq=? AND source_generation=? AND seq_domain=? AND checkpoint_id=?'
        )
        .get(key, pin.commitSeq, pin.sourceGeneration, pin.seqDomain, pin.checkpointId) !== undefined
    );
  }

  /** Revalidate an exact recovered checkpoint and this instance's held lease without renewing either. */
  recoveryAuthorityCurrent(target: ObservationRecoveryTarget, lease: CollectLease): boolean {
    const key = this.#key(target.ref);
    const authority = this.#authority.get(key);
    if (
      !authority ||
      authority.holder !== lease.holder ||
      authority.generation !== lease.generation ||
      lease.resource !== collectResource(target.ref)
    )
      return false;
    const now = this.#sampleNow(0);
    if (!Number.isFinite(lease.expires_at) || now >= lease.expires_at) return false;
    return this.#read(
      () =>
        this.db
          .prepare(
            `
      SELECT 1 AS current FROM observation_current c JOIN collect_leases l ON l.ref=c.ref
      WHERE c.ref=? AND c.commit_seq=? AND c.source_generation=? AND c.seq_domain=? AND c.checkpoint_id=?
        AND l.holder=? AND l.generation=? AND l.expires_at=? AND l.expires_at>? AND l.last_now<=?
    `
          )
          .get(
            key,
            target.commitSeq,
            target.sourceGeneration,
            target.seqDomain,
            target.checkpointIdentity.contentIdentity,
            lease.holder,
            lease.generation,
            lease.expires_at,
            now,
            now
          ) !== undefined
    );
  }

  #lookup(reference: RecoveryIndexReference, pin: LookupPin): RecoveryIndexLookup {
    // Detached identity prevents a caller from moving a lookup to a later boundary.
    const pinned = JSON.parse(canonicalJson(reference)) as RecoveryIndexReference;
    const row = this.#indexRow(pinned);
    return this.#pinnedLookup(pinned, String(row.lineage), Number(row.revision), pin);
  }

  #pinnedLookup(
    pinned: RecoveryIndexReference,
    lineage: string,
    revision: number,
    pin: LookupPin
  ): RecoveryIndexLookup {
    const frozenPin: LookupPin = Object.freeze({ ...pin });
    // Pre-B12M behaviour, unchanged: used while no grant is active on this store.
    const legacyGet = (namespace: string, key: string): string | undefined => {
      this.#key(pinned.boundary.ref);
      const entry = this.#read(() =>
        this.db
          .prepare(
            `SELECT i.id, (SELECT e.value FROM recovery_entries e WHERE e.lineage=i.lineage AND e.namespace=? AND e.key=? AND e.revision<=i.revision ORDER BY e.revision DESC LIMIT 1) AS value FROM recovery_indexes i WHERE i.id=?`
          )
          .get(namespace, key, pinned.indexId)
      );
      if (!entry) throw new ObservationStoreError('recovery_snapshot_retired');
      return entry.value == null ? undefined : String(entry.value);
    };
    const legacyPage = (namespace: string, after: string | null, limit: number): readonly RecoveryIndexEntry[] => {
      this.#key(pinned.boundary.ref);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
        throw new ObservationStoreError('invalid_recovery_budget');
      return this.#snapshot(() => {
        this.#indexRow(pinned);
        const entries = this.db
          .prepare(
            `
          SELECT e.key, e.value FROM recovery_entries e
          WHERE e.lineage=? AND e.namespace=? AND e.key>? AND e.revision<=?
            AND e.revision=(SELECT MAX(n.revision) FROM recovery_entries n
              WHERE n.lineage=e.lineage AND n.namespace=e.namespace AND n.key=e.key AND n.revision<=?)
            AND e.value IS NOT NULL ORDER BY e.key LIMIT ?
        `
          )
          .all(lineage, namespace, after ?? '', revision, revision, limit);
        return entries.map((entry) => ({ namespace, key: String(entry.key), value: String(entry.value) }));
      });
    };
    const unwrap = <T>(result: MeteredLookupResult<T>): T => {
      if (result.kind === 'value') return result.value;
      if (result.kind === 'stale') throw new RecoveryReadError('recovery_snapshot_stale', result.stats);
      throw new RecoveryReadError(
        result.reason === 'deadline' ? 'recovery_deadline_exceeded' : 'recovery_budget_exhausted',
        result.stats,
        result.minimumBytes
      );
    };
    const getMetered = (
      grant: RecoveryReadGrant,
      namespace: string,
      key: string
    ): MeteredLookupResult<string | undefined> => {
      const meter = new ReadMeter(grant);
      try {
        const ref = this.#key(pinned.boundary.ref);
        if (meter.expired()) return { kind: 'refused', reason: 'deadline', stats: meter.finish() };
        return this.#meteredSnapshot<MeteredLookupResult<string | undefined>>(
          meter,
          (): Unmetered<MeteredLookupResult<string | undefined>> => {
            if (!this.#pinCurrent(ref, frozenPin)) return { kind: 'stale' };
            if (!this.db.prepare('SELECT 1 AS present FROM recovery_indexes WHERE id=?').get(pinned.indexId))
              throw new ObservationStoreError('recovery_snapshot_retired');
            // Size probe: the visible revision's rowid and payload length; the value itself is not selected.
            const probe = this.db
              .prepare(
                'SELECT rowid AS rid, value IS NULL AS absent, octet_length(value) AS n FROM recovery_entries WHERE lineage=? AND namespace=? AND key=? AND revision<=? ORDER BY revision DESC LIMIT 1'
              )
              .get(lineage, namespace, key, revision);
            if (!probe || Number(probe.absent) === 1) return { kind: 'value', value: undefined };
            const needed = Number(probe.n);
            if (needed > grant.remaining().maxBytes) return { kind: 'refused', reason: 'bytes', minimumBytes: needed };
            if (meter.expired()) return { kind: 'refused', reason: 'deadline' };
            const row = this.db.prepare('SELECT value FROM recovery_entries WHERE rowid=?').get(probe.rid);
            if (!row) throw new ObservationStoreError('recovery_snapshot_retired');
            const value = meter.text(row.value);
            meter.recordsRead++;
            return { kind: 'value', value };
          }
        );
      } catch (error) {
        throw meter.fail(error);
      }
    };
    const pageMetered = (
      grant: RecoveryReadGrant,
      namespace: string,
      after: string | null,
      limit: number
    ): MeteredLookupResult<readonly RecoveryIndexEntry[]> => {
      const meter = new ReadMeter(grant);
      try {
        const ref = this.#key(pinned.boundary.ref);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
          throw new ObservationStoreError('invalid_recovery_budget');
        if (meter.expired()) return { kind: 'refused', reason: 'deadline', stats: meter.finish() };
        return this.#meteredSnapshot<MeteredLookupResult<readonly RecoveryIndexEntry[]>>(
          meter,
          (): Unmetered<MeteredLookupResult<readonly RecoveryIndexEntry[]>> => {
            if (!this.#pinCurrent(ref, frozenPin)) return { kind: 'stale' };
            if (!this.db.prepare('SELECT 1 AS present FROM recovery_indexes WHERE id=?').get(pinned.indexId))
              throw new ObservationStoreError('invalid_recovery_reference');
            // Phase 1, size probe: the page's rowids and payload lengths in key order; no key or value is selected.
            const rowids: number[] = [];
            let needed = 0;
            const sizes = this.db.prepare(
              `
          SELECT e.rowid AS rid, octet_length(e.key) + octet_length(e.value) AS n FROM recovery_entries e
          WHERE e.lineage=? AND e.namespace=? AND e.key>? AND e.revision<=?
            AND e.revision=(SELECT MAX(n.revision) FROM recovery_entries n
              WHERE n.lineage=e.lineage AND n.namespace=e.namespace AND n.key=e.key AND n.revision<=?)
            AND e.value IS NOT NULL ORDER BY e.key LIMIT ?
        `
            ) as unknown as IterableStatement;
            for (const row of sizes.iterate(lineage, namespace, after ?? '', revision, revision, limit)) {
              if (meter.expired()) return { kind: 'refused', reason: 'deadline' };
              rowids.push(Number(row.rid));
              needed += Number(row.n);
            }
            if (needed > grant.remaining().maxBytes) return { kind: 'refused', reason: 'bytes', minimumBytes: needed };
            // Phase 2: fetch the admitted rows in key order; at the deadline, stop and discard the partial page.
            const entries: RecoveryIndexEntry[] = [];
            const fetch = this.db.prepare('SELECT key, value FROM recovery_entries WHERE rowid=?');
            for (const rid of rowids) {
              if (meter.expired()) return { kind: 'refused', reason: 'deadline' };
              const row = fetch.get(rid);
              if (!row) throw new ObservationStoreError('invalid_recovery_reference');
              entries.push({ namespace, key: meter.text(row.key), value: meter.text(row.value) });
              meter.recordsRead++;
            }
            return { kind: 'value', value: entries };
          }
        );
      } catch (error) {
        throw meter.fail(error);
      }
    };
    const lookup: RecoveryIndexLookup = {
      reference: pinned,
      get: (namespace, key) => {
        const grant = this.#activeGrant;
        return grant ? unwrap(getMetered(grant, namespace, key)) : legacyGet(namespace, key);
      },
      page: (namespace, after, limit) => {
        const grant = this.#activeGrant;
        return grant ? unwrap(pageMetered(grant, namespace, after, limit)) : legacyPage(namespace, after, limit);
      },
      getMetered,
      pageMetered,
    };
    Object.freeze(pinned.boundary.ref);
    Object.freeze(pinned.boundary.fileId);
    Object.freeze(pinned.boundary);
    Object.freeze(pinned);
    return Object.freeze(lookup);
  }

  /** One bounded inline blob plus exact lazy metadata lookup, pinned to the requested commit. */
  readRecovery(
    target: ObservationRecoveryTarget,
    budget: ReaderBudget
  ): ObservationRecovery | ReaderContinuation | null {
    const selected: ObservationRecoveryTarget = JSON.parse(
      canonicalJson({
        ref: target.ref,
        sourceGeneration: target.sourceGeneration,
        seqDomain: target.seqDomain,
        commitSeq: target.commitSeq,
        checkpointIdentity: target.checkpointIdentity,
      })
    );
    const key = this.#key(selected.ref);
    if (
      !Number.isSafeInteger(budget.maxBytes) ||
      budget.maxBytes < 0 ||
      !Number.isSafeInteger(budget.maxRecords) ||
      budget.maxRecords < 0 ||
      !Number.isFinite(budget.budgetMs) ||
      budget.budgetMs < 0
    )
      throw new ObservationStoreError('invalid_recovery_budget');
    if (budget.budgetMs === 0 || budget.maxRecords === 0)
      return {
        kind: 'recovery_catching_up',
        coverage: { state: 'catching_up', loaded: false, skipped: {}, gaps: [], reason: 'recovery_budget_exhausted' },
      };
    return this.#snapshot(() => {
      // A single SELECT pins projection and recovery to the same SQLite snapshot.
      const row = this.db
        .prepare(
          `SELECT c.projection_body, b.body, b.identity
        FROM observation_current c JOIN checkpoint_blobs b ON b.id=c.checkpoint_id
        WHERE c.ref=? AND c.commit_seq=? AND c.source_generation=? AND c.seq_domain=? AND c.checkpoint_id=?`
        )
        .get(
          key,
          selected.commitSeq,
          selected.sourceGeneration,
          selected.seqDomain,
          selected.checkpointIdentity.contentIdentity
        );
      if (!row) return null;
      if (row.identity !== canonicalJson(selected.checkpointIdentity))
        throw new ObservationStoreError('invalid_recovery_reference');
      const body = String(row.body);
      if (Buffer.byteLength(body) > budget.maxBytes)
        return { kind: 'record_needs_larger_slice', minimumBytes: Buffer.byteLength(body) };
      const checkpoint = decodeCheckpointBody(body, selected.checkpointIdentity);
      const references = selected.checkpointIdentity.recoveryReferences;
      if (references.length) {
        const lookup = this.#lookup(references[0], {
          commitSeq: selected.commitSeq,
          sourceGeneration: selected.sourceGeneration,
          seqDomain: selected.seqDomain,
          checkpointId: selected.checkpointIdentity.contentIdentity,
        });
        const handoff = {
          delta: { recoveryVersion: references[0].recoveryVersion, base: lookup.reference, entries: [] },
        };
        Object.defineProperty(handoff, 'lookup', { value: lookup });
        checkpoint.recoveryIndex = handoff;
      }
      return {
        target: JSON.parse(canonicalJson(selected)) as ObservationRecoveryTarget,
        checkpoint,
        recoveryReferences: JSON.parse(canonicalJson(references)) as RecoveryIndexReference[],
      };
    });
  }

  /**
   * B12M: metered readRecovery. It size-probes the checkpoint body, identity and index lineage of the exact target
   * before selecting any of them (the projection body is never selected), admits the recovery against the grant's
   * remaining bytes, records and deadline, and charges the grant exactly once on every outcome. A recovery that does
   * not fit is a continuation, never a partial read. A throw after work is a RecoveryReadError carrying the stats.
   * The returned lookup is pinned to the target commit.
   */
  readRecoveryMetered(target: ObservationRecoveryTarget, grant: RecoveryReadGrant): MeteredRecoveryResult {
    const meter = new ReadMeter(grant);
    try {
      const selected: ObservationRecoveryTarget = JSON.parse(
        canonicalJson({
          ref: target.ref,
          sourceGeneration: target.sourceGeneration,
          seqDomain: target.seqDomain,
          commitSeq: target.commitSeq,
          checkpointIdentity: target.checkpointIdentity,
        })
      );
      const key = this.#key(selected.ref);
      const catchingUp: Unmetered<MeteredRecoveryResult> = {
        kind: 'continuation',
        continuation: {
          kind: 'recovery_catching_up',
          coverage: { state: 'catching_up', loaded: false, skipped: {}, gaps: [], reason: 'recovery_budget_exhausted' },
        },
      };
      const start = grant.remaining();
      if (start.budgetMs <= 0 || start.maxRecords < 1) return { ...catchingUp, stats: meter.finish() };
      const references = selected.checkpointIdentity.recoveryReferences;
      const reference = references[0];
      const where =
        'WHERE c.ref=? AND c.commit_seq=? AND c.source_generation=? AND c.seq_domain=? AND c.checkpoint_id=?';
      const args = [
        key,
        selected.commitSeq,
        selected.sourceGeneration,
        selected.seqDomain,
        selected.checkpointIdentity.contentIdentity,
      ] as const;
      return this.#meteredSnapshot<MeteredRecoveryResult>(meter, (): Unmetered<MeteredRecoveryResult> => {
        // Admission: payload sizes only. One snapshot pins the probe, the fetch and the index row to one commit.
        const probe = this.db
          .prepare(
            `SELECT octet_length(b.body) AS body, octet_length(b.identity) AS identity,
              (SELECT octet_length(i.lineage) FROM recovery_indexes i WHERE i.id=?) AS lineage
            FROM observation_current c JOIN checkpoint_blobs b ON b.id=c.checkpoint_id ${where}`
          )
          .get(reference?.indexId ?? null, ...args);
        if (!probe) return { kind: 'stale' };
        const needed = Number(probe.body) + Number(probe.identity) + (reference ? Number(probe.lineage ?? 0) : 0);
        const remaining = grant.remaining();
        if (needed > remaining.maxBytes)
          return {
            kind: 'continuation',
            continuation: { kind: 'record_needs_larger_slice', minimumBytes: needed },
          };
        if (remaining.budgetMs <= 0) return catchingUp;
        const row = this.db
          .prepare(
            `SELECT b.body, b.identity FROM observation_current c JOIN checkpoint_blobs b ON b.id=c.checkpoint_id ${where}`
          )
          .get(...args);
        if (!row) return { kind: 'stale' };
        const identity = meter.text(row.identity);
        const body = meter.text(row.body);
        if (identity !== canonicalJson(selected.checkpointIdentity))
          throw new ObservationStoreError('invalid_recovery_reference');
        const checkpoint = decodeCheckpointBody(body, selected.checkpointIdentity);
        if (reference) {
          const pinned = JSON.parse(canonicalJson(reference)) as RecoveryIndexReference;
          // The reference and its session are compared inside SQLite; only the lineage id is materialized.
          const index = this.db
            .prepare('SELECT lineage, revision FROM recovery_indexes WHERE id=? AND reference=? AND ref=?')
            .get(pinned.indexId, canonicalJson(pinned), this.#key(pinned.boundary.ref));
          if (!index) throw new ObservationStoreError('invalid_recovery_reference');
          const lookup = this.#pinnedLookup(pinned, meter.text(index.lineage), Number(index.revision), {
            commitSeq: selected.commitSeq,
            sourceGeneration: selected.sourceGeneration,
            seqDomain: selected.seqDomain,
            checkpointId: selected.checkpointIdentity.contentIdentity,
          });
          const handoff = {
            delta: { recoveryVersion: reference.recoveryVersion, base: lookup.reference, entries: [] },
          };
          Object.defineProperty(handoff, 'lookup', { value: lookup });
          checkpoint.recoveryIndex = handoff;
        }
        meter.recordsRead = 1;
        return {
          kind: 'recovered',
          recovery: {
            target: JSON.parse(canonicalJson(selected)) as ObservationRecoveryTarget,
            checkpoint,
            recoveryReferences: JSON.parse(canonicalJson(references)) as RecoveryIndexReference[],
          },
        };
      });
    } catch (error) {
      throw meter.fail(error);
    }
  }

  /** Compatibility only. Status/wait/paint callers use readProjection. */
  readCurrent(ref: SessionRef): ObservationCommit | null {
    this.#key(ref);
    return this.#snapshot(() => {
      const projection = this.readProjection(ref);
      if (!projection) {
        const row = this.#read(() =>
          this.db.prepare('SELECT body FROM observation_legacy WHERE ref=?').get(this.#key(ref))
        );
        return row ? decodePublishedCommit(String(row.body), ref) : null;
      }
      const recovery = this.readRecovery(projection, { maxBytes: 256 * 1024, maxRecords: 1, budgetMs: 20 });
      if (!recovery || 'kind' in recovery) throw new ObservationStoreError('observation_recovery_unavailable');
      const { checkpointIdentity: _identity, ...commit } = projection;
      return { ...commit, checkpoint: recovery.checkpoint, notices: [...projection.notices] };
    });
  }

  readHead(ref: SessionRef): ObservationHead | null {
    const key = this.#key(ref);
    const row = this.#read(() =>
      this.db
        .prepare(
          `
      SELECT commit_seq, source_generation, reader_version, seq_domain FROM observation_current WHERE ref=?
      UNION ALL SELECT commit_seq, source_generation, reader_version, seq_domain FROM observation_legacy WHERE ref=? LIMIT 1
    `
        )
        .get(key, key)
    );
    return row
      ? {
          commitSeq: Number(row.commit_seq),
          sourceGeneration: Number(row.source_generation),
          readerVersion: String(row.reader_version),
          seqDomain: String(row.seq_domain),
        }
      : null;
  }

  prepareCheckpoint(input: CheckpointPreparation): PreparedCheckpoint {
    this.#key(input.checkpoint.ref);
    const handoff = input.checkpoint.recoveryIndex;
    for (const reference of input.recoveryReferences) this.#indexRow(reference);
    if (handoff?.delta.base) {
      this.#indexRow(handoff.delta.base);
      if (
        handoff.delta.base.recoveryVersion !== handoff.delta.recoveryVersion ||
        !sameSessionRef(handoff.delta.base.boundary.ref, input.checkpoint.ref) ||
        handoff.delta.base.boundary.sourceGeneration > input.checkpoint.sourceGeneration
      )
        throw new ObservationStoreError('invalid_recovery_reference');
    }
    return prepareCheckpoint(input);
  }

  /** Legacy caller bridge; new collectors retain a prepared token for unchanged recovery. */
  publish(candidate: ObservationCandidate, lease: CollectLease): PublishResult {
    const handoff = candidate.commit.checkpoint.recoveryIndex;
    // Preserve the original witness checks before replacing its checkpoint digest with trusted identity.
    const expected = digest(candidate.commit.checkpoint);
    if (candidate.boundary.checkpointDigest !== expected)
      throw new ObservationStoreError('observation_boundary_mismatch');
    const token = this.prepareCheckpoint({
      checkpoint: candidate.commit.checkpoint,
      boundary: candidate.boundary.checkpointBoundary,
      format: checkpointFormat(candidate.commit.checkpoint),
      recoveryReferences: handoff?.delta.base ? [handoff.delta.base] : [],
    });
    const { checkpoint: _checkpoint, ...commit } = candidate.commit;
    return this.publishPrepared(
      {
        ...candidate,
        commit,
        checkpoint: token,
        boundary: { ...candidate.boundary, checkpointDigest: token.identity.contentIdentity },
      },
      lease
    );
  }

  /** Lease, CAS, lineage, index changes, blob and projection are checked/committed as one fenced transaction. */
  publishPrepared(candidate: PreparedObservationCandidate, lease: CollectLease): PublishResult {
    const prepared = prepareProjectionCandidate(candidate);
    const { commit, data } = prepared;
    const checkpoint = data.checkpoint;
    const key = this.#key(commit.ref);
    // Migration-only guard. Authority and the actual rebuild remain checked by the existing fenced transaction.
    if (this.unsafeRefs.has(key) && prepared.rebuildFromReaderVersion === undefined)
      throw new ObservationStoreError('observation_rebuild_required');
    if (commit.leaseGeneration !== lease.generation) throw new ObservationStoreError('lease_fenced');
    let acknowledgement: RecoveryIndexLookup | undefined;
    const result = this.#transaction(() => {
      const { now } = this.#requireHeld(key, commit.ref, lease);
      const previous =
        this.db.prepare('SELECT * FROM observation_current WHERE ref=?').get(key) ??
        this.db.prepare('SELECT * FROM observation_legacy WHERE ref=?').get(key);
      if (Number(previous?.commit_seq ?? 0) !== prepared.previousCommitSeq)
        throw new ObservationStoreError('observation_commit_conflict');
      if (previous && previous.seq_domain !== commit.seqDomain)
        throw new ObservationStoreError('observation_seq_domain_mismatch');
      if (previous && commit.sourceGeneration < Number(previous.source_generation))
        throw new ObservationStoreError('observation_source_generation_stale');
      const fileIdentity = canonicalJson(checkpoint.fileId);
      if (
        previous &&
        commit.sourceGeneration === Number(previous.source_generation) &&
        (fileIdentity !== previous.file_id || checkpoint.offset < Number(previous.checkpoint_offset))
      )
        throw new ObservationStoreError('observation_boundary_mismatch');
      if (this.db.prepare('SELECT 1 FROM retired_readers WHERE ref=? AND version=?').get(key, checkpoint.readerVersion))
        throw new ObservationStoreError('observation_reader_retired');
      const rebuilding = previous && previous.reader_version !== checkpoint.readerVersion;
      if (rebuilding) {
        if (
          prepared.rebuildFromReaderVersion !== previous.reader_version ||
          commit.sourceGeneration !== Number(previous.source_generation) + 1 ||
          checkpoint.offset !== 0 ||
          commit.continuity.stateSince !== null ||
          commit.continuity.stateSinceBasis !== 'unknown' ||
          commit.continuity.episodeAnchor !== null ||
          checkpoint.parserState.usageMessageIds.length !== 0 ||
          checkpoint.parserState.openToolWaits.length !== 0 ||
          checkpoint.parserState.compactBoundary !== null ||
          checkpoint.parserState.rateBaseline !== null ||
          checkpoint.parserState.discardingOversize ||
          (checkpoint.parserState.tailBytesSeen ?? 0) !== 0 ||
          commit.notices.length !== 0 ||
          commit.summary.coverage.state === 'complete' ||
          !commit.summary.coverage.gaps.includes('reader_version_rebuild') ||
          (data.delta && (data.delta.base !== null || data.delta.entries.length !== 0))
        )
          throw new ObservationStoreError('observation_rebuild_required');
        this.db.prepare('INSERT INTO retired_readers VALUES(?,?)').run(key, previous.reader_version);
      } else if (prepared.rebuildFromReaderVersion !== undefined)
        throw new ObservationStoreError('observation_rebuild_mismatch');
      if (previous?.content_digest === prepared.contentDigest) {
        if (data.identity.recoveryReferences[0])
          acknowledgement = this.#lookup(data.identity.recoveryReferences[0], {
            commitSeq: Number(previous.commit_seq),
            sourceGeneration: Number(previous.source_generation),
            seqDomain: String(previous.seq_domain),
            checkpointId: String(previous.checkpoint_id ?? ''),
          });
        return { changed: false, commitSeq: Number(previous.commit_seq), bytes: 0 };
      }
      const reference = data.identity.recoveryReferences[0];
      if (previous?.projection_body && previous.checkpoint_id !== data.identity.contentIdentity) {
        const prior = JSON.parse(String(previous.projection_body)) as ObservationProjection;
        const priorRef = prior.checkpointIdentity.recoveryReferences[0];
        if (
          priorRef &&
          reference?.indexId !== priorRef.indexId &&
          data.delta?.base?.indexId !== priorRef.indexId &&
          !(
            (data.delta?.base ?? null) === null &&
            (rebuilding ||
              (commit.sourceGeneration > Number(previous.source_generation) &&
                checkpoint.resetReason !== undefined &&
                checkpoint.resetReason !== 'compaction'))
          )
        )
          throw new ObservationStoreError('recovery_base_conflict');
      }
      const reuse = previous?.checkpoint_id === data.identity.contentIdentity;
      let lineage: string | null = null;
      if (!reuse && data.delta && reference) {
        const base = data.delta.base ? this.#indexRow(data.delta.base) : undefined;
        lineage = base ? String(base.lineage) : reference.indexId;
        const revision = base ? Number(base.revision) + 1 : 1;
        if (!Number.isSafeInteger(revision)) throw new ObservationStoreError('recovery_revision_exhausted');
        const existing = this.db.prepare('SELECT id FROM recovery_indexes WHERE id=?').get(reference.indexId);
        if (!existing) {
          this.db
            .prepare('INSERT INTO recovery_indexes VALUES(?,?,?,?,?,?)')
            .run(reference.indexId, key, reference.recoveryVersion, lineage, revision, canonicalJson(reference));
          const insert = this.db.prepare('INSERT INTO recovery_entries VALUES(?,?,?,?,?)');
          for (const entry of data.delta.entries)
            insert.run(lineage, revision, entry.namespace, entry.key, entry.value);
        }
      }
      const id = data.identity.contentIdentity;
      const blob = reuse ? true : this.db.prepare('SELECT id FROM checkpoint_blobs WHERE id=?').get(id);
      if (!blob)
        this.db
          .prepare('INSERT INTO checkpoint_blobs VALUES(?,?,?,?)')
          .run(id, data.body, canonicalJson(data.identity), lineage);
      this.db
        .prepare(
          `INSERT INTO observation_current VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET
        commit_seq=excluded.commit_seq, source_generation=excluded.source_generation, reader_version=excluded.reader_version,
        seq_domain=excluded.seq_domain, content_digest=excluded.content_digest, projection_body=excluded.projection_body,
        file_id=excluded.file_id, checkpoint_offset=excluded.checkpoint_offset, checkpoint_id=excluded.checkpoint_id`
        )
        .run(
          key,
          commit.commitSeq,
          commit.sourceGeneration,
          checkpoint.readerVersion,
          commit.seqDomain,
          prepared.contentDigest,
          prepared.body,
          fileIdentity,
          checkpoint.offset,
          id
        );
      this.db.prepare('DELETE FROM observation_legacy WHERE ref=?').run(key);
      // Controlled publication is the only garbage collection path. No background writer.
      if (!reuse && previous?.checkpoint_id) {
        const oldId = String(previous.checkpoint_id);
        const old = this.db.prepare('SELECT index_lineage FROM checkpoint_blobs WHERE id=?').get(oldId);
        this.db
          .prepare(
            'DELETE FROM checkpoint_blobs WHERE id=? AND id NOT IN (SELECT checkpoint_id FROM observation_current)'
          )
          .run(oldId);
        if (
          old?.index_lineage &&
          old.index_lineage !== lineage &&
          !this.db.prepare('SELECT 1 FROM checkpoint_blobs WHERE index_lineage=? LIMIT 1').get(old.index_lineage)
        ) {
          this.db.prepare('DELETE FROM recovery_entries WHERE lineage=?').run(old.index_lineage);
          this.db.prepare('DELETE FROM recovery_indexes WHERE lineage=?').run(old.index_lineage);
        }
      }
      this.db.prepare('UPDATE collect_leases SET last_now=? WHERE ref=?').run(now, key);
      if (reference)
        acknowledgement = this.#lookup(reference, {
          commitSeq: commit.commitSeq,
          sourceGeneration: commit.sourceGeneration,
          seqDomain: commit.seqDomain,
          checkpointId: id,
        });
      return {
        changed: true,
        commitSeq: commit.commitSeq,
        bytes: Buffer.byteLength(prepared.body) + (blob ? 0 : Buffer.byteLength(data.body)),
      };
    });
    if (result.changed) this.unsafeRefs.delete(key);
    if (acknowledgement && data.handoff?.committed) {
      // Publication already committed. A collector callback cannot turn it into an unaccepted result.
      try {
        data.handoff.committed(acknowledgement);
      } catch {
        /* Collector can recover the committed projection. */
      }
    }
    return result;
  }

  close(): void {
    if (!this.#closed) {
      this.db.close();
      this.#authority.clear();
      this.#activeGrant = null;
      this.#closed = true;
    }
  }
}

export async function openObservationStore(options: ObservationStoreOptions): Promise<ObservationStore> {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!((major === 22 && minor >= 13) || major >= 24))
    throw new ObservationStoreError(
      'Observation storage requires Node 22.x >=22.13 or Node >=24; Node 23 is unsupported'
    );
  if (!/^[a-f0-9]{64}$/.test(options.sourceId) || !path.isAbsolute(options.hudHome))
    throw new ObservationStoreError('invalid_observation_path');
  const root = path.resolve(options.hudHome);
  const directory = path.join(root, 'sources', options.sourceId);
  if (!options.readOnly) {
    privateDirectory(root);
    privateDirectory(path.join(root, 'sources'));
    privateDirectory(directory);
  }
  const file = path.join(directory, 'observation.sqlite');
  if (!options.readOnly) {
    try {
      fs.closeSync(fs.openSync(file, 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  for (const dir of [root, path.join(root, 'sources'), directory]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new ObservationStoreError('observation_directory_not_private');
  }
  privateFile(file);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) privateFile(file + suffix);
  }
  const { DatabaseSync } = await import('node:sqlite');
  let db = new DatabaseSync(file, { readOnly: options.readOnly ?? false });
  let staging = false;
  const unsafeRefs = new Set<string>();
  try {
    db.exec('PRAGMA busy_timeout=10');
    if (!options.readOnly) {
      db.exec('PRAGMA synchronous=FULL; PRAGMA secure_delete=ON');
      verifyWritableSettings(db);
      const journal = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode);
      if (journal !== 'delete' && journal !== 'wal') throw new ObservationStoreError('unsupported_observation_journal');
      if (journal === 'delete') {
        // Retain the exclusive lock across COMMIT/VACUUM/mode selection. No other writer
        // can invalidate qualification, and an active read snapshot makes this return busy.
        db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
        staging = true;
      }
    }
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (!options.readOnly && !staging && version !== 2)
      throw new ObservationStoreError('observation_wal_rebuild_required');
    if (version !== 2) {
      if (options.readOnly || (version !== 0 && version !== 1))
        throw new ObservationStoreError('unsupported_observation_version');
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = Number(db.prepare('PRAGMA user_version').get()?.user_version);
        if (current === 0) {
          if (db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())
            throw new ObservationStoreError('unversioned_observation_database');
          db.exec(SCHEMA);
        } else if (current === 1) {
          db.exec('ALTER TABLE observation_current RENAME TO observation_legacy');
          const extra = SCHEMA.slice(
            SCHEMA.indexOf('CREATE TABLE observation_current ('),
            SCHEMA.indexOf('CREATE TABLE observation_legacy (')
          );
          db.exec(extra);
          db.exec('PRAGMA user_version=2');
        } else if (current !== 2) throw new ObservationStoreError('unsupported_observation_version');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    if (
      String(db.prepare('PRAGMA journal_mode').get()?.journal_mode) === 'wal' &&
      db.prepare('SELECT 1 FROM observation_legacy LIMIT 1').get()
    )
      throw new ObservationStoreError('observation_wal_rebuild_required');
    if (!options.readOnly) {
      if (staging) {
        // Only live legacy contents require a leased readerVersion rebuild. Unpublished
        // blobs have no consumer and are removed under the same exclusive maintenance lock.
        for (const row of db.prepare('SELECT ref FROM observation_legacy').all()) unsafeRefs.add(String(row.ref));
        for (const row of db
          .prepare(
            `SELECT c.ref, c.checkpoint_id, c.projection_body, b.id, b.body, b.identity, b.index_lineage FROM observation_current c
          LEFT JOIN checkpoint_blobs b ON b.id=c.checkpoint_id`
          )
          .all()) {
          try {
            const identity = JSON.parse(String(row.identity)) as CheckpointIdentity;
            const checkpoint = decodeCheckpointBody(String(row.body), identity);
            if (sessionRefKey(checkpoint.ref) !== row.ref || checkpoint.ref.sourceId !== options.sourceId)
              throw new ObservationStoreError('observation_source_mismatch');
            const projection = decodeProjectionBody(String(row.projection_body), checkpoint.ref);
            if (
              row.id !== identity.contentIdentity ||
              row.checkpoint_id !== identity.contentIdentity ||
              canonicalJson(projection.checkpointIdentity) !== row.identity
            )
              throw new ObservationStoreError('invalid_checkpoint_identity');
            const reference = identity.recoveryReferences[0];
            if (reference) {
              const index = db
                .prepare('SELECT ref, reference, lineage FROM recovery_indexes WHERE id=?')
                .get(reference.indexId);
              if (
                index?.ref !== row.ref ||
                index?.reference !== canonicalJson(reference) ||
                index?.lineage !== row.index_lineage
              )
                throw new ObservationStoreError('invalid_recovery_reference');
              checkpoint.recoveryIndex = {
                delta: { recoveryVersion: reference.recoveryVersion, base: reference, entries: [] },
              };
            } else if (row.index_lineage !== null) {
              throw new ObservationStoreError('invalid_recovery_reference');
            }
            // Re-preparation removes duplicate-key / V8 shadow bytes. Merely decoding
            // a value cannot prove that every byte of the original wire was qualified.
            const verified = preparedCheckpointData(
              prepareCheckpoint({
                checkpoint,
                boundary: checkpointBoundary(checkpoint),
                format: checkpointFormat(checkpoint),
                recoveryReferences: identity.recoveryReferences,
              })
            );
            if (verified.body !== row.body || canonicalJson(verified.identity) !== row.identity)
              throw new ObservationStoreError('invalid_checkpoint_identity');
          } catch (error) {
            if (!(error instanceof SyntaxError || error instanceof TypeError || error instanceof ObservationStoreError))
              throw error;
            unsafeRefs.add(String(row.ref));
          }
        }
        if (unsafeRefs.size === 0) {
          db.exec(`BEGIN IMMEDIATE;
          DELETE FROM checkpoint_blobs WHERE id NOT IN (SELECT checkpoint_id FROM observation_current);
          DELETE FROM recovery_entries WHERE lineage NOT IN
            (SELECT index_lineage FROM checkpoint_blobs WHERE index_lineage IS NOT NULL);
          DELETE FROM recovery_indexes WHERE lineage NOT IN
            (SELECT index_lineage FROM checkpoint_blobs WHERE index_lineage IS NOT NULL);
          COMMIT`);
          // secure_delete does not scrub historic free pages or WAL copies. Repack the
          // qualified DELETE database BEFORE WAL can receive any of its pages.
          db.exec('VACUUM');
          if (String(db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode) !== 'wal')
            throw new ObservationStoreError('unsupported_observation_journal');
        }
        // A connection that enters WAL in EXCLUSIVE mode cannot return to NORMAL.
        // Reopening also ensures maintenance never transfers acquired lease authority.
        db.close();
        db = new DatabaseSync(file);
        db.exec('PRAGMA busy_timeout=10; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON');
        verifyWritableSettings(db);
      }
      const mode = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode);
      if (mode !== (unsafeRefs.size ? 'delete' : 'wal'))
        throw new ObservationStoreError('unsupported_observation_journal');
      // Keep SQLite's 1000-page automatic checkpoint threshold enabled. Reads use short
      // snapshots; a long external snapshot can pin pages and is measured separately.
      if (Number(db.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint) !== 1000)
        throw new ObservationStoreError('unsupported_observation_checkpoint');
      const fd = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (fs.existsSync(file + suffix)) privateFile(file + suffix);
    }
    return new ObservationStore(
      db,
      options.sourceId,
      file,
      options.readOnly ?? false,
      options.now ?? Date.now,
      unsafeRefs
    );
  } catch (error) {
    db.close();
    if (error instanceof Error && /database (?:is )?(?:locked|busy)/.test(error.message))
      throw new ObservationStoreError('observation_busy');
    throw error;
  }
}
