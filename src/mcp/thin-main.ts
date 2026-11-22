/** Local HUD role tools and Codex statusline, newline-delimited JSON-RPC over stdio. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { cliWorkerTools, readTurn, REPORT_READ_EXIT, reportSignature, saveTurn, turnToken, withDonePrompt, workerAlive, writeTurn } from './cli-judge.js';
import { readCodexStatusline, statuslineResource, statuslineTool } from './codex-statusline.js';
import { panelDelivery } from './panel-delivery.js';
import { editTickets, readyTickets } from './local-tickets.js';
import { startLand, landTask } from './land.js';
import { activeLand, isFlowId, landEvents, landView, readLand } from './land-state.js';
import { MAX_MCP_TASKS, pruneCreatedJobs, pruneLandTasks, pruneTasks, rememberCreatedJob, rememberLandTask } from './task-bounds.js';
import { launchThinking, nearestThinking } from './launch-thinking.js';
import { pickSonicThinking } from './sonic-thinking.js';
import { briefPrompt } from './brief-prompt.js';
import { cliWorkerStartup, isHerdrAgentArg, type StandingBriefRef } from './cli-worker-startup.js';
import { startHeadlessProcess, stopSonic } from './sonic-process.js';
import { sonicLimits } from './sonic-policy.js';
import { prepareSonicRetry, sonicSession } from './sonic-session.js';
import { piMcpConfigEmpty } from './pi-mcp-config.js';
import { jobFiles } from './paths.js';
import type { BatchNotice, Job, JobStatus, LaunchAttempt, ManagedWorktree, McpTaskMarker, PiOptions, SessionReceipt } from './job-contracts.js';
import { piReportSettlement, sendHistory } from './pi-read-settlement.js';
import { settleStoppedPi } from './pi-stop-settlement.js';
import { ensureJobWatcher } from './watch-pid.js';
import { reapWorkerTree } from '../roles/worker-tree.js';
import { isCliDirTrusted, propagateCliTrust } from '../cli/trust.js';
import { addWorktree, gitSummary, planWorktree, populateWorktree, reusableWorktree } from './managed-worktree.js';
import { taskTarget } from '../collectors/job-supersession.js';
import { needsTranslation, replyWords } from '../collectors/reply-language.js';
import { failedAttempt, jobChanges, adoptionAttention, jobRow, jobRowReportMeta, readJobProgress, type JobRow } from '../collectors/thin-jobs.js';
import { createWorkSummaryPublisher } from '../collectors/work-summary-snapshot.js';
import { questionFields } from '../collectors/work-artifacts.js';
import { firstReportProse, reportReadHint } from '../utils/report-summary.js';
import { waitUntilFs, type WatchTarget } from '../utils/fs-wait.js';
import { PanelActionLog, type AnswerResult } from '../collectors/panel-actions.js';
import { readDirSafe, readFileBounded, readJsonBounded, readJsonFile, writeJsonPrivate, writePrivateFile } from '../utils/atomic-fs.js';
import { isProcAlive, procStat } from '../utils/proc.js';
import { TryLog } from '../collectors/try-records.js';
import { cliKinds, type CliAgent } from '../roles/cli-kinds.js';
import { herdrId, runCommand, runHerdr } from '../roles/herdr-run.js';
import {
  roleRegistry,
  harnessDefaults,
  recordFailureExhaustion,
  describePlace,
  isQuotaFailure,
  markExhausted,
  readExhausted,
  executable,
  piSwitches,
  type Role,
  type RolePlace,
} from '../roles/roster.js';
import { HarnessSwitchError } from '../roles/harness-switches.js';
import { ROLE_TOOLS as tools } from '../roles/tool-definitions.js';
import { checkBinding, CHECKS_FILE, CHECK_TIMEOUT_MS, jobChecks, MAX_CHECK_COMMAND, MAX_CHECKS, readCheckReceipt, sameChecks } from '../roles/job-checks.js';
import { takeLease } from '../roles/lease.js';
import { ensureQueueWatcher, notify, paneInfo, taskDelivery, watching } from '../roles/notify.js';
import { adoptProjectJobs, projectJobFilter } from '../roles/job-project.js';
import { JOB_ID_RE, JobIndexCache, type CachedJsonResult } from '../roles/job-index-cache.js';
import { sharedRoot } from '../roles/projects.js';
import { resumedWorkerRefusal } from '../roles/resume-guard.js';
import { capForRole, computeQueuePositions, isWorkingForCap, loadConcurrencySettings, QUEUE_START_MARKER, queuedTimestamp } from '../roles/concurrency.js';
import { closedReport, DEFAULT_RESUME_S, resumeDeadline, resumeIdentity, type NativeResume } from './worker-resume.js';
import * as workerTools from '../worker/tools.js';

const jobDir = process.env.HUD_JOB_DIR;
const isWorker = jobDir !== undefined;
const hudHome = isWorker ? dirname(dirname(fs.realpathSync(jobDir))) : resolve(process.env.HUD_HOME || join(homedir(), '.hud'));
if (isWorker) process.env.HUD_HOME = hudHome; // The watcher and other subprocesses inherit the worker's HUD home.
const jobsRoot = join(hudHome, 'jobs');
const jobCache = new JobIndexCache(hudHome);
const workSummary = createWorkSummaryPublisher(hudHome, 'hud-mcp', jobCache);
const publishWorkSummary = (loadedJobs?: readonly Job[]) => {
  try {
    workSummary.publish(loadedJobs ? { jobs: loadedJobs as readonly (Job & Record<string, unknown>)[], jobsExist: true } : undefined);
  } catch { /* Best-effort display snapshot. */ }
};
let resumeChecked = false;
let resumeRefusal: string | undefined;
function checkResume(agent: 'agy' | 'claude' | 'codex', id: unknown) {
  if (isWorker || resumeChecked || typeof id !== 'string' || !id) return;
  resumeChecked = true;
  resumeRefusal = resumedWorkerRefusal(hudHome, { agent, id });
}
const bundled = fileURLToPath(new URL('../../packages/hud-mcp/', import.meta.url));
const binScript = (name: string) => join(bundled, 'bin', name);
const worker = isWorker ? workerTools : undefined;
function registry(cwd: string) {
  return roleRegistry(hudHome, cwd, process.env, undefined, undefined, bundled);
}
function jobCwd(args: Args): string {
  if (args.cwd === undefined) return resolve(process.cwd());
  const cwd = resolve(required(args, 'cwd'));
  // A missing directory otherwise surfaces later as a misleading `spawn <launcher> ENOENT`.
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('invalid_arguments: cwd is not an existing directory');
  return cwd;
}
type Args = Record<string, unknown>;
function required(args: Args, key: string): string {
  if (typeof args[key] !== 'string' || !args[key]) throw new Error(`invalid_arguments: ${key}`);
  return args[key] as string;
}
function derivedKey(kind: string, ...parts: unknown[]): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}
const DERIVED_KEY_WINDOW_MS = 10 * 60_000;
function withinRetryWindow(recordedAt: string | undefined, now: number): boolean {
  const age = now - Date.parse(recordedAt ?? '');
  return age >= 0 && age < DERIVED_KEY_WINDOW_MS;
}
function json<T>(file: string): T | null {
  try {
    return readJsonFile(file) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function slice(file: string, limit: number): { text: string; truncated: boolean; bytes: number } | null {
  try {
    const { bytes, stat, truncated } = readFileBounded(file, limit, { followSymlinks: true });
    return { text: bytes.toString('utf8'), truncated, bytes: truncated ? stat.size : bytes.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function unwrapCachedJson<T>(res: CachedJsonResult<T>, fallbackFile: string): T | null {
  if (res.status === 'ok') return res.value;
  if (res.status === 'missing') return null;
  if (res.status === 'truncated') return json<T>(fallbackFile);
  throw res.error;
}
function readCachedStatus(id: string): { status: JobStatus | null; at: number | null } {
  const file = join(directory(id), jobFiles.status);
  const res = jobCache.readStatus<JobStatus>(id);
  if (res.status === 'ok') return { status: res.value, at: res.at };
  if (res.status === 'missing') return { status: null, at: null };
  if (res.status === 'truncated') {
    const status = json<JobStatus>(file);
    const at = status ? (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null) : null;
    return { status, at };
  }
  throw res.error;
}
function directory(job: string): string {
  return join(jobsRoot, job);
}
function save(job: Job, newAttempt = false): void {
  const file = join(directory(job.job), jobFiles.job);
  // A waiting read can stamp the report while dispatch/send is awaiting a CLI.
  const receipt = findJob(job.job);
  // A session watch can adopt the receipt while this process awaits a launch or send.
  if (receipt?.herdr_pane) job.herdr_pane = receipt.herdr_pane;
  const existing = newAttempt ? null : receipt;
  for (const key of ['read_at', 'observed_at', 'pi_sent_at'] as const) {
    const at = existing?.[key];
    if (at && (!job[key] || at > job[key])) job[key] = at;
  }
  if (existing?.reaped_at) job.reaped_at = existing.reaped_at;
  if (existing) {
    // Watcher-owned: a later integration can clear a previously recorded keep decision.
    for (const key of ['worktree_removed_at', 'worktree_kept_reason', 'worktree_checked_head'] as const)
      job[key] = existing[key];
  }
  if (existing?.exhaustion_marked) job.exhaustion_marked = true;
  jobCache.writeJsonAtomic(file, job as unknown as Record<string, unknown>, { indent: 2, mkdir: false });
  writeScan.getStore()?.record(job);
}
function jobs(onMissing?: () => void): Job[] {
  const out: Job[] = [];
  for (const id of jobCache.listJobIds({ onError: (error) => { throw error; } })) {
    const job = findJob(id);
    if (job) out.push(job);
    else onMissing?.();
  }
  return out;
}
function findJob(id: string): Job | null {
  if (!JOB_ID_RE.test(id)) return null;
  return unwrapCachedJson(jobCache.readJob<Job>(id), join(directory(id), jobFiles.job));
}
function findJobMutable(id: string): Job | null {
  if (!JOB_ID_RE.test(id)) return null;
  return unwrapCachedJson(jobCache.readJobMutable<Job>(id), join(directory(id), jobFiles.job));
}
function primary(id: string): string | null {
  return jobCache.readSession(id)?.fields.primary ?? null;
}
function created(job: Job, initialRow?: JobRow) {
  const task_dir = directory(job.job);
  const { report_unread: _unread, report_mtime: _mtime, question_ids: _questions, ...row } = initialRow ?? readRow(job).row;
  const watch = callerPane && !taskClient ? { watcher_alive: watching(callerPane, hudHome) } : {};
  const thinking = {
    ...(job.thinking == null ? {} : { thinking: job.thinking }),
    ...(job.thinking_source ? { thinking_source: job.thinking_source } : {}),
  };
  const launch = { attempts: job.attempts, used_place: job.used_place ?? null, ...(job.headless && { mode: 'headless' }) };
  const queued = row.state === 'queued'
    ? { queued: true as const, ...(row.queue_position !== undefined ? { queue_position: row.queue_position } : {}) }
    : {};
  const overflow = job.overflow_from ? { overflowed: true as const, overflow_from: job.overflow_from } : {};
  if (job.dispatch_exit_code !== null && job.dispatch_exit_code !== 0 && row.display_state === 'failed') {
    return {
      ok: false,
      code: job.dispatch_code ?? 'dispatch_failed',
      ...(job.dispatch_path ? { path: job.dispatch_path } : {}),
      ...(job.dispatch_code === 'unsupported_harness' || job.dispatch_code === 'invalid_arguments' ? { error: job.stderr_tail } : {}),
      ...row,
      ...overflow,
      reason: job.attempts && job.attempts.length > 1 && !job.used_place
        ? job.attempts.map((a) => `${a.place}: ${a.reason}`).join('; ')
        : row.reason ?? (job.stderr_tail.trim() || `launch exited ${job.dispatch_exit_code}`),
      task_dir,
      agent: primary(job.job),
      ...launch, ...thinking, ...watch,
    };
  }
  return { ...row, ...queued, ...overflow, task_dir, agent: primary(job.job), ...launch, ...thinking, ...watch };
}
function run(
  command: string,
  argv: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv
): Promise<{ exit_code: number; stdout: string; stderr: string; notStarted: boolean }> {
  return new Promise((done) => {
    const child = spawn(command, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      stdout = (stdout + data).slice(-65536);
    });
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      stderr = (stderr + data).slice(-4096);
    });
    child.on('error', (error) => {
      stderr = (stderr + error.message).slice(-4096);
    });
    child.on('close', (code) => done({ exit_code: code ?? -1, stdout, stderr, notStarted: child.pid === undefined }));
  });
}
const AGENT_PANE_BUSY_DELAYS_MS = [100, 200, 400, 800] as const;
function isAgentPaneBusy(result: Awaited<ReturnType<typeof run>>): boolean {
  if (result.exit_code === 0) return false;
  for (const text of [result.stdout, result.stderr]) {
    try {
      if (JSON.parse(text)?.error?.code === 'agent_pane_busy') return true;
    } catch { /* Herdr may also render plain text or trailing lines. */ }
    if (/\bagent_pane_busy\b/.test(text)) return true;
  }
  return false;
}
async function startAgentWithBusyWait(argv: string[]) {
  let started = await run('herdr', argv);
  for (const delay of AGENT_PANE_BUSY_DELAYS_MS) {
    if (!isAgentPaneBusy(started)) return started;
    await sleep(delay);
    started = await run('herdr', argv);
  }
  return started;
}
function refusedBeforeInput(result: Awaited<ReturnType<typeof run>>): boolean {
  if (result.exit_code === 0) return false;
  if (result.notStarted) return true;
  let code;
  try { code = JSON.parse(result.stdout)?.error?.code; } catch { /* Herdr can also render the error on stderr. */ }
  code ??= /^(?:Error:\s*)?(agent_not_ready|agent_not_found)(?=[:\s]|$)/.exec(result.stderr.trim())?.[1];
  return code === 'agent_not_ready' || code === 'agent_not_found';
}
async function dispatchBase(cwd: string): Promise<string> {
  const git = await run('git', ['rev-parse', 'HEAD'], cwd);
  return git.exit_code === 0 ? git.stdout.trim() : 'HEAD';
}
async function workspaceArgs(job: Job): Promise<string[]> {
  const result = await run('herdr', ['pane', 'get', job.herdr_pane]);
  if (result.exit_code !== 0) return [];
  try {
    const pane = JSON.parse(result.stdout).result.pane;
    if (job.herdr_pane === callerPane) rememberCallerHarness(pane.agent);
    return herdrId(pane.workspace_id) ? ['--workspace', pane.workspace_id] : [];
  } catch {
    return [];
  } // An unavailable caller lookup keeps herdr's default workspace.
}
function ensureWatcher(): void {
  ensureJobWatcher(hudHome);
}
const wideChar = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
function cut(text: string, max: number): string {
  const chars = [...text],
    wide = (char: string) => (wideChar.test(char) ? 2 : 1);
  let columns = chars.reduce((sum, char) => sum + wide(char), 0);
  if (columns <= max) return text;
  while (chars.length && columns > max - 1) columns -= wide(chars.pop()!);
  return chars.join('').trimEnd() + '…';
}
/**
 * The worker's herdr tab label: `<role> <package or brief title>` in about 28 columns, on one line (it is recorded as
 * TAB_NAME and pi-role-reap compares it with the tab). A short job suffix is added only when another open job's tab
 * already has the same label.
 */
function tabLabel(job: Job, task: string): string {
  const lines = Buffer.from(task.slice(0, 4096)).subarray(0, 4096).toString('utf8').split(/\r?\n/);
  const title =
    job.package?.trim() || (lines.find((line) => /^#{1,6}\s/.test(line)) ?? lines.find((line) => line.trim()) ?? '');
  const label = cut(
    `${job.role} ${title.replace(/^#{1,6}\s+/, '')}`.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim(),
    28
  );
  const taken = jobs().flatMap((other) =>
    other.job === job.job || other.reaped_at
      ? []
      : [jobCache.readSession(other.job)?.fields.tabName]
  );
  return taken.includes(label) ? `${cut(label, 23)} ${job.job.slice(-4)}` : label;
}
/** A skill name is one path segment under `.hud/skills`. Anything else is not a link we made. */
function plainSkillName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0');
}
function skillReason(path: string): string | null {
  let link = false;
  try {
    link = fs.lstatSync(path).isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  try {
    return fs.statSync(path).isDirectory() ? null : 'not_directory';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return link && (code === 'ENOENT' || code === 'ENOTDIR') ? 'broken' : 'unreadable';
  }
}
/** Role skill dirs and the worker prompt, after `--` and before the caller's `pi_args`. */
function piSkillArgs(job: Job, role: Role, place: RolePlace): string[] {
  const gate = registry(roleCwd(job)).project();
  const role_skills: { name: string; path: string }[] = [];
  const skipped_skills: { name: string; reason: string }[] = [];
  const args: string[] = [];
  for (const name of place.skills ?? role.skills ?? []) {
    if (!isAbsolute(name)) {
      if (!gate.registered) {
        skipped_skills.push({ name, reason: 'unresolved' });
        continue;
      }
      if (!plainSkillName(name)) {
        skipped_skills.push({ name, reason: 'invalid' });
        continue;
      }
    }
    const path = isAbsolute(name) ? name : join(gate.root, '.hud', 'skills', name);
    const reason = skillReason(path);
    if (reason) {
      skipped_skills.push({ name, reason });
      continue;
    }
    role_skills.push({ name, path });
    args.push('--skill', path);
  }
  let worker_prompt: string | null = null;
  if (gate.registered) {
    const agents = join(gate.root, '.hud', 'agents');
    const prompt = join(agents, `${role.role}.md`);
    try {
      if (dirname(prompt) === agents && fs.statSync(prompt).isFile()) {
        worker_prompt = prompt;
        args.push('--append-system-prompt', prompt);
      }
    } catch {
      /* Missing or broken prompt: no flag, launch continues. */
    }
  }
  job.role_skills = role_skills;
  job.skipped_skills = skipped_skills;
  job.worker_prompt = worker_prompt;
  return args;
}
async function dispatchPi(job: Job, role: Role, place: RolePlace, task: string, resume?: NativeResume): Promise<DispatchResult> {
  let openedTab: string | undefined;
  let mayHaveInput = false;
  const reject = (result: DispatchResult) => rejectLaunch(result, openedTab);
  try {
    const resources = piSkillArgs(job, role, place);
    const launcher = executable('pi-role');
    if (!launcher) throw new Error('pi-role not found on PATH');
    const dir = directory(job.job),
      output = join(dir, jobFiles.report);
    const sessionWorker = job.headless && job.role !== 'sonic';
    const sessionFile = sessionWorker ? resume?.file ?? join(dir, 'sessions', `${job.job}.jsonl`) : undefined;
    let continuation = resume?.message;
    if (job.role === 'sonic' && job.retry_of) {
      const source = findJob(job.retry_of);
      if (source?.role === 'sonic') continuation = prepareSonicRetry(dir, job.cwd, source, directory(source.job), readCachedStatus(source.job).status);
    }
    const prompt = continuation ?? briefPrompt(join(dir, jobFiles.brief));
    const piRole = place.pi_role ?? role.instructions;
    if (!piRole) throw new Error('missing pi_role');
    const argv = ['--args-json', piRole];
    if (!job.headless) argv.push('--task-dir', dir, '--role-output', output, '--dispatch-slot', 'primary', '--dispatch-label', job.role);
    argv.push('--allow-write', output);
    if (!job.headless || sessionWorker) argv.push('--qa-dir', join(dir, jobFiles.qa));
    if (sessionWorker) argv.push('--qa-timeout', '0');
    if ((!job.headless || sessionWorker) && job.herdr_pane) {
      const notify = binScript('hud-notify.mjs');
      argv.push('--notify', [process.execPath, notify, hudHome, job.herdr_pane, job.job].map(quote).join(' '));
    }
    const instructionsName = role.instructions ?? role.role;
    if (plainSkillName(instructionsName)) {
      const instructions = join(bundled, 'instructions', `${instructionsName}.md`);
      if (fs.existsSync(instructions)) argv.push('--hud-instructions', instructions);
    }
    argv.push('--hud-sonic-jobs', join(bundled, 'bin', 'sonic-jobs.mjs'));
    if (place.thinking !== undefined) argv.push('--dispatch-effort-source', 'orchestrator');
    for (const key of ['lens', 'mcp', 'tps'] as const)
      if (job[key] !== undefined) argv.push(`--${job[key] ? '' : 'no-'}${key}`);
    if (job.mcp === undefined && piMcpConfigEmpty(job.cwd, job.pi_args)) argv.push('--no-mcp');
    if (job.headless || job.ui_ext === false) argv.push('--no-ui-ext');
    if (job.skills === true) argv.push('--skills');
    argv.push('--', ...(job.headless ? [] : ['--tui-mode', 'regular']), '--hud-worker-tools', '-e',
      join(bundled, '../../integrations/pi/package/extensions/hud.mjs'));
    for (const key of ['model', 'thinking'] as const) if (place[key] !== undefined) argv.push(`--${key}`, place[key]);
    argv.push(...resources, ...(job.pi_args ?? []));
    // Pi expands even a positional @path into file contents. A follow-up is literal text, not a file grant.
    if (sessionFile) argv.push('--session', sessionFile, '--print', '--mode', 'json', '--', prompt.startsWith('@') ? ` ${prompt}` : prompt);
    else if (job.headless) argv.push('--exclude-tools', 'hud_ask,ask_orchestrator,hud_sonic', '--session', sonicSession(dir), '--print', '--mode', 'json', '--', prompt);
    else if (resume?.file) argv.push('--session', resume.file);
    const built = await run(launcher, argv, job.cwd, job.headless ? { ...process.env, HERDR_ENV: undefined } : undefined);
    if (built.exit_code !== 0) return reject(built);
    const piArgs: string[] = JSON.parse(built.stdout);
    if (job.headless) {
      if (sessionFile) {
        if (!resume) {
          fs.mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 });
          writePrivateFile(sessionFile, '', { exclusive: true, mkdir: false });
        }
        job.pi_sent_at = new Date().toISOString();
        save(job);
      }
      startHeadlessProcess(dir, job, piArgs, sessionFile ? { file: sessionFile, id: resume?.id } : undefined,
        job.role === 'sonic' ? sonicLimits(role) : undefined);
      return { exit_code: 0, stdout: '', stderr: '' };
    }
    fs.mkdirSync(join(dir, jobFiles.qa), { recursive: true });
    const base = job.worktree?.base_head ?? await dispatchBase(job.cwd);
    const tabName = tabLabel(job, task),
      name = `${job.job}-primary`;
    const tabArgv = [
      'tab',
      'create',
      ...(await workspaceArgs(job)),
      '--cwd',
      job.cwd,
      '--label',
      tabName,
      '--env',
      `HUD_JOB_DIR=${dir}`,
      '--env',
      `HUD_HOME=${hudHome}`,
      '--no-focus',
    ];
    let left = '';
    let started: Awaited<ReturnType<typeof run>> = { exit_code: 1, stdout: '', stderr: 'tab create not attempted', notStarted: false };
    for (let tabAttempt = 0; tabAttempt < 2; tabAttempt++) {
      const result = await run('herdr', tabArgv);
      if (result.exit_code !== 0) return reject(result);
      const { tab, root_pane } = JSON.parse(result.stdout).result;
      if (herdrId(tab?.tab_id)) openedTab = tab.tab_id;
      left = root_pane?.pane_id;
      if (!openedTab || !herdrId(left)) throw new Error('tab create did not return tab/root pane ids');
      let right = '';
      const record = () => {
        const fields: SessionReceipt = {
          TASK: job.job,
          TAB: tab.tab_id,
          TAB_NAME: tabName,
          LEFT: left,
          RIGHT: right,
          ORCH: job.herdr_pane,
          BASE: base,
          PRIMARY: name,
        };
        if (Object.values(fields).some((value) => /[\r\n]/.test(value))) throw new Error('newlines in SESSION values');
        const sessionFile = join(dir, jobFiles.session);
        writePrivateFile(
          sessionFile,
          Object.entries(fields)
            .map(([k, v]) => `${k}=${v}\n`)
            .join(''),
          { mkdir: false }
        );
        jobCache.invalidateFile(sessionFile);
      };
      record();
      if (job.split) {
        const split = await run('herdr', [
          'pane',
          'split',
          left,
          '--direction',
          'right',
          '--ratio',
          '0.5',
          '--cwd',
          job.cwd,
          '--no-focus',
        ]);
        if (split.exit_code !== 0) return reject(split);
        right = JSON.parse(split.stdout).result.pane.pane_id;
        if (!herdrId(right)) throw new Error('split did not return a pane id');
        record();
      }
      started = await startAgentWithBusyWait(['agent', 'start', name, '--kind', 'pi', '--pane', left, '--', ...piArgs]);
      if (!isAgentPaneBusy(started) || tabAttempt === 1) break;
      await runHerdr(['tab', 'close', openedTab], process.env, { budgetMs: 3000 });
      openedTab = undefined;
    }
    if (started.exit_code !== 0) return reject(await startupFailure(started, left));
    if (resume) {
      const native = readCachedStatus(job.job).status;
      if (native?.session_id !== resume.id || native.session_file !== resume.file)
        return reject(launchError('pi did not open the recorded session'));
    }
    job.pi_sent_at = new Date().toISOString();
    save(job);
    mayHaveInput = true;
    const submitted = await run('herdr', [
      'agent',
      'prompt',
      name,
      prompt,
      '--wait',
      '--until',
      'working',
      '--timeout',
      '30000',
    ]);
    const status = readCachedStatus(job.job).status;
    const completed = status?.task_dir === dir && status.slot === 'primary' && status.state === 'closed' && status.output_written;
    if (submitted.exit_code !== 0 && !completed) {
      if (refusedBeforeInput(submitted)) return reject(submitted);
      if (!(submitted.stderr + submitted.stdout).includes('agent_prompt_stalled')) return submitted;
      return run(process.execPath, [join(dirname(launcher), 'prompt-stall.mjs'), dir, name, left, prompt, '120000']);
    }
    return { ...submitted, exit_code: 0 };
  } catch (error) {
    const result = launchError(String(error));
    return mayHaveInput ? result : reject(result);
  }
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
async function dispatchBro(job: Job, task: string): Promise<DispatchResult> {
  const dir = directory(job.job),
    tabName = tabLabel(job, task);
  const result = await run('herdr', [
    'tab',
    'create',
    ...(await workspaceArgs(job)),
    '--cwd',
    job.cwd,
    '--label',
    tabName,
    '--env',
    `HUD_JOB_DIR=${dir}`,
    '--env',
    `HUD_HOME=${hudHome}`,
    '--no-focus',
  ]);
  if (result.exit_code !== 0) return rejectLaunch(result);
  let created;
  try {
    created = JSON.parse(result.stdout).result;
  } catch (error) {
    return { ...result, exit_code: 1, stderr: `herdr tab create: ${String(error)}` };
  }
  const { tab, root_pane } = created;
  if (!herdrId(tab?.tab_id) || !herdrId(root_pane?.pane_id)) throw new Error('tab create missing ids');
  const sessionFile = join(dir, jobFiles.session);
  writePrivateFile(
    sessionFile,
    `TASK=${job.job}\nTAB=${tab.tab_id}\nTAB_NAME=${tabName}\nLEFT=${root_pane.pane_id}\nORCH=${job.herdr_pane}\n`,
    { mkdir: false }
  );
  jobCache.invalidateFile(sessionFile);
  const script = binScript('hud-jev.mjs');
  return run('herdr', ['pane', 'run', root_pane.pane_id, [process.execPath, script, dir, String(task.length)].map(quote).join(' ')]);
}
function paneText(stdout: string): string {
  try {
    const result = JSON.parse(stdout).result;
    if (typeof result?.read?.text === 'string') return result.read.text;
    if (typeof result?.text === 'string') return result.text;
  } catch {
    /* A plain-text screen is the text itself. */
  }
  return stdout;
}
async function startupFailure(result: DispatchResult, pane: string): Promise<DispatchResult> {
  if (result.stderr.trim() && !/timed? out|timeout|agent_not_ready/i.test(result.stderr)) return result;
  const read = await runHerdr(['pane', 'read', pane, '--source', 'recent'], process.env, { budgetMs: 2000 });
  const reason = read.ok && paneText(read.stdout).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n')
    .reverse().map((line) => line.trim()).find((line) =>
      /^(?:\[roles\]|(?:\w*Error|fatal):)\s+\S/i.test(line) || isQuotaFailure(line));
  return reason ? { ...result, stderr: reason } : result;
}
function agentStatus(stdout: string): string | null {
  try {
    const status = JSON.parse(stdout).result?.agent?.agent_status;
    return typeof status === 'string' ? status : null;
  } catch {
    return null;
  }
}
/**
 * A startup spinner is `working`, then `done`, with no prompt. Prompting while it is still
 * working would accept that working; the following done must not be taken as a finished turn.
 * Returns a failed herdr result, or null when there is nothing to wait for or the wait settled.
 */
async function settlePhantomWorking(name: string) {
  const got = await run('herdr', ['agent', 'get', name]);
  if (agentStatus(got.stdout) !== 'working') return null;
  const waited = await run('herdr', [
    'agent',
    'wait',
    name,
    '--until',
    'done',
    '--until',
    'idle',
    '--timeout',
    '60000',
  ]);
  return waited.exit_code === 0 ? null : waited;
}
function supervisorPid(dir: string, status: JobStatus | null): number | null {
  const fromFile = jobCache.readPid(join(dir, jobFiles.supervisorPid));
  if (fromFile !== null) return fromFile;
  const fromStatus = status?.supervisor_pid;
  return typeof fromStatus === 'number' && Number.isInteger(fromStatus) && fromStatus > 1 ? fromStatus : null;
}
function supervisorAlive(pid: number): boolean {
  return isProcAlive(pid);
}
function spawnCliSupervisor(dir: string): number | null {
  const script = binScript('hud-cli.mjs');
  const child = spawn(process.execPath, [script, dir], { detached: true, stdio: 'ignore' });
  child.on('error', (error) => console.error(`hud-cli: ${error.message}`));
  if (child.pid) {
    const pidFile = join(dir, jobFiles.supervisorPid);
    writePrivateFile(pidFile, `${child.pid}\n`, { mkdir: false });
    jobCache.invalidateFile(pidFile);
  }
  child.unref();
  return child.pid ?? null;
}
/** Trust refusals use the same STATUS keys as hud-cli.mjs if this is the last attempt. */
function failCli(dir: string, job: Job, place: RolePlace, reason: string) {
  const now = new Date().toISOString();
  const status: JobStatus = {
    version: 1,
    task_dir: fs.realpathSync(dir),
    slot: 'primary',
    harness: 'cli',
    agent: place.agent,
    role: job.role,
    model: job.model ?? null,
    thinking: job.thinking ?? null,
    state: 'failed',
    output_path: join(dir, jobFiles.report),
    output_written: false,
    pid: null,
    pid_start_time: null,
    agent_session_id: null,
    started_at: now,
    settled_at: now,
    idle_deadline_at: null,
    ended_at: now,
    exit_reason: reason,
    error: reason,
    updated_at: now,
  };
  return { ...launchError(reason), status };
}
type DispatchResult = {
  exit_code: number; stdout: string; stderr: string; code?: Job['dispatch_code'];
  preInput?: boolean; cleanupFailed?: boolean; status?: JobStatus; path?: string;
};
const launchError = (stderr: string, code?: Job['dispatch_code']): DispatchResult => ({ exit_code: 1, stdout: '', stderr, code });
async function rejectLaunch(result: DispatchResult, tab?: string): Promise<DispatchResult> {
  const cleanup = tab && await runHerdr(['tab', 'close', tab], process.env, { budgetMs: 3000 });
  return { ...result, preInput: true, cleanupFailed: Boolean(cleanup && !cleanup.ok) };
}
async function dispatchCli(job: Job, place: RolePlace, instructions: string, task: string, servers: readonly string[], standingBrief?: StandingBriefRef, options: { callerToken?: string; resume?: NativeResume } = {}): Promise<DispatchResult> {
  const { callerToken, resume } = options;
  let openedTab: string | undefined;
  let mayHaveInput = false;
  const reject = (result: DispatchResult) => rejectLaunch(result, openedTab);
  try {
    const kind = cliKinds[place.agent as CliAgent];
    const dir = directory(job.job);
    const untrusted = `${place.agent} has not trusted ${job.cwd}; run hud trust ${job.cwd}`;
    if (!isCliDirTrusted(place.agent!, job.cwd, process.env)) {
      return reject({ ...failCli(dir, job, place, untrusted), code: 'untrusted_cwd' });
    }
    const startup = cliWorkerStartup(place, job.cwd, dir, instructions, binScript('hud-mcp.mjs'), servers, standingBrief);
    const nativeArgs = [
      ...(place.model ? kind.model(place.model) : []),
      ...(place.thinking ? kind.effort(place.thinking) : []),
      ...kind.bypass,
      ...(place.args ?? []),
      ...startup.args,
    ];
    const agentArgs = resume ? kind.resume!(resume.id, nativeArgs) : nativeArgs;
    // An arbitrary CLI option has no equivalent prompt fallback. Let the next
    // configured place run instead of dropping or changing the option.
    if (!agentArgs.every(isHerdrAgentArg)) return reject(launchError('CLI startup arguments contain control characters'));
    if (job.cli && startup.warning) job.cli.mcp_scope_warning = startup.warning;
    const base = job.worktree?.base_head ?? await dispatchBase(job.cwd);
    const tabName = tabLabel(job, task),
      name = `${job.job}-primary`;
    const tabArgv = [
      'tab',
      'create',
      ...(place.agent === 'codex' ? ['--env', `CODEX_HOME=${resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))}`] : []),
      ...(place.agent === 'claude' && process.env.CLAUDE_CONFIG_DIR ? ['--env', `CLAUDE_CONFIG_DIR=${resolve(process.env.CLAUDE_CONFIG_DIR)}`] : []),
      ...(await workspaceArgs(job)),
      '--cwd',
      job.cwd,
      '--label',
      tabName,
      '--env',
      `HUD_JOB_DIR=${dir}`,
      '--env',
      `HUD_HOME=${hudHome}`,
      '--no-focus',
    ];
    let left = '';
    let started: Awaited<ReturnType<typeof run>> = { exit_code: 1, stdout: '', stderr: 'tab create not attempted', notStarted: false };
    for (let tabAttempt = 0; tabAttempt < 2; tabAttempt++) {
      const result = await run('herdr', tabArgv);
      if (result.exit_code !== 0) return reject(result);
      const { tab, root_pane } = JSON.parse(result.stdout).result;
      if (herdrId(tab?.tab_id)) openedTab = tab.tab_id;
      left = root_pane?.pane_id;
      if (!openedTab || !herdrId(left)) throw new Error('tab create did not return tab/root pane ids');
      const fields: SessionReceipt = {
        TASK: job.job,
        TAB: tab.tab_id,
        TAB_NAME: tabName,
        LEFT: left,
        RIGHT: '',
        ORCH: job.herdr_pane,
        BASE: base,
        PRIMARY: name,
      };
      if (Object.values(fields).some((value) => /[\r\n]/.test(value))) throw new Error('newlines in SESSION values');
      const sessionFile = join(dir, jobFiles.session);
      writePrivateFile(
        sessionFile,
        Object.entries(fields)
          .map(([k, v]) => `${k}=${v}\n`)
          .join(''),
        { mkdir: false }
      );
      jobCache.invalidateFile(sessionFile);
      const argv = ['agent', 'start', name, '--kind', place.agent!, '--pane', left];
      if (kind.startTimeoutMs) argv.push('--timeout', String(kind.startTimeoutMs));
      argv.push('--', ...agentArgs);
      started = await startAgentWithBusyWait(argv);
      if (!isAgentPaneBusy(started) || tabAttempt === 1) break;
      await runHerdr(['tab', 'close', openedTab], process.env, { budgetMs: 3000 });
      openedTab = undefined;
    }
    const notReady = started.exit_code !== 0 && `${started.stdout}\n${started.stderr}`.includes('agent_not_ready');
    if (started.exit_code !== 0 && !notReady) return reject(await startupFailure(started, left));
    if (kind.trust?.text) {
      const read = await run('herdr', ['pane', 'read', left, '--source', 'recent']);
      if (read.exit_code !== 0) return reject(notReady ? started : read);
      if (paneText(read.stdout).includes(kind.trust.text)) {
        const declined = await run('herdr', ['pane', 'send-keys', left, ...kind.trust.decline]);
        if (declined.exit_code !== 0) return reject(declined);
        await run('herdr', ['agent', 'wait', name, '--until', 'idle', '--until', 'unknown', '--timeout', '15000']);
        return reject(failCli(dir, job, place, untrusted));
      }
    }
    if (notReady) return reject(await startupFailure(started, left));
    if (kind.startupQuirk === 'phantom-working') {
      const settled = await settlePhantomWorking(name);
      if (settled) return reject(settled);
    }
    if (resume) {
      const got = await run('herdr', ['agent', 'get', name]);
      const agent = got.exit_code === 0 ? JSON.parse(got.stdout).result?.agent : null;
      if (agent?.agent_session?.kind !== 'id' || agent.agent_session.value !== resume.id)
        return reject(launchError(`${place.agent} did not open the recorded session`));
      writeCreateStatus(dir, { state: 'working', agent_session_id: resume.id });
    }
    const turn = writeTurn(dir, { restarted: !!resume, callerToken });
    const prompt = withDonePrompt(resume?.message ?? startup.prompt, bundled, dir, turn, place.agent!);
    mayHaveInput = true;
    const submitted = await run('herdr', [
      'agent',
      'prompt',
      name,
      prompt,
      '--wait',
      '--until',
      'working',
      '--timeout',
      '30000',
    ]);
    if (refusedBeforeInput(submitted) && reportSignature(dir) === turn.report_sig) return reject(submitted);
    // An ambiguous submission still needs supervision; it is not worker death.
    if (!spawnCliSupervisor(dir)) return { exit_code: 1, stdout: '', stderr: 'hud-cli did not start' };
    return { exit_code: 0, stdout: '', stderr: '' };
  } catch (error) {
    const result = launchError(String(error));
    return mayHaveInput ? result : reject(result);
  }
}
function queuePositionsForJobs(allJobs = jobs(), statusFor = readCachedStatus): Map<string, number> {
  return computeQueuePositions(
    allJobs.map((item) => ({
      id: item.job,
      role: item.role,
      state: statusFor(item.job).status?.state ?? null,
      queuedAt: queuedTimestamp(item),
    }))
  );
}
function scanForCall() {
  let receipts: Job[] | undefined, missingReceipt = false, summaryStale = false;
  let positions: Map<string, number> | undefined;
  const statuses = new Map<string, ReturnType<typeof readCachedStatus>>();
  const all = () => receipts ??= jobs(() => { missingReceipt = true; });
  const status = (id: string) => statuses.get(id) ?? statuses.set(id, readCachedStatus(id)).get(id)!;
  return {
    all, status,
    position: (id: string) => (positions ??= queuePositionsForJobs(all(), status)).get(id),
    summaryJobs: (): readonly Job[] | undefined => (!summaryStale && !missingReceipt ? receipts : undefined),
    invalidateSummary() { summaryStale = true; },
    watcherNeeded(waiting: boolean) {
      try {
        return all().some(job => {
          const state = (waiting ? readCachedStatus : status)(job.job).status?.state;
          if (state !== 'done' && state !== 'closed' && state !== 'failed' && state !== 'stopped') return true;
          // A terminal state does not prove the watcher has finished reaping or cleaning the checkout.
          return !!(job.worktree && !job.worktree_removed_at && !job.worktree_kept_reason) ||
            (!job.reaped_at && !!fs.lstatSync(join(directory(job.job), jobFiles.session), { throwIfNoEntry: false }));
        }) || missingReceipt;
      } catch {
        return true; // An unreadable store is not evidence that nothing needs watching.
      }
    },
    record(job: Job) {
      statuses.delete(job.job);
      if (!receipts) return;
      const index = receipts.findIndex(item => item.job === job.job);
      if (index === -1) receipts.push({ ...job });
      else receipts[index] = { ...job };
    },
    clear() { receipts = positions = undefined; statuses.clear(); },
  };
}
type JobScan = ReturnType<typeof scanForCall>;
// Track receipt writes made by a tool without using its display snapshot for dispatch admission.
const writeScan = new AsyncLocalStorage<JobScan>();

function countWorkingByRole(allJobs = jobs()): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of allJobs) {
    const status = readCachedStatus(item.job).status;
    if (!isWorkingForCap(item, status)) continue;
    counts.set(item.role, (counts.get(item.role) ?? 0) + 1);
  }
  return counts;
}
// Pass null for wait samples, which need fresh status but no FIFO lookup yet.
function readRow(job: Job, markExhaustion = true, lookup?: number | JobScan | null) {
  const dir = directory(job.job);
  const file = join(dir, jobFiles.status);
  const scan = typeof lookup === 'object' ? lookup : undefined;
  let { status, at: statusAt } = (scan?.status ?? readCachedStatus)(job.job);
  const pos = status?.state === 'queued' && lookup !== null
    ? (typeof lookup === 'number' ? lookup : scan ? scan.position(job.job) : queuePositionsForJobs().get(job.job))
    : undefined;
  let row = jobRow(job, status, { dir, cache: jobCache, queuePosition: pos });
  let currentJob = job;
  if (markExhaustion && row.display_state === 'failed' && !job.exhaustion_marked && status && row.reason) {
    const outcome = recordFailureExhaustion(hudHome, bundled, dir, job, row.reason);
    if (outcome.marked) {
      jobCache.invalidateFile(join(dir, jobFiles.job));
      currentJob = { ...job, exhaustion_marked: true };
      status = {
        ...status,
        exit_reason: outcome.reason,
        ...(status.error ? { error: outcome.reason } : {}),
      };
      try {
        const published = jobCache.writeJsonAtomic(file, status as unknown as Record<string, unknown>, { mkdir: false });
        statusAt = published.mtimeMs;
      } catch {
        /* Ignore transient STATUS.json write error. */
      }
      (scan ?? writeScan.getStore())?.record(currentJob);
      row = jobRow(currentJob, status, {
        dir,
        cache: jobCache,
        questionIds: row.question_ids,
        reportPresent: row.report_present,
        reportAt: row.report_mtime,
      });
    }
  }
  return { row, status, statusAt, job: currentJob };
}

function compactRow(row: JobRow) {
  const reason = row.blocked || row.state === 'waiting_orchestrator' || row.display_state === 'failed' ? row.reason : null;
  return {
    job: row.job,
    role: row.role,
    ...(row.overflow_from ? { overflow_from: row.overflow_from } : {}),
    state: row.state ?? row.display_state,
    ...(row.queue_position !== undefined ? { queue_position: row.queue_position } : {}),
    ...(row.report_unread ? { report_unread: true } : {}),
    ...(row.blocked ? { blocked: true } : {}),
    ...(row.question_ids.length ? { question_ids: row.question_ids } : {}),
    ...(reason ? { reason } : {}),
  };
}

async function peekJob(job: Job, { lines, detail }: Args, scan: JobScan) {
  const dir = directory(job.job);
  const { row } = readRow(job, false, scan);
  const summary = {
    status: compactRow(row),
    ...readJobProgress(dir),
    ...(detail === true ? { diagnostics: { ...jobDiagnostics(job), display_state: row.display_state } } : {}),
  };
  if (lines === undefined) return summary;
  if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1 || lines > 120)
    throw new Error('invalid_arguments: lines');
  const pane = jobCache.readSession(job.job)?.fields.left;
  if (!herdrId(pane) || pane.startsWith('-')) return { ...summary, pane_lines: null, pane_reason: 'no pane' };
  const result = await runHerdr(['pane', 'read', pane, '--source', 'recent'], process.env, { budgetMs: 1000 });
  if (!result.ok) return { ...summary, pane_lines: null, pane_reason: result.reason };
  const output = paneText(result.stdout).replace(/\r?\n$/, '');
  return { ...summary, pane_lines: output ? output.split(/\r?\n/).slice(-lines) : [] };
}

