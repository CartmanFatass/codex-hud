import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { validateSessionRef } from './identity.js';
import { registeredSupervisor } from './supervision.js';
import type { JsonObject } from './canonical.js';
import type { Evidence, LedgerEvent, Run, RunSlot } from './types/execution.js';
import type { ChildBinding, Claim, SessionRef } from './types/identity.js';
import type { Link, Report } from './types/lifecycle.js';
import { ledgerRuntimeSupported, loadLedgerSqlite, LEDGER_RUNTIME_REQUIREMENT } from '../ledger/runtime.js';

/** Internal views only: the supported external format belongs to delegation export (B18). */
export type LedgerReadRun = Omit<Run, 'launchTokenHash' | 'launchDigest'>;
export type LedgerReadClaim = Omit<Claim, 'claimHash'>;

export interface LedgerReadScope {
  /** Omitted means all links; an empty array means an explicitly empty scope. */
  linkIds?: readonly string[];
}

export interface LedgerReadSnapshot {
  ledgerId: string;
  asOfSeq: number;
  links: Link[];
  runs: LedgerReadRun[];
  claims: LedgerReadClaim[];
  bindings: ChildBinding[];
  reports: Report[];
  events: LedgerEvent[];
  evidence: Evidence[];
  slots: RunSlot[];
}

/** Valid only during withSnapshot's synchronous callback. No SQL/connection escapes. */
export interface LedgerSnapshotReader {
  readonly ledgerId: string;
  readonly asOfSeq: number;
  listLinks(): Link[];
  listRuns(): LedgerReadRun[];
  listClaims(): LedgerReadClaim[];
  listBindings(): ChildBinding[];
  listReports(): Report[];
  listEvents(): LedgerEvent[];
  listEvidence(): Evidence[];
  listSlots(): RunSlot[];
}

export interface LedgerReader {
  snapshot(scope?: LedgerReadScope): LedgerReadSnapshot;
  /** Keep callbacks short and synchronous; external I/O belongs outside the read transaction. */
  withSnapshot<T>(read: (snapshot: LedgerSnapshotReader) => T, scope?: LedgerReadScope): T;
  close(): void;
}

export type LedgerReadErrorCode =
  'runtime_unavailable' | 'unavailable' | 'unsupported_schema' | 'invalid_ledger' | 'closed' | 'snapshot_active';

export class LedgerReadError extends Error {
  constructor(
    readonly code: LedgerReadErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'LedgerReadError';
  }
}

export const ledgerReadRuntimeSupported = ledgerRuntimeSupported;

type Row = Record<string, SQLOutputValue>;

function string(row: Row, key: string): string {
  if (typeof row[key] !== 'string') throw new LedgerReadError('invalid_ledger', `Invalid ledger field: ${key}`);
  return row[key] as string;
}

function number(row: Row, key: string): number {
  if (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]))
    throw new LedgerReadError('invalid_ledger', `Invalid ledger integer: ${key}`);
  return row[key] as number;
}

function nullableString(row: Row, key: string): string | null {
  return row[key] === null ? null : string(row, key);
}

function nullableNumber(row: Row, key: string): number | null {
  return row[key] === null ? null : number(row, key);
}

function json<T>(row: Row, key: string): T {
  try {
    return JSON.parse(string(row, key)) as T;
  } catch (cause) {
    throw new LedgerReadError('invalid_ledger', `Invalid ledger JSON: ${key}`, { cause });
  }
}

function nullableJson<T>(row: Row, key: string): T | null {
  return row[key] === null ? null : json<T>(row, key);
}

function ref(row: Row, key: string): SessionRef | null {
  if (row[key] === null) return null;
  const tuple = json<unknown>(row, key);
  if (!Array.isArray(tuple) || tuple.length !== 4)
    throw new LedgerReadError('invalid_ledger', `Invalid session reference: ${key}`);
  const value: SessionRef = { harness: tuple[0], sourceId: tuple[1], sessionId: tuple[2], threadId: tuple[3] };
  validateSessionRef(value);
  return value;
}

