import { digest, isCanonicalAbsolutePath } from './canonical.js';
import { sameSessionRef, sessionRefKey } from './identity.js';
import { isRunTerminal } from './execution.js';
import type { SessionRef } from './types/identity.js';
import type {
  CollectLease,
  CostTotal,
  DisplayNodeIdentity,
  Freshness,
  FreshnessSource,
  Metric,
  ObservationCommit,
  ObservationSelection,
  ObservationStamp,
  ObservationTarget,
  ProjectionRun,
  ReaderCheckpoint,
  ReaderParserState,
  RunExecutionProjection,
  StateContinuity,
  TreeInputNode,
  TreePlan,
  TreePlanNode,
  WorkspaceContext,
} from './types/observation.js';

export function makeMetric<T>(
  value: T | null,
  input: {
    source: string;
    asOf: number;
    quality: Metric<T>['quality'];
  }
): Metric<T> {
  if (!input.source.trim() || !Number.isFinite(input.asOf) || input.asOf < 0) {
    throw new Error('invalid_metric_provenance');
  }
  if ((input.quality === 'unknown') !== (value === null)) throw new Error('invalid_metric_value');
  return { value, ...input } as Metric<T>;
}

/** Deduplicate complete refs, and never turn absent prices into zero dollars. */
export function sumCostUsd(nodes: readonly { ref: SessionRef; costUsd: Metric<number> }[]): CostTotal {
  const unique = new Map<string, Metric<number>>();
  for (const node of nodes) {
    const key = sessionRefKey(node.ref);
    const previous = unique.get(key);
    if (!previous || node.costUsd.asOf > previous.asOf) unique.set(key, node.costUsd);
  }
  const metrics = [...unique.values()];
  const known = metrics.filter(
    (metric) =>
      metric.quality !== 'unknown' && metric.value !== null && Number.isFinite(metric.value) && metric.value >= 0
  );
  const compatible = new Set(known.map((metric) => metric.source)).size <= 1;
  const estimated = known.some((metric) => metric.quality === 'estimated');
  const missingCount = metrics.length - known.length;
  return {
    value: compatible && known.length > 0 ? known.reduce((sum, metric) => sum + metric.value!, 0) : null,
    knownCount: known.length,
    missingCount,
    coverage: missingCount === 0 && compatible ? 'complete' : 'partial',
    quality: !compatible || known.length === 0 ? 'unknown' : estimated ? 'estimated' : 'reported',
    isLowerBound: compatible && known.length > 0 && !estimated,
  };
}

/** canonicalCommonDir must already be a verified realpath; this helper does no discovery. */
export function localRepoId(canonicalCommonDir: string): string {
  if (!isCanonicalAbsolutePath(canonicalCommonDir)) {
    throw new Error('git_common_dir_not_canonical');
  }
  return digest(['git-common-dir-v1', canonicalCommonDir]);
}

export function compareWorkspace(
  a: WorkspaceContext,
  b: WorkspaceContext
): {
  cwd: 'same' | 'different' | 'unknown';
  worktree: 'same' | 'different' | 'unknown';
  repository: 'same' | 'different' | 'unknown';
} {
  const compare = (left: string | null, right: string | null) =>
    left === null || right === null
      ? ('unknown' as const)
      : left === right
        ? ('same' as const)
        : ('different' as const);
  return {
    cwd: compare(a.cwd, b.cwd),
    worktree: compare(a.worktreeRoot, b.worktreeRoot),
    repository: compare(a.repoId, b.repoId),
  };
}

export interface WorkspaceDiscoveryState {
  cwd: string;
  generation: number;
  attempted: boolean;
  value: WorkspaceContext | null;
}

/** Existing launch/collect code may execute this plan outside hot paths and transactions. */
export function workspaceDiscoveryPlan(input: {
  cwd: string;
  generation: number;
  path: 'launch' | 'collect' | 'accepted' | 'paint' | 'statusline' | 'transaction';
  cache: WorkspaceDiscoveryState | null;
}): { action: 'cached' | 'discover' | 'unavailable'; maxProcesses: number; softBudgetMs: number } {
  const matches = input.cache?.cwd === input.cwd && input.cache.generation === input.generation;
  if (matches && input.cache?.attempted) {
    return { action: input.cache.value ? 'cached' : 'unavailable', maxProcesses: 0, softBudgetMs: 0 };
  }
  if (input.path !== 'launch' && input.path !== 'collect') {
    return { action: 'unavailable', maxProcesses: 0, softBudgetMs: 0 };
  }
  return { action: 'discover', maxProcesses: 2, softBudgetMs: 200 };
}

