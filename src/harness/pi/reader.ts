import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { ReaderBudget, ReaderResult, SessionReader } from '../../core/interfaces/harness-adapter.js';
import type { SessionEvidence } from '../../core/interfaces/session-evidence.js';
import type { RecoveryReadGrant, RecoveryIndexLookup, RecoveryIndexHandoff } from '../../core/types/checkpoint.js';
import type { SessionRef } from '../../core/types/identity.js';
import type {
  Coverage,
  Metric,
  ObservationEvidence,
  ReaderCheckpoint,
  TokenUsage,
} from '../../core/types/observation.js';
import { initialParserState } from '../../core/observation.js';
import { RecoveryIndexOverlay, attachRecoveryIndex } from '../../core/checkpoint.js';
import { sameSessionRef, validateSessionRef } from '../../core/identity.js';
import {
  PI_RECOVERY_VERSION,
  PI_STATE,
  PI_USAGE,
  PI_RECORD,
  emptyPiSnapshot,
  observePi,
  skip,
  object,
  count,
  type PiSnapshot,
  type Timed,
  type Signature,
} from './projection.js';

class PiRecoveryRefused extends Error {
  constructor(
    readonly reason: 'bytes' | 'records' | 'deadline',
    readonly minimumBytes?: number
  ) {
    super('pi_recovery_refused');
  }
}

