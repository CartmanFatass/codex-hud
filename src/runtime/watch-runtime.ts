/** On-demand file-event reaper. Pi owns grace; pi-role-reap owns tab safety. */
import { isQuotaFailure, recordFailureExhaustion } from '../roles/roster.js';
import { terminalFact, workerAlive, readTurn, reportSignature, REPORT_READ_EXIT } from '../mcp/cli-judge.js';
import { reapWorkerTree, UNVERIFIED_TREE_NOTE, workerTreeRootGone } from '../roles/worker-tree.js';
import { piReadSettlement } from '../mcp/pi-read-settlement.js';
import { checkBinding, readCheckReceipt, sameChecks } from '../roles/job-checks.js';
import { reapWorktree, mainHead } from '../mcp/managed-worktree.js';
import { runCommand } from '../roles/herdr-run.js';
import { archiveJob } from '../roles/job-archive.js';
import { landAttempt, activeLand } from '../mcp/land-state.js';
import { settleStoppedPi } from '../mcp/pi-stop-settlement.js';
import { writePrivateFile } from '../utils/atomic-fs.js';
import type { Job, JobStatus, WorkerTreeSnapshot } from '../mcp/job-contracts.js';
import { jobFiles, BUNDLED_ROOT, binScript } from '../mcp/paths.js';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from '../runtime/herdr-socket.js';

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
const REAP_BUDGET_MS = 135_000;
const REAP_KILL_GRACE_MS = 2_000;
const SHUTDOWN_DRAIN_MS = 3_000;
fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
const cache = new Map<string, { stamp: string; value: unknown }>();
const seen = new Set<string>();
function read(file: string): string | null;
function read<T>(file: string, parse: (text: string) => T): T | null;
function read(file: string, parse: (text: string) => unknown = (text) => text) {
  try {
    const st = fs.statSync(file);
    seen.add(file);
    const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    const hit = cache.get(file);
    if (hit?.stamp === stamp) return hit.value;
    const value = parse(fs.readFileSync(file, 'utf8'));
    cache.set(file, { stamp, value });
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function parseJson<T>(text: string | null): T | null {
  try { return text === null ? null : JSON.parse(text) as T; }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
}
function readFresh(file: string) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
const json = <T>(file: string) => read(file, parseJson<T>);
const jsonFresh = <T>(file: string) => parseJson<T>(readFresh(file));
const log = (message: string) => {
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); }
  catch (error) { console.error(`watch log: ${(error as Error).message}; ${message}`); }
};
const warnings = new Map<string, number>();
function warn(kind: string, message: string) {
  const now = Date.now();
  if (now - (warnings.get(kind) ?? -Infinity) < 60000) return;
  warnings.set(kind, now);
  log(message);
}
let watcher: fs.FSWatcher | undefined, timer: NodeJS.Timeout;
let notify: (event: 'subscribe' | 'idle') => void, subscribed = false,
  queued = false,
  stopped = false,
  reapBacklog = false;
type Retry = { ownership: string; readClose: boolean; at: number; snapshot?: WorkerTreeSnapshot };
type ReapInput = { id: string; dir: string; job: Job | null; status: Partial<JobStatus>; session: string; tab: string;
  ownership: string; retry: Retry | null; readInGrace: string | null; resumeReadReap?: boolean; jobFile: string; statusFile: string };
type ActiveReap = { tab: string; ownership: string; readClose: boolean; busy: string[]; phase: 'preflight' | 'reaping';
  controller: AbortController; promise?: Promise<void> };
