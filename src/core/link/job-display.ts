/** Pure SIMULATED-only display boundary. Never identity authority, ledger writes or execution permission. */
import type { SessionRef } from '../types/identity.js';
import type { JobRef } from '../types/observation.js';
import { displayNodeKey } from '../observation.js';

export interface SimulationJobParent {
  ledgerId: string;
  ref: SessionRef;
}
export interface SimulationJob {
  key: string;
  ref: JobRef;
  parentContext?: SimulationJobParent;
  state: 'queued' | 'sent' | 'uncertain' | 'needs_human' | 'answered' | 'failed';
  revision: number;
  browser: string;
  dispatches: number;
  generation: number | null;
  reconciled: boolean;
  answer: string | null;
  lease: { key: string; generation: number } | null;
  holderLabel?: string;
}
export interface SimulationJobsAvailable {
  provenance: 'SIMULATED';
  availability: 'available';
  storeId: string;
  revision: number;
  jobs: SimulationJob[];
}
export interface SimulationJobsUnavailable {
  provenance: 'SIMULATED';
  availability: 'unavailable';
  storeId: string | null;
  revision: null;
  jobs: [];
  reason: string;
}
export type SimulationJobsSnapshot = SimulationJobsAvailable | SimulationJobsUnavailable;
export interface SimulationJobDisplay extends SimulationJob {
  provenance: 'SIMULATED';
  availability: 'available' | 'last_known';
  storeId: string;
  storeRevision: number;
  reason: string | null;
}
export interface SimulationJobsStatus {
  provenance: 'SIMULATED';
  availability: 'available' | 'unavailable';
  storeId: string | null;
  revision: number | null;
  lastKnownRevision: number | null;
  reason: string | null;
}
const synthetic = (s: unknown): s is string => typeof s === 'string' && /^synthetic-[a-z0-9-]{1,80}$/.test(s);
const number = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const store = (s: unknown): s is string => typeof s === 'string' && /^synthetic-store-[a-f0-9-]{36}$/.test(s);
const record = (v: any): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);
export function validSimulationJobParent(v: unknown): v is SimulationJobParent {
  const p = v as SimulationJobParent;
  return (
    record(p) &&
    Object.keys(p).every((k) => ['ledgerId', 'ref'].includes(k)) &&
    typeof p.ledgerId === 'string' &&
    /^(synthetic-[a-z0-9-]{1,80}|[a-f0-9]{32}|[a-f0-9-]{36})$/.test(p.ledgerId) &&
    record(p.ref) &&
    Object.keys(p.ref).every((k) => ['harness', 'sourceId', 'sessionId', 'threadId'].includes(k)) &&
    ['claude', 'codex', 'pi'].includes(p.ref.harness) &&
    typeof p.ref.sourceId === 'string' &&
    /^[a-f0-9]{64}$/.test(p.ref.sourceId) &&
    synthetic(p.ref.sessionId) &&
    (p.ref.threadId === null || synthetic(p.ref.threadId))
  );
}
// Only detached, deeply frozen allowlisted results may use the normalized retention path.
// The private WeakSet cannot be forged by raw DTOs or by copying public fields.
const normalizedSnapshots = new WeakSet<object>();
function normalized<T extends SimulationJobsSnapshot>(snapshot: T): T {
  function freeze(value: object): void {
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freeze(child);
    Object.freeze(value);
  }
  freeze(snapshot);
  normalizedSnapshots.add(snapshot);
  return snapshot;
}
const unavailable = (storeId: string | null, reason: string): SimulationJobsUnavailable =>
  normalized({
    provenance: 'SIMULATED',
    availability: 'unavailable',
    storeId,
    revision: null,
    jobs: [],
    reason,
  });
