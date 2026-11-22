/** Collection cadence only. Rendering and input keep their own timers. */
export interface AdaptivePollState {
  readonly baseIntervalMs: number;
  readonly maxIdleIntervalMs: number;
  readonly intervalMs: number;
  readonly nextDueAt: number;
  readonly scopeKey?: string;
  readonly fingerprint?: string;
  readonly stablePolls: number;
}

export interface AdaptivePollObservation {
  /** Session identity and collection mode, joined by the caller. */
  scopeKey: string;
  nowMs: number;
  /** Quiet requires positive idle evidence; silence alone is uncertain. */
  activity: 'active' | 'quiet' | 'uncertain';
  /** Stable source identity/change evidence, without render timestamps. */
  fingerprint?: string;
  succeeded: boolean;
}

export function createAdaptivePollState(baseIntervalMs: number, maxIdleIntervalMs = 5000): AdaptivePollState {
  if (
    !Number.isFinite(baseIntervalMs) ||
    baseIntervalMs <= 0 ||
    !Number.isFinite(maxIdleIntervalMs) ||
    maxIdleIntervalMs <= 0
  ) {
    throw new RangeError('Collection intervals must be finite and positive');
  }
  // Test-only cap override for live panel cadence tests.
  const ms = Number(process.env.HUD_PANEL_ADAPTIVE_MAX_MS);
  const cap = Number.isInteger(ms) && ms > 0 ? ms : 5000;
  return {
    baseIntervalMs,
    // A caller configured above the cap keeps its configured cadence.
    maxIdleIntervalMs: Math.max(baseIntervalMs, Math.min(cap, maxIdleIntervalMs)),
    intervalMs: baseIntervalMs,
    nextDueAt: Number.NEGATIVE_INFINITY,
    stablePolls: 0,
  };
}

export function adaptivePollDue(state: AdaptivePollState, scopeKey: string, nowMs: number): boolean {
  return state.scopeKey !== scopeKey || nowMs >= state.nextDueAt;
}

/** User input and explicit refresh invalidate the idle history immediately. */
export function forceAdaptivePoll(state: AdaptivePollState): AdaptivePollState {
  return {
    ...state,
    intervalMs: state.baseIntervalMs,
    nextDueAt: Number.NEGATIVE_INFINITY,
    stablePolls: 0,
    fingerprint: undefined,
  };
}

/** Pure transition: failures and uncertain evidence always retry at base cadence. */
export function recordAdaptivePoll(state: AdaptivePollState, observation: AdaptivePollObservation): AdaptivePollState {
  const quiet = observation.succeeded && observation.activity === 'quiet' && Boolean(observation.fingerprint);
  const stablePolls =
    quiet && state.scopeKey === observation.scopeKey && state.fingerprint === observation.fingerprint
      ? Math.min(32, state.stablePolls + 1)
      : 0;
  // Establish a baseline and two unchanged quiet observations before backing off.
  const intervalMs =
    stablePolls >= 2
      ? Math.min(state.maxIdleIntervalMs, state.baseIntervalMs * 2 ** (stablePolls - 1))
      : state.baseIntervalMs;
  return {
    ...state,
    scopeKey: observation.scopeKey,
    fingerprint: quiet ? observation.fingerprint : undefined,
    stablePolls,
    intervalMs,
    nextDueAt: observation.nowMs + intervalMs,
  };
}
