import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { loadLedgerSqlite, ledgerRuntimeSupported } from '../ledger/runtime.js';
import { EXPORT_LIMITS, serializeDelegationExport } from './export.js';
import type { SessionRef } from './types/identity.js';
import type { DelegationExportV1, ExportInputRecord, ExportPaths, ExportResult, ExportScope } from './types/export.js';

export interface ExportQueryOptions {
  schemaVersion: 1;
  paths?: ExportPaths;
  scope?: ExportScope;
}

export interface ExportQueryValue {
  envelope: DelegationExportV1;
  /** Complete, newline-terminated JSON. Only write this after checking ok. */
  json: string;
  bytes: number;
  recordCount: number;
  elapsedMs: number;
  readTransactionMs: number;
}

type Row = Record<string, SQLOutputValue>;
class ExportFailure extends Error {}
const fail = (reason: string): never => {
  throw new ExportFailure(reason);
};
function ref(value: SQLOutputValue): SessionRef | null {
  if (value === null) return null;
  const tuple: unknown = JSON.parse(String(value));
  if (!Array.isArray(tuple) || tuple.length !== 4) return fail('invalid_session_ref');
  // The A4 serializer validates all four fields before anything can be emitted.
  return { harness: tuple[0], sourceId: tuple[1], sessionId: tuple[2], threadId: tuple[3] };
}

