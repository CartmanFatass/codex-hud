import type { RolloutParseResult, RolloutReadStats } from '../../collectors/rollout.js';
import type { TokenRateSnapshot } from '../../collectors/token-rate.js';
import type { PlanProgress, ToolCall } from '../../types.js';
import type { RecoveryIndexEntry } from '../../core/types/checkpoint.js';

type Wire<T> = T extends Date
  ? number
  : T extends readonly (infer V)[]
    ? Wire<V>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;
export type RecoveryToolCall = Omit<ToolCall, 'arguments' | 'output'> & {
  argumentsMissing?: true;
  outputMissing?: true;
  targetTruncated?: true;
};
export interface RateRecovery {
  baseline?: { total: number; atMs: number };
  lastTotal?: number;
  lastAtMs?: number;
  latest?: Wire<TokenRateSnapshot>;
  toolsStartedAtMs?: number;
  toolsLastAtMs?: number;
  excludedMs: number;
}
export interface RolloutRecovery {
  version: 3;
  offset: number;
  fileIdentity?: string;
  state: {
    cachedResult: Wire<RolloutParseResult> | null;
    rateTracker: RateRecovery;
    runningCount: number;
    runningTail: string | null;
    subagentCount: number;
    typeCount: number;
    rateToolsCount: number;
    readStats?: RolloutReadStats;
    needsReplay: boolean;
    materialMissing?: PlanMaterialMissing;
  };
}
const fail = (_reason?: string): never => {
  throw new Error('invalid_rollout_checkpoint');
};
const MAX_OBSERVATION_BYTES = 256 * 1024;
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
      if (!Object.hasOwn(fields, key)) fail();
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
const date: Check = (value) => {
  num(value);
  if (!Number.isFinite(new Date(value as number).getTime())) fail();
};
const strings = array(str);
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
  outputMissing: optional(literal(true)),
  argumentsMissing: optional(literal(true)),
  targetTruncated: optional(literal(true)),
  id: str,
  name: str,
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
const subagent = object({
  task: optional(str),
  id: str,
  name: str,
  status: literal('starting', 'running', 'completed', 'error', 'unknown'),
  startedAt: optional(date),
  model: optional(str),
  effort: optional(str),
  lastActivityAt: optional(date),
});
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
    subagents: array(subagent),
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

