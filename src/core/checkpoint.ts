import { DefaultDeserializer, serialize } from 'node:v8';
import { canonicalJson, digest } from './canonical.js';
import { sameSessionRef } from './identity.js';
import { observationCommitValid } from './observation.js';
import { ObservationStoreError } from './collect-lease.js';
import type { SessionRef } from './types/identity.js';
import type { ObservationCommit, ObservationView, ReaderCheckpoint } from './types/observation.js';

/** B16 captures both boundaries from the SAME ReaderResult, before adding its projection. */
export interface ObservationBoundary {
  ref: SessionRef;
  readerVersion: string;
  sourceGeneration: number;
  fileId: ReaderCheckpoint['fileId'];
  offset: number;
}
export interface ObservationBoundaryWitness {
  checkpointBoundary: ObservationBoundary;
  summaryBoundary: ObservationBoundary;
  checkpointDigest: string;
  summaryDigest: string;
}
export interface ObservationCandidate {
  commit: ObservationCommit;
  previousCommitSeq: number;
  boundary: ObservationBoundaryWitness;
  /** Explicit fenced reset; retired reader versions can never become current again. */
  rebuildFromReaderVersion?: string;
}

// 待 ARCH 裁决: legal multi-MiB native checkpoints exceed the full-tick budget.
// Validation/hashing currently runs on every publish attempt, including no-ops;
// B16 must not interpret the measured small-commit cost as a universal tick bound.
export const MAX_OBSERVATION_BYTES = 16 * 1024 * 1024;
const fail = (reason = 'invalid_observation_structure'): never => {
  throw new ObservationStoreError(reason);
};
type Check = (value: unknown) => void;
const str: Check = (v) => {
  if (typeof v !== 'string' || v.length > MAX_OBSERVATION_BYTES) fail();
};
const num: Check = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail();
};
const uint: Check = (v) => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) fail();
};
const bool: Check = (v) => {
  if (typeof v !== 'boolean') fail();
};
const optional =
  (check: Check): Check =>
  (v) => {
    if (v !== undefined) check(v);
  };
const nullable =
  (check: Check): Check =>
  (v) => {
    if (v !== null) check(v);
  };
const either =
  (a: Check, b: Check): Check =>
  (v) => {
    try {
      a(v);
    } catch {
      b(v);
    }
  };
const literal =
  (...allowed: unknown[]): Check =>
  (v) => {
    if (!allowed.includes(v)) fail();
  };
function record(v: unknown): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) ||
    Object.getOwnPropertySymbols(v).length > 0
  )
    fail();
  return v as Record<string, unknown>;
}
const object =
  (fields: Record<string, Check>): Check =>
  (v) => {
    const r = record(v);
    for (const key of Object.getOwnPropertyNames(r)) {
      if (!Object.hasOwn(fields, key)) fail('unknown_observation_field');
      if (!('value' in Object.getOwnPropertyDescriptor(r, key)!)) fail();
    }
    for (const [key, check] of Object.entries(fields)) check(r[key]);
  };
const array =
  (check: Check): Check =>
  (v) => {
    if (!Array.isArray(v) || Object.keys(v).length !== v.length) fail();
    for (const item of v as unknown[]) check(item);
  };
const dict =
  (check: Check): Check =>
  (v) => {
    for (const [key, item] of Object.entries(record(v))) {
      // Dynamic dictionaries contain identifiers/counts, never extension state.
      if (!key || key.length > 1024) fail();
      check(item);
    }
  };
