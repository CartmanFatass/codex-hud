/** Job-card authority. No native identities or permissions are synthesized here. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseAssociation } from '../../roles/association.js';
import { parseDispatchStatus } from '../../roles/pi-dispatch-status.js';
import { validDispatch } from '../../roles/pi-dispatch.js';
import { parseRosterRoot } from '../../roles/selection.js';
import { selfStamp, validStamp } from '../../roles/pi-owned/runtime.js';
import { processState } from '../run/process.js';
import type { Coverage } from '../types/observation.js';
import type { ResolvedRecipient } from './index.js';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k)) && keys.every((k) => Object.hasOwn(v, k));
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export const JOB_FIELDS = [
  'goal',
  'test_heading',
  'owned_path',
  'public_output',
  'review',
  'question',
  'report',
] as const;
export type JobField = (typeof JOB_FIELDS)[number];
export interface JobMaterialPolicy {
  schemaVersion: 1;
  revision: number;
  scope: { version: 1; fields: readonly JobField[]; facade: boolean; external: boolean; excludedRoots: string[] };
  grants: {
    purpose: 'job_card';
    recipientId: string;
    decision: 'allow' | 'deny';
    revision: number;
    grantedAt: number;
  }[];
}
export function parseJobPolicy(value: unknown): JobMaterialPolicy | null {
  if (
    !record(value) ||
    !exact(value, ['schemaVersion', 'revision', 'scope', 'grants']) ||
    value.schemaVersion !== 1 ||
    !revision(value.revision)
  )
    return null;
  const s = value.scope;
  if (
    !record(s) ||
    !exact(s, ['version', 'fields', 'facade', 'external', 'excludedRoots']) ||
    s.version !== 1 ||
    typeof s.facade !== 'boolean' ||
    typeof s.external !== 'boolean' ||
    !Array.isArray(s.fields) ||
    s.fields.length !== JOB_FIELDS.length ||
    !JOB_FIELDS.every((f) => (s.fields as unknown[]).includes(f)) ||
    !Array.isArray(s.excludedRoots) ||
    s.excludedRoots.length > 200
  )
    return null;
  try {
    for (const root of s.excludedRoots) {
      if (typeof root !== 'string') return null;
      parseRosterRoot(root);
    }
  } catch {
    return null;
  }
  if (!Array.isArray(value.grants) || value.grants.length > 200) return null;
  const seen = new Set<string>();
  for (const g of value.grants) {
    if (
      !record(g) ||
      !exact(g, ['purpose', 'recipientId', 'decision', 'revision', 'grantedAt']) ||
      g.purpose !== 'job_card' ||
      typeof g.recipientId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(g.recipientId) ||
      !['allow', 'deny'].includes(String(g.decision)) ||
      !revision(g.revision) ||
      !revision(g.grantedAt) ||
      seen.has(g.recipientId)
    )
      return null;
    seen.add(g.recipientId);
  }
  // SAFETY: every required property and nested grant was validated above; no unknown keys survive.
  return value as unknown as JobMaterialPolicy;
}
export interface JobIdentity {
  home: string;
  root: string;
  invocation: string;
  episode: string;
}
export interface JobHelperIdentity {
  slot: string;
  sessionId: string;
  statusLocator: string;
}
export interface JobFragment {
  id: string;
  field: JobField;
  text: string;
  locator: string;
  truncated?: boolean;
  helper?: JobHelperIdentity;
}
export interface JobMaterialSubject {
  kind: 'job';
  identity: JobIdentity;
  budget?: JobReadBudget;
  /** Runs only after grant and source checks; use JobPublicOutputAdapter, not arbitrary files. */
  read: () => { fragments: JobFragment[]; coverage: Coverage };
}
export interface JobMaterialEnvelope {
  kind: 'job';
  version: 1;
  identity: JobIdentity;
  fragments: {
    text: string;
    provenance: {
      kind: 'job';
      identity: JobIdentity;
      field: JobField;
      locator: string;
      id: string;
      recordFingerprint: string;
      truncated: boolean;
      helper?: JobHelperIdentity;
    }[];
  }[];
  sources: string[];
  /** Relative contributing files bound to their device/inode/ancestor identity, never raw tails. */
  sourceIdentities: Record<string, string>;
  purpose: 'job_card';
  recipientId: string;
  policyRevision: Record<string, number>;
  fingerprint: string;
  coverage: Coverage;
  cacheDomain: string;
}
export interface JobBuildInput {
  kind: 'job';
  purpose: 'job_card';
  subject: JobMaterialSubject;
  authority: JobMaterialAuthority;
  resolvedRecipient: ResolvedRecipient | null;
  limits: { maxBytes: number; maxFragments?: number };
  budget?: JobReadBudget;
}
export type JobPending = { pending: true; reason: 'budget' };
export class JobBudgetPending extends Error {
  constructor() {
    super('job_budget_pending');
  }
}
export function rethrowJobBudget(error: unknown): void {
  if (error instanceof JobBudgetPending) throw error;
}
let activeBudget: JobReadBudget | undefined;
export function withJobBudget<T>(budget: JobReadBudget | undefined, fn: () => T): T {
  if (activeBudget) return fn();
  activeBudget = budget ?? jobReadBudget();
  invalidateJobPaths();
  try {
    return fn();
  } finally {
    activeBudget = undefined;
  }
}
export function hasJobBudget(): boolean {
  return activeBudget !== undefined;
}
export function currentJobBudget(): JobReadBudget {
  return activeBudget ?? jobReadBudget();
}
export interface JobReadBudget {
  files: number;
  bytes: number;
  maxFiles: number;
  maxBytes: number;
  deadline?: number;
  probes?: number;
  maxProbes?: number;
  entries?: number;
  maxEntries?: number;
}
export const jobReadBudget = (): JobReadBudget => ({
  files: 0,
  bytes: 0,
  maxFiles: 32,
  maxBytes: 1024 * 1024,
  probes: 0,
  maxProbes: 2048,
  entries: 0,
  maxEntries: 128,
});
let pathMemos = new WeakMap<JobReadBudget, Map<string, fs.Stats>>();
/** Evidence never crosses a callback/body-read boundary. */
export function invalidateJobPaths(): void {
  pathMemos = new WeakMap();
}
/** Two full consent/source fences: five metadata bodies per pass, no public material reads. */
export const JOB_DISPATCH_FENCE_LIMITS = Object.freeze({
  maxFiles: 10,
  maxBytes: 2 * (4 * 65536 + 16384),
  maxProbes: 256,
  maxEntries: 256,
});
export function jobDispatchBudget(): JobReadBudget {
  return { ...jobReadBudget(), ...JOB_DISPATCH_FENCE_LIMITS };
}
const dispatchScopes = new WeakSet<JobReadBudget>();
export function withJobDispatchBudget<T>(budget: JobReadBudget, fn: () => T): T {
  const nested = dispatchScopes.has(budget);
  dispatchScopes.add(budget);
  const previous = activeBudget;
  activeBudget = budget;
  invalidateJobPaths();
  const before = { files: budget.files, bytes: budget.bytes, probes: budget.probes ?? 0, entries: budget.entries ?? 0 };
  jobFileMetrics.dispatch.checks++;
  try {
    return fn();
  } finally {
    if (!nested) {
      for (const key of ['files', 'bytes', 'probes', 'entries'] as const)
        jobFileMetrics.dispatch[key] += (budget[key] ?? 0) - before[key];
      dispatchScopes.delete(budget);
    }
    activeBudget = previous;
    invalidateJobPaths();
  }
}
/** Explicit permission control, never a collection slice: two bounded bodies and their
 * ancestor walks plus owner checks (Linux PATH_MAX permits at most 2048 one-character components). */
