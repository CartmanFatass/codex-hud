import { sameSessionRef } from './identity.js';
import type { SessionRef } from './types/identity.js';
import type {
  TerminalNoteCode,
  BindingReasonCode,
  HandshakeReasonCode,
  GitMissingReasonCode,
  CwdSourceCode,
  DelegationExportLocalRecord,
  DelegationExportRecord,
  DelegationExportV1,
  ExportInputRecord,
  ExportInputSnapshot,
  ExportPaths,
  ExportResult,
  ExportScope,
  ExportWorkspaceSnapshot,
  OutboundPolicy,
  OutboundPurpose,
  VersionDomain,
} from './types/export.js';

const PURPOSES: readonly OutboundPurpose[] = [
  'brief',
  'recap',
  'progress',
  'digest',
  'label',
  'title',
  'cause',
  'changes',
  'approval',
  'probe',
  'jev_task',
  'routing',
];
const LINK_STATES = new Set(['pending', 'claimed', 'bound', 'reported', 'handed_over', 'revoked', 'closed', 'failed']);
const RUN_STATES = new Set(['starting', 'running', 'cancelling', 'ended', 'failed', 'cancelled', 'uncertain']);
const HANDSHAKE_STATES = new Set(['pending', 'claimed', 'bound']);

// Export v1 vocabularies are closed independently of internal diagnostics (E03).
const BINDING_REASON_CODES = new Set<BindingReasonCode>([
  'identity_source_missing',
  'identity_unverified',
  'identity_conflict',
  'resume_ref_mismatch',
  'unsupported',
  'unavailable',
  'unknown',
]);
const HANDSHAKE_REASON_CODES = new Set<HandshakeReasonCode>([
  ...BINDING_REASON_CODES,
  'claim_missing',
  'claim_revoked',
  'claim_expired',
  'claim_conflict',
  'stale_binding',
]);
const GIT_MISSING_REASON_CODES = new Set<GitMissingReasonCode>(['not_git', 'timeout', 'unavailable', 'unknown']);
const CWD_SOURCE_CODES = new Set<CwdSourceCode>(['launch', 'registry', 'transcript', 'supervisor']);
const TERMINAL_NOTE_CODES = new Set<TerminalNoteCode>(['cancel_timing_unknown', 'retire_timing_unknown']);
const OPERATIONS = new Set(['spawn', 'resume', 'handover']);

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const nullableTime = (value: unknown): value is number | null => value === null || integer(value);
const absolutePath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && !value.includes('\0');
function code<T extends string>(value: unknown, whitelist: ReadonlySet<T>): T | null {
  for (const allowed of whitelist) if (value === allowed) return allowed;
  return null;
}
const state = (value: unknown, known: ReadonlySet<string>): string =>
  typeof value === 'string' && known.has(value) ? value : 'unknown';

