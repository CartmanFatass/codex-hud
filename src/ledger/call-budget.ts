import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

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
    this.#deadline = this.started + 30;
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
    return Math.min(this.remaining(), Math.max(0, 20 - this.#wait));
  }
  checkLockSpent(): void {
    if (this.#wait > 20) throw new CallBudgetExpired();
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
    return {
      elapsedMs,
      deadlineMs: this.#deadline - this.started,
      authorizationMs,
      overrunMs: Math.max(0, authorizationMs - (this.#deadline - this.started)),
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
