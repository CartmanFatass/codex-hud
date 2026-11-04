/** Test-owned observation only. No process, timer, probe or file side effects on import. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryRunFactPort } from '../../src/core/run/fake-port.js';
import type { RunSnapshot } from '../../src/core/run/port.js';
import { launchNodeGroup } from '../run/native-group.js';

export interface KillRecord {
  sequence: number;
  operation: string;
  at: number;
  input: unknown;
  before?: RunSnapshot;
  after?: RunSnapshot;
  result?: unknown;
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) immutable(item);
  }
  return value;
}
export function captureKill(port: MemoryRunFactPort, snapshot: () => RunSnapshot) {
  const records: KillRecord[] = [];
  const add = (record: Omit<KillRecord, 'sequence'>) => {
    assert.ok(records.length < 256, 'bounded diagnostic record capacity');
    records.push(immutable(structuredClone({ sequence: records.length + 1, ...record })));
  };
  // MemoryRunFactPort mutations are synchronous transactions returning promises. Capture
  // immediately around that transaction, without extra reads or awaited observations.
  for (const operation of ['register', 'phase', 'startup', 'raw', 'receipt', 'acceptCancel', 'reconcile'] as const) {
    const original = port[operation].bind(port) as (...args: unknown[]) => Promise<unknown>;
    const wrapper = (...args: unknown[]) => {
      const before = structuredClone(snapshot());
      const input = structuredClone(
        operation === 'register' ? [args[0], '<ticket omitted>', '<digest omitted>', args[3]] : args
      );
      const pending = original(...args);
      const after = structuredClone(snapshot());
      return pending.then((result) => {
        add({ operation, at: Date.now(), input, before, after, result });
        return result;
      });
    };
    // The runtime wrapper preserves every argument, result and rejection exactly once.
    Object.assign(port, { [operation]: wrapper });
  }
  const launcher: typeof launchNodeGroup = async (options) => {
    add({ operation: 'group.launch', at: Date.now(), input: { runId: options.runId } });
    const group = await launchNodeGroup(options);
    add({
      operation: 'group.started',
      at: Date.now(),
      input: { helper: group.helper, command: group.command, scope: group.scope },
    });
    return {
      ...group,
      exited: group.exited.then((result) => {
        add({ operation: 'group.exited', at: Date.now(), input: null, result });
        return result;
      }),
      signal: async (signal) => {
        add({ operation: 'signal.request', at: Date.now(), input: signal });
        const result = await group.signal(signal);
        add({ operation: 'signal.ack', at: Date.now(), input: signal, result });
        return result;
      },
    };
  };
  return { records, launcher };
}

/** Explicit publication allowlist: never serialize run input, environment, ticket,
 * token hashes, cwd, session refs, project origin, or arbitrary event/error text. */