export function displayNodeKey(identity: DisplayNodeIdentity): string {
  switch (identity.kind) {
    case 'session':
      return JSON.stringify(['session', sessionRefKey(identity.ref)]);
    case 'delegationIntent':
      return JSON.stringify(['delegationIntent', identity.linkId]);
    case 'job':
      return JSON.stringify([
        'job',
        identity.ref.kind,
        identity.ref.provider,
        identity.ref.account ?? null,
        identity.ref.key,
      ]);
  }
}

export function mergeBoundIntent(
  nodes: readonly TreePlanNode[],
  linkId: string,
  ref: SessionRef
): { nodes: TreePlanNode[]; selectionMap: Record<string, string> } {
  const oldKey = displayNodeKey({ kind: 'delegationIntent', linkId });
  const identity: DisplayNodeIdentity = { kind: 'session', ref };
  const newKey = displayNodeKey(identity);
  const result = new Map<string, TreePlanNode>();
  for (const node of nodes) {
    const key = node.key === oldKey ? newKey : node.key;
    const parentKey = node.parentKey === oldKey ? newKey : node.parentKey;
    if (key === parentKey) continue;
    const existing = result.get(key);
    if (existing) {
      // Keep one parent edge; prefer a loaded representation without manufacturing another node.
      if (!existing.loaded && node.loaded) result.set(key, { ...existing, loaded: true });
      continue;
    }
    result.set(key, { ...node, key, parentKey, identity: node.key === oldKey ? identity : node.identity });
  }
  return { nodes: [...result.values()], selectionMap: { [oldKey]: newKey } };
}

export function planTree(
  rootKey: string,
  inputs: ReadonlyMap<string, TreeInputNode>,
  budget: { maxNodes?: number; maxBytes?: number; maxDepth?: number } = {}
): TreePlan {
  const limit = (value: number | undefined, cap: number) => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('invalid_tree_budget');
    return Math.min(cap, value ?? cap);
  };
  const maxNodes = limit(budget.maxNodes, 200);
  const maxBytes = limit(budget.maxBytes, 8 * 1024 * 1024);
  const maxDepth = limit(budget.maxDepth, 4);
  const nodes: TreePlanNode[] = [];
  const visited = new Set<string>();
  const continuation = new Set<string>();
  let readBytes = 0;
  const queue = [{ key: rootKey, parentKey: null as string | null, depth: 0 }];
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    const node = inputs.get(item.key);
    if (!node) {
      continuation.add(item.key);
      continue;
    }
    const key = displayNodeKey(node.identity);
    if (visited.has(key)) continue;
    visited.add(key);
    if (nodes.length >= maxNodes) {
      continuation.add(key);
      continue;
    }
    const readCost = Number.isFinite(node.readBytes) && node.readBytes >= 0 ? node.readBytes : Infinity;
    const loaded = item.depth <= maxDepth && readBytes + readCost <= maxBytes;
    nodes.push({ identity: node.identity, key, parentKey: item.parentKey, depth: item.depth, loaded });
    if (!loaded) {
      continuation.add(key);
      continue;
    }
    readBytes += readCost;
    const children = node.children.filter((edge) => edge.kind === 'current');
    if (item.depth >= maxDepth) {
      for (const child of children) if (!visited.has(child.key)) continuation.add(child.key);
      if (children.length > 0) nodes[nodes.length - 1].loaded = false;
      continue;
    }
    for (const child of children) queue.push({ key: child.key, parentKey: key, depth: item.depth + 1 });
  }
  return {
    nodes,
    readBytes,
    continuation: [...continuation],
    confirmedSessionCount: nodes.filter((node) => node.identity.kind === 'session').length,
  };
}