const date: Check = (v) => {
  if (!(v instanceof Date) || !Number.isFinite(v.getTime()) || Object.keys(v).length) fail();
};
const strings = array(str);
const fileId = object({ dev: uint, inode: uint });
const ref = object({
  harness: literal('codex', 'claude', 'pi'),
  sourceId: str,
  sessionId: str,
  threadId: nullable(str),
});
const identity = object({ kind: literal('session'), ref });
const parserState = object({
  pendingBytes: (v) => {
    if (
      !Array.isArray(v) ||
      v.length !== 0 ||
      Object.getOwnPropertyNames(v).length !== 1 ||
      Object.getOwnPropertyNames(v)[0] !== 'length' ||
      Object.getOwnPropertySymbols(v).length !== 0
    )
      fail('raw_tail_refused');
  },
  tailBytesSeen: optional(uint),
  tailAtEof: optional(bool),
  discardingOversize: bool,
  discardOffset: optional(nullable(uint)),
  usageMessageIds: strings,
  compactBoundary: nullable(str),
  openToolWaits: array(object({ id: str, startedAt: num, lastActivityAt: num })),
  rateBaseline: nullable(object({ outputTokens: num, measuredAt: num })),
  gaps: strings,
  skipped: dict(uint),
});
const coverage = object({
  state: literal('complete', 'partial', 'catching_up'),
  skipped: dict(uint),
  gaps: strings,
  remainingBytes: optional(uint),
  loaded: bool,
  reason: optional(str),
});
const tokens = object({
  input: num,
  output: num,
  cacheRead: optional(num),
  cacheWrite: optional(num),
  reasoning: optional(num),
});
const metric =
  (value: Check): Check =>
  (v) => {
    object({ value: nullable(value), quality: literal('reported', 'estimated', 'unknown'), source: str, asOf: num })(v);
    const m = record(v);
    if ((m.quality === 'unknown') !== (m.value === null)) fail();
  };
