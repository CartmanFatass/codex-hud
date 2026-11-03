import type { WorkerResult } from './worker-protocol.js';
import { validLifecycles } from './worker-control.js';
const obj = (v: any) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
const finite = (v: any) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const count = (v: any) => Number.isSafeInteger(v) && v >= 0;
const nullableText = (v: any) => v === null || typeof v === 'string';
const shape = (v: any, allowed: string, required = allowed) =>
  obj(v) &&
  Object.keys(v).every((k) => allowed.split(' ').includes(k)) &&
  required
    .split(' ')
    .filter(Boolean)
    .every((k) => Object.hasOwn(v, k));
/** Validate the closed header, including every nested scalar consumed by adoption/accounting. */
export function validWorkerEnvelope(v: any): v is WorkerResult {
  if (
    !shape(
      v,
      'type codec version incarnation scope scopeEpoch requestId revision unchanged payload ledgerObservedAt stats trace resources publication error'
    ) ||
    v.type !== 'result' ||
    !count(v.version) ||
    typeof v.codec !== 'string' ||
    typeof v.incarnation !== 'string' ||
    !nullableText(v.scope) ||
    !count(v.scopeEpoch) ||
    !count(v.requestId) ||
    !count(v.revision) ||
    typeof v.unchanged !== 'boolean' ||
    !(v.payload === null || v.payload instanceof ArrayBuffer) ||
    !(v.ledgerObservedAt === null || finite(v.ledgerObservedAt)) ||
    !nullableText(v.error)
  )
    return false;
  const t = v.trace,
    r = v.resources,
    p = v.publication;
  if (
    !shape(
      t,
      'enqueuedAt activatedAt startedAt collectedAt postedAt encodedAt stages superseded root commits lifecycles'
    ) ||
    !['enqueuedAt', 'activatedAt', 'startedAt', 'collectedAt', 'postedAt', 'encodedAt'].every((k) => finite(t[k])) ||
    !count(t.superseded) ||
    !shape(t.root, 'bytesRead recordsRead elapsedMs failed', 'bytesRead recordsRead elapsedMs') ||
    !count(t.root.bytesRead) ||
    !count(t.root.recordsRead) ||
    !finite(t.root.elapsedMs) ||
    (t.root.failed !== undefined && typeof t.root.failed !== 'boolean') ||
    !shape(t.stages, 'collectionMs publishMs recoveryMs decodeMs headMs leaseMs prepareMs publishCallMs') ||
    !Object.values(t.stages).every(finite) ||
    !Array.isArray(t.commits) ||
    t.commits.length > 1 ||
    !validLifecycles(t.lifecycles)
  )
    return false;
  if (
    t.commits.some(
      (c: any) =>
        !shape(c, 'refKey commitSeq stamp beforeAt returnedAt ackAt') ||
        typeof c.refKey !== 'string' ||
        !/^[a-f0-9]{64}$/.test(c.refKey) ||
        !count(c.commitSeq) ||
        c.commitSeq < 1 ||
        !finite(c.beforeAt) ||
        !finite(c.returnedAt) ||
        !(c.ackAt === null || finite(c.ackAt)) ||
        !shape(c.stamp, 'seqDomain sourceGeneration runId bindingGeneration', 'seqDomain sourceGeneration') ||
        typeof c.stamp.seqDomain !== 'string' ||
        !count(c.stamp.sourceGeneration) ||
        c.stamp.sourceGeneration < 1 ||
        (c.stamp.runId !== undefined && typeof c.stamp.runId !== 'string') ||
        (c.stamp.bindingGeneration !== undefined &&
          (!count(c.stamp.bindingGeneration) || c.stamp.bindingGeneration < 1))
    )
  )
    return false;
  const resourceKeys =
    'readers pinnedReaders evictions metadata blocked retiring retirementBlocked heapUsed heapTotal external arrayBuffers rss payloadBytes cpuUser cpuSystem';
  if (
    !shape(
      r,
      resourceKeys,
      'readers pinnedReaders evictions metadata blocked heapUsed heapTotal external arrayBuffers rss payloadBytes cpuUser cpuSystem'
    ) ||
    ![
      'readers',
      'pinnedReaders',
      'evictions',
      'metadata',
      'heapUsed',
      'heapTotal',
      'external',
      'arrayBuffers',
      'rss',
      'payloadBytes',
    ].every((k) => count(r[k])) ||
    !nullableText(r.blocked) ||
    !['cpuUser', 'cpuSystem'].every((k) => r[k] === null || count(r[k])) ||
    !['retiring', 'retirementBlocked'].every((k) => r[k] === undefined || count(r[k])) ||
    !shape(p, 'attempted changed error') ||
    typeof p.attempted !== 'boolean' ||
    typeof p.changed !== 'boolean' ||
    !nullableText(p.error)
  )
    return false;
  if (v.stats !== null) {
    const s = v.stats;
    if (
      !shape(
        s,
        'totalMs b9Ms wiringMs bytesRead recordsRead projected ledgerReads highWaterChecks immediateMerges eligibleBacklog oldestEligibleWaitMs readGrant',
        'totalMs b9Ms wiringMs bytesRead recordsRead projected ledgerReads highWaterChecks immediateMerges'
      ) ||
      !['totalMs', 'b9Ms', 'wiringMs'].every((k) => finite(s[k])) ||
      !['bytesRead', 'recordsRead', 'ledgerReads', 'highWaterChecks', 'immediateMerges'].every((k) => count(s[k])) ||
      typeof s.projected !== 'boolean' ||
      !(s.eligibleBacklog === undefined || count(s.eligibleBacklog)) ||
      !(s.oldestEligibleWaitMs === undefined || finite(s.oldestEligibleWaitMs))
    )
      return false;
    if (
      s.readGrant !== undefined &&
      (!shape(s.readGrant, 'key kind waitMs') ||
        typeof s.readGrant.key !== 'string' ||
        !['session', 'native_topology'].includes(s.readGrant.kind) ||
        !finite(s.readGrant.waitMs))
    )
      return false;
  }
  return true;
}
