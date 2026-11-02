import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { canonicalJson } from './canonical.js';
import { sessionRefKey } from './identity.js';
import { collectResource } from './observation.js';
import {
  COLLECT_LEASE_TTL_MS,
  COLLECT_RENEW_INTERVAL_MS,
  ObservationStoreError,
  requireCollectLease,
  requireLeaseRequest,
} from './collect-lease.js';
import { prepareObservationCandidate, decodePublishedCommit, type ObservationCandidate } from './checkpoint.js';
import type { SessionRef } from './types/identity.js';
import type { CollectLease, ObservationCommit } from './types/observation.js';

type Row = Record<string, SQLOutputValue>;
const SCHEMA = `
CREATE TABLE collect_leases (
  ref TEXT PRIMARY KEY, holder TEXT, generation INTEGER NOT NULL,
  expires_at REAL NOT NULL, last_now REAL NOT NULL, renewed_at REAL NOT NULL
) STRICT;
CREATE TABLE observation_current (
  ref TEXT PRIMARY KEY, commit_seq INTEGER NOT NULL, source_generation INTEGER NOT NULL,
  reader_version TEXT NOT NULL, seq_domain TEXT NOT NULL, content_digest TEXT NOT NULL,
  body TEXT NOT NULL, file_id TEXT NOT NULL, checkpoint_offset INTEGER NOT NULL
) STRICT;
CREATE TABLE retired_readers (ref TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(ref, version)) STRICT;
PRAGMA user_version=1;`;

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