const closedTabs = new Set<string>();
let reapRetries = new Map<string, Retry>(), preflightHold = new Map<string, { ownership: string; token: string; until: number }>();
let worktreeRetries = new Map<string, number>();
type Handoff = { version: 1; reapRetries: typeof reapRetries; preflightHold: typeof preflightHold; worktreeRetries: typeof worktreeRetries };
const inFlightReaps = new Map<string, ActiveReap>();
const inFlightWorktrees = new Map<string, Promise<void>>();
const worktreeLocks = new Set<string>(), checking = new Set<string>();
let pauseReady: ((state: Handoff | null) => void) | undefined;
function drained() {
  if (!pauseReady || inFlightReaps.size || inFlightWorktrees.size || checking.size) return;
  stopScheduling();
  pauseReady({ version: 1, reapRetries, preflightHold, worktreeRetries });
  pauseReady = undefined;
}
function checksOpen(id: string, dir: string, job: Job | null, status: Partial<JobStatus>) {
  if (!job?.checks?.length) return false;
  if (checking.has(id)) return true;
  const previous = readCheckReceipt(dir);
  if (previous?.state === 'running' && workerAlive(previous.pid ?? null, previous.start ?? null) === true) return true;
  const binding = checkBinding(dir, job, status);
  if (!binding || (previous?.state === 'done' && sameChecks(binding, previous))) return false;
  const child = spawn(process.execPath, [binScript('hud-check'), dir, JSON.stringify(binding)], { stdio: 'ignore' });
  child.unref();
  checking.add(id);
  child.once('error', (error) => { checking.delete(id); drained(); warn(`checks ${id}`, `checks ${id}: ${error.message}`); });
  child.once('exit', (code) => {
    checking.delete(id);
    drained();
    if (code === 0) schedule();
    else warn(`checks ${id}`, `checks ${id}: helper exit=${code}`);
  });
  return true;
}
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  notify('subscribe');
}
function stopScheduling() {
  stopped = true;
  watcher?.close();
  watcher = undefined;
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
  // Check helpers own their own lifetime. Reap helpers must exit before we release watch.pid.
  await Promise.all([Promise.allSettled(reaps.map((entry) => entry.promise)), worktrees]);
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
  const fromFile = Number(read(join(dir, jobFiles.supervisorPid))?.trim());
  if (Number.isInteger(fromFile) && fromFile > 1) return fromFile;
  const pid = status?.supervisor_pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 ? pid : null;
}
function supervisorAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
function readCloseTurn(dir: string, job: Job | null, status: Partial<JobStatus> | null) {
  return status?.state === 'idle_grace' && job && !job.reaped_at ? piReadSettlement(dir, job, status) : null;
}
function writeJsonAtomic(file: string, value: Partial<JobStatus> | Job, indent?: number) {
  writePrivateFile(file, JSON.stringify(value, null, indent) + '\n', { mkdir: false });
}
function startWorktree(id: string, file: string, job: Job) {
  const root = job.worktree!.main_root;
  if (worktreeLocks.has(root)) return; // The owning task reschedules the scan on release.
  worktreeLocks.add(root);
  const promise = Promise.resolve().then(async () => {
    const result = await reapWorktree(id, { job: job.job, cwd: job.cwd, worktree: job.worktree! }, home);
    const latest = jsonFresh<Job>(file);
    if (latest && !latest.worktree_removed_at && JSON.stringify(latest.worktree) === JSON.stringify(job.worktree))
      writeJsonAtomic(file, { ...latest, worktree_kept_reason: undefined, worktree_checked_head: undefined, ...result }, 2);
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
const reapOwner = (session: string | null, status: Partial<JobStatus> | null) => JSON.stringify([session, status?.pid, status?.pid_start_time]);
async function reapJob(entry: ActiveReap, { id, dir, job, status, session, tab, retry, readInGrace, resumeReadReap, jobFile, statusFile }: ReapInput) {
  const { controller: { signal }, ownership, readClose } = entry;
  const sessionFile = join(dir, jobFiles.session);
  if (readInGrace) {
    const target = session.match(/^PRIMARY=([^\r\n]+)$/m)?.[1];
    const agent = target ? (await request('agent.get', { target }, { signal }))?.result?.agent : undefined;
    if (signal.aborted || closedTabs.has(tab)) return true;
    const latest = jsonFresh<JobStatus>(statusFile);
    if (!latest || reapOwner(readFresh(sessionFile), latest) !== ownership ||
        readCloseTurn(dir, jsonFresh(jobFile), latest) !== readInGrace) return true;
    if (!['idle', 'done'].includes(agent?.agent_status ?? '')) {
      preflightHold.set(id, { ownership, token: readInGrace, until: Date.now() + cliCheck });
      return false;
    }
    status = latest;
  }
  entry.phase = 'reaping';
  // Only native Pi may exit using a worker-side snapshot the watcher never saw.
  const expectSnapshot = !!job && !job.cli && !job.bro && !job.jev;
  const { result, complete, issue, snapshot } = await reapWorkerTree(dir, status,
    // Own a new process group so stopping pi-role-reap also stops its Herdr CLI child.
    () => runCommand('pi-role-reap', [dir], process.env, {
      budgetMs: REAP_BUDGET_MS, killGraceMs: REAP_KILL_GRACE_MS, killProcessGroup: true, signal,
    }), (run) => run.ok, { carry: retry?.snapshot, expectSnapshot, signal });
  const exit = signal.aborted ? 'aborted' : result.exitCode ?? result.reason;
  if (result.groupCleanupIssue) log(`reap ${id}: ${result.groupCleanupIssue}`);
  const message = `reap ${id} state=${status.state} exit=${exit}; ${issue ? `${issue}; ` : ''}${UNVERIFIED_TREE_NOTE}`;
  if (complete || signal.aborted) log(message);
  else warn(`reap ${id}`, message);
  if (signal.aborted || result.reason === 'aborted') return true;
  // A tab ownership refusal is final only when there is no unresolved descendant cleanup.
  const refusal = !issue && !readClose && result.exitCode === 1 &&
    result.stderr.trimEnd().endsWith(`: TAB ${tab} name changed or missing; not closing`) && !result.stderr.trim().includes('\n');
  reapRetries.set(id, { ownership, readClose, at: refusal ? Infinity : Date.now() + cliCheck, snapshot });
  if (!complete) return true;

  // Preserve worker shutdown facts and any job receipt updates made while we reaped.
  const latest = jsonFresh<JobStatus>(statusFile);
  if (!latest || reapOwner(readFresh(sessionFile), latest) !== ownership) return true;
  if (readClose && (['idle_grace', 'closed'].includes(latest.state) || resumeReadReap &&
      (latest.state === 'working' || latest.state?.startsWith('waiting')))) {
    writeJsonAtomic(statusFile, { ...latest, state: 'closed', exit_reason: REPORT_READ_EXIT,
      ended_at: latest.ended_at ?? new Date().toISOString() });
  }
  const receipt = jsonFresh<Job>(jobFile);
  if (receipt) {
    if (!receipt.reaped_at) writeJsonAtomic(jobFile, { ...receipt, reaped_at: new Date().toISOString() }, 2);
    reapRetries.delete(id);
  } else {
    // There is no receipt to stamp. Don't repeat a successful reap on every scan.
    reapRetries.set(id, { ownership, readClose, at: Infinity, snapshot });
  }
  return true;
}
function startReap(job: ReapInput) {
  const { id, tab, ownership, readInGrace, resumeReadReap, retry } = job;
  const busy = [job.job?.worktree?.root, job.job?.cwd].filter((path): path is string => !!path);
  const entry: ActiveReap = { tab, ownership, readClose: Boolean(readInGrace || resumeReadReap), busy,
    phase: 'preflight', controller: new AbortController() };
  let rescan = true;
  entry.promise = Promise.resolve().then(() => reapJob(entry, job)).then((again) => { rescan = again; }).catch((error) => {
    if (error.code !== 'ENOENT' && !stopped) {
      if (reapRetries.get(id) === retry || reapRetries.get(id)?.ownership !== ownership)
        reapRetries.set(id, { ownership, readClose: entry.phase === 'reaping' && entry.readClose, at: Date.now() + cliCheck, snapshot: retry?.snapshot });
      warn(`keep ${id} scan`, `keep ${id} scan: ${error.message}`);
    }
  }).finally(() => {
    inFlightReaps.delete(id);
    drained();
    if (rescan || reapBacklog) schedule();
  });
  inFlightReaps.set(id, entry);
}
function scan(retryWatch = false) {
  if (stopped || pauseReady) return;
  reapBacklog = false;
  clearTimeout(timer);
  if (retryWatch && !watcher) startWatch(); // Install before catch-up, only on the timer path.
  seen.clear();
  const baseHeads = new Map<string, ReturnType<typeof mainHead>>();
  const busyWorktrees = new Set<string>(), worktreeChecks = [];
  const markBusy = (job: Job | null) => {
    if (job?.worktree?.root) busyWorktrees.add(job.worktree.root);
    if (job?.cwd) busyWorktrees.add(job.cwd);
  };
  let rechecks = 0;
  let open = false,
    safetyCheck = false,
    nearest = Infinity;
  for (const id of fs.readdirSync(jobs)) {
    if (!/^j[a-f0-9]{16}$/.test(id)) continue;
    const dir = join(jobs, id);
    try {
      const active = inFlightReaps.get(id);
      if (active) {
        for (const root of active.busy) busyWorktrees.add(root);
        if (active.phase === 'preflight') {
          safetyCheck = true;
          if (closedTabs.has(active.tab)) active.controller.abort();
        }
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
      let job, status: Partial<JobStatus> | null, session;
      try { job = json<Job & Record<string, unknown>>(jobFile); status = json<JobStatus>(statusFile); session = read(join(dir, jobFiles.session)); }
      // Unreadable lifecycle or tab evidence may still belong to an open job.
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') open = true; throw error; }
      const tab = session?.match(/^TAB=([^\r\n]+)$/m)?.[1];
      const ownership = reapOwner(session, status);
      const previous = reapRetries.get(id);
      const retry = !job?.reaped_at && previous?.ownership === ownership ? previous : null;
      // A previous read-close attempt may have closed its own tab before retrying cleanup.
      const tabClosed = !retry?.readClose && !!tab && closedTabs.has(tab);
      if (!['closed', 'failed', 'stopped'].includes(status?.state ?? '')) {
        let update: JobStatus | undefined;
        const now = new Date().toISOString();
        if (job?.cli) {
          safetyCheck ||= Boolean(status);
          const pid = (status || tabClosed) && supervisorPid(dir, status);
          const liveSupervisor = pid && supervisorAlive(pid);
          // A live supervisor delivering /quit owns the terminal write and knows why the tab closed.
          const quitting = tabClosed && liveSupervisor && fs.existsSync(`${statusFile}.quit-${pid}`);
          if (!quitting && (tabClosed || (pid && !liveSupervisor))) {
            // The quit marker is removed after STATUS is published; ignore a snapshot taken before that write.
            status = jsonFresh<JobStatus>(statusFile);
            if (['closed', 'failed', 'stopped'].includes(status?.state ?? '')) { schedule(); continue; }
            const alive = workerAlive(status?.pid ?? null, status?.pid_start_time ?? null);
            const end = terminalFact({ alive, tabClosed, stop: fs.existsSync(`${statusFile}.stop-requested`),
              turn: readTurn(dir), reportSig: reportSignature(dir) });
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
          if (terminal) status = terminal;
          else if (status) {
            // The marker or tab event can arrive before the PID is gone.
            open = safetyCheck = true;
            continue;
          }
        } else if (tabClosed) update = { state: 'failed', exit_reason: 'tab closed', ended_at: now };
        if (update) {
          status = { ...status, ...update };
          writeJsonAtomic(statusFile, status);
        }
      }
      // A persisted launch without STATUS is still open until dispatch returns.
      if (!status) {
        if (job && (job.dispatch_exit_code === null || job.dispatch_exit_code === 0)) { open = true; markBusy(job); }
        continue;
      }
      if (checksOpen(id, dir, job, status)) { open = safetyCheck = true; markBusy(job); continue; }
      safetyCheck ||= Boolean(retry?.readClose && retry.at !== Infinity); // The root may still exit after report eligibility changes.
      // Once the recorded tab or root is gone, retry that owner's cleanup without an agent preflight.
      const resumeReadReap = retry?.readClose && ((!!tab && closedTabs.has(tab)) || workerTreeRootGone(status.pid, status.pid_start_time));
      let readInGrace = null;
      if (!resumeReadReap && status.state === 'idle_grace') {
        open = true;
        markBusy(job);
        // Pi owns the unread deadline. CLI grace always goes through its supervisor.
        if (!tab || !(readInGrace = readCloseTurn(dir, job, status))) continue;
      }
      if (!resumeReadReap && (status.state === 'working' || status.state?.startsWith('waiting'))) {
        open = true;
        markBusy(job);
        continue;
      }
      const readClose = Boolean(resumeReadReap || readInGrace);
      if (!readClose && !['closed', 'failed', 'stopped'].includes(status.state ?? '')) continue;
      if (status.state === 'failed' && job && !job.exhaustion_marked) {
        const text = String(status.exit_reason ?? status.error ?? '');
        if (isQuotaFailure(text)) {
          const res = recordFailureExhaustion(home, bundled, dir, job, text);
          if (res.marked && res.reason !== text) {
            status = { ...status, exit_reason: res.reason, error: res.reason };
            writeJsonAtomic(statusFile, status);
          }
        }
      }
      const ended = Date.parse(job?.reaped_at ?? status.settled_at ?? status.ended_at ?? '');
      // A land helper owns its checkout and receipt through push and cleanup, across watcher restarts.
      const land = job?.worktree && landAttempt(home, id).prior;
      const landing = land && activeLand(land);
      if (landing) { open = safetyCheck = true; markBusy(job); }
      const worktreeSafe = Boolean(job?.reaped_at || (!session && (job?.dispatch_exit_code ?? 0) > 0));
      if (!worktreeSafe) markBusy(job);
      // With a tab, wait for successful reap; without a session, only a finished failed launch is safe.
      if (worktreeSafe && !landing && job?.worktree && !job.worktree_removed_at && fs.lstatSync(jobFile).isFile()) {
        const root = job.worktree.main_root;
        let pending = !job.worktree_kept_reason;
        // Only a clean, unpicked result has a checked HEAD. Don't spawn Git for an unchanged base.
        if (job.worktree_checked_head && Date.now() - ended < 7 * 86400000) {
          if (!baseHeads.has(root)) baseHeads.set(root, mainHead(root));
          const head = baseHeads.get(root);
          pending = !!head && head !== job.worktree_checked_head;
        }
        if (pending) {
          worktreeChecks.push({ id, jobFile, job, root });
          continue; // A completing worktree task schedules the next scan for any backlog.
        }
      }
      if (!session && job?.worktree && job.dispatch_exit_code === null) open = true;
      const expires = (Number.isFinite(ended) ? ended : fs.statSync(statusFile).mtimeMs) + 86400000;
      if (!landing && expires < Date.now() && (!tab || job?.reaped_at)) {
        // Pi sessions live in the job dir. CLI and browser keep theirs in their own default place.
        if (!(job?.cli || job?.bro || job?.jev) && !preserveSessions(dir)) continue;
        archiveJob(home, dir, id, job, status, Date.now(), log);
        fs.rmSync(dir, { recursive: true, force: true });
        log(`delete ${id} state=${status.state}`);
        continue;
      }
      if (job?.reaped_at || !tab) continue;
      if (status.state === 'failed' && !resumeReadReap) {
        const ended = Date.parse(status.ended_at ?? '');
        const deadline = (Number.isFinite(ended) ? ended : fs.statSync(statusFile).mtimeMs) + retention;
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
        safetyCheck = true;
        const hold = preflightHold.get(id);
        if (hold?.ownership === ownership && hold.token === readInGrace && hold.until > Date.now()) {
          nearest = Math.min(nearest, hold.until);
          continue;
        }
      }
      if (inFlightReaps.size >= MAX_CONCURRENT_REAPS) {
        reapBacklog = true;
        continue;
      }
      preflightHold.delete(id);
      startReap({ id, dir, job, status, session: session!, tab, retry, readInGrace, resumeReadReap, jobFile, statusFile, ownership });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const retry = reapRetries.get(id);
        if (retry) nearest = Math.min(nearest, retry.at);
        warn(`keep ${id} scan`, `keep ${id} scan: ${(error as Error).message}`);
      }
    }
  }
  for (const { id, jobFile, job, root } of worktreeChecks) {
    if (busyWorktrees.has(job.worktree!.root)) continue;
    const at = worktreeRetries.get(id);
    if (at !== undefined && at > Date.now()) nearest = Math.min(nearest, at);
    else if (!worktreeLocks.has(root) && (!job.worktree_checked_head || rechecks < 4)) {
      if (job.worktree_checked_head) rechecks++;
      startWorktree(id, jobFile, job);
    }
  }
  for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
  if (open) subscribe();
  if (safetyCheck) nearest = Math.min(nearest, Date.now() + cliCheck);
  const hasInFlight = inFlightReaps.size > 0 || inFlightWorktrees.size > 0;
  if ((open || hasInFlight || nearest !== Infinity) && !watcher) nearest = Math.min(nearest, Date.now() + degradedMs);
  if (nearest !== Infinity) timer = setTimeout(() => scan(true), Math.max(1, Math.ceil(nearest - Date.now())));
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
// Watch before catch-up, so a STATUS rename during the initial scan is not missed.
function startWatch() {
  try {
    watcher = fs.watch(jobs, { recursive: true }, (_event, filename) => {
      const path = filename?.toString();
      if (!path || !path.includes('/') || /^[^/]+\/(STATUS\.json(?:\.stop-requested)?|SESSION\.txt|job\.json|checks\.json|report\.md|done\.json|turn\.json)$/.test(path)) schedule();
    }).on('error', (error) => {
      if (stopped) return;
      warn('watch error', `watch error: ${error.message}`);
      watcher?.close(); watcher = undefined;
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
      closedTabs.add(id);
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
      for (const id of tabs) closedTabs.add(id);
      stopped = false;
      startWatch();
      scan();
    },
  };
}
