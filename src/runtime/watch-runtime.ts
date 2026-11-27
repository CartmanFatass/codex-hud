/** On-demand file-event reaper. Native pi owns normal settlement; hud-reap owns tab safety. */
import { isQuotaFailure, recordFailureExhaustion } from '../roles/roster.js';
import { formatPaneExitReason, terminalFact, workerAlive, readTurn, reportSignature, REPORT_READ_EXIT, REPORT_SETTLED_EXIT, type PaneExit } from '../mcp/cli-judge.js';
import { piSessionIdentity, resumeDeadline } from '../mcp/worker-resume.js';
import { headlessSonicChildren, sonicChildren } from '../worker/sonic-jobs.js';
import { reapWorkerTree, tabTreeGrant, UNVERIFIED_TREE_NOTE, workerTreeRootGone } from '../roles/worker-tree.js';
import { piReportSettlement } from '../mcp/pi-read-settlement.js';
import { checkBinding, readCheckReceipt, sameChecks } from '../roles/job-checks.js';
import { archivedClosedJobs, mainHead, reapWorktree, sweepArchivedWorktrees, type ArchivedClosedJob } from '../mcp/managed-worktree.js';
import { runCommand } from '../roles/herdr-run.js';
import { archiveJob, recordStopOrigin } from '../roles/job-archive.js';
import { archiveJobCold, enforceColdRawCap } from '../roles/cold-archive.js';
import { cliSession, cliStreamSession, piSessionHeader } from '../roles/job-sessions.js';
import { recordJobUsage } from '../roles/job-usage.js';
import { checkSonicReportCitations, shouldCheckSonicCitations } from '../roles/sonic-citations.js';
import { collectSonicReadFacts, shouldRecordSonicReads } from '../roles/sonic-reads.js';
import { landAttempt, activeLand, isFlowId, readLand } from '../mcp/land-state.js';
import type { CouncilRun } from '../mcp/council-state.js';
import { settleMainCouncil } from '../mcp/council-settle.js';
import { wakeWorkflow } from '../workflows/wake.js';
import { composedActive, isComposedId, type ComposedRun } from '../workflows/composed-state.js';
import { directRecipient } from '../workflows/scope.js';
import { noticeEvents, runDir } from '../workflows/store.js';
import type { PrewalkRun } from '../mcp/prewalk-flow.js';
import { workflowHeaders } from '../workflows/header-scan.js';
import { batchActive, isBatchId, type Batch } from '../mcp/batch-state.js';
import { isTicketQueueId, type TicketQueue } from '../mcp/ticket-queue-state.js';
import { canOverflowImpJob, startQueuedJob } from '../mcp/thin-main.js';
import { resumeHeadlessQueue } from '../mcp/dispatch/orchestrator.js';
import { hasHeadlessSends, headlessFollowupReady } from '../mcp/headless-sends.js';
import { isGenericNoReportReason, lastTurnError, missingRunnerEvidence, missingRunnerReceipt } from '../mcp/sonic-failure.js';
import { headlessDeadline, killSonicRoot, sonicExit } from '../mcp/sonic-process.js';
import { piTurnUnfinished, settleStoppedPi } from '../mcp/pi-stop-settlement.js';
import { getJobIndexCache, JOB_ID_RE } from '../roles/job-index-cache.js';
import { observeWorkerPermission, permissionNotice, permissionTarget } from '../mcp/worker-permissions.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { notify as notifyPane, watching } from '../roles/notify.js';
import { jobChangePublisher } from '../collectors/job-changes.js';
import { createWorkSummaryPublisher } from '../collectors/work-summary-snapshot.js';
import type { Job, JobSession, JobStatus, WorkerTreeSnapshot } from '../mcp/job-contracts.js';
import { jobFiles, BUNDLED_ROOT, binScript } from '../mcp/paths.js';
import { capForRole, isWorkingForCap, loadConcurrencySettings, queueOrderCompare, queuedTimestamp } from '../roles/concurrency.js';
import { settingsPath } from '../settings.js';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RunnerWatches } from './runner-watches.js';
import { RUNNER_READY } from '../utils/runner-lifetime.js';
import { isProcAlive, isValidPid } from '../utils/proc.js';
import { hasLocalHerdrTarget, herdrEndpoint, isShellLaunchedWorker, probeHerdrTarget, request, SHELL_WORKER_UNSUPPORTED, TAB_PROBE_INTERVAL_MS, tabProbeBackoff } from './herdr-socket.js';
import { pruneDisplayFiles } from './display-retention.js';
import { JOB_RETENTION_MS, pruneJobLogs, pruneLandFlows, pruneProjectScratch } from './work-retention.js';
import { pinnedQueueJobs } from '../unattended/state.js';
import { pruneLegacyTrustBackups } from '../utils/trust-backups.js';
import { readJsonBounded, writeJsonPrivate, writePrivateFile } from '../utils/atomic-fs.js';

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
type SessionEntry = NonNullable<ReturnType<typeof jobCache.readSession>>;
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
export const WATCH_TAB_FACTS_LIMIT = 512;
const WARN_COOLDOWN_MS = 60_000;
const MAX_TAB_QUERIES = 4;

