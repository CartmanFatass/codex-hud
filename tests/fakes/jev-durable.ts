/** SIMULATED only. A bounded SQLite laboratory, never a production ledger or sender. */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { JobRef } from '../../src/core/types/observation.js';
import { displayNodeKey } from '../../src/core/observation.js';
import { leaseReleasePolicy } from '../../src/core/supervision.js';

const APPLICATION_ID = 0x4a45564c; // JEVL: independent simulation format, not ledger v1.
const VERSION = 1;
const LIMIT = 128;
const TABLE_SQL =
  'CREATE TABLE simulated_jev_store (singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL)';
const INPUT_FIELDS = ['ref', 'owner', 'browser', 'requestId', 'requestFingerprint', 'label'];
const JOB_FIELDS = [
  ...INPUT_FIELDS,
  'key',
  'state',
  'dispatches',
  'generation',
  'revision',
  'reconciled',
  'terminalEvidence',
  'answer',
  'reconcileRevision',
];
export type SimulatedJevState = 'queued' | 'sent' | 'uncertain' | 'needs_human' | 'answered' | 'failed';
type Terminal = 'answered' | 'failed';
export interface SimulatedJevInput {
  ref: JobRef;
  owner: string;
  browser: string;
  requestId: string;
  requestFingerprint: string;
  label?: string;
}
interface Job extends SimulatedJevInput {
  key: string;
  state: SimulatedJevState;
  dispatches: number;
  generation: number | null;
  revision: number;
  reconciled: boolean;
  terminalEvidence: string | null;
  answer: string | null;
  reconcileRevision: number | null;
}
interface Lease {
  browser: string;
  key: string;
  owner: string;
  generation: number;
}
interface Data {
  jobs: Job[];
  leases: Lease[];
  generations: { browser: string; generation: number }[];
}
interface Stored {
  storeId: string;
  revision: number;
  data: Data;
}
export interface SimulatedJevSnapshot {
  provenance: 'SIMULATED';
  availability: 'available';
  storeId: string;
  revision: number;
  jobs: (Job & { identity: { kind: 'job'; ref: JobRef }; lease: Lease | null; holderLabel?: string })[];
}
export type SimulatedJevUnavailableReason =
  | 'missing_store'
  | 'private_path_required'
  | 'unsupported_format'
  | 'store_identity_mismatch'
  | 'store_busy'
  | 'corrupt_store'
  | 'reader_closed';