export function parseOutboundPolicy(value: unknown): OutboundPolicy | null {
  if (typeof value === 'string') {
    try {
      return parseOutboundPolicy(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sourceId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sourceId) ||
    !integer(value.revision) ||
    !Array.isArray(value.grants)
  )
    return null;
  const grants: OutboundPolicy['grants'] = [];
  for (const grant of value.grants) {
    if (
      !object(grant) ||
      !PURPOSES.includes(grant.purpose as OutboundPurpose) ||
      !identifier(grant.recipientId) ||
      grant.recipientId === '*' ||
      (grant.decision !== 'allow' && grant.decision !== 'deny') ||
      !integer(grant.grantedAt)
    )
      return null;
    grants.push({
      purpose: grant.purpose as OutboundPurpose,
      recipientId: grant.recipientId,
      decision: grant.decision,
      grantedAt: grant.grantedAt,
    });
  }
  return { schemaVersion: 1, sourceId: value.sourceId, revision: value.revision, grants };
}

export function outboundDecision(
  value: unknown,
  request: {
    sourceId: string | null;
    purpose: OutboundPurpose;
    recipientId: string | null;
  }
): 'allow' | 'deny' {
  const policy = parseOutboundPolicy(value);
  if (!policy || !request.sourceId || !request.recipientId || policy.sourceId !== request.sourceId) return 'deny';
  const matching = policy.grants.filter(
    (grant) => grant.purpose === request.purpose && grant.recipientId === request.recipientId
  );
  return matching.some((grant) => grant.decision === 'allow') && !matching.some((grant) => grant.decision === 'deny')
    ? 'allow'
    : 'deny';
}

/** Domains are selected explicitly; equal numeric versions carry no cross-domain meaning. */
export function versionDisposition(
  domain: VersionDomain,
  version: number,
  actor: 'hud' | 'writer'
): {
  readable: boolean;
  writable: boolean;
  action: 'use' | 'unavailable' | 'rebuild' | 'initialize';
  mayMigrateLedger: false;
} {
  const known: Record<VersionDomain, readonly number[]> = {
    public_snapshot: [2, 3],
    checkpoint: [1],
    ledger: [1],
    delegation_export: [1],
    scan: [3],
  };
  const supported = known[domain].includes(version);
  const action = supported
    ? 'use'
    : domain === 'scan'
      ? 'rebuild'
      : domain === 'ledger' && version === 0 && actor === 'writer'
        ? 'initialize'
        : 'unavailable';
  return { readable: supported, writable: supported && actor === 'writer', action, mayMigrateLedger: false };
}

function decodeRef(value: unknown): ExportResult<SessionRef | null> {
  if (value === null) return { ok: true, value: null };
  if (
    !object(value) ||
    !['claude', 'codex', 'pi'].includes(value.harness as string) ||
    typeof value.sourceId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sourceId) ||
    !identifier(value.sessionId) ||
    !(value.threadId === null || identifier(value.threadId))
  )
    return { ok: false, reason: 'invalid_session_ref' };
  return {
    ok: true,
    value: {
      harness: value.harness as SessionRef['harness'],
      sourceId: value.sourceId,
      sessionId: value.sessionId,
      threadId: value.threadId as string | null,
    },
  };
}

function decodeScope(value: unknown): ExportResult<ExportScope> {
  if (!object(value)) return { ok: false, reason: 'invalid_scope' };
  if (value.kind === 'all') return { ok: true, value: { kind: 'all' } };
  if (
    value.kind !== 'links' ||
    !Array.isArray(value.linkIds) ||
    !value.linkIds.every(identifier) ||
    new Set(value.linkIds).size !== value.linkIds.length
  )
    return { ok: false, reason: 'invalid_scope' };
  return { ok: true, value: { kind: 'links', linkIds: [...value.linkIds].sort() } };
}

function decodeWorkspace(
  value: unknown,
  paths: ExportPaths
): ExportResult<(ExportWorkspaceSnapshot & { worktreeRoot?: string | null }) | null> {
  if (value === null) return { ok: true, value: null };
  if (
    !object(value) ||
    !(value.repoId === null || (typeof value.repoId === 'string' && /^[a-f0-9]{64}$/.test(value.repoId))) ||
    value.identityKind !== 'git-common-dir-v1' ||
    value.scope !== 'local' ||
    !Object.hasOwn(value, 'cwdSource') ||
    !(value.cwdSource === null || typeof value.cwdSource === 'string') ||
    !integer(value.cwdAsOf) ||
    !nullableTime(value.gitCapturedAt) ||
    !(value.gitMissingReason === null || typeof value.gitMissingReason === 'string')
  )
    return { ok: false, reason: 'invalid_workspace_snapshot' };
  if (paths === 'local' && !(value.worktreeRoot === null || absolutePath(value.worktreeRoot)))
    return { ok: false, reason: 'invalid_worktree_root' };
  return {
    ok: true,
    value: {
      repoId: value.repoId as string | null,
      identityKind: 'git-common-dir-v1',
      scope: 'local',
      cwdSource: code(value.cwdSource, CWD_SOURCE_CODES),
      cwdAsOf: value.cwdAsOf,
      gitCapturedAt: value.gitCapturedAt,
      gitMissingReason: code(value.gitMissingReason, GIT_MISSING_REASON_CODES),
      ...(paths === 'local' ? { worktreeRoot: value.worktreeRoot as string | null } : {}),
    },
  };
}

