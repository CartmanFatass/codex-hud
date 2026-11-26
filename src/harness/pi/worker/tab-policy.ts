/** Pure, Pi-free tab worker lifecycle decisions. All deadlines are monotonic milliseconds. */
export type Lifecycle = 'implementer' | 'one_shot';

export const DEFAULT_WARM_CAP_USD = 0.50;

/** Idle grace for a settled implementer: two thirds of the prompt-cache lifetime, at most 20 min, so a
 * continuation sent near the end still reaches a warm cache after the round trip. */
export const IDLE_GRACE_MAX_MS = 20 * 60 * 1000;

export function lifecycle(profile?: string): Lifecycle | undefined {
  if (profile === 'implementer' || profile === 'general') return 'implementer';
  if (profile === 'reviewer' || profile === 'architect' || profile === 'sonic') return 'one_shot';
  return undefined;
}

export interface WarmInput {
  role?: string;
  cap: number;
  admitted: number;
  warmCost: number;
  action: 'warm' | 'stop';
  closing: boolean;
  helperPending: boolean;
  settled: boolean;
  deadline?: number;
  now: number;
}

export function warming(input: WarmInput): { action: 'warm' | 'stop'; admitted: number } | undefined {
  const p = input;
  if (!p.role) return undefined;
  const stop = () => ({ action: 'stop' as const, admitted: p.admitted });
  if (
    p.closing ||
    !Number.isFinite(p.cap) ||
    p.cap <= 0 ||
    !Number.isFinite(p.admitted) ||
    p.admitted < 0 ||
    p.admitted >= p.cap ||
    !Number.isFinite(p.warmCost) ||
    p.warmCost < 0 ||
    p.admitted + p.warmCost > p.cap
  ) {
    return stop();
  }
  const action = p.helperPending ? 'warm' : p.settled ? 'stop' : p.action;
  return { action, admitted: action === 'warm' ? p.admitted + p.warmCost : p.admitted };
}

export interface ExitInput {
  contract: boolean;
  role?: string;
  settled: boolean;
  outputWritten: boolean;
  failed: boolean;
  idle: boolean;
  pendingMessages: boolean;
  helperPending: boolean;
  pendingQuestions: number;
  generation: number;
  expectedGeneration: number;
  now: number;
  deadline?: number;
  print: boolean;
}

export function exitDecision(p: ExitInput): 'wait' | 'closed' | 'failed' {
  if (
    !p.contract ||
    !lifecycle(p.role) ||
    !p.settled ||
    !p.idle ||
    p.pendingMessages ||
    p.helperPending ||
    p.pendingQuestions ||
    p.generation !== p.expectedGeneration
  ) {
    return 'wait';
  }
  if (p.failed || !p.outputWritten) return 'failed';
  if (p.print || lifecycle(p.role) === 'one_shot' || (p.deadline !== undefined && p.now >= p.deadline)) {
    return 'closed';
  }
  return 'wait';
}

/** Mirrors Pi prompt-cache TTL: promptCache values are seconds. */
export function promptCacheTtlMs(model?: { promptCache?: { short?: number; long?: number } }, retention?: string): number {
  const seconds = model?.promptCache?.[retention === 'long' ? 'long' : 'short'];
  return Number.isFinite(seconds) && seconds! > 0 ? seconds! * 1000 : 0;
}

export function idleGraceMs(model?: { promptCache?: { short?: number; long?: number } }, retention?: string): number {
  return Math.min(Math.floor((promptCacheTtlMs(model, retention) * 2) / 3), IDLE_GRACE_MAX_MS);
}
