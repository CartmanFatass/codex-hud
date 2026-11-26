/** Read-only thin jobs. Package labels are display grouping, never execution identity. */
import * as fs from 'node:fs';
import { readFileBounded, writePrivateFile } from '../utils/atomic-fs.js';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Job, JobRoute, JobStatus } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { herdrId } from '../roles/herdr-run.js';
import { fileStampOf, getJobIndexCache, statsMtimeMs, type JobDirMeta, type JobIndexCache, type PersistedFactRow } from '../roles/job-index-cache.js';
import { jobChecks, sameChecks, type CheckSummary } from '../roles/job-checks.js';
import { previewNotice, readReportMeta, type ReportMeta, type ReportMetaFields } from '../roles/report-meta.js';
import { reportReadHint } from '../utils/report-summary.js';
import { adoptProjectJobs } from '../roles/job-project.js';
import { supersession, taskTarget, type Receipt } from './job-supersession.js';
import { ticketTitle } from './ticket-title.js';
import { objectiveLink } from './objectives.js';
import { workerTreeRootGone } from '../roles/worker-tree.js';
import { computeQueuePositions, queuedTimestamp } from '../roles/concurrency.js';
import { answerRecord, questionFields, reviewVerdict } from './work-artifacts.js';
import type { DecisionRecord, EvidenceRef, JobProgress, OwnerWorker, WorkFlow, WorkFlowStep, WorkLane } from './workboard-types.js';

const MAX_ARTIFACT_ENTRIES = 512;
function entries(path: string, missingOK = false, onError?: () => void): string[] {
  try {
    return fs.readdirSync(path);
  } catch (error) {
    if (!missingOK || (error as NodeJS.ErrnoException).code !== 'ENOENT') onError?.();
    return [];
  }
}
interface Snap {
  text: string;
  at: number;
  whole: boolean;
  progress?: JobProgress;
  stamp?: string;
}
type ArtifactStore = Map<string, { stamp: string; snap: Snap }>;
const artifactStores = new WeakMap<JobIndexCache, ArtifactStore>();
const hydrated = new WeakSet<JobIndexCache>();
const persistStates = new WeakMap<JobIndexCache, { file: string; fileStamp: string; stamps: Map<string, string> }>();
const projectArtifactStores = new WeakMap<JobIndexCache, ArtifactStore>();
const artifactStoreFor = (idx: JobIndexCache, stores = artifactStores) => {
  let store = stores.get(idx);
  if (!store) stores.set(idx, (store = new Map()));
  return store;
};
/**
 * Whether the job works inside `root`: its own directory, the main checkout of the worktree HUD manages for it, or the
 * checkout its receipt names as the project (a Sonic child working in its parent's worktree has only that link).
 */
export function worksWithin(root: string, job: Record<string, unknown>, canonical: (path: string) => string): boolean {
  if (typeof job.cwd !== 'string') return false;
  const inside = (path: string) => {
    const rel = relative(root, canonical(path));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const cwd = canonical(job.cwd), tree = job.worktree as { root?: unknown; main_root?: unknown } | undefined;
  return inside(cwd) || (tree?.root === cwd && typeof tree.main_root === 'string' && inside(tree.main_root)) ||
    (typeof job.project_root === 'string' && inside(job.project_root));
}
function statFileStamp(file: string): string | null {
  try {
    const st = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    return st && st.isFile() ? fileStampOf(st) : null;
  } catch { return null; }
}
function sameStamps(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
// Persist only receipt/STATUS facts, never reports, questions or transcript text.
const factKeys = new Set(['job', 'role', 'herdr_pane', 'caller_pane', 'created_at', 'queued_at', 'overflow_from', 'route', 'headless', 'title', 'package', 'ticket', 'objective', 'slice', 'target_hint', 'observed_at', 'retry_of', 'repair_of', 'from_jobs', 'project_root', 'cwd', 'task_length', 'parent_job', 'scout_only', 'scout_state', 'scout_error', 'dispatch_exit_code',
  'state', 'started_at', 'settled_at', 'ended_at', 'read_at', 'read_report_stamp', 'output_written', 'harness', 'model', 'provider', 'thinking', 'exit_reason', 'error', 'reason', 'blocked', 'agent', 'quiet_decision']);
function restore(home: string, idx: JobIndexCache): void {
  if (hydrated.has(idx)) return;
  hydrated.add(idx);
  try {
    const file = join(home, 'display/thin-jobs.json');
    const st = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!st || !st.isFile() || st.size > 1048576n) return;
    const text = fs.readFileSync(file, 'utf8'), rows = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length > 800) return;
    const facts: PersistedFactRow[] = [];
    const stamps = new Map<string, string>();
    let allCurrent = true;
    for (const entry of rows) {
      if (!Array.isArray(entry)) throw Error('cache');
      const [rel, stamp, snap] = entry;
      if (typeof rel !== 'string' || !/^j[0-9a-f]{16}\/(job|STATUS)\.json$/.test(rel) || typeof stamp !== 'string' ||
        !snap || typeof snap.at !== 'number' || typeof snap.whole !== 'boolean' ||
        !(snap.json === null || (snap.json && typeof snap.json === 'object' && !Array.isArray(snap.json)))) throw Error('cache');
      if (rel.endsWith('/job.json') && snap.factsVersion !== 9) { allCurrent = false; continue; } // Older projections lack report read identity.
      facts.push({ rel, stamp, at: snap.at, whole: snap.whole, json: snap.json });
      const kind = !snap.whole ? 'truncated' : snap.json === null ? 'invalid' : 'ok';
      stamps.set(join(home, 'jobs', rel), `${kind}:${stamp}`);
    }
    idx.hydrateFacts(facts);
    if (allCurrent && stamps.size === rows.length) persistStates.set(idx, { file, fileStamp: fileStampOf(st), stamps });
  } catch { /* Corrupt or missing display cache: rebuild on persist. */ }
}
function persist(home: string, idx: JobIndexCache, seenStamps: Map<string, string>): void {
  const file = join(home, 'display/thin-jobs.json');
  const prev = persistStates.get(idx);
  if (prev && prev.file === file && sameStamps(prev.stamps, seenStamps)) {
    const liveStamp = statFileStamp(file);
    if (liveStamp !== null && liveStamp === prev.fileStamp) return;
  }
  // Entry order in JobIndexCache reflects recent lookups, not a change in facts.
  const text = JSON.stringify(idx.exportFacts(seenStamps.keys(), factKeys, { factsVersion: 9 }).sort(([a], [b]) => a.localeCompare(b)));
  if (text.length > 1048576) return;
  try {
    const { bytes, truncated } = readFileBounded(file, 1048576);
    if (!truncated && bytes.toString('utf8') === text) {
      const liveStamp = statFileStamp(file);
      if (liveStamp !== null) persistStates.set(idx, { file, fileStamp: liveStamp, stamps: seenStamps });
      return;
    }
  } catch { /* Missing or unreadable display cache: try to publish. */ }
  try {
    writePrivateFile(file, text);
    const liveStamp = statFileStamp(file);
    if (liveStamp !== null) persistStates.set(idx, { file, fileStamp: liveStamp, stamps: seenStamps });
  }
  catch { /* An unavailable display cache must not stop collection. */ }
}
function readArtifact(path: string, max = 65536, store: ArtifactStore | null = null, seenSet?: Set<string>, onIncomplete?: () => void): Snap | null {
  try {
    const st = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!st) { store?.delete(path); seenSet?.delete(path); return null; }
    if (!st.isFile()) throw new Error('nonregular_job_file');
    seenSet?.add(path);
    const stamp = fileStampOf(st), hit = store?.get(path);
    if (hit?.stamp === stamp) {
      if (!hit.snap.whole) onIncomplete?.();
      store!.delete(path); store!.set(path, hit);
      return hit.snap;
    }
    const { bytes, truncated } = readFileBounded(path, max);
    const snap: Snap = { stamp, text: bytes.toString('utf8'), at: statsMtimeMs(st.mtimeNs), whole: !truncated };
    if (!snap.whole) onIncomplete?.();
    if (store) {
      store.delete(path); store.set(path, { stamp, snap });
      if (store.size > MAX_ARTIFACT_ENTRIES) store.delete(store.keys().next().value!);
    }
    return snap;
  } catch (error) {
    store?.delete(path); seenSet?.delete(path);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onIncomplete?.();
    return null;
  }
}
const when = (v: unknown): number | null => {
  const at = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(at) ? at : null;
};
export const reportWasRead = (job: Pick<Job, 'read_at' | 'read_report_stamp'>, mtime: number | null, stamp?: string | null): boolean =>
  job.read_report_stamp !== undefined ? job.read_report_stamp === stamp : mtime !== null && mtime <= (when(job.read_at) ?? -Infinity);