/** Uses only the sources selected by B16; an unused stale fallback does not poison freshness. */
export function projectFreshness(
  sources: readonly FreshnessSource[],
  requiredSourceIds: readonly string[],
  nowMs: number
): Freshness {
  const selected = requiredSourceIds.map((id) => sources.find((source) => source.id === id));
  const clockAnomaly =
    !Number.isFinite(nowMs) ||
    selected.some(
      (source) =>
        source?.clockAnomaly ||
        [source?.lastEvidenceAt, source?.observedAt, source?.lastSuccessfulReadAt].some(
          (at) => at != null && nowMs < at
        )
    );
  const unknown =
    selected.length === 0 ||
    selected.some(
      (source) =>
        !source ||
        source.validity === 'unknown' ||
        source.validity === 'conflict' ||
        source.lastEvidenceAt === null ||
        source.deadlineAt === null ||
        ![source.lastEvidenceAt, source.deadlineAt].every((at) => Number.isFinite(at) && at! >= 0) ||
        [source.observedAt, source.lastSuccessfulReadAt].some((at) => at !== null && (!Number.isFinite(at) || at < 0))
    );
  const stale = selected.filter((source): source is FreshnessSource =>
    Boolean(source && (source.validity === 'stale' || (source.deadlineAt !== null && nowMs > source.deadlineAt)))
  );
  return {
    state: clockAnomaly || unknown ? 'unknown' : stale.length > 0 ? 'stale' : 'fresh',
    sources: [...sources],
    requiredSourceIds: [...requiredSourceIds],
    staleSince:
      !clockAnomaly && !unknown && stale.length > 0 ? Math.min(...stale.map((source) => source.deadlineAt!)) : null,
    reason: clockAnomaly
      ? 'clock_anomaly'
      : unknown
        ? 'required_source_unavailable'
        : stale.length > 0
          ? 'source_deadline_exceeded'
          : null,
    clockAnomaly,
  };
}

export function runExecutionProjection(run: ProjectionRun | null): RunExecutionProjection {
  return {
    isRunTerminal: run ? isRunTerminal(run) : null,
    execution: run?.state === 'failed' ? 'non_execution' : run ? 'managed' : 'unmanaged',
    launchFailure: run?.state === 'failed' ? { stateKey: 'launch_failed', reason: run.reason ?? null } : null,
  };
}

export function observationStampMismatch(target: ObservationTarget, stamp: ObservationStamp): string | null {
  if (!sameSessionRef(target.ref, stamp.ref)) return 'ref_mismatch';
  if (target.runId !== stamp.runId) return 'run_mismatch';
  if (target.bindingGeneration !== stamp.bindingGeneration) return 'binding_generation_mismatch';
  if (target.sourceGeneration !== stamp.sourceGeneration) return 'source_generation_mismatch';
  return null;
}

export function selectCurrentObservation<T>(
  target: ObservationTarget,
  candidate: { stamp: ObservationStamp; value: T } | null
): ObservationSelection<T> {
  const reason = candidate ? observationStampMismatch(target, candidate.stamp) : 'observation_unavailable';
  return {
    asOfSeq: target.asOfSeq,
    observation: reason ? null : candidate!.value,
    observationStamp: reason ? null : candidate!.stamp,
    rejectedObservationStamp: reason ? (candidate?.stamp ?? null) : null,
    unavailableReason: reason,
  };
}

type ContinuityInputFor<T> = T extends StateContinuity
  ? Omit<T, 'stateSince' | 'stateSinceBasis'> & {
      eventAt: number | null;
      observedAt: number | null;
      continuity: 'proven' | 'first_observation' | 'unknown';
      historicalGap?: boolean;
      clockAnomaly?: boolean;
    }
  : never;
export type ContinuityInput = ContinuityInputFor<StateContinuity>;

export function resolveStateContinuity(input: ContinuityInput, previous: StateContinuity | null): StateContinuity {
  const { eventAt, observedAt, continuity, historicalGap, clockAnomaly, ...identity } = input;
  const sameInterval =
    previous &&
    displayNodeKey(previous.nodeIdentity) === displayNodeKey(input.nodeIdentity) &&
    previous.ruleVersion === input.ruleVersion &&
    previous.runId === input.runId &&
    previous.bindingGeneration === input.bindingGeneration &&
    previous.sourceGeneration === input.sourceGeneration &&
    previous.episodeAnchor === input.episodeAnchor &&
    previous.stateKey === input.stateKey;
  if (!clockAnomaly && !historicalGap && continuity === 'proven' && sameInterval) {
    return {
      ...identity,
      stateSince: previous.stateSince,
      stateSinceBasis: previous.stateSinceBasis,
    } as StateContinuity;
  }
  const validTime = (time: number | null): time is number => time !== null && Number.isFinite(time) && time >= 0;
  if (!clockAnomaly && continuity === 'proven' && validTime(eventAt)) {
    return { ...identity, stateSince: eventAt, stateSinceBasis: 'event' } as StateContinuity;
  }
  if (!clockAnomaly && continuity !== 'unknown' && validTime(observedAt)) {
    return { ...identity, stateSince: observedAt, stateSinceBasis: 'observed' } as StateContinuity;
  }
  return { ...identity, stateSince: null, stateSinceBasis: 'unknown' } as StateContinuity;
}