export const PI_READER_VERSION = 'pi-reader-1';
export const MAX_RECORD_BYTES = 1024 * 1024;
export const DEFAULT_READER_BUDGET: Readonly<ReaderBudget> = {
  maxBytes: 4 * 1024 * 1024,
  maxRecords: 2000,
  budgetMs: 20,
};
export interface PiReaderBudget extends ReaderBudget {
  deadlineMs?: number;
}
export interface PiSessionEvidence extends SessionEvidence {
  inputs: ObservationEvidence[];
  /** Separated from interaction spend; latest reported cache warm event, not an inferred total. */
  cacheWarm: Metric<TokenUsage>;
  branchView: 'last_observed';
}
export interface PiReaderResult extends ReaderResult {
  evidence: PiSessionEvidence;
  inputs: ObservationEvidence[];
}
export interface PiSessionReader extends SessionReader {
  read(budget?: PiReaderBudget): Promise<PiReaderResult>;
}
export interface PiReaderOptions {
  ref: SessionRef;
  /** Metadata-only resolution inside the selected source. The reader validates the session header. */
  resolveFile: (deadlineMs?: number) => string | null;
  /** Explicit reported context window, when supplied by the caller. No model-name inference. */
  contextWindow?: number;
}
function signature(bytes: Buffer, offset: number): Signature {
  return { offset, length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function validateSnapshot(value: unknown, ref: SessionRef): asserts value is PiSnapshot {
  if (!object(value) || JSON.stringify(value).length > 192 * 1024) throw new Error('invalid_pi_recovery_state');
  const expected = Object.keys(emptyPiSnapshot(ref)).sort();
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected) ||
    value.version !== 1 ||
    !object(value.ref) ||
    !sameSessionRef(value.ref as unknown as SessionRef, ref) ||
    typeof value.headerSeen !== 'boolean' ||
    !count(value.targetSize) ||
    !Array.isArray(value.facts) ||
    value.facts.length > 64 ||
    typeof value.missingCost !== 'boolean'
  )
    throw new Error('invalid_pi_recovery_state');
  const timed = (v: unknown, check: (value: unknown) => boolean) =>
    v === null ||
    (object(v) &&
      Object.keys(v).sort().join(',') === 'at,observedTime,value' &&
      count(v.at) &&
      typeof v.observedTime === 'boolean' &&
      check(v.value));
  const text = (v: unknown) => typeof v === 'string' && v.length <= 4096;
  const tokens = (v: unknown) =>
    object(v) &&
    Object.keys(v).sort().join(',') === 'cacheRead,cacheWrite,input,output' &&
    Object.values(v).every(count);
  if (
    !timed(value.cwd, text) ||
    !timed(value.context, count) ||
    !timed(value.cost, count) ||
    !timed(value.usage, tokens) ||
    !timed(value.cacheWarm, tokens) ||
    !timed(value.effort, text) ||
    !timed(
      value.model,
      (v) =>
        object(v) &&
        typeof v.id === 'string' &&
        v.id.length <= 256 &&
        Object.keys(v).every((k) => ['id', 'provider'].includes(k)) &&
        (v.provider === undefined || typeof v.provider === 'string')
    ) ||
    (value.startedAt !== null && !count(value.startedAt)) ||
    (value.sessionVersion !== null && !text(value.sessionVersion))
  )
    throw new Error('invalid_pi_recovery_state');
  for (const fact of value.facts)
    if (
      !object(fact) ||
      !Object.keys(fact).every((k) => ['id', 'at', 'observedTime', 'kind', 'stopReason'].includes(k)) ||
      !text(fact.id) ||
      !count(fact.at) ||
      typeof fact.observedTime !== 'boolean' ||
      !['user_message', 'assistant_message', 'ask_orchestrator', 'compact_boundary'].includes(String(fact.kind)) ||
      (fact.stopReason !== undefined && !text(fact.stopReason))
    )
      throw new Error('invalid_pi_recovery_state');
  for (const s of [value.firstSignature, value.boundarySignature])
    if (
      s !== null &&
      (!object(s) ||
        Object.keys(s).sort().join(',') !== 'length,offset,sha256' ||
        !Number.isSafeInteger(s.offset) ||
        Number(s.offset) < 0 ||
        !Number.isSafeInteger(s.length) ||
        Number(s.length) < 0 ||
        Number(s.length) > 256 ||
        typeof s.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(s.sha256))
    )
      throw new Error('invalid_pi_recovery_state');
  if (
    value.fileStat !== null &&
    (!object(value.fileStat) ||
      Object.keys(value.fileStat).sort().join(',') !== 'ctimeMs,mtimeMs,size' ||
      !Object.values(value.fileStat).every(count))
  )
    throw new Error('invalid_pi_recovery_state');
}
function project(
  ref: SessionRef,
  cp: ReaderCheckpoint,
  s: PiSnapshot,
  coverage: Coverage,
  now: number,
  lastRead: number | null,
  window?: number
): PiSessionEvidence {
  const metric = <T>(item: Timed<T> | null, source: string): Metric<T> =>
    item
      ? {
          value: structuredClone(item.value),
          quality: 'reported',
          source: source + (item.observedTime ? '.observed-time' : ''),
          asOf: item.at,
        }
      : { value: null, quality: 'unknown', source, asOf: now };
  const latest = s.facts.at(-1)?.at ?? s.startedAt;
  const context =
    s.context && count(window) && window > 0
      ? {
          ...s.context,
          value: { used: s.context.value, window, afterCompaction: cp.parserState.compactBoundary !== null },
        }
      : null;
  const inputs: ObservationEvidence[] = s.facts.map((f) => ({
    origin: 'transcript',
    ref: { ...ref },
    sourceGeneration: cp.sourceGeneration,
    validity: 'current',
    evidenceId: `${PI_READER_VERSION}:${cp.fileId.dev}:${cp.fileId.inode}:${f.id}`,
    eventAt: f.observedTime ? null : f.at,
    observedAt: now,
    lastSuccessfulReadAt: lastRead,
    value: {
      kind: f.kind,
      firstObservedAt: f.at,
      ...(f.kind === 'ask_orchestrator' ? { pendingReason: 'question' } : {}),
      ...(f.stopReason ? { stopReason: f.stopReason } : {}),
    },
  }));
  const observation: ReaderResult['observation'] = {
    nodeIdentity: { kind: 'session', ref: { ...ref } },
    statusProjection: {
      activity: 'unknown',
      pendingReason: 'none',
      lastTurnOutcome: 'none',
      liveness: 'unknown',
      freshness: {
        state: 'unknown',
        sources: [
          {
            id: 'pi-transcript',
            validity: s.headerSeen ? 'current' : 'unknown',
            lastEvidenceAt: latest,
            observedAt: now,
            lastSuccessfulReadAt: lastRead,
            deadlineAt: null,
          },
        ],
        requiredSourceIds: ['pi-transcript'],
        staleSince: null,
        reason: 'awaiting_b16_projection',
        clockAnomaly: false,
      },
      stateKey: 'unknown',
      stateSince: null,
      stateSinceBasis: 'unknown',
      isRunTerminal: null,
      asOfSeq: null,
      observationStamp: null,
      asOf: latest,
      observedAt: now,
      lastEvidenceAt: latest,
    },
    conflict: null,
    spent: {
      tokens: metric(s.usage, 'pi.assistant.unique_usage.v1'),
      costUsd: metric(
        s.missingCost ? null : s.cost,
        s.missingCost ? 'pi.assistant.cost_incomplete' : 'pi.assistant.usage.cost.total'
      ),
    },
    workspace: null,
    coverage,
    loaded: s.headerSeen,
    depth: 0,
    evidenceStamp: JSON.stringify([ref, cp.fileId, cp.sourceGeneration, cp.offset]),
    model: metric(s.model && { ...s.model, value: s.model.value.id }, 'pi.model'),
    effort: metric(s.effort, 'pi.thinking_level'),
    context: metric(
      context && {
        ...context,
        value: {
          used: context.value.used,
          window: context.value.window,
          percent: (context.value.used / context.value.window) * 100,
        },
      },
      'pi.assistant.input+cacheRead+cacheWrite'
    ),
  };
  return {
    ref: { ...ref },
    observation,
    cwd: s.cwd?.value ?? null,
    cwdSource: s.cwd ? 'transcript' : 'unknown',
    cwdAsOf: s.cwd?.at ?? null,
    startedAt: s.startedAt,
    version: s.sessionVersion,
    model: metric(s.model, 'pi.model'),
    context: metric(context, 'pi.assistant.input+cacheRead+cacheWrite'),
    reports: [],
    native: [],
    linkEvidence: [],
    caps: {},
    inputs,
    cacheWarm: metric(s.cacheWarm, 'pi.usage.cache_warm'),
    branchView: 'last_observed',
  };
}
/** Incremental, read-only pi reader. It produces native evidence, not launch/resume authority. */
export function createPiReader(options: PiReaderOptions, checkpoint?: ReaderCheckpoint): PiSessionReader {
  const ref = structuredClone(options.ref);
  validateSessionRef(ref);
  if (ref.harness !== 'pi' || ref.threadId !== null) throw new Error('invalid_pi_ref');
  if (options.contextWindow !== undefined && (!count(options.contextWindow) || options.contextWindow === 0))
    throw new Error('invalid_pi_context_window');
  let activeGrant: RecoveryReadGrant | null = null;
  let lookupCache = new Map<string, string | undefined>();
  const wrapped = new WeakMap<RecoveryIndexLookup, RecoveryIndexLookup>();
  // A verified summary is live-reader recovery progress, pinned to this exact lookup.
  const summaries = new WeakMap<RecoveryIndexLookup, string | undefined>();
  const wrapLookup = (lookup: RecoveryIndexLookup): RecoveryIndexLookup => {
    const existing = wrapped.get(lookup);
    if (existing) return existing;
    const result: RecoveryIndexLookup = {
      reference: lookup.reference,
      get(namespace, key) {
        if (!activeGrant || !lookup.getMetered) throw new Error('pi_metered_recovery_required');
        const summary = namespace === PI_STATE && key === 'snapshot';
        if (summary && summaries.has(lookup)) return summaries.get(lookup);
        const cacheKey = JSON.stringify([namespace, key]);
        if (lookupCache.has(cacheKey)) return lookupCache.get(cacheKey);
        const read = lookup.getMetered(activeGrant, namespace, key);
        if (read.kind === 'stale') throw new Error('pi_recovery_snapshot_stale');
        if (read.kind === 'refused') throw new PiRecoveryRefused(read.reason, read.minimumBytes);
        lookupCache.set(cacheKey, read.value);
        if (summary) summaries.set(lookup, read.value);
        return read.value;
      },
      page() {
        throw new Error('pi_recovery_page_unexpected');
      },
      getMetered: lookup.getMetered?.bind(lookup),
      pageMetered: lookup.pageMetered?.bind(lookup),
    };
    wrapped.set(lookup, result);
    wrapped.set(result, result);
    return result;
  };
  const handoff = checkpoint?.recoveryIndex;
  let lazyRecovery = Boolean(handoff?.lookup);
  let index = new RecoveryIndexOverlay(
    PI_RECOVERY_VERSION,
    handoff ? { delta: handoff.delta, ...(handoff.lookup ? { lookup: wrapLookup(handoff.lookup) } : {}) } : undefined
  );
  const savedCheckpoint = (): ReaderCheckpoint => {
    const saved = attachRecoveryIndex(structuredClone(cp), index);
    const raw = saved.recoveryIndex!;
    const output: RecoveryIndexHandoff = { delta: raw.delta };
    Object.defineProperties(output, {
      lookup: { value: raw.lookup },
      committed: {
        value: (lookup: RecoveryIndexLookup) => {
          lazyRecovery = true;
          raw.committed?.(wrapLookup(lookup));
        },
      },
    });
    saved.recoveryIndex = Object.freeze(output);
    return saved;
  };
  const placeholder = (): ReaderCheckpoint => ({
    schemaVersion: 1,
    readerVersion: PI_READER_VERSION,
    ref: { ...ref },
    fileId: { dev: 0, inode: 0 },
    offset: 0,
    sourceGeneration: 1,
    parserState: initialParserState(),
  });
  let cp: ReaderCheckpoint = checkpoint
    ? structuredClone((({ recoveryIndex: _index, ...value }) => value)(checkpoint))
    : placeholder();
  let snapshot = emptyPiSnapshot(ref);
  let snapshotReady = !checkpoint;
  if (checkpoint) {
    if (
      checkpoint.readerVersion !== PI_READER_VERSION ||
      checkpoint.schemaVersion !== 1 ||
      !sameSessionRef(checkpoint.ref, ref) ||
      !checkpoint.recoveryIndex ||
      !Number.isSafeInteger(cp.offset) ||
      cp.offset < 0 ||
      !Number.isSafeInteger(cp.sourceGeneration) ||
      cp.sourceGeneration < 1 ||
      cp.parserState.pendingBytes.length ||
      cp.parserState.usageMessageIds.length ||
      cp.parserState.openToolWaits.length
    )
      throw new Error('unsupported_pi_checkpoint');
    const inline = checkpoint.recoveryIndex.delta.entries.find(
      (entry) => entry.namespace === PI_STATE && entry.key === 'snapshot'
    )?.value;
    if (inline) {
      const value: unknown = JSON.parse(inline);
      validateSnapshot(value, ref);
      snapshot = value;
      snapshotReady = true;
    }
    if (
      (snapshotReady && snapshot.targetSize < cp.offset) ||
      (cp.parserState.discardingOversize &&
        (!Number.isSafeInteger(cp.parserState.discardOffset) || cp.parserState.discardOffset! < cp.offset))
    )
      throw new Error('unsupported_pi_checkpoint');
    for (const entry of checkpoint.recoveryIndex.delta.entries)
      if (!(
        (entry.namespace === PI_STATE && entry.key === 'snapshot') ||
        ([PI_USAGE, PI_RECORD].includes(entry.namespace) &&
          entry.key.length > 0 &&
          entry.key.length <= 256 &&
          entry.value === 'true')
      ))
        throw new Error('invalid_pi_recovery_entry');
  }
  let transient: { offset: number; position: number; bytes: Buffer } | null = null;
  let lastRead: number | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  function read(requested: PiReaderBudget = DEFAULT_READER_BUDGET): PiReaderResult {
    const started = performance.now();
    const { maxBytes, maxRecords, budgetMs, deadlineMs } = requested;
    if (
      ![maxBytes, maxRecords].every((v) => Number.isSafeInteger(v) && v >= 0) ||
      !count(budgetMs) ||
      (deadlineMs !== undefined && !Number.isFinite(deadlineMs))
    )
      throw new Error('invalid_reader_budget');
    const bytesLimit = Math.min(maxBytes, DEFAULT_READER_BUDGET.maxBytes);
    const recordsLimit = Math.min(maxRecords, DEFAULT_READER_BUDGET.maxRecords);
    const deadline = Math.min(started + Math.min(budgetMs, 20), deadlineMs ?? Infinity);
    const positive = bytesLimit > 0 && recordsLimit > 0 && budgetMs > 0 && deadline > started;
    const old = { cp, snapshot, index, transient, lastRead, snapshotReady };
    cp = structuredClone(cp);
    snapshot = structuredClone(snapshot);
    index = index.fork();
    let fd: number | null = null;
    let bytesRead = 0,
      recordsRead = 0,
      minimumBytes = 0;
    let recordRefusal: PiRecoveryRefused | null = null;
    let refusedRecordBytes = 0;
    let recoveredSnapshot: PiSnapshot | null = null;
    let charged = { bytesRead: 0, recordsRead: 0, elapsedMs: 0 };
    lookupCache = new Map();
    activeGrant = positive
      ? {
          now: () => performance.now(),
          remaining: () => ({
            maxBytes: Math.max(0, bytesLimit - bytesRead),
            maxRecords: Math.max(0, recordsLimit - recordsRead),
            budgetMs: Math.max(0, deadline - performance.now()),
          }),
          charge: (stats) => {
            bytesRead += stats.bytesRead;
            recordsRead += stats.recordsRead;
            charged = {
              bytesRead: charged.bytesRead + stats.bytesRead,
              recordsRead: charged.recordsRead + stats.recordsRead,
              elapsedMs: charged.elapsedMs + stats.elapsedMs,
            };
          },
          drain: () => {
            const result = charged;
            charged = { bytesRead: 0, recordsRead: 0, elapsedMs: 0 };
            return result;
          },
        }
      : null;
    try {
      if (positive && !snapshotReady) {
        const saved = index.get(PI_STATE, 'snapshot');
        if (!saved) throw new Error('unsupported_pi_checkpoint');
        const value: unknown = JSON.parse(saved);
        validateSnapshot(value, ref);
        if (value.targetSize < cp.offset) throw new Error('unsupported_pi_checkpoint');
        snapshot = value;
        snapshotReady = true;
        recoveredSnapshot = structuredClone(value);
      }
      // Warm the exact state comparison before native work. A newly ACKed lazy base
      // must not first spend a recovery record at the end of an otherwise full slice.
      if (positive && snapshotReady) index.get(PI_STATE, 'snapshot');
      const file =
        positive && bytesRead < bytesLimit && recordsRead < recordsLimit ? options.resolveFile(deadline) : null;
      if (file !== null) {
        fd = fs.openSync(file, 'r');
        const stat = fs.fstatSync(fd);
        const prior = snapshot.fileStat;
        const changed = !!prior && (prior.mtimeMs !== stat.mtimeMs || prior.ctimeMs !== stat.ctimeMs);
        let reset: ReaderCheckpoint['resetReason'] =
          cp.fileId.inode !== 0 && (cp.fileId.inode !== stat.ino || cp.fileId.dev !== stat.dev)
            ? 'file_changed'
            : cp.fileId.inode !== 0 && stat.size < snapshot.targetSize
              ? 'truncated'
              : changed && stat.size <= prior!.size
                ? 'file_changed'
                : undefined;
        const signatures =
          !reset && changed
            ? [snapshot.firstSignature, snapshot.boundarySignature].filter((s): s is Signature => s !== null)
            : [];
        const signatureBytes = signatures.reduce((n, s) => n + s.length, 0);
        if (signatureBytes > bytesLimit - bytesRead) minimumBytes = bytesRead + signatureBytes;
        else
          for (const s of signatures) {
            const buffer = Buffer.alloc(s.length);
            const n = fs.readSync(fd, buffer, 0, s.length, s.offset);
            bytesRead += n;
            if (n !== s.length || signature(buffer, s.offset).sha256 !== s.sha256) {
              reset = 'file_changed';
              break;
            }
          }
        if (!minimumBytes) {
          if (!cp.fileId.inode || reset) {
            const generation = cp.fileId.inode ? cp.sourceGeneration + 1 : cp.sourceGeneration;
            cp = {
              ...placeholder(),
              fileId: { dev: stat.dev, inode: stat.ino },
              sourceGeneration: generation,
              ...(reset ? { resetReason: reset } : {}),
            };
            snapshot = emptyPiSnapshot(ref);
            index = new RecoveryIndexOverlay(PI_RECOVERY_VERSION);
            transient = null;
          }
          const p = cp.parserState;
          if (changed) transient = null;
          if ((p.discardOffset ?? cp.offset) >= snapshot.targetSize || p.tailAtEof) snapshot.targetSize = stat.size;
          const target = snapshot.targetSize;
          if (!transient && (p.tailBytesSeen ?? 0) > 0 && !p.discardingOversize) {
            const required = Math.min(MAX_RECORD_BYTES + 1, target - cp.offset);
            if (bytesLimit - bytesRead < required) minimumBytes = bytesRead + required;
          }
          if (!minimumBytes) {
            snapshot.fileStat = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
            let pending = transient?.bytes ?? Buffer.alloc(0);
            let position = p.discardOffset ?? transient?.position ?? cp.offset;
            let consumed = false;
            const accept = (line: Buffer, end: number, atEof = false): boolean => {
              let value: unknown;
              try {
                value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
              } catch {
                if (atEof) return false;
                skip(p, 'invalid_json', true);
                return true;
              }
              // Commit each complete native record with its exact metadata, so a
              // later lazy refusal cannot replay an already completed prefix forever.
              const before = {
                snapshot,
                index,
                generation: cp.sourceGeneration,
                resetReason: cp.resetReason,
                parser: { ...p, skipped: { ...p.skipped }, gaps: [...p.gaps] },
              };
              snapshot = { ...snapshot, facts: [...snapshot.facts] };
              index = index.fork();
              try {
                if (observePi(value, snapshot, p, index, end, Date.now())) {
                  cp.sourceGeneration++;
                  cp.resetReason ??= 'compaction';
                }
                index = index.commit();
                return true;
              } catch (error) {
                snapshot = before.snapshot;
                index = before.index;
                Object.assign(p, before.parser);
                cp.sourceGeneration = before.generation;
                if (before.resetReason) cp.resetReason = before.resetReason;
                else delete cp.resetReason;
                if (!(error instanceof PiRecoveryRefused)) throw error;
                recordRefusal = error;
                refusedRecordBytes = line.length + (atEof ? 0 : 1);
                return false;
              }
            };
            const boundary = (line: Buffer, end: number) => {
              if (line.length) {
                snapshot.firstSignature ??= signature(line.subarray(0, 256), cp.offset);
                snapshot.boundarySignature = signature(
                  line.subarray(Math.max(0, line.length - 256)),
                  end - Math.min(line.length, 256)
                );
              }
              cp.offset = end;
            };
            readRecords: while (
              position < target &&
              bytesRead + (lazyRecovery ? 4 : 0) < bytesLimit &&
              recordsRead < recordsLimit &&
              (performance.now() < deadline || !consumed)
            ) {
              const buffer = Buffer.allocUnsafe(
                Math.min(32 * 1024, bytesLimit - bytesRead - (lazyRecovery ? 4 : 0), target - position)
              );
              const n = fs.readSync(fd, buffer, 0, buffer.length, position);
              bytesRead += n;
              if (!n) break;
              let cursor = 0;
              while (cursor < n && recordsRead < recordsLimit && (performance.now() < deadline || !consumed)) {
                const newline = buffer.subarray(0, n).indexOf(10, cursor);
                const end = newline < 0 ? n : newline;
                const piece = buffer.subarray(cursor, end);
                if (!p.discardingOversize) {
                  if (pending.length + piece.length > MAX_RECORD_BYTES) {
                    pending = Buffer.alloc(0);
                    p.discardingOversize = true;
                    skip(p, 'oversize_unknown', true);
                  } else pending = Buffer.concat([pending, piece]);
                }
                position += end - cursor + (newline < 0 ? 0 : 1);
                cursor = end + (newline < 0 ? 0 : 1);
                consumed = true;
                if (p.discardingOversize) p.discardOffset = position;
                if (newline >= 0) {
                  recordsRead++;
                  if (!p.discardingOversize && pending.length) {
                    if (!accept(pending, position)) break readRecords;
                    // Signatures address the actual bytes before LF (including CR).
                    snapshot.firstSignature ??= signature(pending.subarray(0, 256), cp.offset);
                    const tail = pending.subarray(Math.max(0, pending.length - 256));
                    snapshot.boundarySignature = signature(tail, position - 1 - tail.length);
                  }
                  cp.offset = position;
                  pending = Buffer.alloc(0);
                  p.discardingOversize = false;
                  p.discardOffset = null;
                }
              }
            }
            if (
              !recordRefusal &&
              position === target &&
              pending.length &&
              recordsRead < recordsLimit &&
              (performance.now() < deadline || !recordsRead)
            ) {
              recordsRead++;
              if (accept(pending, position, true)) {
                boundary(pending, position);
                pending = Buffer.alloc(0);
              } else if (!recordRefusal) recordsRead--;
            }
            if (recordRefusal) {
              pending = Buffer.alloc(0);
              position = cp.offset;
            }
            p.pendingBytes = [];
            p.tailBytesSeen = pending.length;
            p.tailAtEof = position === target && (pending.length > 0 || p.discardingOversize);
            transient = pending.length ? { offset: cp.offset, position, bytes: pending } : null;
            if (pending.length && position < target && bytesRead === bytesLimit)
              minimumBytes = Math.min(MAX_RECORD_BYTES + 1, target - cp.offset) + signatureBytes;
            if (
              !recordRefusal &&
              position < target &&
              bytesRead + (lazyRecovery ? 4 : 0) >= bytesLimit &&
              !pending.length &&
              cp.offset === old.cp.offset
            )
              minimumBytes =
                Math.min(MAX_RECORD_BYTES + 1, target - cp.offset) + signatureBytes + (lazyRecovery ? 4 : 0);
            lastRead = Date.now();
          }
        }
      }
      const p = cp.parserState;
      const remainingBytes = Math.max(0, snapshot.targetSize - (p.discardOffset ?? cp.offset));
      const coverage: Coverage = {
        state:
          minimumBytes || (recordRefusal as PiRecoveryRefused | null)?.reason === 'bytes'
            ? 'partial'
            : !snapshot.headerSeen || (remainingBytes > 0 && !p.tailAtEof)
              ? 'catching_up'
              : p.gaps.length || p.tailAtEof || p.discardingOversize
                ? 'partial'
                : 'complete',
        skipped: { ...p.skipped },
        gaps: [...p.gaps],
        remainingBytes,
        loaded: snapshot.headerSeen,
        reason: recordRefusal
          ? 'recovery_budget_exhausted'
          : minimumBytes
            ? 'record_needs_larger_slice'
            : file === null
              ? 'budget_exhausted'
              : p.tailAtEof
                ? 'incomplete_tail'
                : 'append_only_assumed_bounded_signatures;pi_branch_last_observed',
      };
      const evidence = project(ref, cp, snapshot, coverage, Date.now(), lastRead, options.contextWindow);
      if (snapshotReady && positive) index.set(PI_STATE, 'snapshot', JSON.stringify(snapshot));
      index = index.commit();
      const saved = savedCheckpoint();
      return {
        observation: evidence.observation,
        evidence,
        inputs: evidence.inputs,
        checkpoint: saved,
        recoveryIndex: saved.recoveryIndex,
        ...(recordRefusal
          ? {
              continuation:
                (recordRefusal as PiRecoveryRefused).reason === 'bytes'
                  ? {
                      kind: 'record_needs_larger_slice' as const,
                      minimumBytes: refusedRecordBytes + ((recordRefusal as PiRecoveryRefused).minimumBytes ?? 0),
                    }
                  : { kind: 'recovery_catching_up' as const, coverage: { ...coverage, state: 'catching_up' as const } },
            }
          : minimumBytes
            ? { continuation: { kind: 'record_needs_larger_slice' as const, minimumBytes } }
            : {}),
        stats: { bytesRead, recordsRead, elapsedMs: performance.now() - started },
      };
    } catch (error) {
      ({ cp, snapshot, index, transient, lastRead, snapshotReady } = old);
      if (error instanceof PiRecoveryRefused) {
        if (recoveredSnapshot) {
          snapshot = recoveredSnapshot;
          snapshotReady = true;
        }
        const coverage: Coverage = {
          state: error.reason === 'bytes' ? 'partial' : 'catching_up',
          skipped: { ...cp.parserState.skipped },
          gaps: [...cp.parserState.gaps],
          loaded: snapshotReady && snapshot.headerSeen,
          reason: 'recovery_budget_exhausted',
        };
        const evidence = project(ref, cp, snapshot, coverage, Date.now(), lastRead, options.contextWindow);
        const saved = savedCheckpoint();
        return {
          observation: evidence.observation,
          evidence,
          inputs: evidence.inputs,
          checkpoint: saved,
          recoveryIndex: saved.recoveryIndex,
          continuation:
            error.reason === 'bytes'
              ? { kind: 'record_needs_larger_slice', minimumBytes: bytesRead + (error.minimumBytes ?? 0) }
              : { kind: 'recovery_catching_up', coverage: { ...coverage, state: 'catching_up' } },
          stats: { bytesRead, recordsRead, elapsedMs: performance.now() - started },
        };
      }
      throw error;
    } finally {
      activeGrant = null;
      lookupCache.clear();
      if (fd !== null) fs.closeSync(fd);
    }
  }
  return {
    read: (budget) => {
      const next = queue.then(() => read(budget));
      queue = next.catch(() => {});
      return next;
    },
  };
}
