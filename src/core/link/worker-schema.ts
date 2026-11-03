import type { DelegationViewModel } from './view-model.js';
type Obj = Record<string, any>;
const fail = (): never => {
  throw new Error('worker_dto_schema');
};
const object = (value: unknown): Obj =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : fail();
const closed = (value: unknown, allowed: string, required = allowed): Obj => {
  const out = object(value),
    keys = new Set(allowed.split(' '));
  if (
    Object.keys(out).some((key) => !keys.has(key)) ||
    required
      .split(' ')
      .filter(Boolean)
      .some((key) => !Object.hasOwn(out, key))
  )
    fail();
  return out;
};
const text = (v: unknown) => {
  if (typeof v !== 'string') fail();
};
const num = (v: unknown) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail();
};
const integer = (v: unknown, min = 0) => {
  if (!Number.isSafeInteger(v) || (v as number) < min) fail();
};
const nullableNum = (v: unknown) => {
  if (v !== null) num(v);
};
const nullableText = (v: unknown) => {
  if (v !== null) text(v);
};
const bool = (v: unknown) => {
  if (typeof v !== 'boolean') fail();
};
const choice = (v: unknown, choices: string) => {
  if (typeof v !== 'string' || !choices.split(' ').includes(v)) fail();
};
const list = (v: unknown, visit: (item: any) => void) => {
  if (!Array.isArray(v)) fail();
  for (const item of v as unknown[]) visit(item);
};
function ref(v: unknown) {
  const r = closed(v, 'harness sourceId sessionId threadId');
  choice(r.harness, 'codex claude pi');
  text(r.sourceId);
  text(r.sessionId);
  nullableText(r.threadId);
  return r;
}
function identity(v: unknown) {
  const i = object(v);
  if (i.kind === 'session') {
    closed(i, 'kind ref');
    ref(i.ref);
  } else if (i.kind === 'delegationIntent') {
    closed(i, 'kind linkId');
    text(i.linkId);
  } else if (i.kind === 'job') {
    closed(i, 'kind ref');
    const r = closed(i.ref, 'kind provider account key', 'kind provider key');
    choice(r.kind, 'jev');
    text(r.provider);
    text(r.key);
    if (r.account !== undefined) text(r.account);
  } else fail();
  return i;
}
function coverage(v: unknown) {
  const c = closed(v, 'state skipped gaps remainingBytes loaded reason', 'state skipped gaps loaded');
  choice(c.state, 'complete partial catching_up');
  bool(c.loaded);
  list(c.gaps, text);
  for (const count of Object.values(object(c.skipped))) integer(count);
  if (c.remainingBytes !== undefined) integer(c.remainingBytes);
  if (c.reason !== undefined) text(c.reason);
}
function stamp(v: unknown) {
  if (v === null) return null;
  const s = closed(
    v,
    'seqDomain commitSeq inputLedgerSeq ref runId bindingGeneration sourceGeneration',
    'seqDomain commitSeq inputLedgerSeq ref sourceGeneration'
  );
  text(s.seqDomain);
  integer(s.commitSeq, 1);
  nullableNum(s.inputLedgerSeq);
  integer(s.sourceGeneration, 1);
  ref(s.ref);
  if (s.runId !== undefined) text(s.runId);
  if (s.bindingGeneration !== undefined) integer(s.bindingGeneration, 1);
  return s;
}
const sameRef = (a: Obj, b: Obj) =>
  a.harness === b.harness && a.sourceId === b.sourceId && a.sessionId === b.sessionId && a.threadId === b.threadId;
const sameStamp = (a: Obj | null, b: Obj | null) =>
  a === null
    ? b === null
    : !!b &&
      sameRef(a.ref, b.ref) &&
      a.seqDomain === b.seqDomain &&
      a.commitSeq === b.commitSeq &&
      a.inputLedgerSeq === b.inputLedgerSeq &&
      a.sourceGeneration === b.sourceGeneration &&
      a.runId === b.runId &&
      a.bindingGeneration === b.bindingGeneration;
