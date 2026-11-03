import type { ReaderResult } from '../interfaces/harness-adapter.js';
import type { ObservationEvidence } from '../types/observation.js';
import type { MergeInput, StatusFacts, StatusSource } from '../status/merge.js';
import { SESSION_EVENT_LIMIT } from '../../collectors/rollout.js';
import type { CodexCheckpoint } from '../../harness/codex/index.js';

/** Bounded native fact continuity only; B16 still owns state/notice classification. */
export interface NativeStatusMemory {
  sourceGeneration: number;
  turnAt: number | null;
  resumedAt: number;
  known: boolean;
  lastEvent: string | null;
  resetContinuity: boolean;
  initialized: boolean;
}
const WORKING_EPISODE = 'codex-working-v1:';
export function restoreNativeStatusMemory(
  anchor: string | null,
  sourceGeneration: number,
  observedAt = Infinity
): NativeStatusMemory {
  const memory: NativeStatusMemory = {
    sourceGeneration,
    turnAt: null,
    resumedAt: 0,
    known: false,
    lastEvent: null,
    resetContinuity: false,
    initialized: false,
  };
  if (!anchor?.startsWith(WORKING_EPISODE) || anchor.length > 256) return memory;
  try {
    const value: unknown = JSON.parse(anchor.slice(WORKING_EPISODE.length));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((at) => typeof at === 'number' && Number.isFinite(at) && at >= 0 && at <= observedAt) &&
      (value[1] === 0 || value[1] >= value[0])
    ) {
      memory.turnAt = value[0];
      memory.resumedAt = value[1];
      memory.known = true;
      memory.initialized = true;
    }
  } catch {
    /* Unrecognized private episode metadata cannot prove a native interval. */
  }
  return memory;
}