const stamp = object({
  seqDomain: str,
  commitSeq: uint,
  inputLedgerSeq: nullable(uint),
  ref,
  runId: optional(str),
  bindingGeneration: optional(uint),
  sourceGeneration: uint,
});
const freshness = object({
  state: literal('fresh', 'stale', 'unknown'),
  requiredSourceIds: strings,
  staleSince: nullable(num),
  reason: nullable(str),
  clockAnomaly: bool,
  sources: array(
    object({
      id: str,
      validity: literal('current', 'stale', 'unknown', 'conflict'),
      lastEvidenceAt: nullable(num),
      observedAt: nullable(num),
      lastSuccessfulReadAt: nullable(num),
      deadlineAt: nullable(num),
      error: optional(str),
      reason: optional(str),
      clockAnomaly: optional(bool),
    })
  ),
});
const activity = literal('working', 'waiting_input', 'idle', 'exited', 'unknown');
const basis = literal('event', 'observed', 'unknown');
const projection = object({
  activity,
  pendingReason: literal('none', 'approval', 'question', 'needs_human'),
  lastTurnOutcome: literal('none', 'completed', 'failed', 'interrupted'),
  liveness: literal('alive', 'gone', 'unknown'),
  freshness,
  stateKey: str,
  stateSince: nullable(num),
  stateSinceBasis: basis,
  isRunTerminal: nullable(bool),
  asOfSeq: nullable(uint),
  observationStamp: nullable(stamp),
  asOf: nullable(num),
  observedAt: num,
  lastEvidenceAt: nullable(num),
  lastKnownActivity: optional(activity),
});
const continuity = object({
  ruleVersion: str,
  bindingGeneration: optional(uint),
  episodeAnchor: nullable(str),
  stateKey: str,
  stateSince: nullable(num),
  stateSinceBasis: basis,
  nodeIdentity: identity,
  runId: optional(str),
  sourceGeneration: uint,
});
const workspaceFields = {
  worktreeRoot: nullable(str),
  worktree: optional(str),
  gitCommonDir: nullable(str),
  repoId: nullable(str),
  identityKind: literal('git-common-dir-v1'),
  scope: literal('local'),
  cwdSource: str,
  cwdAsOf: num,
  gitCapturedAt: nullable(num),
  gitMissingReason: nullable(str),
};
const projectOrigin = nullable(object({ repoId: str, basis: literal('declared'), declaredAt: num }));
const processStamp = object({ pid: uint, proc_start: str, boot_id: str, pid_domain: str });
const processScope = object({
  scope_id: str,
  scope_kind: literal('pgid'),
  pgid: uint,
  sid: uint,
  group_leader: processStamp,
  boot_id: str,
  pid_domain: str,
});
/** These known complete-record public argument/locator slots allow JSON keys, never binary objects. */
const publicJson: Check = (v) => {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') return num(v);
  if (Array.isArray(v)) return array(publicJson)(v);
  for (const value of Object.values(record(v))) publicJson(value);
};
const run = object({
  runId: str,
  linkId: str,
  runSeq: uint,
  operation: literal('spawn', 'resume', 'handover'),
  targetSessionRef: nullable(ref),
  sourceId: str,
  harness: literal('codex', 'claude', 'pi'),
  expectedGeneration: uint,
  mode: literal('visible', 'headless'),
  launchCwd: str,
  workspaceSnapshot: nullable(object(workspaceFields)),
  projectOrigin,
  supervisionStrategy: literal('headless', 'wrapper'),
  scopeKind: literal('pgid'),
  scopeRef: nullable(processScope),
  state: literal('starting', 'running', 'cancelling', 'uncertain', 'ended', 'failed', 'cancelled'),
  locator: nullable(publicJson),
  launchTokenHash: str,
  launchDigest: str,
  launchPhase: literal('reserved', 'armed', 'submitting', 'submitted', 'never_submitted'),
  launchCallId: str,
  launchCorrelationId: str,
  launchMessageId: nullable(str),
  supervisor: nullable(processStamp),
  heartbeatAt: nullable(num),
  heartbeatSeq: uint,
  heartbeatMonoMs: nullable(num),
  cancelRequestedAt: nullable(num),
  submissionFencedAt: nullable(num),
  createdAt: num,
  startedAt: nullable(num),
  endedAt: nullable(num),
  exitCode: nullable(num),
  exitSignal: nullable(str),
  exitSource: nullable(literal('wait_status', 'trusted_harness_result')),
  shellStatus: nullable(num),
  shellSignal: nullable(str),
  terminalEvidenceId: nullable(str),
  orphanPolicy: literal('continue', 'stop'),
});
const report = object({
  reportId: str,
  runId: str,
  linkId: str,
  childBindingId: str,
  callerId: str,
  callerContextId: str,
  contextGeneration: uint,
  status: literal('completed', 'failed', 'blocked', 'interrupted'),
  summary: str,
  path: nullable(str),
  createdAt: num,
});
const summary = object({
  nodeIdentity: identity,
  currentRun: optional(nullable(run)),
  linkId: optional(str),
  runHandshake: optional(object({ state: literal('pending', 'claimed', 'bound'), reason: nullable(str) })),
  latestReportForRun: optional(nullable(report)),
  statusProjection: projection,
  conflict: nullable(object({ count: uint, recordIds: strings, since: num })),
  spent: object({ tokens: metric(tokens), costUsd: metric(num) }),
  workspace: nullable(object({ ...workspaceFields, cwd: nullable(str), projectOrigin })),
  coverage,
  loaded: bool,
  depth: uint,
  evidenceStamp: str,
  model: optional(metric(str)),
  effort: optional(metric(str)),
  context: optional(metric(object({ used: num, window: num, percent: num }))),
  holderLabel: optional(str),
});
const notice = object({
  seq: uint,
  seqDomain: str,
  created_at: num,
  ref,
  runId: optional(str),
  kind: literal('pending', 'failed', 'report', 'uncertain'),
  inputStamp: str,
  sourceEventSeq: optional(uint),
});
const boundary = object({ ref, readerVersion: str, sourceGeneration: uint, fileId, offset: uint });

const nativeLink = object({
  kind: literal('tool_result'),
  tool: str,
  callId: str,
  nativeMessageId: nullable(str),
  linkId: str,
  runId: str,
  eventAt: num,
  launchCallId: optional(str),
  launchCorrelationId: optional(str),
});
const launchLink = object({
  kind: literal('launch_message'),
  nativeMessageId: str,
  linkId: str,
  claimFingerprint: str,
  eventAt: num,
  launchCallId: optional(str),
  launchCorrelationId: optional(str),
});
const signature = nullable(object({ offset: uint, length: uint, sha256: str }));
const fileStat = object({ size: uint, mtimeMs: num, ctimeMs: num });
const claude = object({
  targetSize: uint,
  tailBytesSeen: uint,
  boundarySignature: signature,
  firstRecordSignature: signature,
  lastRecordHeadSignature: signature,
  lastSuccessfulReadAt: nullable(num),
  fileStat: nullable(fileStat),
  tailAtEof: bool,
  discardOffset: nullable(uint),
  factClocks: dict(num),
  factClockPages: array(dict(num)),
  statuslineKey: nullable(str),
  statuslineAt: nullable(num),
  cwd: nullable(str),
  cwdAt: nullable(num),
  startedAt: nullable(num),
  version: nullable(str),
  model: nullable(str),
  modelAt: nullable(num),
  modelObservedTime: bool,
  contextUsed: nullable(num),
  contextAt: nullable(num),
  contextObservedTime: bool,
  usage: nullable(tokens),
  usageAt: nullable(num),
  usageObservedTime: bool,
  lastEvidenceAt: nullable(num),
  pendingHudCalls: dict(str),
  links: array(either(nativeLink, launchLink)),
  reports: array(object({ kind: literal('message', 'update', 'reply'), text: str, at: num })),
  facts: array(
    object({
      id: str,
      eventAt: num,
      observedTime: bool,
      value: object({
        kind: literal('compact_boundary', 'tool_started', 'tool_finished', 'user_message', 'assistant_message'),
        callId: optional(str),
        tool: optional(str),
        isError: optional(bool),
        stopReason: optional(nullable(str)),
      }),
    })
  ),
});

