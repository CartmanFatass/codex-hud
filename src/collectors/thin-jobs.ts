/** Read-only thin jobs. Package labels are display grouping, never execution identity. */
import * as fs from 'node:fs';
import { readFileBounded, writePrivateFile } from '../utils/atomic-fs.js';
import { join } from 'node:path';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { herdrId } from '../roles/herdr-run.js';
import type { JobIndexCache } from '../roles/job-index-cache.js';
import { jobChecks, sameChecks, type CheckSummary } from '../roles/job-checks.js';
import { readReportMeta, type ReportMeta, type ReportMetaFields } from '../roles/report-meta.js';
import { keywordMarks } from '../utils/keyword-marks.js';
import { reportReadHint } from '../utils/report-summary.js';
import { adoptProjectJobs } from '../roles/job-project.js';
import { supersession, taskTarget, type Receipt } from './job-supersession.js';
import { workerTreeRootGone } from '../roles/worker-tree.js';
import { answerRecord, questionFields, reviewVerdict } from './work-artifacts.js';
import type { DecisionRecord, EvidenceRef, JobProgress, OwnerWorker, WorkFlow, WorkFlowStep, WorkLane } from './workboard-types.js';

let complete = false;
function entries(path: string, missingOK = false): string[] {
  try {
    return fs.readdirSync(path);
  } catch (error) {
    if (!missingOK || (error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
    return [];
  }
}
interface Snap {
  text: string;
  at: number;
  whole: boolean;
  json?: Record<string, unknown> | null;
  progress?: JobProgress;
}
const cache = new Map<string, { stamp: string; snap: Snap }>();
const watchCache = new Map<string, { stamp: string; snap: Snap }>();
const seen = new Set<string>();
let cacheHome = '', saved = '';
// Persist only receipt/STATUS facts, never reports, questions or transcript text.
const factKeys = new Set(['job', 'role', 'herdr_pane', 'created_at', 'title', 'package', 'ticket', 'slice', 'target_hint', 'observed_at', 'retry_of', 'repair_of', 'from_jobs', 'project_root', 'cwd', 'task_length', 'parent_job', 'scout_only', 'scout_state', 'scout_error', 'dispatch_exit_code',
  'state', 'started_at', 'settled_at', 'ended_at', 'read_at', 'output_written', 'harness', 'model', 'provider', 'thinking', 'exit_reason', 'error', 'reason', 'blocked', 'agent', 'quiet_decision']);
function restore(home: string): void {
  if (cacheHome === home) return;
  cacheHome = home; cache.clear(); saved = '';
  try {
    const file = join(home, 'display/thin-jobs.json');
    if (fs.statSync(file).size > 1048576) return;
    const text = fs.readFileSync(file, 'utf8'), rows = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length > 400) return;
    for (const [rel, stamp, snap] of rows) {
      if (!/^j[0-9a-f]{16}\/(job|STATUS)\.json$/.test(rel) || typeof stamp !== 'string' ||
        !snap || typeof snap.at !== 'number' || typeof snap.whole !== 'boolean' ||
        !(snap.json === null || (snap.json && typeof snap.json === 'object'))) throw Error('cache');
      if (rel.endsWith('/job.json') && snap.factsVersion !== 3) continue; // Older projections lack supersession/scout evidence.
      cache.set(join(home, 'jobs', rel), { stamp, snap: { ...snap, text: '' } });
    }
    saved = text;
  } catch { cache.clear(); }
}
function persist(home: string): void {
  const root = join(home, 'jobs') + '/';
  const rows = [...cache].filter(([p, { snap }]) => /\/(job|STATUS)\.json$/.test(p) && !snap.json?.checks).map(([p, { stamp, snap }]) =>
    [p.slice(root.length), stamp, { ...(p.endsWith('/job.json') ? { factsVersion: 3 } : {}), at: snap.at, whole: snap.whole, json: snap.json ?
      { ...Object.fromEntries(Object.entries(snap.json).filter(([k]) => factKeys.has(k))),
        project_root: snap.json.project_root ?? (snap.json.worktree as { main_root?: unknown } | null)?.main_root } : null }]);
  const text = JSON.stringify(rows);
  if (text === saved || text.length > 1048576) return;
  try {
    writePrivateFile(join(home, 'display/thin-jobs.json'), text);
    saved = text;
  } catch { /* An unavailable display cache must not stop collection. */ }
}
function read(path: string, max = 65536, store: typeof cache | null = cache): Snap | null {
  try {
    const st = fs.lstatSync(path);
    if (!st.isFile()) throw new Error('nonregular_job_file');
    if (store) seen.add(path);
    const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    const hit = store?.get(path);
    if (hit?.stamp === stamp && !hit.snap.whole) complete = false;
    if (hit?.stamp === stamp) return hit.snap;
    const { bytes, truncated } = readFileBounded(path, max);
    const snap = { text: bytes.toString('utf8'), at: st.mtimeMs, whole: !truncated };
    complete &&= snap.whole;
    store?.set(path, { stamp, snap });
    return snap;
  } catch (error) {
    store?.delete(path);
    if (store) seen.delete(path);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
    return null;
  }
}
function json(path: string, parse: (text: string) => unknown, store: typeof cache | null = cache): { v: Record<string, unknown>; at: number } | null {
  const file = read(path, 65536, store);
  if (!file?.whole) complete = false;
  if (!file?.whole) return null;
  if (file.json === undefined) {
    try {
      const v = parse(file.text);
      file.json = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
      file.json = null;
    }
  }
  if (!file.json) complete = false;
  return file.json ? { v: file.json, at: file.at } : null;
}
const when = (v: unknown): number | null => {
  const at = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(at) ? at : null;
};
export const reportWasRead = (readAt: unknown, mtime: number | null): boolean =>
  mtime !== null && mtime <= (when(readAt) ?? -Infinity);
const word = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const first = (text: string) =>
  text
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.replace(/^#{1,6}\s+/, '')
    .trim() ?? '';
export const stripJobPrefix = (s: string) => s.replace(/^(?:slice|ticket|task|package)\s+(?=\S)/i, '');
const number = (name: string) => Number.parseInt(name.match(/\d+/)?.[0] ?? '0', 10);
/** Share the existing session selection/stat with sentence material; never read its body here. */
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
export interface ThinJobScope {
  project: string | null;
  pane: string | null;
}
export interface JobRow extends Partial<JobProgress> {
  job: string;
  land_turn?: true;
  parent_job?: string;
  role: string | null;
  package: string | null;
  state: string | null;
  display_state: 'working' | 'done' | 'failed' | 'stopped';
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
  progress?: JobProgress;
}
/** Milestones are display metadata: watch/list rows do not read this file. */
export function readJobProgress(dir: string, cached = false): JobProgress {
  const file = read(join(dir, 'progress.jsonl'), 65536, cached ? cache : null);
  if (!file?.whole) return { progress: [], latest_progress: null };
  return file.progress ??= (() => {
    const progress = file.text.split('\n').flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        if (when(entry?.at) !== null && word(entry?.text)) return [{ at: entry.at as string, text: entry.text as string }];
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
      ? (word(s.exit_reason) ?? word(s.error) ?? word(s.reason) ?? (!hasStatus ? stderrFirstLine : null))
      : blocked
        ? (word(s.reason) ?? (cliJob ? `${cliAgent} needs input in its pane` : 'needs input in its pane'))
        : displayState === 'working' && rawState === 'waiting_orchestrator'
          ? (word(s.reason) ?? (cliJob && openQuestions === 0 ? 'quiet without a report; hud_send to continue or hud_close to stop' : null))
          : displayState === 'working'
            ? (word(s.reason) ?? null)
            : (word(s.reason) ?? word(s.exit_reason) ?? null);
  let reportPresent: boolean;
  let reportMtime: number | null = extras?.reportAt ?? null;
  if (extras?.reportPresent !== undefined) {
    reportPresent = extras.reportPresent;
    if (extras.dir && reportPresent && extras.reportAt === undefined) {
      if (extras.cache) {
        reportMtime = extras.cache.readReportStat(extras.dir).mtimeMs;
      } else {
        try { reportMtime = fs.statSync(join(extras.dir, jobFiles.report)).mtimeMs; } catch { /* disappeared */ }
      }
    }
  } else if (extras?.dir) {
    if (extras.cache) {
      const rep = extras.cache.readReportStat(extras.dir);
      reportPresent = rep.present;
      reportMtime = extras.reportAt !== undefined ? extras.reportAt : rep.mtimeMs;
    } else {
      reportPresent = fs.existsSync(join(extras.dir, jobFiles.report));
      if (reportPresent && extras.reportAt === undefined) {
        try { reportMtime = fs.statSync(join(extras.dir, jobFiles.report)).mtimeMs; } catch { /* disappeared */ }
      }
    }
  } else {
    reportPresent = s.output_written === true;
  }
  const parent = word(j.parent_job);
  return {
    job: word(j.job) ?? '',
    ...(parent ? { parent_job: parent } : {}),
    ...(j.land_turn ? { land_turn: true } : {}),
    role: word(j.role),
    package: word(j.package),
    state: rawState,
    display_state: displayState,
    reason,
    blocked,
    open_questions: openQuestions,
    report_present: reportPresent,
    report_unread: reportPresent && reportMtime !== null && !reportWasRead(j.read_at, reportMtime),
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
const evidenceText = (store: typeof cache | null) => (path: string) => {
  const snap = read(path, 65536, store);
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
  if (failedAttempt(row) && superseded(job)) return false;
  return row.display_state === 'working' || row.state === 'idle_grace' || row.report_unread || row.open_questions > 0 ||
    (failedAttempt(row) && failureUnobserved(dir, job.observed_at, statusAt));
}

export interface LeaseRecord {
  project: string;
  name: string;
  holder: string;
  kind: 'main' | 'worker';
  since: string;
  pid: number;
  pid_start_time?: string;
}
export function readLease(file: string): LeaseRecord | null {
  const v = json(file, JSON.parse, null)?.v;
  return v && typeof v.project === 'string' && typeof v.name === 'string' && typeof v.holder === 'string' &&
    (v.kind === 'main' || (v.kind === 'worker' && /^j[0-9a-f]{16}$/.test(v.holder))) && when(v.since) !== null &&
    typeof v.pid === 'number' && Number.isSafeInteger(v.pid) && v.pid > 1 ? v as unknown as LeaseRecord : null;
}
export function leaseJob(home: string, holder: string) {
  const dir = join(home, 'jobs', holder);
  const status = json(join(dir, 'STATUS.json'), JSON.parse, null)?.v;
  const job = status ? {} : json(join(dir, 'job.json'), JSON.parse, null)?.v ?? {};
  const state = jobRow(job, status).state;
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
  const meta = hasReport && settled ? readReportMeta(dir) : null;
  // Worker summaries are plain text; do not expose accidental panel markup in notices or reads.
  if (!meta?.summary || !/[«»]/u.test(meta.summary)) return meta ?? undefined;
  const { summary: marked, ...rest } = meta;
  const summary = keywordMarks(marked).plain.trim();
  return summary ? { ...rest, summary } : rest.files ? rest : undefined;
}

export function jobRowReportMeta(row: JobRow, dir: string): ReportMetaFields | undefined {
  const meta = settledReportMeta(dir, row.report_present, row.display_state !== 'working');
  return meta ? {
    ...(meta.summary ? { summary: meta.summary } : {}), ...(meta.files ? { files: meta.files } : {}),
  } : undefined;
}

const rowState = (row: JobRow) => row.state ?? row.display_state;
const readyChecks = (row?: JobRow) => row?.checks?.state === 'done' && !row.checks.stale ? row.checks : undefined;
export const checksJustFinished = (row: JobRow, old?: JobRow) => !!readyChecks(row) && !sameChecks(readyChecks(row), readyChecks(old));
export function formatJobChange(row: JobRow): string {
  const head = [row.job, row.role, row.package].filter(Boolean).join(' ');
  const reason = row.reason ? row.reason.replace(/\s+/g, ' ').trim() : null;
  const summary = row.report_meta?.summary;
  const unread = !row.parent_job && row.report_unread;
  const parts = [
    rowState(row),
    ...(reason ? [reason] : []),
    ...(unread ? ['report'] : []),
    ...(row.open_questions > 0 ? [row.open_questions === 1 ? 'QUESTION' : `QUESTION (${row.open_questions})`] : []),
    ...(readyChecks(row) ? [`checks ${row.checks!.passed}/${row.checks!.total}`] : []),
    ...(summary ? [[...summary].slice(0, 140).join('')] : []),
    ...(unread ? [reportReadHint(row.job)] : []),
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
    if (row.land_turn && !row.question_ids.some(id => !old?.question_ids.includes(id))) continue;
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
function watchReceipts(home: string) {
  seen.clear();
  const root = join(home, 'jobs');
  return entries(root)
    .filter((id) => /^j[0-9a-f]{16}$/.test(id))
    .flatMap((id) => {
      try {
        const st = fs.lstatSync(join(root, id));
        return st.isDirectory() ? [{ id, at: st.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .flatMap(({ id }) => {
      const job = json(join(root, id, 'job.json'), JSON.parse, watchCache)?.v;
      return job?.job === id && typeof job.role === 'string' ? [{ id, job }] : [];
    });
}

function watchRows(home: string, pane: string | null, receipts: ReturnType<typeof watchReceipts>): JobRow[] {
  const rows: JobRow[] = [];
  for (const { id, job } of receipts) {
    if (rows.length === 200) break;
    if (job.scout_only === true || (pane !== null && job.herdr_pane !== pane)) continue;
    const dir = join(home, 'jobs', id);
    const status = json(join(dir, 'STATUS.json'), JSON.parse, watchCache)?.v ?? null;
    try {
      const checks = jobChecks(dir, job);
      const row = jobRow(job, status, { dir });
      const reportMeta = jobRowReportMeta(row, dir);
      rows.push({ ...row, ...(checks ? { checks } : {}), ...(reportMeta ? { report_meta: reportMeta } : {}) });
    } catch {
      /* Job directory disappeared or became unreadable during the scan; skip it. */
    }
  }
  for (const path of watchCache.keys()) if (!seen.has(path)) watchCache.delete(path);
  return rows;
}

/**
 * Lightweight, read-only watch rows: receipts, `qa/` filenames and report mtime; checks and settled report metadata
 * use the cached report signature. A null pane matches every job, undefined matches none.
 */
export function readThinJobRows(home: string, scope: { pane?: string | null }): JobRow[] {
  if (scope.pane !== null && !herdrId(scope.pane)) return [];
  return watchRows(home, scope.pane, watchReceipts(home));
}

export async function readSessionJobRows(home: string, pane: string, cwd: string, env: NodeJS.ProcessEnv) {
  const receipts = watchReceipts(home);
  // Capture the initial pane state before yielding, so writes just after watch starts are changes, not catch-up.
  const rows = watchRows(home, pane, receipts);
  const jobs = receipts.map(({ job }) => job);
  if (await adoptProjectJobs(home, pane, cwd, jobs, env, adoptionAttention(home, jobs, cwd))) {
    return readThinJobRows(home, { pane });
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
function readLandFlow(home: string, id: string, parse: (text: string) => unknown): WorkFlow | null {
  const file = read(join(home, 'flows', `f${id.slice(1)}.json`));
  if (!file?.whole) return null;
  if (file.json === undefined) {
    try {
      const parsed = parse(file.text);
      file.json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      file.json = null;
    }
  }
  const v = file.json;
  if (!v) return null;
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
    updatedAt: when(v.updated_at) ?? file.at,
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

export function readThinJobs(
  home: string,
  scope: ThinJobScope,
  parse = JSON.parse,
  options?: { settledBefore?: number; openedAt?: number },
  observation?: { complete: boolean }
): WorkLane[] {
  complete = herdrId(scope.pane);
  seen.clear();
  restore(home);
  const root = join(home, 'jobs');
  const candidates = entries(root).filter((id) => /^j[0-9a-f]{16}$/.test(id)).flatMap((id) => {
    try { const st = fs.lstatSync(join(root, id)); return st.isDirectory() ? [{ id, at: st.mtimeMs }] : []; }
    catch { complete = false; return []; }
  }).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  if (candidates.length > 200) complete = false;
  const landFlows = new Map<string, WorkFlow | null>();
  const landFor = (id: string) => {
    if (!landFlows.has(id)) landFlows.set(id, readLandFlow(home, id, parse));
    return landFlows.get(id)!;
  };
  const receipts: Receipt[] = [], outsideTimeWindow: string[] = [];
  const jobs = candidates.slice(0, 200)
    .flatMap(({ id }) => {
      // Filter from STATUS facts before reading receipts or artifacts; active/unknown jobs always stay.
      const status = options ? json(join(root, id, 'STATUS.json'), parse) : null;
      const land = options ? landFor(id) : null;
      if (
        status &&
        !flowIsActive(land) &&
        ['done', 'closed', 'idle_grace', 'failed', 'stopped'].includes(String(status.v.state)) &&
        (Math.max(when(status.v.ended_at) ?? when(status.v.settled_at) ?? status.at, land?.updatedAt ?? -Infinity) < (options?.settledBefore ?? -Infinity) ||
          Math.max(when(status.v.settled_at) ?? when(status.v.ended_at) ?? status.at, land?.updatedAt ?? -Infinity) < (options?.openedAt ?? -Infinity))
      ) { outsideTimeWindow.push(id); return []; }
      const file = json(join(root, id, 'job.json'), parse),
        job = file?.v;
      // Bars may have read STATUS before the directory vanished during the receipt read.
      if (!file) seen.delete(join(root, id, 'STATUS.json'));
      if (job?.job === id) receipts.push(job);
      if (!file || !job || job.job !== id || typeof job.role !== 'string') complete = false;
      if (
        !file ||
        !job ||
        job.job !== id ||
        typeof job.role !== 'string' ||
        !herdrId(scope.pane) ||
        job.herdr_pane !== scope.pane
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
      status = checkedStatus ?? json(join(directory, 'STATUS.json'), parse),
      s = status?.v ?? {};
    const land = landFor(id);
    const initialRow = jobRow(job, status?.v ?? null);
    const state = initialRow.display_state;
    const at = status?.at ?? jobAt;
    // When the work settled, not when the process later exited: closing an idle job must not reset its age or outcome label.
    const settledAt = state === 'working' ? null : (when(s.settled_at) ?? when(s.ended_at) ?? at);
    if (settledAt !== null && !flowIsActive(land) && Math.max(settledAt, land?.updatedAt ?? -Infinity) < (options?.openedAt ?? -Infinity)) return [];
    const briefFile = read(join(directory, 'brief.md')),
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
    const job = json(join(root, id, 'job.json'), parse)?.v;
    if (job?.job === id) receipts.push(job);
  }
  const superseded = supersession(home, receipts, evidenceText(cache), scope.project,
    (j) => taskTarget(titles.get(String(j.job)) ?? ''));
  const labels = new Map(cards.map(({ id, label }) => [id, label]));
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
    const qa = join(directory, 'qa'),
      names = new Set(entries(qa, true));
    for (const name of [...names].filter((n) => /^q\d+\.md$/.test(n)).sort((a, b) => number(a) - number(b))) {
      const answerName = name.replace('.md', '.answer.md');
      const q = read(join(qa, name)),
        a = names.has(answerName) ? read(join(qa, answerName)) : null;
      if (!q || (names.has(answerName) && !a)) complete = false;
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
    const report = read(join(directory, 'report.md'));
    const row = jobRow(job, status?.v ?? null, {
      openQuestions: openCount, reportPresent: report !== null, reportAt: report?.at,
      progress: readJobProgress(directory, true),
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
    const reviews = entries(directory)
      .filter((n) => /^review-\d+\.md$/.test(n))
      .sort((a, b) => number(a) - number(b));
    const phases: string[] = [];
    const verb = runningVerb(String(job.role), word(s.harness) ?? word(job.harness) ?? 'pi');
    // Only a build is a step that later rounds follow; a read-only job's chain is just its state.
    if (verb === 'build' && (report || reviews.length)) phases.push('build ✓');
    let phaseAt = 0,
      lastResult = '';
    for (const name of reviews) {
      const review = read(join(directory, name));
      if (!review) complete = false;
      if (!review) continue;
      const verdict = reviewVerdict(review.text);
      const major = review.text.match(/\b(\d+)\s+(?:major|important)\b/i)?.[1];
      const minor = review.text.match(/\b(\d+)\s+minor\b/i)?.[1];
      const result =
        verdict === 'accept'
          ? 'accept'
          : [major ? `${major} major` : '', minor ? `${minor} minor` : ''].filter(Boolean).join(' ') || (verdict ?? '');
      addFile(name, 'review', review, result);
      phases.push(`review r${number(name)}${result ? ' ' + result : ''}`);
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
    const flow = land ?? (scoutState ? scoutWorkFlow(scoutState, word(job.scout_error), state, s, at) : undefined);
    const phase =
      state === 'stopped'
        ? 'stopped'
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
    phases.push(phase);
    const sessionFile = state === 'working' ? latestSession(directory) : undefined;
    const activityAt = Math.max(created, status?.at ?? 0, report?.at ?? 0, phaseAt, sessionFile?.at ?? 0, flow?.updatedAt ?? 0);
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
      ...(quietDecision ? { quietDecision } : {}),
      ...(row.report_unread ? { reportUnread: true as const } : {}),
      ...(failedAttempt(row) ? {
        superseded: superseded(job),
        failureObserved: (when(job.observed_at) ?? -Infinity) >= (status ? Math.floor(status.at) : 0),
      } : {}),
      state,
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
        phases,
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
      identity: { kind: 'invocation', home, root: scope.pane!, jobId: id },
      label,
      title: label,
      startedAt: lane?.startedAt ?? created,
      phase,
      workers: [...(lane?.workers ?? []), worker],
      decisions: [...(lane?.decisions ?? []), ...decisions],
      evidence: [],
    });
  }
  // Retain only signatures used by this bounded scan.
  for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
  persist(home);
  if (observation) observation.complete = complete;
  return [...lanes.values()];
}