/** Translate explicit native facts. B16 alone chooses sources, semantics, continuity and notices. */
export function readerStatusSources(
  result: ReaderResult,
  target: MergeInput['target'],
  memory?: NativeStatusMemory
): StatusSource[] {
  if (target.nodeIdentity.kind !== 'session') throw new TypeError('session_status_target_required');
  const projection = result.observation.statusProjection;
  const context = {
    ref: target.nodeIdentity.ref,
    sourceGeneration: result.checkpoint.sourceGeneration,
    ...(target.runId === undefined ? {} : { runId: target.runId }),
    ...(target.bindingGeneration === undefined ? {} : { bindingGeneration: target.bindingGeneration }),
  };
  const inputs = (result.evidence as { inputs?: ObservationEvidence[] } | undefined)?.inputs;
  if (inputs) {
    // This is deliberately a bounded recent-evidence view, not a reconstruction of all active tools.
    const closed = new Set(
      inputs.flatMap((input) => {
        const raw = input.value as { kind?: string; callId?: string };
        return raw.kind === 'tool_finished' && raw.callId ? [raw.callId] : [];
      })
    );
    return inputs.flatMap((input, index) => {
      if (input.origin !== 'transcript') return [];
      const raw = input.value as { kind?: string; callId?: string; stopReason?: string; firstObservedAt?: number };
      let value: StatusFacts = {};
      if (raw.kind === 'assistant_message' && raw.stopReason === 'end_turn') {
        const superseded = inputs.some((later, otherIndex) => {
          if (otherIndex <= index) return false;
          const kind = (later.value as { kind?: string }).kind;
          if (
            !['user_message', 'assistant_message', 'tool_started', 'tool_finished', 'compact_boundary'].includes(
              kind ?? ''
            )
          )
            return false;
          return input.eventAt === null || later.eventAt === null || later.eventAt >= input.eventAt;
        });
        value = { ...(superseded ? {} : { activity: 'idle' as const }), lastTurnOutcome: 'completed' };
      } else if (raw.kind === 'tool_started' && raw.callId && !closed.has(raw.callId)) {
        const at = input.eventAt ?? raw.firstObservedAt;
        if (at !== undefined && at !== null)
          value = { openTool: { id: raw.callId, startedAt: at, lastActivityAt: at, deadlineAt: null } };
      }
      if (!Object.keys(value).length) return [];
      const observedAt = input.eventAt === null ? (raw.firstObservedAt ?? input.observedAt) : input.observedAt;
      return [
        {
          id: input.evidenceId ?? `claude:${raw.kind}:${raw.callId ?? input.eventAt}`,
          deadlineAt: input.lastSuccessfulReadAt === null ? null : input.lastSuccessfulReadAt + 5000,
          evidence: { ...input, ...context, observedAt, value },
        },
      ];
    });
  }
  const source = projection.freshness.sources.find((s) => s.id === 'codex-rollout');
  const cp = result.checkpoint as CodexCheckpoint;
  const cached = cp.codex?.rollout.version === 3 ? cp.codex.rollout.state.cachedResult : null;
  const activity = cached?.activity;
  const pending = cached?.pendingApproval;
  const finite = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const base = {
    origin: 'transcript' as const,
    ...context,
    observedAt: projection.observedAt,
    lastSuccessfulReadAt: source?.lastSuccessfulReadAt ?? null,
    validity: source?.validity ?? ('unknown' as const),
  };
  const make = (id: string, value: StatusFacts, eventAt: number | null): StatusSource => ({
    id,
    deadlineAt: source?.deadlineAt ?? null,
    evidence: { ...base, value, eventAt, evidenceId: JSON.stringify([id, eventAt, value.episodes ?? null]) },
  });
  const events = cached?.events ?? [];
  const marker = (event: (typeof events)[number]) => JSON.stringify([event.kind, event.at]);
  const turnClock = finite(activity?.turnStartedAt);
  const turnAt = turnClock !== null && turnClock <= projection.observedAt ? turnClock : null;
  const resumedAt = Math.max(
    0,
    ...events
      .filter(
        (event) =>
          event.kind === 'approval-answered' &&
          turnAt !== null &&
          event.at >= turnAt &&
          event.at <= projection.observedAt
      )
      .map((event) => finite(event.at) ?? 0)
  );
  const state = memory ?? restoreNativeStatusMemory(null, result.checkpoint.sourceGeneration);
  const same =
    state.initialized && state.sourceGeneration === result.checkpoint.sourceGeneration && state.turnAt === turnAt;
  const coversTurn =
    events.length < SESSION_EVENT_LIMIT || (turnAt !== null && events.length > 0 && events[0].at <= turnAt);
  const coversDelta =
    same &&
    ((state.lastEvent !== null && events.some((event) => marker(event) === state.lastEvent)) ||
      result.stats?.recordsRead === 0);
  const proof = resumedAt > 0 || coversTurn || (same && state.known && coversDelta);
  const lostHistory = !coversTurn && !coversDelta && resumedAt === 0;
  state.resetContinuity = projection.activity === 'working' && !proof && (!same || state.known || lostHistory);
  state.sourceGeneration = result.checkpoint.sourceGeneration;
  if (!same) {
    state.turnAt = turnAt;
    state.resumedAt = 0;
  }
  if (proof) state.resumedAt = Math.max(state.resumedAt, resumedAt);
  state.known = proof;
  state.initialized = true;
  state.lastEvent = events.length ? marker(events[events.length - 1]) : null;
  const workingAt = state.known && turnAt !== null ? Math.max(turnAt, state.resumedAt) : null;
  const episode = workingAt === null ? undefined : WORKING_EPISODE + JSON.stringify([turnAt, state.resumedAt]);
  return [
    ...(target.runId === undefined || projection.liveness !== 'unknown'
      ? [make('codex-rollout', { liveness: projection.liveness }, null)]
      : []),
    make(
      'codex:activity',
      {
        activity: projection.activity,
        ...(projection.activity === 'working' && episode ? { episodes: { activity: episode } } : {}),
      },
      finite(
        projection.activity === 'working'
          ? workingAt
          : projection.activity === 'waiting_input'
            ? pending?.since
            : activity?.updatedAt
      )
    ),
    make(
      'codex:pending',
      {
        pendingReason: projection.pendingReason,
        ...(pending?.callId ? { episodes: { pendingReason: `call:${pending.callId}` } } : {}),
      },
      finite(pending?.since)
    ),
    make(
      'codex:outcome',
      {
        lastTurnOutcome: projection.lastTurnOutcome,
        episodes: { lastTurnOutcome: `outcome:${projection.lastTurnOutcome}:${activity?.updatedAt ?? 'unknown'}` },
      },
      finite(activity?.updatedAt)
    ),
  ];
}
