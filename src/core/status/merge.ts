import type { ObservationBoundary } from '../checkpoint.js';
import { isRunTerminal } from '../execution.js';
import { sameSessionRef } from '../identity.js';
import { displayNodeKey, observationStampMismatch, projectFreshness, resolveStateContinuity } from '../observation.js';
import type { ExitSource, RunState } from '../types/execution.js';
import type { Link, Report, RunHandshake } from '../types/lifecycle.js';
import type {
  Activity,
  FreshnessSource,
  LastTurnOutcome,
  Liveness,
  NoticeEvent,
  ObservationEvidence,
  ObservationStamp,
  PendingReason,
  RegistryObservation,
  StateContinuity,
  StatusProjection,
} from '../types/observation.js';

export { isRunTerminal } from '../execution.js';

export type Dimension = 'activity' | 'pendingReason' | 'lastTurnOutcome' | 'liveness';
export type SemanticClass =
  | 'conflict'
  | 'uncertain'
  | 'pending'
  | 'failed'
  | 'interrupted'
  | 'stale'
  | 'working'
  | 'starting'
  | 'exited'
  | 'idle'
  | 'unknown';

/** Facts are already parsed/validated by their source, never OS or transcript I/O. */
export interface StatusFacts {
  activity?: Activity;
  pendingReason?: PendingReason;
  /** A none from another source resolves only the named pending episode, at/after its opening. */
  pendingResolution?: { episodeAnchor: string; eventAt: number };
  lastTurnOutcome?: LastTurnOutcome;
  liveness?: Liveness;
  registry?: RegistryObservation;
  /** An open call supports working only through this caller-supplied deadline. */
  openTool?: { id: string; startedAt: number; lastActivityAt: number; deadlineAt: number | null };
  heartbeatAt?: number | null;
  run?: { runId: string; state: RunState; reason?: string | null };
  report?: Pick<Report, 'reportId' | 'runId' | 'status' | 'createdAt'>;
  /** Only an independently verified native harness result, never shellStatus. */
  nativeExit?: { code: number | null; signal: string | null; source: ExitSource | null } | null;
  /** Private diagnostic only; never used to infer a native result. */
  shellStatus?: number | null;
  /** Episode identities (approval id, turn id, etc.) must survive repeated reads. */
  episodes?: Partial<Record<Dimension | 'run', string>>;
}

export interface StatusSource {
  id: string;
  /** For origin=report, seq is the report.received ledger sequence, not a native/observation cursor. */
  evidence: ObservationEvidence & { value: StatusFacts };
  deadlineAt: number | null;
  error?: string;
  clockAnomaly?: boolean;
}

type Target =
  | {
      nodeIdentity: Extract<StateContinuity['nodeIdentity'], { kind: 'session' }>;
      sourceGeneration: number;
      runId?: string;
      bindingGeneration?: number;
    }
  | {
      nodeIdentity: Extract<StateContinuity['nodeIdentity'], { kind: 'delegationIntent' }>;
      runId: string;
      bindingGeneration?: number;
      sourceGeneration?: never;
    };

/** Persist with continuity and the edges in the later atomic publish step. */
export interface NoticeState {
  pendingReason: PendingReason;
  lastTurnOutcome: LastTurnOutcome;
  runState: RunState | null;
  identityKey: string;
  inputStamps: string[];
  /** Aliases for the same entering event before/after an episode ID is learned. */
  eventStamps?: string[];
  /** Ledger report.received domain only; optional for pure synthetic callers. */
  reportSeq?: number | null;
}

/** No ref is fabricated for an unbound intent; its publisher uses the ledger identity. */
export type NoticeEdge = Omit<NoticeEvent, 'seq' | 'seqDomain' | 'ref'> & {
  nodeIdentity: Target['nodeIdentity'];
};

export interface LedgerStatusFact {
  id: string;
  value: StatusFacts;
  eventAt: number | null;
  observedAt: number;
  seq?: number;
  evidenceId?: string;
  deadlineAt: number | null;
}

export interface MergeInput {
  target: Target;
  sources: readonly StatusSource[];
  /** Same ledger snapshot as asOfSeq; independent of any rejected cached observation. */
  ledgerFacts?: readonly LedgerStatusFact[];
  asOfSeq: number | null;
  observationStamp: ObservationStamp | null;
  /** Already selected by lifecycle 03; this does not recompute binding/resume gates. */
  link?: Pick<Link, 'linkId' | 'state'>;
  runHandshake?: RunHandshake;
  /** Captured from the same ReaderResult as these facts; shared G05 type, no copy. */
  boundary?: ObservationBoundary;
  requiredSourceIds?: readonly string[];
  conflict?: { count: number; recordIds: string[]; since: number } | null;
  history: {
    continuity: 'proven' | 'first_observation' | 'unknown';
    gap?: boolean;
    /** Explicit proof of the entering event under the new rule/reading lineage. */
    rebuildFromEvent?: boolean;
  };
  /** Proof required when a ledger intent becomes a real session. */
  intentBinding?: { linkId: string; runId: string; ref: ObservationStamp['ref']; episodeAnchor: string };
  noticeState?: NoticeState | null;
}

