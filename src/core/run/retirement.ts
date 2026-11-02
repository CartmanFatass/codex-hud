import type { RetireRequest } from '../../ledger/notify-events.js';
import { isRunTerminal } from '../execution.js';
import { hintSubscription, type WaitSubscription } from '../wait/index.js';
import type { RunSnapshot } from './port.js';
import type { FrozenRetirementPolicy } from './retirement-policy.js';

export interface Quiescence {
  quiescent: boolean;
  since: number | null;
  pendingInput: 'none' | 'approval' | 'question' | 'needs_human' | 'unobservable';
  pendingSince: number | null;
  source: string;
  asOf: number;
}
export interface RetirementDeadline {
  rule: RetireRequest['rule'];
  at: number;
  assignment: string;
}
export function retirementAllowed(snapshot: RunSnapshot): boolean {
  return (
    !!snapshot.retirement &&
    snapshot.retirement.authorityValid &&
    snapshot.run.mode === 'headless' &&
    snapshot.retirement.currentRunId === snapshot.run.runId &&
    !isRunTerminal(snapshot.run) &&
    snapshot.run.state !== 'uncertain' &&
    snapshot.run.cancelRequestedAt === null &&
    !!snapshot.run.scopeRef &&
    !['closed', 'revoked', 'handed_over'].includes(snapshot.status.link.state)
  );
}

/** No wall clock polling: fixed deadlines, durable hints and the explicitly
 * authorised wake-recovery timer. Quiescence is read only on a deadline.
 */