const nativeTokens = object({
  input_tokens: optional(num),
  cached_input_tokens: optional(num),
  output_tokens: optional(num),
  reasoning_output_tokens: optional(num),
  total_tokens: optional(num),
});
const rate = object({ tokensPerSecond: num, sampleMs: num, sampledAt: date });
const toolCall = object({
  resultSuccess: optional(bool),
  exitCode: optional(num),
  output: optional(str),
  id: str,
  name: str,
  arguments: optional(publicJson),
  timestamp: date,
  status: literal('running', 'completed', 'error'),
  duration: optional(num),
  target: optional(str),
});
const transcript = object({
  role: literal('user', 'assistant'),
  kind: literal('prompt', 'message', 'update', 'reply'),
  text: str,
  at: date,
});
const rateWindow = nullable(
  object({
    used_percent: optional(num),
    window_minutes: optional(num),
    resets_at: optional(either(num, str)),
    resets_in_seconds: optional(num),
  })
);
const cachedResult = nullable(
  object({
    activity: optional(
      object({
        state: literal('working', 'idle', 'interrupted', 'error'),
        updatedAt: date,
        turnStartedAt: optional(date),
      })
    ),
    tokenUsageAt: optional(date),
    outputRate: optional(rate),
    session: nullable(
      object({
        id: str,
        rolloutPath: str,
        startTime: date,
        cwd: str,
        cliVersion: str,
        model: optional(str),
        reasoningEffort: optional(str),
        approvalPolicy: optional(str),
        sandboxMode: optional(str),
        collaborationMode: optional(str),
        modelProvider: optional(str),
        parentThreadId: optional(str),
        threadSource: optional(str),
        git: optional(object({ branch: optional(str), commitHash: optional(str) })),
      })
    ),
    toolActivity: object({
      recentCalls: array(toolCall),
      totalCalls: uint,
      callsByType: dict(uint),
      lastUpdateTime: date,
    }),
    planProgress: nullable(
      object({
        steps: array(object({ step: str, status: literal('pending', 'in_progress', 'completed') })),
        todos: optional(
          array(
            object({
              id: str,
              content: str,
              status: literal('pending', 'in_progress', 'completed', 'cancelled'),
              priority: literal('low', 'medium', 'high'),
            })
          )
        ),
        completedSteps: uint,
        totalSteps: uint,
        completedTodos: optional(uint),
        totalTodos: optional(uint),
        completed: optional(uint),
        total: optional(uint),
        lastUpdate: date,
      })
    ),
    tokenUsage: nullable(
      object({
        total_token_usage: optional(nativeTokens),
        last_token_usage: optional(nativeTokens),
        model_context_window: optional(num),
      })
    ),
    rateLimits: nullable(
      object({
        limit_id: optional(str),
        limit_name: optional(nullable(str)),
        primary: optional(rateWindow),
        secondary: optional(rateWindow),
        credits: optional(
          nullable(object({ has_credits: optional(bool), unlimited: optional(bool), balance: optional(str) }))
        ),
        plan_type: optional(nullable(str)),
        rate_limit_reached_type: optional(nullable(str)),
        requests_remaining: optional(num),
        tokens_remaining: optional(num),
        reset_time: optional(str),
      })
    ),
    pendingApproval: nullable(
      object({
        kind: literal('exec', 'patch', 'input'),
        callId: optional(str),
        since: date,
        summary: optional(str),
        command: optional(str),
      })
    ),
    subagents: array(
      object({
        task: optional(str),
        id: str,
        name: str,
        status: literal('starting', 'running', 'completed', 'error', 'unknown'),
        startedAt: optional(date),
        model: optional(str),
        effort: optional(str),
        lastActivityAt: optional(date),
      })
    ),
    compactCount: uint,
    lastCompactTime: nullable(date),
    lastToolActivityTime: nullable(date),
    lastAssistantMessageTime: nullable(date),
    lastEventTime: nullable(date),
    workDirs: strings,
    transcript: array(transcript),
    transcriptDroppedAt: optional(date),
    firstUserMessage: optional(transcript),
    lastUserMessageAt: optional(date),
    lastReplyAt: optional(date),
    events: array(
      object({
        kind: literal(
          'approval-requested',
          'approval-answered',
          'compacted',
          'quota',
          'turn-finished',
          'turn-interrupted',
          'turn-failed'
        ),
        at: date,
        text: optional(str),
        threshold: optional(num),
        windowMinutes: optional(num),
      })
    ),
    quotaSamples: array(
      object({
        window: literal('primary', 'secondary'),
        at: date,
        percent: num,
        windowMinutes: optional(num),
        resetsAt: optional(date),
      })
    ),
  })
);
const setOfStrings: Check = (v) => {
  if (!(v instanceof Set) || Object.keys(v).length) fail();
  for (const value of v as Set<unknown>) str(value);
};
const decodedCodex = object({
  cachedResult,
  runningCalls: (v) => {
    if (!(v instanceof Map) || Object.keys(v).length) fail();
    for (const [key, value] of v as Map<unknown, unknown>) {
      str(key);
      toolCall(value);
    }
  },
  rateTracker: object({
    baseline: optional(object({ total: num, atMs: num })),
    lastTotal: optional(num),
    lastAtMs: optional(num),
    latest: optional(rate),
    tools: setOfStrings,
    toolsStartedAtMs: optional(num),
    toolsLastAtMs: optional(num),
    excludedMs: num,
  }),
  readStats: object({
    state: parserState,
    bytesRead: uint,
    recordsRead: uint,
    remainingBytes: uint,
    elapsedMs: num,
    fileStat,
    continuation: optional(object({ kind: literal('record_needs_larger_slice'), minimumBytes: uint })),
    resetReason: optional(literal('truncated', 'file_changed')),
  }),
  needsReplay: bool,
});

