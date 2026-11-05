import { validateRolloutRecovery, validateCodexRecoveryIndexEntry } from '../harness/codex/recovery.js';
import { validateClaudeRecoveryIndexEntry } from '../harness/claude/reader.js';
import { DefaultDeserializer, serialize } from 'node:v8';
import { canonicalJson, digest } from './canonical.js';
import { sameSessionRef } from './identity.js';
import { displayNodeKey, observationCommitValid } from './observation.js';
import { ObservationStoreError } from './collect-lease.js';
import type {
  CheckpointPreparation,
  PreparedCheckpoint,
  CheckpointIdentity,
  RecoveryIndexDelta,
  RecoveryIndexHandoff,
  RecoveryIndexReference,
  CheckpointFormat,
} from './types/checkpoint.js';
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

export const MAX_INLINE_RECOVERY_BYTES = 256 * 1024;
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
const noticeState: Check = (value) => {
  object({
    identityKey: str,
    pendingReason: literal('none', 'approval', 'question', 'needs_human'),
    lastTurnOutcome: literal('none', 'completed', 'failed', 'interrupted'),
    runState: nullable(literal('starting', 'running', 'cancelling', 'uncertain', 'ended', 'failed', 'cancelled')),
    inputStamps: strings,
    eventStamps: strings,
    reportSeq: nullable(uint),
    noticeSeq: uint,
  })(value);
  const state = value as import('./types/observation.js').ObservationNoticeState;
  if (state.inputStamps.length > 3 || state.eventStamps.length > 3) fail();
  for (const stamps of [state.inputStamps, state.eventStamps]) {
    const kinds = new Set<string>();
    for (const input of stamps) {
      const parsed = JSON.parse(input);
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 3 ||
        parsed[0] !== state.identityKey ||
        !['pending', 'failed', 'uncertain'].includes(parsed[1]) ||
        typeof parsed[2] !== 'string' ||
        (parsed[1] === 'pending' && state.pendingReason === 'none') ||
        (parsed[1] === 'failed' && state.lastTurnOutcome !== 'failed' && state.runState !== 'failed') ||
        (parsed[1] === 'uncertain' && state.runState !== 'uncertain') ||
        kinds.has(parsed[1])
      )
        fail();
      kinds.add(parsed[1]);
    }
  }
};
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
  recoveryVersion: optional(literal('claude-recovery-1')),
  reportsTruncated: optional(literal(true)),
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
    recoveryIndex: optional((v) => {
      record(v);
    }),
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
  const candidateRollout = record(c.rollout);
  if (candidateRollout.version === 3) {
    if (cp.readerVersion !== 'codex-facade-4') fail('unsupported_reader_version');
    object({
      rollout: validateRolloutRecovery,
      links: object({ pendingHudCalls: optional(dict(str)), linkEvidence: optional(array(nativeLink)) }),
      clocks: object({
        modelAt: optional(num),
        effortAt: optional(num),
        contextAt: optional(num),
        usageKey: optional(str),
        usageAt: optional(num),
      }),
      pendingHudCount: uint,
    })(c);
    if (
      candidateRollout.offset !== cp.offset ||
      candidateRollout.fileIdentity !== `${cp.fileId.dev}:${cp.fileId.inode}`
    )
      fail('observation_boundary_mismatch');
    const native = c.rollout as import('../harness/codex/recovery.js').RolloutRecovery;
    const nativeState = native.state.readStats?.state;
    if (
      !nativeState ||
      nativeState.discardingOversize !== p.discardingOversize ||
      nativeState.discardOffset !== p.discardOffset ||
      nativeState.tailBytesSeen !== p.tailBytesSeen ||
      nativeState.tailAtEof !== p.tailAtEof ||
      p.openToolWaits.length !== 0 ||
      p.usageMessageIds.length !== 0
    )
      fail('observation_boundary_mismatch');
    return undefined;
  }
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

