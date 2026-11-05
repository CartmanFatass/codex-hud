import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

// Delegation admission policy only. Generic numeric ledger APIs, readers,
// observation ticks, status and wait retain their independent budgets.
export const DELEGATION_AUTHORIZATION_MS = 250;
export const DELEGATION_CONTENTION_MS = 100;

/** Trusted composition dependency. Never populated from a request, environment or config. */
export interface BudgetClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const monotonicClock: BudgetClock = Object.freeze({ now: () => performance.now(), sleep: delay });
export class CallBudgetExpired extends Error {
  readonly code = 'ledger_busy';
  constructor() {
    super('ledger_busy');
  }
}
export type BudgetPhase =
  'prepare' | 'source' | 'queue' | 'acquire' | 'metadata' | 'callback' | 'commit' | 'rollback' | 'complete' | 'flush';

/** One invocation's original authorization budget, including preparation and all writes.
 * Queue time is conservatively charged as contention; callback/preparation time is not.
 * Diagnostic storage is bounded and contains no request data. */
export class CallBudget {
  readonly started: number;
  #deadline: number;
  #last: number;
  #wait = 0;
  #queue = 0;
  #attempts = 0;
  #samples: { phase: BudgetPhase; at: number }[] = [];
  #outer: number | null = null;
  #completed: number | null = null;
  #phase: BudgetPhase | null = null;
  #phaseAt = 0;
  #phaseMs: Partial<Record<BudgetPhase, number>> = {};
  #phaseCounts: Partial<Record<BudgetPhase, number>> = {};
  constructor(
    readonly clock: BudgetClock = monotonicClock,
    started?: number
  ) {
    const now = clock.now();
    if (!Number.isFinite(now) || (started !== undefined && (!Number.isFinite(started) || started > now)))
      throw new TypeError('invalid_budget_clock');
    this.started = started ?? now;
    this.#last = now;
    this.#deadline = this.started + DELEGATION_AUTHORIZATION_MS;
  }
  now(): number {
    const now = this.clock.now();
    if (!Number.isFinite(now) || now < this.#last) throw new TypeError('invalid_budget_clock');
    this.#last = now;
    return now;
  }
  tighten(deadline: number): void {
    if (!Number.isFinite(deadline)) throw new TypeError('invalid_enclosing_deadline');
    this.#outer = Math.min(this.#outer ?? deadline, deadline);
    this.#deadline = Math.min(this.#deadline, deadline);
  }
  note(phase: BudgetPhase): number {
    const now = this.now();
    if (this.#phase !== null) this.#phaseMs[this.#phase] = (this.#phaseMs[this.#phase] ?? 0) + now - this.#phaseAt;
    this.#phase = phase;
    this.#phaseAt = now;
    this.#phaseCounts[phase] = (this.#phaseCounts[phase] ?? 0) + 1;
    if (this.#samples.length === 64) this.#samples.shift();
    this.#samples.push({ phase, at: now - this.started });
    if (phase === 'complete') this.#completed = now;
    return now;
  }
  check(phase: BudgetPhase = 'prepare'): void {
    const now = this.note(phase);
    if (now >= this.#deadline) {
      this.#completed = now;
      throw new CallBudgetExpired();
    }
  }
  remaining(): number {
    return Math.max(0, this.#deadline - this.now());
  }
  lockRemaining(): number {
    return Math.min(this.remaining(), Math.max(0, DELEGATION_CONTENTION_MS - this.#wait));
  }
  checkLockSpent(): void {
    if (this.#wait >= DELEGATION_CONTENTION_MS) throw new CallBudgetExpired();
  }
  chargeWait(start: number, queue = false): void {
    const elapsed = Math.max(0, this.now() - start);
    this.#wait += elapsed;
    if (queue) this.#queue += elapsed;
  }
  attempt(): void {
    this.check('acquire');
    if (this.lockRemaining() <= 0) throw new CallBudgetExpired();
    this.#attempts++;
  }
  async backoff(ms: number): Promise<void> {
    this.check('acquire');
    if (ms >= this.lockRemaining()) throw new CallBudgetExpired();
    const start = this.now();
    try {
      await this.clock.sleep(ms);
    } finally {
      this.chargeWait(start);
    }
    this.check('acquire');
    if (this.lockRemaining() <= 0) throw new CallBudgetExpired();
  }
  diagnostics() {
    const elapsedMs = this.now() - this.started;
    const authorizationMs = (this.#completed ?? this.#last) - this.started;
    // Serialize the declared limit without floating-point addition/subtraction
    // making 250 appear as 250.00000000000003. Actual elapsed/wait are untouched.
    const deadlineMs = Math.min(DELEGATION_AUTHORIZATION_MS, this.#deadline - this.started);
    return {
      writeBudgetApplicable: true as const,
      elapsedMs,
      deadlineMs,
      authorizationMs,
      overrunMs: Math.max(0, authorizationMs - deadlineMs),
      waitMs: this.#wait,
      queueMs: this.#queue,
      attempts: this.#attempts,
      enclosingDeadline: this.#outer === null ? 'unavailable' : 'trusted',
      // Adjacent checkpoint intervals, not claims about kernel-only CPU/lock time.
      phaseMs: { ...this.#phaseMs },
      phaseCounts: { ...this.#phaseCounts },
      phases: [...this.#samples],
    };
  }
}

/** Structural rather than instanceof: CLI and MCP have independent compiled module graphs. */
export function isCallBudget(value: number | CallBudget): value is CallBudget {
  return typeof value !== 'number';
}

/** Read-only receipt/response observation. It has no admission deadline or writer API.
 * Only trusted dispatch selects this type; no request/config field disables a write budget. */
export class ReadCallTiming {
  readonly started: number;
  #completed: number | null = null;
  #last: number;
  #phases: { phase: BudgetPhase; at: number }[] = [];
  constructor(
    readonly clock: BudgetClock = monotonicClock,
    started?: number
  ) {
    this.#last = clock.now();
    this.started = started ?? this.#last;
    if (!Number.isFinite(this.started) || !Number.isFinite(this.#last) || this.started > this.#last)
      throw new TypeError('invalid_budget_clock');
  }
  note(phase: BudgetPhase): void {
    const now = this.clock.now();
    if (!Number.isFinite(now) || now < this.#last) throw new TypeError('invalid_budget_clock');
    this.#last = now;
    if (phase === 'complete') this.#completed ??= now;
    if (this.#phases.length === 64) this.#phases.shift();
    this.#phases.push({ phase, at: now - this.started });
  }
  diagnostics() {
    return {
      writeBudgetApplicable: false as const,
      elapsedMs: this.#last - this.started,
      upfrontMs: this.#completed === null ? null : this.#completed - this.started,
      authorizationMs: null,
      deadlineMs: null,
      overrunMs: null,
      waitMs: null,
      queueMs: null,
      attempts: 0,
      enclosingDeadline: 'not_applicable' as const,
      phases: [...this.#phases],
    };
  }
}

/** Trusted internal composition only, never a request/config authorization check.
 * CLI and MCP compile separate constructors; retain the original shared object.
 * Partial shared-budget shapes must not silently acquire legacy retry semantics. */
export function sharedRenewalBudget(value: unknown): CallBudget | null {
  if (value === null || typeof value !== 'object') return null;
  // Includes acquisition/queue/cleanup operations consumed by actual Ledger,
  // plus enclosing-deadline and diagnostic operations of the shared protocol.
  const fields = [
    'check',
    'backoff',
    'remaining',
    'lockRemaining',
    'now',
    'chargeWait',
    'note',
    'attempt',
    'checkLockSpent',
    'tighten',
    'diagnostics',
  ] as const;
  if (!fields.some((field) => field in value) && !('started' in value) && !('clock' in value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !fields.every((field) => typeof candidate[field] === 'function') ||
    typeof candidate.started !== 'number' ||
    !Number.isFinite(candidate.started)
  )
    throw new TypeError('invalid_shared_call_budget');
  return value as CallBudget;
}
