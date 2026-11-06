/** Narrow read-only completed-report adapter. Metadata queries never project report text or paths. */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { loadLedgerSqlite } from '../ledger/runtime.js';
import { PrivateLedgerGate } from '../ledger/local-manager.js';
import { sessionRefKey, validateSessionRef } from './identity.js';
import type { SessionRef } from './types/identity.js';
import { fingerprint, type MaterialSubject } from './materials/index.js';
import { DigestFailure } from './materials/source-config.js';

type Row = Record<string, SQLOutputValue>;
// Payload predicates stay inside SQLite. No payload, path, claim or summary value leaves this query.
const METADATA = `
SELECT p.report_id, p.run_id, p.link_id, p.status, p.created_at,
  length(CAST(p.summary AS BLOB)) AS summary_bytes,
  r.run_seq, r.expected_generation, b.binding_id, b.caller_id, b.caller_context_id,
  b.context_generation, b.evidence_id, b.session_ref, e.seq AS accepted_seq, e.at AS accepted_at
FROM reports p
JOIN runs r ON r.run_id=p.run_id AND r.link_id=p.link_id
JOIN links l ON l.link_id=r.link_id
JOIN child_bindings b ON b.binding_id=p.child_binding_id AND b.run_id=r.run_id
  AND b.caller_id=p.caller_id AND b.caller_context_id=p.caller_context_id
  AND b.context_generation=p.context_generation AND b.binding_generation=r.expected_generation
JOIN sessions s ON s.session_ref=b.session_ref AND s.source_id=r.source_id AND s.harness=r.harness
JOIN sources src ON src.source_id=s.source_id AND src.harness=s.harness
JOIN caller_contexts ctx ON ctx.context_id=b.caller_context_id AND ctx.generation=b.context_generation
  AND ctx.caller_id=b.caller_id AND ctx.source_id=s.source_id AND ctx.harness=s.harness
  AND ctx.session_ref=b.session_ref
JOIN evidence proof ON proof.evidence_id=b.evidence_id AND proof.validation='accepted'
  AND proof.run_id=r.run_id AND proof.link_id=r.link_id
  AND proof.kind=CASE b.bound_by WHEN 'receipt' THEN 'launch_receipt' ELSE b.bound_by END
JOIN events e ON e.run_id=p.run_id AND e.link_id=p.link_id AND e.kind='report.received'
  AND json_extract(e.payload,'$.reportId')=p.report_id
WHERE p.run_id=? AND p.report_id=? AND p.status='completed'
  AND l.current_owner=1 AND l.state IN ('bound','reported','closed')
  AND l.parent_ref IS NOT NULL AND l.child_ref=b.session_ref
  AND (l.bound_at IS NOT NULL OR l.state IN ('bound','reported','closed'))
  AND (r.target_session_ref IS NULL OR r.target_session_ref=b.session_ref)
  AND r.run_seq=(SELECT max(latest.run_seq) FROM runs latest WHERE latest.link_id=r.link_id)
  AND e.seq=(SELECT max(received.seq) FROM events received JOIN reports accepted
    ON accepted.run_id=received.run_id AND accepted.link_id=received.link_id
    AND accepted.report_id=json_extract(received.payload,'$.reportId')
    WHERE received.kind='report.received' AND received.run_id=r.run_id AND received.link_id=r.link_id)
  AND (SELECT count(*) FROM events duplicate WHERE duplicate.kind='report.received'
    AND duplicate.run_id=p.run_id AND duplicate.link_id=p.link_id
    AND json_extract(duplicate.payload,'$.reportId')=p.report_id)=1
  AND NOT EXISTS (SELECT 1 FROM child_bindings other JOIN evidence bp ON bp.evidence_id=other.evidence_id
    AND bp.validation='accepted' WHERE other.run_id=r.run_id AND other.binding_generation=r.expected_generation
    AND other.session_ref<>b.session_ref)
  AND NOT EXISTS (SELECT 1 FROM evidence conflict LEFT JOIN runs cr ON cr.run_id=conflict.run_id
    LEFT JOIN links cl ON cl.link_id=coalesce(conflict.link_id,cr.link_id)
    WHERE conflict.kind='conflict' AND conflict.validation='accepted'
      AND (conflict.link_id=l.link_id OR cr.link_id=l.link_id OR cr.target_session_ref=b.session_ref
        OR cl.child_ref=b.session_ref)
      AND NOT EXISTS (SELECT 1 FROM evidence resolution
        WHERE resolution.kind='conflict_resolved' AND resolution.validation='accepted'
          AND resolution.run_id IS conflict.run_id
          AND json_extract(resolution.payload,'$.resolves')=conflict.evidence_id))
LIMIT 2`;