function validateCommit(commit: ObservationCommit, checkpointValidated = false): unknown {
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
    noticeState: optional(noticeState),
  })(commit);
  if (!commit.seqDomain || commit.commitSeq < 1 || commit.leaseGeneration < 1) fail();
  const decoded = checkpointValidated ? undefined : validateCheckpoint(commit.checkpoint);
  if (!observationCommitValid(commit)) fail('observation_boundary_mismatch');
  if (commit.noticeState) {
    const state = commit.noticeState;
    const expectedIdentity = JSON.stringify([
      displayNodeKey(commit.continuity.nodeIdentity),
      commit.continuity.runId ?? null,
      commit.continuity.bindingGeneration ?? null,
    ]);
    if (
      state.identityKey !== expectedIdentity ||
      state.pendingReason !== commit.summary.statusProjection.pendingReason ||
      state.lastTurnOutcome !== commit.summary.statusProjection.lastTurnOutcome ||
      commit.notices.some((event) => event.seq > state.noticeSeq)
    )
      fail('observation_notice_state_mismatch');
  }
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
  if (content.checkpoint.codex && decoded !== undefined) {
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

/** JSON arrays have no extension slots: otherwise canonical encoding could hide named/raw state. */
function requireJsonArrayProperties(value: unknown, ancestors = new Set<object>()): void {
  if (!value || typeof value !== 'object') return;
  if (ancestors.has(value)) fail('invalid_observation_structure');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getOwnPropertySymbols(value).length ||
        Object.getOwnPropertyNames(value).some(
          (key) => key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
        )
      )
        fail('raw_tail_refused');
    }
    for (const key of Object.keys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in property)) fail('invalid_observation_structure');
      requireJsonArrayProperties(property.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function prepareObservationCandidate(input: ObservationCandidate): {
  commit: ObservationCommit;
  body: string;
  contentDigest: string;
} {
  // canonicalJson rejects getters, class instances, cycles and binary before any disk write.
  requireJsonArrayProperties(input);
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

/** Live-only cursor over one immutable lookup. It never advances on a refused page. */
export class RecoveryPageCursor {
  private after: string | null = null;
  private page: readonly import('./types/checkpoint.js').RecoveryIndexEntry[] = [];
  private position = 0;
  private finalPage = false;
  private done = false;
  constructor(
    readonly lookup: import('./types/checkpoint.js').RecoveryIndexLookup,
    readonly namespace: string
  ) {
    if (!lookup.pageMetered || !lookup.checkMetered) fail('recovery_metered_lookup_required');
  }
  next(
    grant: import('./types/checkpoint.js').RecoveryReadGrant
  ):
    | { kind: 'value'; value: import('./types/checkpoint.js').RecoveryIndexEntry }
    | { kind: 'continued'; reason: 'bytes' | 'records' | 'deadline'; minimumBytes?: number }
    | { kind: 'stale' }
    | { kind: 'done' } {
    const checked = this.lookup.checkMetered!(grant);
    if (checked.kind === 'stale') return checked;
    if (checked.kind === 'refused')
      return {
        kind: 'continued',
        reason: checked.reason,
        ...(checked.minimumBytes !== undefined ? { minimumBytes: checked.minimumBytes } : {}),
      };
    if (this.position < this.page.length) {
      const value = this.page[this.position++];
      this.after = value.key;
      return { kind: 'value', value };
    }
    if (this.done || this.finalPage) {
      this.done = true;
      return { kind: 'done' };
    }
    const remaining = grant.remaining();
    if (remaining.budgetMs <= 0) return { kind: 'continued', reason: 'deadline' };
    if (remaining.maxRecords <= 0) return { kind: 'continued', reason: 'records' };
    let limit = Math.min(128, remaining.maxRecords);
    for (;;) {
      const result = this.lookup.pageMetered!(grant, this.namespace, this.after, limit);
      if (result.kind === 'stale') return result;
      if (result.kind === 'refused') {
        if (result.reason === 'bytes' && limit > 1) {
          limit = Math.max(1, Math.floor(limit / 2));
          continue;
        }
        return {
          kind: 'continued',
          reason: result.reason,
          ...(result.minimumBytes !== undefined ? { minimumBytes: result.minimumBytes } : {}),
        };
      }
      this.page = result.value;
      this.position = 0;
      this.finalPage = result.value.length < limit;
      return this.next(grant);
    }
  }
}

/** A live, bounded-page scan of one overlay snapshot and its pinned store lookup. */
export class RecoveryOverlayCursor {
  private readonly base?: RecoveryPageCursor;
  private localIterator?: IterableIterator<[string, string | null]>;
  constructor(
    lookup: import('./types/checkpoint.js').RecoveryIndexLookup | undefined,
    readonly namespace: string,
    private readonly local: Map<string, string | null>
  ) {
    if (lookup) this.base = new RecoveryPageCursor(lookup, namespace);
  }
  next(
    grant: import('./types/checkpoint.js').RecoveryReadGrant
  ):
    | { kind: 'value'; key: string; value: string }
    | { kind: 'continued'; reason: 'bytes' | 'records' | 'deadline'; minimumBytes?: number }
    | { kind: 'stale' }
    | { kind: 'done' } {
    if (this.localIterator && this.base) {
      const verified = this.base.next(grant);
      if (verified.kind === 'stale' || verified.kind === 'continued') return verified;
      if (verified.kind !== 'done') fail('recovery_cursor_invalid');
    }
    if (!this.localIterator && this.base) {
      for (;;) {
        const item = this.base.next(grant);
        if (item.kind === 'done') break;
        if (item.kind !== 'value') return item;
        const { key, value } = item.value;
        if (this.local.has(key)) {
          const replacement = this.local.get(key);
          this.local.delete(key);
          if (replacement !== null && replacement !== undefined) return { kind: 'value', key, value: replacement };
        } else if (value !== null) return { kind: 'value', key, value };
      }
    }
    this.localIterator ??= this.local.entries();
    for (;;) {
      const item = this.localIterator.next();
      if (item.done) return { kind: 'done' };
      const [key, value] = item.value;
      if (value !== null) return { kind: 'value', key, value };
    }
  }
}

/** An exact read-through overlay. Historical keys stay in SQLite; only this slice's mutations are copied. */
export class RecoveryIndexOverlay {
  private lookup: import('./types/checkpoint.js').RecoveryIndexLookup | undefined;
  private changes = new Map<string, Map<string, string | null>>();
  private parent: RecoveryIndexOverlay | undefined;
  constructor(
    readonly recoveryVersion: string,
    handoff?: import('./types/checkpoint.js').RecoveryIndexHandoff
  ) {
    if (handoff && handoff.delta.recoveryVersion !== recoveryVersion) fail('recovery_version_mismatch');
    this.lookup = handoff?.lookup;
    if (handoff?.delta.base && !this.lookup) fail('recovery_lookup_required');
    for (const entry of handoff?.delta.entries ?? []) this.put(entry.namespace, entry.key, entry.value);
  }
  private put(namespace: string, key: string, value: string | null): void {
    let space = this.changes.get(namespace);
    if (!space) this.changes.set(namespace, (space = new Map()));
    space.set(key, value);
  }
  get(namespace: string, key: string): string | undefined {
    const space = this.changes.get(namespace);
    if (space?.has(key)) return space.get(key) ?? undefined;
    return this.parent ? this.parent.get(namespace, key) : this.lookup?.get(namespace, key);
  }
  has(namespace: string, key: string): boolean {
    return this.get(namespace, key) !== undefined;
  }
  set(namespace: string, key: string, value: string): void {
    if (this.get(namespace, key) !== value) this.put(namespace, key, value);
  }
  delete(namespace: string, key: string): void {
    if (this.has(namespace, key)) this.put(namespace, key, null);
  }
  /** Start a live scan whose local shadow cannot change underneath the cursor. */
  scan(namespace: string): RecoveryOverlayCursor {
    const layers: RecoveryIndexOverlay[] = [];
    let layer: RecoveryIndexOverlay | undefined = this;
    while (layer) {
      layers.push(layer);
      layer = layer.parent;
    }
    const local = new Map<string, string | null>();
    for (const current of layers.reverse())
      for (const [key, value] of current.changes.get(namespace) ?? []) local.set(key, value);
    return new RecoveryOverlayCursor(layers[0]?.lookup, namespace, local);
  }
  /** Apply a deletion established by a pinned scan without a second lookup. */
  deleteKnown(namespace: string, key: string): void {
    this.put(namespace, key, null);
  }
  *entries(namespace: string): IterableIterator<[string, string]> {
    const local = this.changes.get(namespace);
    let after: string | null = null;
    if (this.parent) {
      for (const [key, value] of this.parent.entries(namespace)) if (!local?.has(key)) yield [key, value];
    } else if (this.lookup) {
      while (true) {
        const requested = this.lookup.pageLimit?.(128) ?? 128;
        const page = this.lookup.page(namespace, after, requested);
        for (const entry of page) {
          if (!local?.has(entry.key) && entry.value !== null) yield [entry.key, entry.value];
        }
        if (page.length < requested) break;
        after = page[page.length - 1].key;
      }
    }
    for (const [key, value] of local ?? []) if (value !== null) yield [key, value];
  }
  /** A slice stages only touched keys. Discard the fork on error; no undo I/O or history copy. */
  fork(): RecoveryIndexOverlay {
    const fork = new RecoveryIndexOverlay(this.recoveryVersion);
    fork.parent = this;
    return fork;
  }
  /** Adopt a successful slice without lookups; metadata writes still wait for fenced publication. */
  commit(): RecoveryIndexOverlay {
    if (!this.parent) return this;
    for (const [namespace, entries] of this.changes) {
      for (const [key, value] of entries) this.parent.put(namespace, key, value);
    }
    return this.parent;
  }
  snapshot(
    onCommitted?: (lookup: import('./types/checkpoint.js').RecoveryIndexLookup) => void
  ): import('./types/checkpoint.js').RecoveryIndexHandoff {
    if (this.parent) fail('uncommitted_recovery_slice');
    const entries = Object.freeze(
      [...this.changes].flatMap(([namespace, values]) =>
        [...values].map(([key, value]) => Object.freeze({ namespace, key, value }))
      )
    );
    const handoff: import('./types/checkpoint.js').RecoveryIndexHandoff = {
      delta: Object.freeze({ recoveryVersion: this.recoveryVersion, base: this.lookup?.reference ?? null, entries }),
    };
    Object.defineProperties(handoff, {
      lookup: { value: this.lookup },
      committed: {
        value: (lookup: import('./types/checkpoint.js').RecoveryIndexLookup) => {
          for (const entry of entries) {
            const space = this.changes.get(entry.namespace);
            if (space?.get(entry.key) === entry.value) space.delete(entry.key);
            if (space?.size === 0) this.changes.delete(entry.namespace);
          }
          this.lookup = lookup;
          onCommitted?.(lookup);
        },
      },
    });
    return Object.freeze(handoff);
  }
}

export function attachRecoveryIndex<T extends ReaderCheckpoint>(
  checkpoint: T,
  index: RecoveryIndexOverlay,
  onCommitted?: (lookup: import('./types/checkpoint.js').RecoveryIndexLookup) => void
): T {
  checkpoint.recoveryIndex = index.snapshot(onCommitted);
  return checkpoint;
}

export interface PreparedCheckpointData {
  readonly checkpoint: ReaderCheckpoint;
  readonly body: string;
  readonly identity: CheckpointIdentity;
  readonly delta: RecoveryIndexDelta | null;
  readonly handoff: RecoveryIndexHandoff | undefined;
}
const preparedCheckpoints = new WeakMap<object, PreparedCheckpointData>();

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function checkpointFormat(checkpoint: ReaderCheckpoint): CheckpointFormat {
  const c = checkpoint as ReaderCheckpoint & { codex?: { rollout: { version: number } } };
  if (c.codex?.rollout.version === 2) return { name: 'codex-v8', version: 2, runtime: process.versions.v8 };
  if (c.codex?.rollout.version === 3) return { name: 'codex-recovery', version: 3, runtime: null };
  if (checkpoint.readerVersion === 'claude-reader-4') return { name: 'claude-recovery', version: 1, runtime: null };
  return { name: 'reader-json', version: 1, runtime: null };
}

/** Called by the source-local store after validating every base reference against its immutable index. */
export function prepareCheckpoint(input: CheckpointPreparation): PreparedCheckpoint {
  const handoff = input.checkpoint.recoveryIndex;
  const { recoveryIndex: _index, ...inline } = input.checkpoint;
  requireJsonArrayProperties(inline);
  const wire = canonicalJson(inline);
  if (Buffer.byteLength(wire) > MAX_INLINE_RECOVERY_BYTES) fail('checkpoint_state_oversize');
  const checkpoint = JSON.parse(wire) as ReaderCheckpoint;
  const decoded = validateCheckpoint(checkpoint);
  if (['codex-facade-4', 'claude-reader-4'].includes(checkpoint.readerVersion) && !handoff)
    fail('recovery_index_required');
  const captured = checkpointBoundary(checkpoint);
  if (digest(captured) !== digest(input.boundary) || digest(input.format) !== digest(checkpointFormat(checkpoint)))
    fail('observation_boundary_mismatch');
  if (decoded !== undefined) {
    (checkpoint as ReaderCheckpoint & { codex: { rollout: { payload: string } } }).codex.rollout.payload =
      serialize(decoded).toString('base64');
  }
  const delta = handoff ? (JSON.parse(canonicalJson(handoff.delta)) as RecoveryIndexDelta) : null;
  const references = JSON.parse(canonicalJson(input.recoveryReferences)) as RecoveryIndexReference[];
  if (delta) {
    object({ recoveryVersion: str, base: nullable((v) => record(v)), entries: array((v) => record(v)) })(delta);
    if (!delta.recoveryVersion || delta.recoveryVersion.length > 128 || !Array.isArray(delta.entries))
      fail('invalid_recovery_index');
    const seen = new Set<string>();
    for (const entry of delta.entries) {
      object({ namespace: str, key: str, value: nullable(str) })(entry);
      if (!entry.namespace || entry.namespace.length > 128 || !entry.key || entry.key.length > 4096)
        fail('invalid_recovery_index');
      if (checkpoint.ref.harness === 'claude') validateClaudeRecoveryIndexEntry(entry);
      if (
        checkpoint.ref.harness === 'codex' &&
        (checkpoint as ReaderCheckpoint & { codex?: { rollout: { version: number } } }).codex?.rollout.version === 3
      )
        validateCodexRecoveryIndexEntry(entry);
      const key = canonicalJson([entry.namespace, entry.key]);
      if (seen.has(key)) fail('invalid_recovery_index');
      seen.add(key);
      // Index values are structured metadata, never an opaque binary parser graph.
      if (entry.value !== null) {
        if (Buffer.byteLength(entry.value) > MAX_INLINE_RECOVERY_BYTES) fail('checkpoint_state_oversize');
        let value: unknown;
        try {
          value = JSON.parse(entry.value);
        } catch {
          fail('invalid_recovery_index');
        }
        publicJson(value);
      }
    }
    if (references.length && (references.length !== 1 || digest(references[0]) !== digest(delta.base)))
      fail('invalid_recovery_reference');
    if (delta.base) {
      object({ indexId: str, recoveryVersion: str, contentIdentity: str, boundary })(delta.base);
      if (
        !sameSessionRef(delta.base.boundary.ref, captured.ref) ||
        delta.base.recoveryVersion !== delta.recoveryVersion ||
        delta.base.boundary.readerVersion !== captured.readerVersion ||
        delta.base.boundary.sourceGeneration > captured.sourceGeneration ||
        digest(delta.base.boundary.fileId) !== digest(captured.fileId) ||
        delta.base.boundary.offset > captured.offset
      )
        fail('invalid_recovery_reference');
    }
    if (
      (checkpoint.readerVersion === 'codex-facade-4' && delta.recoveryVersion !== 'codex-recovery-3') ||
      (checkpoint.readerVersion === 'claude-reader-4' && delta.recoveryVersion !== 'claude-recovery-1')
    )
      fail('recovery_version_mismatch');
    references.length = 0;
    if (delta.entries.length === 0 && delta.base && digest(delta.base.boundary) === digest(captured)) {
      references.push(delta.base);
    } else {
      const contentIdentity = digest({
        base: delta.base?.contentIdentity ?? null,
        entries: delta.entries,
        boundary: captured,
        recoveryVersion: delta.recoveryVersion,
      }) as CheckpointIdentity['contentIdentity'];
      references.push({
        indexId: contentIdentity,
        recoveryVersion: delta.recoveryVersion,
        contentIdentity,
        boundary: captured,
      });
    }
  } else if (references.length) fail('recovery_delta_required');
  const body = canonicalJson(checkpoint);
  if (Buffer.byteLength(body) > MAX_INLINE_RECOVERY_BYTES) fail('checkpoint_state_oversize');
  const identity: CheckpointIdentity = freezeDeep({
    ...captured,
    format: JSON.parse(canonicalJson(input.format)),
    contentIdentity: digest({
      checkpoint,
      format: input.format,
      recoveryReferences: references,
    }) as CheckpointIdentity['contentIdentity'],
    recoveryReferences: references,
  });
  const token = Object.freeze({ identity }) as unknown as PreparedCheckpoint;
  preparedCheckpoints.set(
    token,
    Object.freeze({ checkpoint: freezeDeep(checkpoint), body, identity, delta: freezeDeep(delta), handoff })
  );
  return token;
}

export function preparedCheckpointData(token: PreparedCheckpoint): PreparedCheckpointData {
  const data = preparedCheckpoints.get(token);
  if (!data) fail('invalid_prepared_checkpoint');
  return data!;
}

export function witnessPreparedObservationBoundary(
  checkpoint: PreparedCheckpoint,
  summaryValue: ObservationView,
  summaryBoundary: ObservationBoundary
): ObservationBoundaryWitness {
  const data = preparedCheckpointData(checkpoint);
  return {
    checkpointBoundary: checkpointBoundary(data.checkpoint),
    summaryBoundary: structuredClone(summaryBoundary),
    checkpointDigest: data.identity.contentIdentity,
    summaryDigest: digest(summaryValue),
  };
}

/** Validate only the changing projection; recovery was already detached and validated by preparation. */
export function prepareProjectionCandidate(
  input: import('./interfaces/observation-store.js').PreparedObservationCandidate
): {
  commit: Omit<ObservationCommit, 'checkpoint'>;
  body: string;
  contentDigest: string;
  data: PreparedCheckpointData;
  previousCommitSeq: number;
  rebuildFromReaderVersion?: string;
} {
  const data = preparedCheckpointData(input.checkpoint);
  const wire = canonicalJson({
    commit: input.commit,
    previousCommitSeq: input.previousCommitSeq,
    boundary: input.boundary,
    ...(input.rebuildFromReaderVersion === undefined
      ? {}
      : { rebuildFromReaderVersion: input.rebuildFromReaderVersion }),
  });
  if (Buffer.byteLength(wire) > MAX_OBSERVATION_BYTES) fail('observation_too_large');
  const candidate = JSON.parse(wire) as Omit<ObservationCandidate, 'commit'> & {
    commit: Omit<ObservationCommit, 'checkpoint'>;
  };
  const full = { ...candidate.commit, checkpoint: data.checkpoint };
  validateCommit(full, true);
  if (
    full.commitSeq !== candidate.previousCommitSeq + 1 ||
    digest(checkpointBoundary(data.checkpoint)) !== digest(candidate.boundary.checkpointBoundary) ||
    digest(candidate.boundary.checkpointBoundary) !== digest(candidate.boundary.summaryBoundary) ||
    data.identity.contentIdentity !== candidate.boundary.checkpointDigest ||
    digest(full.summary) !== candidate.boundary.summaryDigest
  )
    fail('observation_boundary_mismatch');
  const projection = { ...candidate.commit, checkpointIdentity: data.identity };
  const body = canonicalJson(projection);
  // Reuse existing semantic no-op rules on a projection-sized object, with the trusted content identity as the key.
  // No checkpoint is scanned on this path. The small synthetic shell carries only content identity.
  const shell = { ...full, checkpoint: { identity: data.identity.contentIdentity } } as unknown as ObservationCommit;
  return {
    commit: candidate.commit,
    body,
    contentDigest: contentDigest(shell, undefined),
    data,
    previousCommitSeq: candidate.previousCommitSeq,
    ...(candidate.rebuildFromReaderVersion === undefined
      ? {}
      : { rebuildFromReaderVersion: candidate.rebuildFromReaderVersion }),
  };
}

/** Recovery decoding is collector-only and bounded; verify durable bytes against their prepared identity. */
export function decodeCheckpointBody(body: string, identity: CheckpointIdentity): ReaderCheckpoint {
  if (Buffer.byteLength(body) > MAX_INLINE_RECOVERY_BYTES) fail('checkpoint_state_oversize');
  let checkpoint: ReaderCheckpoint;
  try {
    checkpoint = JSON.parse(body) as ReaderCheckpoint;
  } catch {
    return fail('invalid_checkpoint_json');
  }
  validateCheckpoint(checkpoint);
  const { format, contentIdentity, recoveryReferences, ...captured } = identity;
  if (
    digest(checkpointBoundary(checkpoint)) !== digest(captured) ||
    digest(checkpointFormat(checkpoint)) !== digest(format) ||
    digest({ checkpoint, format, recoveryReferences }) !== contentIdentity
  )
    fail('invalid_checkpoint_identity');
  return checkpoint;
}

/** Validate the projection envelope independently; recovery content is never selected or decoded here. */
export function decodeProjectionBody(
  body: string,
  expectedRef: SessionRef
): import('./types/checkpoint.js').ObservationProjection {
  if (Buffer.byteLength(body) > MAX_OBSERVATION_BYTES) fail('observation_too_large');
  const value = JSON.parse(body) as import('./types/checkpoint.js').ObservationProjection;
  const { checkpointIdentity, ...commit } = value;
  object({
    ...{ ref, readerVersion: str, sourceGeneration: uint, fileId, offset: uint },
    format: object({ name: str, version: uint, runtime: nullable(str) }),
    contentIdentity: str,
    recoveryReferences: array(object({ indexId: str, recoveryVersion: str, contentIdentity: str, boundary })),
  })(checkpointIdentity);
  if (!sameSessionRef(value.ref, expectedRef)) fail('observation_boundary_mismatch');
  const cp = {
    schemaVersion: 1 as const,
    readerVersion: checkpointIdentity.readerVersion,
    ref: checkpointIdentity.ref,
    fileId: checkpointIdentity.fileId,
    offset: checkpointIdentity.offset,
    sourceGeneration: checkpointIdentity.sourceGeneration,
    parserState: {
      pendingBytes: [],
      discardingOversize: false,
      usageMessageIds: [],
      compactBoundary: null,
      openToolWaits: [],
      rateBaseline: null,
      gaps: [],
      skipped: {},
    },
  };
  validateCommit({ ...commit, notices: [...commit.notices], checkpoint: cp }, true);
  return value;
}
