/** On-demand file-event reaper. Native pi owns settlement; pi-role-reap owns tab safety. */
import { isQuotaFailure, recordFailureExhaustion } from '../roles/roster.js';
import { terminalFact, workerAlive, readTurn, reportSignature, REPORT_READ_EXIT, REPORT_SETTLED_EXIT } from '../mcp/cli-judge.js';
import { piSessionIdentity, resumeDeadline } from '../mcp/worker-resume.js';
import { sonicChildren } from '../worker/sonic-jobs.js';
import { reapWorkerTree, UNVERIFIED_TREE_NOTE, workerTreeRootGone } from '../roles/worker-tree.js';
import { piReportSettlement } from '../mcp/pi-read-settlement.js';
import { checkBinding, readCheckReceipt, sameChecks } from '../roles/job-checks.js';
import { archivedClosedJobs, mainHead, reapWorktree, sweepArchivedWorktrees, type ArchivedClosedJob } from '../mcp/managed-worktree.js';
import { runCommand } from '../roles/herdr-run.js';
import { archiveJob } from '../roles/job-archive.js';
import { landAttempt, activeLand } from '../mcp/land-state.js';
import { canOverflowImpJob, startQueuedJob } from '../mcp/thin-main.js';
import { headlessDeadline, killSonicRoot, sonicExit } from '../mcp/sonic-process.js';
import { settleStoppedPi } from '../mcp/pi-stop-settlement.js';
import { getJobIndexCache, type SessionFields } from '../roles/job-index-cache.js';
import { jobChangePublisher } from '../collectors/job-changes.js';
import { createWorkSummaryPublisher } from '../collectors/work-summary-snapshot.js';
import type { Job, JobStatus, WorkerTreeSnapshot } from '../mcp/job-contracts.js';
import { jobFiles, BUNDLED_ROOT, binScript } from '../mcp/paths.js';
import { capForRole, isWorkingForCap, loadConcurrencySettings, queueOrderCompare, queuedTimestamp } from '../roles/concurrency.js';
import { settingsPath } from '../settings.js';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RunnerWatches } from './runner-watches.js';
import { RUNNER_READY } from '../utils/runner-lifetime.js';
import { isProcAlive } from '../utils/proc.js';
import { request } from '../runtime/herdr-socket.js';
import { pruneDisplayFiles } from './display-retention.js';
import { pruneJobLogs, pruneProjectScratch } from './work-retention.js';
import { pruneLegacyTrustBackups } from '../utils/trust-backups.js';
import { readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';

const bundled = BUNDLED_ROOT;

const home = resolve(process.env.HUD_HOME || join(homedir(), '.hud'));
const jobs = join(home, 'jobs'),
  logFile = join(home, 'watch.log');
const retention = Number(process.env.HUD_WATCH_FAILED_RETENTION_MS ?? 7200000);
const cliCheck = Number(process.env.HUD_WATCH_CLI_CHECK_MS ?? 30000);
// Test-only retry interval override while no file watch is available.
const degradedOverride = Number(process.env.HUD_WATCH_DEGRADED_MS);
const degradedMs = Number.isInteger(degradedOverride) && degradedOverride > 0 ? degradedOverride : 1000;
const MAX_CONCURRENT_REAPS = 4;
const MAX_REAP_ATTEMPTS = 10;
const MAX_REAP_BACKOFF_MS = 60 * 60_000;
const REAP_BUDGET_MS = 135_000;
const REAP_KILL_GRACE_MS = 2_000;
const SHUTDOWN_DRAIN_MS = 3_000;
const HOME_RETENTION_INTERVAL_MS = 60 * 60_000;
const WORKTREE_SWEEP_FILE = 'worktree-reap-sweep.json';
const WORKTREE_SWEEP_VERSION = 1;
let nextHomeRetention = 0;
fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
const jobCache = getJobIndexCache(home);
const jobChanges = jobChangePublisher(home);
const workSummary = createWorkSummaryPublisher(home, 'hud-watch', jobCache);
type SessionEntry = { fields: SessionFields; stamp: string };
function readJsonEntry<T>(file: string): { value: T | null; at: number | null } {
  const res = jobCache.readJson<T>(file);
  if (res.status === 'ok') return { value: res.value, at: res.at };
  if (res.status === 'missing' || res.status === 'invalid') return { value: null, at: null };
  if (res.status === 'truncated') {
    try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')) as T, at: res.at }; }
    catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return { value: null, at: null };
      throw error;
    }
  }
  throw res.error;
}
const readJson = <T>(file: string) => readJsonEntry<T>(file).value;
const log = (message: string) => {
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); }
  catch (error) { console.error(`watch log: ${(error as Error).message}; ${message}`); }
};
export const WATCH_WARNINGS_LIMIT = 256;
export const WATCH_CLOSED_TABS_LIMIT = 512;
const WARN_COOLDOWN_MS = 60_000;

export function rememberClosedTab(tabs: Set<string>, id: string, limit = WATCH_CLOSED_TABS_LIMIT): void {
  if (!id) return;
  tabs.delete(id);
  tabs.add(id);
  while (tabs.size > limit) {
    const oldest = tabs.values().next().value;
    if (oldest === undefined) break;
    tabs.delete(oldest);
  }
}

