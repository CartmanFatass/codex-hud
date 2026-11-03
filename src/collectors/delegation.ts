import { sessionRefKey } from '../core/identity.js';
import { existingHudHome } from '../core/link/home.js';
import { randomUUID, createHash } from 'node:crypto';
import type { LinkLedgerRead } from '../core/link-ledger-read.js';
import {
  monotonicNow,
  WORKER_READER_LIMIT,
  WORKER_EXTERNAL_LIMIT,
  type CommitTrace,
} from '../core/link/worker-protocol.js';
import { canonicalJson } from '../core/canonical.js';
import { SessionPublisher } from '../core/link/publisher.js';
import { linkStatusInput } from '../core/link/index.js';
import { STATUS_RULE_VERSION, type LedgerStatusFact } from '../core/status/merge.js';
import type { LedgerEvent } from '../core/types/execution.js';
import type { WriterFacts } from '../core/status/writer.js';
import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodexAdapter } from '../harness/codex/index.js';
import { ClaudeTranscriptFiles } from '../harness/claude/binding.js';
import { ClaudeAdapter } from '../harness/claude/index.js';
import { openLinkLedgerReader } from '../core/link-ledger-read.js';
import { openObservationStore, type ObservationStore } from '../core/observation-store.js';
import { LinkTickCollector, LEDGER_SNAPSHOT_VALIDITY_MS, type LinkCollectionPort } from '../core/link/tick.js';
import { displayNodeKey } from '../core/observation.js';
import { loadLimits } from '../core/link/limits.js';
import { linkExecution } from '../core/link/execution.js';
import type { LinkScopeMembership, LinkTreeNode } from '../core/link/types.js';
import type { CollectedLinkSession } from '../core/link/types.js';
import type { ReaderBudget, SessionReader } from '../core/interfaces/harness-adapter.js';
import type { SessionEvidence } from '../core/interfaces/session-evidence.js';
import type { LaunchProfile } from '../core/types/capabilities.js';
import type { SessionRef } from '../core/types/identity.js';
import type { ObservationView, ReaderCheckpoint } from '../core/types/observation.js';
import type { DelegationViewModel } from '../core/link/view-model.js';

function signature(file: string): string | null {
  try {
    const s = fs.statSync(file);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch {
    return null;
  }
}
function identity(file: string): string | null {
  try {
    const s = fs.statSync(file);
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
}
type FileStamp = Pick<fs.Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;
function fileStamp(file: string): FileStamp | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}
function sameFileStamp(a: FileStamp | null | undefined, b: FileStamp | null | undefined): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs &&
      a.ctimeMs === b.ctimeMs)
  );
}
interface Source {
  adapter: CodexAdapter | ClaudeAdapter;
  root: string;
  writable: boolean;
  claudeFiles?: ClaudeTranscriptFiles;
  store: ObservationStore | null;
  storeIdentity: string | null;
  storeSignature: string;
  storeDirty: boolean;
}
interface Reading {
  publisher?: SessionPublisher;
  recoveryPending?: boolean;
  snapshot?: { envelope: CollectedLinkSession; token: number; dirty: boolean; value: CollectedLinkSession };
  file?: string | null;
  checkpoint?: ReaderCheckpoint;
  ref: SessionRef;
  reader?: SessionReader;
  envelope?: CollectedLinkSession;
  raw?: SessionEvidence;
  signature: FileStamp | null;
  dirty: boolean;
  caughtUp: boolean;
  topologyToken: number;
  lastGrantedKind?: 'session' | 'native_topology';
  resetSignature?: FileStamp | null;
  resetPending?: boolean;
  evicted?: boolean;
  grantedAt?: number;
  demandToken?: string | null;
  owedLedger?: boolean;
  owedSince?: number;
  retiring?: boolean;
  deliveryPending?: boolean;
  retirementRejected?: boolean;
  retirementBlocked?: boolean;
  retirementNode?: Pick<LinkTreeNode, 'key' | 'identity' | 'currentRun' | 'execution'>;
}
function evidenceFromView(ref: SessionRef, observation: ObservationView): SessionEvidence {
  const unknown = {
    value: null,
    quality: 'unknown' as const,
    source: 'committed:metric_unavailable',
    asOf: observation.statusProjection.observedAt,
  };
  return {
    ref,
    observation,
    cwd: observation.workspace?.cwd ?? null,
    cwdSource: 'unknown',
    cwdAsOf: observation.workspace?.cwdAsOf ?? null,
    startedAt: null,
    version: null,
    model: unknown,
    context: unknown,
    reports: [],
    native: [],
    linkEvidence: [],
    caps: {},
  };
}

