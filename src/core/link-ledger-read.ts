import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { LedgerReadError } from './ledger-read.js';
import type { LedgerReadClaim, LedgerReadRun, LedgerReadScope, LedgerReadSnapshot } from './ledger-read.js';
import { ledgerRuntimeSupported, loadLedgerSqlite } from '../ledger/runtime.js';
import { decodeRecord, parseRef } from '../ledger/records.js';
import { registeredSupervisor } from './supervision.js';
import { linkEvidenceKey } from './link/evidence-key.js';
import type { LaunchMessageLinkEvidence } from './interfaces/session-evidence.js';
import { validateSessionRef } from './identity.js';
import type { SessionRef } from './types/identity.js';

type Row = Record<string, SQLOutputValue>;
interface DecodedRow {
  row: Row;
  columns: string[];
  value: unknown;
}

function freezeDecoded<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDecoded(child);
    Object.freeze(value);
  }
  return value;
}

export interface ClaimFingerprintCheck {
  ledgerId: string;
  asOfSeq: number;
  runId: string;
  bindingGeneration: number;
  recordId: string;
  result: 'verified' | 'mismatch' | 'unverifiable';
}

export type LinkLedgerRead =
  | {
      state: 'available';
      snapshot: LedgerReadSnapshot;
      claimChecks: ClaimFingerprintCheck[];
      conflictTargets: ReadonlyMap<string, SessionRef>;
      reason: null;
    }
  | { state: 'degraded'; snapshot: null; reason: string };

export interface LinkLedgerReader {
  /** One consistent snapshot per tick. Opening belongs to startup, outside the tick. */
  read(launchMessages?: readonly LaunchMessageLinkEvidence[]): LinkLedgerRead;
  close(): void;
}

function readReason(error: unknown): string {
  const code = (error as { errcode?: number } | null)?.errcode;
  if (typeof code === 'number' && [5, 6].includes(code & 0xff)) return 'ledger_busy';
  return error instanceof LedgerReadError ? `ledger_${error.code}` : 'ledger_unavailable';
}