const rateRecovery = object({
  baseline: optional(object({ total: num, atMs: num })),
  lastTotal: optional(num),
  lastAtMs: optional(num),
  latest: optional(rate),
  toolsStartedAtMs: optional(num),
  toolsLastAtMs: optional(num),
  excludedMs: num,
});
const readStats = object({
  state: parserState,
  bytesRead: uint,
  recordsRead: uint,
  remainingBytes: uint,
  elapsedMs: num,
  fileStat: object({ size: uint, mtimeMs: num, ctimeMs: num }),
  continuation: optional(object({ kind: literal('record_needs_larger_slice'), minimumBytes: uint })),
  resetReason: optional(literal('truncated', 'file_changed')),
});
export function validateRolloutRecovery(value: unknown): asserts value is RolloutRecovery {
  object({
    version: literal(3),
    offset: uint,
    fileIdentity: optional(str),
    state: object({
      cachedResult,
      rateTracker: rateRecovery,
      runningCount: uint,
      rateToolsCount: uint,
      runningTail: nullable(str),
      subagentCount: uint,
      typeCount: uint,
      readStats: optional(readStats),
      needsReplay: bool,
      materialMissing: optional(object({ planSteps: uint, planTodos: uint, planText: optional(literal(true)) })),
    }),
  })(value);
  const cp = value as RolloutRecovery;
  if ((cp.state.runningCount === 0) !== (cp.state.runningTail === null)) fail();
  if (cp.state.readStats && cp.state.readStats.fileStat.size < cp.offset) fail();
  if (cp.state.readStats?.state.openToolWaits.length || cp.state.readStats?.state.usageMessageIds.length) fail();
}
const DATE_FIELDS = new Set([
  'timestamp',
  'startTime',
  'at',
  'sampledAt',
  'updatedAt',
  'turnStartedAt',
  'tokenUsageAt',
  'since',
  'lastUpdateTime',
  'lastUpdate',
  'startedAt',
  'lastActivityAt',
  'lastCompactTime',
  'lastToolActivityTime',
  'lastAssistantMessageTime',
  'lastEventTime',
  'transcriptDroppedAt',
  'lastUserMessageAt',
  'lastReplyAt',
  'resetsAt',
]);
/** Applied only to explicit recovery metadata, never the parser's object graph. */
export function metadataToWire<T>(value: T): Wire<T> {
  if (value instanceof Date) return value.getTime() as Wire<T>;
  if (Array.isArray(value)) return value.map(metadataToWire) as Wire<T>;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([key, v]) => [key, metadataToWire(v)])
    ) as Wire<T>;
  }
  return value as Wire<T>;
}
export function metadataFromWire<T>(value: Wire<T>): T {
  const visit = (v: unknown, key = ''): unknown => {
    if (typeof v === 'number' && DATE_FIELDS.has(key)) return new Date(v);
    if (Array.isArray(v)) return v.map((entry) => visit(entry));
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, entry]) => [k, visit(entry, k)]));
    return v;
  };
  return visit(value) as T;
}
export function compactToolCall(call: ToolCall): RecoveryToolCall {
  const prior = call as RecoveryToolCall;
  return {
    id: call.id,
    name: call.name,
    timestamp: call.timestamp,
    status: call.status,
    ...(call.duration === undefined ? {} : { duration: call.duration }),
    ...(call.resultSuccess === undefined ? {} : { resultSuccess: call.resultSuccess }),
    ...(call.exitCode === undefined ? {} : { exitCode: call.exitCode }),
    ...(call.target === undefined ? {} : { target: call.target.slice(0, 512) }),
    ...(call.arguments !== undefined || prior.argumentsMissing ? { argumentsMissing: true as const } : {}),
    ...(call.output !== undefined || prior.outputMissing ? { outputMissing: true as const } : {}),
    ...((call.target && call.target.length > 512) || prior.targetTruncated ? { targetTruncated: true as const } : {}),
  };
}
export function encodeRecoveryToolCall(call: ToolCall): string {
  return JSON.stringify(metadataToWire(compactToolCall(call)));
}
export function decodeRecoveryToolCall(raw: string): ToolCall {
  const value: unknown = JSON.parse(raw);
  toolCall(value);
  return metadataFromWire<RecoveryToolCall>(value as Wire<RecoveryToolCall>);
}
export function validateCodexRecoveryIndexEntry(entry: RecoveryIndexEntry): void {
  if (!entry.key || entry.key.length > 4096) fail();
  if (
    ![
      'codex.running',
      'codex.running-order',
      'codex.rate-tools',
      'codex.hud-pending',
      'codex.subagents',
      'codex.tool-types',
    ].includes(entry.namespace)
  )
    fail();
  if (entry.value === null) return;
  const value: unknown = JSON.parse(entry.value);
  if (entry.namespace === 'codex.running') {
    toolCall(value);
    if ((value as { id: string }).id !== entry.key) fail();
  } else if (entry.namespace === 'codex.running-order') object({ previous: nullable(str), next: nullable(str) })(value);
  else if (entry.namespace === 'codex.rate-tools') literal(true)(value);
  else if (entry.namespace === 'codex.tool-types') uint(value);
  else if (entry.namespace === 'codex.subagents') {
    subagent(value);
    if ((value as { id: string }).id !== entry.key) fail();
  } else str(value);
}

export interface PlanMaterialMissing {
  planSteps: number;
  planTodos: number;
  planText?: true;
}
/** Display material is bounded independently of exact progress counters and pending state. */
export function compactPlan(plan: PlanProgress | null): { plan: PlanProgress | null; missing?: PlanMaterialMissing } {
  if (!plan) return { plan: null };
  const missing: PlanMaterialMissing = { planSteps: 0, planTodos: 0 };
  const excerpt = (text: string): string => {
    if (text.length <= 512) return text;
    missing.planText = true;
    return `${text.slice(0, 511)}…`;
  };
  // Keep the active step/todo even when it lies beyond the display excerpt.
  const steps = plan.steps.slice(0, 32);
  const current = plan.steps.find((step) => step.status === 'in_progress');
  if (current && !steps.includes(current)) steps[steps.length - 1] = current;
  missing.planSteps = plan.steps.length - steps.length;
  const todos = plan.todos?.slice(0, 16);
  const activeTodo = plan.todos?.find((todo) => todo.status === 'in_progress');
  if (todos && activeTodo && !todos.includes(activeTodo)) todos[todos.length - 1] = activeTodo;
  missing.planTodos = (plan.todos?.length ?? 0) - (todos?.length ?? 0);
  const compact: PlanProgress = {
    steps: steps.map((step) => ({ step: excerpt(step.step), status: step.status })),
    ...(todos
      ? {
          todos: todos.map((todo) => ({
            id: todo.id,
            content: excerpt(todo.content),
            status: todo.status,
            priority: todo.priority,
          })),
        }
      : {}),
    completedSteps: plan.completedSteps,
    totalSteps: plan.totalSteps,
    ...(plan.completedTodos === undefined ? {} : { completedTodos: plan.completedTodos }),
    ...(plan.totalTodos === undefined ? {} : { totalTodos: plan.totalTodos }),
    ...(plan.completed === undefined ? {} : { completed: plan.completed }),
    ...(plan.total === undefined ? {} : { total: plan.total }),
    lastUpdate: plan.lastUpdate,
  };
  return { plan: compact, ...(missing.planSteps || missing.planTodos || missing.planText ? { missing } : {}) };
}