class SessionCollection implements LinkCollectionPort {
  readonly immutableSnapshots = true;
  get publishesObservations(): boolean {
    return this.publishing;
  }
  private readonly holder = `hud:${process.pid}:${randomUUID()}`;
  private snapshot: readonly CollectedLinkSession[] | null = null;
  private readings = new Map<string, Reading>();
  private sourceChecks = new Map<string, { dirty: boolean; token: number }>();
  readonly minimumBytes = new Map<string, number>();
  private pendingCommits = new Set<string>();
  private commitCursor: string | undefined;
  private deadline = Infinity;
  constructor(
    readonly sources: Map<string, Source>,
    readonly publishing = false,
    readonly bounded = false
  ) {}
  private demandTokens = new Map<string, string>();
  private observedDemand: LinkLedgerRead | null = null;
  private evictions = 0;
  private resourceBlocked: string | null = null;
  private lifecycleOutcomes: { refKey: string; reason: string }[] = [];
  takeLifecycleOutcomes() {
    return this.lifecycleOutcomes.splice(0);
  }
  private activeMetadata() {
    return [...this.readings.values()].filter((reading) => !reading.retiring).length;
  }
  private metadataAvailable(ref: SessionRef, key = displayNodeKey({ kind: 'session', ref })) {
    if (!this.bounded || this.readings.has(key) || this.activeMetadata() < 200) return true;
    this.resourceBlocked = 'session_metadata_limit';
    return false;
  }
  reconcileMembership(certificate: LinkScopeMembership, view: DelegationViewModel): readonly string[] {
    if (!this.bounded) return [];
    const retired: string[] = [];
    const snapshot = this.observedDemand?.state === 'available' ? this.observedDemand.snapshot : null;
    for (const [key, reading] of this.readings) {
      if (certificate.present.has(key)) {
        reading.retiring = false;
        reading.retirementNode = undefined;
        reading.retirementBlocked = false;
        reading.retirementRejected = false;
        continue;
      }
      if (!certificate.complete || !snapshot) {
        if (reading.retiring) {
          reading.retirementBlocked = true;
          this.resourceBlocked = 'retirement_membership_unknown';
        }
        continue;
      }
      if (!reading.retiring && [...this.readings.values()].filter((r) => r.retiring).length >= 16) {
        reading.retirementBlocked = true;
        reading.retirementNode = undefined;
        this.resourceBlocked = 'retirement_metadata_limit';
        continue;
      }
      reading.retiring = true;
      reading.retirementBlocked = false;
      const run = certificate.currentRuns.get(key) ?? null;
      reading.retirementNode = {
        key,
        identity: { kind: 'session', ref: reading.ref },
        currentRun: run,
        execution: linkExecution(run, snapshot.events),
      };
      const publisher = reading.publisher;
      if (reading.owedLedger && !publisher?.hasReading()) {
        if (publisher?.matchesAcceptedRun(run?.runId, run?.expectedGeneration) === false) {
          this.lifecycleOutcomes.push({
            refKey: createHash('sha256').update(sessionRefKey(reading.ref)).digest('hex'),
            reason: 'retirement_owed_context_superseded',
          });
          reading.owedLedger = false;
          reading.owedSince = undefined;
          reading.retirementRejected = true;
        } else {
          reading.retirementBlocked = true;
          this.resourceBlocked = 'retirement_recapture_required';
          if ([...this.readings.values()].filter((r) => r.retiring).length > 16) {
            reading.retiring = false;
            reading.retirementNode = undefined;
          }
          continue;
        }
      }
      if (publisher?.hasReading() && reading.checkpoint) {
        const target = {
          nodeIdentity: { kind: 'session' as const, ref: reading.ref },
          sourceGeneration: reading.checkpoint.sourceGeneration,
          ...(run ? { runId: run.runId, bindingGeneration: run.expectedGeneration } : {}),
        };
        const matches = publisher.matchesPreparedContext(target);
        if (matches === false) {
          this.lifecycleOutcomes.push({
            refKey: createHash('sha256').update(sessionRefKey(reading.ref)).digest('hex'),
            reason: 'retirement_context_superseded',
          });
          publisher.close();
          reading.reader = undefined;
          reading.checkpoint = undefined;
          reading.retirementRejected = true;
          reading.dirty = true;
          reading.caughtUp = false;
          reading.recoveryPending = true;
        } else if (matches === null) {
          try {
            publisher.prepare(target);
          } catch {
            this.resourceBlocked = 'retirement_preparation_blocked';
            reading.retirementBlocked = true;
            continue;
          }
        }
      }
      const owed =
        reading.owedLedger ||
        (publisher?.hasReading() &&
          (publisher.hasPending() || reading.demandToken !== (this.demandTokens.get(key) ?? '')));
      if (reading.deliveryPending || (owed && !reading.retirementRejected)) continue;
      publisher?.close();
      reading.reader = undefined;
      reading.checkpoint = undefined;
      reading.raw = undefined;
      reading.envelope = undefined;
      reading.snapshot = undefined;
      reading.publisher = undefined;
      reading.retirementNode = undefined;
      this.readings.delete(key);
      this.minimumBytes.delete(key);
      this.pendingTopology.delete(key);
      this.pendingCommits.delete(key);
      retired.push(key);
    }
    if (retired.length) this.invalidateSnapshots();
    return retired;
  }
  private residency(reading: Reading): boolean {
    return !!(reading.reader || reading.checkpoint || reading.publisher?.hasReading());
  }
  private quiescent(reading: Reading): boolean {
    if (reading.retiring || reading.retirementBlocked) return false;
    const cp = reading.checkpoint;
    if (
      !cp ||
      reading.deliveryPending ||
      !reading.caughtUp ||
      reading.resetPending ||
      reading.recoveryPending ||
      reading.publisher?.hasPending()
    )
      return false;
    const partial = (state: {
      pendingBytes?: number[];
      tailBytesSeen?: number;
      tailAtEof?: boolean;
      discardingOversize?: boolean;
      discardOffset?: number | null;
    }) =>
      !!(
        state.pendingBytes?.length ||
        state.tailBytesSeen ||
        state.tailAtEof ||
        state.discardingOversize ||
        state.discardOffset
      );
    if (partial(cp.parserState)) return false;
    const claude = (cp as ReaderCheckpoint & { claude?: Parameters<typeof partial>[0] }).claude;
    const native = claude ?? cp.parserState;
    if (typeof native.tailBytesSeen !== 'number' || typeof native.tailAtEof !== 'boolean') return false;
    return !partial(native) && reading.publisher?.canEvictAcceptedReading() === true;
  }
  resources() {
    const resident = [...this.readings.values()].filter((r) => this.residency(r));
    return {
      readers: resident.length,
      pinnedReaders: resident.filter((r) => !this.quiescent(r)).length,
      evictions: this.evictions,
      metadata: this.readings.size,
      blocked: this.resourceBlocked,
      retiring: [...this.readings.values()].filter((r) => r.retiring).length,
      retirementBlocked: [...this.readings.values()].filter((r) => r.retirementBlocked).length,
    };
  }
  hasPendingCandidates(): boolean {
    return [...this.readings.values()].some((r) => r.publisher?.hasPending());
  }
  private admit(reading: Reading): boolean {
    if (!this.bounded) return true;
    if (process.memoryUsage().arrayBuffers + 8 * 1024 * 1024 > WORKER_EXTERNAL_LIMIT) {
      this.resourceBlocked = 'external_buffer_reservation';
      return false;
    }
    if (this.residency(reading)) {
      this.resourceBlocked = null;
      return true;
    }
    const resident = [...this.readings.values()].filter((r) => this.residency(r));
    if (resident.length >= WORKER_READER_LIMIT) {
      const candidates = resident
        .filter((r) => r !== reading && this.quiescent(r))
        .sort((a, b) => (a.grantedAt ?? 0) - (b.grantedAt ?? 0));
      const victim = candidates.find((r) => r.publisher?.evictAcceptedReading());
      if (!victim) {
        this.resourceBlocked = 'reader_slots_pinned';
        return false;
      }
      const victimKey = displayNodeKey({ kind: 'session', ref: victim.ref });
      if (victim.demandToken !== (this.demandTokens.get(victimKey) ?? '')) {
        victim.owedLedger = true;
        victim.owedSince ??= monotonicNow();
      }
      if (victim.owedLedger) victim.dirty = true;
      victim.reader = undefined;
      victim.checkpoint = undefined;
      victim.evicted = true;
      victim.recoveryPending = true;
      this.evictions++;
    }
    // Reserve native concatenation/rollback, read/signature, transport and the participating legacy tail.
    if (process.memoryUsage().arrayBuffers + 8 * 1024 * 1024 > WORKER_EXTERNAL_LIMIT) {
      this.resourceBlocked = 'external_buffer_reservation';
      return false;
    }
    this.resourceBlocked = null;
    return true;
  }
  observeLedger(ledger: LinkLedgerRead): void {
    if (!this.bounded || ledger === this.observedDemand || ledger.state !== 'available') return;
    this.observedDemand = ledger;
    const snapshot = ledger.snapshot;
    const runs = new Map<string, (typeof snapshot.runs)[number]>();
    for (const run of snapshot.runs)
      if (!runs.has(run.linkId) || runs.get(run.linkId)!.runSeq < run.runSeq) runs.set(run.linkId, run);
    const relevant = new Map<string, unknown[]>();
    const events = new Map<string, unknown[]>();
    for (const event of snapshot.events)
      if (event.runId && ['run.state', 'run.terminal', 'run.reconciliation', 'report.received'].includes(event.kind)) {
        const list = events.get(event.runId) ?? [];
        list.push([event.seq, event.kind, event.payload]);
        events.set(event.runId, list);
      }
    for (const link of snapshot.links)
      if (link.childRef) {
        const key = displayNodeKey({ kind: 'session', ref: link.childRef }),
          run = runs.get(link.linkId);
        const list = relevant.get(key) ?? [];
        list.push([
          link.linkId,
          link.state,
          link.currentOwner,
          run && [
            run.runId,
            run.expectedGeneration,
            run.state,
            run.heartbeatAt,
            run.cancelRequestedAt,
            run.endedAt,
            run.startedAt,
            run.createdAt,
          ],
          run && events.get(run.runId),
          snapshot.bindings.filter((b) => b.runId === run?.runId),
        ]);
        relevant.set(key, list);
      }
    const priorDemand = this.demandTokens;
    this.demandTokens = new Map(
      [...relevant].map(([key, value]) => [key, createHash('sha256').update(JSON.stringify(value)).digest('hex')])
    );
    for (const [key, reading] of this.readings) {
      const token = this.demandTokens.get(key) ?? '';
      if (reading.demandToken !== null && reading.demandToken !== undefined && reading.demandToken !== token) {
        reading.owedLedger = true;
        reading.owedSince ??= monotonicNow();
      }
      if (reading.evicted && (reading.owedLedger || reading.demandToken !== token)) reading.dirty = true;
      if (reading.publisher?.hasReading() && token !== (priorDemand.get(key) ?? '')) {
        this.publicationRevision++;
        this.noOpRevision = -1;
      }
    }
  }
  private publicationCursor = '';
  private publicationRevision = 0;
  private newReadingKey: string | null = null;
  preparePublication(view: DelegationViewModel | null): void {
    const key = this.newReadingKey;
    this.newReadingKey = null;
    if (!key || !view || view.tree.ledger.state !== 'available') return;
    const reading = this.readings.get(key);
    const node = view.tree.nodes.find((node) => node.key === key);
    if (!reading?.publisher || node?.identity.kind !== 'session') return;
    const run = node.currentRun;
    reading.publisher.prepare({
      nodeIdentity: node.identity,
      sourceGeneration: reading.checkpoint!.sourceGeneration,
      ...(run ? { runId: run.runId, bindingGeneration: run.expectedGeneration } : {}),
    });
  }
  private noOpRevision = -1;
  private noOpView: DelegationViewModel | null = null;
  private noOpDeadline = Infinity;
  private publicationClock = -Infinity;
  private ledgerObservedAt: number | null = null;
  setLedgerObservedAt(at: number | null): void {
    this.ledgerObservedAt = at;
  }
  private publicationView: DelegationViewModel | null = null;
  setPublicationView(view: DelegationViewModel | null): void {
    this.publicationView = view;
  }
  private publisher(source: Source, reading: Reading): SessionPublisher | null {
    if (!this.publishing || !source.writable || !source.store) return null;
    if (identity(source.store.databasePath) !== source.storeIdentity) {
      source.writable = false;
      reading.publisher?.forget();
      return null;
    }
    return (reading.publisher ??= new SessionPublisher(source.store, reading.ref, this.holder));
  }
  /** Same collection operation, one fair session, no flusher/timer/second queue. */
  publishOne(
    nowMs: number,
    pendingOnly = false
  ): { attempted: boolean; changed: boolean; error: string | null; key?: string } {
    const view = this.publicationView;
    const ledgerObservedAt = this.ledgerObservedAt;
    if (!this.publishing || !view || view.tree.ledger.state !== 'available' || ledgerObservedAt === null)
      return { attempted: false, changed: false, error: null };
    if (
      view === this.noOpView &&
      this.publicationRevision === this.noOpRevision &&
      nowMs >= this.publicationClock &&
      nowMs <= this.noOpDeadline
    )
      return { attempted: false, changed: false, error: null };
    this.publicationClock = nowMs;
    let nextDeadline = Infinity;
    const nodes = [
      ...view.tree.nodes,
      ...[...this.readings.values()].flatMap((reading) =>
        reading.retiring && reading.retirementNode ? [reading.retirementNode] : []
      ),
    ];
    const cursor = nodes.findIndex((n) => n.key === this.publicationCursor);
    for (let i = 1; i <= nodes.length; i++) {
      const node = nodes[(cursor + i) % nodes.length];
      if (node.identity.kind !== 'session') continue;
      const reading = this.readings.get(node.key);
      const publisher = reading?.publisher;
      if (reading?.retirementBlocked) continue;
      if (!reading || !publisher?.hasReading() || (pendingOnly && !publisher.hasPending())) continue;
      const source = this.sources.get(reading.ref.sourceId)!;
      if (!source.store || identity(source.store.databasePath) !== source.storeIdentity) {
        source.writable = false;
        publisher.forget();
        if (reading.envelope) reading.envelope = { ...reading.envelope, loaded: false };
        return { attempted: false, changed: false, error: 'observation_store_identity_changed' };
      }
      const publicationDemand = this.demandTokens.get(node.key) ?? '';
      const run = node.currentRun;
      const detail = view.details[node.key];
      const reports = reading.retiring
        ? [...this.reportFacts.values()].flatMap((fact) =>
            run && fact.value.report && fact.value.report.runId === run.runId ? [fact.value.report] : []
          )
        : (detail?.reportHistory ?? []);
      const facts: WriterFacts = {
        ...linkStatusInput(view.tree, node.key),
        target: {
          nodeIdentity: node.identity,
          sourceGeneration: reading.checkpoint!.sourceGeneration,
          ...(run ? { runId: run.runId, bindingGeneration: run.expectedGeneration } : {}),
        },
        sources: run
          ? [
              {
                id: `supervisor:${run.runId}`,
                deadlineAt: run.heartbeatAt === null ? null : run.heartbeatAt + 30000,
                evidence: {
                  origin: 'supervisor',
                  ref: node.identity.ref,
                  sourceGeneration: reading.checkpoint!.sourceGeneration,
                  runId: run.runId,
                  bindingGeneration: run.expectedGeneration,
                  validity: 'current',
                  eventAt: run.heartbeatAt,
                  observedAt: ledgerObservedAt,
                  lastSuccessfulReadAt: ledgerObservedAt,
                  value: { heartbeatAt: run.heartbeatAt },
                },
              },
            ]
          : [],
        ledgerFacts: run
          ? [
              {
                id: `run:${run.runId}`,
                value: {
                  run: {
                    runId: run.runId,
                    state: run.state,
                    reason: node.execution.reconciliation?.cause ?? node.execution.launchFailure?.reason,
                  },
                },
                eventAt: run.cancelRequestedAt ?? run.endedAt ?? run.startedAt ?? run.createdAt,
                observedAt: ledgerObservedAt,
                deadlineAt: ledgerObservedAt + LEDGER_SNAPSHOT_VALIDITY_MS,
              },
            ]
          : [],
        history: {
          continuity: publisher.historyContinuity(),
          gap: publisher.historyGap(),
        },
      };
      const stateEvent = run ? this.runEvents.get(run.runId) : undefined;
      const entryEvent = run ? this.runStateEvents.get(run.runId) : undefined;
      const selectedReason = facts.ledgerFacts?.[0]?.value.run?.reason ?? null;
      if (
        run &&
        stateEvent &&
        (stateEvent.payload.state === run.state ||
          (stateEvent.kind === 'run.reconciliation' && (stateEvent.payload.cause ?? null) === selectedReason))
      ) {
        const fact = facts.ledgerFacts![0];
        facts.ledgerFacts = [
          {
            ...fact,
            seq: stateEvent.seq,
            eventAt: stateEvent.at,
            value: {
              ...fact.value,
              episodes: { run: `ledger:${entryEvent?.payload.state === run?.state ? entryEvent.seq : stateEvent.seq}` },
            },
          },
        ];
      }
      // Report sequence comes only from the same validated ledger snapshot, never an observation sequence.
      const reportFacts = reports.flatMap((report) => {
        const fact = this.reportFacts.get(report.reportId);
        return fact?.value.report?.runId === run?.runId ? [fact!] : [];
      });
      facts.ledgerFacts = [...(facts.ledgerFacts ?? []), ...reportFacts];
      const key = JSON.stringify([
        STATUS_RULE_VERSION,
        facts.target,
        facts.link ? [facts.link.linkId, facts.link.state] : null,
        facts.conflict,
        run && [run.state, run.heartbeatAt, run.cancelRequestedAt, run.endedAt, node.execution],
        stateEvent?.seq ?? null,
        run
          ? this.ledgerObservedAt !== null &&
            nowMs >= this.ledgerObservedAt &&
            nowMs <= this.ledgerObservedAt + LEDGER_SNAPSHOT_VALIDITY_MS
          : null,
        reportFacts.map((fact) => [fact.id, fact.seq, fact.value]),
      ]);
      nextDeadline = Math.min(nextDeadline, publisher.deadline());
      if (!publisher.due(key, nowMs) && !reading.owedLedger && reading.demandToken === publicationDemand) continue;
      this.publicationCursor = node.key;
      try {
        if (!publisher.valid(nowMs)) {
          const pending = publisher.hasPending();
          publisher.forget();
          reading.reader = undefined;
          reading.checkpoint = undefined;
          reading.raw = undefined;
          reading.snapshot = undefined;
          reading.recoveryPending = true;
          reading.dirty = true;
          this.minimumBytes.delete(node.key);
          this.pendingTopology.delete(node.key);
          if (reading.envelope)
            reading.envelope = {
              ...reading.envelope,
              evidence: evidenceFromView(reading.ref, reading.envelope.evidence.observation),
              linkEvidenceCurrent: false,
              bytesRead: 0,
              recordsRead: 0,
            };
          this.invalidateSnapshots();
          if (reading.retiring) {
            reading.retirementRejected = true;
            this.lifecycleOutcomes.push({
              refKey: createHash('sha256').update(sessionRefKey(reading.ref)).digest('hex'),
              reason: 'retirement_lease_invalidated',
            });
          } else if (pending) {
            this.lifecycleOutcomes.push({
              refKey: createHash('sha256').update(sessionRefKey(reading.ref)).digest('hex'),
              reason: 'publication_lease_invalidated',
            });
          }
          return { attempted: false, changed: false, error: null };
        }
        const prior = reading.envelope?.evidence.observation.statusProjection.observationStamp?.commitSeq;
        const committed = publisher.publish(facts, key, nowMs);
        if (committed) {
          reading.demandToken = publicationDemand;
          reading.owedLedger = false;
          reading.owedSince = undefined;
          reading.deliveryPending = committed.commitSeq !== prior;
          this.committed(this.sources.get(reading.ref.sourceId)!, reading);
        }
        return { attempted: true, changed: committed?.commitSeq !== prior, error: null, key: node.key };
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'observation_unavailable';
        if (reason === 'status_new_reading_required') {
          publisher.discardReading();
          reading.dirty = true;
        }
        if (['lease_fenced', 'lease_expired', 'lease_time_unknown', 'observation_commit_conflict'].includes(reason)) {
          publisher.forget();
          reading.reader = undefined;
          reading.checkpoint = undefined;
          reading.recoveryPending = true;
          reading.dirty = true;
        }
        if (reading.envelope) reading.envelope = { ...reading.envelope, loaded: false };
        return { attempted: true, changed: false, error: reason };
      }
    }
    this.noOpView = view;
    this.noOpRevision = this.publicationRevision;
    this.noOpDeadline = nextDeadline;
    return { attempted: false, changed: false, error: null };
  }
  private reportFacts: ReadonlyMap<string, LedgerStatusFact> = new Map();
  private runEvents: ReadonlyMap<string, LedgerEvent> = new Map();
  private runStateEvents: ReadonlyMap<string, LedgerEvent> = new Map();
  setRunStateEvents(events: ReadonlyMap<string, LedgerEvent>): void {
    this.runStateEvents = events;
  }
  setRunEvents(events: ReadonlyMap<string, LedgerEvent>): void {
    this.runEvents = events;
  }
  setReportFacts(facts: ReadonlyMap<string, LedgerStatusFact>): void {
    this.reportFacts = facts;
  }