const runKeys = [
  'runId',
  'linkId',
  'sourceId',
  'expectedGeneration',
  'mode',
  'supervisionStrategy',
  'scopeKind',
  'scopeRef',
  'state',
  'launchPhase',
  'supervisor',
  'heartbeatAt',
  'heartbeatSeq',
  'heartbeatMonoMs',
  'cancelRequestedAt',
  'submissionFencedAt',
  'createdAt',
  'startedAt',
  'endedAt',
  'exitCode',
  'exitSignal',
  'exitSource',
  'terminalEvidenceId',
] as const;
const metaKeys = [
  'schema_version',
  'run_id',
  'link_id',
  'source_id',
  'binding_generation',
  'mode',
  'supervision_strategy',
  'supervisor',
  'command_leader',
  'harness',
  'scope',
  'created_at',
  'stdin_mode',
  'capture',
] as const;
const eventKeys = [
  'signal',
  'requestSeq',
  'graceMs',
  'sent',
  'command',
  'helper',
  'scope',
  'code',
  'observedAt',
  'proof_ids',
  'row',
  'state',
  'supervisor',
  'sourceId',
  'bindingGeneration',
] as const;
function pick(value: object, keys: readonly string[]) {
  return Object.fromEntries(
    keys.filter((key) => key in value).map((key) => [key, (value as Record<string, unknown>)[key]])
  );
}
function safeSnapshot(s: RunSnapshot) {
  return {
    revision: s.revision,
    run: pick(s.run, runKeys),
    meta: s.meta && pick(s.meta, metaKeys),
    facts: s.facts,
    receipt: s.receipt,
    claimSupervisor: s.claimSupervisor,
    claimState: s.claimState,
    slotHeld: s.slotHeld,
    controlConflict: s.controlConflict ?? false,
    terminalNote: s.status.terminalNote,
    events: s.events.map((e) => ({
      seq: e.seq,
      runId: e.runId,
      linkId: e.linkId,
      kind: e.kind,
      at: e.at,
      payload: pick(e.payload, eventKeys),
    })),
    terminalTransitionCount: s.events.filter(
      (e) => e.kind === 'run.reconciled' && ['ended', 'failed', 'cancelled'].includes(String(e.payload.state))
    ).length,
  };
}
function safeInput(record: KillRecord) {
  const args = record.input as unknown[];
  if (record.operation === 'startup') return [args[0], args[1], pick(args[2] as object, metaKeys)];
  if (record.operation === 'raw') return [args[0], args[1], args[2], pick(args[3] as object, eventKeys)];
  if (record.operation === 'acceptCancel')
    return [args[0], { kind: 'trusted_local', invocationId: 'synthetic-invocation' }, args[2]];
  return record.input;
}
/** Pure publication-copy transformation. Protected identities are opaque, including
 * scope_id. A single simultaneous substitution preserves equality and avoids
 * recursively rewriting generated pseudonyms. No live evidence is changed. */
export function serializeKillPublication(value: unknown, extraProtected: readonly string[] = []): string {
  const protectedValues = new Set(extraProtected);
  const visit = (item: unknown, visitor: (key: string, child: unknown) => void) => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      visitor(key, child);
      visit(child, visitor);
    }
  };
  visit(value, (key, child) => {
    if (['boot_id', 'pid_domain', 'scope_id'].includes(key)) {
      assert.ok(typeof child === 'string' && child.length > 0, 'invalid protected identity in publication');
      protectedValues.add(child);
    }
  });
  const originals = [...protectedValues].sort((a, b) => b.length - a.length || a.localeCompare(b));
  assert.ok(
    originals.every((item) => item.length > 0),
    'empty protected identity'
  );
  const aliases = new Map(
    originals.map((item) => [item, `identity-sha256-${createHash('sha256').update(item).digest('hex')}`])
  );
  assert.equal(new Set(aliases.values()).size, aliases.size, 'distinct identity aliases');
  const pattern = originals.length
    ? new RegExp(originals.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    : null;
  const transform = (item: unknown): unknown => {
    if (typeof item === 'string') return pattern ? item.replace(pattern, (raw) => aliases.get(raw)!) : item;
    if (Array.isArray(item)) return item.map(transform);
    if (item && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [transform(key), transform(child)]));
    return item;
  };
  const copy = transform(value);
  // Check both decoded strings and encoded bytes; never include an identifier or
  // matching line in diagnostics. Refuse publication instead of unsafe fallback.
  visit(copy, (key, child) => {
    assert.ok(
      !originals.some((raw) => key.includes(raw) || (typeof child === 'string' && child.includes(raw))),
      'protected identity survived publication'
    );
  });
  if (typeof copy === 'string')
    assert.ok(!originals.some((raw) => copy.includes(raw)), 'protected identity survived publication');
  const json = JSON.stringify(copy, null, 2) + '\n';
  assert.ok(!originals.some((raw) => json.includes(raw)), 'protected identity survived encoded publication');
  return json;
}