function decodeRecord(
  value: unknown,
  paths: ExportPaths
): ExportResult<DelegationExportRecord | DelegationExportLocalRecord> {
  if (
    !object(value) ||
    !identifier(value.linkId) ||
    !identifier(value.runId) ||
    !integer(value.runSeq) ||
    value.runSeq < 1 ||
    typeof value.operation !== 'string' ||
    !OPERATIONS.has(value.operation) ||
    typeof value.linkState !== 'string' ||
    typeof value.runState !== 'string' ||
    typeof value.isCurrentRun !== 'boolean' ||
    typeof value.currentOwner !== 'boolean' ||
    !(value.predecessor === null || identifier(value.predecessor)) ||
    typeof value.hasUnresolvedConflict !== 'boolean' ||
    typeof value.relationshipConfirmed !== 'boolean' ||
    !(value.bindingReason === null || typeof value.bindingReason === 'string') ||
    !object(value.runHandshake) ||
    typeof value.runHandshake.state !== 'string' ||
    !(value.runHandshake.reason === null || typeof value.runHandshake.reason === 'string') ||
    value.cwdBasis !== 'launch' ||
    !integer(value.cwdCapturedAt) ||
    !integer(value.createdAt) ||
    !nullableTime(value.startedAt) ||
    !nullableTime(value.endedAt)
  )
    return { ok: false, reason: 'invalid_export_record' };
  if ('terminalNote' in value && value.terminalNote !== null && typeof value.terminalNote !== 'string')
    return { ok: false, reason: 'invalid_terminal_note' };
  if (value.cwdCapturedAt !== value.createdAt) return { ok: false, reason: 'invalid_cwd_capture_time' };
  const parent = decodeRef(value.parentRef),
    child = decodeRef(value.childRef),
    workspace = decodeWorkspace(value.workspaceSnapshot, paths);
  if (!parent.ok) return parent;
  if (!child.ok) return child;
  if (!workspace.ok) return workspace;
  const origin = value.projectOrigin;
  if (
    origin !== null &&
    (!object(origin) ||
      typeof origin.repoId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(origin.repoId) ||
      origin.basis !== 'declared' ||
      !integer(origin.declaredAt))
  )
    return { ok: false, reason: 'invalid_project_origin' };
  if (paths === 'local' && !absolutePath(value.launchCwd)) return { ok: false, reason: 'invalid_launch_cwd' };
  const record: DelegationExportRecord = {
    linkId: value.linkId,
    runId: value.runId,
    runSeq: value.runSeq,
    operation: value.operation as DelegationExportRecord['operation'],
    linkState: state(value.linkState, LINK_STATES) as DelegationExportRecord['linkState'],
    runState: state(value.runState, RUN_STATES) as DelegationExportRecord['runState'],
    isCurrentRun: value.isCurrentRun,
    currentOwner: value.currentOwner,
    predecessor: value.predecessor,
    hasUnresolvedConflict: value.hasUnresolvedConflict,
    parentRef: parent.value,
    childRef: child.value,
    relationshipConfirmed: value.relationshipConfirmed,
    bindingReason: code(value.bindingReason, BINDING_REASON_CODES),
    runHandshake: {
      state: state(value.runHandshake.state, HANDSHAKE_STATES) as DelegationExportRecord['runHandshake']['state'],
      reason: code(value.runHandshake.reason, HANDSHAKE_REASON_CODES),
    },
    cwdBasis: 'launch',
    cwdCapturedAt: value.cwdCapturedAt,
    workspaceSnapshot: workspace.value,
    projectOrigin:
      origin === null
        ? null
        : {
            repoId: (origin as Record<string, unknown>).repoId as string,
            basis: 'declared',
            declaredAt: (origin as Record<string, unknown>).declaredAt as number,
          },
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    ...(Object.hasOwn(value, 'terminalNote') ? { terminalNote: code(value.terminalNote, TERMINAL_NOTE_CODES) } : {}),
  };
  return {
    ok: true,
    value:
      paths === 'local'
        ? {
            ...record,
            launchCwd: value.launchCwd as string,
            workspaceSnapshot: workspace.value as DelegationExportLocalRecord['workspaceSnapshot'],
          }
        : record,
  };
}