function link(row: Row): Link {
  return {
    linkId: string(row, 'link_id'),
    state: string(row, 'state') as Link['state'],
    parentCaller: string(row, 'parent_caller'),
    parentContextId: string(row, 'parent_context_id'),
    parentContextGeneration: number(row, 'parent_context_generation'),
    parentRef: ref(row, 'parent_ref'),
    childRef: ref(row, 'child_ref'),
    currentOwner: number(row, 'current_owner') === 1,
    backend: string(row, 'backend'),
    role: string(row, 'role'),
    label: nullableString(row, 'label'),
    briefPath: string(row, 'brief_path'),
    taskDigest: string(row, 'task_digest'),
    reportPath: nullableString(row, 'report_path'),
    predecessor: nullableString(row, 'predecessor'),
    routing: nullableJson(row, 'routing'),
    createdAt: number(row, 'created_at'),
    claimedAt: nullableNumber(row, 'claimed_at'),
    boundAt: nullableNumber(row, 'bound_at'),
    closedAt: nullableNumber(row, 'closed_at'),
  };
}

function event(row: Row): LedgerEvent {
  return {
    seq: number(row, 'seq'),
    linkId: nullableString(row, 'link_id'),
    runId: nullableString(row, 'run_id'),
    kind: string(row, 'kind'),
    payload: json<JsonObject>(row, 'payload'),
    at: number(row, 'at'),
  };
}

function supervisor(row: Row, registrations: readonly LedgerEvent[]): Run['supervisor'] {
  const anchor = {
    runId: string(row, 'run_id'),
    linkId: string(row, 'link_id'),
    sourceId: string(row, 'source_id'),
    expectedGeneration: number(row, 'expected_generation'),
  };
  const registered = registeredSupervisor(anchor, registrations);
  return registered !== null &&
    registered.pid === nullableNumber(row, 'run_supervisor_pid') &&
    registered.proc_start === nullableString(row, 'run_supervisor_proc_start') &&
    registered.pid === nullableNumber(row, 'claim_supervisor_pid') &&
    registered.proc_start === nullableString(row, 'claim_supervisor_proc_start')
    ? registered
    : null;
}

function run(row: Row, registrations: readonly LedgerEvent[]): LedgerReadRun {
  return {
    runId: string(row, 'run_id'),
    linkId: string(row, 'link_id'),
    sourceId: string(row, 'source_id'),
    expectedGeneration: number(row, 'expected_generation'),
    runSeq: number(row, 'run_seq'),
    operation: string(row, 'operation') as Run['operation'],
    targetSessionRef: ref(row, 'target_session_ref'),
    harness: string(row, 'harness') as Run['harness'],
    mode: string(row, 'mode') as Run['mode'],
    launchCwd: string(row, 'launch_cwd'),
    workspaceSnapshot: nullableJson(row, 'workspace_snapshot'),
    projectOrigin: nullableJson(row, 'project_origin'),
    supervisionStrategy: string(row, 'supervision_strategy') as Run['supervisionStrategy'],
    scopeKind: string(row, 'scope_kind') as Run['scopeKind'],
    scopeRef: nullableJson(row, 'scope_ref'),
    state: string(row, 'state') as Run['state'],
    locator: nullableJson(row, 'locator'),
    launchPhase: string(row, 'launch_phase') as Run['launchPhase'],
    launchCallId: string(row, 'launch_call_id'),
    launchCorrelationId: string(row, 'launch_correlation_id'),
    launchMessageId: nullableString(row, 'launch_message_id'),
    supervisor: supervisor(row, registrations),
    heartbeatAt: nullableNumber(row, 'heartbeat_at'),
    heartbeatSeq: number(row, 'heartbeat_seq'),
    heartbeatMonoMs: nullableNumber(row, 'heartbeat_mono_ms'),
    cancelRequestedAt: nullableNumber(row, 'cancel_requested_at'),
    submissionFencedAt: nullableNumber(row, 'submission_fenced_at'),
    createdAt: number(row, 'created_at'),
    startedAt: nullableNumber(row, 'started_at'),
    endedAt: nullableNumber(row, 'ended_at'),
    exitCode: nullableNumber(row, 'exit_code'),
    exitSignal: nullableString(row, 'exit_signal'),
    exitSource: nullableString(row, 'exit_source') as Run['exitSource'],
    shellStatus: nullableNumber(row, 'shell_status'),
    shellSignal: nullableString(row, 'shell_signal'),
    terminalEvidenceId: nullableString(row, 'terminal_evidence_id'),
    orphanPolicy: string(row, 'orphan_policy') as Run['orphanPolicy'],
  };
}

function claim(row: Row, registrations: readonly LedgerEvent[]): LedgerReadClaim {
  return {
    runId: string(row, 'run_id'),
    sourceId: string(row, 'source_id'),
    expectedGeneration: number(row, 'expected_generation'),
    supervisor: supervisor(row, registrations),
    state: string(row, 'state') as Claim['state'],
    issuedAt: number(row, 'issued_at'),
    expiresAt: number(row, 'expires_at'),
    redeemedContextId: nullableString(row, 'redeemed_context_id'),
    redeemedGeneration: nullableNumber(row, 'redeemed_generation'),
    redeemedSessionRef: ref(row, 'redeemed_session_ref'),
    redeemedAt: nullableNumber(row, 'redeemed_at'),
  };
}