export interface CompletedReportMetadata {
  ledgerId: string; linkId: string; runId: string; reportId: string; ref: SessionRef;
  status: 'completed'; runSeq: number; generation: number; bindingId: string;
  callerId: string; callerContextId: string; contextGeneration: number; evidenceId: string;
  acceptedSeq: number; acceptedAt: number; createdAt: number; summaryBytes: number;
}
export interface CompletedReportTarget {
  readonly metadata: CompletedReportMetadata;
  readonly subject: MaterialSubject;
  readonly materialFailed: boolean;
  current(): boolean;
  close(): void;
}
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const safe = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\x00-\x1f\x7f-\x9f]/.test(v);
function metadata(row: Row, ledgerId: string): CompletedReportMetadata {
  const tuple: unknown = JSON.parse(String(row.session_ref));
  if (!Array.isArray(tuple) || tuple.length !== 4) throw new DigestFailure('target_unavailable');
  const ref: SessionRef = { harness: tuple[0], sourceId: tuple[1], sessionId: tuple[2], threadId: tuple[3] };
  validateSessionRef(ref);
  if (sessionRefKey(ref) !== row.session_ref || !safe(ref.sessionId) || !(ref.threadId === null || safe(ref.threadId)) ||
      !token(ledgerId) || !token(row.link_id) || !token(row.run_id) || !token(row.report_id))
    throw new DigestFailure('target_unavailable');
  for (const key of ['run_seq', 'expected_generation', 'context_generation', 'accepted_seq', 'accepted_at', 'created_at', 'summary_bytes'])
    if (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || Number(row[key]) < 0)
      throw new DigestFailure('target_unavailable');
  for (const key of ['binding_id', 'caller_id', 'caller_context_id', 'evidence_id'])
    if (!safe(row[key])) throw new DigestFailure('target_unavailable');
  return {
    ledgerId, linkId: String(row.link_id), runId: String(row.run_id), reportId: String(row.report_id), ref,
    status: 'completed', runSeq: Number(row.run_seq), generation: Number(row.expected_generation),
    bindingId: String(row.binding_id), callerId: String(row.caller_id), callerContextId: String(row.caller_context_id),
    contextGeneration: Number(row.context_generation), evidenceId: String(row.evidence_id),
    acceptedSeq: Number(row.accepted_seq), acceptedAt: Number(row.accepted_at), createdAt: Number(row.created_at),
    summaryBytes: Number(row.summary_bytes),
  };
}

export async function openCompletedReport(
  home: string, runId: string, reportId: string,
  options: { onQuery?: (sql: string) => void } = {}
): Promise<CompletedReportTarget> {
  if (!token(runId) || !token(reportId)) throw new DigestFailure('invalid_target', 2);
  let db: DatabaseSync | undefined;
  try {
    const gate = new PrivateLedgerGate(home);
    const sqlite = await loadLedgerSqlite();
    db = new sqlite.DatabaseSync(gate.path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=0');
    gate.check();
    const database = db;
    const query = (sql: string) => { options.onQuery?.(sql); return database.prepare(sql); };
    let invalid = false;
    let closed = false;
    let materialFailed = false;
    function transaction<T>(read: () => T): T {
      gate.check();
      database.exec('BEGIN');
      try {
        if (query('PRAGMA user_version').get()?.user_version !== 1) throw new DigestFailure('unsupported_ledger_schema', 5);
        const value = read();
        gate.check();
        database.exec('COMMIT');
        return value;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
    function select(): CompletedReportMetadata {
      const id = query('SELECT ledger_id FROM ledger_metadata WHERE singleton=1').get()?.ledger_id;
      const rows = query(METADATA).all(runId, reportId);
      if (typeof id !== 'string' || rows.length !== 1) throw new DigestFailure('target_unavailable');
      return metadata(rows[0], id);
    }
    const selected = transaction(select);
    const identity = JSON.stringify(selected);
    function checkSelected(): void {
      if (closed || invalid || JSON.stringify(select()) !== identity) throw new DigestFailure('target_changed');
    }
    function current(): boolean {
      if (invalid || closed) return false;
      try { transaction(checkSelected); return true; }
      catch { invalid = true; return false; }
    }
    const recordFingerprint = fingerprint([
      'ledger.completed-report.summary:v1', selected.ledgerId, selected.ref,
      selected.runId, selected.generation, selected.reportId, selected.acceptedSeq, 'summary',
    ]);
    const subject: MaterialSubject = {
      ref: { ...selected.ref }, origin: 'delegated', field: 'result', kind: 'public_text', recordFingerprint,
      // This is coverage of ONE record, not the session, task or transcript.
      coverage: { state: 'complete', loaded: true, skipped: {}, gaps: [] },
      read() {
        try {
          return transaction(() => {
            checkSelected();
            if (selected.summaryBytes > 32768) throw new DigestFailure('material_invalid', 6);
            const row = query('SELECT summary FROM reports WHERE run_id=? AND report_id=? AND link_id=? AND length(CAST(summary AS BLOB))<=32768')
              .get(runId, reportId, selected.linkId);
            const value = row?.summary;
            if (typeof value !== 'string' || Buffer.byteLength(value) > 32768 || Array.from(value).length > 8000 ||
                !value.trim() || value.includes('gAAAAA')) throw new DigestFailure('material_invalid', 6);
            return value;
          });
        } catch (error) {
          if (error instanceof DigestFailure && error.reason === 'material_invalid') materialFailed = true;
          else invalid = true;
          throw error;
        }
      },
    };
    return { metadata: selected, subject, current, get materialFailed() { return materialFailed; },
      close() { if (!closed) { closed = true; database.close(); } } };
  } catch (error) {
    db?.close();
    if (error instanceof DigestFailure) throw error;
    if (error instanceof Error && error.message.startsWith('The HUD ledger requires'))
      throw new DigestFailure('runtime_unavailable', 5);
    throw new DigestFailure('target_unavailable');
  }
}