export function recordWarning(
  map: Map<string, number>,
  kind: string,
  now = Date.now(),
  limit = WATCH_WARNINGS_LIMIT
): boolean {
  if (now - (map.get(kind) ?? -Infinity) < WARN_COOLDOWN_MS) return false;
  map.delete(kind);
  map.set(kind, now);
  if (map.size > limit) {
    for (const [k, at] of map) {
      if (k !== kind && now - at >= WARN_COOLDOWN_MS) map.delete(k);
    }
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
  return true;
}

const warnings = new Map<string, number>();
function warn(kind: string, message: string) {
  if (!recordWarning(warnings, kind)) return;
  log(message);
}
let watcher: fs.FSWatcher | undefined, settingsWatcher: fs.FSWatcher | undefined, timer: NodeJS.Timeout;
let notify: (event: 'subscribe' | 'idle') => void, subscribed = false,
  queued = false,
  stopped = false;
type Retry = { ownership: string; readClose: boolean; at: number; attempts: number; outcome: string; snapshot?: WorkerTreeSnapshot };
type ReapInput = { id: string; dir: string; job: Job | null; status: Partial<JobStatus>; session: SessionEntry | null; tab: string;
  ownership: string; retry: Retry | null; readInGrace: string | null; resumeReadReap?: boolean; jobFile: string; statusFile: string };
type ActiveReap = { tab: string; ownership: string; readClose: boolean; busy: string[]; phase: 'preflight' | 'reaping';
  controller: AbortController; promise?: Promise<void>; snapshot?: WorkerTreeSnapshot };
const closedTabs = new Set<string>();
let reapRetries = new Map<string, Retry>(), preflightHold = new Map<string, { ownership: string; token: string; until: number }>();
let worktreeRetries = new Map<string, number>();
type Handoff = { version: 1; reapRetries: typeof reapRetries; preflightHold: typeof preflightHold; worktreeRetries: typeof worktreeRetries; summaryGeneration?: number };
const inFlightReaps = new Map<string, ActiveReap>();
const inFlightWorktrees = new Map<string, Promise<void>>();
const inFlightStarts = new Map<string, { role: string; promise: Promise<void> }>();
const worktreeLocks = new Set<string>(), checking = new Set<string>();
const sweptWorktrees = new Set<string>(), sweptArchiveRoots = new Set<string>();
let worktreeSweepDone = false;
let sweepStats = { removed: 0, kept: 0 };
const runners = new RunnerWatches(schedule);
const checkRetries = new Map<string, number>();
const orphanRetries = new Map<string, { pid: number; at: number; delay: number }>();
let pauseReady: ((state: Handoff | null) => void) | undefined;
function drained() {
  if (!pauseReady || inFlightReaps.size || inFlightWorktrees.size || inFlightStarts.size || checking.size) return;
  stopScheduling();
  pauseReady({ version: 1, reapRetries, preflightHold, worktreeRetries, summaryGeneration: workSummary.generation });
  pauseReady = undefined;
}
function checkDeadline(id: string, dir: string, job: Job | null, status: Partial<JobStatus>): number | undefined {
  if (!job?.checks?.length) return;
  if (checking.has(id)) return Infinity; // Our child has an exit event.
  const previous = readCheckReceipt(dir);
  if (previous?.state === 'running' && previous.pid && workerAlive(previous.pid, previous.start ?? null) === true) {
    return runners.watch(dir, previous.pid); // Adopted after watcher restart; not our child.
  }
  const binding = checkBinding(dir, job, status);
  const retryAt = checkRetries.get(id);
  if (binding && retryAt && retryAt > Date.now()) return retryAt;
  checkRetries.delete(id);
  if (!binding || (previous?.state === 'done' && sameChecks(binding, previous))) return;
  const child = spawn(process.execPath, [binScript('hud-check'), dir, JSON.stringify(binding)], { stdio: 'ignore' });
  child.unref();
  checking.add(id);
  function finished(issue?: string) {
    checking.delete(id);
    if (issue) {
      warn(`checks ${id}`, `checks ${id}: ${issue}`);
      checkRetries.set(id, Date.now() + cliCheck);
    }
    drained();
    schedule();
  }
  child.once('error', error => finished(error.message));
  child.once('exit', (code, signal) => finished(code === 0 ? undefined : `helper exit=${signal ?? code}`));
  return Infinity;
}
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  notify('subscribe');
}
function stopScheduling() {
  stopped = true;
  runners.close();
  watcher?.close();
  watcher = undefined;
  jobChanges.stop();
  settingsWatcher?.close();
  settingsWatcher = undefined;
  clearTimeout(timer);
}
async function shutdown() {
  pauseReady?.(null);
  pauseReady = undefined;
  if (stopped) return;
  stopScheduling();
  const reaps = [...inFlightReaps.values()];
  for (const entry of reaps) entry.controller.abort();
  const worktrees = Promise.race([
    Promise.allSettled(inFlightWorktrees.values()), delay(SHUTDOWN_DRAIN_MS, undefined, { ref: false }),
  ]);
  const starts = Promise.race([
    Promise.allSettled([...inFlightStarts.values()].map((entry) => entry.promise)), delay(SHUTDOWN_DRAIN_MS, undefined, { ref: false }),
  ]);
  // Check helpers own their own lifetime. Reap helpers must exit before we release watch.pid.
  await Promise.all([Promise.allSettled(reaps.map((entry) => entry.promise)), worktrees, starts]);
}
function sessionFolders(dir: string) {
  const dispatch = join(dir, '.dispatch');
  return [join(dir, 'sessions'), ...(fs.existsSync(dispatch)
    ? fs.readdirSync(dispatch, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => join(dispatch, entry.name, 'sessions')) : [])]
    .filter((folder) => fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory());
}
function preserveSessions(dir: string) {
  try {
    for (const folder of sessionFolders(dir)) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const source = join(folder, entry.name);
        const fd = fs.openSync(source, 'r'), buffer = Buffer.alloc(1024 * 1024);
        let cwd;
        try { cwd = JSON.parse(buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8').split('\n', 1)[0]).cwd; }
        finally { fs.closeSync(fd); }
        if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw Error('session cwd missing or invalid');
        const store = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'),
          'sessions', `--${cwd.slice(1).replace(/[/\\:]/g, '-')}--`);
        fs.mkdirSync(store, { recursive: true, mode: 0o700 });
        const target = join(store, entry.name);
        if (fs.lstatSync(target, { throwIfNoEntry: false })) throw Error('session target exists');
        fs.renameSync(source, target);
      }
    }
    return true;
  } catch (error) {
    warn(`keep ${dir} session preservation`, `keep ${dir.split('/').at(-1)} session preservation: ${(error as Error).message}`);
    return false;
  }
}
function supervisorPid(dir: string, status: Partial<JobStatus> | null) {
  const fromFile = jobCache.readPid(join(dir, jobFiles.supervisorPid));
  if (fromFile !== null) return fromFile;
  const pid = status?.supervisor_pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 ? pid : null;
}
function readCloseTurn(dir: string, job: Job | null, status: Partial<JobStatus> | null) {
  if (status?.state !== 'idle_grace' || !job || job.reaped_at) return null;
  const turn = piReportSettlement(dir, job, status);
  if (!turn || job.resume_s === undefined) return turn;
  const sonic = sonicChildren(dir);
  return jobCache.readQa(dir).openIds.length || sonic.open || sonic.uncollected.length ? null : turn;
}
function writeJsonAtomic(file: string, value: Partial<JobStatus> | Job, indent?: number) {
  jobCache.writeJsonAtomic(file, value as Record<string, unknown>, { indent, mkdir: false });
}
function readWorktreeSweepDone() {
  try { return (readJsonBounded(join(home, WORKTREE_SWEEP_FILE), 4096) as { version?: unknown })?.version === WORKTREE_SWEEP_VERSION; }
  catch { return false; }
}
function registeredRoots(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(join(home, 'projects.json'), 'utf8')) as { version?: unknown; projects?: { root?: unknown }[] };
    return parsed?.version === 1 && Array.isArray(parsed.projects)
      ? parsed.projects.map((p) => p?.root).filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
  } catch { return []; }
}
function finishWorktreeSweep() {
  worktreeSweepDone = true;
  sweptWorktrees.clear(); sweptArchiveRoots.clear();
  try { writeJsonPrivate(join(home, WORKTREE_SWEEP_FILE), { version: WORKTREE_SWEEP_VERSION, completed_at: new Date().toISOString(), ...sweepStats }); }
  catch (error) { warn('worktree sweep', `worktree sweep marker: ${(error as Error).message}`); }
  if (sweepStats.removed || sweepStats.kept) log(`worktree stale sweep: removed=${sweepStats.removed} kept=${sweepStats.kept}`);
}
function startArchivedSweep(root: string, archived: ReadonlyMap<string, ArchivedClosedJob[]>, excludeRoots: ReadonlySet<string>) {
  if (worktreeLocks.has(root)) return;
  const key = `sweep:${root}`;
  worktreeLocks.add(root);
  const promise = Promise.resolve().then(async () => {
    const { removed, kept } = await sweepArchivedWorktrees(home, root, archived, excludeRoots);
    sweepStats.removed += removed; sweepStats.kept += kept;
  }).catch((error) => warn(`sweep ${root}`, `sweep ${root}: ${(error as Error).message}`)).finally(() => {
    sweptArchiveRoots.add(root); worktreeLocks.delete(root); inFlightWorktrees.delete(key);
    drained(); schedule();
  });
  inFlightWorktrees.set(key, promise);
}
function startWorktree(id: string, file: string, job: Job, sweep = false) {
  const root = job.worktree!.main_root;
  if (worktreeLocks.has(root)) return; // The owning task reschedules the scan on release.
  worktreeLocks.add(root);
  const promise = Promise.resolve().then(async () => {
    const result = await reapWorktree(id, { job: job.job, cwd: job.cwd, worktree: job.worktree! }, home);
    const latest = readJson<Job>(file);
    if (latest && !latest.worktree_removed_at && JSON.stringify(latest.worktree) === JSON.stringify(job.worktree))
      writeJsonAtomic(file, { ...latest, worktree_kept_reason: undefined, worktree_checked_head: undefined, ...result }, 2);
    if (!worktreeSweepDone) sweptWorktrees.add(id);
    if (sweep) sweepStats['worktree_removed_at' in result ? 'removed' : 'kept']++;
    worktreeRetries.delete(id);
  }).catch((error) => {
    if (error.code !== 'ENOENT') {
      worktreeRetries.set(id, Date.now() + cliCheck);
      warn(`keep ${id} scan`, `keep ${id} scan: ${error.message}`);
    }
  }).finally(() => {
    worktreeLocks.delete(root);
    inFlightWorktrees.delete(id);
    drained();
    schedule();
  });
  inFlightWorktrees.set(id, promise);
}
const reapOwner = (session: SessionEntry | null, status: Partial<JobStatus> | null) =>
  JSON.stringify([session?.fields ?? null, status?.pid, status?.pid_start_time]);