export const JOB_CONSENT_WRITE_LIMITS = Object.freeze({
  maxFiles: 2,
  maxBytes: 65536 + 4096,
  maxProbes: 5 * 2048 + 64,
  maxEntries: 0,
});
function withConsentWriteBudget<T>(fn: () => T): T {
  const previous = activeBudget;
  const budget = { ...jobReadBudget(), ...JOB_CONSENT_WRITE_LIMITS };
  activeBudget = budget;
  invalidateJobPaths();
  jobFileMetrics.consentWrite.checks++;
  try {
    return fn();
  } catch (error) {
    if (error instanceof Error && error.message === 'consent_busy') {
      jobFileMetrics.consentWrite.busy++;
      throw error;
    }
    jobFileMetrics.consentWrite.ioErrors++;
    if (error instanceof JobBudgetPending)
      throw Object.assign(new Error('consent_write_io', { cause: error }), { code: 'EIO' });
    if (error instanceof Error && !(error as NodeJS.ErrnoException).code) Object.assign(error, { code: 'EIO' });
    throw error;
  } finally {
    for (const key of ['files', 'bytes', 'probes', 'entries'] as const)
      jobFileMetrics.consentWrite[key] += budget[key] ?? 0;
    activeBudget = previous;
    invalidateJobPaths();
  }
}
function consentWrite<T>(fn: () => T, bytes = 0): T {
  jobFileMetrics.consentWrite.writeAttempts++;
  jobFileMetrics.consentWrite.requestedWriteBytes += bytes;
  return fn();
}
function consentOwner<T>(fn: () => T): T {
  jobFileMetrics.consentWrite.ownerChecks++;
  try {
    return fn();
  } finally {
    invalidateJobPaths();
  }
}
function consentExists(file: string): boolean {
  try {
    statPath(file, currentJobBudget(), true);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function checkDeadline(budget: JobReadBudget): void {
  if (budget.deadline !== undefined && performance.now() >= budget.deadline) throw new JobBudgetPending();
}
function probe(budget: JobReadBudget): void {
  checkDeadline(budget);
  if ((budget.probes ?? 0) >= (budget.maxProbes ?? 2048)) throw new JobBudgetPending();
  budget.probes = (budget.probes ?? 0) + 1;
  jobFileMetrics.probes++;
}
function statPath(file: string, budget: JobReadBudget, fresh = false): fs.Stats {
  checkDeadline(budget);
  let memo = pathMemos.get(budget);
  if (!memo) pathMemos.set(budget, (memo = new Map()));
  if (!fresh && memo.has(file)) return memo.get(file)!;
  probe(budget);
  const stat = fs.lstatSync(file);
  memo.set(file, stat);
  return stat;
}
function statFd(fd: number, budget: JobReadBudget): fs.Stats {
  probe(budget);
  return fs.fstatSync(fd);
}
const inode = (s: fs.Stats) => `${s.dev}:${s.ino}:${s.birthtimeMs}`;
/** Aggregate metadata cost for offline diagnostics; never reset by a collector. */
export const jobFileMetrics = {
  probes: 0,
  consentWrite: {
    label: 'consent-write',
    checks: 0,
    files: 0,
    bytes: 0,
    probes: 0,
    entries: 0,
    writeAttempts: 0,
    requestedWriteBytes: 0,
    ownerChecks: 0,
    busy: 0,
    ioErrors: 0,
  },
  dispatch: { checks: 0, files: 0, bytes: 0, probes: 0, entries: 0, pendingBeforeReserve: 0, pendingAfterReserve: 0 },
};
export const jobFileStamp = (s: fs.Stats) => `${inode(s)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
/** Reject all symlink components, not just the leaf; pin and recheck every ancestor. */
export function safeJobPath(
  file: string,
  budget = currentJobBudget(),
  fresh = false
): { stat: fs.Stats; chain: string } {
  if (!path.isAbsolute(file) || file.split(path.sep).includes('..') || path.resolve(file) !== file)
    throw new Error('unsafe_path');
  let current = path.parse(file).root;
  const stamps: string[] = [];
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const s = statPath(current, budget, fresh && current === file);
    if (s.isSymbolicLink() || (current !== file && !s.isDirectory())) throw new Error('unsafe_path');
    stamps.push(inode(s));
  }
  return { stat: statPath(file, budget), chain: stamps.join('/') };
}
/** Bounded positional read; never readFile on a potentially replaced FIFO/device. */
export function readJobFile(
  file: string,
  cap: number,
  budget: JobReadBudget,
  tail = false
): { text: string; truncated: boolean; stamp: string; chain: string } {
  budget = activeBudget ?? budget;
  if (budget.files >= budget.maxFiles || (budget.deadline !== undefined && performance.now() >= budget.deadline))
    throw new JobBudgetPending();
  const before = safeJobPath(file, budget);
  if (!before.stat.isFile()) throw new Error('unsafe_file');
  const amount = Math.min(before.stat.size, cap);
  if (budget.bytes + amount > budget.maxBytes) throw new JobBudgetPending();
  const postReadProbes = file.slice(path.parse(file).root.length).split(path.sep).filter(Boolean).length + 2;
  if ((budget.probes ?? 0) + postReadProbes > (budget.maxProbes ?? 2048)) throw new JobBudgetPending();
  checkDeadline(budget);
  budget.files++;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const s = statFd(fd, budget);
    if (!s.isFile() || jobFileStamp(s) !== jobFileStamp(before.stat)) throw new Error('replaced');
    const buffer = Buffer.alloc(amount);
    let n = 0;
    while (n < amount) {
      checkDeadline(budget);
      const got = fs.readSync(fd, buffer, n, amount - n, tail ? s.size - amount + n : n);
      invalidateJobPaths();
      budget.bytes += got;
      if (!got) break;
      n += got;
    }
    const after = safeJobPath(file, budget, true);
    if (
      after.chain !== before.chain ||
      jobFileStamp(after.stat) !== jobFileStamp(s) ||
      jobFileStamp(statFd(fd, budget)) !== jobFileStamp(s)
    )
      throw new Error('replaced');
    return {
      text: buffer.subarray(0, n).toString('utf8'),
      truncated: s.size > amount,
      stamp: jobFileStamp(s),
      chain: before.chain,
    };
  } finally {
    fs.closeSync(fd);
    invalidateJobPaths();
  }
}
interface Pin {
  identity: JobIdentity;
  directory: string;
  chain: string;
  session: string | null;
  continuation: string;
  sessionChain: string | null;
  sessionFile: string | null;
  directSession: string | null;
  continuationPending: boolean;
  reportEligible: boolean;
  files: Map<string, string>;
}
const minted = new WeakMap<JobMaterialEnvelope, { policy: string; files: [string, string][] }>();
export function freezeJobValue<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJobValue(child);
    Object.freeze(value);
  }
  return value;
}
const prepared = new WeakMap<object, Map<string, JobMaterialEnvelope>>();
export class JobMaterialAuthority {
  readonly home: string;
  private readonly homeChain: string;
  private policyCache?: { stamp: string; value: JobMaterialPolicy | null };
  private knownRevision?: number;
  knownInvalid(envelope: JobMaterialEnvelope): boolean {
    return this.knownRevision !== undefined && envelope.policyRevision[envelope.identity.home] < this.knownRevision;
  }
  private readonly jsonCache = new Map<string, { stamp: string; value: Record<string, unknown> | null }>();
  private readonly pins = new Map<string, Pin>();
  // 1248 file pins + 600 JSON signatures + 200 direct-directory signatures = 2048 entries.
  private pinnedFiles = 0;
  /** Metadata/body accounting is exposed for synthetic cost assertions, never source text. */
  readonly reads = { files: 0, bytes: 0, entries: 0 };
  private readonly directCache = new Map<string, { stamp: string; file: string | null }>();
  private discovery?: { dir: string; stamp: string; handle: fs.Dir; file: string | null; count: number };
  /** Releases the one bounded resumable discovery cursor; no watcher/service exists. */
  dispose(): void {
    this.discovery?.handle.closeSync();
    this.discovery = undefined;
  }
  private directSession(directory: string): string | null {
    try {
      const dir = path.join(directory, 'sessions'),
        s = safeJobPath(dir);
      if (!s.stat.isDirectory()) return null;
      const stamp = jobFileStamp(s.stat) + s.chain,
        hit = this.directCache.get(dir);
      if (hit?.stamp === stamp) return hit.file;
      if (this.discovery && (this.discovery.dir !== dir || this.discovery.stamp !== stamp)) this.dispose();
      const progress = (this.discovery ??= { dir, stamp, handle: fs.opendirSync(dir), file: null, count: 0 });
      const budget = currentJobBudget();
      for (;;) {
        checkDeadline(budget);
        if ((budget.entries ?? 0) >= (budget.maxEntries ?? 128)) throw new JobBudgetPending();
        budget.entries = (budget.entries ?? 0) + 1;
        this.reads.entries++;
        const entry = progress.handle.readSync();
        invalidateJobPaths();
        if (!entry) break;
        if (++progress.count >= 128) {
          progress.file = null;
          break;
        }
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          if (progress.file) {
            progress.file = null;
            break;
          }
          progress.file = path.join(dir, entry.name);
        }
      }
      const file = progress.file;
      this.dispose();
      const after = safeJobPath(dir, budget, true);
      if (after.chain !== s.chain || jobFileStamp(after.stat) !== jobFileStamp(s.stat)) return null;
      this.directCache.set(dir, { stamp, file });
      while (this.directCache.size > 200) this.directCache.delete(this.directCache.keys().next().value!);
      return file;
    } catch (error) {
      rethrowJobBudget(error);
      this.dispose();
      return null;
    }
  }
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** P3b calls this off-tick after observing a policy change; no watcher/service is installed. */
  refresh(): void {
    invalidateJobPaths();
    this.policyCache = undefined;
    this.dispose();
    for (const listener of this.listeners) listener();
  }
  constructor(home: string) {
    this.home = fs.realpathSync(home);
    this.homeChain = safeJobPath(this.home).chain;
  }
  private json(file: string, cap: number): Record<string, unknown> | null {
    const s = safeJobPath(file);
    if (!s.stat.isFile() || s.stat.size > cap) return null;
    const stamp = jobFileStamp(s.stat) + s.chain;
    const hit = this.jsonCache.get(file);
    if (hit?.stamp === stamp) return hit.value;
    const budget = currentJobBudget();
    const files = budget.files,
      bytes = budget.bytes;
    let r: ReturnType<typeof readJobFile>;
    try {
      r = readJobFile(file, cap, budget);
    } finally {
      this.reads.files += budget.files - files;
      this.reads.bytes += budget.bytes - bytes;
    }
    let value: Record<string, unknown> | null = null;
    try {
      const raw: unknown = JSON.parse(r.text);
      if (record(raw)) {
        const keys =
          path.basename(file) === 'receipt.json'
            ? [
                'schema',
                'job',
                'parent',
                'role',
                'phase',
                'preset',
                'binding',
                'executor',
                'state',
                'pi_dispatch',
                'continuation',
              ]
            : path.basename(file) === 'STATUS.json'
              ? [
                  'version',
                  'task_dir',
                  'slot',
                  'role',
                  'output_path',
                  'state',
                  'output_written',
                  'session_id',
                  'session_file',
                  'model',
                  'thinking',
                  'settled_at',
                  'idle_deadline_at',
                  'ended_at',
                  'error',
                  'exit_reason',
                  'helper_pending',
                ]
              : Object.keys(raw);
        value = Object.fromEntries(keys.filter((k) => Object.hasOwn(raw, k)).map((k) => [k, raw[k]]));
      }
    } catch {
      /* Malformed JSON denies. */
    }
    this.jsonCache.set(file, { stamp, value });
    while (this.jsonCache.size > 600) this.jsonCache.delete(this.jsonCache.keys().next().value!);
    return value;
  }
  policy(budget?: JobReadBudget): JobMaterialPolicy | null {
    if (!activeBudget) return withJobBudget(budget, () => this.policy());
    try {
      if (safeJobPath(this.home).chain !== this.homeChain) return null;
      const file = path.join(this.home, 'job-materials-v1', 'policy.json');
      const s = safeJobPath(file);
      if (!s.stat.isFile() || s.stat.size > 65536 || s.stat.mode & 0o077) return null;
      const stamp = jobFileStamp(s.stat) + s.chain;
      if (this.policyCache?.stamp === stamp) return this.policyCache.value;
      const value = parseJobPolicy(this.json(file, 65536));
      this.policyCache = { stamp, value };
      return value;
    } catch (error) {
      rethrowJobBudget(error);
      return null;
    }
  }
  private source(invocation: string, root: string): Omit<Pin, 'identity' | 'files'> | null {
    try {
      if (!/^j[a-f0-9]{16}$/.test(invocation) || safeJobPath(this.home).chain !== this.homeChain) return null;
      parseRosterRoot(root);
      const a = parseAssociation(this.json(path.join(this.home, 'assoc', `${invocation}.json`), 16384), invocation);
      if (!a || a.root !== root) return null;
      const directory = path.join(this.home, 'jobs', invocation);
      const d = safeJobPath(directory);
      if (!d.stat.isDirectory()) return null;
      const r = this.json(path.join(directory, 'receipt.json'), 65536);
      if (
        !record(r) ||
        r.schema !== 1 ||
        r.job !== invocation ||
        r.parent !== root ||
        r.role !== a.role ||
        r.phase !== a.phase ||
        r.preset !== a.preset ||
        !record(r.binding) ||
        !record(r.executor) ||
        r.executor.kind !== a.backend.executor
      )
        return null;
      for (const k of ['id', 'executor', 'harness', 'model', 'effort', 'env_profile', 'recipe'] as const)
        if (r.binding[k] !== a.backend[k]) return null;
      let session: string | null = null;
      let sessionChain: string | null = null;
      let sessionFile: string | null = null;
      let directSession: string | null = null;
      let continuationPending = false;
      let reportEligible = ['done', 'closed'].includes(String(r.state));
      if (r.pi_dispatch !== undefined) {
        if (!validDispatch(r.pi_dispatch, a.role, directory)) return null;
        const raw = this.json(path.join(directory, 'STATUS.json'), 65536);
        const status = parseDispatchStatus(
          raw,
          directory,
          'primary',
          r.pi_dispatch.role as string,
          path.join(directory, 'report.md')
        );
        if (!status) return null;
        session = status.session_id;
        const c = r.pi_dispatch.continuation;
        continuationPending =
          !!c && (status.session_id !== c.previous_session_id || status.settled_at === c.previous_settled_at);
        reportEligible = status.output_written && !continuationPending;
        if (record(raw) && typeof raw.session_file === 'string' && raw.session_file.startsWith(directory + path.sep)) {
          try {
            const file = safeJobPath(raw.session_file);
            if (file.stat.isFile()) {
              sessionChain = file.chain;
              sessionFile = raw.session_file;
            }
          } catch (error) {
            rethrowJobBudget(error);
            /* Unsafe locator is artifact-only. */
          }
        }
      } else if (a.backend.harness === 'pi') {
        directSession = this.directSession(directory);
        if (directSession) {
          try {
            const s = safeJobPath(directSession);
            if (s.stat.isFile()) sessionChain = s.chain;
          } catch (error) {
            rethrowJobBudget(error);
            directSession = null;
          }
        }
      }
      return {
        directory,
        chain: d.chain,
        session,
        sessionChain,
        sessionFile,
        directSession,
        continuationPending,
        reportEligible,
        continuation: JSON.stringify(
          record(r.pi_dispatch) ? (r.pi_dispatch.continuation ?? null) : (r.continuation ?? null)
        ),
      };
    } catch (error) {
      rethrowJobBudget(error);
      return null;
    }
  }
  /** Metadata-only facade admission. A workspace directory is not an accepted input. */
  capture(invocation: string, root: string, budget?: JobReadBudget): JobIdentity | null {
    if (!activeBudget) return withJobBudget(budget, () => this.capture(invocation, root));
    const s = this.source(invocation, root);
    if (!s) return null;
    const identity = {
      home: hash(this.home),
      root,
      invocation,
      episode: hash([s.chain, s.session, s.continuation, s.sessionChain]),
    };
    const key = JSON.stringify(identity);
    if (!this.pins.has(key)) this.pins.set(key, { ...s, identity, files: new Map() });
    while (this.pins.size > 200) {
      const oldest = this.pins.keys().next().value!;
      this.pinnedFiles -= this.pins.get(oldest)!.files.size;
      this.pins.delete(oldest);
    }
    return { ...identity };
  }
  publicSource(identity: JobIdentity): {
    directSession: string | null;
    continuationPending: boolean;
    reportEligible: boolean;
    sessionFile: string | null;
    sessionId: string | null;
  } | null {
    if (!activeBudget) return withJobBudget(undefined, () => this.publicSource(identity));
    if (!this.current(identity)) return null;
    const source = this.source(identity.invocation, identity.root);
    return source
      ? {
          directSession: source.directSession,
          continuationPending: source.continuationPending,
          reportEligible: source.reportEligible,
          sessionFile: source.sessionFile,
          sessionId: source.session,
        }
      : null;
  }
  directory(identity: JobIdentity): string | null {
    return this.pins.get(JSON.stringify(identity))?.directory ?? null;
  }
  current(identity: JobIdentity): boolean {
    if (!activeBudget) return withJobBudget(undefined, () => this.current(identity));
    const pin = this.pins.get(JSON.stringify(identity));
    if (!pin) return false;
    const s = this.source(identity.invocation, identity.root);
    if (
      !s ||
      s.chain !== pin.chain ||
      s.session !== pin.session ||
      s.continuation !== pin.continuation ||
      s.sessionChain !== pin.sessionChain
    )
      return false;
    return true;
  }
  /** Bind contributing file identities; atomic source replacement invalidates old requests. */
  pinFile(identity: JobIdentity, relative: string, expected?: string | false): boolean {
    if (!activeBudget) return withJobBudget(undefined, () => this.pinFile(identity, relative, expected));
    const p = this.pins.get(JSON.stringify(identity));
    if (!p || path.isAbsolute(relative) || relative.split('/').includes('..')) return false;
    try {
      const file = path.join(p.directory, relative);
      const s = safeJobPath(file);
      if (!s.stat.isFile()) return false;
      const previous = expected === false ? p.files.get(file) : expected;
      if (previous !== undefined && previous !== s.chain) return false;
      if (!p.files.has(file)) this.pinnedFiles++;
      p.files.set(file, s.chain);
      if (p.files.size > 32) {
        p.files.delete(p.files.keys().next().value!);
        this.pinnedFiles--;
      }
      if (this.pinnedFiles > 1248) {
        for (const other of this.pins.values()) {
          if (other === p || !other.files.size) continue;
          other.files.delete(other.files.keys().next().value!);
          this.pinnedFiles--;
          break;
        }
      }
      return true;
    } catch (error) {
      rethrowJobBudget(error);
      return false;
    }
  }
  sourceIdentities(identity: JobIdentity, locators: readonly string[]): Record<string, string> {
    const dir = this.directory(identity);
    const selected = new Set(locators.map((locator) => locator.split('#')[0]));
    return dir
      ? Object.fromEntries(
          this.contributingFiles(identity)
            .filter(([file]) => selected.has(path.relative(dir, file)))
            .map(([file, chain]) => [path.relative(dir, file), chain])
        )
      : {};
  }
  contributingFiles(identity: JobIdentity): [string, string][] {
    return [...(this.pins.get(JSON.stringify(identity))?.files ?? [])];
  }
  helperCurrent(identity: JobIdentity, helper: JobHelperIdentity): boolean {
    if (!activeBudget) return withJobBudget(undefined, () => this.helperCurrent(identity, helper));
    const directory = this.directory(identity);
    if (
      !directory ||
      !/^review-[1-9][0-9]{0,5}$/.test(helper.slot) ||
      helper.statusLocator !== `.dispatch/${helper.slot}/STATUS.json`
    )
      return false;
    try {
      const status = parseDispatchStatus(
        this.json(path.join(directory, helper.statusLocator), 65536),
        directory,
        helper.slot,
        'reviewer',
        path.join(directory, `${helper.slot}.md`)
      );
      return !!status?.output_written && status.session_id === helper.sessionId;
    } catch (error) {
      rethrowJobBudget(error);
      return false;
    }
  }
  filesCurrent(files: [string, string][]): boolean {
    if (!activeBudget) return withJobBudget(undefined, () => this.filesCurrent(files));
    try {
      return files.every(([file, chain]) => safeJobPath(file).chain === chain);
    } catch (error) {
      rethrowJobBudget(error);
      return false;
    }
  }
  authorize(identity: JobIdentity, recipient: ResolvedRecipient | null, budget?: JobReadBudget): string | null {
    if (!activeBudget) return withJobBudget(budget, () => this.authorize(identity, recipient));
    const policy = this.policy();
    if (
      !policy ||
      !recipient?.recipientId ||
      !recipient.model ||
      !policy.scope.facade ||
      policy.scope.excludedRoots.includes(identity.root)
    )
      return null;
    const grant = policy.grants.find((g) => g.recipientId === recipient.recipientId && g.purpose === 'job_card');
    if (grant?.decision !== 'allow' || !this.current(identity)) return null;
    return JSON.stringify([policy, grant]);
  }
  /** Explicit user action only. Does not change generation switches or credential routing. */
  setConsent(recipientId: string, decision: 'allow' | 'deny', now: number): void {
    if (!/^[a-f0-9]{64}$/.test(recipientId) || !revision(now)) throw new Error('invalid_consent');
    withConsentWriteBudget(() => this.setConsentNow(recipientId, decision, now));
    // Restore any material scope before notifications; no callback runs under the lock/control scope.
    this.refresh();
  }
  private setConsentNow(recipientId: string, decision: 'allow' | 'deny', now: number): void {
    if (safeJobPath(this.home).chain !== this.homeChain) throw new Error('source_replaced');
    const dir = path.join(this.home, 'job-materials-v1');
    consentWrite(() => fs.mkdirSync(dir, { mode: 0o700, recursive: true }));
    const directory = safeJobPath(dir);
    if (!directory.stat.isDirectory() || directory.stat.mode & 0o077) throw new Error('unsafe_policy');
    this.consentLocked(dir, () => {
      if (safeJobPath(dir).chain !== directory.chain || safeJobPath(this.home).chain !== this.homeChain)
        throw new Error('source_replaced');
      const policyFile = path.join(dir, 'policy.json');
      this.policyCache = undefined;
      this.jsonCache.delete(policyFile);
      const old = this.policy();
      if (!old && consentExists(policyFile)) throw new Error('invalid_policy');
      const next: JobMaterialPolicy = old
        ? structuredClone(old)
        : {
            schemaVersion: 1,
            revision: 0,
            scope: { version: 1, fields: [...JOB_FIELDS], facade: true, external: false, excludedRoots: [] },
            grants: [],
          };
      next.revision++;
      const previous = next.grants.find((g) => g.recipientId === recipientId);
      next.grants = next.grants.filter((g) => g.recipientId !== recipientId);
      next.grants.push({
        purpose: 'job_card',
        recipientId,
        decision,
        revision: (previous?.revision ?? 0) + 1,
        grantedAt: now,
      });
      if (safeJobPath(dir).chain !== directory.chain || safeJobPath(this.home).chain !== this.homeChain)
        throw new Error('source_replaced');
      const temp = path.join(dir, `${randomUUID()}.tmp`);
      const payload = JSON.stringify(next);
      try {
        consentWrite(() => fs.writeFileSync(temp, payload, { mode: 0o600, flag: 'wx' }), Buffer.byteLength(payload));
        consentWrite(() => fs.renameSync(temp, policyFile));
        this.knownRevision = next.revision;
      } finally {
        if (consentExists(temp)) consentWrite(() => fs.unlinkSync(temp));
      }
    });
  }
  private consentLocked<T>(directory: string, write: () => T, retried = false): T {
    const file = path.join(directory, 'policy.lock');
    let fd: number;
    try {
      fd = consentWrite(() => fs.openSync(file, 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (retried) throw new Error('consent_busy');
      try {
        const before = safeJobPath(file);
        if (!before.stat.isFile() || before.stat.size > 4096) throw new Error('consent_busy');
        const r = readJobFile(file, 4096, jobReadBudget());
        let owner: unknown;
        try {
          owner = JSON.parse(r.text);
        } catch {
          /* Empty/unparseable locks need the 60s bound. */
        }
        const recover = validStamp(owner)
          ? consentOwner(() => processState(owner)) === 'dead'
          : Date.now() - before.stat.mtimeMs > 60000;
        if (!recover || safeJobPath(file).chain !== before.chain) throw new Error('consent_busy');
        consentWrite(() => fs.unlinkSync(file));
      } catch {
        throw new Error('consent_busy');
      }
      return this.consentLocked(directory, write, true);
    }
    let original: fs.Stats | undefined;
    try {
      original = statFd(fd, currentJobBudget());
      const stamp = JSON.stringify(consentOwner(() => selfStamp()));
      consentWrite(() => fs.writeFileSync(fd, stamp), Buffer.byteLength(stamp));
      return write();
    } finally {
      fs.closeSync(fd);
      try {
        if (original) {
          const current = statPath(file, currentJobBudget(), true);
          if (current.dev === original.dev && current.ino === original.ino) consentWrite(() => fs.unlinkSync(file));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}
export function buildJobMaterials(
  input: JobBuildInput
): JobMaterialEnvelope | JobPending | { denied: true; reason: 'requires_authorization' | 'no_material' } {
  try {
    return withJobBudget(input.budget ?? input.subject.budget, () => buildJobMaterialsNow(input));
  } catch (error) {
    if (error instanceof JobBudgetPending) return { pending: true, reason: 'budget' };
    throw error;
  }
}
function buildJobMaterialsNow(
  input: JobBuildInput
): JobMaterialEnvelope | { denied: true; reason: 'requires_authorization' | 'no_material' } {
  const deny = { denied: true as const, reason: 'requires_authorization' as const };
  if (input.purpose !== 'job_card' || input.subject.kind !== 'job') return deny;
  const policy = input.authority.authorize(input.subject.identity, input.resolvedRecipient);
  if (!policy) return deny;
  try {
    let result: ReturnType<JobMaterialSubject['read']>;
    try {
      result = input.subject.read();
    } finally {
      invalidateJobPaths();
    }
    if (
      input.authority.authorize(input.subject.identity, input.resolvedRecipient) !== policy ||
      !Number.isSafeInteger(input.limits.maxBytes) ||
      input.limits.maxBytes <= 0
    )
      return deny;
    const preparedKey = JSON.stringify([input.subject.identity, policy, input.resolvedRecipient, input.limits]);
    const previous = Object.isFrozen(result) ? prepared.get(result)?.get(preparedKey) : undefined;
    if (previous && revalidateJobMaterials(previous, input.authority, input.resolvedRecipient)) return previous;
    let bytes = 0;
    const counts = new Map<JobField, number>();
    const caps: Record<JobField, [number, number]> = {
      goal: [1, 1000],
      test_heading: [12, 80],
      owned_path: [64, 160],
      public_output: [4, 600],
      review: [9, 120],
      question: [2, 2000],
      report: [1, 4000],
    };
    const fragments: JobMaterialEnvelope['fragments'] = [];
    let truncated = false;
    const priority: Record<JobField, number> = {
      question: 0,
      report: 1,
      review: 2,
      goal: 3,
      public_output: 4,
      test_heading: 5,
      owned_path: 6,
    };
    for (const f of [...result.fragments].sort((a, b) => (priority[a.field] ?? 7) - (priority[b.field] ?? 7))) {
      if (
        !JOB_FIELDS.includes(f.field) ||
        typeof f.text !== 'string' ||
        !f.text.trim() ||
        f.text.includes('gAAAAA') ||
        !/^[a-z0-9_-]{1,80}$/.test(f.id) ||
        path.isAbsolute(f.locator) ||
        f.locator.split('/').includes('..')
      )
        continue;
      if (
        f.field === 'review' &&
        (!f.helper ||
          !/^review-[1-9][0-9]{0,5}$/.test(f.helper.slot) ||
          !f.helper.sessionId ||
          f.helper.sessionId.length > 400 ||
          f.helper.statusLocator !== `.dispatch/${f.helper.slot}/STATUS.json`)
      )
        return deny;
      const count = (counts.get(f.field) ?? 0) + 1;
      if (
        count > caps[f.field][0] ||
        Array.from(f.text).length > caps[f.field][1] ||
        fragments.some((fragment) => fragment.provenance[0].id === f.id)
      )
        return deny;
      counts.set(f.field, count);
      if (
        bytes + Buffer.byteLength(f.text) > Math.min(16384, input.limits.maxBytes) ||
        fragments.length >= Math.min(32, input.limits.maxFragments ?? 32)
      ) {
        truncated = true;
        break;
      }
      bytes += Buffer.byteLength(f.text);
      fragments.push({
        text: f.text,
        provenance: [
          {
            kind: 'job',
            identity: { ...input.subject.identity },
            field: f.field,
            locator: f.locator,
            id: f.id,
            recordFingerprint: '',
            truncated: !!f.truncated,
            ...(f.helper ? { helper: { ...f.helper } } : {}),
          },
        ],
      });
    }
    if (!fragments.length) return { denied: true, reason: 'no_material' };
    if (
      result.coverage.loaded !== true ||
      !Array.isArray(result.coverage.gaps) ||
      !result.coverage.gaps.every((g) => typeof g === 'string' && g.length < 200) ||
      !record(result.coverage.skipped) ||
      Object.values(result.coverage.skipped).some((n) => !revision(n))
    )
      return deny;
    const coverage: Coverage = {
      state: 'partial',
      loaded: true,
      skipped: { ...result.coverage.skipped },
      gaps: [...new Set([...result.coverage.gaps, ...(truncated ? ['material_budget'] : [])])],
    };
    const source = input.subject.identity.home;
    const locators = fragments.flatMap((f) =>
      f.provenance.flatMap((p) => [p.locator, ...(p.helper ? [p.helper.statusLocator] : [])])
    );
    for (const locator of locators)
      if (!input.authority.pinFile(input.subject.identity, locator.split('#')[0], false)) return deny;
    const sourceIdentities = input.authority.sourceIdentities(input.subject.identity, locators);
    if (Object.keys(sourceIdentities).length !== new Set(locators.map((locator) => locator.split('#')[0])).size)
      return deny;
    const policyRevision = input.authority.policy()!.revision;
    for (const f of fragments)
      for (const p of f.provenance) {
        if (p.helper && !input.authority.helperCurrent(input.subject.identity, p.helper)) return deny;
      }
    if (input.authority.authorize(input.subject.identity, input.resolvedRecipient) !== policy) return deny;
    for (const f of fragments) for (const p of f.provenance) p.recordFingerprint = hash(f.text);
    const envelope: JobMaterialEnvelope = {
      kind: 'job',
      version: 1,
      identity: { ...input.subject.identity },
      fragments,
      sources: [source],
      sourceIdentities,
      purpose: 'job_card',
      recipientId: input.resolvedRecipient!.recipientId,
      policyRevision: { [source]: policyRevision },
      fingerprint: hash(fragments),
      coverage,
      cacheDomain: hash([
        'job-materials-v1',
        input.subject.identity,
        policy,
        input.resolvedRecipient,
        fragments,
        coverage,
      ]),
    };
    minted.set(envelope, {
      policy,
      files: Object.entries(sourceIdentities).map(([relative, chain]) => [
        path.join(input.authority.directory(input.subject.identity)!, relative),
        chain,
      ]),
    });
    freezeJobValue(envelope);
    if (Object.isFrozen(result)) {
      let entries = prepared.get(result);
      if (!entries) prepared.set(result, (entries = new Map()));
      entries.set(preparedKey, envelope);
      if (entries.size > 3) entries.delete(entries.keys().next().value!);
    }
    return envelope;
  } catch (error) {
    rethrowJobBudget(error);
    return deny;
  }
}
/** Restore only the job variant, retaining every original contributor across derived generations. */
export function restoreJobMaterial(
  envelope: JobMaterialEnvelope,
  identity: JobIdentity,
  authority: JobMaterialAuthority,
  recipient: ResolvedRecipient
): JobMaterialEnvelope | null {
  const policy = authority.authorize(identity, recipient);
  if (!policy) return null;
  try {
    if (
      envelope.kind !== 'job' ||
      envelope.version !== 1 ||
      envelope.purpose !== 'job_card' ||
      envelope.recipientId !== recipient.recipientId ||
      JSON.stringify(envelope.identity) !== JSON.stringify(identity) ||
      envelope.policyRevision?.[identity.home] !== authority.policy()?.revision ||
      !Array.isArray(envelope.fragments) ||
      !envelope.fragments.length ||
      envelope.fragments.length > 32 ||
      !record(envelope.sourceIdentities) ||
      Object.keys(envelope.sourceIdentities).length > 32
    )
      return null;
    const dir = authority.directory(identity);
    if (!dir) return null;
    const files: [string, string][] = [];
    for (const [relative, chain] of Object.entries(envelope.sourceIdentities)) {
      if (typeof chain !== 'string' || path.isAbsolute(relative) || relative.split('/').includes('..')) return null;
      files.push([path.join(dir, relative), chain]);
    }
    if (!authority.filesCurrent(files)) return null;
    let bytes = 0,
      origins = 0;
    for (const f of envelope.fragments) {
      if (
        typeof f.text !== 'string' ||
        !f.text.trim() ||
        f.text.includes('gAAAAA') ||
        !Array.isArray(f.provenance) ||
        !f.provenance.length
      )
        return null;
      bytes += Buffer.byteLength(f.text);
      for (const p of f.provenance) {
        if (
          ++origins > 32 ||
          p.kind !== 'job' ||
          JSON.stringify(p.identity) !== JSON.stringify(identity) ||
          !JOB_FIELDS.includes(p.field) ||
          !/^[a-z0-9_-]{1,80}$/.test(p.id) ||
          !/^[a-f0-9]{64}$/.test(p.recordFingerprint) ||
          typeof p.locator !== 'string' ||
          !Object.hasOwn(envelope.sourceIdentities, p.locator.split('#')[0]) ||
          (p.field === 'review' && (!p.helper || !authority.helperCurrent(identity, p.helper)))
        )
          return null;
      }
    }
    if (
      bytes > 16384 ||
      !envelope.coverage?.loaded ||
      !Array.isArray(envelope.coverage.gaps) ||
      !record(envelope.coverage.skipped) ||
      authority.authorize(identity, recipient) !== policy ||
      envelope.fingerprint !== hash(envelope.fragments)
    )
      return null;
    const restored = structuredClone(envelope);
    restored.cacheDomain = hash(['job-restored-v1', envelope.cacheDomain, policy]);
    minted.set(restored, { policy, files });
    return freezeJobValue(restored);
  } catch (error) {
    rethrowJobBudget(error);
    return null;
  }
}
/** Mint a derived note retaining the complete original job provenance, never as a native report. */
export function deriveJobMaterial(
  text: string,
  parent: JobMaterialEnvelope,
  authority: JobMaterialAuthority,
  recipient: ResolvedRecipient
): JobMaterialEnvelope | null {
  if (
    !revalidateJobMaterials(parent, authority, recipient) ||
    !text ||
    Buffer.byteLength(text) > 16384 ||
    text.includes('gAAAAA')
  )
    return null;
  const fragments = [
    {
      text,
      provenance: parent.fragments.flatMap((f) => f.provenance.map((p) => ({ ...p, identity: { ...p.identity } }))),
    },
  ];
  const envelope = {
    ...parent,
    fragments,
    fingerprint: hash(fragments),
    cacheDomain: hash(['job-derived-v1', parent.cacheDomain, fragments]),
  };
  const proof = minted.get(parent)!;
  minted.set(envelope, proof);
  return freezeJobValue(envelope);
}
export function revalidateJobMaterials(
  envelope: JobMaterialEnvelope,
  authority: JobMaterialAuthority,
  recipient: ResolvedRecipient | null,
  budget?: JobReadBudget
): boolean {
  if (minted.has(envelope) && authority.knownInvalid(envelope)) return false;
  if (!activeBudget) return withJobBudget(budget, () => revalidateJobMaterials(envelope, authority, recipient));
  const original = minted.get(envelope);
  // Scope/recipient first, even before fingerprinting a previously admitted envelope.
  if (
    !original ||
    envelope.recipientId !== recipient?.recipientId ||
    authority.authorize(envelope.identity, recipient) !== original.policy
  )
    return false;
  return (
    authority.filesCurrent(original.files) &&
    envelope.fragments.every((f) =>
      f.provenance.every(
        (p) => p.field !== 'review' || (!!p.helper && authority.helperCurrent(envelope.identity, p.helper))
      )
    )
  );
}
