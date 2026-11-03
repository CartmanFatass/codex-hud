import type { ReaderBudget } from '../interfaces/harness-adapter.js';
import type { LinkTickStats } from './tick.js';

export const WORKER_PROTOCOL = 1;
export const WORKER_PAYLOAD_LIMIT = 2 * 1024 * 1024;
export const WORKER_EXTERNAL_LIMIT = 24 * 1024 * 1024;
export const WORKER_READER_LIMIT = 16;
export const WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 };
export const SHARED_READ_BYTES = 8 * 1024 * 1024;
export const ROOT_READ_BYTES = 4 * 1024 * 1024;

/** A shared monotonic clock across threads; never use epoch read clocks as scheduling timestamps. */
export const monotonicNow = (): number => Number(process.hrtime.bigint()) / 1_000_000;

export interface RootReadCharge {
  bytesRead: number;
  recordsRead: number;
  elapsedMs: number;
  failed?: boolean;
}
export interface WorkerOperation {
  type: 'collect';
  version: 1;
  incarnation: string;
  scope: string | null;
  scopeEpoch: number;
  requestId: number;
  enqueuedAt: number;
  activatedAt: number;
  deadlineAt: number;
  budget: ReaderBudget;
  root: RootReadCharge;
  superseded: number;
  fullView?: boolean;
}
export interface CommitTrace {
  refKey: string;
  commitSeq: number;
  stamp: { seqDomain: string; sourceGeneration: number; runId?: string; bindingGeneration?: number };
  beforeAt: number;
  returnedAt: number;
  ackAt: number | null;
}
export interface WorkerStageTimes {
  collectionMs: number;
  publishMs: number;
  recoveryMs: number;
  decodeMs: number;
  headMs: number;
  leaseMs: number;
  prepareMs: number;
  publishCallMs: number;
}
export interface OperationTrace {
  enqueuedAt: number;
  activatedAt: number;
  startedAt: number;
  collectedAt: number;
  postedAt: number;
  encodedAt: number;
  stages: WorkerStageTimes;
  superseded: number;
  root: RootReadCharge;
  commits: CommitTrace[];
  lifecycles: { refKey: string; reason: string }[];
}
export interface WorkerResources {
  readers: number;
  pinnedReaders: number;
  evictions: number;
  metadata: number;
  blocked: string | null;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  rss: number;
  payloadBytes: number;
  cpuUser: number | null;
  cpuSystem: number | null;
}
export interface WorkerResult {
  type: 'result';
  codec: 'v8-1';
  version: 1;
  incarnation: string;
  scope: string | null;
  scopeEpoch: number;
  requestId: number;
  revision: number;
  unchanged: boolean;
  payload: ArrayBuffer | null;
  ledgerObservedAt: number | null;
  stats: Readonly<LinkTickStats> | null;
  trace: OperationTrace;
  resources: WorkerResources;
  publication: { attempted: boolean; changed: boolean; error: string | null };
  error: string | null;
}
export type WorkerInput =
  WorkerOperation | { type: 'ack'; incarnation: string; requestId: number } | { type: 'close'; incarnation: string };
export interface WorkerFatal {
  type: 'fatal';
  version: 1;
  incarnation: string;
  requestId: number | null;
  error: 'worker_metadata_limit' | 'worker_protocol_failure' | 'worker_startup_failure' | 'worker_failure';
  commits: { refKey: string; commitSeq: number }[];
  lifecycles: { refKey: string; reason: string }[];
  accountingComplete: boolean;
  commitCount: number;
  lifecycleCount: number;
}
export type WorkerOutput =
  | WorkerResult
  | { type: 'ready'; incarnation: string; limits: typeof WORKER_RESOURCE_LIMITS }
  | {
      type: 'closed';
      incarnation: string;
      at: number;
      dirty: boolean;
      accountingComplete: boolean;
      lifecycleCount: number;
      lifecycleOutcomes: { refKey: string; reason: string }[];
    }
  | WorkerFatal;
export interface WorkerStartup {
  version: 1;
  incarnation: string;
  hudHome: string;
  ambientHome?: string;
  testModule?: string;
  testData?: unknown;
}