  invalidateSnapshots(): void {
    this.snapshot = null;
    for (const reading of this.readings.values()) reading.snapshot = undefined;
  }
  begin(deadline: number): void {
    this.deadline = deadline;
    this.resourceBlocked = null;
    if (this.bounded) for (const reading of this.readings.values()) reading.deliveryPending = false;
    this.charges = { bytesRead: 0, recordsRead: 0 };
    this.sourceChecks.clear();
    let storesChanged = false;
    for (const source of this.sources.values()) {
      if (!source.store) continue;
      const file = source.store.databasePath;
      const stamp = `${signature(file)}:${signature(file + '-wal')}`;
      source.storeDirty = stamp !== source.storeSignature;
      storesChanged ||= source.storeDirty;
      source.storeSignature = stamp;
    }
    if (!storesChanged && !this.pendingCommits.size) return;
    const storeIdentities = new Map(
      [...this.sources].map(([id, source]) => [id, source.store ? identity(source.store.databasePath) : null])
    );
    for (const [key, reading] of this.readings) {
      const source = this.sources.get(reading.ref.sourceId);
      if (!reading.envelope) continue;
      if (!source?.store || storeIdentities.get(reading.ref.sourceId) !== source.storeIdentity) {
        if (reading.envelope.loaded && reading.envelope.evidence.observation.statusProjection.observationStamp)
          reading.envelope = { ...reading.envelope, loaded: false };
      }
      if (source?.storeDirty) {
        this.pendingCommits.add(key);
        if (this.bounded) reading.publisher?.observeStoreChange();
      }
    }
    if (!this.pendingCommits.size) return;
    const entries = [...this.readings];
    const prior = entries.findIndex(([key]) => key === this.commitCursor);
    const ordered = [...entries.slice(prior + 1), ...entries.slice(0, prior + 1)];
    for (const [key, reading] of ordered) {
      if (performance.now() >= deadline) break;
      if (!this.pendingCommits.has(key)) continue;
      const source = this.sources.get(reading.ref.sourceId);
      if (source && this.committed(source, reading)) this.pendingCommits.delete(key);
      this.commitCursor = key;
    }
  }
  sessions(): readonly CollectedLinkSession[] {
    const states = new Map<string, { topologyDirty: boolean; topologyToken: number }>();
    let result: CollectedLinkSession[] | null = null;
    let index = 0;
    for (const reading of this.readings.values()) {
      if (!reading.envelope) continue;
      const envelope = reading.envelope;
      let topology = envelope.topology;
      const source = this.sources.get(reading.ref.sourceId);
      let token = -1,
        dirty = false;
      if (topology && source?.adapter instanceof CodexAdapter) {
        let state = states.get(reading.ref.sourceId);
        if (!state) {
          state = source.adapter.collectionState(reading.ref, false);
          states.set(reading.ref.sourceId, state);
        }
        token = state.topologyToken;
        dirty = state.topologyDirty || token !== reading.topologyToken;
      }
      let cached = reading.snapshot;
      if (!cached || cached.envelope !== envelope || cached.token !== token || cached.dirty !== dirty) {
        if (topology && dirty)
          topology = {
            ...topology,
            loaded: false,
            coverage: { ...topology.coverage, state: 'catching_up', loaded: false, reason: 'native_topology' },
          };
        const value = {
          ...envelope,
          bytesRead: 0,
          recordsRead: 0,
          ...(topology ? { topology: { ...topology, bytesRead: 0, recordsRead: 0 } } : {}),
        };
        reading.snapshot = cached = { envelope, token, dirty, value };
      }
      if (!result && this.snapshot?.[index] !== cached.value) result = this.snapshot?.slice(0, index) ?? [];
      result?.push(cached.value);
      index++;
    }
    if (result || this.snapshot?.length !== index) this.snapshot = result ?? this.snapshot?.slice(0, index) ?? [];
    return this.snapshot!;
  }
  private reading(ref: SessionRef, key = displayNodeKey({ kind: 'session', ref })): Reading {
    let reading = this.readings.get(key);
    if (!reading) {
      reading = {
        ref: { ...ref },
        signature: null,
        dirty: true,
        caughtUp: false,
        topologyToken: -1,
        demandToken: null,
      };
      this.readings.set(key, reading);
    }
    return reading;
  }
  private committed(source: Source, reading: Reading): boolean {
    if (!source.store) return false;
    if (identity(source.store.databasePath) !== source.storeIdentity) {
      if (reading.envelope) reading.envelope = { ...reading.envelope, loaded: false };
      return false;
    }
    try {
      const stamp = reading.envelope?.evidence.observation.statusProjection.observationStamp;
      if (stamp && reading.envelope?.loaded) {
        const head = source.store.readHead(reading.ref);
        if (
          head &&
          head.commitSeq === stamp.commitSeq &&
          head.seqDomain === stamp.seqDomain &&
          head.sourceGeneration === stamp.sourceGeneration
        )
          return true;
      }
      const commit = source.store.readProjection(reading.ref);
      if (!commit) {
        if (reading.envelope?.evidence.observation.statusProjection.observationStamp)
          reading.envelope = { ...reading.envelope, loaded: false };
        return true;
      }
      // Preserve the exact committed summary/stamp. B9 checks it against the real current run.
      let prior = reading.envelope;
      if (reading.raw && prior?.sourceGeneration !== commit.sourceGeneration) {
        if (prior && commit.sourceGeneration > prior.sourceGeneration) {
          // A follower adopts the authoritative newer lineage without acquiring a write lease.
          reading.raw = undefined;
          reading.reader = undefined;
          reading.checkpoint = undefined;
          reading.publisher?.forget();
          reading.recoveryPending = true;
          reading.dirty = true;
          reading.caughtUp = false;
          reading.signature = null;
          reading.resetPending = false;
          reading.topologyToken = -1;
          this.pendingTopology.delete(displayNodeKey({ kind: 'session', ref: reading.ref }));
          if (source.adapter instanceof CodexAdapter) source.adapter.invalidateTopology(reading.ref);
          prior = undefined;
        } else {
          if (prior && this.publishing) reading.envelope = { ...prior, lastCommitted: commit.summary };
          return true;
        }
      }
      reading.envelope = {
        evidence: { ...(reading.raw ?? evidenceFromView(reading.ref, commit.summary)), observation: commit.summary },
        ...(this.publishing ? { committedOnly: true, lastCommitted: commit.summary } : {}),
        sourceGeneration: commit.sourceGeneration,
        linkEvidenceCurrent: reading.raw ? (prior?.linkEvidenceCurrent ?? false) : false,
        loaded: true,
        bytesRead: 0,
        recordsRead: 0,
        ...(prior?.topology ? { topology: prior.topology } : {}),
      };
      return true;
    } catch {
      if (reading.envelope)
        reading.envelope = {
          ...reading.envelope,
          loaded: false,
        }; /* Preserve the original rejected stamp as lastObservation. */
      return false;
    }
  }
  pending(ref: SessionRef, key?: string): 'session' | 'native_topology' | null {
    if (performance.now() >= this.deadline) return null;
    const source = this.sources.get(ref.sourceId);
    if (!source || source.adapter.id !== ref.harness) return null;
    if (!this.metadataAvailable(ref, key)) return 'session';
    const reading = this.reading(ref, key);
    if (reading.retiring || reading.retirementBlocked) return null;
    if (source.adapter instanceof ClaudeAdapter && reading.file) {
      const current = fileStamp(reading.file);
      if (!sameFileStamp(current, reading.signature)) reading.dirty = true;
      if (
        reading.signature &&
        (!current ||
          current.dev !== reading.signature.dev ||
          current.ino !== reading.signature.ino ||
          current.size < reading.signature.size)
      ) {
        reading.resetPending = true;
        reading.publisher?.discardReading();
        if (reading.envelope) reading.envelope = { ...reading.envelope, loaded: false, linkEvidenceCurrent: false };
      }
    }
    if (source.adapter instanceof CodexAdapter) {
      const first = !this.sourceChecks.has(ref.sourceId);
      const prior = this.sourceChecks.get(ref.sourceId);
      // A resolved path remains indexed while this source's catalog epoch is
      // unchanged. File stat below still checks every visible file each tick.
      const state =
        !first && !prior!.dirty && reading.file && reading.topologyToken === prior!.token
          ? { file: reading.file, topologyDirty: false, topologyToken: prior!.token }
          : source.adapter.collectionState(ref, first, this.deadline);
      if (first) this.sourceChecks.set(ref.sourceId, { dirty: state.topologyDirty, token: state.topologyToken });
      if (!state.file && reading.envelope && (reading.reader || !state.topologyDirty)) {
        reading.resetPending = true;
        if (reading.envelope.loaded || reading.envelope.linkEvidenceCurrent)
          reading.envelope = { ...reading.envelope, loaded: false, linkEvidenceCurrent: false };
      }
      if (state.file) {
        const current = fileStamp(state.file);
        if (!sameFileStamp(current, reading.signature)) reading.dirty = true;
        if (reading.signature && !sameFileStamp(current, reading.signature)) {
          const old = reading.signature;
          if (
            !sameFileStamp(reading.resetSignature, current) &&
            (!current || old.dev !== current.dev || old.ino !== current.ino || current.size <= old.size)
          ) {
            source.adapter.invalidateTopology(ref);
            this.sourceChecks.set(ref.sourceId, { dirty: true, token: -1 });
            reading.topologyToken = -1;
            reading.resetSignature = current;
            reading.resetPending = true;
            reading.publisher?.discardReading();
            if (reading.envelope) reading.envelope = { ...reading.envelope, loaded: false, linkEvidenceCurrent: false };
            return 'native_topology';
          }
        }
      }
      const check = this.sourceChecks.get(ref.sourceId)!;
      if (!state.file || check.dirty || reading.topologyToken !== check.token) {
        if (state.file && reading.reader && !reading.publisher?.hasPending() && (reading.dirty || !reading.caughtUp)) {
          return reading.lastGrantedKind === 'session' ? 'native_topology' : 'session';
        }
        return 'native_topology';
      }
    }
    if (reading.publisher?.hasPending()) return null;
    return !reading.envelope || !reading.envelope.loaded || reading.dirty || !reading.caughtUp ? 'session' : null;
  }
  lineageCurrent(ref: SessionRef): boolean {
    return !this.readings.get(displayNodeKey({ kind: 'session', ref }))?.resetPending;
  }
  async collect(
    ref: SessionRef,
    kind: 'session' | 'native_topology',
    budget: ReaderBudget
  ): Promise<CollectedLinkSession | null> {
    const source = this.sources.get(ref.sourceId);
    if (!source) return null;
    if (!this.metadataAvailable(ref)) return null;
    const reading = this.reading(ref);
    if (reading.retiring || reading.retirementBlocked) return reading.envelope ?? null;
    ref = reading.ref;
    reading.lastGrantedKind = kind;
    if (kind === 'native_topology') {
      const topology = source.adapter.collectTopology
        ? await source.adapter.collectTopology(ref, budget)
        : {
            children: [],
            loaded: false,
            bytesRead: 0,
            recordsRead: 0,
            coverage: {
              state: 'partial' as const,
              skipped: {},
              gaps: ['native_topology_unavailable'],
              loaded: false,
              reason: 'native_topology_unavailable',
            },
          };
      if (!reading.resetPending) this.committed(source, reading);
      if (source.adapter instanceof CodexAdapter)
        reading.topologyToken = source.adapter.collectionState(ref, false).topologyToken;
      // Topology before any reader lineage is kept pending; never invent sourceGeneration=1.
      if (!reading.envelope) {
        reading.dirty = true;
        this.pendingTopology.set(displayNodeKey({ kind: 'session', ref }), topology);
        this.charges = { bytesRead: topology.bytesRead, recordsRead: topology.recordsRead };
        return null;
      }
      if (source.adapter instanceof CodexAdapter && !source.adapter.collectionState(ref, false).file)
        reading.envelope = { ...reading.envelope, loaded: false, linkEvidenceCurrent: false };
      this.pendingTopology.delete(displayNodeKey({ kind: 'session', ref }));
      reading.envelope = {
        ...reading.envelope,
        bytesRead: 0,
        recordsRead: 0,
        topology: { ...topology, ref, sourceGeneration: reading.envelope.sourceGeneration },
      };
      return reading.envelope;
    }
    try {
      const collectionDeadline = performance.now() + budget.budgetMs;
      if (source.claudeFiles) {
        const file = source.claudeFiles.resolve(ref, collectionDeadline);
        if (!file) return reading.envelope ?? null;
        if (reading.file !== file) reading.reader = undefined;
        reading.file = file;
        budget = { ...budget, budgetMs: Math.max(0, Math.floor(collectionDeadline - performance.now())) };
        if (budget.budgetMs === 0) return reading.envelope ?? null;
      }
      const publisher = this.publisher(source, reading);
      if (this.publishing) {
        if (!publisher) {
          this.committed(source, reading);
          return reading.envelope ?? null;
        }
        const hadRuntime = this.residency(reading) || !!reading.raw || publisher.hasPending();
        const claim = publisher.claim(Date.now());
        if (claim === 'follower') {
          this.committed(source, reading);
          if (hadRuntime) {
            const key = displayNodeKey({ kind: 'session', ref: reading.ref });
            reading.reader = undefined;
            reading.checkpoint = undefined;
            reading.raw = undefined;
            reading.recoveryPending = true;
            reading.evicted = true;
            this.minimumBytes.delete(key);
            this.pendingTopology.delete(key);
            // Retain only detached display metadata, even when committed() reused the same head.
            if (reading.envelope)
              reading.envelope = {
                ...reading.envelope,
                evidence: evidenceFromView(reading.ref, reading.envelope.evidence.observation),
                linkEvidenceCurrent: false,
                bytesRead: 0,
                recordsRead: 0,
              };
            this.lifecycleOutcomes.push({
              refKey: createHash('sha256').update(sessionRefKey(reading.ref)).digest('hex'),
              reason: 'reader_authority_retired',
            });
            this.invalidateSnapshots();
          }
          return reading.envelope ?? null;
        }
        if (claim === 'acquired') {
          reading.reader = undefined;
          reading.checkpoint = undefined;
          reading.recoveryPending = true;
        }
        if (!this.admit(reading)) return reading.envelope ?? null;
        if (reading.recoveryPending) {
          const prior = source.store!.readProjection(ref);
          if (prior) {
            const recovery = source.store!.readRecovery(prior, budget);
            if (!recovery || 'kind' in recovery) {
              if (recovery?.kind === 'record_needs_larger_slice')
                this.minimumBytes.set(displayNodeKey({ kind: 'session', ref }), recovery.minimumBytes);
              this.charges = { bytesRead: budget.maxBytes, recordsRead: budget.maxRecords };
              return reading.envelope ?? null;
            }
            if (!publisher?.acceptRecovery(prior, recovery)) throw new TypeError('accepted_recovery_mismatch');
            reading.checkpoint = recovery.checkpoint;
            // Known compact recovery bytes only. B12M must add SQLite/lazy-index metering; all wall time is included.
            const { recoveryIndex: _index, ...inline } = recovery.checkpoint;
            const charged = Buffer.byteLength(canonicalJson(inline));
            budget = {
              ...budget,
              maxBytes: Math.max(0, budget.maxBytes - charged),
              maxRecords: Math.max(0, budget.maxRecords - 1),
            };
            this.charges = { bytesRead: charged, recordsRead: 1 };
          }
          reading.recoveryPending = false;
        }
      }
      if (source.adapter instanceof CodexAdapter) {
        const file = source.adapter.collectionState(ref, false).file;
        if (reading.file !== file) {
          reading.reader = undefined;
          reading.file = file;
        }
      }
      budget = {
        ...budget,
        budgetMs: Math.max(0, Math.floor(Math.min(collectionDeadline, this.deadline) - performance.now())),
      };
      if (budget.budgetMs === 0 || budget.maxBytes === 0 || budget.maxRecords === 0) return reading.envelope ?? null;
      if (!this.admit(reading)) return reading.envelope ?? null;
      reading.grantedAt = monotonicNow();
      reading.reader ??= source.adapter.open(ref, reading.checkpoint);
      reading.evicted = false;
      const readSignature = reading.file ? fileStamp(reading.file) : null;
      const previousGeneration = reading.checkpoint?.sourceGeneration;
      const result = await reading.reader.read(budget);
      if (!result.evidence || !result.stats) return null;
      const reset = previousGeneration !== undefined && previousGeneration !== result.checkpoint.sourceGeneration;
      if (reset && source.adapter instanceof CodexAdapter) {
        source.adapter.invalidateTopology(ref);
        reading.topologyToken = -1;
        this.pendingTopology.delete(displayNodeKey({ kind: 'session', ref }));
      }
      reading.resetPending = false;
      reading.resetSignature = undefined;
      publisher?.capture(result);
      if (publisher) {
        this.publicationRevision++;
        this.newReadingKey = displayNodeKey({ kind: 'session', ref });
      }
      reading.raw = result.evidence;
      reading.checkpoint = result.checkpoint;
      const topologyKey = displayNodeKey({ kind: 'session', ref });
      const topology = this.pendingTopology.get(topologyKey);
      this.pendingTopology.delete(topologyKey);
      reading.envelope = {
        evidence: result.evidence,
        ...(this.publishing ? { committedOnly: true, lastCommitted: reading.envelope?.lastCommitted ?? null } : {}),
        sourceGeneration: result.checkpoint.sourceGeneration,
        linkEvidenceCurrent: !result.checkpoint.resetReason,
        loaded: result.observation.coverage.state !== 'catching_up' && !result.continuation,
        bytesRead: result.stats.bytesRead,
        recordsRead: result.stats.recordsRead,
        ...(topology
          ? {
              topology: {
                ...topology,
                ref,
                sourceGeneration: result.checkpoint.sourceGeneration,
                bytesRead: 0,
                recordsRead: 0,
              },
            }
          : !reset && reading.envelope?.topology
            ? {
                topology: {
                  ...reading.envelope.topology,
                  sourceGeneration: result.checkpoint.sourceGeneration,
                  bytesRead: 0,
                  recordsRead: 0,
                },
              }
            : {}),
      };
      reading.caughtUp = result.observation.coverage.state !== 'catching_up' && !result.continuation;
      reading.dirty = !reading.caughtUp;
      reading.signature = readSignature;
      const key = displayNodeKey({ kind: 'session', ref });
      if (result.continuation?.kind === 'record_needs_larger_slice')
        this.minimumBytes.set(key, result.continuation.minimumBytes);
      else this.minimumBytes.delete(key);
      const charged = { bytesRead: result.stats.bytesRead, recordsRead: result.stats.recordsRead };
      this.committed(source, reading);
      if (this.publishing && !reading.envelope.evidence.observation.statusProjection.observationStamp)
        reading.envelope = { ...reading.envelope, loaded: false };
      reading.envelope = { ...reading.envelope, ...charged };
      return reading.envelope;
    } catch {
      // No completed statistics are available on a thrown read: reserve its full grant conservatively.
      this.charges = {
        bytesRead: this.charges.bytesRead + budget.maxBytes,
        recordsRead: this.charges.recordsRead + budget.maxRecords,
      };
      reading.dirty = true;
      if (reading.envelope) reading.envelope = { ...reading.envelope, loaded: false, linkEvidenceCurrent: false };
      return reading.envelope ?? null;
    }
  }
  private pendingTopology = new Map<string, Awaited<ReturnType<NonNullable<CodexAdapter['collectTopology']>>>>();
  charges = { bytesRead: 0, recordsRead: 0 };
  takeUnattributedIO() {
    const charged = this.charges;
    this.charges = { bytesRead: 0, recordsRead: 0 };
    return charged;
  }
  invalidateSource(sourceId: string): void {
    const source = this.sources.get(sourceId);
    const identityChanged = source?.store && identity(source.store.databasePath) !== source.storeIdentity;
    for (const reading of this.readings.values())
      if (reading.ref.sourceId === sourceId) {
        if (reading.owedLedger) {
          this.lifecycleOutcomes.push({
            refKey: createHash('sha256').update(sessionRefKey(reading.ref)).digest('hex'),
            reason: 'source_publication_debt_invalidated',
          });
          reading.owedLedger = false;
          reading.owedSince = undefined;
        }
        reading.demandToken = null;
        if (identityChanged) reading.publisher?.forget();
        else reading.publisher?.close();
        reading.publisher = undefined;
        reading.reader = undefined;
        reading.checkpoint = undefined;
        reading.recoveryPending = true;
        reading.dirty = true;
      }
    this.invalidateSnapshots();
    for (const [key, reading] of this.readings)
      if (reading.ref.sourceId === sourceId) {
        if (reading.envelope?.evidence.observation.statusProjection.observationStamp)
          reading.envelope = { ...reading.envelope, loaded: false };
        this.pendingCommits.add(key);
      }
  }
  close(): void {
    for (const reading of this.readings.values()) {
      if (reading.owedLedger || reading.publisher?.hasPending())
        this.lifecycleOutcomes.push({
          refKey: createHash('sha256').update(sessionRefKey(reading.ref)).digest('hex'),
          reason: 'collector_closed_unaccepted',
        });
      reading.publisher?.close();
    }
    for (const source of this.sources.values()) {
      source.store?.close();
      if (source.adapter instanceof CodexAdapter) source.adapter.closeCollection();
    }
    this.readings.clear();
    this.pendingTopology.clear();
    this.pendingCommits.clear();
    this.minimumBytes.clear();
    this.invalidateSnapshots();
  }
}