export function initialParserState(): ReaderParserState {
  return {
    pendingBytes: [],
    discardingOversize: false,
    usageMessageIds: [],
    compactBoundary: null,
    openToolWaits: [],
    rateBaseline: null,
    gaps: [],
    skipped: {},
  };
}

const PUBLIC_RECORD_TYPES = new Set([
  'message',
  'user',
  'assistant',
  'tool_result',
  'turn_start',
  'turn_end',
  'token_count',
  'compact_boundary',
]);
const PRIVATE_RECORD_TYPES = new Set(['api-request-blob', 'thinking', 'reasoning', 'image']);

export const JSONL_READER_VERSION = 'jsonl-bytes-2';

/** Opaque live storage. JSON/structuredClone never includes incomplete source bytes. */
export class JsonlTransient {}
interface JsonlTransientState {
  lineage: string;
  committedOffset: number;
  position: number;
  pending: Buffer;
}
const jsonlTransients = new WeakMap<JsonlTransient, JsonlTransientState>();

/** Bytes start at byteOffset (the durable cursor by default); elapsed samples follow completed records. */
export function readJsonlBytes(input: {
  checkpoint: ReaderCheckpoint;
  bytes: Uint8Array;
  knownEndOffset: number;
  byteOffset?: number;
  transient?: JsonlTransient;
  elapsedMsAfterRecord?: readonly number[];
  budget?: { maxBytes?: number; maxRecords?: number; maxRecordBytes?: number; softMs?: number };
}): {
  checkpoint: ReaderCheckpoint;
  records: { type: string; byteEnd: number }[];
  coverage: import('./types/observation.js').Coverage;
  transient: JsonlTransient;
  nextReadOffset: number;
  continuation?: import('./interfaces/harness-adapter.js').ReaderResult['continuation'];
} {
  if (input.checkpoint.schemaVersion !== 1) throw new Error('unsupported_checkpoint_schema');
  if (input.checkpoint.readerVersion !== JSONL_READER_VERSION) throw new Error('unsupported_reader_version');
  const initial = input.checkpoint;
  const byteOffset = input.byteOffset ?? initial.parserState.discardOffset ?? initial.offset;
  if (
    !Number.isSafeInteger(initial.offset) ||
    initial.offset < 0 ||
    !Number.isSafeInteger(input.knownEndOffset) ||
    input.knownEndOffset < initial.offset ||
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < initial.offset ||
    byteOffset > input.knownEndOffset
  )
    throw new Error('reader_reset_required');
  const limit = (value: number | undefined, cap: number, minimum = 0) => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum))
      throw new Error('invalid_reader_budget');
    return Math.min(cap, value ?? cap);
  };
  const maxBytes = limit(input.budget?.maxBytes, 4 * 1024 * 1024);
  const maxRecords = limit(input.budget?.maxRecords, 2000);
  const maxRecordBytes = limit(input.budget?.maxRecordBytes, 1024 * 1024, 1);
  const softMs = limit(input.budget?.softMs, 20);
  // Old raw-tail checkpoints must be rebuilt from source, never cleared at an advanced offset.
  if (initial.parserState.pendingBytes.length !== 0) throw new Error('invalid_reader_checkpoint');
  const parserState: ReaderParserState = {
    ...initial.parserState,
    pendingBytes: [],
    gaps: [...initial.parserState.gaps],
    skipped: { ...initial.parserState.skipped },
  };
  const transient = input.transient ?? new JsonlTransient();
  const lineage = JSON.stringify([initial.ref, initial.fileId, initial.sourceGeneration, initial.readerVersion]);
  const previous = jsonlTransients.get(transient);
  const matches =
    previous?.lineage === lineage &&
    previous.committedOffset === initial.offset &&
    previous.position === byteOffset &&
    !parserState.discardingOversize;
  if (byteOffset !== initial.offset && !parserState.discardingOversize && !matches)
    throw new Error('reader_transient_unavailable');
  let pending = matches ? previous.pending : Buffer.alloc(0);
  let position = byteOffset,
    committedOffset = initial.offset,
    consumed = 0,
    completeLines = 0;
  let timeExhausted = false;
  const records: { type: string; byteEnd: number }[] = [];
  const skip = (reason: string, gap = false) => {
    parserState.skipped[reason] = (parserState.skipped[reason] ?? 0) + 1;
    if (gap && !parserState.gaps.includes(reason)) parserState.gaps.push(reason);
  };
  const parse = (bytes: Buffer) => {
    if (!bytes.length) return;
    try {
      const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r$/, '');
      if (!line.trim()) return;
      const value: unknown = JSON.parse(line);
      const type =
        value && typeof value === 'object' && !Array.isArray(value) ? (value as { type?: unknown }).type : undefined;
      if (typeof type !== 'string') skip('unknown_type', true);
      else if (PRIVATE_RECORD_TYPES.has(type)) skip(type);
      else if (!PUBLIC_RECORD_TYPES.has(type)) skip('unknown_type', true);
      else records.push({ type, byteEnd: position });
    } catch {
      skip('invalid_json', true);
    }
  };
  const availableBytes = Math.min(input.bytes.length, maxBytes, input.knownEndOffset - position);
  while (consumed < availableBytes && completeLines < maxRecords && softMs > 0) {
    const newline = input.bytes.subarray(0, availableBytes).indexOf(10, consumed);
    const end = newline < 0 ? availableBytes : newline;
    const piece = input.bytes.subarray(consumed, end);
    if (!parserState.discardingOversize) {
      if (pending.length + piece.length > maxRecordBytes) {
        pending = Buffer.alloc(0);
        parserState.discardingOversize = true;
        skip('oversize_unknown', true);
      } else pending = Buffer.concat([pending, piece]);
    }
    const count = end - consumed + (newline < 0 ? 0 : 1);
    consumed += count;
    position += count;
    if (parserState.discardingOversize) parserState.discardOffset = position;
    if (newline >= 0) {
      if (!parserState.discardingOversize) parse(pending);
      pending = Buffer.alloc(0);
      parserState.discardingOversize = false;
      parserState.discardOffset = null;
      committedOffset = position;
      completeLines++;
      const elapsed = input.elapsedMsAfterRecord?.[completeLines - 1];
      if (elapsed !== undefined && (!Number.isFinite(elapsed) || elapsed >= softMs)) {
        timeExhausted = true;
        break;
      }
    }
  }
  // A complete JSON record at this fixed EOF needs no LF; partial JSON/code points stay transient.
  if (
    position === input.knownEndOffset &&
    pending.length &&
    completeLines < maxRecords &&
    softMs > 0 &&
    !timeExhausted
  ) {
    try {
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending));
      parse(pending);
      pending = Buffer.alloc(0);
      committedOffset = position;
    } catch {
      /* Source may append the rest later. */
    }
  }
  parserState.tailBytesSeen = pending.length;
  parserState.tailAtEof = position === input.knownEndOffset && (pending.length > 0 || parserState.discardingOversize);
  const checkpoint = { ...initial, offset: committedOffset, parserState };
  jsonlTransients.set(transient, { lineage, committedOffset, position, pending });
  const remainingBytes = input.knownEndOffset - position;
  const needsLarger =
    pending.length > 0 &&
    remainingBytes > 0 &&
    consumed === maxBytes &&
    maxBytes > 0 &&
    maxRecords > 0 &&
    softMs > 0 &&
    !timeExhausted;
  return {
    checkpoint,
    records,
    transient,
    nextReadOffset: position,
    ...(needsLarger
      ? { continuation: { kind: 'record_needs_larger_slice' as const, minimumBytes: maxRecordBytes + 1 } }
      : {}),
    coverage: {
      state: needsLarger
        ? 'partial'
        : remainingBytes > 0
          ? 'catching_up'
          : parserState.gaps.length > 0 || parserState.tailAtEof
            ? 'partial'
            : 'complete',
      skipped: { ...parserState.skipped },
      gaps: [...parserState.gaps],
      remainingBytes,
      loaded: true,
      ...(needsLarger
        ? { reason: 'record_needs_larger_slice' }
        : parserState.tailAtEof
          ? { reason: 'incomplete_tail' }
          : {}),
    },
  };
}