function listReportSummary(row: JobRow) {
  const summary = jobRowReportMeta(row, directory(row.job))?.summary;
  return summary ? { summary: [...summary].slice(0, 120).join('') } : {};
}

function listJobs(recent: boolean, scan: JobScan) {
  const newest = scan.all().filter(projectJobFilter(process.cwd())).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const children = new Map<string, number>();
  for (const { parent_job } of newest) {
    if (parent_job) children.set(parent_job, (children.get(parent_job) ?? 0) + 1);
  }
  const childCount = (id: string) => children.has(id) ? { child_count: children.get(id) } : {};
  const recentLimit = 20;
  if (recent) {
    const rows = newest.slice(0, recentLimit).map((job) => {
      const { row } = readRow(job, !isWorker, scan);
      return {
        job: row.job,
        ...(row.parent_job ? { parent_job: row.parent_job } : {}),
        ...childCount(row.job),
        role: row.role,
        ...(row.overflow_from ? { overflow_from: row.overflow_from } : {}),
        state: row.state,
        display_state: row.display_state,
        ...(row.queue_position !== undefined ? { queue_position: row.queue_position } : {}),
        reason: row.reason,
        blocked: row.blocked,
        open_questions: row.open_questions,
        report_present: row.report_present,
        report_unread: row.report_unread,
        created_at: job.created_at,
        ...listReportSummary(row),
      };
    });
    return { jobs: rows };
  }
  const candidates = newest.flatMap((job, index) => {
    if (job.parent_job) return [];
    // Scanning beyond recent history must not widen the list's quota side effects.
    const { row } = readRow(job, !isWorker && index < recentLimit, scan);
    const active = row.display_state === 'working' || row.display_state === 'queued';
    if (!active && !(ownsJob(job) && row.report_unread)) return [];
    return [{ row, active, compact: { ...compactRow(row), ...childCount(row.job) } }];
  });
  // Keep active work visible. Spend the remaining space on the newest unread reports,
  // reserving room for the single count of those that didn't fit.
  let budget = 2048 - Buffer.byteLength(JSON.stringify({
    jobs: candidates.filter(({ active }) => active).map(({ compact }) => compact),
    older_unread_reports: candidates.length,
  }));
  let older_unread_reports = 0;
  const rows = candidates.flatMap(({ row, active, compact }) => {
    if (active) return [compact];
    if (!older_unread_reports) {
      const preview = { ...compact, ...listReportSummary(row) };
      budget -= 1 + Buffer.byteLength(JSON.stringify(preview));
      if (budget >= 0) return [preview];
    }
    older_unread_reports++;
    return [];
  });
  return { jobs: rows, ...(older_unread_reports ? { older_unread_reports } : {}) };
}

const settled = (state: string | null) => ['idle_grace', 'closed', 'done', 'failed', 'stopped'].includes(state ?? '');
const JOB_WATCH_FILES = new Set<string>([jobFiles.status, jobFiles.job, jobFiles.report, jobFiles.qa, CHECKS_FILE]);
const WAIT_JOB_DIRECT_WATCH_LIMIT = 16;