export function projectKillCapture(
  label: string,
  records: readonly KillRecord[],
  final: RunSnapshot,
  exitFile: unknown
) {
  return {
    schema: 2,
    label,
    runtime: process.version,
    caveat:
      'Instrumentation may perturb scheduling. New evidence, not historical replay. No extra critical-path probes.',
    redaction:
      'v2 explicit field allowlist; opaque scope, boot and PID-domain identities consistently pseudonymized throughout projected copies; original in-memory digest retained, not reconstructible from projection.',
    originalRecordsSha256: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
    records: records.map((r) => ({
      sequence: r.sequence,
      operation: r.operation,
      at: r.at,
      input: safeInput(r),
      before: r.before && safeSnapshot(r.before),
      after: r.after && safeSnapshot(r.after),
      result: r.result,
    })),
    final: safeSnapshot(final),
    exitFile,
  };
}
export function saveKillCapture(label: string, records: readonly KillRecord[], final: RunSnapshot, home: string) {
  const file = join(home, 'runs', final.run.runId, 'exit.json');
  const exitFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const json = serializeKillPublication(projectKillCapture(label, records, final, exitFile));
  const directory = process.env.RUNZ1_KILL_EVIDENCE_DIR;
  if (directory) writeFileSync(join(directory, `${label}-${process.pid}.json`), json, { flag: 'wx', mode: 0o600 });
  else console.log(`RUNZ1_KILL_CAPTURE ${json}`);
}

function assertCaptureBinding(before: RunSnapshot) {
  const meta = before.meta;
  assert.ok(meta?.scope && meta.harness && meta.command_leader && meta.supervisor);
  assert.equal(meta.run_id, before.run.runId);
  assert.equal(meta.link_id, before.run.linkId);
  assert.equal(meta.source_id, before.run.sourceId);
  assert.equal(meta.binding_generation, before.run.expectedGeneration);
  assert.deepEqual(meta.supervisor, before.run.supervisor);
  assert.deepEqual(meta.scope, before.run.scopeRef);
  const registration = before.events.filter((e) => e.kind === 'supervisor.registered');
  assert.equal(registration.length, 1);
  assert.equal(registration[0].runId, before.run.runId);
  assert.equal(registration[0].linkId, before.run.linkId);
  assert.equal(registration[0].payload.sourceId, before.run.sourceId);
  assert.equal(registration[0].payload.bindingGeneration, before.run.expectedGeneration);
  assert.deepEqual(registration[0].payload.supervisor, meta.supervisor);
  assert.deepEqual(before.claimSupervisor, { pid: meta.supervisor.pid, proc_start: meta.supervisor.proc_start });
  for (const stamp of [meta.harness, meta.command_leader, meta.scope.group_leader]) {
    assert.equal(stamp.boot_id, meta.scope.boot_id);
    assert.equal(stamp.pid_domain, meta.scope.pid_domain);
  }
  return meta;
}

/** Explicit completion prerequisites, independent of the actual returned decision.
 * This lost-wait test never has a known native result or a valid never-submitted
 * proof. Report those unsupported premises rather than treating them as absence. */