// Private B2 metadata projection seam, approved by ORCH: the broad LedgerReader
// intentionally exposes more than this export may read. B2 could absorb this API.
// No raw claims, diagnostics, evidence/event payloads, or free-text fields leave SQL.
const RECORDS_SQL = `
WITH valid_bindings AS (
  SELECT b.run_id, min(b.session_ref) AS session_ref,
    count(DISTINCT b.session_ref) AS identities,
    max(b.is_current) AS is_current
  FROM child_bindings b JOIN runs r ON r.run_id=b.run_id
  JOIN sessions s ON s.session_ref=b.session_ref
  JOIN evidence proof ON proof.evidence_id=b.evidence_id AND proof.validation='accepted'
  WHERE b.binding_generation=r.expected_generation
    AND s.source_id=r.source_id AND s.harness=r.harness
    AND (r.target_session_ref IS NULL OR r.target_session_ref=b.session_ref)
  GROUP BY b.run_id
), unresolved AS (
  SELECT coalesce(e.link_id, er.link_id) AS link_id, er.target_session_ref,
    CASE WHEN json_extract(e.payload,'$.cause') IN ('identity_conflict','resume_ref_mismatch')
      THEN json_extract(e.payload,'$.cause') ELSE NULL END AS reason
  FROM evidence e LEFT JOIN runs er ON er.run_id=e.run_id
  WHERE e.kind='conflict' AND e.validation='accepted'
    AND NOT EXISTS (SELECT 1 FROM evidence resolution
      WHERE resolution.kind='conflict_resolved' AND resolution.validation='accepted'
        AND resolution.run_id IS e.run_id
        AND json_extract(resolution.payload,'$.resolves')=e.evidence_id)
), link_conflicts AS (
  SELECT link_id, 1 AS blocked, min(reason) AS reason FROM unresolved GROUP BY link_id
), target_conflicts AS (
  SELECT target_session_ref, 1 AS blocked, min(reason) AS reason
  FROM unresolved WHERE target_session_ref IS NOT NULL GROUP BY target_session_ref
)
SELECT r.link_id, r.run_id, r.run_seq, r.operation, r.state AS run_state,
  r.created_at, r.started_at, r.ended_at,
  (SELECT CASE WHEN json_extract(e.payload,'$.terminalNote') IN ('cancel_timing_unknown','retire_timing_unknown')
    THEN json_extract(e.payload,'$.terminalNote') ELSE NULL END
    FROM events e WHERE e.run_id=r.run_id AND e.kind='run.terminal' ORDER BY e.seq DESC LIMIT 1) AS terminal_note,
  (SELECT json_type(e.payload,'$.terminalNote') FROM events e
    WHERE e.run_id=r.run_id AND e.kind='run.terminal' ORDER BY e.seq DESC LIMIT 1) AS terminal_note_type,
  CASE WHEN :paths='local' THEN r.launch_cwd ELSE NULL END AS launch_cwd,
  CASE WHEN r.workspace_snapshot IS NULL THEN NULL ELSE json_object(
    'repoId',json_extract(r.workspace_snapshot,'$.repoId'),
    'identityKind',json_extract(r.workspace_snapshot,'$.identityKind'),
    'scope',json_extract(r.workspace_snapshot,'$.scope'),
    'cwdSource',json_extract(r.workspace_snapshot,'$.cwdSource'),
    'cwdAsOf',json_extract(r.workspace_snapshot,'$.cwdAsOf'),
    'gitCapturedAt',json_extract(r.workspace_snapshot,'$.gitCapturedAt'),
    'gitMissingReason',json_extract(r.workspace_snapshot,'$.gitMissingReason'),
    'worktreeRoot',CASE WHEN :paths='local' THEN json_extract(r.workspace_snapshot,'$.worktreeRoot') ELSE NULL END
  ) END AS workspace_snapshot,
  CASE WHEN r.project_origin IS NULL THEN NULL ELSE json_object(
    'repoId',json_extract(r.project_origin,'$.repoId'),
    'basis',json_extract(r.project_origin,'$.basis'),
    'declaredAt',json_extract(r.project_origin,'$.declaredAt')
  ) END AS project_origin,
  l.state AS link_state, l.current_owner, l.predecessor, l.parent_ref,
  coalesce(r.target_session_ref,b.session_ref) AS child_ref,
  r.run_seq=(SELECT max(latest.run_seq) FROM runs latest WHERE latest.link_id=r.link_id) AS is_current_run,
  l.parent_ref IS NOT NULL AND l.child_ref IS NOT NULL
    AND l.child_ref=coalesce(r.target_session_ref,b.session_ref)
    AND (l.bound_at IS NOT NULL OR l.state IN ('bound','reported','handed_over','closed')) AS relationship_confirmed,
  (lc.blocked IS NOT NULL OR tc.blocked IS NOT NULL OR coalesce(b.identities,0)>1) AS conflict,
  coalesce(lc.reason,tc.reason) AS binding_reason,
  CASE
    WHEN b.identities=1 AND (b.is_current=1 OR l.current_owner=0
      OR r.run_seq<(SELECT max(latest.run_seq) FROM runs latest WHERE latest.link_id=r.link_id)) THEN 'bound'
    WHEN c.run_id IS NOT NULL AND c.source_id=r.source_id AND c.expected_generation=r.expected_generation
      AND c.state='redeemed' AND :now<c.expires_at THEN 'claimed'
    ELSE 'pending' END AS handshake_state,
  CASE
    WHEN b.identities=1 AND (b.is_current=1 OR l.current_owner=0
      OR r.run_seq<(SELECT max(latest.run_seq) FROM runs latest WHERE latest.link_id=r.link_id)) THEN NULL
    WHEN c.run_id IS NULL THEN 'claim_missing'
    WHEN c.source_id<>r.source_id OR c.expected_generation<>r.expected_generation THEN 'claim_conflict'
    WHEN c.state='revoked' THEN 'claim_revoked'
    WHEN c.state='expired' OR :now>=c.expires_at THEN 'claim_expired'
    WHEN b.run_id IS NOT NULL THEN 'stale_binding'
    ELSE NULL END AS handshake_reason
FROM runs r JOIN links l ON l.link_id=r.link_id
LEFT JOIN claims c ON c.run_id=r.run_id
LEFT JOIN valid_bindings b ON b.run_id=r.run_id
LEFT JOIN link_conflicts lc ON lc.link_id=r.link_id
LEFT JOIN target_conflicts tc ON tc.target_session_ref=coalesce(r.target_session_ref,b.session_ref)
WHERE (:ids IS NULL OR r.link_id IN (SELECT value FROM json_each(:ids)))
ORDER BY r.link_id COLLATE BINARY, r.run_seq
LIMIT 10001`;

function inputRecord(row: Row): ExportInputRecord {
  const confirmed = row.relationship_confirmed === 1;
  return {
    linkId: row.link_id as string,
    runId: row.run_id as string,
    runSeq: row.run_seq as number,
    operation: row.operation as ExportInputRecord['operation'],
    linkState: row.link_state as ExportInputRecord['linkState'],
    runState: row.run_state as ExportInputRecord['runState'],
    isCurrentRun: row.is_current_run === 1,
    currentOwner: row.current_owner === 1,
    predecessor: row.predecessor as string | null,
    hasUnresolvedConflict: row.conflict === 1,
    parentRef: ref(row.parent_ref),
    childRef: ref(row.child_ref),
    relationshipConfirmed: confirmed,
    bindingReason: (row.binding_reason as string | null) ?? (confirmed ? null : 'identity_unverified'),
    runHandshake: {
      state: row.handshake_state as ExportInputRecord['runHandshake']['state'],
      reason: row.handshake_reason as string | null,
    },
    cwdBasis: 'launch',
    cwdCapturedAt: row.created_at as number,
    launchCwd: (row.launch_cwd as string | null) ?? '/',
    workspaceSnapshot: row.workspace_snapshot === null ? null : JSON.parse(String(row.workspace_snapshot)),
    projectOrigin: row.project_origin === null ? null : JSON.parse(String(row.project_origin)),
    createdAt: row.created_at as number,
    startedAt: row.started_at as number | null,
    endedAt: row.ended_at as number | null,
    ...(row.terminal_note_type === null
      ? {}
      : { terminalNote: row.terminal_note as ExportInputRecord['terminalNote'] }),
  };
}