/** One source-local database. Rollback journalling avoids a second durable raw-cache/WAL copy. */
export class ObservationStore {
  #closed = false;
  #lastSampledNow = 0;
  #authority = new Map<string, { holder: string; generation: number }>();
  constructor(
    private readonly db: DatabaseSync,
    readonly sourceId: string,
    readonly databasePath: string,
    private readonly readOnly: boolean,
    private readonly now: () => number
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
      const result = work();
      this.db.exec('COMMIT');
      begun = false;
      return result;
    } catch (error) {
      if (begun) this.db.exec('ROLLBACK');
      if (error instanceof Error && /database (?:is )?(?:locked|busy)/.test(error.message))
        throw new ObservationStoreError('observation_busy');
      throw error;
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

  /** One SELECT exposes a whole version; no writes, lease acquisition, migration, or parsing of source files. */
  readCurrent(ref: SessionRef): ObservationCommit | null {
    const key = this.#key(ref);
    const row = this.#read(() => this.db.prepare('SELECT body FROM observation_current WHERE ref=?').get(key));
    return row ? decodePublishedCommit(String(row.body), ref) : null;
  }

  /** Safe rebuild input when an old raw-tail or runtime-specific body cannot be resumed. */
  readHead(ref: SessionRef): ObservationHead | null {
    const key = this.#key(ref);
    const row = this.#read(() =>
      this.db
        .prepare(
          'SELECT commit_seq, source_generation, reader_version, seq_domain FROM observation_current WHERE ref=?'
        )
        .get(key)
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

  /** B16 supplies the sole merger result and its reader-boundary witness. All preparation precedes the CAS. */
  publish(candidate: ObservationCandidate, lease: CollectLease): PublishResult {
    const prepared = prepareObservationCandidate(candidate);
    const { commit } = prepared;
    const key = this.#key(commit.ref);
    if (commit.leaseGeneration !== lease.generation) throw new ObservationStoreError('lease_fenced');
    return this.#transaction(() => {
      const { now } = this.#requireHeld(key, commit.ref, lease);
      const previous = this.db
        .prepare(
          'SELECT commit_seq, source_generation, reader_version, seq_domain, content_digest, file_id, checkpoint_offset FROM observation_current WHERE ref=?'
        )
        .get(key);
      if (Number(previous?.commit_seq ?? 0) !== candidate.previousCommitSeq)
        throw new ObservationStoreError('observation_commit_conflict');
      if (previous && previous.seq_domain !== commit.seqDomain)
        throw new ObservationStoreError('observation_seq_domain_mismatch');
      if (previous && commit.sourceGeneration < Number(previous.source_generation))
        throw new ObservationStoreError('observation_source_generation_stale');
      const fileIdentity = canonicalJson(commit.checkpoint.fileId);
      if (
        previous &&
        commit.sourceGeneration === Number(previous.source_generation) &&
        (fileIdentity !== previous.file_id || commit.checkpoint.offset < Number(previous.checkpoint_offset))
      )
        throw new ObservationStoreError('observation_boundary_mismatch');
      if (
        this.db
          .prepare('SELECT 1 FROM retired_readers WHERE ref=? AND version=?')
          .get(key, commit.checkpoint.readerVersion)
      )
        throw new ObservationStoreError('observation_reader_retired');
      const rebuilding = previous && previous.reader_version !== commit.checkpoint.readerVersion;
      if (rebuilding) {
        if (
          candidate.rebuildFromReaderVersion !== previous.reader_version ||
          commit.sourceGeneration !== Number(previous.source_generation) + 1 ||
          commit.checkpoint.offset !== 0 ||
          commit.continuity.stateSince !== null ||
          commit.continuity.stateSinceBasis !== 'unknown' ||
          commit.continuity.episodeAnchor !== null ||
          commit.checkpoint.parserState.usageMessageIds.length !== 0 ||
          commit.checkpoint.parserState.openToolWaits.length !== 0 ||
          commit.checkpoint.parserState.compactBoundary !== null ||
          commit.checkpoint.parserState.rateBaseline !== null ||
          commit.checkpoint.parserState.discardingOversize ||
          (commit.checkpoint.parserState.tailBytesSeen ?? 0) !== 0 ||
          commit.notices.length !== 0 ||
          commit.summary.coverage.state === 'complete' ||
          !commit.summary.coverage.gaps.includes('reader_version_rebuild')
        )
          throw new ObservationStoreError('observation_rebuild_required');
        this.db.prepare('INSERT INTO retired_readers VALUES(?,?)').run(key, previous.reader_version);
      } else if (candidate.rebuildFromReaderVersion !== undefined) {
        throw new ObservationStoreError('observation_rebuild_mismatch');
      }
      if (previous?.content_digest === prepared.contentDigest)
        return { changed: false, commitSeq: Number(previous.commit_seq), bytes: 0 };
      this.db
        .prepare(
          'INSERT INTO observation_current VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET commit_seq=excluded.commit_seq, source_generation=excluded.source_generation, reader_version=excluded.reader_version, seq_domain=excluded.seq_domain, content_digest=excluded.content_digest, body=excluded.body, file_id=excluded.file_id, checkpoint_offset=excluded.checkpoint_offset'
        )
        .run(
          key,
          commit.commitSeq,
          commit.sourceGeneration,
          commit.checkpoint.readerVersion,
          commit.seqDomain,
          prepared.contentDigest,
          prepared.body,
          fileIdentity,
          commit.checkpoint.offset
        );
      this.db.prepare('UPDATE collect_leases SET last_now=? WHERE ref=?').run(now, key);
      return { changed: true, commitSeq: commit.commitSeq, bytes: Buffer.byteLength(prepared.body) };
    });
  }

  close(): void {
    if (!this.#closed) {
      this.db.close();
      this.#authority.clear();
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
  const db = new DatabaseSync(file, { readOnly: options.readOnly ?? false });
  try {
    db.exec('PRAGMA busy_timeout=10');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version !== 1) {
      if (options.readOnly || version !== 0) throw new ObservationStoreError('unsupported_observation_version');
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = Number(db.prepare('PRAGMA user_version').get()?.user_version);
        if (current === 0) {
          if (db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())
            throw new ObservationStoreError('unversioned_observation_database');
          db.exec(SCHEMA);
        } else if (current !== 1) throw new ObservationStoreError('unsupported_observation_version');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    if (!options.readOnly) {
      const mode = db.prepare('PRAGMA journal_mode').get();
      if (String(mode?.journal_mode) !== 'delete') throw new ObservationStoreError('unsupported_observation_journal');
      db.exec('PRAGMA synchronous=FULL; PRAGMA secure_delete=ON');
      const fd = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    return new ObservationStore(db, options.sourceId, file, options.readOnly ?? false, options.now ?? Date.now);
  } catch (error) {
    db.close();
    if (error instanceof Error && /database (?:is )?(?:locked|busy)/.test(error.message))
      throw new ObservationStoreError('observation_busy');
    throw error;
  }
}