function completionEligibility(run: Run, facts: readonly ReconcileEvidence[], now: number) {
  assert.ok(Number.isFinite(now) && now >= 0, 'capture needs a valid reconciliation time');
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const bound = facts.filter(
    (e) =>
      e.validation === 'accepted' &&
      e.runId === run.runId &&
      e.sourceId === run.sourceId &&
      e.bindingGeneration === run.expectedGeneration &&
      same(e.supervisor, run.supervisor)
  );
  const timed = (e: ReconcileEvidence) => e.asOf !== null && Number.isFinite(e.asOf) && e.asOf >= 0 && e.asOf <= now;
  const complete = bound.filter(
    (e) =>
      (e.fact.kind === 'receipt' || e.fact.kind === 'scope_reconciled') &&
      e.fact.complete &&
      e.fact.harnessTerminated &&
      e.fact.launchersSealed
  );
  const dated = complete.filter(timed);
  for (const e of complete)
    assert.equal(
      (e.fact as { nativeExit: unknown }).nativeExit,
      null,
      'lost-wait proof must keep native status unknown'
    );
  assert.ok(
    !bound.some((e) => e.fact.kind === 'never_submitted'),
    'launched capture cannot claim never-submitted proof'
  );
  const chronology = new Set(
    bound.flatMap((e) => (e.fact.kind === 'cancel' && e.fact.chronology !== 'unknown' ? [e.fact.chronology] : []))
  );
  const reasons: string[] = [];
  if (bound.some((e) => e.fact.kind === 'conflict')) reasons.push('explicit-conflict');
  if (run.cancelRequestedAt !== null && chronology.size > 1) reasons.push('cancellation-conflict');
  if (complete.some((e) => !timed(e))) reasons.push('invalid-completion-time');
  const scopes = bound.filter((e) => e.fact.kind === 'scope' && timed(e));
  if (
    scopes.some(
      (a) =>
        a.fact.kind === 'scope' &&
        a.fact.state === 'alive' &&
        scopes.some(
          (g) =>
            g.asOf === a.asOf &&
            g.fact.kind === 'scope' &&
            g.fact.state === 'gone' &&
            g.fact.complete &&
            g.fact.harnessTerminated &&
            g.fact.launchersSealed
        )
    )
  )
    reasons.push('persistent-scope-tie');
  const counter = (e: ReconcileEvidence) =>
    e.fact.kind === 'scope'
      ? e.fact.state === 'alive' || (e.fact.state !== 'unknown' && e.fact.complete && !e.fact.launchersSealed)
      : (e.fact.kind === 'receipt' || e.fact.kind === 'scope_reconciled') &&
        (!e.fact.harnessTerminated || !e.fact.launchersSealed);
  if (dated.some((proof) => bound.some((e) => counter(e) && (!timed(e) || e.asOf! >= proof.asOf!))))
    reasons.push('current-or-undated-counter-evidence');
  return { eligible: dated.length > 0 && reasons.length === 0, reasons, proofCount: complete.length };
}

/** Independent assertion over the *releasing transaction*, not a later probe and
 * not reconcileRun used as its own expected answer. Only this fixture's lost-wait
 * receipt/Q cases are admitted; unknown native fields remain null in every branch. */