export function resetReaderCheckpoint(
  checkpoint: ReaderCheckpoint,
  fileId: ReaderCheckpoint['fileId'],
  sourceGeneration: number,
  reason: NonNullable<ReaderCheckpoint['resetReason']>
): ReaderCheckpoint {
  return { ...checkpoint, fileId, sourceGeneration, offset: 0, parserState: initialParserState(), resetReason: reason };
}

export function collectResource(ref: SessionRef): string {
  return `collect:${sessionRefKey(ref)}`;
}

/** Only describes observation write authority; it never authorizes ledger/slot writes. */
export function collectLeaseAccess(input: {
  lease: CollectLease | null;
  ref: SessionRef;
  holder: string;
  generation: number;
  nowMs: number;
  previousNowMs: number;
  storage: 'observation' | 'ledger';
}): { writable: boolean; reason: string | null; mayChangeRunSlot: false } {
  let reason: string | null = null;
  if (input.storage !== 'observation') reason = 'wrong_storage';
  else if (
    !Number.isFinite(input.nowMs) ||
    !Number.isFinite(input.previousNowMs) ||
    input.nowMs < input.previousNowMs ||
    (input.lease !== null && !Number.isFinite(input.lease.expires_at))
  )
    reason = 'lease_time_unknown';
  else if (
    !input.lease ||
    input.lease.resource !== collectResource(input.ref) ||
    input.lease.holder !== input.holder ||
    input.lease.generation !== input.generation
  )
    reason = 'lease_fenced';
  else if (input.nowMs >= input.lease.expires_at) reason = 'lease_expired';
  return { writable: reason === null, reason, mayChangeRunSlot: false };
}