function status(v: unknown) {
  const s = closed(
    v,
    'activity pendingReason lastTurnOutcome liveness freshness stateKey stateSince stateSinceBasis isRunTerminal asOfSeq observationStamp asOf observedAt lastEvidenceAt lastKnownActivity',
    'activity pendingReason lastTurnOutcome liveness freshness stateKey stateSince stateSinceBasis isRunTerminal asOfSeq observationStamp asOf observedAt lastEvidenceAt'
  );
  choice(s.activity, 'working waiting_input idle exited unknown');
  choice(s.pendingReason, 'none approval question needs_human');
  choice(s.lastTurnOutcome, 'none completed failed interrupted');
  choice(s.liveness, 'alive gone unknown');
  text(s.stateKey);
  choice(s.stateSinceBasis, 'event observed unknown');
  nullableNum(s.stateSince);
  if (s.isRunTerminal !== null) bool(s.isRunTerminal);
  nullableNum(s.asOfSeq);
  nullableNum(s.asOf);
  num(s.observedAt);
  nullableNum(s.lastEvidenceAt);
  if (s.lastKnownActivity !== undefined) choice(s.lastKnownActivity, 'working waiting_input idle exited unknown');
  stamp(s.observationStamp);
  const f = closed(s.freshness, 'state sources requiredSourceIds staleSince reason clockAnomaly');
  choice(f.state, 'fresh stale unknown');
  nullableNum(f.staleSince);
  nullableText(f.reason);
  bool(f.clockAnomaly);
  list(f.requiredSourceIds, text);
  list(f.sources, (raw) => {
    const x = closed(
      raw,
      'id validity lastEvidenceAt observedAt lastSuccessfulReadAt deadlineAt error reason clockAnomaly',
      'id validity lastEvidenceAt observedAt lastSuccessfulReadAt deadlineAt'
    );
    text(x.id);
    choice(x.validity, 'current stale unknown conflict');
    for (const k of ['lastEvidenceAt', 'observedAt', 'lastSuccessfulReadAt', 'deadlineAt']) nullableNum(x[k]);
    if (x.error !== undefined) text(x.error);
    if (x.reason !== undefined) text(x.reason);
    if (x.clockAnomaly !== undefined) bool(x.clockAnomaly);
  });
  return s;
}
function conflict(v: unknown) {
  if (v === null) return;
  const c = closed(v, 'count recordIds since');
  integer(c.count);
  list(c.recordIds, text);
  num(c.since);
}
function offline(v: unknown) {
  if (v === null) return;
  const p = closed(v, 'since seq orphanPolicy');
  num(p.since);
  integer(p.seq);
  text(p.orphanPolicy);
}
function execution(v: unknown) {
  const x = closed(
    v,
    'terminal reconciliation isRunTerminal execution launchFailure',
    'isRunTerminal execution launchFailure'
  );
  if (x.isRunTerminal !== null) bool(x.isRunTerminal);
  choice(x.execution, 'non_execution managed unmanaged');
  if (x.launchFailure !== null) {
    const f = closed(x.launchFailure, 'stateKey reason');
    if (f.stateKey !== 'launch_failed') fail();
    nullableText(f.reason);
  }
  if (x.reconciliation !== undefined && x.reconciliation !== null) {
    const r = closed(x.reconciliation, 'cause missing');
    text(r.cause);
    list(r.missing, text);
  }
  if (x.terminal !== undefined && x.terminal !== null) {
    const t = closed(x.terminal, 'note termination');
    nullableText(t.note);
    if (t.termination !== null) {
      const z = closed(t.termination, 'outcome requestedCause observed attribution');
      text(z.outcome);
      nullableText(z.requestedCause);
      text(z.attribution);
      const o = closed(z.observed, 'exitCode signal escalatedTo scopeEvidence');
      nullableNum(o.exitCode);
      nullableText(o.signal);
      nullableText(o.escalatedTo);
      text(o.scopeEvidence);
    }
  }
}
function metric(v: unknown, kind: 'text' | 'number' | 'tokens' | 'context') {
  const m = closed(v, 'source asOf value quality');
  text(m.source);
  num(m.asOf);
  choice(m.quality, 'reported estimated unknown');
  if (m.value === null) {
    if (m.quality !== 'unknown') fail();
    return;
  }
  if (m.quality === 'unknown') fail();
  if (kind === 'text') text(m.value);
  else if (kind === 'number') num(m.value);
  else {
    const d = closed(
      m.value,
      kind === 'tokens' ? 'input output cacheRead cacheWrite reasoning' : 'used window percent',
      kind === 'tokens' ? 'input output' : 'used window percent'
    );
    for (const v of Object.values(d)) num(v);
  }
}
function observation(v: unknown) {
  if (v === null) return null;
  const o = closed(
    v,
    'nodeIdentity currentRun linkId runHandshake latestReportForRun statusProjection conflict spent workspace coverage loaded depth evidenceStamp model effort context holderLabel',
    'nodeIdentity statusProjection conflict spent workspace coverage loaded depth evidenceStamp'
  );
  identity(o.nodeIdentity);
  status(o.statusProjection);
  coverage(o.coverage);
  bool(o.loaded);
  integer(o.depth);
  text(o.evidenceStamp);
  const spent = closed(o.spent, 'tokens costUsd');
  metric(spent.tokens, 'tokens');
  metric(spent.costUsd, 'number');
  for (const k of ['model', 'effort']) if (o[k] !== undefined) metric(o[k], 'text');
  if (o.context !== undefined) metric(o.context, 'context');
  conflict(o.conflict);
  if (o.currentRun !== undefined) run(o.currentRun);
  if (o.latestReportForRun !== undefined) report(o.latestReportForRun);
  if (o.runHandshake !== undefined) {
    const h = closed(o.runHandshake, 'state reason');
    choice(h.state, 'pending claimed bound');
    nullableText(h.reason);
  }
  if (o.workspace !== null) object(o.workspace);
  if (o.linkId !== undefined) text(o.linkId);
  if (o.holderLabel !== undefined) text(o.holderLabel);
  return o;
}
const runKeys =
  'runId linkId runSeq operation targetSessionRef sourceId harness expectedGeneration mode launchCwd workspaceSnapshot projectOrigin supervisionStrategy scopeKind scopeRef state locator launchPhase launchCallId launchCorrelationId launchMessageId supervisor heartbeatAt heartbeatSeq heartbeatMonoMs cancelRequestedAt submissionFencedAt createdAt startedAt endedAt exitCode exitSignal exitSource shellStatus shellSignal terminalEvidenceId orphanPolicy';