function jobWatchTargets(dir: string): WatchTarget[] {
  const qaDir = join(dir, jobFiles.qa);
  const list: WatchTarget[] = [
    {
      dir,
      filter: (name) => name === null || JOB_WATCH_FILES.has(name),
    },
  ];
  if (fs.existsSync(qaDir)) {
    list.push({
      dir: qaDir,
      filter: (name) => name === null || /^q\d+(?:\.answer)?\.md$/.test(name),
    });
  }
  return list;
}

async function waitJobs({ jobs: ids, mode = 'any', wait_ms = 60000 }: Args, scan: JobScan) {
  if (mode !== 'any' && mode !== 'all') throw new Error('invalid_arguments: mode');
  if (typeof wait_ms !== 'number' || !Number.isInteger(wait_ms) || wait_ms < 0 || wait_ms > 120000)
    throw new Error('invalid_arguments: wait_ms');
  const deadline = performance.now() + wait_ms;
  const readJob = (id: string) => findJob(id);
  let initial: JobRow[];
  if (ids === undefined) {
    // Existing session jobs may settle while herdr is listing panes; keep the call-start targets.
    const atStart = new Map(sessionJobs(scan).map((job) => [job.job, readRow(job, false, null).row]));
    if (await adoptSessionJobs(scan)) {
      for (const job of sessionJobs(scan)) if (!atStart.has(job.job)) atStart.set(job.job, readRow(job, false, null).row);
    }
    initial = [...atStart.values()].filter((row) => !settled(row.state));
  } else {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !JOB_ID_RE.test(id)))
      throw new Error('invalid_arguments: jobs');
    await adoptSessionJobs(scan);
    initial = [...new Set<string>(ids)].map((id) => {
      const job = readJob(id);
      if (!job) throw new Error(`invalid_arguments: unknown job ${id}`);
      return readRow(job, false, null).row;
    });
  }
  const targets = new Set(initial.map((row) => row.job));
  function result(rows: JobRow[], timedOut = false) {
    const allSettled = mode === 'all' && rows.length === targets.size && rows.every((row) => settled(row.state));
    const triggered = rows.filter((row) => allSettled || (mode === 'any' && settled(row.state)) ||
      row.blocked || row.state === 'waiting_orchestrator' || row.display_state === 'failed' || row.open_questions > 0
    ).map((row) => row.job);
    const ready = targets.size === 0 || triggered.length > 0;
    const timed_out = !ready && (timedOut || performance.now() >= deadline);
    const jobs = ready || timed_out ? rows.map(row => compactRow(row.state === 'queued'
      ? { ...row, queue_position: scan.position(row.job) } : row)) : [];
    return { ready, timed_out, triggered, jobs };
  }
  const sample = () => [...targets].flatMap((id) => {
    const job = readJob(id);
    return job ? [readRow(job, false, null).row] : [];
  });
  let first = true;
  const watchTargets = (): WatchTarget[] =>
    targets.size <= WAIT_JOB_DIRECT_WATCH_LIMIT
      ? [...targets].flatMap((id) => jobWatchTargets(directory(id)))
      : [{
          dir: jobsRoot,
          recursive: true,
          filter: (name) => {
            if (name === null) return true;
            const [id, file] = name.split('/');
            return !id || (targets.has(id) && (!file || JOB_WATCH_FILES.has(file)));
          },
        }];

  return waitUntilFs({
    targets: watchTargets,
    timeoutMs: Math.max(0, deadline - performance.now()),
    isTransientError: (error) => error instanceof SyntaxError,
    check: ({ timedOut }) => {
      const rows = first && ids !== undefined ? initial : sample();
      first = false;
      const next = result(rows, timedOut);
      return next.ready || next.timed_out ? { done: true, value: next } : { done: false };
    },
  });
}

function openQuestions(dir: string): string[] {
  return jobCache.readQa(dir).openIds.map((id) => `${id}.md`);
}
function jobDiagnostics(job: Job) {
  return {
    cwd: job.cwd,
    ...(job.attempts ? { attempts: job.attempts, used_place: job.used_place ?? null } : {}),
    place: job.place,
    ...(job.preset !== undefined ? { preset: job.preset } : {}),
    model: job.model,
    thinking: job.thinking,
    model_source: job.model_source,
    ...(job.cli ? { idle_grace_s: job.cli.idle_grace_s } : {}),
    ...(job.resume_s !== undefined ? { resume_s: job.resume_s } : {}),
    ...(job.cli?.mcp_scope_warning ? { mcp_scope_warning: job.cli.mcp_scope_warning } : {}),
    ...Object.fromEntries([...piSwitches, 'pi_args' as const].map((key) => [key, job[key]])),
    ...(job.role_skills !== undefined
      ? {
          role_skills: job.role_skills,
          skipped_skills: job.skipped_skills ?? [],
          worker_prompt: job.worker_prompt ?? null,
        }
      : {}),
    dispatch_exit_code: job.dispatch_exit_code,
    stderr_tail: job.stderr_tail,
  };
}
type GitSummary = Awaited<ReturnType<typeof gitSummary>>;
function readGit(summary: GitSummary | undefined, full: boolean) {
  if (!summary) return {};
  const { paths, ...git_summary } = summary;
  if (full) return { git_summary };
  const more = (summary.changed_files ?? 0) - (paths?.length ?? 0);
  return {
    changed_files: paths && (more ? [...paths, `+${more} more`] : paths),
    ...(summary.overlaps?.length ? { overlaps: summary.overlaps.map(({ job }) => job) } : {}),
    ...('overlaps_incomplete' in summary && summary.overlaps_incomplete ? { overlaps_incomplete: true } : {}),
  };
}

// Count JSON escapes and UTF-8, not UTF-16 units; never split a code point.
function digestLine(text: string, budget: number) {
  let line = '';
  for (const ch of text.trim()) {
    budget -= Buffer.byteLength(JSON.stringify(ch)) - 2;
    if (budget < 0) return line + '…';
    line += ch;
  }
  return line;
}
const RESULT_HEAD_BYTES = 2048;
function fallbackResultLine(text: string) {
  // The notice reads only this prefix; use the same evidence when the digest has a larger body.
  const head = Buffer.from(text.slice(0, RESULT_HEAD_BYTES)).subarray(0, RESULT_HEAD_BYTES).toString('utf8');
  return (firstReportProse(head) ?? 'Report ready').slice(0, 240);
}
function reportDigest(report: NonNullable<ReturnType<typeof slice>>, job: string, state: string | null,
  summary: string | undefined, git: GitSummary | undefined) {
  const verdict = report.text.match(/^[\t ]*(?:[-*] )?(?:\*\*)?verdict(?:\*\*)?:(?:\*\*)?[\t ]*([^\r\n]+)/im)?.[1].trim();
  const blockers = report.text.match(/^[\t ]*(?:[-*] )?(?:\*\*)?blockers?(?:\*\*)?:(?:\*\*)?[\t ]*([^\r\n]+)/im)?.[1].trim();
  const facts = { state, read_hint: reportReadHint(job), report_bytes: report.bytes,
    ...(git ? { changed_files: git.changed_files } : {}),
    ...(verdict ? { verdict: digestLine(verdict, 100) } : {}),
    ...(blockers ? { blockers: digestLine(blockers, 160) } : {}) };
  const budget = 1000 - Buffer.byteLength(JSON.stringify({ ...facts, result: '…' }));
  return { ...facts, result: digestLine(summary ?? fallbackResultLine(report.text), budget) };
}
function observation(
  job: Job,
  full: boolean,
  detail: boolean,
  git: GitSummary | undefined,
  preRead?: ReturnType<typeof readRow>
) {
  const dir = directory(job.job);
  const { row, status, job: currentJob } = preRead ?? readRow(job, !isWorker);
  const report = row.report_unread || full ? slice(join(dir, jobFiles.report), 65536) : null;
  const reportMeta = jobRowReportMeta(row, dir);
  const questions = (preRead ? row.question_ids.map((id) => `${id}.md`) : openQuestions(dir)).map((name) => ({
    id: name.slice(0, -3),
    text: slice(join(dir, jobFiles.qa, name), 2048)?.text ?? '',
  }));
  const progress = readJobProgress(dir);
  const checks = jobChecks(dir, { ...currentJob });
  const exit_reason = typeof status?.exit_reason === 'string' ? status.exit_reason : null;
  return {
    row,
    value: {
      job: currentJob.job,
      role: currentJob.role,
      ...(currentJob.overflow_from ? { overflow_from: currentJob.overflow_from } : {}),
      state: detail ? row.state : row.state ?? row.display_state,
      ...(row.queue_position !== undefined ? { queue_position: row.queue_position } : {}),
      ...(detail || (row.state !== null && row.state !== row.display_state) ? { display_state: row.display_state } : {}),
      ...(detail || row.reason ? { reason: row.reason } : {}),
      ...(detail || row.blocked ? { blocked: row.blocked } : {}),
      ...(detail || exit_reason ? { exit_reason } : {}),
      ...(full && status?.quiet_decision && typeof status.quiet_decision === 'object' ? { quiet_decision: status.quiet_decision } : {}),
      ...(detail ? jobDiagnostics(currentJob) : {}),
      ...readGit(git, full),
      ...(full && currentJob.worktree ? { worktree: currentJob.worktree } : {}),
      ...(full && currentJob.worktree_removed_at ? { worktree_removed_at: currentJob.worktree_removed_at } : {}),
      ...(full && currentJob.worktree_kept_reason ? { worktree_kept_reason: currentJob.worktree_kept_reason } : {}),
      report_exists: row.report_present,
      ...(full && reportMeta ? { report_meta: reportMeta } : {}),
      ...(detail || (full && row.report_unread) ? { report_unread: row.report_unread } : {}),
      ...(full && (detail || progress.latest_progress) ? progress : { latest_progress: progress.latest_progress ?? undefined }),
      ...(checks ? { checks: full ? checks : { state: checks.state, stale: checks.stale,
        results: checks.results.map(({ command, passed }) => `${passed ? 'pass' : 'fail'}: ${digestLine(command.replace(/\s+/g, ' '), 120)}`) } } : {}),
      ...(row.report_present && !report ? { report_unchanged: true } : report && !full ? {
        digest: reportDigest(report, currentJob.job, row.state ?? row.display_state, reportMeta?.summary, git),
      } : {
        ...(full && report ? { report_path: join(dir, jobFiles.report) } : {}),
        ...(detail || report ? { report: report?.text ?? null } : {}),
        ...(detail || report?.truncated ? { report_truncated: report?.truncated ?? false } : {}),
      }),
      ...(detail || questions.length ? { questions } : {}),
    },
  };
}
async function readContextFile(path: string, limit: number | undefined) {
  const file = await fs.promises.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    if (limit !== undefined && stat.size > limit) return null;
    // Validate the whole file, but only keep the body for browser briefs.
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let content = '', bytes = 0;
    while (true) {
      const length = limit === undefined ? buffer.length : Math.min(buffer.length, limit - bytes + 1);
      const { bytesRead } = await file.read(buffer, 0, length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (limit !== undefined && bytes > limit) return null;
      const text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      if (/[\x00-\x08\x0e-\x1f\x7f]/.test(text)) throw new Error('binary content');
      if (limit !== undefined) content += text;
    }
    decoder.decode(); // Reject an incomplete final UTF-8 sequence.
    return { bytes, content };
  } finally {
    await file.close();
  }
}