function validateCheckpoint(cp: ReaderCheckpoint): unknown {
  object({
    schemaVersion: literal(1),
    readerVersion: str,
    ref,
    fileId,
    offset: uint,
    sourceGeneration: uint,
    parserState,
    resetReason: optional(literal('truncated', 'file_changed', 'compaction', 'branch_changed')),
    codex: optional((v) => {
      if (cp.ref.harness !== 'codex') fail();
      record(v);
    }),
    claude: optional((v) => {
      if (cp.ref.harness !== 'claude') fail();
      claude(v);
    }),
  })(cp);
  if (cp.sourceGeneration < 1 || !cp.readerVersion) fail();
  const p = cp.parserState;
  if (p.discardingOversize && (!Number.isSafeInteger(p.discardOffset) || p.discardOffset! < cp.offset))
    fail('observation_boundary_mismatch');
  const extensions = cp as ReaderCheckpoint & { codex?: Record<string, unknown>; claude?: Record<string, unknown> };
  if (extensions.claude) {
    const c = extensions.claude;
    if (
      Number(c.targetSize) < cp.offset ||
      p.discardingOversize !== (c.discardOffset !== null) ||
      (c.discardOffset !== null &&
        (Number(c.discardOffset) < cp.offset || Number(c.discardOffset) > Number(c.targetSize)))
    )
      fail('observation_boundary_mismatch');
  }
  if (!extensions.codex) return undefined;
  const c = extensions.codex;
  object({
    rollout: object({
      version: literal(2),
      runtime: literal(process.versions.v8),
      offset: uint,
      fileIdentity: str,
      payload: str,
    }),
    links: object({ pendingHudCalls: optional(dict(str)), linkEvidence: optional(array(nativeLink)) }),
    clocks: object({
      modelAt: optional(num),
      effortAt: optional(num),
      contextAt: optional(num),
      usageKey: optional(str),
      usageAt: optional(num),
    }),
  })(c);
  const rollout = record(c.rollout);
  if (rollout.offset !== cp.offset || rollout.fileIdentity !== `${cp.fileId.dev}:${cp.fileId.inode}`)
    fail('observation_boundary_mismatch');
  const payload = rollout.payload as string;
  if (payload.length > MAX_OBSERVATION_BYTES) fail('invalid_codex_payload');
  const encoded = Buffer.from(payload, 'base64');
  if (encoded.toString('base64') !== payload) fail('invalid_codex_payload');
  let decoded: unknown;
  try {
    const decoder = new DefaultDeserializer(encoded);
    if (!decoder.readHeader()) fail('invalid_codex_payload');
    decoded = decoder.readValue();
    let hasTrailingBytes = false;
    try {
      decoder.readRawBytes(1);
      hasTrailingBytes = true;
    } catch {
      // At the exact end, even a one-byte read fails. The convenience
      // deserialize() API silently ignores a second value or raw suffix.
    }
    if (hasTrailingBytes) fail('invalid_codex_payload');
  } catch {
    fail('invalid_codex_payload');
  }
  // Known version-2 native structure only. Future unprovable native state: 待 ARCH 裁决;
  // rather than silently carrying unprovable raw bytes into durable observation storage.
  decodedCodex(decoded);
  const saved = record(decoded);
  const stats = record(saved.readStats);
  const nativeState = record(stats.state);
  if (
    nativeState.discardingOversize !== p.discardingOversize ||
    nativeState.discardOffset !== p.discardOffset ||
    nativeState.tailBytesSeen !== p.tailBytesSeen ||
    nativeState.tailAtEof !== p.tailAtEof ||
    Number(record(stats.fileStat).size) < cp.offset
  )
    fail('observation_boundary_mismatch');
  return decoded;
}