function run(v: unknown) {
  if (v === null) return null;
  const r = closed(v, runKeys, 'runId expectedGeneration state');
  text(r.runId);
  integer(r.expectedGeneration, 1);
  text(r.state);
  return r;
}
function report(v: unknown) {
  if (v === null) return;
  const r = closed(
    v,
    'reportId runId linkId childBindingId callerId callerContextId contextGeneration status summary path createdAt',
    'reportId runId linkId status summary path createdAt'
  );
  for (const key of ['reportId', 'runId', 'linkId', 'summary']) text(r[key]);
  nullableText(r.path);
  num(r.createdAt);
  choice(r.status, 'completed failed blocked interrupted');
}
/** Validate the closed display containers before any freshness/presentation consumer can see them.
 * Declared locator/currentState/routing JSON remains open plain data, validated by the codec graph walk. */
export function validateDisplaySchema(value: unknown): asserts value is DelegationViewModel | null {
  if (value === null) return;
  const v = closed(value, 'tree details limits capacity pendingStatus');
  integer(v.pendingStatus);
  const t = closed(v.tree, 'ledger nodes relations candidates selectionMap continuation truncation counts io coverage');
  const l = closed(t.ledger, 'state ledgerId asOfSeq reason');
  choice(l.state, 'available degraded');
  nullableText(l.ledgerId);
  nullableNum(l.asOfSeq);
  nullableText(l.reason);
  coverage(t.coverage);
  object(t.selectionMap);
  for (const x of Object.values(t.selectionMap)) text(x);
  const io = closed(t.io, 'bytesRead recordsRead remainingBytes exceeded');
  nullableNum(io.bytesRead);
  nullableNum(io.recordsRead);
  num(io.remainingBytes);
  bool(io.exceeded);
  const counts = closed(t.counts, 'confirmedSessions delegationIntents jobs knownUnloaded omitted unknownDescendants');
  for (const key of ['confirmedSessions', 'delegationIntents', 'jobs', 'knownUnloaded', 'omitted'])
    integer(counts[key]);
  bool(counts.unknownDescendants);
  const trunc = closed(t.truncation, 'candidates conflictRecords continuation');
  for (const x of Object.values(trunc)) integer(x);
  list(t.continuation, (x) => {
    closed(x, 'key identity reason');
    text(x.key);
    identity(x.identity);
    choice(x.reason, 'nodes depth bytes unloaded native_topology');
  });
  list(t.candidates, (raw) => {
    const c = closed(raw, 'ref linkId kind recordId asOf observedAt reason');
    ref(c.ref);
    nullableText(c.linkId);
    text(c.kind);
    text(c.recordId);
    nullableNum(c.asOf);
    num(c.observedAt);
    text(c.reason);
  });
  const nodeKeys = new Set<string>(),
    nodes = new Map<string, Obj>();
  list(t.nodes, (raw) => {
    const n = closed(
      raw,
      'identity key parentKey edge native depth crossHarnessDepth loaded coverage observation lastObservation currentRun execution conflict links host parent',
      'identity key parentKey edge depth crossHarnessDepth loaded coverage observation lastObservation currentRun execution conflict links host parent'
    );
    text(n.key);
    if (nodeKeys.has(n.key)) fail();
    nodeKeys.add(n.key);
    nodes.set(n.key, n);
    const id = identity(n.identity);
    nullableText(n.parentKey);
    if (n.edge !== null) choice(n.edge, 'delegated native intent');
    integer(n.depth);
    integer(n.crossHarnessDepth);
    bool(n.loaded);
    coverage(n.coverage);
    list(n.links, text);
    const r = run(n.currentRun);
    execution(n.execution);
    conflict(n.conflict);
    const o = observation(n.observation);
    observation(n.lastObservation);
    if (n.native !== undefined && n.native !== null) {
      const m = closed(n.native, 'title kind');
      nullableText(m.title);
      nullableText(m.kind);
    }
    if (n.host !== null) {
      const h = closed(n.host, 'locator state occupantMatches checkedAt currentState');
      text(h.state);
      nullableNum(h.checkedAt);
      if (h.occupantMatches !== null) bool(h.occupantMatches);
      if (h.locator !== null) object(h.locator);
      if (h.currentState !== null) object(h.currentState);
    }
    if (n.parent !== null) {
      const p = closed(n.parent, 'identity harness name liveness paneLabel');
      identity(p.identity);
      nullableText(p.harness);
      nullableText(p.name);
      text(p.liveness);
      nullableText(p.paneLabel);
    }
    const s = o?.statusProjection.observationStamp;
    if (
      s &&
      (id.kind !== 'session' ||
        !sameRef(s.ref, id.ref) ||
        (r
          ? s.runId !== r.runId || s.bindingGeneration !== r.expectedGeneration
          : s.runId !== undefined || s.bindingGeneration !== undefined))
    )
      fail();
  });
  if (nodeKeys.size > 200) fail();
  list(t.relations, (raw) => {
    const r = closed(raw, 'link currentRun parentKey childKey attribution verification conflict parentOffline host');
    const link = closed(
      r.link,
      'linkId state parentCaller parentContextId parentContextGeneration parentRef childRef currentOwner backend role label briefPath taskDigest reportPath predecessor routing createdAt claimedAt boundAt closedAt'
    );
    for (const k of [
      'linkId',
      'state',
      'parentCaller',
      'parentContextId',
      'backend',
      'role',
      'briefPath',
      'taskDigest',
    ])
      text(link[k]);
    for (const k of ['label', 'reportPath', 'predecessor']) nullableText(link[k]);
    integer(link.parentContextGeneration, 1);
    bool(link.currentOwner);
    num(link.createdAt);
    for (const k of ['claimedAt', 'boundAt', 'closedAt']) nullableNum(link[k]);
    if (link.parentRef !== null) ref(link.parentRef);
    if (link.childRef !== null) ref(link.childRef);
    if (link.routing !== null) object(link.routing);
    conflict(r.conflict);
    offline(r.parentOffline);
    run(r.currentRun);
    nullableText(r.parentKey);
    text(r.childKey);
    choice(r.attribution, 'confirmed intent history conflict');
    choice(r.verification, 'not_observed corroborated conflict');
    object(r.host);
  });
  const details = object(v.details);
  for (const [key, raw] of Object.entries(details)) {
    if (!nodeKeys.has(key)) fail();
    const d = closed(
      raw,
      'status statusSource latestReportForRun reportHistory parentOffline wake wakeUnavailableReason observationUnavailableReason reconcile resumable',
      'status statusSource latestReportForRun reportHistory parentOffline wake reconcile resumable'
    );
    choice(d.statusSource, 'committed ledger unavailable');
    const s = d.status === null ? null : status(d.status);
    report(d.latestReportForRun);
    offline(d.parentOffline);
    for (const k of ['wakeUnavailableReason', 'observationUnavailableReason'])
      if (d[k] !== undefined) nullableText(d[k]);
    if (d.wake !== null) {
      const w = closed(d.wake, 'adapter state reason attempts');
      text(w.adapter);
      text(w.state);
      nullableText(w.reason);
      if (w.attempts !== null) integer(w.attempts);
    }
    list(d.reportHistory, report);
    const a = closed(d.resumable, 'resumable reason subject');
    if (a.resumable !== false || a.subject !== 'local_user' || a.reason !== 'capability_unverified') fail();
    if (
      d.statusSource === 'committed' &&
      (!s ||
        !s.observationStamp ||
        !nodes.get(key)?.observation?.statusProjection.observationStamp ||
        !sameStamp(
          stamp(s.observationStamp),
          stamp(nodes.get(key)?.observation?.statusProjection.observationStamp ?? null)
        ))
    )
      fail();
    if (d.reconcile !== null) {
      const x = closed(d.reconcile, 'operation linkId runId reason subject delivery hudHome displayCommand');
      for (const p of ['linkId', 'runId', 'reason', 'hudHome', 'displayCommand']) text(x[p]);
      if (x.operation !== 'reconcile' || x.subject !== 'local_user' || x.delivery !== 'copy_only') fail();
    }
  }
  if (Object.keys(details).length !== nodeKeys.size) fail();
  const limits = closed(v.limits, 'limits source reason');
  const cap = closed(limits.limits, 'maxActiveRuns maxActiveRunsPerOwner');
  integer(cap.maxActiveRuns, 1);
  integer(cap.maxActiveRunsPerOwner, 1);
  choice(limits.source, 'default configured');
  nullableText(limits.reason);
  if (v.capacity !== null) {
    const c = closed(v.capacity, 'active limit mine mineLimit full occupants');
    for (const key of ['active', 'limit', 'mine', 'mineLimit']) integer(c[key]);
    bool(c.full);
    list(c.occupants, (raw) => {
      const o = closed(raw, 'runId linkId state since holder retireEta');
      text(o.runId);
      text(o.linkId);
      text(o.state);
      num(o.since);
      choice(o.holder, 'self other');
      nullableNum(o.retireEta);
    });
  }
}