export interface MergeResult {
  projection: StatusProjection;
  semanticClass: SemanticClass;
  reason: string;
  selectedSources: Record<Dimension, string | null>;
  conflict: MergeInput['conflict'];
  continuity: StateContinuity;
  notices: NoticeEdge[];
  noticeState: NoticeState;
  unavailableReasons: { sourceId: string; reason: string }[];
  boundary: ObservationBoundary | null;
}

type FactSource = Pick<StatusSource, 'id' | 'deadlineAt' | 'error' | 'clockAnomaly'> & {
  evidence: Pick<
    ObservationEvidence,
    'origin' | 'eventAt' | 'observedAt' | 'lastSuccessfulReadAt' | 'validity' | 'seq' | 'evidenceId' | 'reason'
  > & { value: StatusFacts };
};
interface Candidate<T> {
  value: T;
  source: FactSource;
  eventAt: number | null;
  episode: string | null;
  rank: number;
}
const timeValid = (at: number | null | undefined): at is number => at != null && Number.isFinite(at) && at >= 0;
const minTime = (times: (number | null | undefined)[]): number | null => {
  const valid = times.filter(timeValid);
  return valid.length ? Math.min(...valid) : null;
};
const maxTime = (times: (number | null | undefined)[]): number | null => {
  const valid = times.filter(timeValid);
  return valid.length ? Math.max(...valid) : null;
};
const eventIdentity = (source: FactSource): string => {
  const e = source.evidence;
  return e.seq !== undefined
    ? JSON.stringify([e.origin, source.id, e.seq])
    : JSON.stringify([e.origin, source.id, e.evidenceId ?? null, e.eventAt ?? e.observedAt]);
};
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The sole semantic order; no visual glyph, colour, sorting bucket or child state. */
function classify(
  p: Pick<StatusProjection, 'activity' | 'pendingReason' | 'lastTurnOutcome' | 'liveness' | 'freshness'>,
  run: StatusFacts['run'] | undefined,
  report: StatusFacts['report'] | undefined,
  conflict: MergeInput['conflict'],
  unconfirmedIntent: boolean
): [SemanticClass, string] {
  if (conflict && conflict.count > 0) return ['conflict', 'contradictory_evidence'];
  if (run?.state === 'uncertain') return ['uncertain', run.reason ?? 'unknown'];
  if (p.pendingReason !== 'none' || report?.status === 'blocked')
    return ['pending', report?.status === 'blocked' ? 'blocked' : p.pendingReason];
  if (run?.state === 'failed') return ['failed', 'launch_failed'];
  if (p.lastTurnOutcome === 'failed') return ['failed', 'turn_failed'];
  if (run?.state === 'cancelling' || run?.state === 'cancelled') return ['interrupted', run.state];
  if (p.lastTurnOutcome === 'interrupted' || report?.status === 'interrupted') return ['interrupted', 'interrupted'];
  if (p.freshness.state !== 'fresh') return ['stale', p.freshness.reason ?? 'required_source_unavailable'];
  if (p.activity === 'working') return ['working', 'working'];
  if (run?.state === 'starting' || (unconfirmedIntent && p.activity === 'unknown')) return ['starting', 'starting'];
  if (report?.status === 'completed') return ['exited', 'reported'];
  if ((run && isRunTerminal(run)) || p.liveness === 'gone' || p.activity === 'exited')
    return ['exited', run ? 'ended' : 'exited'];
  if (p.activity === 'idle' || p.activity === 'waiting_input') return ['idle', 'idle'];
  return ['unknown', 'insufficient_evidence'];
}

/**
 * Pure, synchronous merger. Inputs are immutable by convention and never mutated.
 * asOfSeq, commitSeq and notice sequences are separate domains: no cross-domain ordering.
 */