export function assertKillEvidence(records: readonly KillRecord[], final: RunSnapshot, exitFile: unknown) {
  assert.equal(final.run.exitCode, null);
  assert.equal(final.run.exitSignal, null);
  assert.equal(final.run.exitSource, null);
  assert.deepEqual(exitFile, final.receipt, 'file and retained receipt agree');
  const reconciles = records.filter((r) => r.operation === 'reconcile');
  const released = reconciles.filter((r) => r.before!.slotHeld && !r.after!.slotHeld);
  const terminalEvents = final.events.filter(
    (e) => e.kind === 'run.reconciled' && ['ended', 'failed', 'cancelled'].includes(String(e.payload.state))
  );
  if (final.slotHeld) {
    let lastCommitted: KillRecord | undefined;
    let blocked = false;
    for (const transaction of reconciles) {
      assert.ok(transaction.before && transaction.after, 'missing captured transaction boundary');
      const before = transaction.before,
        after = transaction.after;
      const input = transaction.input as [string, number, ReconcileEvidence[], number];
      if (transaction.result === null) {
        assert.deepEqual(after, before, 'rejected CAS must not change retained state');
        continue; // Proposed observations were not committed.
      }
      assert.ok(transaction.result, 'missing transaction result');
      assertCaptureBinding(before);
      assert.equal(input[0], before.run.runId);
      assert.equal(input[1], before.revision, 'successful CAS revision');
      const facts = [...before.facts, ...input[2]];
      assert.deepEqual(after.facts, facts, 'successful transaction retains supplied facts');
      assert.equal(after.revision, before.revision + 1);
      const eligibility = completionEligibility(before.run, facts, input[3]);
      assert.equal(eligibility.eligible, false, 'eligible completion proof cannot remain held');
      blocked ||= eligibility.reasons.length > 0;
      const decision = transaction.result as ReconcileDecision;
      assert.equal(decision.releaseSlot, false);
      assert.equal(after.slotHeld, true);
      assert.equal(after.run.state, decision.state);
      assert.equal(after.status.terminalNote, decision.terminalNote);
      assert.ok(!['ended', 'failed', 'cancelled'].includes(decision.state));
      lastCommitted = transaction;
    }
    assert.ok(lastCommitted, 'incomplete capture: no successful reconciliation boundary');
    assert.deepEqual(final.facts, lastCommitted.after!.facts, 'final retained facts need a known committed boundary');
    assertCaptureBinding(final);
    const lastInput = lastCommitted.input as [string, number, ReconcileEvidence[], number];
    const retained = completionEligibility(final.run, final.facts, lastInput[3]);
    assert.equal(retained.eligible, false, 'eligible retained completion proof cannot remain held');
    blocked ||= retained.reasons.length > 0;
    assert.equal(released.length, 0);
    assert.equal(terminalEvents.length, 0);
    assert.ok(!['ended', 'failed', 'cancelled'].includes(final.run.state));
    assert.equal(final.receipt, null);
    assert.equal(records.filter((r) => r.operation === 'receipt').length, 0);
    assert.equal(final.run.endedAt, null);
    assert.equal(final.run.terminalEvidenceId, null);
    return blocked ? ('blocked-proof' as const) : ('incomplete-proof' as const);
  }
  assert.equal(released.length, 1, 'exactly one captured slot-releasing transaction');
  const transition = released[0];
  const before = transition.before!,
    after = transition.after!;
  const input = transition.input as [string, number, ReconcileEvidence[], number];
  const decision = transition.result as ReconcileDecision;
  assert.equal(input[0], before.run.runId);
  assert.equal(input[1], before.revision, 'successful CAS was on the captured revision');
  assert.ok(decision && decision.releaseSlot && decision.emitTransition);
  const all = [...before.facts, ...input[2]];
  assert.deepEqual(after.facts, all, 'actual supplied facts retained unchanged');
  assertCompletionEvidence(before.run, all, input[3], decision);
  const meta = assertCaptureBinding(before);
  assert.equal(after.claimState, 'revoked');
  assert.equal(final.claimState, 'revoked');
  assert.equal(after.run.endedAt, input[3]);
  assert.ok(after.run.submissionFencedAt !== null);
  assert.ok(after.run.terminalEvidenceId !== null);
  // The fake port stores the generic first evidence ID. Do not confuse it with Q.
  assert.ok(decision.evidenceIds.includes(after.run.terminalEvidenceId));
  assert.equal(after.run.state, decision.state);
  assert.equal(final.run.state, after.run.state);
  assert.equal(final.status.terminalNote, decision.terminalNote);
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].payload.row, decision.row);
  assert.equal(terminalEvents[0].payload.state, decision.state);
  assert.equal(terminalEvents[0].at, input[3]);
  if (!final.receipt) {
    assert.equal(records.filter((r) => r.operation === 'receipt').length, 0);
    assert.ok(all.some((e) => decision.evidenceIds.includes(e.evidenceId) && e.fact.kind === 'scope_reconciled'));
    return 'receiptless-Q' as const;
  }
  assert.equal(records.filter((r) => r.operation === 'receipt').length, 1);
  assert.equal(final.receipt.native_exit, null);
  assert.equal(
    inspectReceipt(
      { final: true, complete: true, fingerprint: digest(final.receipt), receipt: final.receipt },
      meta,
      new Map()
    ).decision,
    'adopt'
  );
  assert.ok(all.some((e) => decision.evidenceIds.includes(e.evidenceId) && e.fact.kind === 'receipt'));
  return 'final-receipt' as const;
}