export function checkpointBoundary(checkpoint: ReaderCheckpoint): ObservationBoundary {
  return structuredClone({
    ref: checkpoint.ref,
    readerVersion: checkpoint.readerVersion,
    sourceGeneration: checkpoint.sourceGeneration,
    fileId: checkpoint.fileId,
    offset: checkpoint.offset,
  });
}

/** The witness is a trusted collector assertion, not a signature authorizing untrusted publishers. */
export function witnessObservationBoundary(
  checkpoint: ReaderCheckpoint,
  summary: ObservationView,
  summaryBoundary: ObservationBoundary
): ObservationBoundaryWitness {
  return {
    checkpointBoundary: checkpointBoundary(checkpoint),
    summaryBoundary: structuredClone(summaryBoundary),
    checkpointDigest: digest(checkpoint),
    summaryDigest: digest(summary),
  };
}

function validateCommit(commit: ObservationCommit): unknown {
  object({
    ref,
    sourceGeneration: uint,
    leaseGeneration: uint,
    seqDomain: str,
    commitSeq: uint,
    observationStamp: stamp,
    checkpoint: (v) => record(v),
    summary,
    continuity,
    notices: array(notice),
  })(commit);
  if (!commit.seqDomain || commit.commitSeq < 1 || commit.leaseGeneration < 1) fail();
  const decoded = validateCheckpoint(commit.checkpoint);
  if (!observationCommitValid(commit)) fail('observation_boundary_mismatch');
  if ((commit.continuity.stateSinceBasis === 'unknown') !== (commit.continuity.stateSince === null)) fail();
  const p = commit.checkpoint.parserState;
  if ((p.tailAtEof || p.discardingOversize || p.gaps.length > 0) && commit.summary.coverage.state === 'complete')
    fail('observation_boundary_mismatch');
  for (const gap of p.gaps) if (!commit.summary.coverage.gaps.includes(gap)) fail('observation_boundary_mismatch');
  let seq = 0;
  for (const event of commit.notices) {
    if (event.seq <= seq || event.runId !== commit.observationStamp.runId) fail('observation_boundary_mismatch');
    seq = event.seq;
  }
  return decoded;
}