export class HudDelegationCollector {
  private watcher: fs.FSWatcher | null = null;
  private sourceWatchers: fs.FSWatcher[] = [];
  private ledgerIdentity: string | null;
  private collecting = false;
  private preparing = false;
  private refreshPending = false;
  private closed = false;
  private readonly commitTraces: CommitTrace[] = [];
  private constructor(
    readonly home: string,
    readonly collector: LinkTickCollector,
    private readonly port: SessionCollection,
    private readonly ambientRef: (id: string) => SessionRef | null
  ) {
    this.ledgerIdentity = identity(path.join(home, 'ledger.sqlite'));
    if (port.bounded) for (const source of port.sources.values()) if (source.store) this.traceStore(source.store);
    try {
      this.watcher = fs.watch(home, (_event, file) => {
        if (!file || ['ledger.sqlite', 'ledger.sqlite-wal', 'sources'].includes(String(file))) {
          this.refreshPending = true;
          if (!this.collecting && !this.port.bounded) void this.prepare();
        }
      });
      this.watcher.unref();
    } catch {}
    this.watchSources();
  }
  private watchSources(): void {
    for (const watcher of this.sourceWatchers) watcher.close();
    this.sourceWatchers = [];
    const dirs = [
      path.join(this.home, 'sources'),
      ...[...this.port.sources.keys()].map((id) => path.join(this.home, 'sources', id)),
    ];
    for (const dir of dirs)
      try {
        const watcher = fs.watch(dir, () => {
          this.refreshPending = true;
          if (!this.collecting && !this.port.bounded) void this.prepare();
        });
        watcher.unref();
        this.sourceWatchers.push(watcher);
      } catch {}
  }
  /** Startup and identity-change preparation only; never called from tick. */
  async prepare(): Promise<void> {
    if (this.closed || this.preparing || this.collecting) return;
    const next = identity(path.join(this.home, 'ledger.sqlite'));
    this.refreshPending = false;
    this.preparing = true;
    try {
      if (next !== this.ledgerIdentity) {
        const reader = await openLinkLedgerReader(path.join(this.home, 'ledger.sqlite'));
        if (this.closed) {
          reader.close();
          return;
        }
        this.collector.replaceReader(reader);
        this.ledgerIdentity = next;
      }
      let changed = false;
      for (const [sourceId, source] of this.port.sources) {
        const file = path.join(this.home, 'sources', sourceId, 'observation.sqlite');
        const nextIdentity = identity(file);
        if (
          nextIdentity === source.storeIdentity &&
          (!this.port.publishing || source.writable || this.ledgerIdentity === null)
        )
          continue;
        this.port.invalidateSource(sourceId);
        source.store?.close();
        source.store = null;
        source.writable = false;
        try {
          source.store = await openObservationStore({ hudHome: this.home, sourceId, readOnly: !this.port.publishing });
          source.writable = this.port.publishing;
          if (this.port.bounded) this.traceStore(source.store);
          source.storeIdentity = identity(source.store.databasePath);
        } catch {
          if (nextIdentity === null) source.storeIdentity = null;
          else this.refreshPending = true;
        }
        if (this.closed) {
          source.store?.close();
          source.store = null;
          return;
        }
        source.storeSignature = '';
        changed = true;
      }
      if (changed) this.watchSources();
    } finally {
      this.preparing = false;
    }
  }

