import { spawnSync } from 'node:child_process';
/** Test/integration fake, deliberately not a production ledger replacement. */
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  rmdirSync,
  lstatSync,
  constants,
} from 'node:fs';
import { dirname } from 'node:path';
import { reconcileRun, isRunTerminal } from '../execution.js';
import { sessionOwnerKey } from '../identity.js';
import {
  supervisorRegistrationEvent,
  registeredSupervisor,
  sameProcessStamp,
  scopeUpdateAllowed,
} from '../supervision.js';
import type { ProcessStamp, RunMeta, FinalExitReceipt } from '../types/supervision.js';
import type { ReconcileEvidence } from '../types/execution.js';
import type { RunFactPort, RunSnapshot, LocalManager, CancelIntent } from './port.js';

export interface FakeRunSeed {
  snapshot: RunSnapshot;
  ticketHash: string;
  authorized: boolean;
  cancel: CancelIntent | null;
}
export const ticketHash = (ticket: string): string => createHash('sha256').update(ticket).digest('hex');
export class MemoryRunFactPort implements RunFactPort {
  constructor(
    protected seed: FakeRunSeed,
    readonly ownerUid = process.getuid!()
  ) {}
  protected transaction<T>(fn: (s: FakeRunSeed) => T): T {
    return fn(this.seed);
  }
  protected writer(s: FakeRunSeed, stamp: ProcessStamp): void {
    const registered = registeredSupervisor(s.snapshot.run, s.snapshot.events);
    if (
      !sameProcessStamp(registered, stamp) ||
      !sameProcessStamp(s.snapshot.run.supervisor, stamp) ||
      s.snapshot.claimSupervisor?.pid !== stamp.pid ||
      s.snapshot.claimSupervisor?.proc_start !== stamp.proc_start
    )
      throw new Error('writer_not_registered');
  }
  async authorizeManager(id: string, actor: LocalManager, operation: 'reconcile'): Promise<void> {
    this.transaction((s) => {
      this.id(s, id);
      if (actor.uid !== this.ownerUid || !actor.invocationId) throw new Error('unauthorized');
      const p = s.snapshot;
      if (!p.events.some((e) => e.kind === 'manager.reconcile' && e.payload.invocationId === actor.invocationId)) {
        p.events.push({
          seq: p.events.length + 1,
          runId: id,
          linkId: p.run.linkId,
          kind: 'manager.reconcile',
          payload: {
            uid: actor.uid,
            invocationId: actor.invocationId,
            operation,
            representedOwner: p.status.link.parentRef ? sessionOwnerKey(p.status.link.parentRef) : null,
          },
          at: Date.now(),
        });
        p.revision++;
      }
    });
  }
  async read(runId: string): Promise<RunSnapshot> {
    return this.transaction((s) => {
      this.id(s, runId);
      const result = structuredClone(s.snapshot);
      result.status.currentRun = structuredClone(result.run);
      const offline = [...result.events].reverse().find((e) => e.kind === 'parent.offline');
      if (offline)
        result.status.parentOffline = {
          since: Number(offline.payload.since),
          seq: offline.seq,
          orphanPolicy: result.run.orphanPolicy,
        };
      return result;
    });
  }
  private id(s: FakeRunSeed, id: string): void {
    if (s.snapshot.run.runId !== id) throw new Error('run_not_found');
  }
  async register(id: string, ticket: string, launchDigest: string, stamp: ProcessStamp): Promise<void> {
    this.transaction((s) => {
      this.id(s, id);
      const p = s.snapshot,
        r = p.run;
      if (
        !s.authorized ||
        !p.slotHeld ||
        r.state !== 'starting' ||
        r.launchPhase !== 'reserved' ||
        r.supervisor ||
        r.submissionFencedAt !== null ||
        r.cancelRequestedAt !== null ||
        s.ticketHash !== ticketHash(ticket) ||
        r.launchTokenHash !== s.ticketHash ||
        r.launchDigest !== launchDigest
      )
        throw new Error('ticket_refused');
      const at = Date.now();
      r.supervisor = structuredClone(stamp);
      r.launchPhase = 'armed';
      r.heartbeatAt = at;
      r.heartbeatSeq = 1;
      r.heartbeatMonoMs = performance.now();
      p.claimSupervisor = { pid: stamp.pid, proc_start: stamp.proc_start };
      p.claimState = 'armed';
      p.events.push({ ...supervisorRegistrationEvent(r, stamp, at), seq: p.events.length + 1 });
      p.revision++;
    });
  }
  async phase(id: string, stamp: ProcessStamp, phase: 'submitting' | 'submitted'): Promise<void> {
    this.transaction((s) => {
      this.id(s, id);
      this.writer(s, stamp);
      const r = s.snapshot.run;
      if (
        isRunTerminal(r) ||
        r.submissionFencedAt !== null ||
        (phase === 'submitting' && (r.launchPhase !== 'armed' || r.cancelRequestedAt !== null)) ||
        (phase === 'submitted' && r.launchPhase !== 'submitting')
      )
        throw new Error('submission_refused');
      r.launchPhase = phase;
      s.snapshot.revision++;
    });
  }
  async startup(id: string, stamp: ProcessStamp, meta: RunMeta): Promise<void> {
    this.transaction((s) => {
      this.id(s, id);
      this.writer(s, stamp);
      const p = s.snapshot;
      if (
        meta.run_id !== id ||
        meta.source_id !== p.run.sourceId ||
        meta.binding_generation !== p.run.expectedGeneration ||
        !sameProcessStamp(meta.supervisor, stamp) ||
        !scopeUpdateAllowed(p.run.scopeRef, meta.scope)
      )
        throw new Error('startup_mismatch');
      p.meta = structuredClone(meta);
      p.run.scopeRef = structuredClone(meta.scope);
      p.run.startedAt ??= Date.now();
      p.revision++;
    });
  }
  async heartbeat(id: string, stamp: ProcessStamp, seq: number, monoMs: number) {
    return this.transaction((s) => {
      this.id(s, id);
      this.writer(s, stamp);
      const r = s.snapshot.run;
      if (isRunTerminal(r) || r.heartbeatSeq !== seq) return null;
      r.heartbeatAt = Date.now();
      r.heartbeatMonoMs = monoMs;
      r.heartbeatSeq++;
      s.snapshot.revision++;
      return { seq: r.heartbeatSeq, cancel: structuredClone(s.cancel) };
    });
  }
  async raw(id: string, stamp: ProcessStamp, kind: string, payload: Record<string, unknown>): Promise<number> {
    return this.transaction((s) => {
      this.id(s, id);
      this.writer(s, stamp);
      const p = s.snapshot,
        seq = p.events.length + 1;
      p.events.push({
        seq,
        runId: id,
        linkId: p.run.linkId,
        kind,
        payload: JSON.parse(JSON.stringify(payload)),
        at: Date.now(),
      });
      p.revision++;
      return seq;
    });
  }
  async receipt(id: string, stamp: ProcessStamp, receipt: FinalExitReceipt): Promise<void> {
    this.transaction((s) => {
      this.id(s, id);
      this.writer(s, stamp);
      const p = s.snapshot;
      if (p.receipt && JSON.stringify(p.receipt) !== JSON.stringify(receipt)) throw new Error('receipt_conflict');
      p.receipt = structuredClone(receipt);
      p.revision++;
    });
  }
  async acceptCancel(
    id: string,
    actor: LocalManager | { kind: 'orphan_policy'; supervisor: ProcessStamp },
    graceMs: number
  ): Promise<CancelIntent | null> {
    return this.transaction((s) => {
      this.id(s, id);
      const p = s.snapshot;
      if (actor.kind === 'trusted_local') {
        if (actor.uid !== this.ownerUid || !actor.invocationId) throw new Error('unauthorized');
      } else {
        this.writer(s, actor.supervisor);
        if (p.run.orphanPolicy !== 'stop') throw new Error('unauthorized');
      }
      if (isRunTerminal(p.run)) return null;
      if (s.cancel) return structuredClone(s.cancel);
      const at = Date.now(),
        seq = p.events.length + 1;
      s.cancel = { at, seq, graceMs };
      p.run.cancelRequestedAt = at;
      // This is the reconciler's accepted intent transaction, never a raw writer update.
      p.run.state = 'cancelling';
      p.events.push({
        seq,
        runId: id,
        linkId: p.run.linkId,
        kind: 'cancel.accepted',
        payload: {
          actor:
            actor.kind === 'trusted_local'
              ? {
                  kind: 'local_user',
                  uid: actor.uid,
                  invocationId: actor.invocationId,
                  representedOwner: p.status.link.parentRef ? sessionOwnerKey(p.status.link.parentRef) : null,
                }
              : JSON.parse(JSON.stringify(actor)),
          graceMs,
        },
        at,
      });
      p.revision++;
      return structuredClone(s.cancel);
    });
  }
  async reconcile(id: string, revision: number, observations: ReconcileEvidence[], nowMs: number) {
    return this.transaction((s) => {
      this.id(s, id);
      const p = s.snapshot;
      if (p.revision !== revision) return null;
      p.facts.push(...structuredClone(observations));
      const d = reconcileRun(p.run, p.facts, nowMs, {
        slotHeld: p.slotHeld,
        ticketConsumed: p.run.launchPhase !== 'reserved',
        terminalBasis: { evidence: p.facts, terminalNote: p.status.terminalNote },
      });
      p.run.state = d.state;

      p.run.exitCode = d.exitCode;
      p.run.exitSignal = d.exitSignal;
      p.run.exitSource = d.exitSource;
      if (d.releaseSlot) {
        p.slotHeld = false;
        p.claimState = 'revoked';
        p.run.submissionFencedAt ??= nowMs;
        p.run.endedAt ??= nowMs;
        p.run.terminalEvidenceId ??= d.evidenceIds[0] ?? null;
      }
      p.status.currentRun = structuredClone(p.run);
      p.status.terminalNote = d.terminalNote;
      p.status.interaction = { focus: false, input: false, resume: false };
      p.status.reconciliation = d.cause
        ? { cause: d.cause, evidenceIds: d.evidenceIds, missing: [d.cause], observedAt: nowMs, allowedActions: [] }
        : null;
      if (d.emitTransition)
        p.events.push({
          seq: p.events.length + 1,
          runId: id,
          linkId: p.run.linkId,
          kind: 'run.reconciled',
          payload: { row: d.row, state: d.state },
          at: nowMs,
        });
      p.revision++;
      return d;
    });
  }
}
/** Interprocess CAS fake. Busy is explicit; a crashed lock never grants execution. */
export class FileRunFactPort extends MemoryRunFactPort {
  constructor(readonly path: string) {
    super(JSON.parse(readFileSync(path, 'utf8')));
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid!() || st.mode & 0o077)
      throw new Error('unsafe_fact_file');
  }
  override async read(runId: string): Promise<RunSnapshot> {
    const seed = JSON.parse(readFileSync(this.path, 'utf8')) as FakeRunSeed;
    if (seed.snapshot.run.runId !== runId) throw new Error('run_not_found');
    const result = structuredClone(seed.snapshot);
    result.status.currentRun = structuredClone(result.run);
    const offline = [...result.events].reverse().find((e) => e.kind === 'parent.offline');
    if (offline)
      result.status.parentOffline = {
        since: Number(offline.payload.since),
        seq: offline.seq,
        orphanPolicy: result.run.orphanPolicy,
      };
    return result;
  }
  protected override transaction<T>(fn: (s: FakeRunSeed) => T): T {
    // flock is test-only: inherited descriptors share the locked open-file
    // description, so kernel process exit releases it even during SIGKILL.
    const lock = openSync(`${this.path}.lock`, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const held = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'pipe', lock] });
    if (held.status !== 0) {
      closeSync(lock);
      throw new Error('fake_port_busy');
    }
    try {
      this.seed = JSON.parse(readFileSync(this.path, 'utf8'));
      const before = JSON.stringify(this.seed),
        result = fn(this.seed),
        after = JSON.stringify(this.seed);
      if (before !== after) {
        const tmp = `${this.path}.${process.pid}.tmp`;
        const fd = openSync(
          tmp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        );
        try {
          writeFileSync(fd, after);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, this.path);
        const dir = openSync(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      }
      return result;
    } finally {
      closeSync(lock);
    }
  }
}
