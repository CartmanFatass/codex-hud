import { performance } from 'node:perf_hooks';
import { canonicalJson } from '../canonical.js';
import { capacityProjection } from '../capacity.js';
import type { LinkLedgerReader, LinkLedgerRead } from '../link-ledger-read.js';
import { displayNodeKey, projectFreshness, observationStampMismatch } from '../observation.js';
import { mergeStatus, STATUS_RULE_VERSION, type MergeResult, type LedgerStatusFact } from '../status/merge.js';
import type { DisplayNodeIdentity } from '../types/observation.js';
import type { LedgerEvent } from '../types/execution.js';
import type { SessionRef } from '../types/identity.js';
import type { ReaderBudget } from '../interfaces/harness-adapter.js';
import type { LaunchMessageLinkEvidence } from '../interfaces/session-evidence.js';
import { wakeProjection } from '../wake/projection.js';
import { projectLinkTree, linkStatusInput, committedReaderRate, committedReaderAction } from './index.js';
import { planLinkRead } from './read-plan.js';
import { reconcileDescriptor } from './actions.js';
import { LinkProjectionMemo } from './memo.js';
import type { LoadedLimits } from './limits.js';
import type { CollectedLinkHost, CollectedLinkSession, LinkTreeProjection } from './types.js';
import type { DelegationViewModel, DelegationNodeDetails } from './view-model.js';

export const LEDGER_SNAPSHOT_VALIDITY_MS = 5000;

export interface LinkCollectionPort {
  /** Owned snapshots never mutate their memo fields; replace the array on any change. */
  readonly immutableSnapshots?: boolean;
  /** Explicit production mode can observe real native roots even before the first delegation. */
  readonly publishesObservations?: boolean;
  invalidateSnapshots?(): void;
  /** Stable evidence retained from previous ticks, with zero current-tick charges. */
  begin?(deadline: number, scope?: string): void;
  /** Consume at most one recovery continuation for this ordinary opportunity. */
  takeContinuation?(scope: string, tree: LinkTreeProjection | null): { key: string | null } | null;
  discardContinuation?(): void;
  rejectContinuation?(): boolean;
  sessions(): readonly CollectedLinkSession[];
  /** Metadata-only invalidation. No body/topology reads on this call. */
  pending(ref: SessionRef, key?: string): 'session' | 'native_topology' | null;
  collect(
    ref: SessionRef,
    kind: 'session' | 'native_topology',
    budget: ReaderBudget,
    continuation?: boolean
  ): Promise<CollectedLinkSession | null>;
  takeUnattributedIO?(): { bytesRead: number; recordsRead: number };
  lineageCurrent?(ref: SessionRef): boolean;
  minimumBytes?: ReadonlyMap<string, number>;
}
export interface LinkTickInput {
  roots: readonly DisplayNodeIdentity[];
  ledgerUnavailableReason?: string;
  sessions?: readonly CollectedLinkSession[];
  hosts?: readonly CollectedLinkHost[];
  nowMs?: number;
  /** The caller's shared collection deadline, including earlier collection work. */
  deadline?: number;
  budget?: { maxNodes?: number; maxBytes?: number; maxCrossHarnessDepth?: number };
}
export interface LinkTickStats {
  totalMs: number;
  b9Ms: number;
  wiringMs: number;
  bytesRead: number;
  recordsRead: number;
  projected: boolean;
  ledgerReads: number;
  highWaterChecks: number;
  immediateMerges: number;
  regularVisits: number;
  continuationAttempts: number;
}

