import type { SQLInputValue } from 'node:sqlite';
import { canonicalJson, requireCanonicalAbsolutePath } from '../core/canonical.js';
import { sessionRefKey } from '../core/identity.js';
import { registeredSupervisor } from '../core/supervision.js';
import type { CallerContext, Claim, SessionRef } from '../core/types/identity.js';
import type { Evidence, IdempotencyRecord, LedgerEvent, Run } from '../core/types/execution.js';
import type { Link } from '../core/types/lifecycle.js';
import type { ProjectOrigin, RunWorkspaceSnapshot } from '../core/types/observation.js';
import type { LedgerTransaction, SqlRow } from './transaction.js';

export function parseRef(value: unknown): SessionRef | null {
  if (value === null) return null;
  const [harness, sourceId, sessionId, threadId] = JSON.parse(String(value));
  return { harness, sourceId, sessionId, threadId };
}
export const refValue = (value: SessionRef | null): string | null => (value === null ? null : sessionRefKey(value));
export const jsonValue = (value: unknown): string | null => (value === null ? null : canonicalJson(value));
const jsonFields = new Set([
  'workspace_snapshot',
  'project_origin',
  'scope_ref',
  'locator',
  'routing',
  'payload',
  'outcome',
]);
const refFields = new Set(['parent_ref', 'child_ref', 'target_session_ref', 'session_ref', 'redeemed_session_ref']);
const boolFields = new Set(['current_owner', 'is_current']);
function snake(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
/** Explicit domain fields only: no secrets or process stamps can be silently flattened into SQL. */
export function insertRecord(tx: LedgerTransaction, table: string, record: object): void {
  const fields = Object.entries(record).map(([key, value]) => {
    const column = snake(key);
    const encoded = refFields.has(column)
      ? refValue(value)
      : jsonFields.has(column)
        ? jsonValue(value)
        : boolFields.has(column)
          ? Number(value)
          : value;
    return [column, encoded] as const;
  });
  tx.run(
    `INSERT INTO ${table} (${fields.map(([column]) => column).join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
    ...fields.map(([, value]) => value as SQLInputValue)
  );
}
export function decodeRecord<T>(row: SqlRow): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      camel(key),
      refFields.has(key)
        ? parseRef(value)
        : jsonFields.has(key)
          ? value === null
            ? null
            : JSON.parse(String(value))
          : boolFields.has(key)
            ? Boolean(value)
            : value,
    ])
  ) as T;
}
export function readEvents(tx: LedgerTransaction, runId: string): LedgerEvent[] {
  return tx.all('SELECT * FROM events WHERE run_id=? ORDER BY seq', runId).map((row) => decodeRecord<LedgerEvent>(row));
}
export function readRun(tx: LedgerTransaction, runId: string): Run {
  const row = tx.get('SELECT * FROM runs WHERE run_id=?', runId);
  if (!row) throw new Error('run_not_found');
  const decoded = decodeRecord<Run>(row);
  const stamp = registeredSupervisor(decoded, readEvents(tx, runId));
  const claim = tx.get('SELECT supervisor_pid,supervisor_proc_start FROM claims WHERE run_id=?', runId);
  decoded.supervisor =
    stamp &&
    stamp.pid === row.supervisor_pid &&
    stamp.proc_start === row.supervisor_proc_start &&
    claim?.supervisor_pid === stamp.pid &&
    claim.supervisor_proc_start === stamp.proc_start
      ? stamp
      : null;
  // These two columns are only projections of the authoritative registration event.
  delete (decoded as unknown as Record<string, unknown>).supervisorPid;
  delete (decoded as unknown as Record<string, unknown>).supervisorProcStart;
  return decoded;
}
export function insertRun(tx: LedgerTransaction, run: Run): void {
  const { supervisor, ...rest } = run;
  insertRecord(tx, 'runs', {
    ...rest,
    supervisorPid: supervisor?.pid ?? null,
    supervisorProcStart: supervisor?.proc_start ?? null,
  });
}
export function insertClaim(tx: LedgerTransaction, claim: Claim): void {
  const { supervisor, ...rest } = claim;
  insertRecord(tx, 'claims', {
    ...rest,
    supervisorPid: supervisor?.pid ?? null,
    supervisorProcStart: supervisor?.proc_start ?? null,
  });
}
export function readLink(tx: LedgerTransaction, linkId: string): Link {
  const row = tx.get('SELECT * FROM links WHERE link_id=?', linkId);
  if (!row) throw new Error('link_not_found');
  return decodeRecord<Link>(row);
}
export function readContext(tx: LedgerTransaction, contextId: string, generation: number): CallerContext {
  const row = tx.get('SELECT * FROM caller_contexts WHERE context_id=? AND generation=?', contextId, generation);
  if (!row) throw new Error('stale_context');
  return decodeRecord<CallerContext>(row);
}
export function readIdempotency(tx: LedgerTransaction, ownerKey: string, requestKey: string): IdempotencyRecord[] {
  return tx
    .all('SELECT * FROM idempotency WHERE owner_key=? AND request_key=?', ownerKey, requestKey)
    .map((row) => decodeRecord<IdempotencyRecord>(row));
}
export function readEvidence(tx: LedgerTransaction, runId: string): Evidence[] {
  return tx
    .all('SELECT * FROM evidence WHERE run_id=? ORDER BY evidence_id', runId)
    .map((row) => decodeRecord<Evidence>(row));
}

function whitelist(value: object, keys: readonly string[], name: string): void {
  canonicalJson(value);
  if (Array.isArray(value) || value === null || Object.keys(value).some((key) => !keys.includes(key)))
    throw new TypeError(`invalid_${name}`);
}
export function validateWorkspace(snapshot: RunWorkspaceSnapshot | null): void {
  if (snapshot === null) return;
  whitelist(
    snapshot,
    [
      'cwdSource',
      'cwdAsOf',
      'gitCapturedAt',
      'gitMissingReason',
      'worktreeRoot',
      'worktree',
      'gitCommonDir',
      'repoId',
      'identityKind',
      'scope',
    ],
    'workspace'
  );
  if (
    snapshot.identityKind !== 'git-common-dir-v1' ||
    snapshot.scope !== 'local' ||
    typeof snapshot.cwdSource !== 'string' ||
    !Number.isFinite(snapshot.cwdAsOf) ||
    snapshot.cwdAsOf < 0 ||
    (snapshot.gitCapturedAt !== null && (!Number.isFinite(snapshot.gitCapturedAt) || snapshot.gitCapturedAt < 0)) ||
    (snapshot.gitMissingReason !== null && typeof snapshot.gitMissingReason !== 'string') ||
    (snapshot.repoId !== null && !/^[0-9a-f]{64}$/.test(snapshot.repoId)) ||
    (snapshot.worktree !== undefined && typeof snapshot.worktree !== 'string')
  )
    throw new TypeError('invalid_workspace');
  for (const path of [snapshot.worktreeRoot, snapshot.gitCommonDir])
    if (path !== null) requireCanonicalAbsolutePath(path);
}
export function validateOrigin(origin: ProjectOrigin | null): void {
  if (origin === null) return;
  whitelist(origin, ['repoId', 'basis', 'declaredAt'], 'project_origin');
  if (
    origin.basis !== 'declared' ||
    !/^[0-9a-f]{64}$/.test(origin.repoId) ||
    !Number.isFinite(origin.declaredAt) ||
    origin.declaredAt < 0
  )
    throw new TypeError('invalid_project_origin');
}