export function decodeDelegationExport(value: unknown): ExportResult<DelegationExportV1> {
  if (typeof value === 'string') {
    try {
      return decodeDelegationExport(JSON.parse(value));
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
  }
  if (
    !object(value) ||
    value.format !== 'hud-delegation-export' ||
    value.schemaVersion !== 1 ||
    !identifier(value.ledgerId) ||
    !integer(value.asOfSeq) ||
    !integer(value.exportedAt) ||
    (value.paths !== 'none' && value.paths !== 'local') ||
    !object(value.coverage) ||
    value.coverage.state !== 'complete' ||
    !integer(value.coverage.recordCount) ||
    !Array.isArray(value.records) ||
    value.coverage.recordCount !== value.records.length
  )
    return { ok: false, reason: 'invalid_export_envelope' };
  const scope = decodeScope(value.scope);
  if (!scope.ok) return scope;
  const records: (DelegationExportRecord | DelegationExportLocalRecord)[] = [];
  const runIds = new Set<string>(),
    runKeys = new Set<string>();
  for (const raw of value.records) {
    const record = decodeRecord(raw, value.paths);
    if (!record.ok) return record;
    const key = JSON.stringify([record.value.linkId, record.value.runSeq]);
    if (runIds.has(record.value.runId) || runKeys.has(key)) return { ok: false, reason: 'duplicate_export_run' };
    if (scope.value.kind === 'links' && !scope.value.linkIds.includes(record.value.linkId))
      return { ok: false, reason: 'record_outside_scope' };
    runIds.add(record.value.runId);
    runKeys.add(key);
    records.push(record.value);
  }
  records.sort((left, right) =>
    left.linkId < right.linkId ? -1 : left.linkId > right.linkId ? 1 : left.runSeq - right.runSeq
  );
  const envelope = {
    format: 'hud-delegation-export' as const,
    schemaVersion: 1 as const,
    ledgerId: value.ledgerId,
    asOfSeq: value.asOfSeq,
    exportedAt: value.exportedAt,
    scope: scope.value,
    coverage: { state: 'complete' as const, recordCount: records.length },
  };
  return {
    ok: true,
    value:
      value.paths === 'local'
        ? { ...envelope, paths: 'local', records: records as DelegationExportLocalRecord[] }
        : { ...envelope, paths: 'none', records },
  };
}

function whitelistInputRecord(record: ExportInputRecord, paths: ExportPaths): unknown {
  const workspace = record.workspaceSnapshot;
  // List every field rather than spreading a ledger row, workspace, or diagnostic object.
  return {
    linkId: record.linkId,
    runId: record.runId,
    runSeq: record.runSeq,
    operation: record.operation,
    linkState: record.linkState,
    runState: record.runState,
    isCurrentRun: record.isCurrentRun,
    currentOwner: record.currentOwner,
    predecessor: record.predecessor,
    hasUnresolvedConflict: record.hasUnresolvedConflict,
    parentRef: record.parentRef,
    childRef: record.childRef,
    relationshipConfirmed: record.relationshipConfirmed,
    bindingReason: code(record.bindingReason, BINDING_REASON_CODES),
    runHandshake: {
      state: record.runHandshake.state,
      reason: code(record.runHandshake.reason, HANDSHAKE_REASON_CODES),
    },
    cwdBasis: record.cwdBasis,
    cwdCapturedAt: record.cwdCapturedAt,
    workspaceSnapshot:
      workspace === null
        ? null
        : {
            repoId: workspace.repoId,
            identityKind: workspace.identityKind,
            scope: workspace.scope,
            cwdSource: code(workspace.cwdSource, CWD_SOURCE_CODES),
            cwdAsOf: workspace.cwdAsOf,
            gitCapturedAt: workspace.gitCapturedAt,
            gitMissingReason: code(workspace.gitMissingReason, GIT_MISSING_REASON_CODES),
            ...(paths === 'local' ? { worktreeRoot: workspace.worktreeRoot } : {}),
          },
    projectOrigin:
      record.projectOrigin === null
        ? null
        : {
            repoId: record.projectOrigin.repoId,
            basis: record.projectOrigin.basis,
            declaredAt: record.projectOrigin.declaredAt,
          },
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    ...(Object.hasOwn(record, 'terminalNote') ? { terminalNote: record.terminalNote } : {}),
    ...(paths === 'local' ? { launchCwd: record.launchCwd } : {}),
  };
}

export const EXPORT_LIMITS = { records: 10_000, bytes: 16 * 1024 * 1024, softMs: 1000 } as const;

/** The caller measures read/assembly elapsed time; this layer performs no I/O or clock reads. */
export function serializeDelegationExport(
  input: ExportInputSnapshot,
  timing: {
    readElapsedMs: number;
    assemblyElapsedMs: number;
  }
): ExportResult<{ envelope: DelegationExportV1; json: string; bytes: number; elapsedMs: number }> {
  const elapsedMs = timing.readElapsedMs + timing.assemblyElapsedMs;
  if (
    ![timing.readElapsedMs, timing.assemblyElapsedMs].every((elapsed) => Number.isFinite(elapsed) && elapsed >= 0) ||
    elapsedMs > EXPORT_LIMITS.softMs
  )
    return { ok: false, reason: 'export_time_budget_exceeded' };
  if (input.records.length > EXPORT_LIMITS.records) return { ok: false, reason: 'export_record_budget_exceeded' };
  try {
    const decoded = decodeDelegationExport({
      format: 'hud-delegation-export',
      schemaVersion: 1,
      ledgerId: input.ledgerId,
      asOfSeq: input.asOfSeq,
      exportedAt: input.exportedAt,
      scope: input.scope,
      paths: input.paths,
      coverage: { state: 'complete', recordCount: input.records.length },
      records: input.records.map((record) => whitelistInputRecord(record, input.paths)),
    });
    if (!decoded.ok) return decoded;
    const json = `${JSON.stringify(decoded.value, null, 2)}\n`;
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > EXPORT_LIMITS.bytes) return { ok: false, reason: 'export_byte_budget_exceeded' };
    return { ok: true, value: { envelope: decoded.value, json, bytes, elapsedMs } };
  } catch {
    return { ok: false, reason: 'export_assembly_failed' };
  }
}

export function exactExportRefJoin(left: unknown, right: unknown): boolean {
  const a = decodeRef(left),
    b = decodeRef(right);
  return a.ok && b.ok && a.value !== null && b.value !== null && sameSessionRef(a.value, b.value);
}

export function isDefiniteCurrentParent(record: DelegationExportRecord): boolean {
  return (
    record.isCurrentRun &&
    record.currentOwner &&
    record.relationshipConfirmed &&
    !record.hasUnresolvedConflict &&
    record.parentRef !== null &&
    record.childRef !== null &&
    (record.linkState === 'bound' || record.linkState === 'reported') &&
    record.runState !== 'unknown'
  );
}

export function canReplaceExportScope(exitCode: number, snapshot: DelegationExportV1 | null): boolean {
  return (
    exitCode === 0 &&
    snapshot !== null &&
    snapshot.coverage.state === 'complete' &&
    snapshot.coverage.recordCount === snapshot.records.length
  );
}