/** Only read clocks and assigned publication stamps are excluded from unchanged-content detection. */
function contentDigest(commit: ObservationCommit, decoded: unknown): string {
  const content = structuredClone(commit) as unknown as Record<string, any>;
  delete content.commitSeq;
  delete content.leaseGeneration;
  delete content.observationStamp.commitSeq;
  delete content.summary.statusProjection.observationStamp.commitSeq;
  delete content.summary.statusProjection.observedAt;
  for (const source of content.summary.statusProjection.freshness.sources) {
    delete source.observedAt;
    delete source.lastSuccessfulReadAt;
  }
  for (const metric of [
    content.summary.spent.tokens,
    content.summary.spent.costUsd,
    content.summary.model,
    content.summary.effort,
    content.summary.context,
  ]) {
    if (metric?.quality === 'unknown') delete metric.asOf;
  }
  if (content.checkpoint.claude) delete content.checkpoint.claude.lastSuccessfulReadAt;
  if (content.checkpoint.codex) {
    const native = decoded as Record<string, any>;
    // Keep the native bytes themselves in the commit, but fingerprint their stable parsed content.
    const stats = { ...native.readStats };
    // The facade updates derived rate/tool/compaction metadata after exporting its
    // native payload. Hash the authoritative durable outer state for these fields.
    stats.state = content.checkpoint.parserState;
    delete stats.bytesRead;
    delete stats.recordsRead;
    delete stats.elapsedMs;
    const stable = { ...native, readStats: stats };
    // V8-only containers have an explicit deterministic JSON view for hashing.
    const json = JSON.stringify(stable, (_key, value) =>
      value instanceof Map ? [...value] : value instanceof Set ? [...value] : value
    );
    content.checkpoint.codex.rollout.payload = JSON.parse(json);
  }
  return digest(content);
}

export function prepareObservationCandidate(input: ObservationCandidate): {
  commit: ObservationCommit;
  body: string;
  contentDigest: string;
} {
  // canonicalJson rejects getters, class instances, cycles and binary before any disk write.
  const wire = canonicalJson(input);
  if (Buffer.byteLength(wire) > MAX_OBSERVATION_BYTES) fail('observation_too_large');
  const candidate = JSON.parse(wire) as ObservationCandidate;
  object({
    commit: (v) => record(v),
    previousCommitSeq: uint,
    rebuildFromReaderVersion: optional(str),
    boundary: object({
      checkpointBoundary: boundary,
      summaryBoundary: boundary,
      checkpointDigest: str,
      summaryDigest: str,
    }),
  })(candidate);
  const commit = candidate.commit;
  const decoded = validateCommit(commit);
  if (
    commit.commitSeq !== candidate.previousCommitSeq + 1 ||
    digest(checkpointBoundary(commit.checkpoint)) !== digest(candidate.boundary.checkpointBoundary) ||
    digest(candidate.boundary.checkpointBoundary) !== digest(candidate.boundary.summaryBoundary) ||
    digest(commit.checkpoint) !== candidate.boundary.checkpointDigest ||
    digest(commit.summary) !== candidate.boundary.summaryDigest
  )
    fail('observation_boundary_mismatch');
  if (decoded !== undefined) {
    // V8 has no unique wire encoding: real producer values may re-encode
    // differently. Persist only the validated value, never shadow bytes from
    // duplicate Map keys or other bytes invisible to the decoded structure.
    const native = commit.checkpoint as ReaderCheckpoint & { codex: { rollout: { payload: string } } };
    native.codex.rollout.payload = serialize(decoded).toString('base64');
  }
  return { commit, body: canonicalJson(commit), contentDigest: contentDigest(commit, decoded) };
}

export function decodePublishedCommit(body: string, expectedRef: SessionRef): ObservationCommit {
  if (Buffer.byteLength(body) > MAX_OBSERVATION_BYTES) fail('observation_too_large');
  let commit: ObservationCommit;
  try {
    commit = JSON.parse(body) as ObservationCommit;
  } catch {
    return fail('invalid_observation_json');
  }
  validateCommit(commit);
  if (!sameSessionRef(commit.ref, expectedRef)) fail('observation_boundary_mismatch');
  return commit;
}