export function observationCommitValid(commit: ObservationCommit): boolean {
  const stamp = commit.observationStamp;
  const projection = commit.summary.statusProjection;
  return (
    Array.isArray(commit.checkpoint.parserState.pendingBytes) &&
    commit.checkpoint.parserState.pendingBytes.length === 0 &&
    sameSessionRef(commit.ref, stamp.ref) &&
    sameSessionRef(commit.ref, commit.checkpoint.ref) &&
    commit.summary.nodeIdentity.kind === 'session' &&
    sameSessionRef(commit.ref, commit.summary.nodeIdentity.ref) &&
    commit.continuity.nodeIdentity.kind === 'session' &&
    sameSessionRef(commit.ref, commit.continuity.nodeIdentity.ref) &&
    stamp.sourceGeneration === commit.sourceGeneration &&
    commit.checkpoint.sourceGeneration === commit.sourceGeneration &&
    commit.continuity.sourceGeneration === commit.sourceGeneration &&
    stamp.seqDomain === commit.seqDomain &&
    stamp.commitSeq === commit.commitSeq &&
    projection.observationStamp !== null &&
    digest(projection.observationStamp) === digest(stamp) &&
    projection.asOfSeq === stamp.inputLedgerSeq &&
    projection.stateKey === commit.continuity.stateKey &&
    projection.stateSince === commit.continuity.stateSince &&
    projection.stateSinceBasis === commit.continuity.stateSinceBasis &&
    commit.continuity.runId === stamp.runId &&
    commit.continuity.bindingGeneration === stamp.bindingGeneration &&
    commit.notices.every((notice) => sameSessionRef(notice.ref, commit.ref) && notice.seqDomain === commit.seqDomain)
  );
}

/** A bounded second read closes a lost-hint window; hints never change run/cursor. */
export function waitReadPlan(input: {
  runId: string;
  nextSeq: number;
  initialReadDone: boolean;
  hintRegistered: boolean;
  rereadAfterRegistration: boolean;
  relevantHint: boolean;
  deadlineReached: boolean;
}): { action: 'read' | 'register_hint' | 'wait'; runId: string; nextSeq: number } {
  const action = !input.initialReadDone
    ? 'read'
    : !input.hintRegistered
      ? 'register_hint'
      : !input.rereadAfterRegistration || input.relevantHint || input.deadlineReached
        ? 'read'
        : 'wait';
  return { action, runId: input.runId, nextSeq: input.nextSeq };
}

export function noticeBaseline<T>(
  previous: T | null,
  current: T,
  changed: (before: T, after: T) => string[]
): string[] {
  return previous === null ? [] : [...new Set(changed(previous, current))];
}