/** One retained read-only data path for both entry points. Creation/opening belongs to startup. */
export class LinkTickCollector {
  private ledger: LinkLedgerRead;
  private ledgerToken = '';
  private ledgerObservedAt: number | null = null;
  publicationLedgerObservedAt(): number | null {
    return this.ledgerObservedAt;
  }
  private launchKey = '';
  private memoKey = -1;
  private projectionMemo = new LinkProjectionMemo();
  private launchSnapshot: readonly CollectedLinkSession[] | null = null;
  private launchMessages: LaunchMessageLinkEvidence[] = [];
  private launchFingerprint = '';
  private indexedSnapshot: readonly CollectedLinkSession[] | null = null;
  private snapshotIndex = new Map<string, CollectedLinkSession>();
  private refKeys = new WeakMap<SessionRef, SessionRef & { key: string }>();
  private tree: LinkTreeProjection | null = null;
  private view: DelegationViewModel | null = null;
  private lastAvailableView: DelegationViewModel | null = null;
  private lastAvailableScope = '';
  private nextFreshnessAt = Infinity;
  private freshnessClock = -Infinity;
  private freshnessView: DelegationViewModel | null = null;
  private selectionMap: Record<string, string> = {};
  private cursor: string | undefined;
  private mergeCursor: string | undefined;
  private immediate = new Map<string, { key: string; result: MergeResult }>();
  private lastStats: LinkTickStats = {
    totalMs: 0,
    b9Ms: 0,
    wiringMs: 0,
    bytesRead: 0,
    recordsRead: 0,
    projected: false,
    ledgerReads: 0,
    highWaterChecks: 0,
    immediateMerges: 0,
    regularVisits: 0,
    continuationAttempts: 0,
  };
  constructor(
    private reader: LinkLedgerReader,
    private readonly home: string,
    private readonly limits: LoadedLimits,
    private readonly port?: LinkCollectionPort
  ) {
    this.ledger = { state: 'degraded', snapshot: null, reason: 'ledger_initializing' };
  }
  /** Explicit lifecycle operation; invoke outside an incremental tick, after an identity change only. */
  replaceReader(reader: LinkLedgerReader): void {
    this.reader.close();
    this.reader = reader;
    this.ledgerToken = '';
    this.ledgerObservedAt = null;
    this.memoKey = -1;
    this.port?.invalidateSnapshots?.();
    this.immediate.clear();
    this.selectionMap = {};
    this.ledger = { state: 'degraded', snapshot: null, reason: 'ledger_initializing' };
  }
  chargeAdditionalRead(bytesRead: number, recordsRead: number, elapsedMs: number): void {
    this.lastStats = {
      ...this.lastStats,
      bytesRead: this.lastStats.bytesRead + bytesRead,
      recordsRead: this.lastStats.recordsRead + recordsRead,
      totalMs: this.lastStats.totalMs + elapsedMs,
      wiringMs: this.lastStats.wiringMs + elapsedMs,
    };
  }
  stats(): Readonly<LinkTickStats> {
    return this.lastStats;
  }
  current(): DelegationViewModel | null {
    return this.view;
  }
  close(): void {
    this.reader.close();
  }

  private referenceKey(ref: SessionRef): string {
    const previous = this.refKeys.get(ref);
    if (
      previous &&
      previous.harness === ref.harness &&
      previous.sourceId === ref.sourceId &&
      previous.sessionId === ref.sessionId &&
      previous.threadId === ref.threadId
    )
      return previous.key;
    const key = displayNodeKey({ kind: 'session', ref });
    this.refKeys.set(ref, { ...ref, key });
    return key;
  }

  private availableFreshness(view: DelegationViewModel, nowMs: number): DelegationViewModel {
    if (view === this.freshnessView && nowMs >= this.freshnessClock && nowMs < this.nextFreshnessAt) return view;
    if (nowMs < this.freshnessClock || nowMs >= this.nextFreshnessAt) this.port?.invalidateSnapshots?.();
    this.freshnessClock = nowMs;
    this.nextFreshnessAt = Infinity;
    let changed = false;
    const details: Record<string, DelegationNodeDetails> = {};
    for (const [key, detail] of Object.entries(view.details)) {
      const original = view.tree.nodes.find((node) => node.key === key)?.observation?.statusProjection;
      if (detail.statusSource !== 'committed' || !original) {
        details[key] = detail;
        continue;
      }
      const freshness = projectFreshness(original.freshness.sources, original.freshness.requiredSourceIds, nowMs);
      for (const source of original.freshness.sources)
        if (source.deadlineAt !== null && source.deadlineAt >= nowMs)
          this.nextFreshnessAt = Math.min(this.nextFreshnessAt, source.deadlineAt + 1);
      if (
        detail.status?.freshness.state === freshness.state &&
        detail.status.freshness.reason === freshness.reason &&
        detail.status.freshness.staleSince === freshness.staleSince &&
        detail.status.freshness.clockAnomaly === freshness.clockAnomaly
      )
        details[key] = detail;
      else {
        details[key] = { ...detail, status: { ...original, freshness } };
        changed = true;
      }
    }
    this.freshnessView = changed ? { ...view, details } : view;
    return this.freshnessView;
  }