export function rememberTab<T>(map: Map<string, T>, key: string, value: T): boolean {
  if (!key) return false;
  map.delete(key);
  map.set(key, value);
  let evicted = false;
  while (map.size > WATCH_TAB_FACTS_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
    evicted = true;
  }
  return evicted;
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
const snapshotWarnings = new Set<string>();
function warn(kind: string, message: string) {
  if (!recordWarning(warnings, kind)) return;
  log(message);
}
let watcher: fs.FSWatcher | undefined, flowsWatcher: fs.FSWatcher | undefined, settingsWatcher: fs.FSWatcher | undefined, timer: NodeJS.Timeout;
let notify: (event: 'subscribe' | 'idle') => void, subscribed = false,
  queued = false,
  stopped = false;
type Retry = { ownership: string; readClose: boolean; readCloseRootReaped?: boolean; at: number; attempts: number; outcome: string; snapshot?: WorkerTreeSnapshot };
type ReapInput = { id: string; dir: string; job: Job | null; status: Partial<JobStatus>; session: SessionEntry | null; tab: string;
  ownership: string; retry: Retry | null; readInGrace: string | null; resumeReadReap?: boolean; jobFile: string; statusFile: string };
type ActiveReap = { session: SessionEntry | null; ownership: string; readClose: boolean; busy: string[]; phase: 'preflight' | 'reaping';
  controller: AbortController; promise?: Promise<void>; snapshot?: WorkerTreeSnapshot };
const goneTabs = new Map<string, string>(); // stock only: job ID -> exact SESSION stamp confirmed absent
const exitedLaunches = new Map<string, PaneExit>(); // fork direct-exec: launch_id + root terminal_id -> pane.exited status
const deadDirectObservedAt = new Map<string, number>(); // fork direct-exec: first observation of dead root PID (150ms grace for in-flight pane.exited)
const deadDirectRoots = new Map<string, true>(); // fork direct-exec: verified dead exact PID + start ticks without pane.exited
const tabRetries = new Map<string, { stamp: string; at: number; failures: number }>();
const turnErrorChecks = new Map<string, string>(); // job ID -> status timestamp already inspected for a generic no-report turn error
// Retry failed retention on an event for that job, or on the next housekeeping pass.
const retentionFailures = new Set<string>();
let tabWakes = new Map<string, true>(), checkAllTabs = true, tabProbe: AbortController | undefined, nextTabProbe = 0;
function wakeTab(key: string) {
  if (checkAllTabs || !rememberTab(tabWakes, key, true)) return;
  checkAllTabs = true;
  tabWakes.clear();
}
const directPaneKey = (launchId: string, terminalId: string) => `${launchId}\0${terminalId}`;
const isDirectExecSession = (session: SessionEntry | null): boolean =>
  Boolean(session?.fields.directExec === '1' && session.fields.launchId && session.fields.terminalId);
const directRootPid = (session: SessionEntry | null): { pid: number; start: string } | null => {
  if (!session?.fields.pid || !session.fields.pidStart || !/^\d+$/.test(session.fields.pidStart)) return null;
  const pid = Number(session.fields.pid);
  return isValidPid(pid) ? { pid, start: session.fields.pidStart } : null;
};
const tabWasClosed = (id: string, session: SessionEntry | null) => {
  if (!session || !hasLocalHerdrTarget(session.fields) || isDirectExecSession(session)) return false;
  return goneTabs.get(id) === session.stamp;
};
const sameSession = (id: string, session: SessionEntry | null) =>
  !!session && jobCache.readSession(id, { throwOnError: true })?.stamp === session.stamp;
function probeTabs(checks: { id: string; session: SessionEntry }[]) {
  if (!checks.length) return;
  const controller = new AbortController(), { signal } = controller;
  tabProbe = controller;
  let next = 0;
  const worker = async () => {
    while (!signal.aborted && next < checks.length) {
      const { id, session } = checks[next++]!;
      try {
        const now = performance.now();
        const start = Math.max(now, nextTabProbe);
        nextTabProbe = start + TAB_PROBE_INTERVAL_MS;
        if (start > now) await delay(Math.ceil(start - now), undefined, { signal });
        const result = await probeHerdrTarget(session.fields, signal, 'hud-watch-probe');
        if (signal.aborted || !sameSession(id, session) || !hasLocalHerdrTarget(session.fields)) continue;
        if (result === 'unknown') {
          const prior = tabRetries.get(id);
          const failures = prior?.stamp === session.stamp ? Math.min(prior.failures + 1, 8) : 1;
          rememberTab(tabRetries, id, { stamp: session.stamp, at: Date.now() + tabProbeBackoff(failures), failures });
          continue;
        }
        tabRetries.delete(id);
        if (result === 'present') continue;
        rememberTab(goneTabs, id, session.stamp);
        const active = inFlightReaps.get(id);
        if (active?.phase === 'preflight' && active.session?.stamp === session.stamp) active.controller.abort();
        schedule();
      } catch (error) { if (!signal.aborted) warn(`keep ${id} scan`, `keep ${id} scan: ${(error as Error).message}`); }
    }
  };
  void Promise.all(Array.from({ length: Math.min(MAX_TAB_QUERIES, checks.length) }, worker)).then(() => {
    if (tabProbe !== controller) return;
    tabProbe = undefined;
    if (checkAllTabs || tabWakes.size || tabRetries.size) schedule();
  });
}
let reapRetries = new Map<string, Retry>(), preflightHold = new Map<string, { ownership: string; token: string; until: number }>();
let worktreeRetries = new Map<string, number>();
type Handoff = { version: 1; reapRetries: typeof reapRetries; preflightHold: typeof preflightHold; worktreeRetries: typeof worktreeRetries; summaryGeneration?: number };
const inFlightReaps = new Map<string, ActiveReap>();
const inFlightWorktrees = new Map<string, Promise<void>>();
const inFlightStarts = new Map<string, { role: string; promise: Promise<void> }>();
const permissionChecks = new Map<string, { controller: AbortController; promise: Promise<void> }>();
const permissionsSeen = new Map<string, { pane: string; key: string; next: number }>();
const flowNoticeChecks = new Map<string, { controller: AbortController; promise: Promise<void> }>();
const flowNoticeRetries = new Map<string, { at: number; attempts: number }>();
const WAITING_FLOW_NOTICE = /^(?:pause-\d+|handback-[a-z][a-z0-9_-]{0,47}|error-\d+)$/;
function deliverFlowNotices(
  id: string,
  run: { pane: string; origin_mcp?: { pid: number; start: string }; notices?: Record<string, string> },
  now: number,
  seenMarkers: Set<string>,
): number {
  let nextAt = Infinity;
  const endpoint = herdrEndpoint();
  if (!endpoint || !fs.existsSync(endpoint) || !run.pane || !run.notices || !directRecipient(run) || watching(run.pane, home)) return nextAt;
  const ready: Record<string, string> = {};
  for (const [key, text] of Object.entries(run.notices)) {
    if (!WAITING_FLOW_NOTICE.test(key)) continue;
    const marker = join(runDir(home, id), `${key}.noticed`);
    seenMarkers.add(marker);
    if (flowNoticeChecks.has(marker)) continue;
    const retry = flowNoticeRetries.get(marker);
    if (retry && retry.at > now) { nextAt = Math.min(nextAt, retry.at); continue; }
    ready[key] = text;
  }
  if (!Object.keys(ready).length) return nextAt;
  for (const { line, marker } of noticeEvents(home, { flow: id, notices: ready })) {
    const controller = new AbortController();
    const recordRetry = () => {
      fs.rmSync(marker, { force: true });
      if (!controller.signal.aborted && herdrEndpoint()) {
        const attempts = (flowNoticeRetries.get(marker)?.attempts ?? 0) + 1;
        flowNoticeRetries.set(marker, { at: Date.now() + Math.min(30_000, 500 * 2 ** Math.min(attempts - 1, 6)), attempts });
      }
    };
    const promise = notifyPane(run.pane, line, home, { signal: controller.signal }).then(sent => {
      if (!sent.skipped && (sent.status === 0 || sent.uncertain)) {
        flowNoticeRetries.delete(marker);
        return;
      }
      recordRetry();
    }).catch(recordRetry).finally(() => {
      flowNoticeChecks.delete(marker);
      drained();
      schedule();
    });
    flowNoticeChecks.set(marker, { controller, promise });
  }
  return nextAt;
}
function checkPermission(dir: string, job: Job, status: Partial<JobStatus> | null, session: SessionEntry) {
  const controller = new AbortController();
  const promise = observeWorkerPermission(home, dir, job, status, session, controller.signal).then(entry => {
    const recipient = jobCallerPane(job);
    if (entry && recipient && !controller.signal.aborted)
      void notifyPane(recipient, permissionNotice(job.job, entry), home).catch(() => {});
  }).catch(() => { if (!controller.signal.aborted) warn(`permission ${job.job}`, `${job.job}: could not reconcile worker permission`); })
    .finally(() => { permissionChecks.delete(job.job); drained(); schedule(); });
  permissionChecks.set(job.job, { controller, promise });
}
const worktreeLocks = new Set<string>(), checking = new Set<string>();
const sweptWorktrees = new Set<string>(), sweptArchiveRoots = new Set<string>();
let worktreeSweepDone = false;
let sweepStats = { removed: 0, kept: 0 };
const runners = new RunnerWatches(schedule);
const checkRetries = new Map<string, number>();
let nextPiExitCheck = 0;
const orphanRetries = new Map<string, { pid: number; at: number; delay: number }>();
let pauseReady: ((state: Handoff | null) => void) | undefined;
function drained() {
  if (!pauseReady || inFlightReaps.size || inFlightWorktrees.size || inFlightStarts.size || checking.size || permissionChecks.size || flowNoticeChecks.size) return;
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
  tabProbe?.abort();
  tabProbe = undefined;
  runners.close();
  watcher?.close();
  watcher = undefined;
  flowsWatcher?.close();
  flowsWatcher = undefined;
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
  const permissions = [...permissionChecks.values()];
  for (const entry of permissions) entry.controller.abort();
  const flowNotices = [...flowNoticeChecks.values()];
  for (const entry of flowNotices) entry.controller.abort();
  await Promise.all([Promise.allSettled(reaps.map((entry) => entry.promise)), worktrees, starts,
    Promise.race([Promise.allSettled([...permissions, ...flowNotices].map(entry => entry.promise)), delay(SHUTDOWN_DRAIN_MS, undefined, { ref: false })])]);
}
function sessionFolders(dir: string) {
  const dispatch = join(dir, '.dispatch');
  const dispatchStat = fs.lstatSync(dispatch, { throwIfNoEntry: false });
  // A linked .dispatch tree is not job-local and is skipped by the cold snapshot too.
  return [join(dir, 'sessions'), ...(dispatchStat && !dispatchStat.isSymbolicLink()
    ? fs.readdirSync(dispatch, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => join(dispatch, entry.name, 'sessions')) : [])]
    .filter((folder) => fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory());
}
function recordSessions(dir: string, job: Job, status: Partial<JobStatus>, piFiles: string[]): Job {
  const known = Array.isArray(job.sessions) ? job.sessions : [];
  const found: JobSession[] = [];
  const addPi = (id: string, path: string) => found.push({ harness: 'pi', id, path });
  if (status.harness === 'cli' || job.cli) {
    const agent = status.agent ?? job.cli?.agent;
    let id = status.agent_session_id;
    if (job.headless || status.slot === 'headless') {
      // STATUS initially names the requested ID. Only native init is evidence it ran.
      id = undefined;
      const offset = status.stdout_start;
      if ((!job.reaped_at || !known.length) && agent && typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0) {
        try { id = cliStreamSession(join(dir, jobFiles.sonicStdout), agent, offset); }
        catch { /* No readable native init. */ }
      }
    }
    const native = cliSession(agent, id);
    if (native) found.push(native);
  }
  if (!job.cli && !job.bro && !job.jev) {
    const identity = piSessionIdentity(job, status.session_file);
    if (identity?.file && (!status.session_id || identity.id === status.session_id)) addPi(identity.id, identity.file);
    else if (!identity && typeof status.session_id === 'string' && status.session_id)
      found.push({ harness: 'pi', id: status.session_id });
    // Sonic retries stage a copy before opening it and may replace it after a rejected open.
    if (isSonicSession(job, status) && !(job.retry_of && status.state === 'working'))
      piFiles.push(join(dir, jobFiles.sonicSession));
  }
  // The job's primary/helper links and local session files are explicit associations.
  for (const file of piFiles) {
    let path;
    try { path = fs.realpathSync(file); } catch { continue; }
    if (known.some(s => s?.harness === 'pi' && s.path === path)) continue;
    const native = piSessionHeader(path);
    if (native) addPi(native.id, native.path);
  }
  const sessions = [...known];
  for (const fact of found) {
    const i = sessions.findIndex(s => s?.harness === fact.harness && s.id === fact.id);
    if (i === -1) sessions.push(fact);
    else if (!sessions[i]!.path && fact.path) sessions[i] = fact;
  }
  if (sessions.length === known.length && sessions.every((s, i) => s === known[i])) return job;
  const receipt = { ...job, sessions };
  try { writeJsonAtomic(join(dir, jobFiles.job), receipt, 2); }
  catch (error) { warn(`sessions ${job.job}`, `record sessions ${job.job}: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); }
  return receipt;
}
const isSonicSession = (job: Job, status: Partial<JobStatus>) => status.slot === 'sonic' || (job.headless && job.role === 'sonic');
function hasLocalPiSession(dir: string, job: Job, status: Partial<JobStatus>, localFiles: string[]) {
  if (job.cli || job.bro || job.jev || !(job.headless || status.slot === 'headless' || status.slot === 'sonic')) return false;
  const root = fs.realpathSync(dir);
  const candidates = [...localFiles, status.session_file, isSonicSession(job, status) ? join(dir, jobFiles.sonicSession) : undefined];
  return candidates.some(file => {
    if (!file || !isAbsolute(file)) return false;
    try {
      const path = fs.realpathSync(file), local = relative(root, path);
      if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) return false;
      const st = fs.lstatSync(path);
      return st.isFile() && st.size > 0; // A failed launch can leave an empty placeholder.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return false;
    }
  });
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
function snapshotIssueForLog(id: string, dir: string, issue?: string) {
  if (!issue?.startsWith('worker-tree snapshot unresolved:')) return issue;
  const marker = join(dir, 'worker-tree-warning');
  if (snapshotWarnings.has(id) || fs.existsSync(marker)) return;
  try { writePrivateFile(marker, '', { exclusive: true, mkdir: false }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    // A full or unwritable filesystem can prevent saving both the snapshot and the marker.
    snapshotWarnings.add(id);
  }
  return issue;
}
const reapOwner = (session: SessionEntry | null, status: Partial<JobStatus> | null) =>
  JSON.stringify([session?.fields ?? null, status?.pid, status?.pid_start_time]);
function deferReap(entry: ActiveReap, { id, retry }: ReapInput, message: string, final = false, targetReaped = false) {
  const attempts = (retry?.attempts ?? 0) + 1;
  const exhausted = !final && attempts >= MAX_REAP_ATTEMPTS;
  const outcome = `${message}${exhausted ? '; retry limit reached' : ''}`;
  // Staging names vary across attempts without changing the failure.
  const key = outcome.replace(/worker-tree\.json\.[0-9a-f-]{36}\.tmp/g, 'worker-tree.json.tmp');
  if (key !== retry?.outcome) log(outcome);
  const readClose = entry.phase === 'reaping' && entry.readClose;
  reapRetries.set(id, { ownership: entry.ownership, readClose,
    ...(readClose && (targetReaped || retry?.readCloseRootReaped) && { readCloseRootReaped: true }),
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
      const issue = snapshotIssueForLog(id, dir, cleanup.issue);
      deferReap(entry, input, `reap ${id}: ${issue ?? 'sonic cleanup incomplete'}`);
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
    const identity = !job.cli && status.slot === 'headless' && piSessionIdentity(job, status.session_file);
    if (!job.cli && end.state === 'waiting_orchestrator' && (!identity || (status.session_id && identity.id !== status.session_id)))
      end = { state: 'failed', exit_reason: 'pi exited without the session needed to answer its question' };
    // A pause (or a plain turn end without a report) is not a job close. On an
    // actual close, hand remaining sonic jobs to their own reapers before publishing it.
    if (status.slot === 'headless' && (stopped || end.state === 'closed')) {
      for (const child of headlessSonicChildren(dir)) if (child.state === 'open')
        writePrivateFile(join(child.dir, jobFiles.stopRequested), '', { mkdir: false });
    }
    const waiting = !stopped && end.state === 'waiting_orchestrator';
    const evidence = !stopped && end.exit_reason === missingRunnerReceipt ? missingRunnerEvidence(dir, job, status) : undefined;
    const settled: JobStatus = { ...status, ...end, ...evidence, ...(identity && !status.session_id && { session_id: identity.id }), ...(stopped ? { state: 'stopped', exit_reason: 'stopped' } : {}),
      output_written: !waiting && fs.existsSync(join(dir, jobFiles.report)), ...(waiting ? {} : { settled_at: now, ended_at: now }),
      stdout_bytes: size(jobFiles.sonicStdout), stderr_bytes: size(jobFiles.sonicStderr) };
    recordJobUsage(dir, job, settled);
    const latest = readJson<Job>(jobFile);
    let recorded = latest && recordSessions(dir, latest, settled, []);
    if (recorded && !waiting && shouldCheckSonicCitations(recorded, settled)) {
      const citations = checkSonicReportCitations(dir, recorded);
      if (citations) {
        recorded = { ...recorded, citations };
        writeJsonAtomic(jobFile, recorded, 2);
      }
    }
    if (recorded && !waiting && shouldRecordSonicReads(recorded, settled)) {
      recorded = { ...recorded, ...collectSonicReadFacts(dir, recorded, settled) };
      writeJsonAtomic(jobFile, recorded, 2);
    }
    if (settled.state === 'failed' && recorded && !recorded.exhaustion_marked) {
      const text = String(settled.exit_reason ?? settled.error ?? '');
      if (isQuotaFailure(text)) {
        const res = recordFailureExhaustion(home, bundled, dir, recorded, text);
        if (res.marked) {
          jobCache.invalidateFile(jobFile);
          recorded = { ...recorded, exhaustion_marked: true };
          if (res.reason !== text) {
            settled.exit_reason = res.reason;
            settled.error = res.reason;
          }
        }
      }
    }
    writeJsonAtomic(statusFile, settled);
    if (recorded && !waiting) writeJsonAtomic(jobFile, { ...recorded, reaped_at: now }, 2);
    const issue = snapshotIssueForLog(id, dir, cleanup.unrecoverable);
    if (issue) log(`reap ${id}: ${issue}; ${UNVERIFIED_TREE_NOTE}`);
    reapRetries.delete(id);
    return;
  }
  if (readInGrace) {
    const target = session?.fields.primary;
    const agent = target ? (await request('agent.get', { target }, { signal }))?.result?.agent : undefined;
    if (signal.aborted || (job?.resume_s === undefined && tabWasClosed(id, session))) return;
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
  const launchStamp = session ? (session.fields.launchId || session.fields.launch || `stamp:${session.stamp}`) : undefined;
  const reapArgs = [binScript('hud-reap'), dir, ...(launchStamp ? ['--launch', launchStamp] : [])];
  const { result, complete, issue, snapshot, unrecoverable } = await reapWorkerTree(dir, status,
    // Own a new process group so stopping hud-reap also stops its Herdr CLI child.
    () => runCommand(process.execPath, reapArgs, process.env, {
      budgetMs: REAP_BUDGET_MS, killGraceMs: REAP_KILL_GRACE_MS, killProcessGroup: true, signal,
    }), (run) => run.ok, { carry: retry?.snapshot, expectSnapshot, signal, treeGrant: tabTreeGrant });
  entry.snapshot = snapshot;
  const exit = signal.aborted ? 'aborted' : result.exitCode ?? result.reason;
  const groupIssue = result.groupCleanupIssue?.replace(/^group \d+ /, 'reaper group ');
  let reapReason = !result.ok && !signal.aborted && result.reason !== 'aborted'
    ? result.stderr.trim().split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? ''
    : '';
  if (reapReason) {
    if (reapReason.startsWith('hud-reap: ')) reapReason = reapReason.slice('hud-reap: '.length);
    if (reapReason.startsWith(`${dir}: `)) reapReason = reapReason.slice(dir.length + 2);
    else {
      try {
        const real = fs.realpathSync(dir);
        if (reapReason.startsWith(`${real}: `)) reapReason = reapReason.slice(real.length + 2);
      } catch { /* Keep the diagnostic as-is if the job dir is gone. */ }
    }
    reapReason = reapReason.replace(/[\r\n\x00-\x1f]+/g, ' ').trim().slice(0, 240);
  }
  const message = () => {
    const noted = snapshotIssueForLog(id, dir, issue);
    return `reap ${id} state=${status.state} exit=${exit}; ${reapReason ? `${reapReason}; ` : ''}${noted ? `${noted}; ` : ''}${groupIssue ? `${groupIssue}; ` : ''}${UNVERIFIED_TREE_NOTE}`;
  };
  if (signal.aborted || result.reason === 'aborted') { log(message()); return; }
  const refusal = result.exitCode === 1 &&
    result.stderr.trimEnd().endsWith(`: TAB ${tab} name changed or missing; not closing`) && !result.stderr.trim().includes('\n');
  // When ancestry cannot be recovered, only the tab outcome remains to be verified.
  if (!complete && !(unrecoverable && (result.ok || refusal))) {
    deferReap(entry, input, message(), refusal && !issue && !readClose, result.ok);
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
      const finalStatus = readJson<JobStatus>(statusFile) ?? latest;
      const citations = shouldCheckSonicCitations(receipt, finalStatus)
        ? checkSonicReportCitations(dir, receipt)
        : undefined;
      writeJsonAtomic(jobFile, { ...receipt, ...(citations ? { citations } : {}), reaped_at: new Date().toISOString() }, 2);
      log(message());
    }
    reapRetries.delete(id);
  } else {
    // There is no receipt to stamp. Don't repeat a finished reap on every scan.
    deferReap(entry, input, message(), true);
  }
}
function startReap(job: ReapInput) {
  const { id, session, ownership, readInGrace, resumeReadReap, retry } = job;
  const busy = [job.job?.worktree?.root, job.job?.cwd].filter((path): path is string => !!path);
  const entry: ActiveReap = { session, ownership, readClose: Boolean(readInGrace || resumeReadReap), busy,
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
  trackStart(id, targetRole, async () => {
    const res = await startQueuedJob(id, targetRole, overflowed);
    if (res.started) log(`queue start ${id} role=${targetRole}${overflowed ? ' (overflow from imp)' : ''}`);
    else if (res.failed) warn(`queue ${id}`, `queue start failed ${id}: ${res.reason ?? 'unknown'}`);
  });
}
function trackStart(id: string, targetRole: string, launch: () => Promise<void>) {
  if (inFlightStarts.has(id)) return;
  const promise = Promise.resolve().then(launch).catch((error) => {
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
  if (retryWatch && (!watcher || !flowsWatcher)) startWatch(); // Install before catch-up, only on the timer path.
  // Piggyback on the on-demand retention scan; never keep the watcher alive for housekeeping.
  const scanAt = performance.now(), housekeep = scanAt >= nextHomeRetention;
  if (housekeep) {
    retentionFailures.clear();
    nextHomeRetention = scanAt + HOME_RETENTION_INTERVAL_MS;
    pruneDisplayFiles(join(home, 'display'));
    const removed = pruneLegacyTrustBackups(home);
    if (removed) log(`pruned legacy trust backups: ${removed}`);
    const scratch = pruneProjectScratch(home);
    if (scratch !== null) log(`pruned project scratch entries: ${scratch}`);
  }
  const flows = workflowHeaders(home);
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
  const nowMs = Date.now(), checkPiExit = nowMs >= nextPiExitCheck;
  if (checkPiExit) { nextPiExitCheck = nowMs + cliCheck; checkAllTabs = true; }
  const tabChecks: { id: string; session: SessionEntry }[] = [], pendingTabRetries = new Set<string>();
  const scanAllTabs = !tabProbe && checkAllTabs, wakes = tabProbe ? null : tabWakes;
  if (!tabProbe) { checkAllTabs = false; tabWakes = new Map(); }
  const checkTab = (id: string, session: SessionEntry | null) => {
    // On the fork, absence of the old pane address is never terminal while exact PID+start is alive.
    if (!session || isDirectExecSession(session) || !hasLocalHerdrTarget(session.fields) || tabWasClosed(id, session)) return;
    const retry = tabRetries.get(id);
    const pending = retry?.stamp === session.stamp;
    if (pending) {
      pendingTabRetries.add(id);
      if (retry.at > nowMs) { nearest = Math.min(nearest, retry.at); return; }
    }
    if (!tabProbe && (pending || scanAllTabs || wakes?.has(`job:${id}`) ||
        (session.fields.tab && wakes?.has(`tab:${session.fields.tab}`)))) tabChecks.push({ id, session });
  };
  const listedIds = jobCache.listJobIds({ onError: (error) => { throw error; } });
  const liveIds = new Set(listedIds);
  const { held: heldJobs, evidence: evidenceJobs } = pinnedQueueJobs(home, flows);
  // An unanswered composed hand-back has no timeout. Keep its evidence and source
  // worktrees available until the run is stopped or settles, even after main exits.
  for (const file of flows.files) {
    if (!file.endsWith('.json') || !isComposedId(file.slice(0, -5))) continue;
    const run = flows.header<ComposedRun>(file);
    if (run?.template !== 'composed' || (run.state !== 'working' && run.state !== 'paused')) continue;
    for (const cursor of Object.values(run.steps ?? {})) {
      if (cursor.job) heldJobs.add(cursor.job);
      for (const item of cursor.items ?? []) if (item.job) heldJobs.add(item.job);
    }
  }
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
        if (active.readClose || active.phase === 'preflight') checkTab(id, active.session);
        continue;
      }
      if (inFlightWorktrees.has(id) || !fs.lstatSync(dir).isDirectory()) continue;
      const piLinks: string[] = [], piLocalFiles: string[] = [];
      try {
        const loops: string[] = [];
        for (const folder of sessionFolders(dir)) for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
          if (!entry.name.endsWith('.jsonl')) continue;
          const file = join(folder, entry.name);
          if (entry.isFile()) piLocalFiles.push(file);
          if (!entry.isSymbolicLink()) continue;
          try { fs.statSync(file); piLinks.push(file); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ELOOP') loops.push(file);
          }
        }
        // Identify every member before unlinking any of them.
        for (const link of loops) { fs.unlinkSync(link); log(`unlink loop ${link}`); }
      } catch (error) { warn(`keep ${id} scan`, `keep ${id} scan: ${(error as Error).message}`); }
      const jobFile = join(dir, jobFiles.job), statusFile = join(dir, jobFiles.status);
      let job: Job | null, status: Partial<JobStatus> | null, statusAt: number | null, session: SessionEntry | null;
      try { job = readJson<Job>(jobFile); ({ value: status, at: statusAt } = readJsonEntry<JobStatus>(statusFile)); session = jobCache.readSession(id, { throwOnError: true }); }
      // Unreadable lifecycle or tab evidence may still belong to an open job.
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') open = true; throw error; }
      if (job?.worktree?.root) {
        knownWorktrees.add(job.worktree.root);
        knownWorktreeRoots.add(job.worktree.main_root);
      }
      const held = heldJobs.has(id);
      const retained = held || evidenceJobs.has(id);
      if (held) markBusy(job); // A continuation may share a held source worktree.
      if (isShellLaunchedWorker(session?.fields) && !job?.reaped_at) {
        markBusy(job);
        warn(`legacy worker ${id}`, `${id}: ${SHELL_WORKER_UNSUPPORTED}`);
        continue;
      }
      if (status?.state === 'queued' && job && !job.reaped_at) {
        open = true;
        queuedJobs.push({ id, job, queuedAt: queuedTimestamp(job) });
        continue;
      }
      if (job && (status || piLinks.length)) {
        // Real tab files are a legacy preservation layout; new tabs link to the native store.
        if (job.headless || status?.slot === 'headless' || status?.slot === 'sonic') piLinks.push(...piLocalFiles);
        job = recordSessions(dir, job, status ?? {}, piLinks);
      }
      if (job?.headless && job.reaped_at && headlessFollowupReady(status) && hasHeadlessSends(dir) &&
          !fs.existsSync(join(dir, jobFiles.stopRequested))) {
        open = true;
        markBusy(job);
        countWorking(job.role);
        trackStart(id, job.role, async () => {
          try {
            const result = await resumeHeadlessQueue(id);
            if (!result || result.code === 'worker_reopening') await delay(100);
          } catch {
            warn(`follow-up ${id}`, `resume queued sends ${id}: could not read or reopen this turn`);
            await delay(1000);
          }
        });
        continue;
      }
      const tab = session?.fields.tab;
      const ownership = reapOwner(session, status);
      const previous = reapRetries.get(id);
      const retry = !job?.reaped_at && previous?.ownership === ownership ? previous : null;
      const direct = isDirectExecSession(session);
      const directKey = direct ? directPaneKey(session!.fields.launchId!, session!.fields.terminalId!) : null;
      const directRoot = direct ? directRootPid(session) : null;
      const closedForLaunch = tabWasClosed(id, session);
      const paneExit = directKey ? exitedLaunches.get(directKey) ?? null : null;
      if (job && session && permissionTarget(session) && !job.headless && !job.bro && !job.jev && !job.reaped_at &&
          (permissionsSeen.has(id) || ['working', 'waiting_orchestrator', 'blocked'].includes(status?.state ?? ''))) {
        const live = !paneExit && ['working', 'waiting_orchestrator', 'blocked'].includes(status?.state ?? '');
        const key = `${session.stamp}:${status?.state}:${status?.blocked ?? false}:${status?.blocked_at ?? ''}:${!!paneExit}`;
        const seen = permissionsSeen.get(id);
        if (!permissionChecks.has(id) && (seen?.key !== key || seen.next <= nowMs) && permissionChecks.size < 8) {
          permissionsSeen.set(id, { pane: session.fields.left!, key, next: live ? nowMs + cliCheck : Infinity });
          checkPermission(dir, job, status, session);
        }
        if (live) {
          const due = permissionsSeen.get(id)?.next;
          if (due !== undefined && due > nowMs) nearest = Math.min(nearest, due);
        }
      }
      if (direct && directKey && directRoot && !job?.reaped_at && !['done', 'closed', 'failed', 'stopped'].includes(status?.state ?? '')) {
        nearest = Math.min(nearest, nextPiExitCheck);
        if (!paneExit && !deadDirectRoots.has(directKey)) {
          if (workerAlive(directRoot.pid, directRoot.start) === false) {
            const firstDead = deadDirectObservedAt.get(directKey) ?? nowMs;
            if (!deadDirectObservedAt.has(directKey)) rememberTab(deadDirectObservedAt, directKey, firstDead);
            if (nowMs - firstDead >= 150) {
              rememberTab(deadDirectRoots, directKey, true);
              deadDirectObservedAt.delete(directKey);
            } else {
              nearest = Math.min(nearest, firstDead + 150);
            }
          } else {
            deadDirectObservedAt.delete(directKey);
          }
        }
      }
      const reconciledDeadRoot = Boolean(directKey && deadDirectRoots.has(directKey));
      // A previous read-close attempt may have closed its own tab before retrying cleanup.
      const tabClosed = !retry?.readClose && closedForLaunch;
      if (!job?.headless && !job?.reaped_at &&
          (retry?.readClose || !['done', 'closed', 'failed', 'stopped'].includes(status?.state ?? ''))) checkTab(id, session);
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
        if (job?.role === 'council') {
          const councilFlow = flows.files.includes(`${id}.json`) ? flows.header<CouncilRun>(`${id}.json`) : null;
          const activeCouncilFlow = councilFlow?.template === 'council' && councilFlow.state === 'working';
          const settledCouncil = settleMainCouncil(home, jobCache, id, { trigger: 'watcher', activeFlow: activeCouncilFlow, now });
          if (settledCouncil) {
            job = settledCouncil.job;
            status = settledCouncil.status;
            statusAt = null;
          } else if (!activeCouncilFlow && fs.existsSync(`${statusFile}.stop-requested`)) {
            update = { state: 'stopped', reason: null, exit_reason: 'Council stopped', ended_at: now };
          }
        } else if (job?.cli) {
          const pid = supervisorPid(dir, status);
          const liveSupervisor = pid && isProcAlive(pid);
          if (pid && liveSupervisor) watch(dir, pid);
          // A live supervisor delivering /quit (or holding a direct-exec exit event we missed) owns the terminal write.
          const quitting = tabClosed && liveSupervisor && fs.existsSync(`${statusFile}.quit-${pid}`);
          const deferDirect = direct && Boolean(liveSupervisor) && !paneExit;
          if (!quitting && !deferDirect && (tabClosed || (pid && !liveSupervisor) || (direct && (paneExit || (!liveSupervisor && reconciledDeadRoot))))) {
            // The quit marker is removed after STATUS is published; ignore a snapshot taken before that write.
            ({ value: status, at: statusAt } = readJsonEntry<JobStatus>(statusFile));
            if (['done', 'closed', 'failed', 'stopped'].includes(status?.state ?? '')) { schedule(); continue; }
            if ((tabClosed || paneExit || reconciledDeadRoot) && !sameSession(id, session)) { schedule(); continue; }
            const alive = workerAlive(status?.pid ?? directRoot?.pid ?? null, status?.pid_start_time ?? directRoot?.start ?? null);
            const end = terminalFact({ alive, paneExit, directExec: direct, tabClosed, stop: fs.existsSync(`${statusFile}.stop-requested`),
              turn: readTurn(dir), reportSig: reportSignature(dir) });
            if (!end && alive === true && (status?.pid ?? directRoot?.pid) && !liveSupervisor) {
              // The remaining third-party worker owns no HUD socket. Back off until a replacement
              // supervisor, a tab event, or verified worker exit ends this degraded handoff.
              const orphanPid = (status?.pid ?? directRoot?.pid)!;
              orphans.add(id);
              let retry = orphanRetries.get(id);
              if (!retry || retry.pid !== orphanPid || retry.at <= Date.now()) {
                const delay = Math.min(MAX_REAP_BACKOFF_MS, retry?.pid === orphanPid ? retry.delay * 2 : cliCheck);
                orphanRetries.set(id, retry = { pid: orphanPid, delay, at: Date.now() + delay });
              }
              nearest = Math.min(nearest, retry.at);
            }
            const reason = alive === true ? 'supervisor exited; worker still running' : 'supervisor exited; worker liveness unknown';
            if (end) {
              if (tabClosed && !paneExit && !fs.existsSync(`${statusFile}.stop-requested`) && !end.outputWritten)
                recordStopOrigin(dir, 'pane_vanished', status?.state, now);
              update = { state: end.state, reason: null, blocked: false, output_written: end.outputWritten,
                ...(paneExit ? { runner_exit_code: paneExit.exitCode, runner_exit_signal: paneExit.signal as NodeJS.Signals | null } : {}),
                settled_at: status?.settled_at ?? now, ended_at: now, exit_reason: end.exitReason,
                error: end.state === 'failed' ? end.exitReason : null, updated_at: now };
            }
            else if (status?.state !== 'waiting_orchestrator' || status.reason !== reason)
              update = { state: 'waiting_orchestrator', reason, blocked: false, ended_at: null, exit_reason: null, error: null };
          }
        } else if (!job?.bro && !job?.jev && fs.existsSync(`${statusFile}.stop-requested`)) {
          // Stop intent takes precedence over a tab closing while the worker is exiting.
          const stopStatus = direct && directRoot && status
            ? { ...status, pid: status.pid ?? directRoot.pid, pid_start_time: status.pid_start_time ?? directRoot.start }
            : status;
          const terminal = settleStoppedPi(statusFile, stopStatus);
          if (terminal) { status = terminal; jobCache.invalidateFile(statusFile); statusAt = null; }
          else if (status) {
            // The marker or tab event can arrive before the PID is gone.
            open = true;
            nearest = Math.min(nearest, Date.now() + cliCheck); // Pi tabs have no HUD runner.
            if (isWorkingForCap(job, status)) countWorking(job!.role);
            continue;
          }
        } else if (direct && job && !job.bro && !job.jev && !job.headless && !job.reaped_at && paneExit) {
          // Direct-exec Pi exit reported by herdr's pane.exited event (matched by launch_id + root terminal_id).
          const latest = readJson<JobStatus>(statusFile);
          if (['done', 'closed', 'failed', 'stopped'].includes(latest?.state ?? '')) {
            status = latest;
            jobCache.invalidateFile(statusFile);
            statusAt = null;
          } else if (sameSession(id, session) && (!latest || reapOwner(session, latest) === ownership)) {
            status = latest;
            const baseFields: Partial<JobStatus> = latest ? {} : {
              version: 1, task_dir: dir, slot: 'primary', harness: 'pi',
              ...(directRoot ? { pid: directRoot.pid, pid_start_time: directRoot.start } : {}),
            };
            if (paneExit.exitCode === 0 && !paneExit.signal) {
              const settled = Boolean(latest?.output_written || (latest && readCloseTurn(dir, job, latest)));
              const failReason = settled ? null : lastTurnError(dir, latest ?? status ?? {}, job) ?? 'process exited without a report';
              update = settled
                ? { ...baseFields, state: 'closed', reason: null, blocked: false, idle_deadline_at: null,
                    settled_at: latest?.settled_at ?? now, ended_at: now, exit_reason: latest?.exit_reason ?? 'settled',
                    error: null, runner_exit_code: 0, runner_exit_signal: null, updated_at: now }
                : { ...baseFields, state: 'failed', reason: null, blocked: false, idle_deadline_at: null,
                    ended_at: now, exit_reason: failReason, error: failReason,
                    runner_exit_code: 0, runner_exit_signal: null, updated_at: now };
            } else {
              const exitReason = lastTurnError(dir, latest ?? status ?? {}, job) ?? formatPaneExitReason(paneExit);
              update = { ...baseFields, state: 'failed', reason: null, blocked: false, idle_deadline_at: null,
                ended_at: now, exit_reason: exitReason, error: exitReason,
                runner_exit_code: paneExit.exitCode, runner_exit_signal: paneExit.signal as NodeJS.Signals | null, updated_at: now };
            }
          }
        } else if (direct && job && !job.bro && !job.jev && !job.headless && !job.reaped_at && reconciledDeadRoot && !retry?.readCloseRootReaped) {
          // A verified read-close reap may have ended the root before descendant cleanup failed. Let that retry finish;
          // otherwise exact PID/start death without pane.exited never proves a successful exit.
          const latest = readJson<JobStatus>(statusFile);
          if (['done', 'closed', 'failed', 'stopped'].includes(latest?.state ?? '')) {
            status = latest;
            jobCache.invalidateFile(statusFile);
            statusAt = null;
          } else if (sameSession(id, session) && (!latest || reapOwner(session, latest) === ownership) &&
              directRoot && workerAlive(directRoot.pid, directRoot.start) === false) {
            status = latest;
            const baseFields: Partial<JobStatus> = {
              ...(latest ? {} : { version: 1, task_dir: dir, slot: 'primary', harness: 'pi' }),
              pid: latest?.pid ?? directRoot.pid,
              pid_start_time: latest?.pid_start_time ?? directRoot.start,
            };
            const exitReason = 'worker exited (exit unknown)';
            update = { ...baseFields, state: 'failed', reason: null, blocked: false, idle_deadline_at: null,
              ended_at: now, exit_reason: exitReason, error: exitReason, updated_at: now };
          }
        } else if (direct && job && !job.bro && !job.jev && !job.headless && !job.reaped_at) {
          // Direct-exec Pi with live exact PID+start stays unresolved across pane moves/tab.closed; never fall through to stock Pi or tabClosed.
        } else if (job && !job.bro && !job.jev && !job.headless && !job.reaped_at &&
            status?.pid && status.pid_start_time && piTurnUnfinished(status)) {
          // Native Pi owns no HUD runner socket. Even a confirmed disappearance is not worker-exit evidence.
          nearest = Math.min(nearest, nextPiExitCheck);
          if (!retry?.readClose && (tabClosed || (!tab && !session?.fields.left && checkPiExit)) &&
              workerTreeRootGone(status.pid, status.pid_start_time)) {
            const priorState = readJson<JobStatus>(statusFile)?.state;
            const terminal = settleStoppedPi(statusFile, status, true, tabClosed ? () => sameSession(id, session) : undefined);
            if (terminal) {
              if (!fs.existsSync(`${statusFile}.stop-requested`))
                recordStopOrigin(dir, 'pane_vanished', priorState, terminal.ended_at ?? new Date().toISOString());
              status = terminal;
              jobCache.invalidateFile(statusFile);
              statusAt = null;
            }
          }
        } else if (tabClosed && !(job?.resume_s !== undefined && readCloseTurn(dir, job, status))) {
          // A reopen rollback publishes closed STATUS before restoring the old
          // SESSION. Don't pair that receipt with a working status read earlier.
          const latest = readJson<JobStatus>(statusFile);
          if (latest?.state !== status?.state || !sameSession(id, session) || reapOwner(session, latest) !== ownership) {
            schedule();
            continue;
          }
          status = latest;
          if (!fs.existsSync(`${statusFile}.stop-requested`))
            recordStopOrigin(dir, 'pane_vanished', status?.state, now);
          update = { state: 'failed', exit_reason: 'tab closed', ended_at: now };
        }
        if (update) {
          if ((tabClosed || paneExit || reconciledDeadRoot) && !sameSession(id, session)) { schedule(); continue; }
          status = { ...status, ...update };
          writeJsonAtomic(statusFile, status);
          statusAt = null;
        }
      }
      if (isWorkingForCap(job, status)) countWorking(job!.role);
      // A persisted launch without STATUS is still open until dispatch returns.
      if (!status) {
        if (job && (job.dispatch_exit_code === null || job.dispatch_exit_code === 0)) { open = true; markBusy(job); }
        else if (job?.launch_unknown) markBusy(job);
        continue;
      }
      // Land can start in idle_grace as well as after closure; its receipt is outside jobs/.
      const land = job?.worktree && landAttempt(home, id, flows).prior;
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
      const resumeReadReap = retry?.readClose && (closedForLaunch || workerTreeRootGone(status.pid ?? directRoot?.pid, status.pid_start_time ?? directRoot?.start));
      if (job && ['idle_grace', 'done', 'closed', 'failed', 'stopped'].includes(status.state ?? ''))
        recordJobUsage(dir, job, status);
      if (job && shouldCheckSonicCitations(job, status)) {
        const citations = checkSonicReportCitations(dir, job);
        if (citations) {
          job = { ...job, citations };
          try { writeJsonAtomic(jobFile, job, 2); }
          catch (error) { warn(`citations ${id}`, `record citations ${id}: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); }
        }
      }
      if (job && shouldRecordSonicReads(job, status)) {
        job = { ...job, ...collectSonicReadFacts(dir, job, status) };
        try { writeJsonAtomic(jobFile, job, 2); }
        catch (error) { warn(`reads ${id}`, `record reads ${id}: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); }
      }
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
      const tryRetention = !retentionFailures.has(id);
      if (tryRetention && job && !held && (status.state === 'done' || !tab || job.reaped_at) &&
          pruneJobLogs(dir, job, status, Date.now(), home) === 'failed') retentionFailures.add(id);
      if (!readClose && !['closed', 'failed', 'stopped'].includes(status.state ?? '')) continue;
      if (status.state === 'failed' && job && !job.exhaustion_marked) {
        let text = String(status.exit_reason ?? status.error ?? '');
        let upgraded = false;
        if (isGenericNoReportReason(text)) {
          const checkStamp = `${statusAt ?? ''}:${status.ended_at ?? ''}:${text}`;
          if (turnErrorChecks.get(id) !== checkStamp) {
            rememberTab(turnErrorChecks, id, checkStamp);
            const turnErr = lastTurnError(dir, status, job);
            if (turnErr) {
              text = turnErr;
              upgraded = true;
            }
          }
        }
        if (isQuotaFailure(text)) {
          const res = recordFailureExhaustion(home, bundled, dir, job, text);
          if (res.marked) jobCache.invalidateFile(jobFile);
          if ((res.marked && res.reason !== text) || upgraded) {
            const finalReason = res.marked ? res.reason : text;
            status = { ...status, exit_reason: finalReason, error: finalReason };
            writeJsonAtomic(statusFile, status);
            statusAt = null;
          }
        } else if (upgraded) {
          status = { ...status, exit_reason: text, error: text };
          writeJsonAtomic(statusFile, status);
          statusAt = null;
        }
      }
      const ended = Date.parse(job?.reaped_at ?? status.settled_at ?? status.ended_at ?? '');
      const resumeUntil = job && resumeDeadline(job, status);
      const resumable = !!resumeUntil && resumeUntil > Date.now();
      if (resumable && job?.worktree) nearest = Math.min(nearest, resumeUntil);
      const launchUnknown = Boolean(job?.launch_unknown || status.launch_unknown || status.exit_reason === 'launch_unknown');
      const worktreeSafe = Boolean(!launchUnknown && (job?.reaped_at || (!session && (job?.dispatch_exit_code ?? 0) > 0)));
      if (!worktreeSafe || resumable) markBusy(job);
      // With a tab, wait for successful reap; keep the checkout available for native resume or open owner holds.
      if (worktreeSafe && !resumable && !checkingReport && !landing && !held && job?.worktree && !job.worktree_removed_at && fs.lstatSync(jobFile).isFile()) {
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
      const closedAt = Number.isFinite(ended) ? ended : (statusAt ?? fs.statSync(statusFile).mtimeMs);
      const now = Date.now();
      if (!landing && !checkingReport && !resumable && !launchUnknown && !retained && closedAt + JOB_RETENTION_MS < now && (!tab || job?.reaped_at)) {
        if (!tryRetention || (job && now <= closedAt + 7 * JOB_RETENTION_MS && hasLocalPiSession(dir, job, status, piLocalFiles))) continue;
        let cold: { wroteRaw: boolean };
        try { cold = archiveJobCold(home, dir, id, job, status, now); }
        catch (error) {
          retentionFailures.add(id);
          warn(`keep ${id} cold archive`, `keep ${id} cold archive: ${(error as Error).message}`);
          continue;
        }
        // The raw snapshot has the job-local bytes; now preserve legacy Pi history in its native store.
        const sessionsPreserved = job?.cli || job?.bro || job?.jev || preserveSessions(dir);
        if (cold.wroteRaw) {
          try { enforceColdRawCap(home); }
          catch (error) { warn('cold raw cap', `cold raw cap: ${(error as Error).message}`); }
        }
        if (!sessionsPreserved) {
          retentionFailures.add(id);
          continue;
        }
        archiveJob(home, dir, id, job, status, now, log);
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (error) {
          retentionFailures.add(id);
          throw error;
        }
        jobCache.evictJob(id);
        reapRetries.delete(id);
        retentionFailures.delete(id);
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
  // The batch driver watches settlement itself; this on-demand watcher only recovers a dead driver.
  const { files, header } = flows;
  const seenFlowNoticeMarkers = new Set<string>();
  const flowScanNow = Date.now();
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    try {
      if (isComposedId(id)) {
        const run = header<ComposedRun>(file);
        if (run?.template !== 'composed') continue;
        if (run.state === 'paused' || run.state === 'working') {
          nearest = Math.min(nearest, deliverFlowNotices(id, run, flowScanNow, seenFlowNoticeMarkers));
        }
        if (!composedActive(run)) continue;
        wakeWorkflow(home, run, true);
      } else if (isTicketQueueId(id)) {
        const q = header<TicketQueue>(file);
        if (!q) continue;
        if (!q.task && (q.state === 'paused' || q.state === 'working')) {
          nearest = Math.min(nearest, deliverFlowNotices(id, q, flowScanNow, seenFlowNoticeMarkers));
        }
        if (q.state !== 'working') continue;
        wakeWorkflow(home, q);
      } else if (/^j[0-9a-f]{16}$/.test(id)) {
        const run = header<CouncilRun | PrewalkRun>(file);
        if ((run?.template !== 'council' && run?.template !== 'prewalk') || run.state !== 'working') continue;
        wakeWorkflow(home, run);
      } else if (isBatchId(id)) {
        const b = header<Batch>(file);
        if (!b || !batchActive(b)) continue;
        wakeWorkflow(home, b);
      } else if (isFlowId(id)) {
        const f = readLand(home, id, flows);
        // A sealed owner is reconciled, never re-elected. Keep checking in case
        // there was no live job directory to subscribe to its lifetime socket.
        if (!f || !activeLand(f)) continue;
      } else continue;
      nearest = Math.min(nearest, Date.now() + 5000);
    } catch (error) { warn(`flow ${id}`, `flow ${id}: ${(error as Error).message}`); }
  }
  // Archive expired jobs before dropping the flow receipts those archives read.
  if (housekeep) pruneLandFlows(home);
  for (const id of [...reapRetries.keys()]) if (!liveIds.has(id)) reapRetries.delete(id);
  for (const id of snapshotWarnings) if (!liveIds.has(id)) snapshotWarnings.delete(id);
  for (const id of goneTabs.keys()) if (!liveIds.has(id)) goneTabs.delete(id);
  for (const id of tabRetries.keys()) if (!pendingTabRetries.has(id)) tabRetries.delete(id);
  for (const id of turnErrorChecks.keys()) if (!liveIds.has(id)) turnErrorChecks.delete(id);
  for (const id of retentionFailures) if (!liveIds.has(id)) retentionFailures.delete(id);
  probeTabs(tabChecks);
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
  const watching = Boolean(watcher && flowsWatcher);
  workSummary.publish({ watching, ids: listedIds, jobsExist: true, flows });
  open ||= workSummary.hasActiveLand;
  runners.finishScan();
  for (const id of orphanRetries.keys()) if (!orphans.has(id)) orphanRetries.delete(id);
  for (const id of permissionsSeen.keys()) if (!liveIds.has(id)) permissionsSeen.delete(id);
  for (const marker of [...flowNoticeRetries.keys()]) if (!seenFlowNoticeMarkers.has(marker)) flowNoticeRetries.delete(marker);
  const hasInFlight = inFlightReaps.size > 0 || inFlightWorktrees.size > 0 || inFlightStarts.size > 0 || permissionChecks.size > 0 || flowNoticeChecks.size > 0;
  if ((open || hasInFlight || nearest !== Infinity) && !watching) nearest = Math.min(nearest, Date.now() + degradedMs);
  if (nearest !== Infinity) timer = setTimeout(() => scan(true), Math.max(1, Math.min(0x7fffffff, Math.ceil(nearest - Date.now()))));
  if (!queued && !open && !hasInFlight && nearest === Infinity) {
    stopScheduling();
    notify('idle');
  }
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
  // A degraded jobs watch can retry repeatedly. Keep the independent flow watch
  // rather than replacing its handle and leaving the old one alive.
  if (!flowsWatcher) try {
    const flows = join(home, 'flows');
    fs.mkdirSync(flows, { mode: 0o700, recursive: true });
    flowsWatcher = fs.watch(flows, { persistent: false }, (_event, name) => {
      const file = name?.toString();
      const flowId = file?.split('.', 1)[0];
      const owner = isFlowId(flowId) ? `j${flowId.slice(1, 17)}` : flowId;
      if (owner && JOB_ID_RE.test(owner) && retentionFailures.delete(owner)) schedule();
      // Ticket queues still wake their existing recovery scan; they are not counted as lands.
      if (!file || (file.endsWith('.json') && isFlowId(file.slice(0, -5))) || /^[bqw][a-f0-9]{16}\.json$/.test(file)) schedule();
    }).once('error', () => {
      flowsWatcher?.close(); flowsWatcher = undefined;
      workSummary.markDegraded();
      schedule();
    });
  } catch { /* The existing degraded retry handles an unavailable directory. */ }
  if (watcher) return;
  try {
    watcher = fs.watch(jobs, { recursive: true }, (event, filename) => {
      const path = filename?.toString();
      jobChanges.change(path ?? '');
      if (path?.endsWith(`/${RUNNER_READY}`)) { runners.ready(join(jobs, dirname(path))); schedule(); return; }
      if (path?.endsWith(`/${jobFiles.session}`)) wakeTab(`job:${dirname(path)}`);
      const watchedJob = path?.split('/')[0];
      if (watchedJob && retentionFailures.delete(watchedJob)) schedule();
      if (event === 'rename' && path && /^[^/]+\/(sonic-session\.jsonl|(?:\.dispatch\/[^/]+\/)?sessions(?:\/[^/]+\.jsonl)?)$/.test(path)) schedule();
      if (!path || !path.includes('/') || /^[^/]+\/(supervisor\.pid|STATUS\.json(?:\.(?:stop|timeout)-requested)?|SESSION\.txt|sonic-(?:exit|stop)\.json|headless-sends\.json|job\.json|permissions\.json|checks\.json|report\.md|done\.json|turn\.json|qa(?:\/[^/]+)?)$/.test(path)) schedule();
    }).on('error', (error) => {
      if (stopped) return;
      warn('watch error', `watch error: ${error.message}`);
      watcher?.close(); watcher = undefined;
      jobChanges.stop();
      workSummary.markDegraded();
      clearTimeout(timer);
      timer = setTimeout(() => scan(true), degradedMs);
    });
  } catch (error) { warn('watch error', `watch error: ${(error as Error).message}`); }
}

export function openRuntime(emit: typeof notify) {
  notify = emit;
  return {
    shutdown,
    tab(id: string) { if (id) wakeTab(`tab:${id}`); schedule(); },
    tabClosedByLaunch(_launchId: string, tabId?: string) {
      if (tabId) wakeTab(`tab:${tabId}`);
      schedule();
    },
    paneExited(launchId: string, terminalId: string, exit: PaneExit) {
      if (launchId && terminalId) rememberTab(exitedLaunches, directPaneKey(launchId, terminalId), exit);
      schedule();
    },
    paneClosedByLaunch(_launchId: string, _terminalId: string) {
      schedule();
    },
    panePermissionChanged(pane: string) {
      for (const entry of permissionsSeen.values()) if (entry.pane === pane && entry.next !== Infinity) {
        entry.next = 0;
        schedule();
      }
    },
    // A subscription ack carries no permission-state change. Keep the per-pane check schedule.
    reconcileTabs() { checkAllTabs = true; schedule(); },
    pause() {
      if (stopped) return null;
      // Stop admitting scans; don't rely on a 30 s tick landing between two reaps.
      return new Promise<Handoff | null>((resolve) => { pauseReady = resolve; drained(); });
    },
    start(state: Handoff | null) {
      if (state && state.version !== 1) throw new Error('incompatible watcher handoff');
      if (state) ({ reapRetries, preflightHold, worktreeRetries } = state);
      if (state?.summaryGeneration) workSummary.setGeneration(state.summaryGeneration);
      checkAllTabs = true;
      worktreeSweepDone = readWorktreeSweepDone();
      sweptWorktrees.clear();
      sweptArchiveRoots.clear();
      retentionFailures.clear();
      sweepStats = { removed: 0, kept: 0 };
      stopped = false;
      startWatch();
      scan();
    },
  };
}