import type { ReconcileDecision, ReconcileEvidence, Run } from '../../src/core/types/execution.js';
import { digest } from '../../src/core/canonical.js';
import { inspectReceipt } from '../../src/core/supervision.js';

export function assertCompletionEvidence(
  run: Run,
  all: readonly ReconcileEvidence[],
  now: number,
  decision: ReconcileDecision
) {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const bound = all.filter(
    (e) =>
      e.validation === 'accepted' &&
      e.runId === run.runId &&
      e.sourceId === run.sourceId &&
      e.bindingGeneration === run.expectedGeneration &&
      same(e.supervisor, run.supervisor)
  );
  const timed = (e: ReconcileEvidence) => e.asOf !== null && Number.isFinite(e.asOf) && e.asOf >= 0 && e.asOf <= now;
  const complete = bound.filter(
    (e) =>
      (e.fact.kind === 'receipt' || e.fact.kind === 'scope_reconciled') &&
      e.fact.complete &&
      e.fact.harnessTerminated &&
      e.fact.launchersSealed
  );
  assert.ok(complete.length > 0, 'release needs a bound, accepted complete R or Q');
  for (const proof of complete) {
    assert.ok(timed(proof), 'complete proof requires a valid fact time');
    assert.ok(decision.evidenceIds.includes(proof.evidenceId), 'decision cites supporting proof');
    assert.ok(!decision.auditEvidenceIds.includes(proof.evidenceId), 'support must not be audit-only');
    assert.equal((proof.fact as { nativeExit: unknown }).nativeExit, null);
    for (const e of bound) {
      assert.notEqual(e.fact.kind, 'conflict', 'unresolved conflict prevents release');
      assert.notEqual(e.fact.kind, 'never_submitted', 'this launched fixture cannot use N');
      const counter =
        e.fact.kind === 'scope'
          ? e.fact.state === 'alive' || (e.fact.state !== 'unknown' && e.fact.complete && !e.fact.launchersSealed)
          : (e.fact.kind === 'receipt' || e.fact.kind === 'scope_reconciled') &&
            (!e.fact.harnessTerminated || !e.fact.launchersSealed);
      if (counter) assert.ok(timed(e) && e.asOf! < proof.asOf!, 'no undated/current/later counter-evidence');
    }
  }
  const scoped = bound.filter((e) => e.fact.kind === 'scope' && timed(e));
  for (const alive of scoped.filter((e) => e.fact.kind === 'scope' && e.fact.state === 'alive')) {
    assert.ok(
      !scoped.some(
        (e) =>
          e.asOf === alive.asOf &&
          e.fact.kind === 'scope' &&
          e.fact.state === 'gone' &&
          e.fact.complete &&
          e.fact.harnessTerminated &&
          e.fact.launchersSealed
      ),
      'conflicting same-time scope facts remain a conflict'
    );
  }
  const chronologies = new Set(
    bound.flatMap((e) => (e.fact.kind === 'cancel' && e.fact.chronology !== 'unknown' ? [e.fact.chronology] : []))
  );
  if (run.cancelRequestedAt !== null) assert.ok(chronologies.size <= 1, 'contradictory cancellation facts');
  const cancelled = run.cancelRequestedAt !== null && chronologies.has('before_exit');
  assert.equal(decision.row, cancelled ? 'R-02-2' : 'R-02-3');
  assert.equal(decision.state, cancelled ? 'cancelled' : 'ended');
  assert.equal(
    decision.terminalNote,
    run.cancelRequestedAt !== null && chronologies.size === 0 ? 'cancel_timing_unknown' : null
  );
  assert.equal(decision.cause, null);
  assert.equal(decision.exitCode, null);
  assert.equal(decision.exitSignal, null);
  assert.equal(decision.exitSource, null);
}