/** One on-demand read transaction; no stdout, initialization, migration or collection. */
export async function queryDelegationExport(
  hudHome: string,
  options: ExportQueryOptions
): Promise<ExportResult<ExportQueryValue>> {
  const start = performance.now();
  let db: DatabaseSync | undefined;
  try {
    if (!options || options.schemaVersion !== 1) return { ok: false, reason: 'unsupported_export_schema' };
    const paths = options.paths ?? 'none';
    if (paths !== 'none' && paths !== 'local') return { ok: false, reason: 'invalid_paths' };
    const scope = options.scope ?? { kind: 'all' };
    if (
      (scope.kind !== 'all' && scope.kind !== 'links') ||
      (scope.kind === 'links' &&
        (!Array.isArray(scope.linkIds) ||
          scope.linkIds.some((id) => typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) ||
          new Set(scope.linkIds).size !== scope.linkIds.length))
    )
      return { ok: false, reason: 'invalid_scope' };
    const exportScope: ExportScope =
      scope.kind === 'all' ? { kind: 'all' } : { kind: 'links', linkIds: [...scope.linkIds].sort() };
    if (!ledgerRuntimeSupported()) return { ok: false, reason: 'runtime_unavailable' };
    const checkTime = () => {
      if (performance.now() - start > EXPORT_LIMITS.softMs) fail('export_time_budget_exceeded');
    };
    const path = join(hudHome, 'ledger.sqlite');
    try {
      if (!(await stat(path)).isFile()) return { ok: false, reason: 'ledger_unavailable' };
    } catch (error) {
      return {
        ok: false,
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ledger_missing' : 'ledger_unavailable',
      };
    }
    const { DatabaseSync } = await loadLedgerSqlite();
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=0');
    checkTime();
    const readStart = performance.now();
    db.exec('BEGIN');
    let ledgerId: string;
    let asOfSeq: number;
    let rows: Row[];
    const exportedAt = Date.now();
    const ids = exportScope.kind === 'all' ? null : JSON.stringify(exportScope.linkIds);
    try {
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) fail('unsupported_ledger_schema');
      const metadata = db.prepare('SELECT ledger_id FROM ledger_metadata WHERE singleton=1').get();
      if (!metadata || typeof metadata.ledger_id !== 'string' || !metadata.ledger_id) fail('invalid_ledger');
      ledgerId = metadata!.ledger_id as string;
      asOfSeq = db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events').get()!.seq as number;
      // Refuse large scopes before reading any per-run metadata or binding/evidence joins.
      const count = db
        .prepare(
          `SELECT count(*) AS n FROM (SELECT run_id FROM runs
        WHERE (? IS NULL OR link_id IN (SELECT value FROM json_each(?))) LIMIT 10001)`
        )
        .get(ids, ids)!.n as number;
      if (count > EXPORT_LIMITS.records) fail('export_record_budget_exceeded');
      checkTime();
      // Positional bindings avoid extending B2's minimal SQLite declarations for named parameters.
      const positional = RECORDS_SQL.replace(/:paths/g, '?')
        .replace(/:now/g, '?')
        .replace(/:ids/g, '?');
      rows = db.prepare(positional).all(paths, paths, exportedAt, exportedAt, ids, ids);
      if (rows.length !== count) fail('invalid_ledger');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const readTransactionMs = performance.now() - readStart;
    db.close();
    db = undefined;
    checkTime();
    const records = rows.map(inputRecord);
    const serialized = serializeDelegationExport(
      { ledgerId, asOfSeq, exportedAt, scope: exportScope, paths, records },
      {
        readElapsedMs: readTransactionMs,
        assemblyElapsedMs: Math.max(0, performance.now() - start - readTransactionMs),
      }
    );
    if (!serialized.ok) return serialized;
    // A4 measures caller-supplied elapsed time before encoding; include encoding and close here too.
    checkTime();
    return {
      ok: true,
      value: {
        ...serialized.value,
        elapsedMs: performance.now() - start,
        recordCount: records.length,
        readTransactionMs,
      },
    };
  } catch (error) {
    return { ok: false, reason: error instanceof ExportFailure ? error.message : 'ledger_unavailable' };
  } finally {
    db?.close();
  }
}
