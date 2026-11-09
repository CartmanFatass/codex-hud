/** Pi-free decisions. The event adapter supplies observations and owns all effects. */
import type { DispatchRole } from '../pi-dispatch.js';
import { MAX_REVIEW_ROUNDS, MAX_SONIC_CALLS, WARM_BUDGET_USD, refuse } from './contracts.js';

export interface HelperState {
  sonicCalls: number;
  reviewRounds: number;
  active: boolean;
}
/** Reserve before launch, including failed calls. Persist under the parent's helper mutex. */
export function reserveHelper(
  role: DispatchRole,
  slot: string,
  kind: 'sonic' | 'reviewer',
  state: HelperState
): HelperState {
  if (role !== 'implementer' || slot !== 'primary') refuse('helper_ineligible', kind);
  if (state.active) refuse('helper_busy', kind);
  if (![state.sonicCalls, state.reviewRounds].every((n) => Number.isSafeInteger(n) && n >= 0))
    refuse('invalid_contract', 'helper_counts');
  if (kind === 'sonic' ? state.sonicCalls >= MAX_SONIC_CALLS : state.reviewRounds >= MAX_REVIEW_ROUNDS)
    refuse('helper_limit', kind);
  return {
    sonicCalls: state.sonicCalls + Number(kind === 'sonic'),
    reviewRounds: state.reviewRounds + Number(kind === 'reviewer'),
    active: true,
  };
}
export interface SettlementFacts {
  generation: number;
  expectedGeneration: number;
  settled: boolean;
  idle: boolean;
  pendingMessages: boolean;
  helperPending: boolean;
  questions: number;
  aborted: boolean;
  error: boolean;
  outputBefore: string | null;
  outputAfter: string | null;
}
/** Call after agent_settled and an event-loop deferral, never merely on agent_end. */
export function settlementDecision(facts: SettlementFacts): 'wait' | 'failed' | 'ready' {
  if (
    facts.generation !== facts.expectedGeneration ||
    !facts.settled ||
    !facts.idle ||
    facts.pendingMessages ||
    facts.helperPending ||
    facts.questions !== 0
  )
    return 'wait';
  if (facts.aborted || facts.error || !facts.outputAfter || facts.outputAfter === facts.outputBefore) return 'failed';
  return 'ready';
}
export function cacheTtlMs(seconds: number | null | undefined): number {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}
/** Model changes can only shorten a deadline measured from the original settlement. */
export function graceDeadline(settledAtMs: number, ttlMs: number, previous?: number): number {
  const next = settledAtMs + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0);
  return previous === undefined ? next : Math.min(previous, next);
}
export function graceExpired(nowMs: number, deadlineMs: number, generation: number, expected: number): boolean {
  return generation === expected && nowMs >= deadlineMs;
}
export interface WarmingFacts {
  closing: boolean;
  failed: boolean;
  disabled: boolean;
  spentUsd: number;
  estimatedUsd: number;
  helperPending: boolean;
  settled: boolean;
}
export function warmingDecision(facts: WarmingFacts): 'stop' | 'warm' | 'native' {
  if (
    facts.closing ||
    facts.failed ||
    facts.disabled ||
    !Number.isFinite(facts.spentUsd) ||
    !Number.isFinite(facts.estimatedUsd) ||
    facts.spentUsd < 0 ||
    facts.estimatedUsd < 0 ||
    facts.spentUsd >= WARM_BUDGET_USD ||
    facts.spentUsd + facts.estimatedUsd > WARM_BUDGET_USD
  )
    return 'stop';
  if (facts.helperPending) return 'warm';
  return facts.settled ? 'stop' : 'native';
}