/** No writer imports, initialization, migration, retries or filesystem creation. */
export async function openLinkLedgerReader(path: string, scope?: LedgerReadScope): Promise<LinkLedgerReader> {
  let db: DatabaseSync | null = null;
  let reason = 'ledger_unavailable';
  // Reuse only exact unchanged row values, after re-reading them in this tick's transaction.
  // Cached records are immutable; this never reuses a previous snapshot or skips a SQL read.
  let decodedRows = new Map<string, DecodedRow>();
  // Freeze the caller's requested scope for this reader's lifetime.
  const ids = scope?.linkIds === undefined ? undefined : JSON.stringify([...new Set(scope.linkIds)]);
  try {
    if (!ledgerRuntimeSupported()) throw new LedgerReadError('runtime_unavailable', 'Unsupported ledger runtime');
    if (!path || path === ':memory:') throw new LedgerReadError('unavailable', 'Existing ledger required');
    const sqlite = await loadLedgerSqlite();
    db = new sqlite.DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=0');
  } catch (error) {
    db?.close();
    db = null;
    reason = readReason(error);
  }
  return {
    read: (launchMessages = []) => {
      if (!db) return { state: 'degraded', snapshot: null, reason };
      let active = false;
      try {
        db.exec('BEGIN');
        active = true;
        if (db.prepare('PRAGMA user_version').get()?.user_version !== 1)
          throw new LedgerReadError('unsupported_schema', 'Unsupported ledger schema');
        const ledgerId = db.prepare('SELECT ledger_id FROM ledger_metadata WHERE singleton=1').get()?.ledger_id;
        if (typeof ledgerId !== 'string' || !ledgerId)
          throw new LedgerReadError('invalid_ledger', 'Missing ledger identity');
        const asOfSeq = Number(db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events').get()?.seq);
        const linkWhere = ids === undefined ? '' : ' WHERE link_id IN (SELECT value FROM json_each(?))';
        const runWhere = ids === undefined ? '' : ' WHERE run_id IN (SELECT run_id FROM runs' + linkWhere + ')';
        const relatedWhere =
          ids === undefined
            ? ''
            : ' WHERE (link_id IN (SELECT value FROM json_each(?)) OR run_id IN (SELECT run_id FROM runs' +
              linkWhere +
              '))';
        const rows = (sql: string, params = 1) =>
          ids === undefined ? db!.prepare(sql).all() : db!.prepare(sql).all(...Array(params).fill(ids));
        const nextDecodedRows = new Map<string, DecodedRow>();
        const cached = <T>(table: string, key: string, row: Row, decode: () => T): T => {
          const id = JSON.stringify([table, row[key]]);
          const previous = decodedRows.get(id);
          if (
            previous &&
            Object.keys(row).length === previous.columns.length &&
            previous.columns.every((column) => row[column] === previous.row[column])
          ) {
            nextDecodedRows.set(id, previous);
            return previous.value as T;
          }
          const value = freezeDecoded(decode());
          nextDecodedRows.set(id, { row, columns: Object.keys(row), value });
          return value;
        };
        const decoded = <T>(table: string, key: string, sql: string, params = 1): T[] =>
          rows(sql, params).map((row) => cached(table, key, row, () => decodeRecord<T>(row)));
        // Explicit run columns exclude both launch credentials before crossing the SQLite boundary.
        const runColumns = `run_id,link_id,run_seq,operation,target_session_ref,source_id,harness,expected_generation,
          mode,launch_cwd,workspace_snapshot,project_origin,supervision_strategy,scope_kind,scope_ref,state,locator,
          launch_phase,launch_call_id,launch_correlation_id,launch_message_id,supervisor_pid,supervisor_proc_start,
          heartbeat_at,heartbeat_seq,heartbeat_mono_ms,cancel_requested_at,submission_fenced_at,created_at,started_at,
          ended_at,exit_code,exit_signal,exit_source,shell_status,shell_signal,terminal_evidence_id,orphan_policy`;
        const runRows = rows(`SELECT ${runColumns} FROM runs${linkWhere} ORDER BY link_id,run_seq`);
        // Claim hashes exist only inside this transaction and are never returned, including error paths.
        const claimRows = rows(`SELECT * FROM claims${runWhere} ORDER BY run_id`);
        // Scope is a display selection, not permission to miss a conflict on another run of the same full ref.
        const targetSet = `SELECT child_ref FROM links${linkWhere} UNION SELECT target_session_ref FROM runs${linkWhere}`;
        const evidenceWhere =
          ids === undefined
            ? ''
            : ` WHERE (e.link_id IN (SELECT value FROM json_each(?)) OR e.run_id IN (SELECT run_id FROM runs${linkWhere}))
            OR (e.kind IN ('conflict','conflict_resolved') AND coalesce(r.target_session_ref,l.child_ref) IN (${targetSet}))`;
        const evidenceRows = rows(
          `SELECT e.*, r.target_session_ref AS conflict_target_ref, l.child_ref AS conflict_child_ref
          FROM evidence e LEFT JOIN runs r ON r.run_id=e.run_id
          LEFT JOIN links l ON l.link_id=coalesce(e.link_id,r.link_id)${evidenceWhere} ORDER BY e.evidence_id`,
          4
        );
        const conflictTargets = new Map<string, SessionRef>();
        const evidence = evidenceRows.map((row) => {
          const { conflict_target_ref: target, conflict_child_ref: child, ...safe } = row;
          if (safe.kind === 'conflict' || safe.kind === 'conflict_resolved') {
            const ref = parseRef(target ?? child);
            if (ref) {
              validateSessionRef(ref);
              conflictTargets.set(String(safe.evidence_id), ref);
            }
          }
          return cached('evidence', 'evidence_id', safe, () =>
            decodeRecord<LedgerReadSnapshot['evidence'][number]>(safe)
          );
        });
        const snapshot: LedgerReadSnapshot = {
          ledgerId,
          asOfSeq,
          links: decoded('links', 'link_id', `SELECT * FROM links${linkWhere} ORDER BY link_id`),
          runs: [],
          claims: [],
          bindings: decoded(
            'bindings',
            'binding_id',
            `SELECT * FROM child_bindings${runWhere} ORDER BY run_id,binding_id`
          ),
          reports: decoded('reports', 'report_id', `SELECT * FROM reports${linkWhere} ORDER BY run_id,report_id`),
          events: decoded('events', 'seq', `SELECT * FROM events${relatedWhere} ORDER BY seq`, 2),
          evidence,
          slots: decoded('slots', 'slot_key', `SELECT * FROM slots${runWhere} ORDER BY slot_key`),
        };
        const claims = new Map(claimRows.map((row) => [row.run_id, row]));
        const registrations = new Map<string, LedgerReadSnapshot['events']>();
        for (const event of snapshot.events) {
          if (event.kind !== 'supervisor.registered' || !event.runId) continue;
          const group = registrations.get(event.runId) ?? [];
          group.push(event);
          registrations.set(event.runId, group);
        }
        const stripStamp = (row: Record<string, SQLOutputValue>) => {
          const { supervisor_pid: _pid, supervisor_proc_start: _start, ...safe } = row;
          return safe;
        };
        for (const row of runRows) {
          const base = cached('runs', 'run_id', row, () =>
            decodeRecord<Omit<LedgerReadRun, 'supervisor'>>(stripStamp(row))
          );
          const registered = registeredSupervisor(base, registrations.get(base.runId) ?? []);
          const claim = claims.get(base.runId);
          const supervisor =
            registered &&
            registered.pid === row.supervisor_pid &&
            registered.proc_start === row.supervisor_proc_start &&
            registered.pid === claim?.supervisor_pid &&
            registered.proc_start === claim?.supervisor_proc_start
              ? registered
              : null;
          const run: LedgerReadRun = { ...base, supervisor };
          snapshot.runs.push(run);
          if (claim) {
            const { claim_hash: _hash, ...safe } = stripStamp(claim);
            const claimBase = cached('claims', 'run_id', safe, () =>
              decodeRecord<Omit<LedgerReadClaim, 'supervisor'>>(safe)
            );
            snapshot.claims.push({ ...claimBase, supervisor });
          }
        }
        for (const ref of [
          ...snapshot.links.flatMap((link) => [link.parentRef, link.childRef]),
          ...snapshot.runs.map((run) => run.targetSessionRef),
          ...snapshot.bindings.map((binding) => binding.sessionRef),
          ...snapshot.claims.map((claim) => claim.redeemedSessionRef),
        ])
          if (ref) validateSessionRef(ref);
        for (const row of [...snapshot.events, ...snapshot.evidence]) {
          if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload))
            throw new LedgerReadError('invalid_ledger', 'Invalid ledger metadata');
        }
        const claimChecks: ClaimFingerprintCheck[] = [];
        const byLaunch = new Map<string, LedgerReadRun[]>();
        const launchKey = (link: string, call: string | undefined, correlation: string | undefined) =>
          JSON.stringify([link, call ?? null, correlation ?? null]);
        for (const run of snapshot.runs) {
          const key = launchKey(run.linkId, run.launchCallId, run.launchCorrelationId);
          const group = byLaunch.get(key) ?? [];
          group.push(run);
          byLaunch.set(key, group);
        }
        for (const entry of launchMessages) {
          for (const run of byLaunch.get(launchKey(entry.linkId, entry.launchCallId, entry.launchCorrelationId)) ??
            []) {
            const expected = claims.get(run.runId)?.claim_hash;
            claimChecks.push({
              ledgerId,
              asOfSeq,
              runId: run.runId,
              bindingGeneration: run.expectedGeneration,
              recordId: linkEvidenceKey(entry),
              result:
                typeof expected !== 'string'
                  ? 'unverifiable'
                  : expected === entry.claimFingerprint
                    ? 'verified'
                    : 'mismatch',
            });
          }
        }
        db.exec('COMMIT');
        active = false;
        decodedRows = nextDecodedRows;
        return { state: 'available', snapshot, claimChecks, conflictTargets, reason: null };
      } catch (error) {
        if (active) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* Preserve the sanitized read failure. */
          }
        }
        return { state: 'degraded', snapshot: null, reason: readReason(error) };
      }
    },
    close: () => {
      db?.close();
      db = null;
      decodedRows.clear();
      reason = 'ledger_closed';
    },
  };
}