export interface SimulatedJevUnavailable {
  provenance: 'SIMULATED';
  availability: 'unavailable';
  storeId: string | null;
  revision: null;
  jobs: [];
  reason: SimulatedJevUnavailableReason;
}
export type SimulatedJevReadResult = SimulatedJevSnapshot | SimulatedJevUnavailable;
const valid = (v: unknown): v is string => typeof v === 'string' && /^synthetic-[a-z0-9-]{1,80}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const terminal = (v: unknown): v is Terminal => v === 'answered' || v === 'failed';
const keyOf = (ref: JobRef) => displayNodeKey({ kind: 'job', ref });
function check(ok: unknown, reason = 'malformed_store'): asserts ok {
  if (!ok) throw Error(`jev_lab_${reason}`);
}
function fields(value: unknown, allowed: readonly string[], reason = 'malformed_store'): void {
  check(value && typeof value === 'object' && !Array.isArray(value), reason);
  const prototype = Object.getPrototypeOf(value);
  check(prototype === Object.prototype || prototype === null, reason);
  check(
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === 'string' && allowed.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!
    ),
    reason
  );
}
function refValid(ref: JobRef): void {
  fields(ref, ['kind', 'provider', 'account', 'key'], 'invalid_ref');
  check(
    ref.kind === 'jev' && valid(ref.provider) && valid(ref.key) && (ref.account === undefined || valid(ref.account)),
    'invalid_ref'
  );
}
function inputValuesValid(input: SimulatedJevInput): void {
  refValid(input.ref);
  check([input.owner, input.browser, input.requestId, input.requestFingerprint].every(valid), 'invalid_input');
  check(input.label === undefined || valid(input.label), 'invalid_label');
}
function copyInput(input: SimulatedJevInput): SimulatedJevInput {
  return {
    ref: {
      kind: 'jev',
      provider: input.ref.provider,
      key: input.ref.key,
      ...(input.ref.account === undefined ? {} : { account: input.ref.account }),
    },
    owner: input.owner,
    browser: input.browser,
    requestId: input.requestId,
    requestFingerprint: input.requestFingerprint,
    ...(input.label === undefined ? {} : { label: input.label }),
  };
}
/** This lab requires a caller-owned private directory and a single private regular file. */
function privatePath(path: string, existing: boolean): string {
  const full = resolve(path),
    parent = dirname(full),
    dir = lstatSync(parent);
  check(
    realpathSync(parent) === parent &&
      dir.isDirectory() &&
      !dir.isSymbolicLink() &&
      (dir.mode & 0o077) === 0 &&
      dir.uid === process.getuid?.(),
    'private_directory_required'
  );
  if (existing) {
    const file = lstatSync(full);
    check(
      file.isFile() &&
        !file.isSymbolicLink() &&
        file.nlink === 1 &&
        (file.mode & 0o077) === 0 &&
        file.uid === process.getuid?.(),
      'private_file_required'
    );
  }
  return full;
}
function read(db: DatabaseSync, expectedStoreId?: string): Stored {
  check(
    db.prepare('PRAGMA application_id').get()?.application_id === APPLICATION_ID &&
      db.prepare('PRAGMA user_version').get()?.user_version === VERSION,
    'unsupported_format'
  );
  const schema = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
  check(
    schema.length === 1 &&
      schema[0].type === 'table' &&
      schema[0].name === 'simulated_jev_store' &&
      schema[0].sql === TABLE_SQL
  );
  const rows = db.prepare('SELECT singleton, store_id, revision, payload FROM simulated_jev_store').all();
  check(rows.length === 1);
  const row = rows[0];
  check(row.singleton === 1);
  check(
    typeof row.store_id === 'string' && /^synthetic-store-[a-f0-9-]{36}$/.test(row.store_id) && integer(row.revision)
  );
  check(expectedStoreId === undefined || row.store_id === expectedStoreId, 'store_identity_mismatch');
  check(typeof row.payload === 'string' && Buffer.byteLength(row.payload) <= 1024 * 1024);
  let data: Data;
  try {
    data = JSON.parse(row.payload) as Data;
  } catch {
    throw Error('jev_lab_malformed_store');
  }
  fields(data, ['jobs', 'leases', 'generations']);
  check(data && Array.isArray(data.jobs) && Array.isArray(data.leases) && Array.isArray(data.generations));
  check(data.jobs.length <= LIMIT && data.leases.length <= LIMIT && data.generations.length <= LIMIT);
  const keys = new Set<string>(),
    requests = new Set<string>(),
    browsers = new Set<string>(),
    leased = new Set<string>();
  for (const g of data.generations) {
    fields(g, ['browser', 'generation']);
    check(g && valid(g.browser) && integer(g.generation) && g.generation > 0 && !browsers.has(g.browser));
    browsers.add(g.browser);
  }
  for (const job of data.jobs) {
    fields(job, JOB_FIELDS);
    inputValuesValid(job);
    check(job.key === keyOf(job.ref) && !keys.has(job.key));
    keys.add(job.key);
    const request = JSON.stringify([job.owner, job.requestId]);
    check(!requests.has(request));
    requests.add(request);
    check(integer(job.revision) && job.revision > 0 && job.revision <= row.revision);
    check(['queued', 'sent', 'uncertain', 'needs_human', 'answered', 'failed'].includes(job.state));
    check(typeof job.reconciled === 'boolean' && (job.dispatches === 0 || job.dispatches === 1));
    check(
      job.dispatches === 0
        ? job.state === 'queued' && job.generation === null
        : job.state !== 'queued' && integer(job.generation) && job.generation > 0
    );
    check(terminal(job.state) ? valid(job.terminalEvidence) : job.terminalEvidence === null);
    check(job.answer === null || (job.reconciled && job.state === 'answered' && valid(job.answer)));
    check(
      job.reconciled
        ? terminal(job.state) &&
            integer(job.reconcileRevision) &&
            job.reconcileRevision > 0 &&
            job.reconcileRevision < job.revision
        : job.reconcileRevision === null && job.answer === null
    );
    if (job.generation !== null)
      check(data.generations.some((g) => g.browser === job.browser && g.generation >= job.generation!));
  }
  for (const g of data.generations) {
    const used = data.jobs.filter((j) => j.browser === g.browser && j.generation !== null).map((j) => j.generation!);
    check(used.length > 0 && new Set(used).size === used.length && Math.max(...used) === g.generation);
  }
  for (const lease of data.leases) {
    fields(lease, ['browser', 'key', 'owner', 'generation']);
    check(
      lease &&
        valid(lease.browser) &&
        valid(lease.owner) &&
        integer(lease.generation) &&
        lease.generation > 0 &&
        !leased.has(lease.browser)
    );
    leased.add(lease.browser);
    const job = data.jobs.find((j) => j.key === lease.key);
    check(
      job &&
        job.browser === lease.browser &&
        job.owner === lease.owner &&
        job.generation === lease.generation &&
        job.dispatches === 1 &&
        !job.reconciled
    );
    check(data.generations.some((g) => g.browser === lease.browser && g.generation === lease.generation));
  }
  for (const job of data.jobs)
    check((job.dispatches === 1 && !job.reconciled) === data.leases.some((l) => l.key === job.key));
  return { storeId: row.store_id, revision: row.revision, data };
}
function snapshot(stored: Stored): SimulatedJevSnapshot {
  return {
    provenance: 'SIMULATED',
    availability: 'available',
    storeId: stored.storeId,
    revision: stored.revision,
    jobs: stored.data.jobs.map((job) => {
      const lease = stored.data.leases.find((l) => l.browser === job.browser) ?? null;
      const holder = lease ? stored.data.jobs.find((j) => j.key === lease.key && j.owner === lease.owner) : null;
      return structuredClone({
        ...copyInput(job),
        key: job.key,
        state: job.state,
        dispatches: job.dispatches,
        generation: job.generation,
        revision: job.revision,
        reconciled: job.reconciled,
        terminalEvidence: job.terminalEvidence,
        answer: job.answer,
        reconcileRevision: job.reconcileRevision,
        identity: { kind: 'job' as const, ref: job.ref },
        lease: lease
          ? { browser: lease.browser, key: lease.key, owner: lease.owner, generation: lease.generation }
          : null,
        ...(holder?.label ? { holderLabel: holder.label } : {}),
      });
    }),
  };
}
function transaction<T>(db: DatabaseSync, write: boolean, action: () => T): T {
  db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const value = action();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function readFailure(error: unknown): SimulatedJevUnavailableReason {
  const e = error as { code?: string; errcode?: number; message?: string };
  if (e?.code === 'ENOENT') return 'missing_store';
  if (e?.code === 'EACCES' || e?.code === 'EPERM' || /^jev_lab_private_/.test(e?.message ?? ''))
    return 'private_path_required';
  if (e?.message === 'jev_lab_unsupported_format') return 'unsupported_format';
  if (e?.message === 'jev_lab_store_identity_mismatch') return 'store_identity_mismatch';
  if (e?.errcode === 5 || e?.errcode === 6) return 'store_busy';
  return 'corrupt_store';
}
/** Opens only existing stores. Failures return no usable jobs; no create, repair or implicit reopen. */
export class SimulatedJevReader {
  private db: DatabaseSync | null = null;
  private storeId: string | null;
  private failure: SimulatedJevUnavailableReason = 'reader_closed';
  constructor(path: string, expectedStoreId?: string) {
    this.storeId = expectedStoreId ?? null;
    try {
      this.db = new DatabaseSync(privatePath(path, true), { readOnly: true });
      this.storeId = transaction(this.db, false, () => read(this.db!, expectedStoreId)).storeId;
    } catch (error) {
      this.failure = readFailure(error);
      this.db?.close();
      this.db = null;
    }
  }
  snapshot(): SimulatedJevReadResult {
    if (this.db) {
      try {
        return transaction(this.db, false, () => snapshot(read(this.db!, this.storeId!)));
      } catch (error) {
        return this.unavailable(readFailure(error));
      }
    }
    return this.unavailable(this.failure);
  }
  private unavailable(reason: SimulatedJevUnavailableReason): SimulatedJevUnavailable {
    return {
      provenance: 'SIMULATED',
      availability: 'unavailable',
      storeId: this.storeId,
      revision: null,
      jobs: [],
      reason,
    };
  }
  close(): void {
    this.db?.close();
    this.db = null;
    this.failure = 'reader_closed';
  }
}
/** Synthetic state only. No sender, timer, browser, network, real owner proof or capability. */
export class DurableJevLab {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly storeId: string,
    private readonly crashPoint?: (point: 'before_commit' | 'after_commit') => void
  ) {}
  static create(path: string): DurableJevLab {
    const full = privatePath(path, false),
      fd = openSync(full, 'wx', 0o600);
    closeSync(fd);
    const db = new DatabaseSync(full),
      storeId = `synthetic-store-${randomUUID()}`;
    try {
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION}; ${TABLE_SQL}`);
      db.prepare('INSERT INTO simulated_jev_store VALUES (1, ?, 0, ?)').run(
        storeId,
        JSON.stringify({ jobs: [], leases: [], generations: [] })
      );
      db.exec('COMMIT');
      return new DurableJevLab(db, storeId);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  static open(
    path: string,
    expectedStoreId?: string,
    crashPoint?: (point: 'before_commit' | 'after_commit') => void
  ): DurableJevLab {
    const db = new DatabaseSync(privatePath(path, true));
    try {
      const { storeId } = transaction(db, false, () => read(db, expectedStoreId));
      db.exec('PRAGMA synchronous=FULL');
      return new DurableJevLab(db, storeId, crashPoint);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  snapshot(): SimulatedJevSnapshot {
    return transaction(this.db, false, () => snapshot(read(this.db, this.storeId)));
  }
  close(): void {
    this.db.close();
  }
  private mutate<T>(action: (s: Stored) => { changed: boolean; value: T }, dispatch = false): T {
    const value = transaction(this.db, true, () => {
      const s = read(this.db, this.storeId),
        result = action(s);
      if (result.changed) {
        const payload = JSON.stringify(s.data),
          revision = s.revision + 1;
        const result = this.db
          .prepare(
            'UPDATE simulated_jev_store SET revision=?, payload=? WHERE singleton=1 AND store_id=? AND revision=?'
          )
          .run(revision, payload, this.storeId, s.revision);
        check(Number(result.changes) === 1, 'write_not_persisted');
        const persisted = read(this.db, this.storeId);
        check(persisted.revision === revision && JSON.stringify(persisted.data) === payload, 'write_not_persisted');
        if (dispatch) this.crashPoint?.('before_commit');
      }
      return result.value;
    });
    if (dispatch) this.crashPoint?.('after_commit');
    return value;
  }
  enqueue(input: SimulatedJevInput): { replay: boolean; revision: number; state: SimulatedJevState } {
    fields(input, INPUT_FIELDS, 'invalid_input_fields');
    inputValuesValid(input);
    input = copyInput(input);
    return this.mutate<{ replay: boolean; revision: number; state: SimulatedJevState }>((s) => {
      const key = keyOf(input.ref),
        old = s.data.jobs.find((j) => j.key === key);
      const request = s.data.jobs.find((j) => j.owner === input.owner && j.requestId === input.requestId);
      check(!request || request.key === key, 'request_conflict');
      if (old) {
        check(
          old.owner === input.owner &&
            old.browser === input.browser &&
            old.requestId === input.requestId &&
            old.requestFingerprint === input.requestFingerprint &&
            old.label === input.label,
          'request_conflict'
        );
        return { changed: false, value: { replay: true, revision: old.revision, state: old.state } };
      }
      check(s.data.jobs.length < LIMIT, 'job_limit');
      const revision = s.revision + 1;
      s.data.jobs.push({
        ...copyInput(input),
        key,
        state: 'queued',
        dispatches: 0,
        generation: null,
        revision,
        reconciled: false,
        terminalEvidence: null,
        answer: null,
        reconcileRevision: null,
      });
      return { changed: true, value: { replay: false, revision, state: 'queued' } };
    });
  }
  private owned(s: Stored, owner: string, ref: JobRef): Job {
    refValid(ref);
    check(valid(owner), 'invalid_input');
    const job = s.data.jobs.find((j) => j.key === keyOf(ref));
    check(job && job.owner === owner, 'not_owned');
    return job;
  }
  private active(s: Stored, owner: string, ref: JobRef, generation: number, expectedRevision: number): Job {
    const job = this.owned(s, owner, ref);
    check(integer(expectedRevision) && job.revision === expectedRevision, 'stale_revision');
    check(
      integer(generation) &&
        s.data.leases.some(
          (l) =>
            l.key === job.key &&
            l.owner === owner &&
            l.browser === job.browser &&
            l.generation === generation &&
            job.generation === generation
        ),
      'stale_or_foreign_lease'
    );
    return job;
  }
  /** Commit an uncertain single-use dispatch ticket BEFORE a caller models sending anything. */
  consumeDispatch(
    owner: string,
    ref: JobRef,
    expectedRevision: number
  ): { generation: number; revision: number; state: 'uncertain' } {
    return this.mutate((s) => {
      const job = this.owned(s, owner, ref);
      check(job.revision === expectedRevision && integer(expectedRevision), 'stale_revision');
      check(job.dispatches === 0, 'no_retry');
      check(!s.data.leases.some((l) => l.browser === job.browser), 'browser_busy');
      let g = s.data.generations.find((entry) => entry.browser === job.browser);
      if (!g) {
        g = { browser: job.browser, generation: 0 };
        s.data.generations.push(g);
      }
      check(g.generation < Number.MAX_SAFE_INTEGER, 'generation_exhausted');
      g.generation++;
      job.dispatches = 1;
      job.generation = g.generation;
      job.state = 'uncertain';
      job.revision = s.revision + 1;
      s.data.leases.push({ browser: job.browser, key: job.key, owner, generation: g.generation });
      return {
        changed: true,
        value: { generation: g.generation, revision: job.revision, state: 'uncertain' as const },
      };
    }, true);
  }
  observe(
    owner: string,
    ref: JobRef,
    generation: number,
    expectedRevision: number,
    state: Exclude<SimulatedJevState, 'queued'>,
    evidence?: string
  ): { revision: number } {
    check(['sent', 'uncertain', 'needs_human', 'answered', 'failed'].includes(state), 'invalid_state');
    check(terminal(state) ? valid(evidence) : evidence === undefined, 'invalid_evidence');
    return this.mutate((s) => {
      const job = this.active(s, owner, ref, generation, expectedRevision);
      check(!terminal(job.state) || (job.state === state && job.terminalEvidence === evidence), 'terminal_conflict');
      if (job.state === state && job.terminalEvidence === (evidence ?? null))
        return { changed: false, value: { revision: job.revision } };
      job.state = state;
      job.terminalEvidence = evidence ?? null;
      job.revision = s.revision + 1;
      return { changed: true, value: { revision: job.revision } };
    });
  }
  reconcile(
    owner: string,
    ref: JobRef,
    generation: number,
    expectedRevision: number,
    outcome: Terminal,
    evidence: string,
    answer?: string
  ): { revision: number; replay: boolean } {
    check(terminal(outcome) && valid(evidence), 'invalid_evidence');
    check(answer === undefined || (outcome === 'answered' && valid(answer)), 'invalid_answer');
    return this.mutate<{ revision: number; replay: boolean }>((s) => {
      const job = this.owned(s, owner, ref);
      if (job.reconciled) {
        check(
          job.generation === generation &&
            job.reconcileRevision === expectedRevision &&
            job.state === outcome &&
            job.terminalEvidence === evidence &&
            job.answer === (answer ?? null),
          'reconcile_conflict'
        );
        return { changed: false, value: { revision: job.revision, replay: true } };
      }
      this.active(s, owner, ref, generation, expectedRevision);
      check(job.state === outcome && job.terminalEvidence === evidence, 'outcome_mismatch');
      check(leaseReleasePolicy({ kind: 'browser', outcome, reconciled: true }) === 'release', 'release_refused');
      job.reconciled = true;
      job.answer = answer ?? null;
      job.reconcileRevision = expectedRevision;
      job.revision = s.revision + 1;
      s.data.leases = s.data.leases.filter((l) => l.key !== job.key);
      return { changed: true, value: { revision: job.revision, replay: false } };
    });
  }
}