  private lastInput: LinkTickInput | null = null;
  private reportFacts = new Map<string, LedgerStatusFact>();
  private runEvents = new Map<string, LedgerEvent>();
  private runStateEvents = new Map<string, LedgerEvent>();
  publicationRunStateEvents(): ReadonlyMap<string, LedgerEvent> {
    return this.runStateEvents;
  }
  publicationRunEvents(): ReadonlyMap<string, LedgerEvent> {
    return this.runEvents;
  }
  publicationReportFacts(): ReadonlyMap<string, LedgerStatusFact> {
    return this.reportFacts;
  }
  /** Pure assembly of newly committed envelopes, using the exact retained ledger snapshot. */
  async refreshCommitted(changedKey?: string): Promise<DelegationViewModel | null> {
    const started = performance.now();
    const node = changedKey ? this.tree?.nodes.find((node) => node.key === changedKey) : null;
    const session = changedKey
      ? this.port?.sessions().find((session) => this.referenceKey(session.evidence.ref) === changedKey)
      : null;
    const summary = session?.evidence.observation;
    if (
      this.view &&
      this.tree &&
      node?.identity.kind === 'session' &&
      node.loaded &&
      node.observation?.statusProjection.observationStamp &&
      session?.loaded &&
      summary?.statusProjection.observationStamp &&
      !observationStampMismatch(
        {
          ref: node.identity.ref,
          sourceGeneration: session.sourceGeneration,
          ...(node.currentRun
            ? { runId: node.currentRun.runId, bindingGeneration: node.currentRun.expectedGeneration }
            : {}),
          asOfSeq: this.tree.ledger.asOfSeq,
        },
        summary.statusProjection.observationStamp
      ) &&
      node.observation.statusProjection.observationStamp.sourceGeneration === session.sourceGeneration &&
      JSON.stringify(node.observation.coverage) === JSON.stringify(summary.coverage) &&
      JSON.stringify(node.conflict) === JSON.stringify(summary.conflict)
    ) {
      // The same ledger/topology was already projected before paint. Only this committed observation changed.
      const rate = committedReaderRate(session, summary, Date.now(), this.tree.ledger.state === 'available');
      const action = committedReaderAction(session, summary, Date.now(), this.tree.ledger.state === 'available');
      this.tree = {
        ...this.tree,
        nodes: this.tree.nodes.map((value) =>
          value.key === changedKey
            ? { ...value, observation: summary, lastObservation: summary, committedRate: rate, committedAction: action }
            : value
        ),
      };
      this.view = {
        ...this.view,
        tree: this.tree,
        details: {
          ...this.view.details,
          [changedKey!]: {
            ...this.view.details[changedKey!],
            status: summary.statusProjection,
            statusSource: 'committed',
            observationUnavailableReason: null,
            outputRate: rate,
            action,
          },
        },
      };
      this.nextFreshnessAt = -Infinity;
      this.view = this.availableFreshness(this.view, Date.now());
      this.lastAvailableView = this.view;
      // A normal tick will fold this adopted observation together with its next native/ledger changes.
      this.memoKey = -1;
      const elapsed = performance.now() - started;
      this.lastStats = {
        ...this.lastStats,
        totalMs: this.lastStats.totalMs + elapsed,
        b9Ms: this.lastStats.b9Ms + elapsed,
      };
      return this.view;
    }
    if (!this.lastInput) return this.view;
    const previous = this.lastStats;
    const view = await this.assemble(this.lastInput, true);
    const refreshed = this.lastStats;
    this.lastStats = {
      ...previous,
      totalMs: previous.totalMs + refreshed.totalMs,
      b9Ms: previous.b9Ms + refreshed.b9Ms,
      wiringMs: previous.wiringMs + refreshed.wiringMs,
      projected: previous.projected || refreshed.projected,
    };
    return view;
  }
  async tick(input: LinkTickInput): Promise<DelegationViewModel | null> {
    return this.assemble(input, false);
  }
  private async assemble(input: LinkTickInput, projectionOnly: boolean): Promise<DelegationViewModel | null> {
    if (!projectionOnly) this.lastInput = input;
    const started = performance.now();
    const nowMs = input.nowMs ?? Date.now();
    const deadline = Math.min(input.deadline ?? started + 40, started + 40);
    const maxBytes = Math.min(8 * 1024 * 1024, input.budget?.maxBytes ?? 8 * 1024 * 1024);
    const stats: LinkTickStats = {
      totalMs: 0,
      b9Ms: 0,
      wiringMs: 0,
      bytesRead: 0,
      recordsRead: 0,
      projected: false,
      ledgerReads: 0,
      highWaterChecks: 0,
      immediateMerges: 0,
      regularVisits: 0,
      continuationAttempts: 0,
    };
    const finish = () => {
      stats.totalMs = performance.now() - started;
      stats.wiringMs = Math.max(0, stats.totalMs - stats.b9Ms);
      this.lastStats = stats;
      if (this.view && this.ledger.state === 'available') {
        this.lastAvailableView = this.view;
        this.lastAvailableScope = JSON.stringify([input.roots, input.budget ?? {}]);
      }
      return this.view;
    };
    const rejectContinuation = () => {
      if (!projectionOnly && this.port?.rejectContinuation?.()) stats.continuationAttempts++;
    };
    if (!projectionOnly && performance.now() >= deadline) rejectContinuation();
    let retained = input.sessions ?? this.port?.sessions() ?? [];
    const immutableSnapshots = !input.sessions && this.port?.immutableSnapshots === true;
    if (!immutableSnapshots || retained !== this.launchSnapshot) {
      this.launchMessages = retained.flatMap((s) =>
        s.evidence.linkEvidence.filter((e): e is LaunchMessageLinkEvidence => e.kind === 'launch_message')
      );
      this.launchFingerprint = canonicalJson(this.launchMessages);
      this.launchSnapshot = immutableSnapshots ? retained : null;
    }
    const messages = this.launchMessages;
    const launches = this.launchFingerprint;
    let b9Start = performance.now();
    const token = projectionOnly ? this.ledgerToken : (input.ledgerUnavailableReason ?? this.reader.changeToken());
    if (!projectionOnly && !input.ledgerUnavailableReason) stats.highWaterChecks++;
    if (
      !projectionOnly &&
      (token !== this.ledgerToken || launches !== this.launchKey || this.ledger.state === 'degraded')
    ) {
      this.ledger = input.ledgerUnavailableReason
        ? { state: 'degraded', snapshot: null, reason: input.ledgerUnavailableReason }
        : this.reader.read(messages);
      this.ledgerObservedAt = this.ledger.state === 'available' ? nowMs : null;
      if (!input.ledgerUnavailableReason) stats.ledgerReads++;
      this.ledgerToken = token;
      this.launchKey = launches;
    }
    stats.b9Ms += performance.now() - b9Start;
    if (this.ledger.state === 'degraded') this.port?.invalidateSnapshots?.();
    if (
      this.ledger.state === 'degraded' &&
      this.ledger.reason === 'ledger_busy' &&
      this.lastAvailableView &&
      this.lastAvailableScope === JSON.stringify([input.roots, input.budget ?? {}])
    ) {
      rejectContinuation();
      const prior = this.lastAvailableView;
      const tree = {
        ...prior.tree,
        ledger: { ...prior.tree.ledger, state: 'degraded' as const, reason: 'ledger_busy' },
        coverage: {
          ...prior.tree.coverage,
          state: 'partial' as const,
          reason: 'ledger_busy',
          gaps: [...new Set([...prior.tree.coverage.gaps, 'ledger_busy'])],
        },
        nodes: prior.tree.nodes.map((node) => ({
          ...node,
          host: node.host ? { ...node.host, state: 'unknown' as const, currentState: null } : null,
        })),
        relations: prior.tree.relations.map((relation) => ({
          ...relation,
          host: { ...relation.host, state: 'unknown' as const, currentState: null },
        })),
      };
      this.view = this.availableFreshness(
        {
          ...prior,
          tree,
          capacity: null,
          details: Object.fromEntries(
            Object.entries(prior.details).map(([key, detail]) => [
              key,
              { ...detail, wake: null, wakeUnavailableReason: 'ledger_busy', reconcile: null },
            ])
          ),
        },
        nowMs
      );
      this.memoKey = -1;
      return finish();
    }
    if (this.ledger.state === 'available' && !this.ledger.snapshot.links.length && !this.port?.publishesObservations) {
      rejectContinuation();
      this.view = null;
      return finish();
    }
    const scope =
      this.ledger.state === 'available'
        ? canonicalJson([input.roots, input.budget ?? {}, this.ledgerToken, this.ledger.snapshot.ledgerId, launches])
        : undefined;
    if (!projectionOnly) this.port?.begin?.(deadline, scope);
    retained = input.sessions ?? this.port?.sessions() ?? [];
    if (!immutableSnapshots || retained !== this.indexedSnapshot) {
      this.snapshotIndex = new Map(retained.map((s) => [displayNodeKey({ kind: 'session', ref: s.evidence.ref }), s]));
      this.indexedSnapshot = immutableSnapshots ? retained : null;
    }
    let unique = this.snapshotIndex;
    let didCollect = false;
    if (!projectionOnly && this.port && performance.now() >= deadline) rejectContinuation();
    // Scheduling metadata only. planLinkRead remains the single grant authority, including the retained fair cursor.
    if (!projectionOnly && this.port && performance.now() < deadline) {
      const refs = new Map<string, SessionRef>();
      for (const root of input.roots) if (root.kind === 'session') refs.set(this.referenceKey(root.ref), root.ref);
      for (const node of this.tree?.nodes ?? [])
        if (node.identity.kind === 'session' && node.crossHarnessDepth <= (input.budget?.maxCrossHarnessDepth ?? 4))
          refs.set(this.referenceKey(node.identity.ref), node.identity.ref);
      const orderedRefs = [...refs].slice(0, Math.min(200, input.budget?.maxNodes ?? 200));
      const eligible = [];
      for (const [key, ref] of orderedRefs) {
        const kind = this.port.pending(ref, key);
        if (kind)
          eligible.push({
            key,
            identity: { kind: 'session' as const, ref },
            reason: kind === 'session' ? 'unloaded' : 'native_topology',
          });
      }
      const charged = retained.reduce((sum, s) => sum + s.bytesRead + (s.topology?.bytesRead ?? 0), 0);
      const schedulingTree = {
        ...this.tree,
        nodes: orderedRefs.map(([key]) => ({ key })),
        continuation: eligible,
        io: { remainingBytes: Math.max(0, maxBytes - charged), exceeded: charged > maxBytes },
      } as LinkTreeProjection;
      const offer = scope ? this.port.takeContinuation?.(scope, this.tree) : null;
      const continuationKey = offer?.key ?? undefined;
      if (offer) stats.continuationAttempts++;
      const plan = planLinkRead(schedulingTree, {
        remainingMs: Math.max(0, Math.floor(deadline - performance.now())),
        afterKey: this.cursor,
        minimumBytes: this.port.minimumBytes,
        continuationKey,
      });
      if (!plan.target || !plan.continuation) this.port.discardContinuation?.();
      if (plan.target) {
        didCollect = true;
        unique = new Map(unique);
        if (!plan.continuation) {
          this.cursor = plan.nextCursor;
          stats.regularVisits++;
        }
        const read = await this.port.collect(plan.target.ref, plan.target.kind, plan.budget, plan.continuation);
        if (read) {
          const previous = unique.get(plan.target.key);
          unique.set(plan.target.key, {
            ...read,
            bytesRead: read.bytesRead + (previous?.bytesRead ?? 0),
            recordsRead: read.recordsRead + (previous?.recordsRead ?? 0),
            ...(read.topology
              ? {
                  topology: {
                    ...read.topology,
                    bytesRead: read.topology.bytesRead + (previous?.topology?.bytesRead ?? 0),
                    recordsRead: read.topology.recordsRead + (previous?.topology?.recordsRead ?? 0),
                  },
                }
              : {}),
          });
        }
        // Source-scoped topology discovery may update other envelopes without re-reading them.
        for (const envelope of this.port.sessions()) {
          const key = displayNodeKey({ kind: 'session', ref: envelope.evidence.ref });
          if (key === plan.target.key) continue;
          const previous = unique.get(key);
          unique.set(key, {
            ...envelope,
            bytesRead: previous?.bytesRead ?? 0,
            recordsRead: previous?.recordsRead ?? 0,
            ...(envelope.topology
              ? {
                  topology: {
                    ...envelope.topology,
                    bytesRead: previous?.topology?.bytesRead ?? 0,
                    recordsRead: previous?.topology?.recordsRead ?? 0,
                  },
                }
              : {}),
          });
        }
      }
    }
    const sessions =
      !didCollect && immutableSnapshots && unique.size === retained.length ? retained : [...unique.values()];
    const extraIO = this.port?.takeUnattributedIO?.() ?? { bytesRead: 0, recordsRead: 0 };
    stats.bytesRead = extraIO.bytesRead + sessions.reduce((n, s) => n + s.bytesRead + (s.topology?.bytesRead ?? 0), 0);
    stats.recordsRead =
      extraIO.recordsRead + sessions.reduce((n, s) => n + s.recordsRead + (s.topology?.recordsRead ?? 0), 0);
    const ledgerKey =
      this.ledger.state === 'available'
        ? [this.ledger.snapshot.ledgerId, this.ledger.snapshot.asOfSeq, this.ledgerToken]
        : [this.ledger.reason];
    const keyOf = () =>
      this.projectionMemo.key(
        ledgerKey,
        sessions,
        input.hosts ?? [],
        input.roots,
        input.budget ?? {},
        this.selectionMap,
        immutableSnapshots
      );
    const memo = keyOf();
    if (memo !== this.memoKey) {
      b9Start = performance.now();
      this.tree = projectLinkTree({
        ledger: this.ledger,
        roots: input.roots,
        sessions,
        hosts: input.hosts,
        nowMs,
        budget: input.budget,
        selectionMap: this.selectionMap,
      });
      this.tree.io = {
        ...this.tree.io,
        bytesRead: stats.bytesRead,
        recordsRead: stats.recordsRead,
        remainingBytes: Math.max(0, maxBytes - stats.bytesRead),
        exceeded: stats.bytesRead > maxBytes,
      };
      stats.b9Ms += performance.now() - b9Start;
      stats.projected = true;
      this.selectionMap = this.tree.selectionMap;
      this.memoKey = keyOf();
      this.view = {
        tree: this.tree,
        capacity:
          this.ledger.state === 'available'
            ? capacityProjection(
                this.ledger.snapshot.runs,
                this.ledger.snapshot.links,
                input.roots.find(
                  (root): root is Extract<DisplayNodeIdentity, { kind: 'session' }> => root.kind === 'session'
                )?.ref ?? null,
                this.limits.limits
              )
            : null,
        limits: this.limits,
        details: {},
        pendingStatus: 0,
      };
    }
    if (!this.view || !this.tree) return finish();
    if (!stats.projected && this.view.pendingStatus === 0) {
      this.view = this.availableFreshness(this.view, nowMs);
      return finish();
    }
    const details: Record<string, DelegationNodeDetails> = {};
    const snapshot = this.ledger.state === 'available' ? this.ledger.snapshot : null;
    const events = snapshot?.events ?? [];
    const reports = new Map<string, typeof snapshot extends null ? never : NonNullable<typeof snapshot>['reports']>();
    this.reportFacts = new Map();
    this.runEvents = new Map();
    this.runStateEvents = new Map();
    for (const event of events)
      if (event.runId && ['run.state', 'run.terminal'].includes(event.kind))
        this.runStateEvents.set(event.runId, event);
    for (const event of events)
      if (event.runId && ['run.state', 'run.terminal', 'run.reconciliation'].includes(event.kind))
        this.runEvents.set(event.runId, event);
    const reportsById = new Map(snapshot?.reports.map((r) => [r.reportId, r]));
    for (const event of events)
      if (event.kind === 'report.received' && typeof event.payload.reportId === 'string') {
        const report = reportsById.get(event.payload.reportId);
        if (report && report.runId === event.runId && report.linkId === event.linkId) {
          this.reportFacts.set(report.reportId, {
            id: `report:${report.reportId}`,
            value: { report },
            seq: event.seq,
            eventAt: report.createdAt,
            observedAt: this.ledgerObservedAt!,
            deadlineAt: this.ledgerObservedAt! + LEDGER_SNAPSHOT_VALIDITY_MS,
          });
          const list = reports.get(report.runId) ?? [];
          list.push(report);
          reports.set(report.runId, list);
        }
      }
    const mergeStarted = performance.now();
    let pendingStatus = 0;
    const previousMergeIndex = this.tree.nodes.findIndex((node) => node.key === this.mergeCursor);
    const mergeNodes = [
      ...this.tree.nodes.slice(previousMergeIndex + 1),
      ...this.tree.nodes.slice(0, previousMergeIndex + 1),
    ];
    for (const node of mergeNodes) {
      const run = node.currentRun;
      const history = run ? (reports.get(run.runId) ?? []) : [];
      let status = node.observation?.statusProjection.observationStamp ? node.observation.statusProjection : null;
      let statusSource: DelegationNodeDetails['statusSource'] = status ? 'committed' : 'unavailable';
      if (
        !status &&
        run &&
        (node.identity.kind === 'delegationIntent' ||
          (node.identity.kind === 'session' &&
            unique.has(node.key) &&
            this.port?.lineageCurrent?.(node.identity.ref) !== false))
      ) {
        const sourceGeneration = unique.get(node.key)?.sourceGeneration;
        const cacheKey = canonicalJson([
          node.key,
          run.runId,
          this.tree.ledger.asOfSeq,
          sourceGeneration ?? null,
          run.expectedGeneration,
          node.lastObservation?.evidenceStamp ?? null,
          node.conflict,
        ]);
        let cached = this.immediate.get(node.key);
        if (
          cached?.key !== cacheKey &&
          stats.immediateMerges < 20 &&
          performance.now() - mergeStarted < 5 &&
          performance.now() < deadline
        ) {
          const facts: LedgerStatusFact[] = [
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
              observedAt: nowMs,
              deadlineAt: null,
            },
          ];
          const report = history.at(-1);
          if (report) {
            const event = events.find(
              (e) =>
                e.kind === 'report.received' &&
                e.payload.reportId === report.reportId &&
                e.runId === run.runId &&
                e.linkId === run.linkId
            )!;
            facts.push({
              id: `report:${report.reportId}`,
              value: { report },
              seq: event.seq,
              eventAt: report.createdAt,
              observedAt: nowMs,
              deadlineAt: null,
            });
          }
          const result = mergeStatus(
            {
              ...linkStatusInput(this.tree, node.key),
              target:
                node.identity.kind === 'delegationIntent'
                  ? { nodeIdentity: node.identity, runId: run.runId }
                  : {
                      nodeIdentity: node.identity as Extract<DisplayNodeIdentity, { kind: 'session' }>,
                      sourceGeneration: sourceGeneration!,
                      runId: run.runId,
                      bindingGeneration: run.expectedGeneration,
                    },
              sources: [],
              ledgerFacts: facts,
              observationStamp: null,
              history: { continuity: cached ? 'proven' : 'unknown' },
            },
            cached?.result.continuity ?? null,
            STATUS_RULE_VERSION,
            nowMs
          );
          cached = { key: cacheKey, result };
          this.immediate.set(node.key, cached);
          stats.immediateMerges++;
          this.mergeCursor = node.key;
        }
        if (cached?.key === cacheKey) {
          status = cached.result.projection;
          statusSource = 'ledger';
        } else pendingStatus++;
      }
      const relation = this.tree.relations.find(
        (r) => node.links.includes(r.link.linkId) && r.currentRun?.runId === run?.runId
      );
      const wakeState =
        relation && this.ledger.state === 'available' ? this.ledger.wakeStates?.get(relation.link.linkId) : undefined;
      let reconcile = null;
      if (run && (run.state === 'uncertain' || node.conflict || node.execution.reconciliation)) {
        try {
          reconcile = reconcileDescriptor(this.home, run.linkId, run.runId);
        } catch {}
      }
      details[node.key] = {
        ...(node.committedRate ? { outputRate: node.committedRate } : {}),
        ...(node.committedAction ? { action: node.committedAction } : {}),
        status,
        statusSource,
        latestReportForRun: history.at(-1) ?? null,
        reportHistory: history,
        parentOffline: relation?.parentOffline ?? null,
        wake:
          wakeState === undefined
            ? null
            : {
                ...wakeProjection(wakeState, this.home, run?.runId ?? '', 0).wake,
                attempts:
                  this.ledger.state === 'available'
                    ? (this.ledger.wakeAttempts?.get(relation!.link.linkId) ?? null)
                    : null,
              },
        wakeUnavailableReason: wakeState === undefined && relation ? 'wake_validation_unavailable' : null,
        observationUnavailableReason: status ? null : 'committed_observation_unavailable',
        reconcile,
        resumable: { resumable: false, reason: 'capability_unverified', subject: 'local_user' },
      };
    }
    for (const key of this.immediate.keys()) if (!details[key]) this.immediate.delete(key);
    this.view = { ...this.view, details, pendingStatus };
    this.nextFreshnessAt = -Infinity;
    this.view = this.availableFreshness(this.view, nowMs);
    return finish();
  }
}
