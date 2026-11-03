import { serialize } from 'node:v8';
import { WORKER_PAYLOAD_LIMIT, WORKER_PROTOCOL, type WorkerFatal, type WorkerResult } from './worker-protocol.js';
const hash = /^[a-f0-9]{64}$/;
const incarnationPattern = /^[a-f0-9-]{36}$/;
const reasons = new Set([
  'retirement_owed_context_superseded',
  'retirement_context_superseded',
  'retirement_lease_invalidated',
  'source_publication_debt_invalidated',
  'collector_closed_unaccepted',
  'reader_authority_retired',
  'publication_lease_invalidated',
]);
const errors = new Set([
  'worker_metadata_limit',
  'worker_protocol_failure',
  'worker_startup_failure',
  'worker_failure',
]);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const obj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
export function validCommits(v: unknown): v is WorkerFatal['commits'] {
  return (
    Array.isArray(v) &&
    v.length <= 1 &&
    v.every(
      (c) =>
        obj(c) &&
        Object.keys(c).length === 2 &&
        typeof c.refKey === 'string' &&
        hash.test(c.refKey) &&
        count(c.commitSeq) &&
        c.commitSeq > 0
    )
  );
}
export function validLifecycles(v: unknown): v is WorkerFatal['lifecycles'] {
  return (
    Array.isArray(v) &&
    v.length <= 216 &&
    v.every(
      (c) =>
        obj(c) &&
        Object.keys(c).length === 2 &&
        typeof c.refKey === 'string' &&
        hash.test(c.refKey) &&
        reasons.has(c.reason)
    )
  );
}
export function compactOutcomes(commits: unknown, lifecycles: unknown) {
  const c = validCommits(commits),
    l = validLifecycles(lifecycles);
  return {
    commits: c ? commits : [],
    lifecycles: l ? lifecycles : [],
    accountingComplete: c && l,
    commitCount: Array.isArray(commits) ? commits.length : 0,
    lifecycleCount: Array.isArray(lifecycles) ? lifecycles.length : 0,
  };
}
export function makeWorkerFatal(
  incarnation: string,
  requestId: number | null,
  error: WorkerFatal['error'],
  commits: unknown = [],
  lifecycles: unknown = []
): WorkerFatal {
  const message: WorkerFatal = {
    type: 'fatal',
    version: WORKER_PROTOCOL,
    incarnation,
    requestId,
    error,
    ...compactOutcomes(commits, lifecycles),
  };
  if (!validWorkerFatal(message)) throw new Error('worker_control_invariant');
  return message;
}
export function validWorkerFatal(v: unknown): v is WorkerFatal {
  if (
    !obj(v) ||
    Object.keys(v).some(
      (k) =>
        ![
          'type',
          'version',
          'incarnation',
          'requestId',
          'error',
          'commits',
          'lifecycles',
          'accountingComplete',
          'commitCount',
          'lifecycleCount',
        ].includes(k)
    )
  )
    return false;
  return (
    v.type === 'fatal' &&
    v.version === WORKER_PROTOCOL &&
    typeof v.incarnation === 'string' &&
    incarnationPattern.test(v.incarnation) &&
    (v.requestId === null || count(v.requestId)) &&
    errors.has(v.error) &&
    typeof v.accountingComplete === 'boolean' &&
    validCommits(v.commits) &&
    validLifecycles(v.lifecycles) &&
    count(v.commitCount) &&
    count(v.lifecycleCount) &&
    (!v.accountingComplete || (v.commitCount === v.commits.length && v.lifecycleCount === v.lifecycles.length)) &&
    serialize(v).byteLength <= WORKER_PAYLOAD_LIMIT
  );
}
/** Null→ArrayBuffer adds a type tag and bounded varint length.64 bytes conservatively covers that framing. */
export function resultWireUpperBound(result: Pick<WorkerResult, 'payload'> & object): number {
  return serialize({ ...result, payload: null }).byteLength + (result.payload?.byteLength ?? 0) + 64;
}