function binding(row: Row): ChildBinding {
  const sessionRef = ref(row, 'session_ref');
  if (sessionRef === null) throw new LedgerReadError('invalid_ledger', 'Missing binding session reference');
  return {
    bindingId: string(row, 'binding_id'),
    runId: string(row, 'run_id'),
    sessionRef,
    bindingGeneration: number(row, 'binding_generation'),
    callerId: string(row, 'caller_id'),
    callerContextId: string(row, 'caller_context_id'),
    contextGeneration: number(row, 'context_generation'),
    boundBy: string(row, 'bound_by') as ChildBinding['boundBy'],
    capabilities: string(row, 'capabilities') as ChildBinding['capabilities'],
    evidenceId: string(row, 'evidence_id'),
    isCurrent: number(row, 'is_current') === 1,
    createdAt: number(row, 'created_at'),
    revokedAt: nullableNumber(row, 'revoked_at'),
  };
}

function report(row: Row): Report {
  return {
    reportId: string(row, 'report_id'),
    runId: string(row, 'run_id'),
    linkId: string(row, 'link_id'),
    childBindingId: string(row, 'child_binding_id'),
    callerId: string(row, 'caller_id'),
    callerContextId: string(row, 'caller_context_id'),
    contextGeneration: number(row, 'context_generation'),
    status: string(row, 'status') as Report['status'],
    summary: string(row, 'summary'),
    path: nullableString(row, 'path'),
    createdAt: number(row, 'created_at'),
  };
}

function evidence(row: Row): Evidence {
  return {
    evidenceId: string(row, 'evidence_id'),
    runId: nullableString(row, 'run_id'),
    linkId: nullableString(row, 'link_id'),
    kind: string(row, 'kind') as Evidence['kind'],
    producer: string(row, 'producer') as Evidence['producer'],
    fingerprint: string(row, 'fingerprint'),
    payload: json(row, 'payload'),
    observedAt: number(row, 'observed_at'),
    validatedAt: nullableNumber(row, 'validated_at'),
    validation: string(row, 'validation') as Evidence['validation'],
  };
}