const reasons = new Set([
  'missing_store',
  'private_path_required',
  'unsupported_format',
  'store_identity_mismatch',
  'store_busy',
  'corrupt_store',
  'reader_closed',
]);
/** Accept durable lab DTOs, copy only display fields, and return no usable jobs on malformed input. */
export function simulationJobsSnapshot(value: unknown): SimulationJobsSnapshot {
  if (record(value) && normalizedSnapshots.has(value as object)) return value as SimulationJobsSnapshot;
  const v = value as any,
    id = record(v) && store(v.storeId) ? v.storeId : null;
  try {
    if (!record(v) || v.provenance !== 'SIMULATED') return unavailable(id, 'invalid_snapshot');
    if (v.availability === 'unavailable') {
      if (
        (v.storeId !== null && !store(v.storeId)) ||
        v.revision !== null ||
        !Array.isArray(v.jobs) ||
        v.jobs.length ||
        !reasons.has(v.reason)
      )
        return unavailable(id, 'invalid_snapshot');
      return unavailable(id, v.reason);
    }
    if (v.availability !== 'available' || !id || !number(v.revision) || !Array.isArray(v.jobs) || v.jobs.length > 128)
      return unavailable(id, 'invalid_snapshot');
    const seen = new Set<string>();
    const jobs: SimulationJob[] = [];
    for (const j of v.jobs) {
      const ref = j?.ref;
      if (
        !record(j) ||
        !record(ref) ||
        ref.kind !== 'jev' ||
        !synthetic(ref.provider) ||
        !synthetic(ref.key) ||
        (ref.account !== undefined && !synthetic(ref.account)) ||
        Object.keys(ref).some((k) => !['kind', 'provider', 'account', 'key'].includes(k))
      )
        throw Error();
      const key = displayNodeKey({ kind: 'job', ref });
      if (
        j.key !== key ||
        seen.has(key) ||
        !number(j.revision) ||
        !j.revision ||
        j.revision > v.revision ||
        !synthetic(j.browser) ||
        !['queued', 'sent', 'uncertain', 'needs_human', 'answered', 'failed'].includes(j.state) ||
        typeof j.reconciled !== 'boolean' ||
        (j.dispatches !== 0 && j.dispatches !== 1) ||
        (j.parentContext !== undefined && !validSimulationJobParent(j.parentContext))
      )
        throw Error();
      if (
        j.dispatches === 0
          ? j.state !== 'queued' || j.generation !== null || j.reconciled
          : j.state === 'queued' || !number(j.generation) || !j.generation
      )
        throw Error();
      if (j.reconciled && !['answered', 'failed'].includes(j.state)) throw Error();
      if (j.answer !== null && !(j.reconciled && j.state === 'answered' && synthetic(j.answer))) throw Error();
      if (j.lease !== null) {
        const l = j.lease,
          holder = v.jobs.find((other: any) => other.key === l.key);
        if (
          !record(l) ||
          !number(l.generation) ||
          !l.generation ||
          l.browser !== j.browser ||
          !holder ||
          holder.browser !== j.browser ||
          holder.generation !== l.generation ||
          holder.reconciled ||
          holder.dispatches !== 1 ||
          l.owner !== holder.owner ||
          (j.holderLabel !== undefined && (!synthetic(j.holderLabel) || j.holderLabel !== holder.label))
        )
          throw Error();
      } else if (j.holderLabel !== undefined) throw Error();
      if (
        j.dispatches === 1 &&
        !j.reconciled &&
        (!j.lease || j.lease.key !== key || j.lease.generation !== j.generation)
      )
        throw Error();
      seen.add(key);
      jobs.push({
        key,
        ref: {
          kind: 'jev',
          provider: ref.provider,
          key: ref.key,
          ...(ref.account === undefined ? {} : { account: ref.account }),
        },
        ...(j.parentContext === undefined ? {} : { parentContext: structuredClone(j.parentContext) }),
        state: j.state,
        revision: j.revision,
        browser: j.browser,
        dispatches: j.dispatches,
        generation: j.generation,
        reconciled: j.reconciled,
        answer: j.answer,
        lease: j.lease ? { key: j.lease.key, generation: j.lease.generation } : null,
        ...(j.holderLabel === undefined ? {} : { holderLabel: j.holderLabel }),
      });
    }
    // Custody belongs to the browser, not an account or attached parent. Validate
    // every row before filtering or projecting any parent-specific display edge.
    const holders = new Map<string, SimulationJob>();
    for (const job of jobs) {
      if (job.dispatches === 1 && !job.reconciled) {
        if (holders.has(job.browser)) throw Error();
        holders.set(job.browser, job);
      }
    }
    for (const job of jobs) {
      const holder = holders.get(job.browser);
      if (
        holder
          ? !job.lease || job.lease.key !== holder.key || job.lease.generation !== holder.generation
          : job.lease !== null
      )
        throw Error();
    }
    return normalized({ provenance: 'SIMULATED', availability: 'available', storeId: id, revision: v.revision, jobs });
  } catch {
    return unavailable(id, 'invalid_snapshot');
  }
}
export const canRetainSimulationJobs = (reason: string): boolean =>
  reasons.has(reason) && reason !== 'store_identity_mismatch';

/** Last-known data is allowed only from the same explicitly identified store; never cross-store fallback. */
export function simulationJobDisplayInput(
  current: unknown,
  previous?: unknown
): { status: SimulationJobsStatus; jobs: SimulationJobDisplay[] } {
  const snapshot = simulationJobsSnapshot(current);
  const prior = previous === undefined ? null : simulationJobsSnapshot(previous);
  const accepted =
    snapshot.availability === 'available'
      ? snapshot
      : canRetainSimulationJobs(snapshot.reason) &&
          snapshot.storeId &&
          prior?.availability === 'available' &&
          prior.storeId === snapshot.storeId
        ? prior
        : null;
  const fresh = snapshot.availability === 'available';
  return {
    status: {
      provenance: 'SIMULATED',
      availability: snapshot.availability,
      storeId: snapshot.storeId,
      revision: snapshot.revision,
      lastKnownRevision: !fresh && accepted ? accepted.revision : null,
      reason: fresh ? null : snapshot.reason,
    },
    jobs:
      accepted?.jobs.map((job) => ({
        ...job,
        answer: fresh ? job.answer : null,
        provenance: 'SIMULATED',
        availability: fresh ? 'available' : 'last_known',
        storeId: accepted.storeId,
        storeRevision: accepted.revision,
        reason: fresh ? null : snapshot.reason,
      })) ?? [],
  };
}