export function mergeStatus(
  input: MergeInput,
  previous: StateContinuity | null,
  ruleVersion: string,
  nowMs: number
): MergeResult {
  const { target } = input;
  if (target.nodeIdentity.kind === 'delegationIntent' && input.link && target.nodeIdentity.linkId !== input.link.linkId)
    throw new TypeError('relation_link_mismatch');
  if (!ruleVersion || !Number.isFinite(nowMs) || nowMs < 0) throw new TypeError('invalid_merge_clock_or_rule');
  if (
    new Set([...input.sources, ...(input.ledgerFacts ?? [])].map((s) => s.id)).size !==
    input.sources.length + (input.ledgerFacts?.length ?? 0)
  )
    throw new TypeError('duplicate_status_source');
  // These are all ledger event sequences. Observation/notice sequences never enter this check.
  const ledgerSequences = [
    ...(input.ledgerFacts ?? []).map((fact) => fact.seq),
    ...input.sources
      .filter((source) => source.evidence.origin === 'ledger' || source.evidence.origin === 'report')
      .map((source) => source.evidence.seq),
  ].filter((seq): seq is number => seq !== undefined);
  if (
    (input.asOfSeq !== null && (!Number.isSafeInteger(input.asOfSeq) || input.asOfSeq < 0)) ||
    ledgerSequences.some(
      (seq) => !Number.isSafeInteger(seq) || seq < 0 || input.asOfSeq === null || seq > input.asOfSeq
    )
  )
    throw new TypeError('invalid_ledger_snapshot');
  const session = target.nodeIdentity.kind === 'session' ? target.nodeIdentity : null;
  let stampReason: string | null = null;
  if (input.observationStamp) {
    stampReason = session
      ? observationStampMismatch(
          {
            ref: session.ref,
            runId: target.runId,
            bindingGeneration: target.bindingGeneration,
            sourceGeneration: target.sourceGeneration!,
            asOfSeq: input.asOfSeq,
          },
          input.observationStamp
        )
      : 'intent_has_no_observation_commit';
  }
  if (
    input.boundary &&
    (!session ||
      !sameSessionRef(input.boundary.ref, session.ref) ||
      input.boundary.sourceGeneration !== target.sourceGeneration)
  )
    throw new TypeError('observation_boundary_mismatch');

  const unavailableReasons: MergeResult['unavailableReasons'] = [];
  const sources = [...input.sources].sort((a, b) => compareText(a.id, b.id));
  const freshnessSources: FreshnessSource[] = [];
  const matching: FactSource[] = [];
  for (const source of sources) {
    const e = source.evidence;
    let reason: string | null = null;
    if (e.origin === 'ledger') {
      if (
        target.nodeIdentity.kind !== 'delegationIntent' ||
        e.nodeIdentity.linkId !== target.nodeIdentity.linkId ||
        e.currentRunId !== target.runId
      )
        reason = 'ledger_identity_mismatch';
    } else if (!session || !sameSessionRef(e.ref, session.ref)) reason = 'ref_mismatch';
    else if (e.runId !== target.runId) reason = 'run_mismatch';
    else if (e.sourceGeneration !== target.sourceGeneration) reason = 'source_generation_mismatch';
    else if (e.bindingGeneration !== target.bindingGeneration) reason = 'binding_generation_mismatch';
    if (e.origin !== 'ledger' && stampReason) reason = stampReason;
    if (
      e.value.registry &&
      (!session || !e.value.registry.occupant || !sameSessionRef(e.value.registry.occupant, session.ref))
    )
      reason = 'registry_occupant_mismatch';
    if (e.value.run && e.value.run.runId !== target.runId) reason = 'run_mismatch';
    if (e.value.report && e.value.report.runId !== target.runId) reason = 'report_run_mismatch';
    if (reason) unavailableReasons.push({ sourceId: source.id, reason });
    const heartbeat = e.value.heartbeatAt;
    const deadlineAt =
      heartbeat !== undefined
        ? timeValid(heartbeat) && timeValid(source.deadlineAt)
          ? Math.min(heartbeat + 30000, source.deadlineAt)
          : null
        : e.value.openTool
          ? e.value.openTool.deadlineAt === null || source.deadlineAt === null
            ? null
            : Math.min(e.value.openTool.deadlineAt, source.deadlineAt)
          : source.deadlineAt;
    freshnessSources.push({
      id: source.id,
      validity: reason ? 'unknown' : e.validity,
      lastEvidenceAt: heartbeat !== undefined ? heartbeat : (e.eventAt ?? e.observedAt),
      observedAt: e.observedAt,
      lastSuccessfulReadAt: e.lastSuccessfulReadAt,
      deadlineAt,
      ...(source.error ? { error: source.error } : {}),
      ...(reason || e.reason ? { reason: reason ?? e.reason } : {}),
      ...(source.clockAnomaly ? { clockAnomaly: true } : {}),
    });
    if (!reason) matching.push(source);
  }
  for (const fact of input.ledgerFacts ?? []) {
    if (
      !target.runId ||
      (fact.value.run && fact.value.run.runId !== target.runId) ||
      (fact.value.report && fact.value.report.runId !== target.runId)
    ) {
      unavailableReasons.push({ sourceId: fact.id, reason: 'ledger_run_mismatch' });
      continue;
    }
    const source: FactSource = {
      id: fact.id,
      deadlineAt: fact.deadlineAt,
      evidence: {
        origin: 'ledger',
        value: fact.value,
        eventAt: fact.eventAt,
        observedAt: fact.observedAt,
        lastSuccessfulReadAt: fact.observedAt,
        validity: 'current',
        ...(fact.seq === undefined ? {} : { seq: fact.seq }),
        ...(fact.evidenceId ? { evidenceId: fact.evidenceId } : {}),
      },
    };
    matching.push(source);
    freshnessSources.push({
      id: fact.id,
      validity: 'current',
      lastEvidenceAt: fact.eventAt ?? fact.observedAt,
      observedAt: fact.observedAt,
      lastSuccessfulReadAt: fact.observedAt,
      deadlineAt: fact.deadlineAt,
    });
  }
  matching.sort((a, b) => compareText(a.id, b.id));
  freshnessSources.sort((a, b) => compareText(a.id, b.id));
  const sourceFreshness = (s: FactSource) => projectFreshness(freshnessSources, [s.id], nowMs);
  const current = matching.filter((s) => s.evidence.validity === 'current' && sourceFreshness(s).state === 'fresh');
  // Durable run/report/result facts survive a transport deadline. They never prove process termination.
  const factual = matching.filter((s) => s.evidence.validity === 'current' || s.evidence.validity === 'stale');
  const byFactTime = (a: FactSource, b: FactSource) =>
    (b.evidence.eventAt ?? b.evidence.observedAt) - (a.evidence.eventAt ?? a.evidence.observedAt) ||
    compareText(a.id, b.id);
  const runSource = factual
    .filter((s) => s.evidence.value.run)
    .sort(
      (a, b) => Number(b.evidence.origin === 'ledger') - Number(a.evidence.origin === 'ledger') || byFactTime(a, b)
    )[0];
  const run = runSource?.evidence.value.run;
  // All report seq values here are ledger event seq values, never observation commits.
  const reportSources = factual
    .filter((s) => s.evidence.value.report && (s.evidence.origin === 'ledger' || s.evidence.origin === 'report'))
    .sort((a, b) => (b.evidence.seq ?? -1) - (a.evidence.seq ?? -1) || byFactTime(a, b));
  const reportSource = reportSources[0];
  const report = reportSource?.evidence.value.report;
  const candidates: { [D in Dimension]: Candidate<StatusProjection[D]>[] } = {
    activity: [],
    pendingReason: [],
    lastTurnOutcome: [],
    liveness: [],
  };
  function add<D extends Dimension>(
    d: D,
    value: StatusProjection[D] | undefined,
    s: FactSource,
    rank: number,
    eventAt = s.evidence.eventAt,
    episode: string | null = s.evidence.value.episodes?.[d] ?? null
  ) {
    if (value !== undefined) candidates[d].push({ value, source: s, rank, eventAt, episode } as never);
  }
  for (const s of current) {
    const e = s.evidence,
      f = e.value;
    const registry = f.registry;
    let activity = registry?.activity ?? f.activity;
    if (f.openTool) {
      if (timeValid(f.openTool.deadlineAt) && nowMs <= f.openTool.deadlineAt) activity = 'working';
      else if (activity === 'working' || activity === undefined) activity = 'unknown';
    }
    if (activity !== 'unknown')
      add(
        'activity',
        activity,
        s,
        e.origin === 'registry' ? 0 : e.origin === 'transcript' ? 1 : 2,
        f.openTool?.startedAt ?? e.eventAt
      );
    const pending = registry?.pendingReason ?? f.pendingReason;
    add(
      'pendingReason',
      pending,
      s,
      e.origin === 'transcript' ? 0 : 1,
      pending === 'none' ? (f.pendingResolution?.eventAt ?? e.eventAt) : e.eventAt
    );
    if (f.liveness !== 'unknown') add('liveness', f.liveness, s, e.origin === 'supervisor' ? 0 : 1);
    if (timeValid(f.heartbeatAt)) add('liveness', 'alive', s, 0, f.heartbeatAt);
  }
  for (const s of factual) {
    const f = s.evidence.value;
    if (f.lastTurnOutcome !== 'none' || current.includes(s))
      add('lastTurnOutcome', f.lastTurnOutcome, s, s.evidence.origin === 'transcript' ? 0 : 1);
    if (
      f.nativeExit?.source &&
      ((f.nativeExit.code !== null && f.nativeExit.code !== 0) || f.nativeExit.signal !== null)
    )
      add('lastTurnOutcome', 'failed', s, 0);
    if (s === reportSource && report) {
      if (report.status === 'blocked')
        add('pendingReason', 'needs_human', s, -1, report.createdAt, `report:${report.reportId}`);
      else add('lastTurnOutcome', report.status, s, 1, report.createdAt, `report:${report.reportId}`);
    }
    // completionSeq is an outcome observation, never an ongoing busy signal.
    const r = f.registry;
    if (r?.completionSeq != null)
      add('lastTurnOutcome', 'completed', s, 2, r.sourceClockAt, `completion:${r.completionSeq}`);
  }
  if (runSource && run && (run.state === 'ended' || run.state === 'cancelled')) {
    add('activity', 'exited', runSource, 3);
    add('liveness', 'gone', runSource, -1);
  }
  const resolutionSources = new Set<string>();
  function pick<D extends Dimension>(d: D): Candidate<StatusProjection[D]> | null {
    let list = candidates[d];
    if (d === 'pendingReason') {
      const pending = candidates.pendingReason.filter((c) => c.value !== 'none');
      const resolvers = new Set<Candidate<PendingReason>>();
      const unresolved = pending.filter((active) => {
        const proofs = candidates.pendingReason.filter((resolved) => {
          const proof = resolved.source.evidence.value.pendingResolution;
          return (
            resolved.value === 'none' &&
            proof &&
            active.episode !== null &&
            proof.episodeAnchor === active.episode &&
            timeValid(active.eventAt) &&
            timeValid(proof.eventAt) &&
            proof.eventAt >= active.eventAt &&
            proof.eventAt <= nowMs
          );
        });
        // Keep the actual proof dependencies even when another request remains open.
        for (const proof of proofs) {
          resolvers.add(proof);
          resolutionSources.add(proof.source.id);
        }
        return proofs.length === 0;
      });
      if (unresolved.length) list = unresolved as typeof list;
      else if (resolvers.size) {
        // An unrelated higher-ranked none cannot replace a correlated resolution.
        list = [...resolvers].sort(
          (a, b) => (b.eventAt ?? -1) - (a.eventAt ?? -1) || a.rank - b.rank || compareText(a.source.id, b.source.id)
        ) as typeof list;
        return list[0];
      }
    }
    list.sort((a, b) => {
      if (d === 'lastTurnOutcome' && (a.value === 'none') !== (b.value === 'none')) return a.value === 'none' ? 1 : -1;
      if (d === 'lastTurnOutcome' && (a.value === 'failed') !== (b.value === 'failed'))
        return a.value === 'failed' ? -1 : 1;
      if (d === 'pendingReason' && a.value !== 'none' && b.value !== 'none' && a.rank >= 0 && b.rank >= 0)
        return (
          (b.eventAt ?? -1) - (a.eventAt ?? -1) ||
          Number(b.source.evidence.origin === 'registry') - Number(a.source.evidence.origin === 'registry') ||
          a.rank - b.rank ||
          compareText(a.source.id, b.source.id)
        );
      return a.rank - b.rank || (b.eventAt ?? -1) - (a.eventAt ?? -1) || compareText(a.source.id, b.source.id);
    });
    return list[0] ?? null;
  }
  const activity = pick('activity'),
    pending = pick('pendingReason'),
    outcome = pick('lastTurnOutcome'),
    live = pick('liveness');
  const selectedSources = {
    activity: activity?.source.id ?? null,
    pendingReason: pending?.source.id ?? null,
    lastTurnOutcome: outcome?.source.id ?? null,
    liveness: live?.source.id ?? null,
  };
  const required = new Set([...(input.requiredSourceIds ?? []), ...resolutionSources]);
  for (const id of Object.values(selectedSources)) if (id) required.add(id);
  if (runSource) required.add(runSource.id);
  if (stampReason) required.add('missing:observation');
  if (!live && run && !isRunTerminal(run) && run.state !== 'starting') {
    const heartbeat = matching.find(
      (s) => s.evidence.value.heartbeatAt !== undefined || s.evidence.value.liveness !== undefined
    );
    required.add(heartbeat?.id ?? 'missing:liveness');
  }
  if (!activity && !run) {
    const last = matching.find(
      (s) => s.evidence.value.activity || s.evidence.value.registry || s.evidence.value.openTool
    );
    required.add(
      last?.id ??
        sources.find((s) => s.evidence.value.activity || s.evidence.value.registry || s.evidence.value.openTool)?.id ??
        'missing:activity'
    );
  }
  if (!live && !run) {
    const last = matching.find((s) => s.evidence.value.liveness || s.evidence.value.heartbeatAt !== undefined);
    required.add(
      last?.id ??
        sources.find((s) => s.evidence.value.liveness || s.evidence.value.heartbeatAt !== undefined)?.id ??
        'missing:liveness'
    );
  }
  let freshness = projectFreshness(freshnessSources, [...required].sort(compareText), nowMs);
  let conflict = input.conflict ? structuredClone(input.conflict) : null;
  const explicit = matching.filter((s) => s.evidence.validity === 'conflict');
  // Policy row C01: preserve a current registry/transcript contradiction explicitly.
  const r = current.find(
    (s) =>
      s.evidence.origin === 'registry' && s.evidence.value.registry && s.evidence.value.registry.activity !== 'unknown'
  );
  const t = current.find(
    (s) =>
      s.evidence.origin === 'transcript' &&
      s.evidence.value.activity &&
      s.evidence.value.activity !== 'unknown' &&
      !s.evidence.value.openTool
  );
  const disagreement =
    r && t && r.evidence.value.registry && r.evidence.value.registry.activity !== t.evidence.value.activity;
  const contradictory = [...explicit, ...(disagreement ? [r!, t!] : [])];
  if (contradictory.length) {
    const recordIds = [
      ...new Set([...(conflict?.recordIds ?? []), ...contradictory.map((s) => s.evidence.evidenceId ?? s.id)]),
    ].sort(compareText);
    conflict = {
      count: Math.max(conflict?.count ?? 0, recordIds.length),
      recordIds,
      since: minTime([conflict?.since, ...contradictory.map((s) => s.evidence.eventAt ?? s.evidence.observedAt)])!,
    };
  }
  const dims = {
    activity: activity?.value ?? ('unknown' as Activity),
    pendingReason: pending?.value ?? ('none' as PendingReason),
    lastTurnOutcome:
      run?.state === 'failed' ? ('none' as LastTurnOutcome) : (outcome?.value ?? ('none' as LastTurnOutcome)),
    liveness: live?.value ?? ('unknown' as Liveness),
    freshness,
  };
  const unconfirmedIntent =
    input.runHandshake?.state === 'pending' ||
    input.runHandshake?.state === 'claimed' ||
    input.link?.state === 'pending' ||
    input.link?.state === 'claimed';
  const [availableClass, availableReason] = classify(
    { ...dims, freshness: { ...freshness, state: 'fresh' } },
    run,
    report,
    conflict,
    unconfirmedIntent
  );
  const reportEnters =
    reportSource &&
    ((availableClass === 'pending' && availableReason === 'blocked') ||
      (availableClass === 'exited' && availableReason === 'reported') ||
      (availableClass === 'interrupted' &&
        availableReason === 'interrupted' &&
        report?.status === 'interrupted' &&
        outcome?.value !== 'interrupted'));
  if (reportEnters) {
    required.add(reportSource.id);
    freshness = projectFreshness(freshnessSources, [...required].sort(compareText), nowMs);
    dims.freshness = freshness;
  }
  const [semanticClass, reason] = classify(dims, run, report, conflict, unconfirmedIntent);
  const stateKey = reason === 'launch_failed' ? 'launch_failed' : `${semanticClass}:${reason}`;
  let entering: Candidate<unknown> | null =
    semanticClass === 'pending'
      ? pending
      : (semanticClass === 'failed' && reason !== 'launch_failed') ||
          (semanticClass === 'interrupted' && reason === 'interrupted')
        ? outcome
        : semanticClass === 'working' || semanticClass === 'idle'
          ? activity
          : semanticClass === 'exited'
            ? report
              ? outcome
              : (live ?? activity)
            : null;
  if (
    ['uncertain', 'starting'].includes(semanticClass) ||
    ['launch_failed', 'cancelling', 'cancelled'].includes(reason)
  ) {
    entering = runSource
      ? {
          value: run,
          source: runSource,
          eventAt: runSource.evidence.eventAt,
          episode: runSource.evidence.value.episodes?.run ?? eventIdentity(runSource),
          rank: 0,
        }
      : null;
  }
  if (
    reportEnters &&
    ((semanticClass === 'pending' && reason === 'blocked') ||
      (semanticClass === 'exited' && reason === 'reported') ||
      (semanticClass === 'interrupted' && reason === 'interrupted'))
  ) {
    entering = {
      value: report!.status,
      source: reportSource,
      eventAt: report!.createdAt,
      episode: `report:${report!.reportId}`,
      rank: 0,
    };
  }
  // A closure proves interruption even if a newer activity event supplies the resumed start,
  // or the previous duration was unknown. Sampling need not publish the opening in between.
  let resumedAfterPrior = false;
  let resolutionBoundary: number | null = null;
  const resolution = pending?.source.evidence.value.pendingResolution;
  if (
    !['conflict', 'uncertain', 'pending'].includes(semanticClass) &&
    pending?.value === 'none' &&
    resolution &&
    resolutionSources.has(pending.source.id) &&
    timeValid(pending.eventAt)
  ) {
    resolutionBoundary = pending.eventAt;
    resumedAfterPrior = !!previous && (previous.stateSince === null || pending.eventAt > previous.stateSince);
    if (!entering || entering.eventAt === null || pending.eventAt >= entering.eventAt)
      entering = {
        value: semanticClass,
        rank: 0,
        episode: null,
        ...entering,
        source: pending.source,
        eventAt: pending.eventAt,
      };
  }
  // Recovery from a selected higher-priority uncertainty can reveal an older native/report
  // fact. Its semantic interval resumes at the real run-state recovery event, not that old fact.
  const recoveryBoundary =
    previous?.stateKey.startsWith('uncertain:') &&
    displayNodeKey(previous.nodeIdentity) === displayNodeKey(target.nodeIdentity) &&
    previous.runId === target.runId &&
    previous.bindingGeneration === target.bindingGeneration &&
    previous.sourceGeneration === target.sourceGeneration &&
    run &&
    run.state !== 'uncertain' &&
    !['conflict', 'uncertain'].includes(semanticClass) &&
    timeValid(runSource?.evidence.eventAt)
      ? runSource.evidence.eventAt
      : null;
  if (recoveryBoundary !== null && runSource) {
    resumedAfterPrior ||= previous!.stateSince === null || recoveryBoundary > previous!.stateSince;
    if (!entering || entering.eventAt === null || recoveryBoundary >= entering.eventAt)
      entering = {
        value: semanticClass,
        rank: 0,
        episode: null,
        ...entering,
        source: runSource,
        eventAt: recoveryBoundary,
      };
  }
  let observedRecoveryBoundary: number | null = null;
  if (
    previous?.stateKey.startsWith('stale:') &&
    displayNodeKey(previous.nodeIdentity) === displayNodeKey(target.nodeIdentity) &&
    previous.runId === target.runId &&
    previous.bindingGeneration === target.bindingGeneration &&
    previous.sourceGeneration === target.sourceGeneration &&
    ['working', 'starting', 'exited', 'idle', 'unknown'].includes(semanticClass)
  ) {
    const supporting = matching.filter((s) => required.has(s.id));
    const events = supporting
      .map((source) => ({ source, at: source.evidence.value.heartbeatAt ?? source.evidence.eventAt }))
      .filter(
        (entry): entry is { source: FactSource; at: number } =>
          timeValid(entry.at) &&
          entry.at >= (previous.stateSince ?? 0) &&
          (previous.stateSince !== null ||
            entry.source.evidence.value.heartbeatAt !== undefined ||
            (input.history.rebuildFromEvent === true && entry.source === entering?.source))
      )
      .sort((a, b) => b.at - a.at || compareText(a.source.id, b.source.id));
    const recovery = events[0];
    resumedAfterPrior = true;
    if (recovery) {
      if (!entering || entering.eventAt === null || recovery.at >= entering.eventAt)
        entering = {
          value: semanticClass,
          rank: 0,
          episode: null,
          ...entering,
          source: recovery.source,
          eventAt: recovery.at,
        };
    } else {
      // A successful read proves current freshness without inventing a source event.
      observedRecoveryBoundary = maxTime(
        supporting.flatMap((s) => [s.evidence.observedAt, s.evidence.lastSuccessfulReadAt])
      );
      if (
        observedRecoveryBoundary === null ||
        (previous.stateSince !== null && observedRecoveryBoundary < previous.stateSince)
      )
        observedRecoveryBoundary = nowMs;
    }
  }
  let episodeAnchor = entering?.episode ?? null;
  const selectedIds = new Set([...required]);
  const used = matching.filter((s) => selectedIds.has(s.id));
  const observedAt = maxTime(used.map((s) => s.evidence.observedAt)) ?? nowMs;
  let eventAt =
    semanticClass === 'stale'
      ? maxTime([freshness.staleSince, resolutionBoundary, recoveryBoundary])
      : semanticClass === 'conflict'
        ? conflict!.since
        : observedRecoveryBoundary === null
          ? (entering?.eventAt ?? null)
          : null;
  if (eventAt !== null && eventAt > nowMs) eventAt = null;
  const sameNode = previous && displayNodeKey(previous.nodeIdentity) === displayNodeKey(target.nodeIdentity);
  let previousForContinuity = previous;
  const laterStaleBoundary =
    semanticClass === 'stale' &&
    timeValid(eventAt) &&
    previous?.stateKey === stateKey &&
    timeValid(previous.stateSince) &&
    eventAt > previous.stateSince;
  const binding = input.intentBinding;
  if (
    previous?.nodeIdentity.kind === 'delegationIntent' &&
    session &&
    binding &&
    binding.linkId === previous.nodeIdentity.linkId &&
    binding.runId === target.runId &&
    binding.runId === previous.runId &&
    sameSessionRef(binding.ref, session.ref) &&
    binding.episodeAnchor === episodeAnchor &&
    binding.episodeAnchor === previous.episodeAnchor
  ) {
    previousForContinuity = { ...previous, ...target } as StateContinuity;
  }
  const lineageChanged =
    previousForContinuity &&
    (previousForContinuity.ruleVersion !== ruleVersion ||
      ('sourceGeneration' in previousForContinuity &&
        previousForContinuity.sourceGeneration !== target.sourceGeneration));
  const unprovenBinding = previous && !sameNode && previousForContinuity === previous;
  // An absent anchor on a replacement source is not proof of a new episode.
  const sameProvenInterval =
    !resumedAfterPrior &&
    !laterStaleBoundary &&
    previousForContinuity &&
    displayNodeKey(previousForContinuity.nodeIdentity) === displayNodeKey(target.nodeIdentity) &&
    previousForContinuity.runId === target.runId &&
    previousForContinuity.bindingGeneration === target.bindingGeneration &&
    previousForContinuity.ruleVersion === ruleVersion &&
    previousForContinuity.sourceGeneration === target.sourceGeneration &&
    previousForContinuity.stateKey === stateKey &&
    input.history.continuity === 'proven' &&
    !input.history.gap &&
    !freshness.clockAnomaly;
  if (
    sameProvenInterval &&
    (episodeAnchor === null ||
      (previousForContinuity!.episodeAnchor === null &&
        (eventAt === null ||
          (previousForContinuity!.stateSince !== null && eventAt <= previousForContinuity!.stateSince))))
  ) {
    episodeAnchor = episodeAnchor ?? previousForContinuity!.episodeAnchor;
    previousForContinuity = { ...previousForContinuity!, episodeAnchor };
  }
  const continuityMode = freshness.clockAnomaly
    ? 'unknown'
    : unprovenBinding || ((input.history.gap || lineageChanged) && !input.history.rebuildFromEvent)
      ? 'first_observation'
      : input.history.continuity;
  const continuity = resolveStateContinuity(
    {
      ...target,
      ruleVersion,
      episodeAnchor,
      stateKey,
      eventAt,
      observedAt: observedRecoveryBoundary ?? observedAt,
      continuity: continuityMode,
      historicalGap: input.history.gap,
      clockAnomaly: freshness.clockAnomaly,
    } as Parameters<typeof resolveStateContinuity>[0],
    resumedAfterPrior ||
      laterStaleBoundary ||
      (previousForContinuity?.stateSince === null && timeValid(eventAt) && input.history.continuity === 'proven')
      ? null
      : previousForContinuity
  );
  const projection: StatusProjection = {
    ...dims,
    stateKey,
    stateSince: continuity.stateSince,
    stateSinceBasis: continuity.stateSinceBasis,
    isRunTerminal: run ? isRunTerminal(run) : null,
    asOfSeq: input.asOfSeq,
    observationStamp: stampReason ? null : input.observationStamp ? structuredClone(input.observationStamp) : null,
    asOf: maxTime(used.map((s) => s.evidence.eventAt)),
    observedAt,
    lastEvidenceAt: maxTime(
      used.map((s) => s.evidence.value.heartbeatAt ?? s.evidence.eventAt ?? s.evidence.observedAt)
    ),
  };
  if (freshness.state !== 'fresh') {
    const last = matching.find(
      (s) => s.evidence.value.registry?.activity || s.evidence.value.activity || s.evidence.value.openTool
    );
    const lastKnown =
      last?.evidence.value.registry?.activity ??
      last?.evidence.value.activity ??
      (last?.evidence.value.openTool ? 'working' : undefined);
    if (lastKnown) projection.lastKnownActivity = lastKnown;
  }
  const identityKey = JSON.stringify([
    displayNodeKey(target.nodeIdentity),
    target.runId ?? null,
    target.bindingGeneration ?? null,
  ]);
  const priorNotice = input.noticeState?.identityKey === identityKey ? input.noticeState : null;
  const emitted = new Set(priorNotice?.inputStamps ?? []);
  const emittedEvents = new Set(priorNotice?.eventStamps ?? []);
  const nextStamps = new Set<string>();
  const nextEvents = new Set<string>();
  const notices: NoticeEdge[] = [];
  function edge(kind: NoticeEdge['kind'], source: FactSource | undefined, episode: string | null, notify = true) {
    if (!source) return;
    const e = source.evidence;
    const inputStamp = JSON.stringify([identityKey, kind, episode ?? eventIdentity(source)]);
    const eventStamp = JSON.stringify([identityKey, kind, eventIdentity(source)]);
    nextStamps.add(inputStamp);
    nextEvents.add(eventStamp);
    // A ledger sequence is exact. A timestamp-based alias only proves ID enrichment/loss;
    // two distinct already-known episodes can legitimately share a millisecond.
    const eventKnown =
      (emitted.has(eventStamp) || emittedEvents.has(eventStamp)) &&
      (e.seq !== undefined || episode === null || emitted.has(eventStamp));
    const known = emitted.has(inputStamp) || eventKnown;
    emitted.add(inputStamp);
    emittedEvents.add(eventStamp);
    if (known || !priorNotice || !notify) return;
    notices.push({
      nodeIdentity: structuredClone(target.nodeIdentity),
      ...(target.runId ? { runId: target.runId } : {}),
      kind,
      inputStamp,
      created_at: kind === 'report' ? source.evidence.value.report!.createdAt : (e.eventAt ?? e.observedAt),
      ...(e.origin === 'ledger' || e.origin === 'report' ? (e.seq !== undefined ? { sourceEventSeq: e.seq } : {}) : {}),
    });
  }
  if (dims.pendingReason !== 'none')
    edge('pending', pending?.source, pending?.episode ?? null, !priorNotice || priorNotice.pendingReason === 'none');
  if (dims.lastTurnOutcome === 'failed') edge('failed', outcome?.source, outcome?.episode ?? null);
  if (run?.state === 'uncertain') edge('uncertain', runSource, runSource?.evidence.value.episodes?.run ?? null);
  if (run?.state === 'failed') edge('failed', runSource, runSource?.evidence.value.episodes?.run ?? null);
  let reportSeq = priorNotice?.reportSeq ?? null;
  // Baseline reports are acknowledged without retroactive notifications.
  for (const source of [...reportSources].reverse()) {
    const id = source.evidence.value.report!.reportId;
    const stamp = JSON.stringify([identityKey, 'report', `report:${id}`]);
    const seq = source.evidence.seq;
    if (seq !== undefined && reportSeq !== null && seq <= reportSeq) continue;
    if (priorNotice) edge('report', source, `report:${id}`);
    else nextStamps.add(stamp);
    if (seq !== undefined) reportSeq = seq;
  }
  return {
    projection,
    semanticClass,
    reason: reason === 'launch_failed' ? (run?.reason ?? 'launch_failed') : reason,
    selectedSources,
    conflict,
    continuity: structuredClone(continuity),
    notices,
    noticeState: {
      pendingReason: dims.pendingReason,
      lastTurnOutcome: dims.lastTurnOutcome,
      runState: run?.state ?? null,
      identityKey,
      inputStamps: [...nextStamps].sort(compareText),
      eventStamps: [...nextEvents].sort(compareText),
      reportSeq,
    },
    unavailableReasons,
    boundary: input.boundary ? structuredClone(input.boundary) : null,
  };
}