  private stageTimes = { recoveryMs: 0, decodeMs: 0, headMs: 0, leaseMs: 0, prepareMs: 0, publishCallMs: 0 };
  operationStages() {
    return { ...this.stageTimes };
  }
  private traceStore(store: ObservationStore): void {
    const target = store as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const [method, stage] of [
      ['readRecovery', 'recoveryMs'],
      ['readProjection', 'decodeMs'],
      ['readHead', 'headMs'],
      ['acquire', 'leaseMs'],
      ['renew', 'leaseMs'],
      ['prepareCheckpoint', 'prepareMs'],
    ] as const) {
      const original = target[method].bind(store);
      target[method] = (...args) => {
        const started = performance.now();
        try {
          return original(...args);
        } finally {
          this.stageTimes[stage] += performance.now() - started;
        }
      };
    }
    const publish = store.publishPrepared.bind(store);
    store.publishPrepared = (candidate, lease) => {
      const beforeAt = monotonicNow();
      let result;
      try {
        result = publish(candidate, lease);
      } finally {
        this.stageTimes.publishCallMs += monotonicNow() - beforeAt;
      }
      const returnedAt = monotonicNow();
      if (result.changed)
        this.commitTraces.push({
          refKey: createHash('sha256').update(sessionRefKey(candidate.commit.ref)).digest('hex'),
          commitSeq: result.commitSeq,
          stamp: {
            seqDomain: candidate.commit.seqDomain,
            sourceGeneration: candidate.commit.sourceGeneration,
            runId: candidate.commit.observationStamp.runId,
            bindingGeneration: candidate.commit.observationStamp.bindingGeneration,
          },
          beforeAt,
          returnedAt,
          ackAt: null,
        });
      return result;
    };
  }
  takeLifecycleOutcomes() {
    return this.port.takeLifecycleOutcomes();
  }
  takeCommitTraces(): CommitTrace[] {
    return this.commitTraces.splice(0);
  }
  resources() {
    return this.port.resources();
  }
  async settlePending(): Promise<{ settled: boolean; attempted: boolean; error: string | null }> {
    if (!this.port.hasPendingCandidates()) return { settled: true, attempted: false, error: null };
    this.port.setPublicationView(this.collector.current());
    const result = this.port.publishOne(Date.now(), true);
    return { settled: !this.port.hasPendingCandidates(), attempted: result.attempted, error: result.error };
  }
  private tickStarted = 0;
  private tailPending = false;
  private operation: object | null = null;
  /** Release only this collection operation after an entrypoint assembly/paint failure; retain unacknowledged evidence. */
  abandonCollection(): void {
    this.tailPending = false;
    this.operation = null;
    this.collecting = false;
  }
  publicationToken(): object | null {
    return this.operation;
  }
  private publication = { publishMs: 0, fullTickMs: 0, attempted: false, changed: false, error: null as string | null };
  publicationStats() {
    return { ...this.publication };
  }
  /** Await immediately after this collection's initial paint; never call for redraw/status/wait. */
  async afterPaint(
    paint: (view: DelegationViewModel | null) => void,
    collectionStartedAt = this.tickStarted,
    token = this.operation
  ): Promise<void> {
    if (!this.tailPending || this.closed || token !== this.operation) return;
    this.tailPending = false;
    this.operation = null;
    const started = performance.now();
    this.publication = { publishMs: 0, fullTickMs: 0, attempted: false, changed: false, error: null };
    try {
      this.port.setPublicationView(this.collector.current());
      this.port.setLedgerObservedAt(this.collector.publicationLedgerObservedAt());
      this.port.setReportFacts(this.collector.publicationReportFacts());
      this.port.setRunEvents(this.collector.publicationRunEvents());
      this.port.setRunStateEvents(this.collector.publicationRunStateEvents());
      const result = this.port.publishOne(Date.now());
      this.publication = { ...result, publishMs: performance.now() - started, fullTickMs: 0 };
      if (result.changed || result.error)
        paint(await this.collector.refreshCommitted(result.error ? undefined : result.key));
    } catch (error) {
      this.publication = {
        ...this.publication,
        publishMs: performance.now() - started,
        error: error instanceof Error ? error.message : 'observation_unavailable',
      };
    } finally {
      this.collecting = false;
      if (this.refreshPending) await this.prepare();
      this.publication.fullTickMs = performance.now() - collectionStartedAt;
    }
  }
  async tick(sessionId: string | undefined, deadline?: number, maxBytes?: number): Promise<DelegationViewModel | null> {
    if (this.collecting) return this.collector.current();
    for (const key of Object.keys(this.stageTimes) as (keyof typeof this.stageTimes)[]) this.stageTimes[key] = 0;
    if (this.port.bounded && this.refreshPending) await this.prepare();
    this.collecting = true;
    this.tickStarted = performance.now();
    this.tailPending = this.port.publishing;
    this.operation = Object.freeze({});
    try {
      const ref = sessionId ? this.ambientRef(sessionId) : null;
      const view = await this.collector.tick({
        roots: ref ? [{ kind: 'session', ref }] : [],
        deadline,
        ...(maxBytes === undefined ? {} : { budget: { maxBytes } }),
        ...(this.preparing || identity(path.join(this.home, 'ledger.sqlite')) !== this.ledgerIdentity
          ? { ledgerUnavailableReason: 'ledger_identity_changed' }
          : {}),
      });
      this.port.preparePublication(view);
      return view;
    } catch {
      return this.collector.current();
    } finally {
      if (this.port.publishing && [...this.port.sources.values()].some((source) => !source.writable))
        this.refreshPending = true;
      if (!this.tailPending) this.collecting = false;
      if (this.refreshPending && !this.collecting && !this.port.bounded)
        setImmediate(() => {
          void this.prepare();
        }).unref();
    }
  }
  close(): void {
    this.closed = true;
    this.watcher?.close();
    for (const watcher of this.sourceWatchers) watcher.close();
    this.collector.close();
    this.port.close();
  }
  static async open(
    env: Readonly<Record<string, string | undefined>> = process.env,
    ambientHome?: string,
    options: { publish?: boolean; boundedWorker?: boolean } = {}
  ): Promise<HudDelegationCollector | null> {
    const home = existingHudHome(env);
    if (!home) return null;
    const hasLedger = identity(path.join(home, 'ledger.sqlite')) !== null;
    if (options.publish === true && !hasLedger) return null;
    const publishing = options.publish === true && hasLedger;
    const sources = new Map<string, Source>();
    const codex = new CodexAdapter(undefined, true),
      claude = new ClaudeAdapter();
    const profiles: LaunchProfile[] = [];
    try {
      const config = JSON.parse(fs.readFileSync(path.join(home, 'delegate.json'), 'utf8'));
      if (config.version === 1 && Array.isArray(config.profiles)) profiles.push(...config.profiles.slice(0, 128));
    } catch {}
    let ambientSource: string | null = null;
    if (ambientHome)
      profiles.push({
        name: 'hud-observer',
        harness: 'codex',
        source: { root: ambientHome, label: 'Current Codex' },
        env: {},
        mcpServerName: 'hud',
      } as LaunchProfile);
    for (const profile of profiles) {
      if (
        !profile ||
        !['codex', 'claude'].includes(profile.harness) ||
        typeof profile.source?.root !== 'string' ||
        !path.isAbsolute(profile.source.root) ||
        !profile.env ||
        typeof profile.mcpServerName !== 'string'
      )
        continue;
      const adapter = profile.harness === 'codex' ? codex : claude;
      try {
        const sourceId = await adapter.resolveSource(profile, {});
        if (profile.name === 'hud-observer') ambientSource = sourceId;
        if (sources.has(sourceId)) continue;
        let store: ObservationStore | null = null;
        try {
          store = await openObservationStore({ hudHome: home, sourceId, readOnly: !publishing });
        } catch {}
        sources.set(sourceId, {
          adapter,
          root: fs.realpathSync(profile.source.root),
          writable: publishing && store !== null,
          ...(profile.harness === 'claude'
            ? { claudeFiles: new ClaudeTranscriptFiles(fs.realpathSync(profile.source.root), sourceId) }
            : {}),
          store,
          storeIdentity: store ? identity(store.databasePath) : null,
          storeSignature: '',
          storeDirty: true,
        });
      } catch {}
    }
    const port = new SessionCollection(sources, options.publish === true, options.boundedWorker === true);
    const reader = await openLinkLedgerReader(path.join(home, 'ledger.sqlite'));
    const collector = new LinkTickCollector(reader, home, loadLimits(home), port);
    return new HudDelegationCollector(home, collector, port, (id) =>
      ambientSource ? { harness: 'codex', sourceId: ambientSource, sessionId: id, threadId: null } : null
    );
  }
}

export { withDelegationObservation } from '../core/link/activity.js';