function deferReap(entry: ActiveReap, { id, retry }: ReapInput, message: string, final = false) {
  const attempts = (retry?.attempts ?? 0) + 1;
  const exhausted = !final && attempts >= MAX_REAP_ATTEMPTS;
  const outcome = `${message}${exhausted ? '; retry limit reached' : ''}`;
  // Staging names vary across attempts without changing the failure.
  const key = outcome.replace(/worker-tree\.json\.[0-9a-f-]{36}\.tmp/g, 'worker-tree.json.tmp');
  if (key !== retry?.outcome) log(outcome);
  reapRetries.set(id, { ownership: entry.ownership, readClose: entry.phase === 'reaping' && entry.readClose,
    at: final || exhausted ? Infinity : Date.now() + Math.min(MAX_REAP_BACKOFF_MS, cliCheck * 2 ** (attempts - 1)),
    attempts, outcome: key, snapshot: entry.snapshot });
}
async function reapJob(entry: ActiveReap, input: ReapInput) {
  const { id, dir, job, session, tab, retry, readInGrace, resumeReadReap, jobFile, statusFile } = input;
  let { status } = input;
  const { controller: { signal }, ownership, readClose } = entry;
  if (job?.headless) {
    let end = sonicExit(dir, status, status.slot === 'headless' && jobCache.readQa(dir).openIds.length > 0);
    if (!end) return;
    entry.phase = 'reaping';
    const cleanup = await reapWorkerTree(dir, status, () => killSonicRoot(dir, status), gone => gone,
      { expectSnapshot: true, carry: retry?.snapshot, signal });
    if (signal.aborted) return;
    entry.snapshot = cleanup.snapshot;
    if (!cleanup.complete && !(cleanup.unrecoverable && cleanup.result)) {
      deferReap(entry, input, `reap ${id}: ${cleanup.issue ?? 'sonic runner still exiting'}`);
      return;
    }
    // A panel Stop can race reopening a paused turn. Never publish an old runner's terminal facts over its successor.
    if (reapOwner(session, readJson<JobStatus>(statusFile)) !== ownership) return;
    const now = new Date().toISOString();
    const stopped = fs.existsSync(join(dir, jobFiles.stopRequested));
    const size = (name: string) => {
      const stat = fs.lstatSync(join(dir, name), { throwIfNoEntry: false });
      return stat?.isFile() ? stat.size : undefined;
    };
    const identity = status.slot === 'headless' && piSessionIdentity(job, status.session_file);
    if (end.state === 'waiting_orchestrator' && (!identity || (status.session_id && identity.id !== status.session_id)))
      end = { state: 'failed', exit_reason: 'pi exited without the session needed to answer its question' };
    const waiting = !stopped && end.state === 'waiting_orchestrator';
    writeJsonAtomic(statusFile, { ...status, ...end, ...(identity && !status.session_id && { session_id: identity.id }), ...(stopped ? { state: 'stopped', exit_reason: 'stopped' } : {}),
      output_written: !waiting && fs.existsSync(join(dir, jobFiles.report)), ...(waiting ? {} : { settled_at: now, ended_at: now }),
      stdout_bytes: size(jobFiles.sonicStdout), stderr_bytes: size(jobFiles.sonicStderr) });
    const latest = readJson<Job>(jobFile);
    if (latest && !waiting) writeJsonAtomic(jobFile, { ...latest, reaped_at: now }, 2);
    if (cleanup.unrecoverable) log(`reap ${id}: ${cleanup.unrecoverable}; ${UNVERIFIED_TREE_NOTE}`);
    reapRetries.delete(id);
    return;
  }
  if (readInGrace) {
    const target = session?.fields.primary;
    const agent = target ? (await request('agent.get', { target }, { signal }))?.result?.agent : undefined;
    if (signal.aborted || (job?.resume_s === undefined && closedTabs.has(tab))) return;
    const latest = readJson<JobStatus>(statusFile);
    if (!latest || reapOwner(jobCache.readSession(id, { throwOnError: true }), latest) !== ownership ||
        readCloseTurn(dir, readJson<Job>(jobFile), latest) !== readInGrace) return;
    const observed = agent?.agent_status;
    if (job?.resume_s === undefined ? !['idle', 'done'].includes(observed ?? '') : observed === 'working' || observed === 'blocked') {
      preflightHold.set(id, { ownership, token: readInGrace, until: Date.now() + (job?.resume_s === undefined ? cliCheck : 500) });
      return;
    }
    status = latest;
  }
  entry.phase = 'reaping';
  // Only native Pi may exit using a worker-side snapshot the watcher never saw.
  const expectSnapshot = !!job && !job.cli && !job.bro && !job.jev;
  const { result, complete, issue, snapshot, unrecoverable } = await reapWorkerTree(dir, status,
    // Own a new process group so stopping pi-role-reap also stops its Herdr CLI child.
    () => runCommand('pi-role-reap', [dir], process.env, {
      budgetMs: REAP_BUDGET_MS, killGraceMs: REAP_KILL_GRACE_MS, killProcessGroup: true, signal,
    }), (run) => run.ok, { carry: retry?.snapshot, expectSnapshot, signal });
  entry.snapshot = snapshot;
  const exit = signal.aborted ? 'aborted' : result.exitCode ?? result.reason;
  const groupIssue = result.groupCleanupIssue?.replace(/^group \d+ /, 'reaper group ');
  const message = `reap ${id} state=${status.state} exit=${exit}; ${issue ? `${issue}; ` : ''}${groupIssue ? `${groupIssue}; ` : ''}${UNVERIFIED_TREE_NOTE}`;
  if (signal.aborted || result.reason === 'aborted') { log(message); return; }
  const refusal = result.exitCode === 1 &&
    result.stderr.trimEnd().endsWith(`: TAB ${tab} name changed or missing; not closing`) && !result.stderr.trim().includes('\n');
  // When ancestry cannot be recovered, only the tab outcome remains to be verified.
  if (!complete && !(unrecoverable && (result.ok || refusal || closedTabs.has(tab)))) {
    deferReap(entry, input, message, refusal && !issue && !readClose);
    return;
  }

  // Preserve worker shutdown facts and any job receipt updates made while we reaped.
  const latest = readJson<JobStatus>(statusFile);
  if (!latest || reapOwner(jobCache.readSession(id, { throwOnError: true }), latest) !== ownership) return;
  if (readClose && (['idle_grace', 'closed'].includes(latest.state) || resumeReadReap &&
      (latest.state === 'working' || latest.state?.startsWith('waiting')))) {
    writeJsonAtomic(statusFile, { ...latest, state: 'closed',
      exit_reason: job?.resume_s === undefined ? REPORT_READ_EXIT : REPORT_SETTLED_EXIT,
      ended_at: latest.ended_at ?? new Date().toISOString(),
      ...(job?.resume_s === undefined ? {} : { idle_deadline_at: null }) });
  }
  const receipt = readJson<Job>(jobFile);
  if (receipt) {
    if (!receipt.reaped_at) {
      writeJsonAtomic(jobFile, { ...receipt, reaped_at: new Date().toISOString() }, 2);
      log(message);
    }
    reapRetries.delete(id);
  } else {
    // There is no receipt to stamp. Don't repeat a finished reap on every scan.
    deferReap(entry, input, message, true);
  }
}
function startReap(job: ReapInput) {
  const { id, tab, ownership, readInGrace, resumeReadReap, retry } = job;
  const busy = [job.job?.worktree?.root, job.job?.cwd].filter((path): path is string => !!path);
  const entry: ActiveReap = { tab, ownership, readClose: Boolean(readInGrace || resumeReadReap), busy,
    phase: 'preflight', controller: new AbortController(), snapshot: retry?.snapshot };
  entry.promise = Promise.resolve().then(() => reapJob(entry, job)).catch((error) => {
    if (error.code !== 'ENOENT' && !stopped) deferReap(entry, job, `keep ${id} scan: ${error.message}`);
  }).finally(() => {
    inFlightReaps.delete(id);
    drained();
    schedule(); // Completion may have installed a preflight/retry deadline.
  });
  inFlightReaps.set(id, entry);
}
function startQueued(id: string, targetRole: string, overflowed: boolean) {
  if (inFlightStarts.has(id)) return;
  const promise = Promise.resolve().then(() => startQueuedJob(id, targetRole, overflowed)).then((res) => {
    if (res.started) log(`queue start ${id} role=${targetRole}${overflowed ? ' (overflow from imp)' : ''}`);
    else if (res.failed) warn(`queue ${id}`, `queue start failed ${id}: ${res.reason ?? 'unknown'}`);
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !stopped) {
      warn(`queue ${id}`, `queue start error ${id}: ${(error as Error).message}`);
    }
  }).finally(() => {
    inFlightStarts.delete(id);
    drained();
    schedule();
  });
  inFlightStarts.set(id, { role: targetRole, promise });
}
function scan(retryWatch = false) {
  if (stopped || pauseReady) return;
  clearTimeout(timer);
  if (retryWatch && !watcher) startWatch(); // Install before catch-up, only on the timer path.
  // Piggyback on the on-demand retention scan; never keep the watcher alive for housekeeping.
  const scanAt = performance.now();
  if (scanAt >= nextHomeRetention) {
    nextHomeRetention = scanAt + HOME_RETENTION_INTERVAL_MS;
    pruneDisplayFiles(join(home, 'display'));
    const removed = pruneLegacyTrustBackups(home);
    if (removed) log(`pruned legacy trust backups: ${removed}`);
    const scratch = pruneProjectScratch(home);
    if (scratch !== null) log(`pruned project scratch entries: ${scratch}`);
  }
  const baseHeads = new Map<string, ReturnType<typeof mainHead>>();
  const busyWorktrees = new Set<string>(), knownWorktrees = new Set<string>(), knownWorktreeRoots = new Set<string>();
  const worktreeChecks: { id: string; jobFile: string; job: Job; root: string; sweep: boolean }[] = [];
  const workingByRole = new Map<string, number>();
  const queuedJobs: { id: string; job: Job; queuedAt: number }[] = [];
  const countWorking = (role: string) => workingByRole.set(role, (workingByRole.get(role) ?? 0) + 1);
  const markBusy = (job: Job | null) => {
    if (job?.worktree?.root) busyWorktrees.add(job.worktree.root);
    if (job?.cwd) busyWorktrees.add(job.cwd);
  };
  let rechecks = 0;
  let open = false,
    nearest = Infinity;
  const listedIds = jobCache.listJobIds({ onError: (error) => { throw error; } });
  const liveIds = new Set(listedIds);
  const orphans = new Set<string>();
  const watch = (dir: string, pid: number) => { nearest = Math.min(nearest, runners.watch(dir, pid)); };
  for (const id of listedIds) {
    const dir = join(jobs, id);
    try {
      const starting = inFlightStarts.get(id);
      if (starting) {
        countWorking(starting.role);
        open = true;
        continue;
      }
      const active = inFlightReaps.get(id);
      if (active) {
        for (const root of active.busy) busyWorktrees.add(root);
        if (active.phase === 'preflight' && closedTabs.has(active.tab)) active.controller.abort();
        continue;
      }
      if (inFlightWorktrees.has(id) || !fs.lstatSync(dir).isDirectory()) continue;
      try {
        const loops = sessionFolders(dir).flatMap((folder) => fs.readdirSync(folder, { withFileTypes: true })
          .filter((entry) => entry.isSymbolicLink() && entry.name.endsWith('.jsonl'))
          .map((entry) => join(folder, entry.name)))
          .filter((link) => {
            try { fs.statSync(link); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ELOOP'; }
            return false;
          });
        for (const link of loops) { fs.unlinkSync(link); log(`unlink loop ${link}`); }
      } catch (error) { warn(`keep ${id} scan`, `keep ${id} scan: ${(error as Error).message}`); }
      const jobFile = join(dir, jobFiles.job), statusFile = join(dir, jobFiles.status);
      let job: (Job & Record<string, unknown>) | null, status: Partial<JobStatus> | null, statusAt: number | null, session: SessionEntry | null;
      try { job = readJson<Job & Record<string, unknown>>(jobFile); ({ value: status, at: statusAt } = readJsonEntry<JobStatus>(statusFile)); session = jobCache.readSession(id, { throwOnError: true }); }
      // Unreadable lifecycle or tab evidence may still belong to an open job.
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') open = true; throw error; }
      if (job?.worktree?.root) {
        knownWorktrees.add(job.worktree.root);
        knownWorktreeRoots.add(job.worktree.main_root);
      }
      if (status?.state === 'queued' && job && !job.reaped_at) {
        open = true;
        queuedJobs.push({ id, job, queuedAt: queuedTimestamp(job) });
        continue;
      }
      const tab = session?.fields.tab;
      const ownership = reapOwner(session, status);
      const previous = reapRetries.get(id);
      const retry = !job?.reaped_at && previous?.ownership === ownership ? previous : null;
      // A previous read-close attempt may have closed its own tab before retrying cleanup.
      const tabClosed = !retry?.readClose && !!tab && closedTabs.has(tab);
      if (job?.headless && status?.pid && (status.state === 'working' ||
          (status.state === 'waiting_orchestrator' && fs.existsSync(join(dir, jobFiles.stopRequested))))) {
        markBusy(job);
        if (isWorkingForCap(job, status)) countWorking(job.role);
        if (retry?.at === Infinity) continue;
        open = true;
        if (retry && retry.at > Date.now()) nearest = Math.min(nearest, retry.at);
        else {
          // Keep the close/reconnect edge even if /proc cannot resolve an exiting runner's argv yet.
          if (status.pid) watch(dir, status.pid);
          if (!sonicExit(dir, status)) nearest = Math.min(nearest, headlessDeadline(status));
          else if (inFlightReaps.size < MAX_CONCURRENT_REAPS)
            startReap({ id, dir, job, status, session, tab: '', ownership, retry, readInGrace: null, jobFile, statusFile });
        }
        continue;
      }
      if (!['done', 'closed', 'failed', 'stopped'].includes(status?.state ?? '')) {
        let update: JobStatus | undefined;
        const now = new Date().toISOString();
        if (job?.cli) {
          const pid = supervisorPid(dir, status);
          const liveSupervisor = pid && isProcAlive(pid);
          if (pid && liveSupervisor) watch(dir, pid);
          // A live supervisor delivering /quit owns the terminal write and knows why the tab closed.
          const quitting = tabClosed && liveSupervisor && fs.existsSync(`${statusFile}.quit-${pid}`);
          if (!quitting && (tabClosed || (pid && !liveSupervisor))) {
            // The quit marker is removed after STATUS is published; ignore a snapshot taken before that write.
            ({ value: status, at: statusAt } = readJsonEntry<JobStatus>(statusFile));
            if (['done', 'closed', 'failed', 'stopped'].includes(status?.state ?? '')) { schedule(); continue; }
            const alive = workerAlive(status?.pid ?? null, status?.pid_start_time ?? null);
            const end = terminalFact({ alive, tabClosed, stop: fs.existsSync(`${statusFile}.stop-requested`),
              turn: readTurn(dir), reportSig: reportSignature(dir) });
            if (!end && alive === true && status?.pid && !liveSupervisor) {
              // The remaining third-party worker owns no HUD socket. Back off until a replacement
              // supervisor, a tab event, or verified worker exit ends this degraded handoff.
              orphans.add(id);
              let retry = orphanRetries.get(id);
              if (!retry || retry.pid !== status.pid || retry.at <= Date.now()) {
                const delay = Math.min(MAX_REAP_BACKOFF_MS, retry?.pid === status.pid ? retry.delay * 2 : cliCheck);
                orphanRetries.set(id, retry = { pid: status.pid, delay, at: Date.now() + delay });
              }
              nearest = Math.min(nearest, retry.at);
            }
            const reason = alive === true ? 'supervisor exited; worker still running' : 'supervisor exited; worker liveness unknown';
            if (end) update = { state: end.state, reason: null, blocked: false, output_written: end.outputWritten,
              settled_at: status?.settled_at ?? now, ended_at: now, exit_reason: end.exitReason,
              error: end.state === 'failed' ? end.exitReason : null, updated_at: now };
            else if (status?.state !== 'waiting_orchestrator' || status.reason !== reason)
              update = { state: 'waiting_orchestrator', reason, blocked: false, ended_at: null, exit_reason: null, error: null };
          }
        } else if (!job?.bro && !job?.jev && fs.existsSync(`${statusFile}.stop-requested`)) {
          // Stop intent takes precedence over a tab closing while the worker is exiting.
          const terminal = settleStoppedPi(statusFile, status);
          if (terminal) { status = terminal; jobCache.invalidateFile(statusFile); statusAt = null; }
          else if (status) {
            // The marker or tab event can arrive before the PID is gone.
            open = true;
            nearest = Math.min(nearest, Date.now() + cliCheck); // Native pi-roles has no HUD runner.
            if (isWorkingForCap(job, status)) countWorking(job!.role);
            continue;
          }
        } else if (tabClosed && !(job?.resume_s !== undefined && readCloseTurn(dir, job, status)))
          update = { state: 'failed', exit_reason: 'tab closed', ended_at: now };
        if (update) {
          status = { ...status, ...update };
          writeJsonAtomic(statusFile, status);
          statusAt = null;
        }
      }
      if (isWorkingForCap(job, status)) countWorking(job!.role);
      // A persisted launch without STATUS is still open until dispatch returns.
      if (!status) {
        if (job && (job.dispatch_exit_code === null || job.dispatch_exit_code === 0)) { open = true; markBusy(job); }
        continue;
      }
      // Land can start in idle_grace as well as after closure; its receipt is outside jobs/.
      const land = job?.worktree && landAttempt(home, id).prior;
      const landing = land && activeLand(land);
      if (landing) { watch(dir, land.pid); open = true; markBusy(job); }
      const check = checkDeadline(id, dir, job, status);
      const checkingReport = check !== undefined;
      if (checkingReport) {
        open = true; nearest = Math.min(nearest, check); markBusy(job);
        if (job?.resume_s === undefined || !status.output_written) continue;
      }
      // If report eligibility changes, still look for the root to exit, without polling during backoff.
      if (retry?.readClose && retry.at !== Infinity)
        nearest = Math.min(nearest, retry.at > Date.now() ? retry.at : Date.now() + cliCheck);
      // Once the recorded tab or root is gone, retry that owner's cleanup without an agent preflight.
      const resumeReadReap = retry?.readClose && ((!!tab && closedTabs.has(tab)) || workerTreeRootGone(status.pid, status.pid_start_time));
      let readInGrace = null;
      if (!resumeReadReap && status.state === 'idle_grace') {
        open = true;
        markBusy(job);
        // New Pi jobs close on native settlement. Pre-upgrade jobs still honor their grace.
        if (!tab || !(readInGrace = readCloseTurn(dir, job, status))) continue;
      }
      if (!resumeReadReap && (status.state === 'working' || status.state?.startsWith('waiting'))) {
        open = true;
        markBusy(job);
        continue;
      }
      const readClose = Boolean(resumeReadReap || readInGrace);
      if (job && (status.state === 'done' || !tab || job.reaped_at)) pruneJobLogs(dir, job, status, Date.now());
      if (!readClose && !['closed', 'failed', 'stopped'].includes(status.state ?? '')) continue;
      if (status.state === 'failed' && job && !job.exhaustion_marked) {
        const text = String(status.exit_reason ?? status.error ?? '');
        if (isQuotaFailure(text)) {
          const res = recordFailureExhaustion(home, bundled, dir, job, text);
          if (res.marked) jobCache.invalidateFile(jobFile);
          if (res.marked && res.reason !== text) {
            status = { ...status, exit_reason: res.reason, error: res.reason };
            writeJsonAtomic(statusFile, status);
            statusAt = null;
          }
        }
      }
      const ended = Date.parse(job?.reaped_at ?? status.settled_at ?? status.ended_at ?? '');
      const resumeUntil = job && resumeDeadline(job, status);
      const resumable = !!resumeUntil && resumeUntil > Date.now();
      if (resumable && job?.worktree) nearest = Math.min(nearest, resumeUntil);
      const worktreeSafe = Boolean(job?.reaped_at || (!session && (job?.dispatch_exit_code ?? 0) > 0));
      if (!worktreeSafe || resumable) markBusy(job);
      // With a tab, wait for successful reap; keep the checkout available for native resume.
      if (worktreeSafe && !resumable && !checkingReport && !landing && job?.worktree && !job.worktree_removed_at && fs.lstatSync(jobFile).isFile()) {
        const root = job.worktree.main_root;
        let pending = !job.worktree_kept_reason;
        // Only a clean, unpicked result has a checked HEAD. Don't spawn Git for an unchanged base.
        if (job.worktree_checked_head && Date.now() - ended < 7 * 86400000) {
          if (!baseHeads.has(root)) baseHeads.set(root, mainHead(root));
          const head = baseHeads.get(root);
          pending = !!head && head !== job.worktree_checked_head;
        }
        const sweep = !pending && !worktreeSweepDone && Boolean(job.worktree_kept_reason) && !job.worktree_checked_head && !sweptWorktrees.has(id);
        if (pending || sweep) {
          worktreeChecks.push({ id, jobFile, job, root, sweep });
          continue; // A completing worktree task schedules the next scan for any backlog.
        }
      }
      if (!session && job?.worktree && job.dispatch_exit_code === null) open = true;
      const expires = (Number.isFinite(ended) ? ended : (statusAt ?? fs.statSync(statusFile).mtimeMs)) + 86400000;
      if (!landing && !checkingReport && !resumable && expires < Date.now() && (!tab || job?.reaped_at)) {
        // Pi sessions live in the job dir. CLI and browser keep theirs in their own default place.
        if (!(job?.cli || job?.bro || job?.jev) && !preserveSessions(dir)) continue;
        archiveJob(home, dir, id, job, status, Date.now(), log);
        fs.rmSync(dir, { recursive: true, force: true });
        jobCache.evictJob(id);
        reapRetries.delete(id);
        log(`delete ${id} state=${status.state}`);
        continue;
      }
      if (job?.reaped_at || !tab) continue;
      if (status.state === 'failed' && !resumeReadReap) {
        const ended = Date.parse(status.ended_at ?? '');
        const deadline = (Number.isFinite(ended) ? ended : (statusAt ?? fs.statSync(statusFile).mtimeMs)) + retention;
        if (deadline > Date.now()) {
          nearest = Math.min(nearest, deadline);
          continue;
        }
      }
      if (retry && retry.at > Date.now()) {
        nearest = Math.min(nearest, retry.at);
        continue;
      }
      if (readInGrace) {
        const hold = preflightHold.get(id);
        if (hold?.ownership === ownership && hold.token === readInGrace && hold.until > Date.now()) {
          nearest = Math.min(nearest, hold.until);
          continue;
        }
      }
      if (inFlightReaps.size >= MAX_CONCURRENT_REAPS) continue;
      preflightHold.delete(id);
      startReap({ id, dir, job, status, session, tab, retry, readInGrace, resumeReadReap, jobFile, statusFile, ownership });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const retry = reapRetries.get(id);
        if (retry) nearest = Math.min(nearest, retry.at);
        warn(`keep ${id} scan`, `keep ${id} scan: ${(error as Error).message}`);
      }
    }
  }
  for (const id of [...reapRetries.keys()]) if (!liveIds.has(id)) reapRetries.delete(id);
  for (const id of checkRetries.keys()) if (!liveIds.has(id)) checkRetries.delete(id);
  for (const id of [...preflightHold.keys()]) if (!liveIds.has(id)) preflightHold.delete(id);
  for (const id of [...worktreeRetries.keys()]) if (!liveIds.has(id)) worktreeRetries.delete(id);
  const warnNow = Date.now();
  for (const [kind, at] of warnings) if (warnNow - at >= WARN_COOLDOWN_MS) warnings.delete(kind);
  let pendingSweep = false;
  for (const { id, jobFile, job, root, sweep } of worktreeChecks) {
    if (busyWorktrees.has(job.worktree!.root)) continue;
    const at = worktreeRetries.get(id);
    if (at !== undefined && at > Date.now()) { nearest = Math.min(nearest, at); if (sweep) pendingSweep = true; }
    else if (!worktreeLocks.has(root) && (!job.worktree_checked_head || rechecks < 4)) {
      if (job.worktree_checked_head) rechecks++;
      if (sweep) pendingSweep = true;
      startWorktree(id, jobFile, job, sweep);
    } else if (sweep) pendingSweep = true;
  }
  if (!worktreeSweepDone && !pendingSweep && inFlightWorktrees.size === 0 && inFlightReaps.size === 0) {
    const archived = archivedClosedJobs(home, liveIds);
    const roots = archived.size ? [...new Set([...knownWorktreeRoots, ...registeredRoots()].flatMap((r) => {
      try { return [fs.realpathSync(r)]; } catch { return []; }
    }))].filter((r) => !sweptArchiveRoots.has(r)) : [];
    if (roots.length) {
      const exclude = new Set([...busyWorktrees, ...knownWorktrees]);
      for (const root of roots) if (!worktreeLocks.has(root)) startArchivedSweep(root, archived, exclude);
    } else finishWorktreeSweep();
  }
  if (queuedJobs.length) {
    ensureSettingsWatch();
    queuedJobs.sort(queueOrderCompare);
    const concurrency = loadConcurrencySettings();
    const dispatched = new Set<string>();
    for (const { id, job } of queuedJobs) {
      const cap = capForRole(concurrency, job.role);
      if (cap === 0 || (workingByRole.get(job.role) ?? 0) < cap) {
        countWorking(job.role);
        dispatched.add(id);
        startQueued(id, job.role, false);
      }
    }
    if (concurrency.impOverflow) {
      const generalCap = capForRole(concurrency, 'general');
      const overflowCandidates = queuedJobs.filter(({ id, job }) => !dispatched.has(id) && job.role === 'imp');
      if (overflowCandidates.length && (generalCap === 0 || (workingByRole.get('general') ?? 0) < generalCap)) {
        const freeSlots = generalCap === 0 ? overflowCandidates.length : generalCap - (workingByRole.get('general') ?? 0);
        // Check preset/place compatibility after the scan, before claiming overflow.
        void Promise.resolve().then(() => {
          if (stopped || pauseReady) return;
          let started = 0;
          for (const { id, job } of overflowCandidates) {
            if (started >= freeSlots) break;
            if (inFlightStarts.has(id) || !canOverflowImpJob(job)) continue;
            started++;
            startQueued(id, 'general', true);
          }
        }).catch(() => {});
      }
    }
  } else if (settingsWatcher) {
    settingsWatcher.close();
    settingsWatcher = undefined;
  }
  if (watcher) jobChanges.start();
  if (open) subscribe();
  runners.finishScan();
  for (const id of orphanRetries.keys()) if (!orphans.has(id)) orphanRetries.delete(id);
  const hasInFlight = inFlightReaps.size > 0 || inFlightWorktrees.size > 0 || inFlightStarts.size > 0;
  if ((open || hasInFlight || nearest !== Infinity) && !watcher) nearest = Math.min(nearest, Date.now() + degradedMs);
  if (nearest !== Infinity) timer = setTimeout(() => scan(true), Math.max(1, Math.min(0x7fffffff, Math.ceil(nearest - Date.now()))));
  if (!queued && !open && !hasInFlight && nearest === Infinity) {
    stopScheduling();
    notify('idle');
    return;
  }
  workSummary.publish({ watching: Boolean(watcher) });
}
function schedule() {
  if (queued || stopped) return;
  queued = true;
  setImmediate(() => { queued = false; scan(); });
}
function ensureSettingsWatch() {
  if (settingsWatcher || stopped) return;
  try {
    const file = settingsPath();
    const dir = dirname(file), name = basename(file);
    if (fs.existsSync(dir)) {
      settingsWatcher = fs.watch(dir, (_event, changed) => {
        const fileName = changed?.toString();
        if (!fileName || fileName === name) schedule();
      }).on('error', () => {
        settingsWatcher?.close();
        settingsWatcher = undefined;
      });
    }
  } catch { /* Settings directory unavailable; job events still drive scans. */ }
}
// Watch before catch-up, so a STATUS rename during the initial scan is not missed.
function startWatch() {
  try {
    watcher = fs.watch(jobs, { recursive: true }, (_event, filename) => {
      const path = filename?.toString();
      jobChanges.change(path ?? '');
      if (path?.endsWith(`/${RUNNER_READY}`)) { runners.ready(join(jobs, dirname(path))); schedule(); return; }
      if (!path || !path.includes('/') || /^[^/]+\/(supervisor\.pid|STATUS\.json(?:\.(?:stop|timeout)-requested)?|SESSION\.txt|sonic-(?:exit|stop)\.json|job\.json|checks\.json|report\.md|done\.json|turn\.json|qa(?:\/[^/]+)?)$/.test(path)) schedule();
    }).on('error', (error) => {
      if (stopped) return;
      warn('watch error', `watch error: ${error.message}`);
      watcher?.close(); watcher = undefined;
      jobChanges.stop();
      workSummary.publish({ watching: false });
      clearTimeout(timer);
      timer = setTimeout(() => scan(true), degradedMs);
    });
  } catch (error) { warn('watch error', `watch error: ${(error as Error).message}`); }
}

export function openRuntime(emit: typeof notify) {
  notify = emit;
  return {
    shutdown,
    tab(id: string) {
      rememberClosedTab(closedTabs, id);
      if (pauseReady) for (const active of inFlightReaps.values())
        if (active.phase === 'preflight' && active.tab === id) active.controller.abort();
      schedule();
    },
    pause() {
      if (stopped) return null;
      // Stop admitting scans; don't rely on a 30 s tick landing between two reaps.
      return new Promise<Handoff | null>((resolve) => { pauseReady = resolve; drained(); });
    },
    start(state: Handoff | null, tabs: Set<string>) {
      if (state && state.version !== 1) throw new Error('incompatible watcher handoff');
      if (state) ({ reapRetries, preflightHold, worktreeRetries } = state);
      if (state?.summaryGeneration) workSummary.setGeneration(state.summaryGeneration);
      for (const id of tabs) rememberClosedTab(closedTabs, id);
      worktreeSweepDone = readWorktreeSweepDone();
      sweptWorktrees.clear();
      sweptArchiveRoots.clear();
      sweepStats = { removed: 0, kept: 0 };
      stopped = false;
      startWatch();
      scan();
    },
  };
}