/** Opens an existing database only. Importing this module remains safe on Node 18. */
export async function openLedgerReader(path: string): Promise<LedgerReader> {
  if (!ledgerReadRuntimeSupported())
    throw new LedgerReadError('runtime_unavailable', `Ledger reads require ${LEDGER_RUNTIME_REQUIREMENT}.`);
  // SQLite's in-memory pseudo-path is not an existing ledger file.
  if (!path || path === ':memory:') throw new LedgerReadError('unavailable', 'An existing ledger path is required.');
  let db: DatabaseSync;
  try {
    const sqlite = await loadLedgerSqlite();
    db = new sqlite.DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    throw new LedgerReadError('unavailable', 'Cannot open ledger read-only.', { cause });
  }
  let closed = false;
  let reading = false;
  const ensureOpen = () => {
    if (closed) throw new LedgerReadError('closed', 'Ledger reader is closed.');
  };
  const withSnapshot = <T>(read: (snapshot: LedgerSnapshotReader) => T, scope: LedgerReadScope = {}): T => {
    ensureOpen();
    if (reading) throw new LedgerReadError('snapshot_active', 'A ledger read snapshot is already active.');
    if (scope.linkIds?.some((id) => typeof id !== 'string' || id.length === 0))
      throw new TypeError('Invalid ledger link scope.');
    const ids = scope.linkIds === undefined ? undefined : JSON.stringify([...new Set(scope.linkIds)].sort());
    const linkFilter = ids === undefined ? '' : ' WHERE link_id IN (SELECT value FROM json_each(?))';
    const runFilter =
      ids === undefined
        ? ''
        : ' WHERE run_id IN (SELECT run_id FROM runs WHERE link_id IN (SELECT value FROM json_each(?)))';
    const eventFilter =
      ids === undefined
        ? ''
        : ' WHERE (link_id IN (SELECT value FROM json_each(?)) OR run_id IN (SELECT run_id FROM runs WHERE link_id IN (SELECT value FROM json_each(?))))';
    const supervisorColumns =
      'runs.supervisor_pid AS run_supervisor_pid, runs.supervisor_proc_start AS run_supervisor_proc_start, claims.supervisor_pid AS claim_supervisor_pid, claims.supervisor_proc_start AS claim_supervisor_proc_start';
    let active = true;
    const rows = (sql: string, repeats = 1): Row[] => {
      if (!active) throw new LedgerReadError('closed', 'Ledger read snapshot has ended.');
      return ids === undefined ? db.prepare(sql).all() : db.prepare(sql).all(...Array(repeats).fill(ids));
    };
    reading = true;
    try {
      db.exec('BEGIN');
      try {
        // This first read pins the SQLite snapshot, including schema and event high-water.
        const version = db.prepare('PRAGMA user_version').get();
        if (!version || number(version, 'user_version') !== 1)
          throw new LedgerReadError(
            'unsupported_schema',
            'Unsupported ledger schema; read-only access never migrates.'
          );
        const metadata = db.prepare('SELECT ledger_id FROM ledger_metadata WHERE singleton = 1').get();
        if (!metadata || string(metadata, 'ledger_id').length === 0)
          throw new LedgerReadError('invalid_ledger', 'Ledger identity is missing.');
        const highWater = db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM events').get()!;
        let registrations: Map<string | null, LedgerEvent[]> | undefined;
        const registrationEvents = (runId: string): LedgerEvent[] => {
          if (!registrations) {
            registrations = new Map();
            for (const item of rows(
              `SELECT * FROM events${eventFilter}${eventFilter ? ' AND' : ' WHERE'} kind = 'supervisor.registered' ORDER BY seq`,
              2
            ).map(event)) {
              const group = registrations.get(item.runId) ?? [];
              group.push(item);
              registrations.set(item.runId, group);
            }
          }
          return registrations.get(runId) ?? [];
        };
        const view: LedgerSnapshotReader = {
          ledgerId: string(metadata, 'ledger_id'),
          asOfSeq: number(highWater, 'seq'),
          listLinks: () => rows(`SELECT * FROM links${linkFilter} ORDER BY link_id`).map(link),
          listRuns: () => {
            return rows(
              `SELECT runs.*, ${supervisorColumns} FROM runs LEFT JOIN claims USING (run_id)${linkFilter} ORDER BY link_id, run_seq`
            ).map((row) => run(row, registrationEvents(string(row, 'run_id'))));
          },
          listClaims: () =>
            rows(
              `SELECT claims.*, runs.link_id, ${supervisorColumns} FROM claims JOIN runs USING (run_id)${linkFilter} ORDER BY run_id`
            ).map((row) => claim(row, registrationEvents(string(row, 'run_id')))),
          listBindings: () => rows(`SELECT * FROM child_bindings${runFilter} ORDER BY run_id, binding_id`).map(binding),
          listReports: () =>
            rows(`SELECT * FROM reports${linkFilter} ORDER BY link_id, run_id, created_at, report_id`).map(report),
          listEvents: () => rows(`SELECT * FROM events${eventFilter} ORDER BY seq`, 2).map(event),
          listEvidence: () => rows(`SELECT * FROM evidence${eventFilter} ORDER BY evidence_id`, 2).map(evidence),
          listSlots: () =>
            rows(`SELECT * FROM slots${runFilter} ORDER BY slot_key`).map((row) => ({
              slotKey: string(row, 'slot_key'),
              sessionRef: ref(row, 'session_ref'),
              runId: string(row, 'run_id'),
              holder: string(row, 'holder'),
              acquiredAt: number(row, 'acquired_at'),
            })),
        };
        const value = read(view);
        if (value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value)
          throw new TypeError('Ledger read snapshot callbacks must be synchronous.');
        db.exec('COMMIT');
        return value;
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
    } finally {
      active = false;
      reading = false;
    }
  };
  const reader: LedgerReader = {
    withSnapshot,
    snapshot: (scope) =>
      withSnapshot(
        (view) => ({
          ledgerId: view.ledgerId,
          asOfSeq: view.asOfSeq,
          links: view.listLinks(),
          runs: view.listRuns(),
          claims: view.listClaims(),
          bindings: view.listBindings(),
          reports: view.listReports(),
          events: view.listEvents(),
          evidence: view.listEvidence(),
          slots: view.listSlots(),
        }),
        scope
      ),
    close: () => {
      if (closed) return;
      if (reading) throw new LedgerReadError('snapshot_active', 'Cannot close an active ledger snapshot.');
      db.close();
      closed = true;
    },
  };
  try {
    withSnapshot(() => undefined);
  } catch (cause) {
    db.close();
    throw cause;
  }
  return reader;
}