const BRIEF_FILE_MAX_BYTES = 256 * 1024;
async function readBriefFile(raw: unknown, cwd: string): Promise<{ task: string } | { ok: false; code: 'invalid_arguments' | 'context_too_large'; error: string }> {
  if (typeof raw !== 'string' || !raw || raw.includes('\0'))
    return { ok: false, code: 'invalid_arguments', error: 'invalid brief_file' };
  try {
    const base = await fs.promises.realpath(cwd);
    const path = await fs.promises.realpath(resolve(cwd, raw));
    const rel = relative(base, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('outside cwd');
    const file = await readContextFile(path, BRIEF_FILE_MAX_BYTES);
    if (!file) return { ok: false, code: 'context_too_large', error: `brief_file: ${JSON.stringify(raw)}` };
    if (!file.content.trim()) return { ok: false, code: 'invalid_arguments', error: 'brief_file is empty' };
    return { task: file.content };
  } catch {
    return { ok: false, code: 'invalid_arguments', error: `brief_file: ${JSON.stringify(raw)} must resolve to a readable UTF-8 text file inside ${cwd}` };
  }
}

const SONIC_FACTS_EN =
  'Sonic facts: unverified starting points with file:line; its unchecked list is where it did not look; read yourself any code you base a decision on.';
const SONIC_FACTS_ZH =
  'Sonic 事实：带 file:line 的未核实起点；未检查列表是它没有看的地方；凡是据此做决定的代码，请亲自阅读。';
function sonicFactsPrefix(task: unknown): string {
  if (typeof task !== 'string' || !task.trim()) return SONIC_FACTS_EN;
  const words = replyWords(task).replace(/\b(?:[\w]+[-./#][\w./#-]+|[A-Z\d_]{2,}|[0-9a-f]{7,40})\b/g, ' ');
  const han = words.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const other = words.match(/[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/gu)?.length ?? 0;
  const latin = words.match(/[A-Za-z]/g)?.length ?? 0;
  return han > 0 && !(other >= 4 && other >= 0.2 * (han + other)) && (han >= 0.25 * (han + latin) || needsTranslation(task, 'en'))
    ? SONIC_FACTS_ZH
    : SONIC_FACTS_EN;
}

async function assembleContext(args: Args, cwd: string, inline: boolean, project: { root: string; registered: boolean }, repairOf?: string) {
  const metadata: Pick<Job, 'context_files' | 'from_jobs'> = {};
  const sections: string[] = [];
  let remaining = 256 * 1024;
  const inside = (base: string, path: string) => {
    const rel = relative(base, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('outside its root');
  };
  const append = async (path: string, label: string, prefix?: string) => {
    const file = await readContextFile(path, inline ? Math.min(64 * 1024, remaining) : undefined);
    if (!file) return false;
    if (inline) {
      remaining -= file.bytes;
      let length = 3;
      for (const run of file.content.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
      const fence = '`'.repeat(length);
      sections.push(`${prefix ? `${prefix}\n\n` : ''}### ${label}\n\n${fence}\n${file.content}${file.content.endsWith('\n') ? '' : '\n'}${fence}`);
    } else sections.push(prefix ? `${prefix}\n- ${label}` : `- ${label}`);
    return true;
  };
  let standing: string | undefined;
  let standingLabel: string | undefined;
  let reference = '';
  if (project.registered) {
    const standingPath = join(project.root, '.hud', 'brief.md');
    try {
      const path = await fs.promises.realpath(standingPath);
      inside(project.root, path);
      if (inline) {
        if (!(await append(path, JSON.stringify(standingPath))))
          return { ok: false, code: 'context_too_large', error: standingPath } as const;
      } else {
        if (!(await fs.promises.stat(path)).isFile()) throw new Error('not a regular file');
        // A heading here could replace the title of a task written without one.
        reference = `Read the project standing brief: ${JSON.stringify(standingPath)}.\n\n`;
      }
      standing = path;
      standingLabel = standingPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return { ok: false, code: 'invalid_arguments', error: `${standingPath} must resolve to a readable text file inside ${project.root}` } as const;
    }
  }
  const sonicPrefix = sonicFactsPrefix(args.task);
  for (const [key, root, max] of [['context_files', cwd, 32], ['from_jobs', jobsRoot, 16]] as const) {
    const given = args[key];
    const repair = key === 'from_jobs' ? repairOf : undefined;
    if (given === undefined && !repair) continue;
    const values = given === undefined ? [] : given;
    if (!Array.isArray(values) || values.length > max || values.some((v) =>
      typeof v !== 'string' || !v || v.includes('\0') || (key === 'from_jobs' && !/^j[0-9a-f]{16}$/.test(v)))) {
      return { ok: false, code: 'invalid_arguments', error: `invalid ${key} (maximum ${max} entries)` } as const;
    }
    const recorded: string[] = metadata[key] = [];
    if (!values.length && !repair) continue;
    let source: string = key;
    try {
      const base = await fs.promises.realpath(root);
      const files: { value: string; name: 'report' | 'brief' | '' }[] = values.map((value) => ({ value, name: key === 'from_jobs' ? 'report' : '' }));
      if (repair) {
        if (!values.includes(repair)) files.push({ value: repair, name: 'report' });
        files.push({ value: repair, name: 'brief' });
      }
      for (const { value, name } of files) {
        source = `${key}: ${JSON.stringify(value)}`;
        const path = await fs.promises.realpath(resolve(root, name ? join(value, jobFiles[name]) : value));
        inside(base, path);
        const label = `${name ? `${value} ${name}: ` : ''}${JSON.stringify(path)}`;
        let sonic = false;
        if (key === 'from_jobs' && name === 'report') {
          try { sonic = findJob(value)?.role === 'sonic'; } catch { /* Corrupt receipt leaves sonic false. */ }
        }
        if (path === standing) {
          if (!inline) await readContextFile(path, undefined); // Explicit context still requires UTF-8 text.
        } else if (!(await append(path, label, sonic ? sonicPrefix : undefined))) {
          return { ok: false, code: 'context_too_large', error: source } as const;
        }
        if (!name || (name === 'report' && (value !== repair || values.includes(value)))) recorded.push(name ? value : path);
      }
    } catch {
      return { ok: false, code: 'invalid_arguments', error: `${source} must resolve to a readable UTF-8 text file inside ${root}` } as const;
    }
  }
  const block = !sections.length ? '' : inline
    ? `\n## Context\n\n${sections.join('\n\n')}\n`
    : `## Context References\n\nRead these files for task context:\n\n${sections.join('\n')}\n\n`;
  return {
    metadata,
    block: reference + block,
    standing: standing && standingLabel ? { path: standing, label: standingLabel } satisfies StandingBriefRef : undefined,
  };
}

function placeOptions(args: Args, configured: RolePlace) {
  const place = { ...configured };
  const invalid = (error?: string) => ({ ok: false, code: 'invalid_arguments', error } as const);
  if (args.mode !== undefined && (args.mode !== 'headless' || place.harness !== 'pi'))
    return invalid('headless mode requires pi');
  if (args.idle_grace_s !== undefined) {
    if (!Number.isInteger(args.idle_grace_s) || (args.idle_grace_s as number) < 60 || (args.idle_grace_s as number) > 3600)
      return invalid('idle_grace_s must be an integer from 60 to 3600');
    if (place.harness !== 'cli') return invalid(place.harness === 'pi'
      ? "idle_grace_s is CLI-only; pi grace follows the model's cache lifetime inside pi-roles"
      : 'idle_grace_s is CLI-only; browser jobs have no idle grace');
  }
  if (args.kind !== undefined) {
    if (place.harness !== 'bro' || place.tool !== 'jev-flow' || (args.kind !== 'image' && args.kind !== 'video')) return invalid();
    place.kind = args.kind;
  } else if (place.harness === 'bro' && place.tool === 'jev-flow' && !place.kind) place.kind = 'image';
  if (place.harness === 'bro' && (args.model !== undefined || args.thinking !== undefined || args.isolation === 'worktree'))
    return invalid(args.isolation === 'worktree' ? 'worktree isolation is local-only' : undefined);
  if (args.thinking !== undefined) place.thinking = required(args, 'thinking');
  const options: PiOptions = place.harness === 'pi' ? { split: place.split ?? false, pi_args: place.pi_args ?? [] } : {};
  for (const key of piSwitches) {
    const value = args[key];
    if (value !== undefined) {
      if (place.harness !== 'pi' || typeof value !== 'boolean') return invalid();
      options[key] = value;
    } else if (key !== 'skills' && place.harness === 'pi' && place[key] !== undefined) options[key] = place[key];
  }
  if (args.pi_args !== undefined && place.harness !== 'pi') return invalid();
  const piArgs = args.pi_args === undefined ? options.pi_args : args.pi_args;
  if (piArgs !== undefined) {
    if (!Array.isArray(piArgs) || piArgs.length > 128 ||
      piArgs.some((value) => typeof value !== 'string' || value.length > 4096)) return invalid();
    if (piArgs.some((value) => /^--(?:orchestrator|notify)(?:=|$)/.test(value)))
      return invalid('pi_args cannot override --orchestrator or --notify caller binding');
    if (args.role === 'sonic' && piArgs.some(value => value === '--' || /^(-c|-r|--(?:continue|resume|fork|session|no-session|session-id|mode|task-dir|dispatch-slot|role-output))(?:=|$)/.test(value)))
      return invalid('pi_args cannot override the one-shot sonic lifecycle');
    if (args.mode === 'headless' && piArgs.some(value => value === '--' || /^(-c|-r|--(?:no-session|continue|resume|fork|session(?:-id|-dir)?|mode|task-dir|dispatch-slot|role-output|qa-dir|qa-timeout))(?:=|$)/.test(value)))
      return invalid('pi_args cannot override the headless session lifecycle');
    options.pi_args = piArgs;
  }
  return { place, options };
}

// An in-place land retry uses its original worktree but still belongs to the registered main project's roster.
const roleCwd = (job: Job) => job.worktree?.main_root ?? (job.land_turn ? job.project_root : undefined) ?? job.cwd;
const piOptionKeys = [...piSwitches, 'pi_args'] as const;
const replayOptions = ['mode', 'on', 'model', 'thinking', 'isolation', 'idle_grace_s', 'kind', 'context_files', ...piOptionKeys] as const;
function jobOptions(job: Job): Args {
  return {
    role: job.role, cwd: job.worktree?.main_root ?? job.cwd, package: job.package, ticket: job.ticket, slice: job.slice, preset: job.preset,
    context_files: job.context_files, from_jobs: job.from_jobs, checks: job.checks,
    ...(job.create_options ?? {
      isolation: job.worktree ? 'worktree' : undefined,
      model: job.model_source === 'hud_create' ? job.model : undefined,
      thinking: job.thinking ?? undefined, idle_grace_s: job.cli?.idle_grace_s, kind: job.bro?.kind,
      ...Object.fromEntries(piOptionKeys.map((key) => [key, job[key]])),
    }),
  };
}
function originalTask(job: Job): string {
  const brief = fs.readFileSync(join(directory(job.job), jobFiles.brief), 'utf8');
  if (job.task_length !== undefined) return brief.slice(0, job.task_length);
  // Old receipts only have the assembled brief. Strip HUD-generated context and instructions.
  return brief.split(/\n## Context References\n\nRead these files for task context:\n|\n## Context\n\n### |\nFinish with `hud_report`\.\n$|\nThis harness uses the commands below instead of the worker tools named in your role\./, 1)[0].trimEnd();
}

type SonicParent = Pick<Job, 'job' | 'cwd' | 'project_root' | 'worktree'>;
function sonicCwd(parent: SonicParent, args: Args): string {
  // Use the actual launch cwd from the receipt, not the worktree's main checkout or process.cwd().
  if (typeof parent.cwd !== 'string' || !isAbsolute(parent.cwd)) throw new Error('missing parent cwd');
  if (args.cwd === undefined) return jobCwd({ cwd: parent.cwd });

  const cwd = jobCwd({ cwd: fs.realpathSync(resolve(parent.cwd, required(args, 'cwd'))) });
  const root = fs.realpathSync(parent.project_root ?? parent.worktree?.main_root ?? sharedRoot(parent.cwd));
  const rel = relative(root, cwd);
  const inside = rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  // Linked worktrees can sit outside their main checkout's directory.
  if (inside || sharedRoot(cwd) === root) return cwd;
  throw new Error('outside parent project');
}

function continuationWorktreeSource(jobId: string | undefined, fallback?: Job): Job | undefined {
  const seen = new Set<string>();
  for (let id = jobId; id && !seen.has(id) && seen.size < 16;) {
    seen.add(id);
    const job = findJob(id);
    if (!job) break;
    if (job.worktree) return job;
    id = job.repair_of;
  }
  return fallback?.worktree?.owner ? fallback : undefined;
}

type SlotGate = { wait: Promise<void>; release: () => void };

export async function dispatchJob(input: Args, pane: string | undefined, parent?: SonicParent, repair?: { job: string; derived: boolean }, batch = false, slotGate?: SlotGate) {
  if (parent) {
    try { input = { ...input, cwd: sonicCwd(parent, input) }; }
    catch { return { ok: false, code: 'invalid_arguments', error: 'sonic cwd must be an existing directory inside the parent project' }; }
  }
  if (input.task !== undefined && input.brief_file !== undefined) {
    return { ok: false, code: 'invalid_arguments', error: 'task and brief_file are mutually exclusive' };
  }
  const retryOf = input.retry_of === undefined ? undefined : required(input, 'retry_of');
  const source = retryOf ? findJob(retryOf) : null;
  if (retryOf && !source) return { ok: false, code: 'job_not_found' };
  const role = input.role === undefined && source ? source.role : required(input, 'role');
  // Check caller input, not inherited retry options or internal repair placement.
  if (!parent && !repair && role !== 'general' && ['preset', 'on', 'model', 'thinking'].some(key => input[key] !== undefined)) {
    return { ok: false, code: 'invalid_arguments', error: `Role ${JSON.stringify(role)} runs as configured in its role file and Control; use general to choose a model for one job.` };
  }
  let args = input;
  let repairOf = repair?.job;
  let worktreeSource = repair?.job ? continuationWorktreeSource(repair.job) : undefined;
  if (source) {
    const { row } = readRow(source);
    if (row.state !== 'failed' && row.state !== 'stopped') return { ok: false, code: 'not_retryable' };
    const inherited = jobOptions(source);
    delete inherited.on; // Retry through the role's chain instead of pinning the previous harness.
    if (input.on !== undefined) delete inherited.preset;
    args = { ...inherited, ...(input.task === undefined && input.brief_file === undefined ? { task: originalTask(source) } : {}), ...input, role };
    repairOf = input.from_jobs === undefined ? source.repair_of : undefined;
    if (input.cwd === undefined && input.isolation !== 'none') {
      worktreeSource = continuationWorktreeSource(source.repair_of, source);
    }
  }
  const cwd = jobCwd(args);
  if (args.brief_file !== undefined) {
    const loaded = await readBriefFile(args.brief_file, cwd);
    if ('code' in loaded) return loaded;
    const { brief_file: _unused, ...rest } = args;
    args = { ...rest, task: loaded.task };
  }
  // An explicit key can retrieve a prior job even when other arguments in the retry differ.
  const requestKey = args.request_key === undefined
    ? derivedKey(retryOf ? 'retry' : 'create', pane, role, cwd, required(args, 'task'), retryOf)
    : required(args, 'request_key');
  const windowedKey = args.request_key === undefined || repair?.derived === true;
  return keyLock(`request:${requestKey}`, () =>
    dispatchWithKey(args, pane, requestKey, windowedKey, parent?.job, repairOf, retryOf ? input : undefined, { worktreeSource, batch, slotGate }));
}

const pendingScouts = new Map<string, AbortController>();
const scoutedCreates = new Set<Promise<void>>();

async function runCreateScout(target: Job, question: string, contextCwd: string, contextFiles: unknown, signal: AbortSignal): Promise<{ id?: string; failure?: string }> {
  let scout: Job | null = null;
  let discard = false;
  try {
    const result = await dispatchWithKey({ role: 'sonic', task: question, cwd: target.cwd, context_files: contextFiles },
      target.herdr_pane, `scout:${target.job}`, false, target.job, undefined, undefined, { scoutContextCwd: contextCwd });
    if (!('job' in result)) {
      return { failure: ('reason' in result && result.reason) || ('error' in result && result.error) || ('code' in result && result.code) || 'could not launch' };
    }
    const id = result.job;
    while ((scout = findJob(id))) {
      const { row } = readRow(scout);
      if (signal.aborted) { discard = !settled(row.state); return {}; }
      if (settled(row.state)) {
        if (row.state === 'failed' || row.state === 'stopped') return { failure: row.reason ?? row.state };
        if (!row.report_present) return { failure: 'settled without a report' };
        save({ ...scout, read_at: new Date().toISOString() });
        return { id };
      }
      if (row.open_questions || row.blocked || row.state === 'waiting_orchestrator') {
        discard = true;
        return { failure: row.open_questions ? 'asked a question' : row.reason ?? 'needed attention' };
      }
      await sleep(500, undefined, { signal });
    }
    return { failure: 'scout receipt disappeared' };
  } catch (error) {
    discard = !!scout;
    return { failure: error instanceof Error ? error.message : String(error) };
  } finally {
    if (discard && scout) await stopSonic(directory(scout.job)).catch(() => ensureWatcher());
  }
}

const matchPlace = (p: RolePlace, target: RolePlace) =>
  p.harness === target.harness &&
  (target.harness !== 'cli' || p.agent === target.agent) &&
  (target.harness !== 'bro' || (p.tool === target.tool && (!target.provider || p.provider === target.provider)));

function argsForPlace(args: Args, place: RolePlace, retryInput?: Args) {
  if (!retryInput) return args;
  const compatible = { ...args };
  const unused = [...(place.harness === 'pi' ? [] : piOptionKeys),
    ...(place.harness === 'cli' ? [] : ['idle_grace_s']),
    ...(place.harness === 'bro' && place.tool === 'jev-flow' ? [] : ['kind'])];
  for (const key of unused) if (retryInput[key] === undefined) delete compatible[key];
  return compatible;
}

function harnessesSourceFor(onName: string | null): string {
  let overrideHarnesses: Record<string, { model?: string }> | null = null;
  if (onName) {
    try {
      overrideHarnesses = json<Record<string, { model?: string }>>(join(hudHome, 'harnesses.json'));
    } catch {
      overrideHarnesses = null;
    }
  }
  return onName && overrideHarnesses?.[onName]?.model !== undefined
    ? join(hudHome, 'harnesses.json')
    : join(bundled, 'harnesses.json');
}

export function canOverflowImpJob(job: Job): boolean {
  if (job.role !== 'imp') return false;
  const cwd = roleCwd(job);
  const found = registry(cwd);
  const roles = found.roles();
  const definition = roles.get('imp');
  if (!definition || !roles.has('general') || (job.headless && !definition.can_continue)) return false;
  if (job.preset !== undefined && !definition.presets?.some((p) => p.name === job.preset)) return false;
  let routing;
  try { routing = found.routing(Date.now()); } catch { return false; }
  const onName = typeof job.create_options?.on === 'string' ? job.create_options.on : null;
  const defaults = onName ? harnessDefaults(hudHome, bundled) : null;
  const onEntry = onName ? defaults?.[onName] : undefined;
  if (onName && !onEntry) return false;
  const modelOverride = typeof job.create_options?.model === 'string' ? job.create_options.model : undefined;
  if (onEntry?.harness === 'bro' && modelOverride !== undefined) return false;
  const choice = onEntry ? { run: [{ ...definition.run.find((p) => matchPlace(p, onEntry)), ...onEntry }] }
    : job.preset !== undefined ? { preset: job.preset } : undefined;
  const effective = found.assignment(definition, Date.now(), modelOverride, routing, choice, !!job.retry_of && job.create_options?.model === undefined);
  const active = effective.places.find((p) => p.state === 'active');
  if (!active) return false;
  const opts = jobOptions(job);
  const retryInput = job.retry_of ? { retry_of: job.retry_of, ...(job.create_options ?? {}) } : undefined;
  return !('code' in placeOptions(argsForPlace({ ...opts, role: 'general' }, active.place, retryInput), active.place));
}

async function dispatchWithKey(args: Args, pane: string | undefined, request_key: string, windowedKey: boolean,
  parentJob?: string, repairOf?: string, retryInput?: Args,
  { scoutContextCwd, landCwd, worktreeSource, batch, slotGate }: { scoutContextCwd?: string; landCwd?: string; worktreeSource?: Job; batch?: boolean; slotGate?: SlotGate } = {}) {
  const asked = required(args, 'role');
  const cwd = jobCwd(args);
  const found = registry(cwd);
  // `architect` names oracle unless a role file defines its own architect.
  const configured = found.roles(true);
  const requestedRole = asked === 'architect' && !configured.has(asked) ? 'oracle' : asked;
  if (args.scout !== undefined && (requestedRole === 'sonic' || typeof args.scout !== 'string' || !args.scout.trim())) {
    return { ok: false, code: 'invalid_arguments', error: requestedRole === 'sonic' ? 'scout is not available for role sonic' : 'scout must be a nonempty question' };
  }
  const scoutQuestion = args.scout as string | undefined;
  if (scoutQuestion && Array.isArray(args.from_jobs) && args.from_jobs.length >= 16) {
    return { ok: false, code: 'invalid_arguments', error: 'scouted dispatch reserves one of the 16 from_jobs entries' };
  }
  let role = requestedRole;
  const definition = configured.get(role);
  if (definition?.optionalEnabled === false) return { ok: false, code: 'role_unavailable',
    reason: `Optional role ${role} is off. Turn it on in Control → Roles (Space), or configure it in $HUD_HOME/role-switches.json.` };
  if (!definition) {
    const invalid = found.invalidRole(role);
    return { ok: false, code: 'role_unavailable', reason: `Role ${asked} is not configured or is hidden in this project`, ...invalid };
  }
  const now = Date.now();
  const existing = jobs().find((job) =>
    job.request_key === request_key && (!windowedKey || withinRetryWindow(job.created_at, now)));
  if (existing) {
    ensureWatcher();
    if (!taskClient) void ensureQueueWatcher(pane, hudHome);
    return created(existing);
  }
  if (args.mode !== undefined && !definition.can_continue)
    return { ok: false, code: 'invalid_arguments', error: 'explicit headless mode requires a continuable role' };
  const isolation = args.isolation === undefined ? 'none' : args.isolation;
  if (isolation !== 'none' && isolation !== 'worktree') return { ok: false, code: 'invalid_arguments', error: 'invalid isolation' };
  const task = required(args, 'task');
  const { checks } = args;
  if (checks !== undefined && (!Array.isArray(checks) || checks.length > MAX_CHECKS || checks.some((command) =>
    typeof command !== 'string' || !command.trim() || command.length > MAX_CHECK_COMMAND || command.includes('\0')))) {
    throw new Error('invalid_arguments: checks');
  }
  if (args.package !== undefined && typeof args.package !== 'string') throw new Error('invalid_arguments: package');
  for (const key of ['ticket', 'slice']) if (args[key] !== undefined) required(args, key);
  if (args.preset !== undefined && args.on !== undefined) {
    return { ok: false, code: 'invalid_arguments', error: 'preset and on are mutually exclusive' };
  }
  const presetName = args.preset === undefined ? undefined : required(args, 'preset');
  const preset = definition.presets?.find((p) => p.name === presetName);
  if (presetName !== undefined && !preset) {
    return { ok: false, code: 'invalid_arguments', error: `unknown preset: ${presetName}` };
  }
  let routing;
  try { routing = found.routing(now); }
  catch (error) {
    if (error instanceof HarnessSwitchError) return harnessSwitchFailure(error);
    throw error;
  }
  const onName = args.on !== undefined ? required(args, 'on') : null;
  const defaults = onName ? harnessDefaults(hudHome, bundled) : null;
  const onEntry = onName ? defaults?.[onName] : undefined;
  if (onName && !onEntry) {
    return { ok: false, code: 'invalid_arguments', error: `unknown harness: ${onName}` };
  }
  if (role === 'sonic' && ((onEntry && onEntry.harness !== 'pi') || preset?.run.some(p => p.harness !== 'pi'))) {
    return { ok: false, code: 'invalid_arguments', error: 'sonic runs headless on pi only' };
  }
  const modelOverride = args.model === undefined ? undefined : required(args, 'model');
  if (onEntry?.harness === 'bro' && modelOverride !== undefined) return { ok: false, code: 'invalid_arguments' };
  const choice = onEntry ? { run: [{ ...definition.run.find((p) => matchPlace(p, onEntry)), ...onEntry }] }
    : presetName !== undefined ? { preset: presetName } : undefined;
  const effective = found.assignment(definition, now, modelOverride, routing, choice, !!retryInput && retryInput.model === undefined);
  const places = effective.places.filter(p => !landCwd || p.place.harness !== 'bro');
  const details = places.find((p) => p.state === 'active' || (landCwd && p.state === 'standby'));
  const argsFor = (place: RolePlace) => argsForPlace(args, place, retryInput);
  if (!herdrId(pane)) return { ok: false, code: 'herdr_required' };

  const id = 'j' + randomBytes(8).toString('hex');
  const dir = directory(id);
  const project = found.project();
  const contextCwd = scoutContextCwd ?? cwd;
  const contextFor = (targetArgs: Args, inline: boolean) => assembleContext(targetArgs, contextCwd, inline, project, repairOf);
  let worktree: ManagedWorktree | undefined;
  let reusedWorktree: ManagedWorktree | undefined;
  if (isolation === 'worktree') {
    if (worktreeSource) reusedWorktree = await reusableWorktree(worktreeSource, cwd) ?? undefined;
    if (reusedWorktree) worktree = reusedWorktree;
    else {
      try { worktree = await planWorktree(cwd, id, (args.package as string | undefined) || role); }
      catch { return { ok: false, code: 'invalid_arguments', error: 'worktree isolation requires a Git checkout with a HEAD commit' }; }
    }
  }

  const enforceCap = role !== 'sonic' && !parentJob && !scoutContextCwd && !landCwd;
  let overflowFrom: string | undefined;
  let initial: Exclude<ReturnType<typeof placeOptions>, { code: 'invalid_arguments' }> | undefined;
  let inline = false;
  let context: Exclude<Awaited<ReturnType<typeof assembleContext>>, { ok: false }> | undefined;
  let base!: Job;
  let queuedReply: ReturnType<typeof created> | TaskReply | undefined;

  const admit = async () => {
    let shouldQueue = false;
    if (enforceCap) {
      const concurrency = loadConcurrencySettings();
      const cap = capForRole(concurrency, role);
      const workingByRole = countWorkingByRole();
      if (cap > 0 && (workingByRole.get(role) ?? 0) >= cap) {
        const generalCap = capForRole(concurrency, 'general');
        const generalHasRoom = generalCap === 0 || (workingByRole.get('general') ?? 0) < generalCap;
        if (role === 'imp' && concurrency.impOverflow && generalHasRoom && found.roles().has('general')) {
          // Overflow borrows a concurrency slot, not the general role's launch chain or mode.
          overflowFrom = 'imp';
          role = 'general';
        } else shouldQueue = true;
      }
    }

    if (shouldQueue) {
      if (!details) {
        return { ok: false as const, code: 'no_available_place' as const, reason: effective.reason, places: effective.places, exhausted: effective.exhausted };
      }
      const checked = placeOptions(argsFor(details.place), details.place);
      if ('code' in checked) return checked;
      const queuedContext = await contextFor(args, false);
      if ('code' in queuedContext) return queuedContext;
      const nowIso = new Date().toISOString();
      const queuedJob: Job = {
        job: id,
        role,
        request_key,
        cwd: reusedWorktree?.root ?? cwd,
        project_root: sharedRoot(cwd),
        ...(reusedWorktree ? { worktree: reusedWorktree } : {}),
        herdr_pane: pane,
        created_at: nowIso,
        queued_at: nowIso,
        ...(args.mode === 'headless' && { headless: true }),
        task_length: task.length,
        ...queuedContext.metadata,
        ...(checks?.length ? { checks } : {}),
        ...(repairOf ? { repair_of: repairOf } : {}),
        ...(retryInput ? { retry_of: required(retryInput, 'retry_of') } : {}),
        ...(scoutQuestion ? { scout_question: scoutQuestion } : {}),
        target_hint: taskTarget(task) || null,
        ...(args.package === undefined ? {} : { package: args.package as string }),
        ...(args.ticket === undefined ? {} : { ticket: args.ticket as string }),
        ...(args.slice === undefined ? {} : { slice: args.slice as string }),
        ...(presetName === undefined ? {} : { preset: presetName }),
        create_options: {
          cwd,
          ...Object.fromEntries(replayOptions.filter((key) => args[key] !== undefined).map((key) => [key, args[key]])),
        },
        attempts: [],
        dispatch_exit_code: null,
        stderr_tail: '',
      };
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      writePrivateFile(join(dir, jobFiles.brief), `${task}\n\n${queuedContext.block}`, { exclusive: true, mkdir: false });
      save(queuedJob);
      writeCreateStatus(dir, { state: 'queued', role, updated_at: nowIso });
      const position = queuePositionsForJobs().get(id) ?? 1;
      trackCreatedJob(id);
      const queuedRow = readRow(queuedJob, false, position).row;
      cursor.set(id, queuedRow);
      ensureWatcher();
      let taskEntry: HudTask | undefined;
      if (taskClient) {
        taskEntry = beginTask(queuedJob);
        taskEntry.view.statusMessage = `${taskLabel(taskEntry, 'queued')} (#${position})`;
      } else void ensureQueueWatcher(pane, hudHome);
      if (batch) {
        registerBatchTask(taskEntry, queuedJob, true);
        queuedReply = created(queuedJob, queuedRow);
      } else {
        queuedReply = finishTask(taskEntry, queuedJob, true) ?? created(queuedJob, queuedRow);
      }
      return undefined;
    }

    if (!details) {
      return { ok: false as const, code: 'no_available_place' as const, reason: effective.reason, places: effective.places, exhausted: effective.exhausted };
    }
    if (!initial) {
      const checked = placeOptions(argsFor(details.place), details.place);
      if ('code' in checked) return checked;
      initial = checked;
    }
    inline = initial.place.harness === 'bro';
    const assembled = await contextFor(args, inline);
    if ('code' in assembled) return assembled;
    context = assembled;
    base = {
      job: id,
      role,
      ...(overflowFrom ? { overflow_from: overflowFrom } : {}),
      request_key,
      cwd: landCwd ?? reusedWorktree?.root ?? cwd,
      project_root: sharedRoot(cwd),
      ...(reusedWorktree ? { worktree: reusedWorktree } : {}),
      herdr_pane: pane,
      created_at: new Date().toISOString(),
      task_length: task.length,
      ...(checks?.length ? { checks } : {}),
      ...(repairOf ? { repair_of: repairOf } : {}),
      ...(retryInput ? { retry_of: required(retryInput, 'retry_of') } : {}),
      ...(landCwd ? { land_turn: request_key } : {}),
      target_hint: taskTarget(task) || null, // Keep even under another pane; missing means a legacy receipt.
      ...(parentJob ? { parent_job: parentJob } : {}),
      ...(role === 'sonic' || args.mode === 'headless' ? { headless: true } : {}),
      ...(scoutContextCwd === undefined ? {} : { scout_only: true }),
      ...(args.package === undefined ? {} : { package: args.package as string }),
      ...(args.ticket === undefined ? {} : { ticket: args.ticket as string }),
      ...(args.slice === undefined ? {} : { slice: args.slice as string }),
      ...(presetName === undefined ? {} : { preset: presetName }),
      attempts: [],
      dispatch_exit_code: null,
      stderr_tail: '',
    };
    if (enforceCap) {
      // Reserve this slot on disk inside the concurrency lock so concurrent creates and the watcher see it immediately.
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      save(base);
    }
    return undefined;
  };

  let admissionError: Awaited<ReturnType<typeof admit>>;
  if (slotGate) await slotGate.wait;
  try {
    admissionError = enforceCap ? await keyLock('concurrency', admit) : await admit();
  } finally {
    slotGate?.release();
  }
  if (admissionError !== undefined) return admissionError;
  if (queuedReply !== undefined) return queuedReply;

  const harnessesSource = harnessesSourceFor(onName);
  const attempts = base.attempts!;
  const selected = definition.presets?.some((p) => p.run === definition!.run);
  const candidates = places.filter((p) => p === details || p.state === 'standby');
  let scoutTask: HudTask | undefined;
  let scoutResult: Awaited<ReturnType<typeof runCreateScout>> | undefined;
  // Reads can reveal the persisted ID before launch ends; serialize its mutations with launch too.
  const launch = () => keyLock(`job:${id}`, async () => {
    let job = base;
    let result: DispatchResult = launchError('no launch attempted');
    let reason = '';
    let taskEntry: HudTask | undefined;
    let sonicPick: Promise<string | undefined> | undefined;
    for (const candidate of candidates) {
      const launchArgs = argsFor(candidate.place);
      const prepared = candidate === details ? initial! : placeOptions(launchArgs, candidate.place);
      if ('code' in prepared) continue; // Explicit harness-only options still constrain this dispatch.
      if (attempts.length) {
        const exhausted = readExhausted(hudHome);
        const quota = isQuotaFailure(reason);
        if ((quota && candidate.key === job.place_key) || exhausted.has(candidate.key)) continue;
        if (quota && !exhausted.has(job.place_key!)) markExhausted(hudHome, job.place_key!, reason);
        // The previous tab is closed. Keep the job, but do not carry its launch/turn state into a new worker.
        for (const file of [jobFiles.session, jobFiles.status, jobFiles.turn]) fs.rmSync(join(dir, file), { force: true });
        jobCache.invalidateJob(id);
      } else fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

      const { place, options } = prepared;
      let thinking_source: Job['thinking_source'];
      if (role === 'sonic' && place.harness !== 'bro') {
        if (args.thinking !== undefined) thinking_source = 'explicit';
        else {
          const picked = await (sonicPick ??= pickSonicThinking(hudHome, task, definition!.thinking_choices));
          if (picked !== undefined) place.thinking = picked;
          thinking_source = picked === undefined ? 'default' : 'decision';
        }
      }
      const attempt: LaunchAttempt = { index: candidate.index, place: describePlace(place, candidate.model.value) };
      job = {
        ...base, ...options, place, place_key: candidate.key,
        ...(place.harness === 'bro' || role === 'sonic' ? {} : { resume_s: definition!.resume_s ?? DEFAULT_RESUME_S }),
        create_options: {
          cwd: landCwd ?? cwd, ...Object.fromEntries(replayOptions.filter((key) => launchArgs[key] !== undefined).map((key) => [key, launchArgs[key]])),
        },
        ...(job.worktree ? { worktree: job.worktree, cwd: job.cwd } : {}),
        ...(place.harness === 'bro' ? { bro: place } : {
          model: candidate.model.value, thinking: place.thinking ?? candidate.thinking.value,
          ...(thinking_source ? { thinking_source } : {}),
          model_source: modelOverride !== undefined ? 'hud_create' : onEntry?.model !== undefined ? harnessesSource : candidate.model.source,
        }),
        ...(place.harness === 'cli' ? { cli: {
          agent: place.agent!, can_continue: (effective.harness === 'bro' ? definition!.can_continue : effective.can_continue) === true,
          idle_grace_s: (args.idle_grace_s as number | undefined) ?? definition!.idle_grace_s ?? 600,
          state_trust: candidate.state_trust ?? 'advisory',
        } } : {}),
      };
      const browser = place.harness === 'bro';
      let briefContext = inline === browser ? context! : await contextFor(args, browser);
      let scoutFailure = scoutResult?.failure;
      if (scoutResult?.id && !('code' in briefContext)) {
        const withScout = await contextFor({ ...args, from_jobs: [...(briefContext.metadata.from_jobs ?? []), scoutResult.id] }, browser);
        if ('code' in withScout) scoutFailure = withScout.code === 'context_too_large' ? 'report exceeds the context limit' : 'report is unreadable';
        else briefContext = withScout;
      }
      if (scoutQuestion) {
        if (scoutFailure) {
          job.scout_state = 'failed';
          job.scout_error = digestLine(scoutFailure.replace(/\s+/g, ' '), 120);
        } else if (scoutResult?.id) {
          job.scout_state = 'done';
          delete job.scout_error;
        }
      }
      if (!('code' in briefContext)) {
        Object.assign(job, briefContext.metadata);
        const note = scoutFailure ? `Scout failed: ${digestLine(scoutFailure.replace(/\s+/g, ' '), 300)}\n\n` : '';
        writeBrief(job, dir, task, note + briefContext.block, !scoutQuestion && attempts.length === 0);
      }
      // Persist before dispatch: an interrupted launch must not dispatch again on retry.
      save(job, attempts.length > 0);
      if (attempts.length === 0) publishWorkSummary();
      if (attempts.length === 0) {
        if (job.retry_of) {
          const source = findJob(job.retry_of);
          if (source) save({ ...source, observed_at: new Date().toISOString() });
        }
        if (parentJob && !job.scout_only) {
          const children = join(directory(parentJob), jobFiles.sonic);
          fs.mkdirSync(children, { recursive: true, mode: 0o700 });
          fs.writeFileSync(join(children, id), '', { mode: 0o600, flag: 'wx' });
        } else if (!parentJob) trackCreatedJob(id);
        ensureWatcher();
        if (taskClient && !parentJob && !scoutTask) taskEntry = beginTask(job);
        else if (!scoutTask && !job.scout_only) void ensureQueueWatcher(pane, hudHome);
      }
      const launchRole = preset || selected ? { ...definition!, skills: place.skills } : definition!;
      if (scoutQuestion && attempts.length === 0) {
        fs.rmSync(join(dir, jobFiles.status), { force: true });
        jobCache.invalidateFile(join(dir, jobFiles.status));
      }
      if ('code' in briefContext) result = { ...launchError(briefContext.error ?? 'could not prepare launch context'), preInput: true };
      else result = await launchPlace(job, launchRole, place, dir, task, worktree, briefContext.standing);
      reason = result.exit_code === 0 ? '' : launchReason(result);
      if (reason) attempt.reason = reason;
      attempts.push(attempt);
      if (result.exit_code === 0 || (!result.preInput && fs.existsSync(join(dir, jobFiles.status)))) job.used_place = attempt.place;
      if (job.headless || !result.preInput || result.cleanupFailed) break;
      save(job);
    }
    const launchRow = finishLaunch(job, dir, result, reason, !scoutQuestion);
    if (scoutTask && activeTasks.get(id) === scoutTask && scoutTask.view.status === 'working' && job.herdr_pane === scoutTask.pane) {
      scoutTask.fence = taskFence(job);
      extendTask(scoutTask, job);
    }
    if (batch) {
      registerBatchTask(taskEntry, job, result.exit_code === 0);
      return created(job, launchRow);
    }
    return finishTask(taskEntry, job, result.exit_code === 0, taskEntry && launchSummary(job)) ?? created(job, launchRow);
  });
  if (!scoutQuestion) return launch();

  // The target ID (and task, if negotiated) is stable across both stages.
  base.scout_state = 'scouting';
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeBrief({ ...base, place: initial!.place }, dir, task, context!.block, true);
  save(base);
  writeCreateStatus(dir, { state: 'working', reason: 'scouting' });
  trackCreatedJob(id);
  const scoutRow = readRow(base).row;
  cursor.set(id, scoutRow);
  ensureWatcher();
  if (taskClient) {
    scoutTask = beginTask(base);
    scoutTask.view.statusMessage = taskLabel(scoutTask, 'scouting');
  } else void ensureQueueWatcher(pane, hudHome);
  if (batch) registerBatchTask(scoutTask, base, true);
  const reply = batch ? created(base, scoutRow) : (finishTask(scoutTask, base, true) ?? created(base, scoutRow));
  const controller = new AbortController();
  pendingScouts.set(id, controller);
  const creating = (async () => {
    try {
      // Keep worktree creation behind the same trust gate as ordinary worktree dispatch.
      if (worktree && !base.worktree && candidates.some(({ place }) => !('code' in placeOptions(argsFor(place), place)) &&
        (place.harness === 'pi' || (place.harness === 'cli' && isCliDirTrusted(place.agent!, worktree!.main_root))))) {
        await prepareWorktree(base, worktree);
      }
      if (!controller.signal.aborted && (!worktree || base.worktree)) {
        scoutResult = await runCreateScout(base, scoutQuestion, cwd, context!.metadata.context_files, controller.signal);
      }
      if (controller.signal.aborted) {
        save({ ...base, dispatch_exit_code: 1 });
        writeCreateStatus(dir, { state: 'stopped', exit_reason: 'scouted dispatch stopped', ended_at: new Date().toISOString() });
        return;
      }
      // Hand off synchronously: subsequent mutations queue behind the target launch lock.
      pendingScouts.delete(id);
      await launch();
    } catch (error) {
      const latest = findJobMutable(id) ?? base;
      finishLaunch(latest, dir, { ...launchError(String(error)), preInput: true }, String(error), false);
      if (scoutTask && activeTasks.get(id) === scoutTask && scoutTask.view.status === 'working' && latest.herdr_pane === scoutTask.pane) {
        scoutTask.fence = taskFence(latest);
        persistTask(scoutTask);
      }
    } finally {
      pendingScouts.delete(id);
    }
  })();
  scoutedCreates.add(creating);
  void creating.then(() => scoutedCreates.delete(creating), () => scoutedCreates.delete(creating));
  return reply;
}

/** Watcher entry point: claim a queued job atomically and start it on its first available place at start time. */
export async function startQueuedJob(id: string, targetRole?: string, overflowed = false): Promise<{ started: boolean; failed?: boolean; reason?: string }> {
  const dir = directory(id);
  try {
    fs.writeFileSync(join(dir, QUEUE_START_MARKER), `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOENT') return { started: false };
    throw error;
  }
  return keyLock(`job:${id}`, async () => {
    jobCache.invalidateJob(id);
    const existing = findJobMutable(id);
    const status = readCachedStatus(id).status;
    if (!existing || status?.state !== 'queued') return { started: false };
    const role = targetRole ?? existing.role;
    const cwd = existing.worktree?.main_root ?? (typeof existing.create_options?.cwd === 'string' ? existing.create_options.cwd : existing.cwd);
    const failQueued = (reason: string, code?: Job['dispatch_code']) => {
      existing.role = role;
      if (overflowed && role !== 'imp') existing.overflow_from = 'imp';
      existing.dispatch_exit_code = 1;
      if (code) existing.dispatch_code = code;
      existing.stderr_tail = reason;
      save(existing);
      writeCreateStatus(dir, { state: 'failed', role, exit_reason: reason, error: reason, ended_at: new Date().toISOString() });
      return { started: false, failed: true, reason };
    };
    let task: string;
    try { task = originalTask(existing); }
    catch (error) { return failQueued(`could not read queued brief: ${error instanceof Error ? error.message : String(error)}`); }
    const args: Args = { ...jobOptions(existing), cwd, role, task };
    const retryInput: Args | undefined = existing.retry_of ? { retry_of: existing.retry_of, ...(existing.create_options ?? {}) } : undefined;
    const found = registry(cwd);
    const definition = found.roles(true).get(existing.role);
    if (definition?.optionalEnabled === false) return failQueued(`Optional role ${existing.role} is off`);
    if (!definition) return failQueued(`Role ${existing.role} is not configured or is hidden in this project`);
    if (args.mode === 'headless' && !definition.can_continue) return failQueued('headless mode requires a continuable role', 'invalid_arguments');
    const now = Date.now();
    let routing;
    try { routing = found.routing(now); }
    catch (error) { return failQueued(error instanceof Error ? error.message : String(error)); }
    const onName = typeof args.on === 'string' ? args.on : null;
    const defaults = onName ? harnessDefaults(hudHome, bundled) : null;
    const onEntry = onName ? defaults?.[onName] : undefined;
    if (onName && !onEntry) return failQueued(`unknown harness: ${onName}`, 'invalid_arguments');
    const presetName = typeof args.preset === 'string' ? args.preset : undefined;
    const preset = definition.presets?.find((p) => p.name === presetName);
    if (presetName !== undefined && !preset) return failQueued(`unknown preset: ${presetName}`, 'invalid_arguments');
    const modelOverride = typeof args.model === 'string' ? args.model : undefined;
    const choice = onEntry ? { run: [{ ...definition.run.find((p) => matchPlace(p, onEntry)), ...onEntry }] }
      : presetName !== undefined ? { preset: presetName } : undefined;
    const effective = found.assignment(definition, now, modelOverride, routing, choice, !!retryInput && retryInput.model === undefined);
    const places = effective.places;
    const details = places.find((p) => p.state === 'active');
    if (!details) return failQueued(effective.reason ?? 'no available place');
    const argsFor = (place: RolePlace) => argsForPlace(args, place, retryInput);
    const initial = placeOptions(argsFor(details.place), details.place);
    if ('code' in initial) return failQueued(initial.error ?? 'invalid_arguments', 'invalid_arguments');

    let worktree: ManagedWorktree | undefined = existing.worktree;
    if (!worktree && args.isolation === 'worktree') {
      try { worktree = await planWorktree(cwd, id, existing.package || role); }
      catch { return failQueued('worktree isolation requires a Git checkout with a HEAD commit', 'invalid_arguments'); }
    }

    if (overflowed && existing.role !== role) {
      existing.overflow_from = existing.role;
      existing.role = role;
    }
    const base: Job = { ...existing, role, ...(role === 'sonic' ? { headless: true } : {}), attempts: [] };
    const project = found.project();
    const contextFor = (targetArgs: Args, inline: boolean) => assembleContext(targetArgs, cwd, inline, project, existing.repair_of);
    const inline = initial.place.harness === 'bro';
    const context = await contextFor(args, inline);
    if ('code' in context) return failQueued(context.error ?? context.code ?? 'invalid_arguments', context.code === 'invalid_arguments' ? 'invalid_arguments' : undefined);

    const scoutQuestion = existing.scout_question;
    let scoutResult: Awaited<ReturnType<typeof runCreateScout>> | undefined;
    if (scoutQuestion) {
      base.scout_state = 'scouting';
      save(base);
      writeCreateStatus(dir, { state: 'working', role, reason: 'scouting' });
      const controller = new AbortController();
      if (worktree && !base.worktree && places.some(({ place }) => !('code' in placeOptions(argsFor(place), place)) &&
        (place.harness === 'pi' || (place.harness === 'cli' && isCliDirTrusted(place.agent!, worktree!.main_root))))) {
        await prepareWorktree(base, worktree);
      }
      if (!worktree || base.worktree) {
        scoutResult = await runCreateScout(base, scoutQuestion, cwd, context.metadata.context_files, controller.signal);
      }
    }

    // Leave queued state cleanly before launching.
    fs.rmSync(join(dir, jobFiles.status), { force: true });
    jobCache.invalidateFile(join(dir, jobFiles.status));
    save(base);

    const harnessesSource = harnessesSourceFor(onName);
    const attempts = base.attempts!;
    const selected = definition.presets?.some((p) => p.run === definition.run);
    const candidates = places.filter((p) => p === details || p.state === 'standby');
    let job = base;
    let result: DispatchResult = launchError('no launch attempted');
    let reason = '';
    let sonicPick: Promise<string | undefined> | undefined;
    for (const candidate of candidates) {
      const launchArgs = argsFor(candidate.place);
      const prepared = candidate === details ? initial : placeOptions(launchArgs, candidate.place);
      if ('code' in prepared) continue;
      if (attempts.length) {
        const exhausted = readExhausted(hudHome);
        const quota = isQuotaFailure(reason);
        if ((quota && candidate.key === job.place_key) || exhausted.has(candidate.key)) continue;
        if (quota && !exhausted.has(job.place_key!)) markExhausted(hudHome, job.place_key!, reason);
        for (const file of [jobFiles.session, jobFiles.status, jobFiles.turn]) fs.rmSync(join(dir, file), { force: true });
        jobCache.invalidateJob(id);
      }
      const { place, options } = prepared;
      let thinking_source: Job['thinking_source'];
      if (role === 'sonic' && place.harness !== 'bro') {
        if (args.thinking !== undefined) thinking_source = 'explicit';
        else {
          const picked = await (sonicPick ??= pickSonicThinking(hudHome, task, definition.thinking_choices));
          if (picked !== undefined) place.thinking = picked;
          thinking_source = picked === undefined ? 'default' : 'decision';
        }
      }
      const attempt: LaunchAttempt = { index: candidate.index, place: describePlace(place, candidate.model.value) };
      job = {
        ...base, ...options, place, place_key: candidate.key,
        ...(place.harness === 'bro' || role === 'sonic' ? {} : { resume_s: definition.resume_s ?? DEFAULT_RESUME_S }),
        create_options: {
          cwd, ...Object.fromEntries(replayOptions.filter((key) => launchArgs[key] !== undefined).map((key) => [key, launchArgs[key]])),
        },
        ...(job.worktree ? { worktree: job.worktree, cwd: job.cwd } : {}),
        ...(place.harness === 'bro' ? { bro: place } : {
          model: candidate.model.value, thinking: place.thinking ?? candidate.thinking.value,
          ...(thinking_source ? { thinking_source } : {}),
          model_source: modelOverride !== undefined ? 'hud_create' : onEntry?.model !== undefined ? harnessesSource : candidate.model.source,
        }),
        ...(place.harness === 'cli' ? { cli: {
          agent: place.agent!, can_continue: (effective.harness === 'bro' ? definition.can_continue : effective.can_continue) === true,
          idle_grace_s: (args.idle_grace_s as number | undefined) ?? definition.idle_grace_s ?? 600,
          state_trust: candidate.state_trust ?? 'advisory',
        } } : {}),
      };
      const browser = place.harness === 'bro';
      let briefContext = inline === browser ? context : await contextFor(args, browser);
      let scoutFailure = scoutResult?.failure;
      if (scoutResult?.id && !('code' in briefContext)) {
        const withScout = await contextFor({ ...args, from_jobs: [...(briefContext.metadata.from_jobs ?? []), scoutResult.id] }, browser);
        if ('code' in withScout) scoutFailure = withScout.code === 'context_too_large' ? 'report exceeds the context limit' : 'report is unreadable';
        else briefContext = withScout;
      }
      if (scoutQuestion) {
        if (scoutFailure) {
          job.scout_state = 'failed';
          job.scout_error = digestLine(scoutFailure.replace(/\s+/g, ' '), 120);
        } else if (scoutResult?.id) {
          job.scout_state = 'done';
          delete job.scout_error;
        }
      }
      if (!('code' in briefContext)) {
        Object.assign(job, briefContext.metadata);
        const note = scoutFailure ? `Scout failed: ${digestLine(scoutFailure.replace(/\s+/g, ' '), 300)}\n\n` : '';
        writeBrief(job, dir, task, note + briefContext.block, false);
      }
      save(job, attempts.length > 0);
      if (attempts.length === 0 && job.retry_of) {
        const source = findJob(job.retry_of);
        if (source) save({ ...source, observed_at: new Date().toISOString() });
      }
      const launchRole = preset || selected ? { ...definition, skills: place.skills } : definition;
      if ('code' in briefContext) result = { ...launchError(briefContext.error ?? 'could not prepare launch context'), preInput: true };
      else result = await launchPlace(job, launchRole, place, dir, task, worktree, briefContext.standing, { callerToken: existing.created_at });
      reason = result.exit_code === 0 ? '' : launchReason(result);
      if (reason) attempt.reason = reason;
      attempts.push(attempt);
      if (result.exit_code === 0 || (!result.preInput && fs.existsSync(join(dir, jobFiles.status)))) job.used_place = attempt.place;
      if (job.headless || !result.preInput || result.cleanupFailed) break;
      save(job);
    }
    finishLaunch(job, dir, result, reason, false);
    return { started: result.exit_code === 0, ...(result.exit_code !== 0 ? { failed: true, reason } : {}) };
  });
}

function writeBrief(job: Job, dir: string, task: string, block: string, first: boolean) {
  const place = job.place!;
  let brief = `${task}${place.harness === 'bro' ? '\n' : '\n\n'}${block}`;
  if (place.harness === 'pi') brief += 'Finish with `hud_report`.\n';
  else if (place.harness === 'cli' && !cliWorkerTools(place.agent!)) {
    const command = (bin: string) => `node ${JSON.stringify(join(bundled, 'bin', `${bin}.mjs`))}`;
    const own = `--dir ${JSON.stringify(dir)}`;
    brief += 'This harness uses the commands below instead of the worker tools named in your role.\n' +
      `Write your report to ${join(dir, jobFiles.report)}; then run the --done command from the prompt you are answering.\n` +
      `Ask the orchestrator with: ${command('hud-ask')} ${own} --question "..." --default "..."\n`;
    if (job.role !== 'sonic') brief +=
      `Sonic command: ${command('hud-sonic')} start ${own} --task <text> | --task-file <file>\n` +
      `Collect: ${command('hud-sonic')} wait ${own} --job <id>\n`;
    brief += `Optional milestone: ${command('hud-progress')} ${own} "message"\n`;
  }
  // Standing brief and context references follow the task; labels read the brief's opening lines.
  writePrivateFile(join(dir, jobFiles.brief), brief, { exclusive: first, mkdir: false });
}

async function prepareWorktree(job: Job, worktree: ManagedWorktree) {
  await addWorktree(worktree);
  job.worktree = worktree;
  job.cwd = worktree.root;
  save(job);
  await populateWorktree(worktree);
}

async function launchPlace(job: Job, definition: Role, place: RolePlace, dir: string, task: string, worktree?: ManagedWorktree, standingBrief?: StandingBriefRef, options: { callerToken?: string; resume?: NativeResume } = {}): Promise<DispatchResult> {
  const { resume } = options;
  let instructionsPath = '';
  try {
    if (!resume && job.thinking != null) {
      // Pi takes `off`, even when the model maps it to the provider value `none`.
      if (place.harness === 'pi' && job.thinking === 'none') job.thinking = place.thinking = 'off';
      const supported = await launchThinking(hudHome, place, job.model ?? null);
      if (supported && !supported.includes(job.thinking)) {
        const thinking = nearestThinking(job.thinking, supported);
        if (!thinking) return rejectLaunch(launchError(`no supported thinking level for ${job.model}`, 'invalid_arguments'));
        job.thinking = place.thinking = thinking;
      }
    }
    if (place.harness === 'cli') {
      const name = definition.instructions ?? definition.role;
      if (!plainSkillName(name)) return rejectLaunch(launchError(`invalid instructions name: ${name}`, 'unsupported_harness'));
      instructionsPath = join(bundled, 'instructions', `${name}.md`);
      if (!fs.existsSync(instructionsPath))
        return rejectLaunch({ ...launchError(`missing CLI instructions file: ${instructionsPath}`, 'unsupported_harness'), path: instructionsPath });
      if (worktree && !isCliDirTrusted(place.agent!, worktree.main_root)) {
        const reason = `${place.agent} has not trusted ${worktree.main_root}; run hud trust ${worktree.main_root}`;
        return rejectLaunch({ ...failCli(dir, job, place, reason), code: 'untrusted_cwd' });
      }
    }
    if (worktree && !job.worktree) await prepareWorktree(job, worktree);
    if (worktree && place.harness === 'cli') propagateCliTrust(place.agent!, worktree.main_root, worktree.root);
    save(job);
  } catch (error) {
    // Worktree setup is shared; another place cannot repair it.
    return resume ? rejectLaunch(launchError(String(error))) : launchError(String(error));
  }
  if (place.harness === 'cli') return dispatchCli(job, place, instructionsPath, task, definition.mcp_servers ?? [], standingBrief, options);
  if (place.harness === 'pi') return dispatchPi(job, definition, place, task, resume);
  try { return await dispatchBro(job, task); }
  catch (error) { return launchError(String(error)); }
}

function launchReason(result: DispatchResult) {
  let detail = result.stderr.trim();
  if (!detail) {
    try {
      const error = JSON.parse(result.stdout)?.error;
      if (typeof error?.message === 'string') detail = [error.code, error.message].filter(Boolean).join(': ');
    } catch { /* The command may return plain text. */ }
  }
  return (detail || result.stdout.trim().split(/\r?\n/, 1)[0] || `launch exited ${result.exit_code}`).slice(0, 500);
}

function writeCreateStatus(dir: string, status: JobStatus) {
  jobCache.writeJsonAtomic(join(dir, jobFiles.status), status as unknown as Record<string, unknown>, { mkdir: false });
  publishWorkSummary();
}

function finishLaunch(job: Job, dir: string, result: DispatchResult, reason: string, advanceCursor = true): JobRow | undefined {
  job.dispatch_exit_code = result.exit_code;
  if (result.code) job.dispatch_code = result.code;
  if (result.path) job.dispatch_path = result.path;
  job.stderr_tail = result.stderr;
  const statusFile = join(dir, jobFiles.status);
  if (result.exit_code !== 0 && (result.preInput || !fs.existsSync(statusFile))) {
    const outcome = recordFailureExhaustion(hudHome, bundled, dir, job, reason);
    if (outcome.marked) {
      job.exhaustion_marked = true;
      jobCache.invalidateFile(join(dir, jobFiles.job));
    }
    writeCreateStatus(dir, {
      ...result.status,
      state: 'failed',
      harness: job.place?.harness,
      ...(job.bro ? { provider: job.bro.provider === 'chatgpt' ? 'openai' : 'gemini' } : {}),
      exit_reason: outcome.reason,
      ended_at: new Date().toISOString(),
    });
  }
  save(job);
  publishWorkSummary();
  if (!advanceCursor) return undefined;
  const { row } = readRow(job);
  if (!job.parent_job) cursor.set(job.job, row);
  return row;
}

function harnessSwitchFailure(error: HarnessSwitchError) {
  return { ok: false, code: error.code, error: error.message, path: error.path };
}

function compactAssignment(assignment: ReturnType<ReturnType<typeof registry>['assignment']>) {
  const { role, instructions, available, can_continue, runs_on, model, thinking, reason, places,
    preset, preset_missing } = assignment;
  const place = runs_on && {
    harness: runs_on.harness,
    pi_role: runs_on.pi_role,
    agent: runs_on.agent,
    tool: runs_on.tool,
    provider: runs_on.provider,
    kind: runs_on.kind,
    effort: runs_on.effort,
    model: model ?? undefined,
    thinking: thinking ?? undefined,
  };
  return {
    role, available, can_continue, runs_on: place,
    ...(preset ? { preset } : {}),
    ...(preset_missing ? { preset_missing } : {}),
    places: places.map(({ index, state, off_by, until, missing, provider, provider_source }) =>
      ({ index, state, off_by, until, missing, provider, provider_source })),
    ...(instructions && instructions !== role && instructions !== runs_on?.pi_role ? { instructions } : {}),
    ...(reason ? { reason } : {}),
  };
}

function ticketGuide(args: Args): boolean {
  return args.op === undefined || args.op === 'guide';
}
async function resumeJob(current: Job, status: JobStatus, row: JobRow, message: string,
  matchKey: string, explicitKey: string | undefined, land: boolean, batch: boolean, answerRequest?: string) {
  const dir = directory(current.job);
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    // A land helper and the main MCP can both see the same closure. Only one may reopen it.
    const lock = spawnSync('flock', ['-xn', '-E', '75', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 1000 });
    if (lock.status === 75) return { ok: false, code: 'worker_reopening' };
    if (lock.status !== 0) return;
    const latest = findJob(current.job);
    const fresh = readCachedStatus(current.job).status;
    const expected = answerRequest ? 'waiting_orchestrator' : 'closed';
    if (!latest || latest.reaped_at !== current.reaped_at || !fresh || fresh.ended_at !== status.ended_at ||
        fresh.state !== expected || fresh.pid !== status.pid)
      return { ok: false, code: 'worker_reopening' };
    return await reopenJob(latest, fresh, row, message, matchKey, explicitKey, land, batch, answerRequest);
  } finally { fs.closeSync(fd); }
}

async function reopenJob(current: Job, status: JobStatus, row: JobRow, message: string,
  matchKey: string, explicitKey: string | undefined, land: boolean, batch: boolean, answerRequest?: string) {
  const { job: id, place } = current, dir = directory(id);
  const until = answerRequest ? Infinity : resumeDeadline(current, status);
  if (!until || Date.now() >= until || !place || (place.harness !== 'cli' && place.harness !== 'pi') ||
      !fs.statSync(current.cwd, { throwIfNoEntry: false })?.isDirectory()) return;
  const identity = resumeIdentity(current, status);
  const role = registry(roleCwd(current)).roles().get(current.role);
  if (!identity || !role) return;
  const priorSession = current.headless ? null : slice(join(dir, jobFiles.session), 8192);
  if ((!current.headless && (!priorSession || priorSession.truncated)) || fs.existsSync(join(dir, jobFiles.stopRequested)) ||
      fs.existsSync(join(dir, jobFiles.closeRequested))) return;
  const priorTurn = current.cli ? readTurn(dir) : null;
  if (current.cli && !priorTurn) return;
  const oldTask = activeTasks.get(id);
  if (oldTask && !(answerRequest && current.herdr_pane === oldTask.pane && taskFence(current) === oldTask.fence)) sampleTask(oldTask);
  const carryTask = oldTask && !land && activeTasks.get(id) === oldTask && oldTask.view.status === 'working'
    ? oldTask : undefined;
  const key = explicitKey ?? `${matchKey}:${randomBytes(8).toString('hex')}`;
  const outcome = { key, ...(explicitKey === undefined ? { derived_key: matchKey } : {}),
    recorded_at: new Date().toISOString(), exit_code: null as number | null, stderr_tail: '', resumed: true as const };
  const next: Job = { ...current, reaped_at: undefined, land_turn: land ? key : undefined,
    send_outcomes: [...(current.send_outcomes ?? []), outcome] };
  const answerFile = answerRequest && join(dir, jobFiles.qa, `${answerRequest}.answer.md`);
  if (answerRequest && answerFile) {
    if (!jobCache.readQa(dir).openIds.includes(answerRequest)) return { ok: false, code: 'question_not_open' };
    writePrivateFile(answerFile, message, { exclusive: true, mkdir: false });
    jobCache.invalidateQa(id);
    if (jobCache.readQa(dir).openIds.length) {
      if (carryTask) { carryTask.seenQuestions.add(`${answerRequest}.md`); extendTask(carryTask, current); }
      return { ok: true, written: true };
    }
    if (jobCache.readQa(dir).allQuestionFiles.length > 1)
      message = `Answer to ${answerRequest}: ${message}\nOther decisions are in ${join(dir, jobFiles.qa)}.`;
  }
  const taskEntry = taskClient && !land && !carryTask ? beginTask(next, row.report_mtime, answerRequest) : undefined;
  // The reaper has finished the old turn. Publish a nonterminal status before replacing its ownership.
  writeCreateStatus(dir, { state: 'working' });
  save(next, true);
  const result = await launchPlace(next, role, place, dir, message, undefined, undefined, { resume: { ...identity, message } });
  if (result.preInput && !result.cleanupFailed) {
    if (priorSession) writePrivateFile(join(dir, jobFiles.session), priorSession.text, { mkdir: false });
    if (answerFile) { fs.unlinkSync(answerFile); jobCache.invalidateQa(id); }
    if (priorTurn) saveTurn(dir, priorTurn);
    writeCreateStatus(dir, status);
    const touched = findJob(id);
    save({ ...current, read_at: touched?.read_at ?? current.read_at, observed_at: touched?.observed_at ?? current.observed_at }, true);
    if (taskEntry) releaseTask(taskEntry);
    return;
  }
  const latest = findJobMutable(id) ?? next;
  const recorded = latest.send_outcomes?.find((attempt) => attempt.key === key) ?? outcome;
  recorded.exit_code = result.exit_code;
  recorded.stderr_tail = result.stderr;
  if (result.preInput) { // The failed launch still owns a tab; let the watcher retry cleanup.
    writeCreateStatus(dir, { ...result.status, state: 'failed', exit_reason: launchReason(result), ended_at: new Date().toISOString() });
  }
  save(latest);
  const ok = result.exit_code === 0;
  if (carryTask && activeTasks.get(id) === carryTask) {
    if (ok) {
      if (answerRequest) carryTask.seenQuestions.add(`${answerRequest}.md`);
      carryTask.fence = taskFence(latest);
      carryTask.reportBefore = row.report_mtime;
      carryTask.attentionBefore = undefined;
      extendTask(carryTask, latest);
    } else if (batchTasks.get(id) !== carryTask) sampleTask(carryTask);
  }
  if (ok && !taskClient && !land) void ensureQueueWatcher(latest.herdr_pane, hudHome);
  const continuation = 'resumed' as const;
  if (batch) registerBatchTask(taskEntry, latest, ok);
  else {
    const task = finishTask(taskEntry, latest, ok, continuation);
    if (task) return { ...task, job: id, continuation };
  }
  return { ok, sent: ok, ...(answerRequest && { written: true }), job: id, continuation, ...(ok ? {} : { code: 'send_failed', stderr_tail: result.stderr }) };
}

async function sendJob(id: string, message: string, explicitKey: string | undefined, workingOnly: boolean, land = false, batch = false) {
  const matchKey = explicitKey ?? derivedKey('send', id, message);
  let current = findJobMutable(id);
  if (!current) return { ok: false, code: 'job_not_found' };
  if (current.role === 'sonic') return { ok: false, code: 'not_continuable' };
  const dir = directory(current.job);
  const now = Date.now();
  const duplicate = explicitKey === undefined
    ? current.send_outcomes?.find((attempt) => attempt.derived_key === matchKey && withinRetryWindow(attempt.recorded_at, now))
    : sendHistory(current).find((attempt) => attempt.key === explicitKey);
  if (duplicate) {
    const outcome = 'legacy' in duplicate ? undefined : duplicate;
    if (outcome?.exit_code === 0 && !taskClient) void ensureQueueWatcher(process.env.HERDR_PANE_ID, hudHome);
    return outcome?.exit_code === 0
      ? { ok: true, sent: false, ...(outcome.resumed ? { job: id, continuation: 'resumed' as const } : {}) }
      : { ok: false, sent: false, code: 'send_failed',
          ...(outcome && { key: outcome.key, exit_code: outcome.exit_code, stderr_tail: outcome.stderr_tail }) };
  }
  let { row, status, statusAt } = readRow(current);
  const closingPi = current.resume_s !== undefined && row.state === 'idle_grace' && !row.open_questions && piReportSettlement(dir, current, status);
  if (!workingOnly && !row.open_questions && (closingPi || (closedReport(current, status) && !current.reaped_at && (current.headless || primary(id))))) {
    ensureWatcher();
    // Never replace a SESSION receipt while the watcher still owns that tab and process tree.
    const ready = await waitUntilFs({ targets: [{ dir }], timeoutMs: 30_000, check: ({ timedOut }) => {
      const latest = findJobMutable(id);
      if (!latest || latest.reaped_at || timedOut) return { done: true, value: latest?.reaped_at ? latest : null };
      return { done: false };
    } });
    if (!ready) return { ok: false, code: 'worker_closing' };
    current = ready;
    ({ row, status, statusAt } = readRow(current));
  }
  const state = row.state ?? '';
  const repairKey = derivedKey('repair', id, matchKey);
  if (!workingOnly && !row.open_questions && closedReport(current, status)) {
    if (!land) {
      const prior = jobs().find((job) => job.request_key === repairKey &&
        (explicitKey !== undefined || withinRetryWindow(job.created_at, now)));
      if (prior) {
        supersedeTask(id, `continued as repair job ${prior.job}`);
        return { ...created(prior), continued_as: prior.job, continuation: 'repair' as const };
      }
    }
    if (status && current.reaped_at) {
      const resumed = await resumeJob(current, status, row, message, matchKey, explicitKey, land, batch);
      if (resumed) return resumed;
    }
    if (land) return { ok: false, code: 'not_continuable' };
  }
  if (!workingOnly && !land && !row.open_questions && (closedReport(current, status) ||
      (state === 'closed' && status?.exit_reason === REPORT_READ_EXIT) ||
      (current.resume_s === undefined && (state === 'idle_grace' || (state === 'closed' && status?.exit_reason === 'settled')) &&
        piReportSettlement(dir, current, status)))) {
    const repair = await dispatchJob({ ...jobOptions(current), task: message, request_key: repairKey },
      process.env.HERDR_PANE_ID, undefined, { job: id, derived: explicitKey === undefined }, batch);
    const continued_as = 'job' in repair ? repair.job : isTaskReply(repair) ? tasks.get(repair.taskId)?.job : undefined;
    if (continued_as) supersedeTask(id, `continued as repair job ${continued_as}`);
    return { ...repair, continuation: 'repair' as const, ...(continued_as ? { continued_as } : {}) };
  }
  const agent = primary(current.job);
  // A working pi or CLI job queues the message (the worker takes it after its current step); a settled one
  // continues in its idle grace when the role allows (owner, 2026-11-11).
  const queued = !land && ['working', 'waiting_helper', 'waiting_orchestrator'].includes(state);
  const readReport = row.report_mtime !== null && !row.report_unread;
  if (
    current.bro ||
    current.jev ||
    !agent ||
    !(queued || (!workingOnly && state === 'idle_grace' && !readReport && registry(roleCwd(current)).roles().get(current.role)?.can_continue))
  )
    return { ok: false, code: 'not_continuable' };
  const oldTask = activeTasks.get(id);
  if (oldTask) sampleTask(oldTask);
  const carryTask = oldTask && !land && activeTasks.get(id) === oldTask && oldTask.view.status === 'working'
    ? oldTask : undefined;
  // Record the attempt first. A fresh derived send needs its own key for CLI turn tracking.
  const key = explicitKey ?? `${matchKey}:${randomBytes(8).toString('hex')}`;
  const recorded_at = new Date().toISOString();
  const outcome = { key, ...(explicitKey === undefined ? { derived_key: matchKey } : {}), recorded_at,
    exit_code: null as number | null, stderr_tail: '' };
  current.land_turn = land ? key : undefined;
  (current.send_outcomes ??= []).push(outcome);
  if (!current.cli) current.pi_sent_at = recorded_at;
  save(current);
  // Read the rollback baseline at mutation time, with no pane query between it and the write.
  const prior = current.cli ? readTurn(dir) : null;
  const turn = current.cli ? writeTurn(dir, { send: { key, pid: process.pid, start: procStat(process.pid)?.start ?? null } }) : null;
  const taskEntry = taskClient && !workingOnly && !land && !carryTask
    ? beginTask(current, row.report_mtime, undefined, row, statusAt) : undefined;
  const result = await run('herdr', ['agent', 'prompt', agent, turn ? withDonePrompt(message, bundled, dir, turn, current.cli!.agent) : message]);
  if (turn && refusedBeforeInput(result)) {
    const active = readTurn(dir);
    if (active?.seq === turn.seq && active.send?.key === key && active.send.pid === process.pid) {
      if (prior) saveTurn(dir, prior);
      else fs.unlinkSync(join(dir, jobFiles.turn));
    }
  }
  const latest = findJobMutable(id) ?? current;
  const attempted = latest.send_outcomes?.find((attempt) => attempt.key === key) ?? outcome;
  attempted.exit_code = result.exit_code;
  attempted.stderr_tail = result.stderr;
  save(latest);
  if (!taskClient && result.exit_code === 0) void ensureQueueWatcher(process.env.HERDR_PANE_ID, hudHome);
  if (result.exit_code === 0 && current.cli) {
    const supPid = supervisorPid(dir, status);
    if (
      supPid &&
      !supervisorAlive(supPid) &&
      workerAlive(
        typeof status?.pid === 'number' ? status.pid : null,
        typeof status?.pid_start_time === 'string' ? status.pid_start_time : null
      ) === true
    ) {
      spawnCliSupervisor(dir);
    }
  }
  const ok = result.exit_code === 0;
  if (carryTask && activeTasks.get(id) === carryTask) {
    // Follow only this send's fence; a failed send can advance it only for a CLI prompt that may have reached the worker.
    const fence = taskFence(latest);
    if (fence === (turn ? turnToken(turn) : key)) {
      carryTask.fence = fence;
      carryTask.reportBefore = row.report_mtime;
      carryTask.attentionBefore = needsAttention(row) ? (statusAt ?? undefined) : undefined;
      if (ok) extendTask(carryTask, latest);
      else persistTask(carryTask);
    }
    if (!ok) {
      if (batchTasks.get(id) === carryTask) claimTask(carryTask, latest);
      else if (sampleTask(carryTask).status === 'working') claimTask(carryTask, latest);
    }
  }
  if (batch) {
    registerBatchTask(taskEntry, latest, ok);
  } else {
    const response = finishTask(taskEntry, latest, ok);
    if (response) return response;
  }
  if (!ok && oldTask && !carryTask && sampleTask(oldTask).status === 'working') claimTask(oldTask, latest);
  return {
    ...(ok ? {} : { code: 'send_failed' }),
    ok, sent: ok,
    ...(queued ? { queued: true } : {}),
    exit_code: result.exit_code,
    stderr_tail: result.stderr,
  };
}

/** Detached land helper only: repair the existing branch, without widening public retry_of eligibility. */
export async function dispatchLandRepair(id: string, cwd: string, task: string, key: string, pane: string | null) {
  const source = findJob(id);
  if (!source || source.cwd !== cwd) throw Error('Repair source checkout changed');
  if (source.role === 'sonic') throw Error('Sonic cannot continue; dispatch a new query');
  const { row, status } = readRow(source, false);
  if (row.open_questions || !['idle_grace', 'done', 'closed'].includes(row.state ?? ''))
    throw Error(`Repair source needs attention: ${id}`);
  const deadline = typeof status?.idle_deadline_at === 'string' ? Date.parse(status.idle_deadline_at) : Infinity;
  if (closedReport(source, status) || (row.state === 'idle_grace' && Date.now() < deadline)) {
    const sent = await keyLock(`job:${id}`, () => sendJob(id, task, key, false, true));
    if ('sent' in sent && sent.sent) return id;
    if (!('code' in sent) || sent.code !== 'not_continuable') { releaseLandTurn(id, key); throw Error(`Repair send failed: ${id}`); }
  }
  const args = { ...jobOptions(source), cwd: sharedRoot(cwd), isolation: 'none', retry_of: id, task, on: undefined };
  // A closed but successfully settled job isn't a public retry target. Use the same keyed create path,
  // retaining retry provenance and the original checkout rather than starting at a clean main tip.
  const result = await keyLock(`request:${key}`, () => dispatchWithKey(args, pane ?? source.herdr_pane, key, false,
    undefined, undefined, { retry_of: id }, { landCwd: cwd }));
  if ('job' in result && result.job && !('ok' in result && result.ok === false)) return result.job;
  throw Error(`Could not dispatch landing repair: ${'code' in result ? result.code : 'no job'}`);
}

export function releaseLandTurn(id: string, key: string) {
  const job = findJobMutable(id);
  if (job?.land_turn === key) { delete job.land_turn; save(job); }
}

function itemError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, code: message.startsWith('invalid_arguments') ? 'invalid_arguments' : 'tool_error', error: message };
}

async function sendJobs(args: Args) {
  if (args.messages !== undefined) {
    if (args.job !== undefined || args.jobs !== undefined || args.text !== undefined || args.message_key !== undefined ||
        !Array.isArray(args.messages) || !args.messages.length) throw new Error('invalid_arguments: messages');
    const messages = await Promise.all(args.messages.map(async (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return { ok: false, code: 'invalid_arguments', error: 'invalid_arguments: messages' };
      const item = raw as Args;
      const jobId = typeof item.job === 'string' ? item.job : undefined;
      try {
        const id = required(item, 'job');
        const message = required(item, 'text');
        const key = item.message_key === undefined ? undefined : required(item, 'message_key');
        return { job: id, ...await keyLock(`job:${id}`, () => sendJob(id, message, key, false, false, true)) };
      } catch (error) {
        return { ...(jobId ? { job: jobId } : {}), ...itemError(error) };
      }
    }));
    return { messages };
  }
  const text = required(args, 'text');
  const key = args.message_key === undefined ? undefined : required(args, 'message_key');
  const send = (id: string, workingOnly: boolean) => keyLock(`job:${id}`, () => sendJob(id, text, key, workingOnly));
  if (args.jobs === undefined) return send(required(args, 'job'), false);
  if (args.job !== undefined || !Array.isArray(args.jobs) || !args.jobs.length ||
      args.jobs.some((id) => typeof id !== 'string' || !id)) throw new Error('invalid_arguments: jobs');
  const results = await Promise.all([...new Set<string>(args.jobs)].map(async (job) => ({ job, result: await send(job, true) })));
  const sent: string[] = [], skipped: { job: string; reason: string }[] = [];
  for (const { job, result } of results) {
    if ('sent' in result && result.sent) sent.push(job);
    else skipped.push({ job, reason: ('code' in result && result.code) || 'already_sent' });
  }
  return { sent, skipped };
}

async function call(name: string, args: Args, scan: JobScan): Promise<unknown> {
  if (name === 'hud_land') {
    const id = required(args, 'job'), job = findJob(id);
    const flow = await startLand(hudHome, id, job, job ? readRow(job).row.state : null, callerPane, taskClient);
    ensureWatcher();
    if (taskClient) {
      rememberLandTask(landTasks, flow.flow, landActive);
      saveTaskReceipt({ id: flow.flow, expiresAt: Date.parse(flow.created_at) + TASK_TTL });
      return { resultType: 'task', ...landTask(hudHome, flow) };
    }
    if (callerPane) void ensureQueueWatcher(callerPane, hudHome);
    return landView(flow);
  }
  if (name === 'hud_lease') return takeLease(args, { home: hudHome, cwd: process.cwd(), holder: callerPane });
  if (name === 'hud_tickets') {
    if (ticketGuide(args)) return fs.readFileSync(join(bundled, '../../integrations/tickets/method.md'), 'utf8');
    const cwd = jobCwd(args);
    return args.op === 'ready' ? readyTickets(cwd, jobCache) : editTickets(cwd, args);
  }
  if (args.detail !== undefined && typeof args.detail !== 'boolean') throw new Error('invalid_arguments: detail');
  const detail = args.detail === true;
  if (name === 'hud_roster') {
    if (args.convention_version !== undefined && typeof args.convention_version !== 'string')
      throw new Error('invalid_arguments: convention_version');
    const found = registry(jobCwd(args));
    const { root, registered } = found.project();
    const project = { root, registered };
    const ignored = found.projectConfigIgnored();
    const invalid = found.invalid();
    const convention = found.convention();
    // Include the project and source. For a capped file, invalidate on changes beyond the returned prefix too.
    const stat = convention.truncated ? fs.statSync(convention.path, { bigint: true, throwIfNoEntry: false }) : undefined;
    const beyondCap = stat && `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const convention_version = createHash('sha256').update(JSON.stringify([project, convention, beyondCap])).digest('hex');
    const now = Date.now();
    let routing;
    try { routing = found.routing(now); }
    catch (error) {
      if (error instanceof HarnessSwitchError) return harnessSwitchFailure(error);
      throw error;
    }
    const roles = [...found.roles().values()].map((role) => {
      const assignment = found.assignment(role, now, undefined, routing);
      return detail ? assignment : compactAssignment(assignment);
    });
    if (!taskClient && !callerHarness && callerPane) rememberCallerHarness((await paneInfo(callerPane))?.agent);
    const watcherAlive = !taskClient && !!callerPane && watching(callerPane, hudHome);
    const unchanged = (args.convention_version ?? sentConventionVersion) === convention_version;
    if (!unchanged) sentConventionVersion = convention_version;
    return {
      roles,
      ...(detail || invalid.length ? { invalid } : {}),
      convention_version,
      ...(unchanged ? { convention_unchanged: true } : { convention }),
      project,
      ...(callerPane && !taskClient ? { watcher_alive: watcherAlive } : {}),
      hint: deliveryHint(watcherAlive),
      ...(ignored ? { project_config_ignored: ignored } : {}),
    };
  }
  if (name === 'hud_create') {
    if (args.jobs !== undefined) {
      if (taskClient) throw new Error('In a task session, send one hud_create per job as parallel calls; each gets its own MCP task.');
      if (!Array.isArray(args.jobs) || !args.jobs.length ||
          Object.keys(args).some((key) => key !== 'jobs' && args[key] !== undefined)) {
        throw new Error('invalid_arguments: jobs');
      }
      let gate = Promise.resolve();
      const results = await Promise.all(args.jobs.map(async (raw) => {
        const wait = gate;
        let release!: () => void;
        gate = new Promise<void>((resolve) => { release = resolve; });
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ('jobs' in raw && (raw as Args).jobs !== undefined)) {
          release();
          return { ok: false, code: 'invalid_arguments', error: 'invalid_arguments: jobs' };
        }
        try {
          return await dispatchJob(raw as Args, process.env.HERDR_PANE_ID, undefined, undefined, true, { wait, release });
        } catch (error) {
          return itemError(error);
        } finally {
          release();
        }
      }));
      if (sentCreateHint) return { jobs: results };
      sentCreateHint = true;
      const watcherAlive = !taskClient && !!callerPane && watching(callerPane, hudHome);
      return { jobs: results, hint: deliveryHint(watcherAlive) };
    }
    const result = await dispatchJob(args, process.env.HERDR_PANE_ID);
    if (sentCreateHint) return result;
    sentCreateHint = true;
    if (isTaskReply(result)) return { ...result, statusMessage: `${result.statusMessage} — ${deliveryHint(false)}` };
    const watcherAlive = !taskClient && ('watcher_alive' in result ? result.watcher_alive === true : !!callerPane && watching(callerPane, hudHome));
    // Tab placement or roster discovery may already know the harness; do not probe on the dispatch reply path.
    return { ...result, hint: deliveryHint(watcherAlive) };
  }
  if (name === 'hud_send') {
    ensureWatcher();
    return sendJobs(args);
  }
  if (name === 'hud_respond' && args.answers !== undefined) {
    if (args.job !== undefined || args.request_id !== undefined || args.answer !== undefined ||
        !Array.isArray(args.answers) || !args.answers.length) throw new Error('invalid_arguments: answers');
    const answers = await Promise.all(args.answers.map(async (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return { ok: false, code: 'invalid_arguments', error: 'invalid_arguments: answers' };
      const item = raw as Args;
      const jobId = typeof item.job === 'string' ? item.job : undefined;
      const reqId = typeof item.request_id === 'string' ? item.request_id : undefined;
      try {
        const id = required(item, 'job');
        const res = await keyLock(`job:${id}`, async () => respondJob(item, true));
        return { job: id, ...(reqId ? { request_id: reqId } : {}), ...res };
      } catch (error) {
        return { ...(jobId ? { job: jobId } : {}), ...(reqId ? { request_id: reqId } : {}), ...itemError(error) };
      }
    }));
    return { answers };
  }
  if (name === 'hud_wait') return waitJobs(args, scan);
  if (name === 'hud_read') {
    const { view } = args;
    if (view !== undefined) {
      if (view !== 'compact' && view !== 'recent') throw new Error('invalid_arguments: view');
      if (args.job !== undefined || args.jobs !== undefined) throw new Error('invalid_arguments: view is list-only');
    }
    if (args.mode !== undefined && args.mode !== 'digest' && args.mode !== 'full') throw new Error('invalid_arguments: mode');
    if (args.full !== undefined && typeof args.full !== 'boolean') throw new Error('invalid_arguments: full');
    if (args.wait_ms !== undefined && (typeof args.wait_ms !== 'number' || !Number.isFinite(args.wait_ms)))
      throw new Error('invalid_arguments: wait_ms');
    ensureJobWatcher(hudHome, () => scan.watcherNeeded(Number(args.wait_ms) > 0));
    if (args.jobs !== undefined) {
      if (args.job !== undefined || !Array.isArray(args.jobs) || !args.jobs.length) throw new Error('invalid_arguments: jobs');
      return { jobs: await Promise.all(args.jobs.map(async (job) => {
        try { return { job, ...await callJob(name, { ...args, job }, detail, scan) }; }
        catch (error) { return { job, ok: false, code: 'tool_error', error: String(error) }; }
      })) };
    }
    if (args.job === undefined) {
      if (args.mode !== undefined) throw new Error('invalid_arguments: mode requires job or jobs');
      if (args.detail !== undefined) throw new Error('invalid_arguments: detail requires job');
      return listJobs(view === 'recent', scan);
    }
  }
  if (!tools.some((tool) => tool.name === name)) throw new Error('unknown_tool');
  return callJob(name, args, detail, scan);
}

async function callJob(name: string, args: Args, detail: boolean, scan: JobScan) {
  const id = required(args, 'job');
  if (name === 'hud_read' && isFlowId(id)) {
    const flow = readLand(hudHome, id);
    return flow ? landView(flow) : { ok: false, code: 'flow_not_found' };
  }
  const job = findJob(id);
  if (!job) return { ok: false, code: 'job_not_found' };
  if (name === 'hud_peek') return job.job === id ? peekJob(job, args, scan) : { ok: false, code: 'job_not_found' };
  const dir = directory(job.job);
  if (name === 'hud_read') {
    const full = args.mode === 'full' || (args.mode === undefined && args.full === true);
    const waitMs = Math.max(0, Math.min(120000, (args.wait_ms as number | undefined) ?? 0));
    let initial: JobRow | undefined;
    const isReady = (row: JobRow) =>
      settled(row.state) ||
      row.state === 'waiting_orchestrator' ||
      row.blocked ||
      row.open_questions > 0 ||
      (initial !== undefined && jobChanges([initial], [row]).length > 0);
    let summary: GitSummary | undefined;
    let firstCheck = true;
    return waitUntilFs({
      targets: () => jobWatchTargets(dir),
      timeoutMs: waitMs,
      isTransientError: (error) => error instanceof SyntaxError,
      check: async ({ timedOut }) => {
        const polledJob = firstCheck ? job : (findJob(job.job) ?? job);
        firstCheck = false;
        let polled = readRow(polledJob, !isWorker, null);
        initial ??= polled.row;
        if (!timedOut && !isReady(polled.row)) return { done: false };
        const obsJob = polled.job;
        const wt = obsJob.worktree;
        // Only probe once per read, even if a concurrent answer or continuation resumes the wait.
        if (wt && summary === undefined) {
          summary = await gitSummary(wt, () => scan.all()
            .flatMap((other) => other.job !== obsJob.job && other.worktree?.main_root === wt.main_root &&
              other.worktree.root !== wt.root && !other.worktree_removed_at
              ? [{ job: other.job, worktree: other.worktree, created_at: other.created_at }] : [])
            .sort((a, b) => b.created_at.localeCompare(a.created_at)));
          // Async gitSummary yielded; re-read job and status fresh before observing.
          polled = readRow(findJob(job.job) ?? obsJob, !isWorker, null);
          // The fresh read disagrees with the quick one (answered or continued meanwhile): wait, never spin.
          if (!timedOut && !isReady(polled.row)) return { done: false, minDelayMs: 50 };
        }
        if (polled.row.state === 'queued') polled.row.queue_position = scan.position(job.job);
        const { value: result, row: currentRow } = observation(polled.job, full, detail, summary, polled);
        const collected = ('report' in result || 'digest' in result) && result.report_exists;
        const observed = result.blocked || failedAttempt(currentRow);
        if (!isWorker && (collected || observed)) {
          const latest = findJobMutable(job.job)!;
          const at = new Date().toISOString();
          if (collected) latest.read_at = at;
          if (observed) latest.observed_at = at;
          save(latest);
        }
        return { done: true, value: result };
      },
    });
  }
  if (name === 'hud_respond') return respondJob(args, false, scan.summaryJobs());
  return closeJob(job);
}

export async function resumePanelAnswer(home: string, job: string, request_id: string, answer: string): Promise<AnswerResult> {
  if (resolve(home) !== hudHome) return { ok: false, reason: 'job belongs to another HUD home' };
  const result = await keyLock(`job:${job}`, () => respondJob({ job, request_id, answer }, false));
  return 'code' in result && result.code ? { ok: false, reason: result.code } :
    { ok: true, written: 'written' in result ? result.written === true : true };
}

async function respondJob(args: Args, batch: boolean, loadedJobs?: readonly Job[]) {
  const id = required(args, 'job');
  const job = findJob(id);
  if (!job) return { ok: false, code: 'job_not_found' };
  const dir = directory(job.job);
  const request = required(args, 'request_id');
  if (!/^q\d+$/.test(request)) throw new Error('invalid_arguments: request_id');
  const answer = required(args, 'answer');
  ensureWatcher();
  fs.mkdirSync(join(dir, jobFiles.qa), { recursive: true, mode: 0o700 });
  if (job.headless && job.role !== 'sonic') {
    if (fs.existsSync(join(dir, jobFiles.qa, `${request}.answer.md`))) return { ok: true, written: false };
    if (!jobCache.readQa(dir).openIds.includes(request)) return { ok: false, code: 'question_not_open' };
    // The question is visible before pi has flushed its session and the watcher has reaped this turn.
    const status = await waitUntilFs({ targets: [{ dir }], timeoutMs: 30_000, check: ({ timedOut }) => {
      const fresh = readCachedStatus(id).status;
      return fresh?.state !== 'working' || timedOut ? { done: true, value: fresh } : { done: false };
    } });
    if (status?.state !== 'waiting_orchestrator') return { ok: false, code: 'worker_not_waiting' };
    const key = `answer:${request}`;
    return await resumeJob(job, status, readRow(job, false).row, answer, key, key, false, batch, request) ??
      { ok: false, code: 'resume_failed' };
  }
  const oldTask = activeTasks.get(id);
  const polled = taskClient ? readRow(job, false) : undefined;
  const row = polled?.row;
  const state = row?.state ?? row?.display_state;
  const canCarry = !!oldTask && oldTask.view.status === 'working' &&
    job.herdr_pane === oldTask.pane && taskFence(job) === oldTask.fence &&
    state !== 'failed' && state !== 'stopped' && !fs.existsSync(join(dir, jobFiles.stopRequested));
  if (oldTask && !canCarry) sampleTask(oldTask);
  const task = !canCarry && row?.question_ids.includes(request)
    ? beginTask(job, oldTask?.reportBefore, request, row, polled?.statusAt) : undefined;
  try {
    writePrivateFile(join(dir, jobFiles.qa, `${request}.answer.md`), answer, { exclusive: true, mkdir: false });
    jobCache.invalidateQa(job.job);
    publishWorkSummary(loadedJobs);
    if (canCarry) {
      oldTask.seenQuestions.add(`${request}.md`);
      if (row && needsAttention(row)) oldTask.attentionBefore = polled?.statusAt ?? undefined;
      extendTask(oldTask, job);
      return { ok: true, written: true };
    }
    if (batch) {
      registerBatchTask(task, job, true);
      return { ok: true, written: true };
    }
    return finishTask(task, job, true) ?? { ok: true, written: true };
  } catch (error) {
    if (task) releaseTask(task);
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    jobCache.invalidateQa(job.job);
    return { ok: true, written: false };
  }
}

async function closeJob(job: Job, stop = false) {
  const scouting = pendingScouts.get(job.job);
  if (scouting) {
    scouting.abort();
    return { exit_code: 0, last_line: 'stopping scouted dispatch' };
  }
  const dir = directory(job.job);
  let { row, status } = readRow(job);
  if (row.state === 'queued' && !fs.existsSync(join(dir, jobFiles.session))) {
    let claimed = false;
    try {
      fs.writeFileSync(join(dir, QUEUE_START_MARKER), 'closed\n', { flag: 'wx', mode: 0o600 });
      claimed = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        jobCache.evictJob(job.job);
        cursor.delete(job.job);
        return { exit_code: 0, last_line: 'removed queued job', removed: true };
      }
      if (code !== 'EEXIST') throw error;
    }
    if (claimed) {
      const active = activeTasks.get(job.job);
      if (active) {
        batchTasks.delete(job.job);
        const msg = `${taskLabel(active, 'stopped')} — removed from queue`;
        updateTask(active, 'cancelled', msg, msg);
      }
      fs.rmSync(dir, { recursive: true, force: true });
      jobCache.evictJob(job.job);
      cursor.delete(job.job);
      return { exit_code: 0, last_line: 'removed queued job', removed: true };
    }
    // Watcher just claimed it to start; wait briefly for launch state before reaping.
    for (let i = 0; i < 40; i++) {
      await sleep(25);
      jobCache.invalidateJob(job.job);
      const refreshed = findJob(job.job);
      if (!refreshed) return { exit_code: 0, last_line: 'removed queued job', removed: true };
      job = refreshed;
      ({ row, status } = readRow(job));
      if (row.state !== 'queued' || fs.existsSync(join(dir, jobFiles.session))) break;
    }
  }
  if (job.headless) {
    const closed = await stopSonic(dir);
    publishWorkSummary();
    if (closed && !isWorker && readRow(job).row.display_state === 'failed')
      save({ ...(findJob(job.job) ?? job), observed_at: new Date().toISOString() });
    return { exit_code: closed ? 0 : 1, last_line: `${job.role} ${closed ? 'closed' : 'cleanup pending'}` };
  }
  const { result, complete, issue } = await reapWorkerTree(dir, status, () => {
    // Idle grace already finished: reap quits and the supervisor closes. A working job is stopped.
    if (row.state === 'idle_grace' && (stop || job.cli)) {
      try {
        fs.writeFileSync(join(dir, stop ? jobFiles.stopRequested : jobFiles.closeRequested), '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return runCommand('pi-role-reap', [dir], process.env, { budgetMs: 135_000 });
  }, (run) => run.ok);
  const statusFile = join(dir, jobFiles.status);
  const stoppingPi = !job.cli && !job.bro && !job.jev && fs.existsSync(join(dir, jobFiles.stopRequested));
  // Reaping can succeed even when Pi exited before its shutdown hook wrote STATUS.
  if (stoppingPi) {
    settleStoppedPi(statusFile, readCachedStatus(job.job).status);
    jobCache.invalidateFile(statusFile);
  }
  publishWorkSummary();
  if (issue || stoppingPi) ensureWatcher();
  if (!isWorker && complete && row.display_state === 'failed') {
    const latest = findJob(job.job) ?? job;
    save({ ...latest, observed_at: new Date().toISOString() });
  }
  return {
    exit_code: complete ? 0 : result.exitCode || 1,
    last_line: issue ?? (result.reason === 'timeout' ? 'pi-role-reap timed out' :
      (result.stdout.trim() || result.stderr.trim()).split('\n').at(-1) ?? ''),
  };
}

const callerPane = herdrId(process.env.HERDR_PANE_ID) ? process.env.HERDR_PANE_ID! : null;
let callerHarness: 'agy' | 'claude' | 'codex' | 'pi' | undefined;
let sentConventionVersion: string | undefined;
let sentCreateHint = false;
let discovered = false, taskClient = false, agyClient = false;
function rememberCallerHarness(agent: unknown): void {
  if (!callerHarness && (agent === 'agy' || agent === 'claude' || agent === 'codex' || agent === 'pi')) callerHarness = agent;
}
function deliveryHint(watcherAlive: boolean): string {
  if (taskClient) return 'Worker-turn events arrive as MCP task completions; owner panel decisions arrive without hud watch. Use `hud_read` to collect reports and check jobs without a task.';
  const fallback = 'Without live delivery, questions may be typed; use `hud_wait` for settlement or attention.';
  const live = 'Keep working until notified, then collect reports with `hud_read`.';
  switch (callerHarness) {
    case 'agy':
      return watcherAlive
        ? `Antigravity: the PreInvocation hook delivers events while working; herdr types them when idle. ${live}`
        : 'Antigravity: no live watch. Use `hud_wait` for settlement or attention.';
    case 'claude':
      return `Claude Code: ${watcherAlive ? '`hud watch` is live under Monitor' : 'run `hud watch` under Monitor'}; re-arm after expiry. ${live}`;
    case 'codex':
      return 'Codex: events are queued automatically; no Monitor is needed. Missing thread ID or queue failure falls back to typing.';
    case 'pi':
      return watcherAlive
        ? `pi: native HUD notices wake an idle session or arrive before the next model request, without touching drafts. ${live}`
        : `pi: the native HUD watch is not active. ${fallback}`;
    default:
      return watcherAlive ? `HUD watch is live. ${live}` : fallback;
  }
}
let createdJobs = new Set<string>();
const trackCreatedJob = (id: string) => rememberCreatedJob(createdJobs, id, (jobId) => !!findJob(jobId));
const landActive = (id: string) => { const flow = readLand(hudHome, id); return !!flow && activeLand(flow); };
async function adoptSessionJobs(scan: JobScan) {
  if (!callerPane) return false;
  const receipts = scan.all(), cwd = process.cwd();
  const onAdopt = (id: string) => {
    const job = findJob(id);
    if (job) scan.record(job);
  };
  if (!await adoptProjectJobs(hudHome, callerPane, cwd, receipts, process.env,
    adoptionAttention(hudHome, receipts, cwd, jobCache), jobCache, onAdopt)) return false;
  scan.invalidateSummary();
  if (!taskClient) void ensureQueueWatcher(callerPane, hudHome);
  return true;
}
function ownsJob(job: Job) {
  return !job.scout_only && (callerPane ? job.herdr_pane === callerPane : createdJobs.has(job.job));
}
function sessionJobs(scan: JobScan) {
  const own = scan.all().filter(ownsJob);
  return own.length ? own.filter(projectJobFilter(process.cwd())) : own;
}
function sessionRows(markExhaustion: boolean, scan = scanForCall()): JobRow[] {
  return sessionJobs(scan)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.job.localeCompare(b.job))
    .slice(0, 200)
    .map((job) => {
      const { row } = readRow(job, markExhaustion, scan);
      const reportMeta = jobRowReportMeta(row, directory(job.job));
      return reportMeta ? { ...row, report_meta: reportMeta } : row;
    });
}
let cursor = new Map<string, JobRow>();
const tries = new TryLog(hudHome), answers = new PanelActionLog(hudHome);
let ownerDelivery: ReturnType<typeof panelDelivery> | undefined;
async function syncPanelDelivery() {
  if (taskClient && !resumeRefusal) {
    if (!ownerDelivery) {
      const cwd = process.cwd(), matches = projectJobFilter(cwd);
      ownerDelivery = panelDelivery(hudHome, callerPane, cwd, id => {
        const job = findJob(id);
        return !!job && ownsJob(job) && matches(job);
      }, async message => (await notify(callerPane, message, hudHome)).status === 0);
    }
    ensureBatchTimer();
  } else {
    const old = ownerDelivery;
    ownerDelivery = undefined;
    await old?.stop();
    await stopBatchDelivery(true);
  }
}
async function withChanges(value: unknown, markExhaustion: boolean, scan: JobScan): Promise<unknown> {
  // Snapshot, diff and advance the shared cursors synchronously, in response order.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (taskClient) {
    const changes = [...(await ownerDelivery?.changes() ?? []), ...(await drainBatchChanges())];
    return changes.length ? { ...value, changes } : value;
  }
  const rows = sessionRows(markExhaustion, scan);
  const changes = [...jobChanges(cursor, rows), ...tries.changes(process.cwd()), ...answers.changes(new Set(rows.map((row) => row.job)), process.cwd()), ...landEvents(hudHome, callerPane).lines];
  cursor = new Map(rows.map((row) => [row.job, row]));
  return changes.length ? { ...(value as Record<string, unknown>), changes } : value;
}

// Only calls touching the same request key or job wait on one another.
const locks = new Map<string, Promise<unknown>>();
async function keyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}
function mutationKey(name: string, args: Args): string | null {
  if (name === 'hud_tickets' && !ticketGuide(args) && args.op !== 'ready')
    return isWorker ? 'tickets' : `tickets:${fs.realpathSync(jobCwd(args))}`;
  if (name === 'hud_respond' && args.answers !== undefined) return null;
  if (name !== 'hud_respond' && name !== 'hud_close') return null;
  const id = args.job;
  // Leave validation to the tool, without making invalid calls wait for one another.
  if (typeof id !== 'string' || !id) return `invalid:${randomBytes(8).toString('hex')}`;
  return `job:${id}`;
}
const TASK_EXTENSION = 'io.modelcontextprotocol/tasks';
const TASK_TTL = 3 * 60 * 60_000;
const TASK_POLL_MS = 5000;
const privateCache = { ttlMs: 0, cacheScope: 'private' } as const;
const taskContent = (text: string) => ({ content: [{ type: 'text', text }] });
type TaskStatus = BatchNotice['status'];
type TaskView = { status: TaskStatus; statusMessage: string; lastUpdatedAt: string; result?: ReturnType<typeof taskContent> };
type HudTask = {
  id: string; job: string; role: string; pane: string; createdAt: string; fence?: string;
  reportBefore: number | null; seenQuestions: Set<string>; view: TaskView; attentionBefore?: number;
  expiresAt?: number; ttlMs?: number; recovered?: true;
};
let tasks = new Map<string, HudTask>(), activeTasks = new Map<string, HudTask>();

type TaskReceipt = { id: string; expiresAt: number };
type JobTaskReceipt = TaskReceipt & Omit<HudTask, 'seenQuestions'> & { seenQuestions: string[] };
const taskRoot = join(hudHome, 'mcp-tasks');
const jobTaskId = /^j[0-9a-f]{16}:[0-9a-f]{16}$/;
const nativeCaller = process.env.CLAUDE_CODE_SESSION_ID || null;
// Scope receipts to the reconnecting caller, including predictable land IDs. Do not store the native session ID.
const taskCaller = createHash('sha256').update(JSON.stringify([
  callerPane, nativeCaller, callerPane || nativeCaller ? null : process.cwd(),
])).digest('hex').slice(0, 32);
const taskFile = (id: string) => join(taskRoot, `${id}.${taskCaller}.json`);
function saveTaskReceipt(receipt: TaskReceipt | JobTaskReceipt) {
  try { writeJsonPrivate(taskFile(receipt.id), receipt); } catch { /* Live tasks still work without disk recovery. */ }
}
function persistTask(task: HudTask) {
  // Batch notices have no client task ID and stay tied to their live connection.
  if (!tasks.has(task.id) || task.expiresAt === undefined) return;
  saveTaskReceipt({ ...task, expiresAt: task.expiresAt, seenQuestions: [...task.seenQuestions] });
}
function loadTaskReceipt(id: string): TaskReceipt | JobTaskReceipt | undefined {
  if (!jobTaskId.test(id) && !isFlowId(id)) return;
  try {
    const receipt = readJsonBounded(taskFile(id), 1024 * 1024) as TaskReceipt | JobTaskReceipt;
    if (receipt.id !== id || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= Date.now()) return;
    if (jobTaskId.test(id) && (!('job' in receipt) || receipt.job !== id.split(':')[0] ||
      typeof receipt.createdAt !== 'string' || !Array.isArray(receipt.seenQuestions) || !receipt.view)) return;
    return receipt;
  } catch { /* Missing, damaged or unreadable receipts are unknown tasks. */ }
}
let taskSweep: NodeJS.Timeout | undefined;
function sweepTaskReceipts(): string[] {
  const keep: string[] = [], cutoff = Date.now() - TASK_TTL;
  try {
    for (const file of readDirSafe(taskRoot)) {
      const match = /^([^.]+)\.([0-9a-f]{32})\.json(\.\d+\.[0-9a-f-]+\.tmp)?$/.exec(file);
      if (!match || (!jobTaskId.test(match[1]) && !isFlowId(match[1]))) continue;
      const path = join(taskRoot, file);
      try {
        // Age from the last write is only for cleanup; polling always checks expiresAt.
        if (fs.lstatSync(path).mtimeMs <= cutoff) fs.unlinkSync(path);
        else if (!match[3] && match[2] === taskCaller) keep.push(match[1]);
      } catch { /* The file may have disappeared during a concurrent sweep. */ }
    }
  } catch { /* Persistence is best-effort. */ }
  return keep;
}
function recoverTask(receipt: JobTaskReceipt): HudTask {
  const task: HudTask = { ...receipt, seenQuestions: new Set(receipt.seenQuestions), recovered: true };
  tasks.set(task.id, task);
  armExpiry(task);
  pruneTasks(tasks, Date.now(), evictTask);
  return task;
}
function resumeTaskReceipts() {
  if (taskSweep) return;
  const pending = sweepTaskReceipts().map(loadTaskReceipt).filter((entry): entry is JobTaskReceipt =>
    !!entry && 'job' in entry && entry.view.status === 'working');
  // Reattach active tasks even if the first call after reconnect is a follow-up instead of a poll.
  for (const entry of pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (tasks.size >= MAX_MCP_TASKS) break;
    if (tasks.has(entry.id) || activeTasks.has(entry.job)) continue;
    try {
      const job = findJob(entry.job);
      if (!job || job.herdr_pane !== entry.pane || taskFence(job) !== entry.fence ||
          (callerPane && taskDelivery(directory(entry.job), callerPane))) continue;
      const task = recoverTask(entry);
      activeTasks.set(task.job, task);
      claimTask(task, job);
    } catch { /* A broken job receipt must not prevent discovery. */ }
  }
  taskSweep = setInterval(sweepTaskReceipts, 60_000).unref();
}
type PendingBatchNotice = { job: string; fence: string; status: TaskStatus; text: string };
let batchTasks = new Map<string, HudTask>();
let batchPending = new Map<string, PendingBatchNotice>();
let batchTimer: NodeJS.Timeout | undefined;
let batchSending: Promise<void> | undefined;
let handedOff = false;
let landTasks = new Set<string>();
const expiry = new Map<string, NodeJS.Timeout>();
function disarmExpiry(id: string) {
  const timer = expiry.get(id);
  if (timer) { clearTimeout(timer); expiry.delete(id); }
}
function armExpiry(task: HudTask) {
  disarmExpiry(task.id);
  const timer = setTimeout(() => {
    if (expiry.get(task.id) !== timer) return;
    expiry.delete(task.id);
    tasks.delete(task.id);
    releaseTask(task);
  }, Math.max(0, task.expiresAt! - Date.now())).unref();
  expiry.set(task.id, timer);
}
function evictTask(task: HudTask) {
  disarmExpiry(task.id);
  releaseTask(task);
}
const markerFile = (task: HudTask) => join(directory(task.job), jobFiles.task);
function claimTask(task: HudTask, job: Job) {
  if (!callerPane || job.herdr_pane !== callerPane) return;
  try {
    writePrivateFile(markerFile(task), JSON.stringify({ id: task.id, pane: callerPane, pid: process.pid,
      start: procStat(process.pid)?.start, expires: task.expiresAt ?? (Date.parse(task.createdAt) + TASK_TTL) } satisfies McpTaskMarker), { mkdir: false });
  } catch { /* If not recorded, question delivery keeps its ordinary fallback. */ }
}
function extendTask(task: HudTask, job: Job) {
  const now = Date.now();
  task.expiresAt = now + TASK_TTL;
  task.ttlMs = Math.max(TASK_TTL, task.expiresAt - Date.parse(task.createdAt));
  if (tasks.has(task.id)) {
    tasks.delete(task.id);
    tasks.set(task.id, task);
    armExpiry(task);
  }
  persistTask(task);
  claimTask(task, job);
}
function supersedeTask(id: string, detail: string) {
  const oldTask = activeTasks.get(id);
  if (!oldTask || oldTask.view.status !== 'working') return;
  const message = `${taskLabel(oldTask, detail)}. Use hud_read for the job's current state.`;
  updateTask(oldTask, 'cancelled', message, message);
}
function releaseTask(task: HudTask) {
  if (activeTasks.get(task.job) === task) activeTasks.delete(task.job);
  try {
    const marker = json<McpTaskMarker>(markerFile(task));
    if (marker?.id === task.id && marker.pid === process.pid) fs.unlinkSync(markerFile(task));
  } catch { /* Stale delivery markers expire and cannot authorize cancellation. */ }
}
const questionFiles = (dir: string) => jobCache.readQa(dir).allQuestionFiles;
const taskLabel = (task: HudTask, state: string) => `${task.job} (${task.role}) — ${state}`;
const needsAttention = (row: JobRow) => row.blocked || row.state === 'blocked' || row.state === 'waiting_orchestrator';
function beginTask(job: Job, reportBefore: number | null = null, answer?: string, prior?: JobRow, priorStatusAt?: number | null): HudTask {
  const createdAt = new Date().toISOString(), dir = directory(job.job);
  const qa = jobCache.readQa(dir);
  const openSet = new Set(qa.openIds);
  const task: HudTask = {
    id: `${job.job}:${randomBytes(8).toString('hex')}`, job: job.job, role: job.role, pane: job.herdr_pane, createdAt,
    reportBefore,
    attentionBefore: prior && needsAttention(prior)
      ? (priorStatusAt !== undefined ? (priorStatusAt ?? undefined) : (readCachedStatus(job.job).at ?? undefined))
      : undefined,
    seenQuestions: new Set(qa.allQuestionFiles.filter((name) =>
      !answer || name === `${answer}.md` || !openSet.has(name.slice(0, -3)))),
    view: { status: 'working', statusMessage: `${job.job} (${job.role}) — working`, lastUpdatedAt: createdAt },
  };
  claimTask(task, job);
  return task;
}
function taskFence(job: Job) {
  const turn = job.cli ? readTurn(directory(job.job)) : null;
  if (turn) return turn.caller_token ?? turnToken(turn);
  const sends = job.send_outcomes ?? [];
  for (let i = sends.length - 1; i >= 0; i--) if (!sends[i].exit_code) return sends[i].key;
  return job.created_at;
}
function wireTask(task: HudTask) {
  return { taskId: task.id, createdAt: task.createdAt, ttlMs: task.ttlMs ?? TASK_TTL, pollIntervalMs: TASK_POLL_MS, ...task.view };
}
type TaskReply = ReturnType<typeof wireTask> & { resultType: 'task' };
const isTaskReply = (value: unknown): value is TaskReply =>
  !!value && typeof value === 'object' && 'resultType' in value && value.resultType === 'task';
function launchSummary(job: Job) {
  const facts = [job.used_place && `used_place: ${job.used_place}`, job.thinking && `thinking: ${job.thinking}`,
    job.thinking_source && `thinking_source: ${job.thinking_source}`, job.overflow_from && `overflowed from ${job.overflow_from}`,
    job.repair_of && `continued_as: ${job.job}`];
  if (job.attempts && job.attempts.length > 1) facts.push(`attempts: ${job.attempts.map(({ place, reason }) =>
    reason ? `${place} (${reason.replace(/\s+/g, ' ').slice(0, 160)})` : place).join(' → ')}`);
  return facts.filter(Boolean).join('; ');
}
function finishTask(task: HudTask | undefined, job: Job, ok: boolean, launch?: string): TaskReply | undefined {
  if (!task) return;
  if (!ok) { releaseTask(task); return; }
  task.fence = taskFence(job);
  if (launch) task.view.statusMessage += ` — ${launch}`;
  tasks.delete(task.id);
  tasks.set(task.id, task);
  activeTasks.set(task.job, task);
  task.expiresAt = Date.now() + TASK_TTL;
  armExpiry(task);
  pruneTasks(tasks, Date.now(), evictTask);
  persistTask(task);
  return { resultType: 'task', ...wireTask(task) };
}
function registerBatchTask(task: HudTask | undefined, job: Job, ok: boolean): void {
  if (!task) return;
  if (!ok) { releaseTask(task); return; }
  task.fence = taskFence(job);
  activeTasks.set(task.job, task);
  task.expiresAt = Date.now() + TASK_TTL;
  batchTasks.set(task.job, task);
  ensureBatchTimer();
}
function stopBatchTimerIfIdle() {
  if (!batchTasks.size && !batchPending.size && batchTimer) {
    clearInterval(batchTimer);
    batchTimer = undefined;
  }
}
function ensureBatchTimer() {
  if (!batchTimer && taskClient && !resumeRefusal && (batchTasks.size || batchPending.size)) {
    batchTimer = setInterval(() => { void pushBatchNotices(); }, 250).unref();
  }
}
function recordBatchNotice(item: PendingBatchNotice, taskId: string, via: 'push' | 'changes') {
  try {
    writePrivateFile(join(directory(item.job), jobFiles.batchNotice), JSON.stringify({
      task_id: taskId, fence: item.fence, status: item.status, delivered_at: new Date().toISOString(), via,
    } satisfies BatchNotice, null, 2) + '\n');
  } catch { /* Job directory gone or unreadable. */ }
}
function sampleBatchTasks() {
  const now = Date.now();
  for (const [id, task] of [...batchTasks.entries()]) {
    if (locks.has(`job:${id}`)) continue;
    if (task.expiresAt && now >= task.expiresAt) {
      batchTasks.delete(id);
      releaseTask(task);
      continue;
    }
    if (activeTasks.get(id) !== task) {
      batchTasks.delete(id);
      continue;
    }
    const job = findJob(id);
    if (!job || job.herdr_pane !== task.pane || taskFence(job) !== task.fence) {
      batchTasks.delete(id);
      releaseTask(task);
      continue;
    }
    const view = sampleTask(task);
    if (view.status === 'working') continue;
    batchTasks.delete(id);
    const text = view.result?.content[0]?.text ?? view.statusMessage;
    batchPending.set(task.id, { job: task.job, fence: task.fence ?? '', status: view.status, text });
  }
  stopBatchTimerIfIdle();
}
async function pushBatchNotices() {
  if (batchSending || !taskClient || resumeRefusal) return;
  sampleBatchTasks();
  if (!callerPane || !batchPending.size) return;
  const run = (async () => {
    for (const [id, item] of [...batchPending.entries()]) {
      if (!taskClient || resumeRefusal) break;
      try {
        if ((await notify(callerPane, item.text, hudHome)).status === 0) {
          batchPending.delete(id);
          recordBatchNotice(item, id, 'push');
        }
      } catch { /* Retry on next tick or deliver via withChanges. */ }
    }
  })().finally(() => {
    batchSending = undefined;
    stopBatchTimerIfIdle();
  });
  batchSending = run;
  await run;
}
async function drainBatchChanges(): Promise<string[]> {
  if (batchSending) await batchSending;
  sampleBatchTasks();
  if (!batchPending.size) return [];
  const lines: string[] = [];
  for (const [id, item] of [...batchPending.entries()]) {
    batchPending.delete(id);
    recordBatchNotice(item, id, 'changes');
    lines.push(item.text);
  }
  stopBatchTimerIfIdle();
  return lines;
}
async function stopBatchDelivery(releaseMarkers: boolean) {
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = undefined;
  }
  await batchSending;
  if (releaseMarkers) {
    for (const task of batchTasks.values()) releaseTask(task);
  }
  batchTasks.clear();
  batchPending.clear();
}
function updateTask(task: HudTask, status: TaskStatus, statusMessage: string, text?: string): TaskView {
  if (task.view.status !== status || task.view.statusMessage !== statusMessage) {
    task.view = { status, statusMessage, lastUpdatedAt: new Date().toISOString(), ...(text ? { result: taskContent(text) } : {}) };
    persistTask(task);
  }
  if (status !== 'working') releaseTask(task);
  return task.view;
}
// null means the current report is still awaiting its checks; a stale receipt never supplies an outcome.
function taskCheckOutcome(dir: string, job: Job, status: ReturnType<typeof readRow>['status']) {
  if (!job.checks?.length) return '';
  const binding = checkBinding(dir, { ...job }, status);
  if (!binding) return '\nChecks: unavailable';
  const receipt = readCheckReceipt(dir);
  const current = receipt && sameChecks(receipt, binding);
  if (current && receipt.state === 'done') {
    const passed = receipt.results.filter((result) => result.exit_code === 0).length;
    return `\nChecks: ${passed}/${job.checks.length} passed`;
  }
  // Bound a missing helper from declaration, or an interrupted run from its running receipt.
  // Allow one poll for the helper to publish the last command's timeout result.
  const started = current && fs.statSync(join(dir, CHECKS_FILE), { throwIfNoEntry: false })?.mtimeMs;
  const deadline = (started || Date.parse(status!.settled_at!)) + job.checks.length * CHECK_TIMEOUT_MS + TASK_POLL_MS;
  return Date.now() < deadline ? null : '\nChecks: result unavailable (timed out)';
}
function sampleTask(task: HudTask): TaskView {
  if (task.view.status !== 'working') return task.view;
  const job = findJob(task.job);
  if (!job || job.herdr_pane !== task.pane || taskFence(job) !== task.fence) {
    const reason = !job
      ? 'job no longer present'
      : job.herdr_pane !== task.pane
        ? `moved to pane ${job.herdr_pane}`
        : 'superseded by a newer turn';
    const message = `${taskLabel(task, reason)}. Use hud_read for the job's current state.`;
    return updateTask(task, 'cancelled', message, message);
  }
  if (job.role !== task.role) task.role = job.role;
  const dir = directory(job.job), { row, status, statusAt } = readRow(job, false);
  const state = row.state ?? row.display_state;
  if (state === 'queued') {
    const label = row.queue_position !== undefined ? `${taskLabel(task, 'queued')} (#${row.queue_position})` : taskLabel(task, 'queued');
    return updateTask(task, 'working', label);
  }
  const label = taskLabel(task, state);
  if (state === 'failed' || state === 'stopped' || fs.existsSync(join(dir, jobFiles.stopRequested))) {
    const stopped = state !== 'failed';
    const message = `${taskLabel(task, stopped ? 'stopped' : state)} — ${row.reason ?? (stopped ? 'stop requested' : 'worker failed')}`;
    return updateTask(task, stopped ? 'cancelled' : 'failed', message, message);
  }
  // An answer can arrive between polls (for example from the panel). That question still ended this task.
  const question = questionFiles(dir).find((name) => !task.seenQuestions.has(name));
  if (question) {
    const id = question.slice(0, -3), fields = questionFields(slice(join(dir, jobFiles.qa, question), 2048)?.text ?? '');
    const message = taskLabel(task, 'waiting_orchestrator');
    const choices = [...fields.options, ...(fields.suggested ? [`Default: ${fields.suggested}`] : [])];
    return updateTask(task, 'completed', `${message} — ${id}`, `${message}\nQuestion ${id}: ${fields.question}${choices.length ? `\n${choices.join(' | ')}` : ''}`);
  }
  // A send or answer may not have reached the worker when Claude first polls.
  if (!row.open_questions && needsAttention(row) &&
      (task.attentionBefore === undefined || (statusAt ?? undefined) !== task.attentionBefore)) {
    const message = `${taskLabel(task, row.blocked ? 'blocked' : state)} — ${row.reason ?? 'worker needs attention'}`;
    return updateTask(task, 'completed', message, `${message}. Use hud_read/hud_peek for details.`);
  }
  const report = join(dir, jobFiles.report);
  const currentSettlement = typeof status?.settled_at !== 'string' || status.settled_at >= task.createdAt;
  if (settled(state) && currentSettlement && row.report_mtime !== null && row.report_mtime !== task.reportBefore) {
    const outcome = taskCheckOutcome(dir, job, status);
    if (outcome === null) return updateTask(task, 'working', `${label} — awaiting checks`);
    const meta = jobRowReportMeta(row, dir);
    const summary = meta?.summary ?? fallbackResultLine(slice(report, RESULT_HEAD_BYTES)?.text ?? '');
    return updateTask(task, 'completed', `${label} — report ready`, `${label}\nReport: ${reportReadHint(task.job)}\nSummary: ${summary}${outcome}`);
  }
  if (state === 'closed' || state === 'done') {
    const message = `${label} — no report for this turn`;
    return updateTask(task, 'failed', message, message);
  }
  const progress = readJobProgress(dir).latest_progress;
  const message = (progress && progress.at >= task.createdAt ? progress.text : null) ?? row.reason;
  return updateTask(task, 'working', `${taskLabel(task, settled(state) ? 'working' : state)}${message ? ` — ${message}` : ''}`);
}
function unknownTask(taskId: string) {
  const now = new Date().toISOString(), statusMessage = 'Unknown or expired task. Use hud_read to find the job and collect its report.';
  return { taskId, status: 'failed', statusMessage, createdAt: now, lastUpdatedAt: now, ttlMs: TASK_TTL, pollIntervalMs: TASK_POLL_MS };
}
async function taskRequest(taskId: string, cancel: boolean) {
  if (isFlowId(taskId)) {
    const live = landTasks.has(taskId);
    if (!live && (cancel || !loadTaskReceipt(taskId))) return unknownTask(taskId);
    const flow = readLand(hudHome, taskId);
    if (!flow || Date.parse(flow.created_at) + TASK_TTL <= Date.now()) {
      landTasks.delete(taskId);
      return unknownTask(taskId);
    }
    if (live) { landTasks.delete(taskId); landTasks.add(taskId); }
    return landTask(hudHome, flow, cancel);
  }
  let task = tasks.get(taskId);
  if (!task && !cancel) {
    const receipt = loadTaskReceipt(taskId);
    if (receipt && 'job' in receipt) task = recoverTask(receipt);
  }
  // Disk recovery restores polling, not authority to stop a prior connection's work.
  if (!task || (cancel && task.recovered)) return unknownTask(taskId);
  const current = task;
  return keyLock(`job:${current.job}`, async () => {
    if (current.expiresAt !== undefined && current.expiresAt <= Date.now()) return unknownTask(taskId);
    if (sampleTask(current).status === 'working' && cancel) {
      const closed = await closeJob(findJob(current.job)!, true);
      const message = closed.exit_code === 0 ? taskLabel(current, 'stopped') : `${taskLabel(current, 'stop failed')} — ${closed.last_line}`;
      updateTask(current, closed.exit_code === 0 ? 'cancelled' : 'failed', message, message);
    }
    return wireTask(current);
  });
}
async function toolsListResult() {
  return {
    ...(discovered ? privateCache : {}),
    tools: resumeRefusal ? [] : worker ? await worker.listWorkerTools(true) :
      [...tools, statuslineTool].filter((tool) => !taskClient || tool.name !== 'hud_wait').map((tool) =>
        taskClient && ['hud_create', 'hud_send', 'hud_respond', 'hud_land'].includes(tool.name)
          ? { ...tool, execution: { taskSupport: 'optional' } } : tool),
  };
}
async function receive(line: string, write: (value: unknown) => void): Promise<void> {
  const rpcError = (id: unknown, code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } });
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    rpcError(null, -32700, 'Parse error');
    return;
  }
  if (
    !request ||
    request.jsonrpc !== '2.0' ||
    typeof request.method !== 'string' ||
    (request.id !== undefined && request.id !== null && !['string', 'number'].includes(typeof request.id))
  ) {
    rpcError(null, -32600, 'Invalid Request');
    return;
  }
  if (request.id === undefined) return; // Includes notifications/initialized.
  let result: unknown;
  switch (request.method) {
    case 'server/discover': {
      const meta = request.params?._meta;
      discovered = true;
      taskClient = !worker && !resumeRefusal && meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28' &&
        Object.hasOwn(meta?.['io.modelcontextprotocol/clientCapabilities']?.extensions ?? {}, TASK_EXTENSION);
      if (taskClient) resumeTaskReceipts();
      await syncPanelDelivery();
      result = { supportedVersions: ['2026-07-28'], ...privateCache,
        capabilities: { tools: { listChanged: true }, ...(!worker && !resumeRefusal ? { extensions: { [TASK_EXTENSION]: {} } } : {}) } };
      break;
    }
    case 'initialize':
      discovered = taskClient = false;
      await syncPanelDelivery();
      const clientName = request.params?.clientInfo?.name;
      agyClient = clientName === 'antigravity-client';
      if (agyClient) callerHarness = 'agy';
      if (clientName === 'hud-pi') callerHarness = 'pi';
      result = {
        protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: true }, resources: {} },
        serverInfo: { name: 'hud-mcp-thin', version: '0.1.4' },
        instructions: resumeRefusal ?? (worker ? 'Use the worker tools for your own HUD job. Finish with hud_report.' :
          'Call hud_roster when project dispatch context is missing or stale. With live watch, keep working until notified, then collect with hud_read.'),
      };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = await toolsListResult();
      break;
    case 'tasks/get':
    case 'tasks/cancel':
      if (!taskClient || resumeRefusal) { rpcError(request.id, -32601, 'Method not found'); return; }
      if (typeof request.params?.taskId !== 'string') { rpcError(request.id, -32602, 'Invalid task id'); return; }
      try {
        result = await taskRequest(request.params.taskId, request.method === 'tasks/cancel');
      } catch (error) {
        rpcError(request.id, -32603, String(error));
        return;
      }
      break;
    case 'resources/list':
      result = { resources: worker || resumeRefusal ? [] : [statuslineResource] };
      break;
    case 'resources/templates/list':
      result = { resourceTemplates: [] };
      break;
    case 'resources/read':
      if (typeof request.params?.uri !== 'string') {
        rpcError(request.id, -32602, 'Invalid resource URI');
        return;
      }
      if (worker || resumeRefusal || request.params.uri !== statuslineResource.uri) {
        rpcError(request.id, -32002, 'Resource not found');
        return;
      }
      result = readCodexStatusline(request.params._meta, hudHome, callerPane);
      break;
    case 'tools/call': {
      // Antigravity and Codex expose session identity only in tools/call metadata.
      const meta = request.params?._meta, turn = meta?.['x-codex-turn-metadata'];
      if (agyClient) checkResume('agy', meta?.['antigravity.google/conversation_id']);
      else checkResume('codex', meta?.threadId ?? turn?.thread_id ?? meta?.sessionId ?? turn?.session_id);
      if (resumeRefusal) {
        await syncPanelDelivery();
        result = { ...taskContent(resumeRefusal), isError: true };
        break;
      }
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
        rpcError(request.id, -32602, 'Invalid params');
        return;
      }
      if (worker) {
        if (!(await worker.workerTools(true)).some((tool: { name: string }) => tool.name === name)) {
          result = { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'worker_cannot_dispatch' }) }], isError: true };
        } else {
          try {
            const value = await worker.callWorkerTool(name, args);
            if (name === 'hud_ask' || name === 'hud_report' || name === 'hud_sonic') publishWorkSummary();
            result = { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
          } catch (error) {
            const code = error instanceof Error && 'code' in error && error.code === 'invalid_arguments'
              ? error.code : 'tool_error';
            result = { content: [{ type: 'text', text: JSON.stringify({ ok: false, code, error: String(error) }) }], isError: true };
          }
        }
        break;
      }
      if (name === statuslineTool.name) {
        result = { content: [{ type: 'text', text: `Codex statusline resource: ${statuslineResource.uri}` }] };
        break;
      }
      const scan = scanForCall();
      const invoke = () => writeScan.run(scan, () => call(name, args, scan));
      try {
        if (taskClient && name === 'hud_wait') throw new Error('unknown_tool');
        if (name !== 'hud_wait') await adoptSessionJobs(scan);
        const key = mutationKey(name, args);
        if (key !== null && locks.has(key)) scan.invalidateSummary();
        const value = key === null ? await invoke() : await keyLock(key, invoke);
        const markExhaustion = name !== 'hud_peek';
        if (isTaskReply(value)) {
          result = value;
        } else if (typeof value === 'string') {
          const content = [{ type: 'text', text: value }];
          const delta = await withChanges({}, markExhaustion, scan) as { changes?: unknown[] };
          if (delta.changes) content.push({ type: 'text', text: JSON.stringify(delta) });
          result = { content };
        } else {
          result = { content: [{ type: 'text', text: JSON.stringify(await withChanges(value, markExhaustion, scan)) }] };
        }
      } catch (error) {
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                code: 'tool_error',
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      } finally {
        scan.clear();
      }
      break;
    }
    default:
      rpcError(request.id, -32601, 'Method not found');
      return;
  }
  write({ jsonrpc: '2.0', id: request.id, result: discovered ? { resultType: 'complete', ...result as object } : result });
}
// Private live-connection handoff preserves state that disk recovery cannot, including cancellation authority.
async function snapshot() {
  const toolsList = JSON.stringify(await toolsListResult());
  handedOff = true;
  pruneCreatedJobs(createdJobs, (id) => !!findJob(id));
  pruneLandTasks(landTasks, landActive);
  pruneTasks(tasks, Date.now(), evictTask);
  return { version: 1, scoutedCreatePending: scoutedCreates.size > 0, toolsList, tasks, activeTasks, batchTasks, batchPending, landTasks, discovered, taskClient, agyClient, resumeChecked, resumeRefusal,
    callerHarness, sentConventionVersion, sentCreateHint, createdJobs, cursor, triesAt: tries.delivered, answersAt: answers.offset };
}
export function openRuntime() {
  return {
    snapshot,
    async start(state?: Awaited<ReturnType<typeof snapshot>>) {
      if (!state) {
        checkResume('claude', process.env.CLAUDE_CODE_SESSION_ID);
        if (!worker && !resumeRefusal) cursor = new Map(sessionRows(false).map((row) => [row.job, row]));
        return;
      }
      if (state.version !== 1) throw new Error('incompatible MCP session handoff');
      ({ tasks, activeTasks, landTasks, discovered, taskClient, agyClient, resumeChecked, resumeRefusal,
        callerHarness, sentConventionVersion, sentCreateHint, createdJobs, cursor } = state);
      batchTasks = state.batchTasks ?? new Map();
      batchPending = state.batchPending ?? new Map();
      tries.delivered = state.triesAt;
      answers.offset = state.answersAt;
      for (const task of tasks.values()) {
        armExpiry(task);
        // A live generation from before persistence may have issued this task.
        if (!loadTaskReceipt(task.id)) persistTask(task);
      }
      if (taskClient) {
        for (const id of landTasks) {
          if (loadTaskReceipt(id)) continue;
          try {
            const flow = readLand(hudHome, id), expiresAt = flow ? Date.parse(flow.created_at) + TASK_TTL : 0;
            if (expiresAt > Date.now()) saveTaskReceipt({ id, expiresAt });
          } catch { /* A broken flow receipt must not prevent reload. */ }
        }
        resumeTaskReceipts();
      }
      await syncPanelDelivery();
      return { toolsList: JSON.stringify(await toolsListResult()) };
    },
    async stop() {
      clearInterval(taskSweep);
      await ownerDelivery?.stop();
      await stopBatchDelivery(!handedOff);
      for (const scout of pendingScouts.values()) scout.abort();
      await Promise.allSettled([...scoutedCreates]);
      for (const timer of expiry.values()) clearTimeout(timer);
      expiry.clear(); tasks.clear(); activeTasks.clear(); landTasks.clear(); createdJobs.clear(); cursor?.clear();
    },
    async request(line: string) {
      let reply: unknown;
      await receive(line, (value) => { reply = value; });
      return reply;
    },
  };
}