export class RetirementScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private deadlines = new Map<string, RetirementDeadline>();
  private subscription?: WaitSubscription;
  private recovery?: NodeJS.Timeout;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private pendingRefresh = false;
  private idleNotBefore = 0;
  private assignment: string | null = null;
  private committed = false;
  private maxMonoAt: number | null = null;
  constructor(
    private readonly options: {
      home: string;
      runId: string;
      policy: Readonly<FrozenRetirementPolicy>;
      startClock: { startedAt: number; monoMs: number };
      clockTrusted: () => Promise<boolean>;
      read: () => Promise<RunSnapshot>;
      evidence: (snapshot: RunSnapshot) => Promise<Quiescence | null>;
      retire: (deadline: RetirementDeadline, snapshot: RunSnapshot, request: RetireRequest) => Promise<boolean>;
      failed: (error: unknown) => void;
      cancelled: () => void;
    }
  ) {}

  async start(): Promise<void> {
    // Subscribe before the first snapshot, closing report/registration races.
    this.subscription = hintSubscription(this.options.home)(this.options.runId, () => this.refresh());
    await this.serial(() => this.update());
    this.scheduleRecovery();
  }
  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      if (!this.closed) await work();
    });
    this.queue = next.catch((error) => this.options.failed(error));
    return next;
  }
  refresh(): void {
    if (this.closed || this.pendingRefresh || this.committed) return;
    this.pendingRefresh = true;
    void this.serial(async () => {
      this.pendingRefresh = false;
      await this.update();
    }).catch(() => {});
  }
  private scheduleRecovery(): void {
    if (this.closed || this.committed) return;
    this.recovery = setTimeout(() => {
      this.refresh();
      this.scheduleRecovery();
    }, this.options.policy.recoveryMs);
  }
  private arm(rule: RetirementDeadline['rule'], at: number, assignment: string, wakeAt?: number): void {
    if (this.closed) return;
    const prior = this.deadlines.get(rule);
    if (prior?.at === at && prior.assignment === assignment) return;
    clearTimeout(this.timers.get(rule));
    const deadline = { rule, at, assignment };
    this.deadlines.set(rule, deadline);
    this.timers.set(
      rule,
      setTimeout(
        () => {
          void this.serial(() => this.expire(deadline)).catch(() => {});
        },
        Math.ceil(
          Math.max(
            0,
            wakeAt === undefined && rule === 'max_runtime' && this.maxMonoAt !== null
              ? this.maxMonoAt - performance.now()
              : (wakeAt ?? at) - Date.now()
          )
        )
      )
    );
  }
  private clear(rule: string): void {
    clearTimeout(this.timers.get(rule));
    this.timers.delete(rule);
    this.deadlines.delete(rule);
  }
  private async update(): Promise<void> {
    if (this.committed) return;
    const trustedClock = await this.options.clockTrusted();
    if (this.closed) return;
    const snapshot = await this.options.read();
    if (this.closed) return;
    if (!retirementAllowed(snapshot)) {
      for (const rule of this.timers.keys()) this.clear(rule);
      if (snapshot.run.cancelRequestedAt !== null) this.options.cancelled();
      if (isRunTerminal(snapshot.run) || snapshot.run.cancelRequestedAt !== null) this.close();
      return;
    }
    const { policy } = this.options;
    const assignment = snapshot.retirement!.assignment;
    if (assignment !== this.assignment) {
      for (const rule of this.timers.keys()) this.clear(rule);
      this.assignment = assignment;
    }
    const maxAt = (snapshot.run.startedAt ?? snapshot.run.createdAt) + policy.maxRunMs;
    this.maxMonoAt ??= this.options.startClock.monoMs + policy.maxRunMs;
    this.arm('max_runtime', maxAt, assignment);
    if (!trustedClock) {
      for (const rule of this.timers.keys()) if (rule !== 'max_runtime') this.clear(rule);
      return;
    }
    const report = snapshot.status.latestReportForRun;
    const newerDecision = snapshot.retirement!.intentSeq > (snapshot.retirement!.reportSeq ?? 0);
    if (report && newerDecision) {
      this.clear('after_report');
      this.clear('blocked_wait');
    } else if (report && ['completed', 'failed'].includes(report.status)) {
      this.clear('blocked_wait');
      this.arm(
        'after_report',
        report.createdAt + (policy.role === 'reviewer' ? policy.reviewerAfterReportMs : policy.afterReportMs),
        assignment
      );
    } else if (report) {
      this.clear('after_report');
      this.arm('blocked_wait', report.createdAt + policy.blockedWaitMs, assignment);
    } else {
      this.clear('after_report');
    }
    this.arm(
      'idle',
      Math.max((snapshot.run.startedAt ?? snapshot.run.createdAt) + policy.idleMs, this.idleNotBefore),
      assignment
    );
  }
  private async expire(deadline: RetirementDeadline): Promise<void> {
    if (this.committed || this.deadlines.get(deadline.rule) !== deadline) return;
    this.clear(deadline.rule);
    const trustedClock = await this.options.clockTrusted();
    if (this.closed) return;
    if (!trustedClock && deadline.rule !== 'max_runtime') {
      await this.update();
      return;
    }
    const first = await this.options.read();
    if (this.closed) return;
    if (!retirementAllowed(first) || first.retirement!.assignment !== deadline.assignment) {
      await this.update();
      return;
    }
    const evidence = await this.options.evidence(first);
    if (this.closed) return;
    const request = this.eligible(deadline, first, evidence);
    if (request) {
      // Every eligibility row and its quiescence are rechecked from one fresh
      // ledger snapshot immediately before the original writer commits intent.
      const second = await this.options.read();
      if (this.closed) return;
      if (retirementAllowed(second) && second.retirement!.assignment === deadline.assignment) {
        const secondEvidence = await this.options.evidence(second);
        if (this.closed) return;
        const rechecked = this.eligible(deadline, second, secondEvidence);
        if (rechecked && (await this.options.retire(deadline, second, rechecked))) {
          this.committed = true;
          clearTimeout(this.recovery);
          for (const rule of this.timers.keys()) this.clear(rule);
          return;
        }
      }
    }
    // An unavailable idle source is never a timer-driven assertion of silence.
    // Recheck no more often than the prescribed idle interval.
    if (deadline.rule === 'idle') this.idleNotBefore = Date.now() + Math.max(this.options.policy.idleMs / 4, 300_000);
    if (
      (deadline.rule === 'after_report' || deadline.rule === 'idle') &&
      evidence?.pendingInput &&
      !['none', 'unobservable'].includes(evidence.pendingInput) &&
      evidence.pendingSince !== null
    ) {
      this.arm('blocked_wait', evidence.pendingSince + this.options.policy.blockedWaitMs, deadline.assignment);
      return;
    }
    // Failed eligibility waits for new assignment/hint or bounded recovery; do
    // not spin an already-expired after-report/max timer on a busy writer.
    this.arm(
      deadline.rule,
      deadline.at,
      deadline.assignment,
      Date.now() +
        (deadline.rule === 'idle' ? Math.max(this.options.policy.idleMs / 4, 300_000) : this.options.policy.recoveryMs)
    );
  }
  private eligible(
    deadline: RetirementDeadline,
    snapshot: RunSnapshot,
    evidence: Quiescence | null
  ): RetireRequest | null {
    const now = Date.now(),
      { policy } = this.options;
    if (
      deadline.rule === 'max_runtime'
        ? this.maxMonoAt === null || performance.now() < this.maxMonoAt
        : now < deadline.at
    )
      return null;
    const report = snapshot.status.latestReportForRun;
    const reportSeq = snapshot.retirement!.reportSeq;
    const pending = evidence?.pendingInput ?? 'unobservable';
    const hasPending = pending !== 'none' && pending !== 'unobservable';
    if (
      deadline.rule === 'after_report' &&
      (!report ||
        !['completed', 'failed'].includes(report.status) ||
        reportSeq === null ||
        snapshot.retirement!.intentSeq > reportSeq ||
        hasPending ||
        now < report.createdAt + (policy.role === 'reviewer' ? policy.reviewerAfterReportMs : policy.afterReportMs))
    )
      return null;
    if (
      deadline.rule === 'blocked_wait' &&
      !(
        (report &&
          ['blocked', 'interrupted'].includes(report.status) &&
          reportSeq !== null &&
          snapshot.retirement!.intentSeq <= reportSeq &&
          now >= report.createdAt + policy.blockedWaitMs) ||
        (hasPending &&
          evidence?.pendingSince !== null &&
          evidence?.pendingSince !== undefined &&
          (snapshot.retirement!.intentAt === null || snapshot.retirement!.intentAt < evidence.pendingSince) &&
          now >= evidence.pendingSince + policy.blockedWaitMs)
      )
    )
      return null;
    if (
      deadline.rule === 'idle' &&
      ((report && ['completed', 'failed'].includes(report.status)) ||
        !evidence?.quiescent ||
        evidence.since === null ||
        now < evidence.since + policy.idleMs ||
        pending !== 'none')
    )
      return null;

    const causes = {
      after_report: 'retire_after_report',
      idle: 'retire_idle',
      blocked_wait: 'retire_blocked_wait',
      max_runtime: 'runtime_limit',
    } as const;
    return {
      cause: causes[deadline.rule],
      rule: deadline.rule,
      actor: { kind: 'policy' },
      deadlineAt: deadline.at,
      eligibility: {
        ...(reportSeq === null ? {} : { reportSeq }),
        newerWorkChecked: true,
        quiescence: deadline.rule === 'idle' ? 'observed' : 'not_required',
        pendingInput: pending === 'none' ? 'none' : pending === 'unobservable' ? 'unobservable' : 'policy_override',
      },
      graceMs: policy.graceMs,
    };
  }
  async recheck(deadline: RetirementDeadline, snapshot: RunSnapshot): Promise<boolean> {
    const trustedClock = await this.options.clockTrusted();
    if (this.closed) return false;
    if (!trustedClock && deadline.rule !== 'max_runtime') return false;
    return (
      retirementAllowed(snapshot) &&
      snapshot.retirement!.assignment === deadline.assignment &&
      (await this.recheckEvidence(deadline, snapshot))
    );
  }
  private async recheckEvidence(deadline: RetirementDeadline, snapshot: RunSnapshot): Promise<boolean> {
    const evidence = await this.options.evidence(snapshot);
    return !this.closed && this.eligible(deadline, snapshot, evidence) !== null;
  }
  resume(): void {
    if (this.closed || !this.committed) return;
    this.committed = false;
    this.refresh();
    this.scheduleRecovery();
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.recovery);
    this.subscription?.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.deadlines.clear();
  }
}