const word = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const first = (text: string) =>
  text
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.replace(/^#{1,6}\s+/, '')
    .trim() ?? '';
export const stripJobPrefix = (s: string) => s.replace(/^(?:slice|ticket|task|package)\s+(?=\S)/i, '');
const number = (name: string) => Number.parseInt(name.match(/\d+/)?.[0] ?? '0', 10);
function latestSession(directory: string): OwnerWorker['sessionFile'] {
  const root = join(directory, 'sessions');
  try {
    if (fs.realpathSync(root) !== root) return undefined;
    return fs.readdirSync(root).slice(0, 400)
      .filter((n) => n.endsWith('.jsonl'))
      .flatMap((n) => {
        try {
          const path = fs.realpathSync(join(root, n)), st = fs.statSync(path);
          return path.endsWith('.jsonl') && st.isFile() ? [{ path, at: st.mtimeMs }] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.at - a.at)[0];
  } catch {
    return undefined;
  }
}
function headlessOutputAt(directory: string): number | undefined {
  try {
    const stat = fs.lstatSync(join(directory, jobFiles.sonicStdout), { throwIfNoEntry: false });
    if (stat?.isFile()) return stat.mtimeMs;
  } catch { /* Unreadable log: no activity evidence. */ }
}
export interface ThinJobScope {
  project: string | null;
  pane: string | null;
  /** A project root: its jobs, whatever pane dispatched them, instead of the pane's (the Execution page). */
  within?: string;
}
export interface JobRow extends Partial<JobProgress> {
  job: string;
  land_turn?: true;
  ticket_queue?: true;
  workflow?: string;
  batch_flow?: string;
  parent_job?: string;
  role: string | null;
  package: string | null;
  state: string | null;
  display_state: 'queued' | 'working' | 'done' | 'failed' | 'stopped';
  queue_position?: number;
  overflow_from?: string;
  reason: string | null;
  blocked: boolean;
  open_questions: number;
  report_present: boolean;
  report_unread: boolean;
  report_mtime: number | null;
  question_ids: string[];
  checks?: CheckSummary;
  report_meta?: ReportMetaFields;
}
export interface JobRowExtras {
  dir?: string;
  cache?: JobIndexCache;
  questionIds?: readonly string[];
  openQuestions?: number;
  reportPresent?: boolean;
  reportAt?: number | null;
  reportStamp?: string | null;
  progress?: JobProgress;
  queuePosition?: number;
}
/** Milestones are display metadata, except for active Sonic checkpoints delivered by watch. */
export function readJobProgress(dir: string, cached = false, store?: ArtifactStore, seenSet?: Set<string>): JobProgress {
  const file = readArtifact(join(dir, 'progress.jsonl'), 65536, store ?? (cached ? artifactStoreFor(getJobIndexCache(resolve(dir, '../..'))) : null), seenSet);
  if (!file?.whole) return { progress: [], latest_progress: null };
  return file.progress ??= (() => {
    const progress = file.text.split('\n').flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        if (when(entry?.at) !== null && word(entry?.text)) return [{ at: entry.at as string, text: entry.text as string,
        ...(entry.source === 'checkpoint' ? { source: 'checkpoint' as const } : {}) }];
      } catch { /* Ignore a partial or malformed record. */ }
      return [];
    }).slice(-10);
    return { progress, latest_progress: progress.at(-1) ?? null };
  })();
}
function openQuestionIds(dir: string): string[] {
  const qa = join(dir, 'qa');
  try {
    const names = new Set(fs.readdirSync(qa));
    return [...names].filter((name) => /^q\d+\.md$/.test(name) && !names.has(name.replace('.md', '.answer.md')))
      .sort((a, b) => number(a) - number(b)).map((name) => name.slice(0, -3));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
function statReport(dir: string) {
  try {
    const st = fs.lstatSync(join(dir, jobFiles.report), { bigint: true, throwIfNoEntry: false });
    return st && st.isFile() ? { present: true, mtimeMs: statsMtimeMs(st.mtimeNs), stamp: fileStampOf(st) } : null;
  } catch { return null; }
}
/**
 * Derive one job's shared status row from its receipt (`job.json`) and `STATUS.json`.
 * Shared by the panel collector (`readThinJobs`) and the MCP server so both agree on state, reason and attention.
 */
export function jobRow(
  job: Partial<Job>,
  status: Partial<JobStatus> | null | undefined,
  extras?: JobRowExtras
): JobRow {
  const j = job && typeof job === 'object' ? job : {};
  const hasStatus = status !== null && status !== undefined && typeof status === 'object';
  const s = hasStatus ? status : {};
  const rawState =
    word(s.state) ??
    (!hasStatus && typeof j.dispatch_exit_code === 'number' && j.dispatch_exit_code !== 0 ? 'failed' : null);
  // A job closed after it wrote its report finished its task; only the close raced settlement (owner, 2026-11-12).
  const displayState: JobRow['display_state'] =
    rawState === 'stopped'
      ? s.output_written === true
        ? 'done'
        : 'stopped'
      : rawState === 'failed'
        ? 'failed'
        : rawState === 'queued'
          ? 'queued'
          : rawState !== null && ['closed', 'idle_grace', 'done'].includes(rawState)
            ? 'done'
            : 'working';
  const blocked = displayState === 'working' && s.blocked === true;
  const cliInfo = j.cli !== null && typeof j.cli === 'object' ? j.cli : null;
  const cliJob = word(s.harness) === 'cli' || cliInfo !== null;
  const cliAgent = word(s.agent) ?? word(cliInfo?.agent) ?? 'CLI';
  const stderrFirstLine = word(j.stderr_tail)?.split(/\r?\n/)[0]?.trim() || null;
  const questionIds =
    extras?.questionIds !== undefined
      ? [...extras.questionIds]
      : extras?.dir
        ? extras.cache
          ? [...extras.cache.readQa(extras.dir).openIds]
          : openQuestionIds(extras.dir)
        : [];
  const openQuestions = extras?.openQuestions ?? questionIds.length;
  const reason =
    displayState === 'failed'
      ? (word(s.error) ?? word(s.exit_reason) ?? word(s.reason) ?? (!hasStatus ? stderrFirstLine : null))
      : blocked
        ? (word(s.reason) ?? (cliJob ? `${cliAgent} needs input in its pane` : 'needs input in its pane'))
        : displayState === 'working' && rawState === 'waiting_orchestrator'
          ? (word(s.reason) ?? (cliJob && openQuestions === 0 ? 'quiet without a report; hud_send to continue or hud_close to stop' : null))
          : displayState === 'working'
            ? (word(s.reason) ?? null)
            : (word(s.reason) ?? word(s.exit_reason) ?? null);
  const rep = extras?.dir && (extras.reportPresent === undefined || (extras.reportPresent && extras.reportAt === undefined))
    ? (extras.cache ? extras.cache.readReportStat(extras.dir) : statReport(extras.dir)) : null;
  const reportPresent = extras?.reportPresent ?? (extras?.dir ? !!rep?.present : s.output_written === true);
  const reportMtime = extras?.reportAt ?? rep?.mtimeMs ?? null;
  const parent = word(j.parent_job);
  const overflowFrom = word(j.overflow_from);
  return {
    job: word(j.job) ?? '',
    ...(parent ? { parent_job: parent } : {}),
    ...(j.land_turn ? { land_turn: true } : {}),
    ...(j.ticket_queue ? { ticket_queue: true } : {}),
    ...(j.workflow && { workflow: j.workflow }),
    ...(j.batch_flow && { batch_flow: j.batch_flow }),
    role: word(j.role),
    ...(overflowFrom ? { overflow_from: overflowFrom } : {}),
    package: word(j.package),
    state: rawState,
    display_state: displayState,
    ...(rawState === 'queued' && extras?.queuePosition !== undefined ? { queue_position: extras.queuePosition } : {}),
    reason,
    blocked,
    open_questions: openQuestions,
    report_present: reportPresent,
    report_unread: reportPresent && reportMtime !== null && !reportWasRead(j, reportMtime, extras?.reportStamp ?? rep?.stamp),
    report_mtime: reportMtime,
    question_ids: questionIds,
    ...extras?.progress,
  };
}
export function failureUnobserved(dir: string, observedAt: unknown, statusAt?: number | null): boolean {
  const observed = when(observedAt);
  if (observed === null) return true;
  if (statusAt !== undefined) return statusAt !== null && Math.floor(statusAt) > observed;
  try {
    const status = fs.statSync(join(dir, jobFiles.status), { throwIfNoEntry: false });
    return status !== undefined && Math.floor(status.mtimeMs) > observed;
  } catch { return true; }
}

export const failedAttempt = (row: JobRow) => row.display_state === 'failed' || row.display_state === 'stopped';
const evidenceText = (store: ArtifactStore | null, seenSet?: Set<string>) => (path: string) => {
  const snap = readArtifact(path, 65536, store, seenSet);
  return snap?.whole ? snap.text : undefined; // A truncated list of checked boxes does not prove a ticket landed.
};
export const jobSupersession = (home: string, jobs: Receipt[], cwd: string) =>
  supersession(home, jobs, evidenceText(null), cwd);

export function adoptionAttention(home: string, jobs: Receipt[], cwd: string, jobCache?: JobIndexCache) {
  const superseded = jobSupersession(home, jobs, cwd);
  return (dir: string, job: Record<string, unknown>) => jobOwesCaller(dir, job, superseded, jobCache);
}
function jobOwesCaller(dir: string, job: Record<string, unknown>, superseded: (job: Receipt) => boolean, jobCache?: JobIndexCache): boolean {
  let status: Partial<JobStatus> | null = null;
  let statusAt: number | null | undefined;
  if (jobCache) {
    const res = jobCache.readJson<Partial<JobStatus>>(join(dir, jobFiles.status));
    if (res.status === 'ok') {
      status = res.value;
      statusAt = res.at;
    } else if (res.status === 'missing') {
      status = null;
      statusAt = null;
    } else if (res.status === 'truncated') {
      status = JSON.parse(fs.readFileSync(join(dir, jobFiles.status), 'utf8'));
    } else {
      throw res.error;
    }
  } else {
    try { status = JSON.parse(fs.readFileSync(join(dir, jobFiles.status), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const row = jobRow(job, status, { dir, cache: jobCache });
  if (row.ticket_queue || (failedAttempt(row) && superseded(job))) return false;
  const reportOwed = !row.parent_job && !row.land_turn && row.report_unread;
  return row.display_state === 'working' || row.display_state === 'queued' || row.state === 'idle_grace' || reportOwed || row.open_questions > 0 ||
    (!row.land_turn && failedAttempt(row) && failureUnobserved(dir, job.observed_at, statusAt));
}

export interface LeaseCustodian {
  pid: number;
  start: string;
  boot_id: string;
}
export interface LeaseRecord {
  project: string;
  name: string;
  holder: string;
  kind: 'main' | 'worker';
  since: string;
  pid: number;
  pid_start_time?: string;
  custodian?: LeaseCustodian;
  custodian_error?: string;
}
export function readLease(file: string): LeaseRecord | null {
  const snap = readArtifact(file, 65536);
  let v: Record<string, unknown> | null = null;
  try { const p = snap?.whole ? JSON.parse(snap.text) : null; if (p && typeof p === 'object' && !Array.isArray(p)) v = p; }
  catch { return null; }
  return v && typeof v.project === 'string' && typeof v.name === 'string' && typeof v.holder === 'string' &&
    (v.kind === 'main' || (v.kind === 'worker' && /^j[0-9a-f]{16}$/.test(v.holder))) && when(v.since) !== null &&
    typeof v.pid === 'number' && Number.isSafeInteger(v.pid) && v.pid > 1 ? v as unknown as LeaseRecord : null;
}
export function leaseJob(home: string, holder: string) {
  const idx = getJobIndexCache(home), s = idx.readStatus<JobStatus>(holder);
  const status = s.status === 'ok' ? s.value : undefined;
  const j = status ? null : idx.readJob<Job>(holder);
  const state = jobRow(j?.status === 'ok' ? j.value : {}, status).state;
  return { status, terminal: state === 'closed' || state === 'failed' || state === 'stopped' };
}
export function leaseActive(home: string, lease: LeaseRecord): boolean {
  if (lease.kind === 'worker' && leaseJob(home, lease.holder).terminal) return false;
  if (workerTreeRootGone(lease.pid, lease.pid_start_time)) return false;
  try { process.kill(lease.pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  return true;
}
export function readActiveLeases(home: string, project: string): LeaseRecord[] {
  const dir = join(home, 'leases');
  return entries(dir, true).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).flatMap((name) => {
    const lease = readLease(join(dir, name));
    return lease?.project === project && leaseActive(home, lease) ? [lease] : [];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function settledReportMeta(dir: string, hasReport: boolean, settled: boolean): ReportMeta | undefined {
  return hasReport && settled ? readReportMeta(dir) ?? undefined : undefined;
}

export function jobRowReportMeta(row: JobRow, dir: string): ReportMetaFields | undefined {
  const meta = settledReportMeta(dir, row.report_present, row.display_state !== 'working' && row.display_state !== 'queued');
  if (!meta) return undefined;
  const { v, at, report_sig, summary: declared, ...fields } = meta;
  // Keep legacy guillemet markup out of watch/MCP digests. The Inspector reads the declaration as written.
  const summary = declared?.replace(/«[+!-](?![+!-])|[«»]/gu, '').trim();
  return summary ? { ...fields, summary } : fields.files || fields.skip_checks_reason || fields.preview ? fields : undefined;
}

const rowState = (row: JobRow) => row.state ?? row.display_state;
const readyChecks = (row?: JobRow) => row?.checks?.state === 'done' && !row.checks.stale ? row.checks : undefined;
export const checksJustFinished = (row: JobRow, old?: JobRow) => !!readyChecks(row) && !sameChecks(readyChecks(row), readyChecks(old));
export function formatJobChange(row: JobRow): string {
  const head = [row.job, row.role, row.package].filter(Boolean).join(' ');
  const reason = row.reason ? row.reason.replace(/\s+/g, ' ').trim() : null;
  const summary = row.report_meta?.summary;
  const unread = !row.parent_job && row.report_unread;
  const stateLabel = row.state === 'queued' && row.queue_position !== undefined ? `queued (#${row.queue_position})` : rowState(row);
  const parts = [
    stateLabel,
    ...(reason ? [reason] : []),
    ...(unread ? ['report'] : []),
    ...(row.open_questions > 0 ? [row.open_questions === 1 ? 'QUESTION' : `QUESTION (${row.open_questions})`] : []),
    ...(readyChecks(row) ? [`checks ${row.checks!.passed}/${row.checks!.total}`] : []),
    ...(summary ? [[...summary].slice(0, 140).join('')] : []),
    ...(unread ? [previewNotice(row.report_meta?.preview), reportReadHint(row.job)].filter(Boolean) : []),
  ];
  return `${head}: ${parts.join(' | ')}`;
}
/**
 * Format one concise line per job whose `(state, reason, report_present, open_questions)` changed since `prev`.
 */
export function jobChanges(prev: ReadonlyMap<string, JobRow> | readonly JobRow[], rows: readonly JobRow[]): string[] {
  const prior = Array.isArray(prev)
    ? new Map((prev as readonly JobRow[]).map((row) => [row.job, row]))
    : (prev as ReadonlyMap<string, JobRow>);
  const lines: string[] = [];
  for (const row of rows) {
    const old = prior.get(row.job);
    if ((row.workflow || row.batch_flow) && !row.question_ids.some(id => !old?.question_ids.includes(id)) && !(row.blocked && !old?.blocked)) continue;
    if (row.ticket_queue || (row.land_turn && !row.question_ids.some(id => !old?.question_ids.includes(id)))) continue;
    if (row.parent_job && row.display_state !== 'working' && row.display_state !== 'failed' &&
        !row.question_ids.some((id) => !old?.question_ids.includes(id))) continue;
    // A working job's reason and report flip with every tool step of the worker; only what the session acts on is
    // an event: a new job, a state change, a question, or a new reason outside `working` (owner 2026-11-14: no flood).
    const working = (r: JobRow) => rowState(r) === 'working';
    if (
      old && !checksJustFinished(row, old) &&
      (working(old) && working(row)
        ? old.open_questions === row.open_questions
        : rowState(old) === rowState(row) &&
          old.reason === row.reason &&
          (row.parent_job || old.report_present === row.report_present) &&
          old.open_questions === row.open_questions)
    ) {
      continue;
    }
    lines.push(formatJobChange(row));
  }
  return lines;
}
export type WatchJobRow = JobRow & { notice_mtime: number };

function watchReceipts(cache: JobIndexCache) {
  return cache.listJobDirsByMtime().dirs.flatMap(({ id, dir }) => {
    const res = cache.readJob<Job & Record<string, unknown>>(id);
    return res.status === 'ok' && res.value.job === id && typeof res.value.role === 'string'
      ? [{ id, dir, job: res.value, receiptAt: res.at }]
      : [];
  });
}

function watchRows(cache: JobIndexCache, pane: string | null, receipts: ReturnType<typeof watchReceipts>, adopted?: ReadonlySet<string>): WatchJobRow[] {
  const rows: WatchJobRow[] = [];
  const statuses = new Map<string, Partial<JobStatus> | null>();
  for (const { id, dir, job, receiptAt } of receipts) {
    if (rows.length === 200) break;
    if (job.scout_only === true || job.council || (pane !== null && jobCallerPane(job) !== pane)) continue;
    const statusRes = cache.readStatus<JobStatus>(id);
    const status = statusRes.status === 'ok' ? statusRes.value : null;
    statuses.set(id, status);
    try {
      const checks = jobChecks(dir, job);
      const progress = job.role === 'sonic' && status?.state === 'working' ? readJobProgress(dir, true) : undefined;
      const row = jobRow(job, status, { dir, cache, progress });
      const reportMeta = jobRowReportMeta(row, dir);
      const checksAt = checks?.state === 'done' && !checks.stale
        ? fs.lstatSync(join(dir, jobFiles.checks), { throwIfNoEntry: false })?.mtimeMs : undefined;
      // Directory mtime and receipt rewrites (maintenance, adoption) are not new settlement evidence.
      const statusAt = statusRes.status === 'ok' ? statusRes.at : (adopted?.has(id) ? (when(job.created_at) ?? 0) : receiptAt);
      const notice_mtime = Math.max(statusAt, row.report_unread ? row.report_mtime ?? 0 : 0, checksAt ?? 0);
      rows.push({ ...row, notice_mtime, ...(checks ? { checks } : {}), ...(reportMeta ? { report_meta: reportMeta } : {}) });
    } catch {
      /* Job directory disappeared or became unreadable during the scan; skip it. */
    }
  }
  if (rows.some((row) => row.state === 'queued')) {
    const entries = receipts.map(({ id, job }) => {
      const status = statuses.has(id)
        ? statuses.get(id)
        : (() => {
            const res = cache.readStatus<JobStatus>(id);
            return res.status === 'ok' ? res.value : null;
          })();
      return { id, role: word(job.role), state: word(status?.state), queuedAt: queuedTimestamp(job as Partial<Job>) };
    });
    const positions = computeQueuePositions(entries);
    for (const row of rows) {
      if (row.state === 'queued') {
        const pos = positions.get(row.job);
        if (pos !== undefined) row.queue_position = pos;
      }
    }
  }
  return rows;
}

/**
 * Lightweight, read-only watch rows: receipts, `qa/` filenames and report mtime; checks and settled report metadata
 * use the cached report signature. A null pane matches every job, undefined matches none.
 */
export function readThinJobRows(home: string, scope: { pane?: string | null }): WatchJobRow[] {
  if (scope.pane !== null && !herdrId(scope.pane)) return [];
  const cache = getJobIndexCache(home);
  return watchRows(cache, scope.pane, watchReceipts(cache));
}

export async function readSessionJobRows(home: string, pane: string, cwd: string, env: NodeJS.ProcessEnv) {
  const cache = getJobIndexCache(home);
  const receipts = watchReceipts(cache);
  // Capture the initial pane state before yielding, so writes just after watch starts are changes, not catch-up.
  const rows = watchRows(cache, pane, receipts);
  const jobs = receipts.map(({ job }) => job), adopted = new Set<string>();
  if (await adoptProjectJobs(home, pane, cwd, jobs, env, adoptionAttention(home, jobs, cwd, cache), cache, (id) => adopted.add(id))) {
    return watchRows(cache, pane, watchReceipts(cache), adopted);
  }
  return rows;
}
/**
 * What a running job is doing, by role (owner, 2026-11-11): only an implementer builds; read-only roles review,
 * research or ask. An unknown role is just working.
 */
export function runningVerb(role: string, harness: string): string {
  if (/(^|-)imp$|implementer/.test(role)) return 'build';
  if (/reviewer/.test(role)) return 'reviewing';
  if (role === 'architect') return 'researching';
  if (harness === 'bro') return /^flow/.test(role) ? 'generating' : 'asking web';
  return 'working';
}
const LAND_STATES = new Set<WorkFlow['state']>(['queued', 'running', 'completed', 'failed', 'cancelled']);
const flowIsActive = (flow: WorkFlow | null | undefined) => flow?.state === 'queued' || flow?.state === 'running';
function readLandFlow(idx: JobIndexCache, home: string, id: string, parse: (text: string) => unknown, onIncomplete: () => void): WorkFlow | null {
  const base = join(home, 'flows', `f${id.slice(1)}`);
  const read = (suffix: string) => {
    const row = idx.readJson(`${base}${suffix}.json`, { parse });
    if (row.status === 'truncated' || row.status === 'error') onIncomplete();
    return row;
  };
  let res = read('');
  if (res.status !== 'ok') return null;
  // A pre-landing failure or cancellation can be retried under the next attempt ID.
  for (let n = 2; res.value.job === id && !res.value.landed_sha &&
      (res.value.state === 'failed' || res.value.state === 'cancelled'); n++) {
    const next = read(`-${n}`);
    if (next.status !== 'ok') break;
    if (n > 16) { onIncomplete(); break; }
    res = next;
  }
  const v = res.value;
  const state = typeof v.state === 'string' && LAND_STATES.has(v.state as WorkFlow['state']) ? (v.state as WorkFlow['state']) : null;
  const step = word(v.step);
  if (v.job !== id || !state || !step) return null;
  const config = v.config && typeof v.config === 'object' ? (v.config as Record<string, unknown>) : null;
  const push = config?.push === true;
  const keys: WorkFlowStep['key'][] = push ? ['gate', 'merge', 'push'] : ['gate', 'merge'];
  const stage = step === 'done'
    ? keys.length
    : step === 'push' || (step === 'cleanup' && push)
      ? keys.length - 1
      : step === 'records' || step === 'fast-forward' || step.startsWith('after[') || step === 'cleanup'
        ? 1
        : 0;
  const steps: WorkFlowStep[] = keys.map((key, i) => ({
    key,
    state:
      state === 'completed'
        ? 'done'
        : i < stage
          ? 'done'
          : i === stage
            ? state === 'failed'
              ? 'failed'
              : state === 'cancelled'
                ? 'cancelled'
                : 'active'
            : 'pending',
  }));
  const sha = word(v.landed_sha);
  const error = word(v.error);
  return {
    kind: 'land',
    state,
    steps,
    step,
    ...(sha ? { landedSha: sha.slice(0, 7) } : {}),
    ...(error ? { error } : {}),
    updatedAt: when(v.updated_at) ?? res.at,
  };
}
function scoutWorkFlow(
  scoutState: string,
  scoutError: string | null,
  state: JobRow['display_state'],
  s: Record<string, unknown>,
  at: number
): WorkFlow {
  if (scoutState === 'scouting' || (state === 'stopped' && word(s.exit_reason) === 'scouted dispatch stopped')) {
    const flowState: WorkFlow['state'] = state === 'stopped' ? 'cancelled' : state === 'failed' ? 'failed' : 'running';
    const first: WorkFlowStep['state'] = state === 'stopped' ? 'cancelled' : state === 'failed' ? 'failed' : 'active';
    return {
      kind: 'scout',
      state: flowState,
      steps: [
        { key: 'scout', state: first },
        { key: 'run', state: 'pending' },
      ],
      updatedAt: at,
    };
  }
  const scoutStep: WorkFlowStep['state'] = scoutState === 'failed' ? 'failed' : 'done';
  const runStep: WorkFlowStep['state'] =
    state === 'working' ? 'active' : state === 'done' ? 'done' : state === 'failed' ? 'failed' : 'cancelled';
  const flowState: WorkFlow['state'] =
    state === 'working' ? 'running' : state === 'done' ? 'completed' : state === 'failed' ? 'failed' : 'cancelled';
  return {
    kind: 'scout',
    state: flowState,
    steps: [
      { key: 'scout', state: scoutStep },
      { key: 'run', state: runStep },
    ],
    ...(scoutState === 'failed' && scoutError ? { error: scoutError } : {}),
    updatedAt: at,
  };
}

export type ThinJobInventory = { dirs: readonly JobDirMeta[]; totalValid: number; complete: boolean };

export function readThinJobs(
  home: string,
  scope: ThinJobScope,
  parse = JSON.parse,
  options?: { settledBefore?: number; openedAt?: number },
  observation?: { complete: boolean },
  inventory?: ThinJobInventory
): WorkLane[] {
  const { within } = scope;
  let complete = (within !== undefined || herdrId(scope.pane)) && inventory?.complete !== false;
  const markIncomplete = () => { complete = false; };
  // The two kinds of view prune their own artifacts, so one does not evict what the other keeps reading.
  const idx = getJobIndexCache(home), artifacts = artifactStoreFor(idx, within === undefined ? artifactStores : projectArtifactStores);
  const canonicals = new Map<string, string>(), canonical = (path: string) => {
    let known = canonicals.get(path);
    if (known === undefined) {
      try { known = fs.realpathSync(path); } catch { known = resolve(path); }
      canonicals.set(path, known);
    }
    return known;
  };
  const projectRoot = within === undefined ? '' : canonical(within);
  const seenStamps = new Map<string, string>(), seenArtifacts = new Set<string>();
  restore(home, idx);
  const root = join(home, 'jobs');
  // The worktree link is not among the persisted facts, so a project view reads receipts whole.
  const readFact = (path: string, acceptFacts = true): { v: Record<string, unknown>; at: number } | null => {
    const res = idx.readJson(path, { parse, acceptFacts });
    if (res.status === 'ok') { seenStamps.set(path, `ok:${res.stamp}`); return { v: res.value, at: res.at }; }
    if (res.status === 'truncated' || res.status === 'invalid') seenStamps.set(path, `${res.status}:${res.stamp}`);
    else seenStamps.delete(path);
    complete = false;
    return null;
  };
  const readArt = (path: string) => readArtifact(path, 65536, artifacts, seenArtifacts, markIncomplete);
  const { dirs, totalValid } = inventory ?? idx.listJobDirsByMtime({ onDirError: markIncomplete, onStatError: markIncomplete });
  const candidates = idx.recentJobFamilies(dirs, 200, parse);
  if (totalValid > candidates.length) complete = false;
  const landFlows = new Map<string, WorkFlow | null>();
  const landFor = (id: string) => {
    if (!landFlows.has(id)) landFlows.set(id, readLandFlow(idx, home, id, parse, markIncomplete));
    return landFlows.get(id)!;
  };
  const receipts: Receipt[] = [], outsideTimeWindow: string[] = [];
  const jobs = candidates
    .flatMap(({ id }) => {
      // Overflow discovery already loaded these receipts to identify parents. Persist their
      // facts and skip STATUS entirely on other panes. Small windows retain the status-first path.
      const receipt = dirs.length > 200 && within === undefined ? readFact(join(root, id, 'job.json')) : null;
      if (receipt?.v.job === id && typeof receipt.v.role === 'string' && jobCallerPane(receipt.v) !== scope.pane) {
        receipts.push(receipt.v);
        return [];
      }
      const status = options ? readFact(join(root, id, 'STATUS.json')) : null;
      const land = options ? landFor(id) : null;
      if (
        status &&
        !flowIsActive(land) &&
        ['done', 'closed', 'idle_grace', 'failed', 'stopped'].includes(String(status.v.state)) &&
        (Math.max(when(status.v.ended_at) ?? when(status.v.settled_at) ?? status.at, land?.updatedAt ?? -Infinity) < (options?.settledBefore ?? -Infinity) ||
          Math.max(when(status.v.settled_at) ?? when(status.v.ended_at) ?? status.at, land?.updatedAt ?? -Infinity) < (options?.openedAt ?? -Infinity))
      ) { outsideTimeWindow.push(id); return []; }
      const file = receipt ?? readFact(join(root, id, 'job.json'), within === undefined),
        job = file?.v;
      // Bars may have read STATUS before the directory vanished during the receipt read.
      if (!file) seenStamps.delete(join(root, id, 'STATUS.json'));
      if (job?.job === id) receipts.push(job);
      if (!file || !job || job.job !== id || typeof job.role !== 'string') complete = false;
      if (
        !file ||
        !job ||
        job.job !== id ||
        typeof job.role !== 'string' ||
        !(within === undefined ? herdrId(scope.pane) && jobCallerPane(job) === scope.pane : worksWithin(projectRoot, job, canonical))
      )
        return [];
      const created = when(job.created_at);
      if (created === null) complete = false;
      return created === null ? [] : [{ id, job, created, jobAt: file.at, status }];
    })
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  const lanes = new Map<string, WorkLane>();
  const cards = jobs.flatMap(({ id, job, created, jobAt, status: checkedStatus }) => {
    const directory = join(root, id),
      status = checkedStatus ?? readFact(join(directory, 'STATUS.json')),
      s = status?.v ?? {};
    const land = landFor(id);
    const initialRow = jobRow(job, status?.v ?? null);
    const state = initialRow.display_state;
    const at = status?.at ?? jobAt;
    // When the work settled, not when the process later exited: closing an idle job must not reset its age or outcome label.
    const settledAt = state === 'working' || state === 'queued' ? null : (when(s.settled_at) ?? when(s.ended_at) ?? at);
    if (settledAt !== null && !flowIsActive(land) && Math.max(settledAt, land?.updatedAt ?? -Infinity) < (options?.openedAt ?? -Infinity)) return [];
    const briefFile = readArt(join(directory, 'brief.md')),
      brief = briefFile?.text ?? '',
      task = typeof job.task_length === 'number' ? brief.slice(0, job.task_length) : brief;
    const briefTitle = stripJobPrefix(first(task.split(/\r?\n/).find((line) => /^#{1,6}\s/.test(line)) ?? ''));
    const title = briefTitle || stripJobPrefix(first(task) || first(word(job.title) ?? '')) || id.slice(-6);
    const displayId = title.match(/^([\w]+(?:[-/#][\w]+)+|[A-Z][A-Z\d_]+(?=:)|\d+)(?=[:\s]|$)/)?.[1] ?? word(job.slice) ?? word(job.ticket) ?? undefined;
    const label = stripJobPrefix(word(job.package) ?? displayId ?? title.split(':', 1)[0]);
    return [{ id, job, created, jobAt, directory, status, s, state, at, settledAt, briefFile, briefTitle, title, displayId, label, land }];
  });
  const scoutChildren = new Map<string, { state: JobRow['display_state'] }>();
  for (const card of cards) {
    const parent = word(card.job.parent_job);
    if (card.job.scout_only === true && parent) scoutChildren.set(parent, { state: card.state });
  }
  const titles = new Map(cards.map(({ id, title }) => [id, title]));
  // An attempt on another pane or settled before open can retire a failure, but never becomes a card or model input.
  if (cards.some(({ state }) => state === 'failed' || state === 'stopped')) for (const id of outsideTimeWindow) {
    const job = readFact(join(root, id, 'job.json'))?.v;
    if (job?.job === id) receipts.push(job);
  }
  const superseded = supersession(home, receipts, evidenceText(artifacts, seenArtifacts), scope.project,
    (j) => taskTarget(titles.get(String(j.job)) ?? ''));
  const queuePositions = cards.some(({ state }) => state === 'queued')
    ? computeQueuePositions(
        candidates.flatMap(({ id }) => {
          const stRes = idx.readJson(join(root, id, 'STATUS.json'), { parse, acceptFacts: true });
          const st = stRes.status === 'ok' ? stRes.value : null;
          if (word(st?.state) !== 'queued') return [];
          const recRes = idx.readJson(join(root, id, 'job.json'), { parse, acceptFacts: true });
          const rec = recRes.status === 'ok' ? recRes.value : null;
          if (!rec || rec.job !== id || typeof rec.role !== 'string') return [];
          return [{ id, role: rec.role, state: 'queued', queuedAt: queuedTimestamp(rec as Partial<Job>) }];
        })
      )
    : new Map<string, number>();
  const labels = new Map(cards.map(({ id, label }) => [id, label]));
  const labelOf = new Map(cards.map(({ id, displayId, title }) => [id, displayId ?? title]));
  for (const { id, job, created, jobAt, directory, status, s, state, at, settledAt, briefFile, briefTitle, title, displayId, label: ownLabel, land } of cards) {
    const parent = word(job.parent_job);
    const parentLabel = parent && parent !== id ? labels.get(parent) : undefined;
    const label = parentLabel ?? ownLabel;
    const laneId = `thin-job:package:${label}`,
      workerId = `thin-job:${id}`;
    const ref = (file: string, snap: Snap): EvidenceRef => ({
      sourceId: id,
      relativePath: file,
      revision: String(snap.at),
      at: snap.at,
      timeBasis: 'file-mtime',
    });
    const decisions: DecisionRecord[] = [];
    const files: NonNullable<OwnerWorker['files']>[number][] = [];
    const addFile = (rel: string, kind: 'brief' | 'report' | 'review', snap: Snap | null, verdict?: string) => {
      if (snap) files.push({ rel, kind, at: snap.at, paths: [join(directory, rel)], verdict });
    };
    addFile('brief.md', 'brief', briefFile);
    let openCount = 0;
    let pending: { fields: ReturnType<typeof questionFields>; evidence: EvidenceRef; id: string } | undefined;
    let qaSnap;
    try { qaSnap = idx.readQa(directory); }
    catch { complete = false; }
    const openSet = new Set(qaSnap?.openIds ?? []);
    const qa = join(directory, 'qa');
    for (const name of qaSnap?.allQuestionFiles ?? []) {
      const answerName = name.replace('.md', '.answer.md');
      const hasAnswer = !openSet.has(name.slice(0, -3));
      const q = readArt(join(qa, name)),
        a = hasAnswer ? readArt(join(qa, answerName)) : null;
      if (!q || (hasAnswer && !a)) complete = false;
      if (!q) continue;
      const fields = questionFields(q.text);
      files.push({
        rel: `qa/${name}`,
        kind: 'question',
        at: a?.at ?? q.at,
        paths: [join(qa, name), ...(a ? [join(qa, answerName)] : [])],
        qid: name.slice(0, -3),
        title: fields.question,
        state: a ? 'answered' : 'open',
      });
      if (!a) {
        openCount++;
        pending ??= { fields: questionFields(q.text), evidence: ref(`qa/${name}`, q), id: name.slice(0, -3) };
      } else {
        const record = answerRecord(
          laneId,
          `${id}/qa/${name}`,
          q.text,
          a.text,
          ref(`qa/${name}`, q),
          ref(`qa/${answerName}`, a)
        );
        if (record) {
          decisions.push(record);
          Object.assign(files.at(-1)!, {
            title: record.option ?? fields.question,
            state: record.departure ? 'departure' : 'answered',
          });
        }
      }
    }
    const report = readArt(join(directory, 'report.md'));
    const row = jobRow(job, status?.v ?? null, {
      openQuestions: openCount, reportPresent: report !== null, reportAt: report?.at, reportStamp: report?.stamp,
      progress: readJobProgress(directory, true, artifacts, seenArtifacts),
    });
    const cliJob = word(s.harness) === 'cli' || (job.cli !== null && typeof job.cli === 'object');
    const paneAsk =
      !pending && row.display_state === 'working' && cliJob && (row.blocked || row.state === 'waiting_orchestrator')
        ? (row.reason ?? '')
        : '';
    const waiting = row.display_state === 'working'
      ? pending ?? (paneAsk
        ? {
            fields: { question: paneAsk, options: [] as string[], suggested: '' },
            evidence: ref('STATUS.json', { text: '', at: status?.at ?? at, whole: true }),
            id: row.blocked ? 'blocked' : 'quiet',
          }
        : undefined)
      : undefined;
    const reviews = entries(directory, false, markIncomplete)
      .filter((n) => /^review-\d+\.md$/.test(n))
      .sort((a, b) => number(a) - number(b));
    const verb = runningVerb(String(job.role), word(s.harness) ?? word(job.harness) ?? 'pi');
    let phaseAt = 0,
      lastResult = '';
    for (const name of reviews) {
      const review = readArt(join(directory, name));
      if (!review) complete = false;
      if (!review) continue;
      const verdict = reviewVerdict(review.text);
      addFile(name, 'review', review, verdict ?? undefined);
      phaseAt = review.at;
      lastResult = first(review.text);
    }
    const scoutChild = scoutChildren.get(id);
    const scoutState =
      word(job.scout_state) ??
      (word(s.reason) === 'scouting' || word(s.exit_reason) === 'scouted dispatch stopped'
        ? 'scouting'
        : scoutChild
          ? scoutChild.state === 'working'
            ? 'scouting'
            : scoutChild.state === 'done'
              ? 'done'
              : 'failed'
          : null);
    const holder = land?.state === 'queued' ? /^waiting for f([a-f0-9]{16})(?:-[1-9]\d*)?(?: |$)/.exec(land.step ?? '')?.[1] : undefined;
    const waitsOn = holder ? labelOf.get(`j${holder}`) : undefined;
    const flow = (waitsOn && land ? { ...land, waitsOn } : land) ?? (scoutState ? scoutWorkFlow(scoutState, word(job.scout_error), state, s, at) : undefined);
    const phase =
      state === 'stopped'
        ? 'stopped'
        : state === 'queued'
          ? 'queued'
          : waiting
            ? 'asking'
            : state === 'failed'
              ? 'failed'
              : settledAt !== null
                ? 'done'
                : flow?.kind === 'scout' && flow.steps[0]?.state === 'active'
                  ? 'scouting'
                  : reviews.length
                    ? 'fixing'
                    : verb;
    const queuePosition = state === 'queued' ? queuePositions.get(id) : undefined;
    const overflowFrom = word(job.overflow_from);
    const route = job.route as Partial<JobRoute> | undefined;
    const sessionFile = state === 'working' ? latestSession(directory) : undefined;
    const outputAt = state === 'working' && job.headless === true ? headlessOutputAt(directory) : undefined;
    const activityAt = Math.max(created, status?.at ?? 0, report?.at ?? 0, phaseAt, sessionFile?.at ?? 0, outputAt ?? 0, flow?.updatedAt ?? 0);
    const reportMeta = settledReportMeta(directory, report !== null, settledAt !== null);
    const sentence =
      reportMeta?.summary ||
      waiting?.fields.question ||
      (state === 'failed' ? row.reason : null) ||
      (report && report.at >= phaseAt ? first(report.text) : lastResult) ||
      (state === 'working' ? row.reason : null) ||
      '';
    addFile('report.md', 'report', report);
    const qd = s.quiet_decision && typeof s.quiet_decision === 'object' && !Array.isArray(s.quiet_decision)
      ? (s.quiet_decision as Record<string, unknown>)
      : null;
    const quietDecision: OwnerWorker['quietDecision'] =
      qd &&
      (qd.choice === null || typeof qd.choice === 'string') &&
      (qd.probability === null || (typeof qd.probability === 'number' && Number.isFinite(qd.probability))) &&
      typeof qd.action === 'string' &&
      qd.action.trim()
        ? {
            choice: typeof qd.choice === 'string' ? qd.choice : null,
            probability: typeof qd.probability === 'number' ? qd.probability : null,
            action: qd.action.trim(),
            ...(typeof qd.reason === 'string' && qd.reason.trim() ? { reason: qd.reason.trim() } : {}),
          }
        : undefined;
    const ticketHeading = ticketTitle(word(job.project_root) ?? scope.project, word(job.ticket) ?? word(job.slice), word(job.package) ?? '');
    const worker: OwnerWorker = {
      files,
      ...(flow ? { flow } : {}),
      ...(reportMeta ? { reportMeta } : {}),
      sessionFile,
      progress: row.progress,
      latest_progress: row.latest_progress,
      checks: jobChecks(directory, job),
      id: workerId,
      laneId,
      ...(parent ? { parentJobId: `thin-job:${parent}` } : {}),
      role: String(job.role),
      harness: word(s.harness) ?? word(job.harness) ?? 'pi',
      task: title,
      displayId,
      ...(briefTitle ? { briefTitle } : {}),
      ...(ticketHeading ? { ticketTitle: ticketHeading } : {}),
      objective: objectiveLink(job.objective),
      ...(quietDecision ? { quietDecision } : {}),
      ...(row.report_unread ? { reportUnread: true as const } : {}),
      ...(failedAttempt(row) ? {
        superseded: superseded(job),
        failureObserved: (when(job.observed_at) ?? -Infinity) >= (status ? Math.floor(status.at) : 0),
      } : {}),
      state,
      ...(queuePosition !== undefined ? { queuePosition } : {}),
      ...(route && (route.tier === 'light' || route.tier === 'standard' || route.tier === 'hard') &&
        (route.mode === 'headless' || route.mode === 'tab') && (route.source === 'decision' || route.source === 'default') &&
        typeof route.reason === 'string' ? { route: {
          tier: route.tier, mode: route.mode, source: route.source, reason: route.reason,
          ...(route.placement === 'even' && { placement: 'even' as const, preset: word(route.preset) }),
          ...(typeof route.fallback === 'string' && { fallback: route.fallback }),
          ...(typeof route.mode_reason === 'string' && { mode_reason: route.mode_reason }),
        } } : {}),
      ...(job.headless === true ? { headless: true as const } : {}),
      ...(overflowFrom ? { overflowFrom } : {}),
      startedAt: when(s.started_at) ?? created,
      settledAt,
      phase,
      model: word(s.model) ?? word(job.model),
      provider: word(s.provider) ?? word(job.provider),
      effort: word(s.thinking) ?? word(job.thinking),
      homeNeedsHuman: !!waiting,
      humanEndedAt: waiting?.evidence.at ?? null,
      ...(waiting ? { ask: waiting.fields.question } : {}),
      stale: false,
      // The last ref is the file Enter opens: the report, else the brief.
      evidence: [
        ref('job.json', { text: '', at: jobAt, whole: true }),
        ...(report ? [ref('report.md', report)] : briefFile ? [ref('brief.md', briefFile)] : []),
      ],
      work: {
        episode: id,
        signature: String(at),
        activityAt,
        activityBasis: 'observed',
        request: !!waiting,
        failed: state === 'failed',
        result: settledAt !== null,
        // A settled job is done: no "report unread" stage, since only hud_read could tell (owner, 2026-11-11).
        facadeClosed: true,
        facadeClosedAt: settledAt,
        reason: sentence,
        ...(waiting
          ? {
              requestInfo: {
                id: waiting.id,
                question: waiting.fields.question,
                suggested: waiting.fields.suggested,
                options: waiting.fields.options,
                context: waiting.fields.context,
                evidence: waiting.evidence,
              },
            }
          : {}),
      },
    };
    const lane = lanes.get(laneId);
    lanes.set(laneId, {
      id: laneId,
      identity: { kind: 'invocation', home, root: within === undefined ? scope.pane! : jobCallerPane(job), jobId: id },
      label,
      title: label,
      startedAt: lane?.startedAt ?? created,
      phase,
      workers: [...(lane?.workers ?? []), worker],
      decisions: [...(lane?.decisions ?? []), ...decisions],
      evidence: [],
    });
  }
  // Retain only artifact signatures used by this bounded scan.
  for (const path of artifacts.keys()) if (!seenArtifacts.has(path)) artifacts.delete(path);
  // The persisted facts are the pane view's.
  if (within === undefined) persist(home, idx, seenStamps);
  if (observation) observation.complete = complete;
  return [...lanes.values()];
}
