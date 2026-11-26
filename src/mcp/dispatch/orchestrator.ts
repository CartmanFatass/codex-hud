/** Job creation, queued launch, continuations, and landing repair. */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, join, isAbsolute, resolve, relative, sep } from 'node:path';
import { isCliDirTrusted, propagateCliTrust } from '../../cli/trust.js';
import { taskTarget } from '../../collectors/job-supersession.js';
import { objectiveLink } from '../../collectors/objectives.js';
import type { JobRow } from '../../collectors/thin-jobs.js';
import { isWorkingForCap, loadConcurrencySettings, capForRole, QUEUE_START_MARKER } from '../../roles/concurrency.js';
import { councilGrants } from '../../roles/council-grant.js';
import { wakeWorkflow } from '../../workflows/wake.js';
import { createCouncilRun } from '../council-state.js';
import { HarnessSwitchError } from '../../roles/harness-switches.js';
import { jobCallerPane } from '../../roles/job-pane.js';
import { herdrId } from '../../roles/herdr-run.js';
import { MAX_CHECKS, MAX_CHECK_COMMAND } from '../../roles/job-checks.js';
import { recordQuestionAnswer } from '../../roles/job-archive.js';
import { withAbstractLock } from '../../utils/abstract-lock.js';
import { watching, ensureQueueWatcher } from '../../roles/notify.js';
import { sharedRoot } from '../../roles/projects.js';
import { readReportMeta, validPreviewPath } from '../../roles/report-meta.js';
import { EXPERIMENT_TAG_MAX_LENGTH } from '../../roles/tool-definitions.js';
import {
  currentPreset, harnessDefaults, readExhausted, isQuotaFailure, markExhausted, describePlace, recordFailureExhaustion,
  type Role, type RolePlace,
} from '../../roles/roster.js';
import { loadSettings } from '../../settings.js';
import { writePrivateFile } from '../../utils/atomic-fs.js';
import { waitUntilFs } from '../../utils/fs-wait.js';
import { hostInline } from '../../workflows/inline.js';
import { reservePrewalk, drivePrewalk, type PrewalkRun, type ScoutSpec, type ScoutOutcome, type ReservedLaunch, type PrewalkInputs } from '../prewalk-flow.js';
import { waitChildReport } from './child-report.js';
import { prepareCouncil, type CouncilSeat } from './council.js';
import { procStat } from '../../utils/proc.js';
import {
  beginPrompt, cliWorkerTools, endPrompt, readTurn, saveTurn, REPORT_READ_EXIT, withDonePrompt, workerAlive, turnToken,
} from '../cli-judge.js';
import type { StandingBriefRef } from '../cli-worker-startup.js';
import { defaultImpRoute, impPlacementSettings, repairImpRoute, pickImpRoute } from '../imp-routing.js';
import { clearHeadlessSends, hasHeadlessSends, headlessFollowupReady, readHeadlessSends, writeHeadlessSends } from '../headless-sends.js';
import type {
  AnswerActor, Job, JobRoute, ManagedWorktree, LaunchAttempt, ResumeFailure, JobStatus, PrewalkEntry, PrewalkScoutKind, SendOutcome,
} from '../job-contracts.js';
import { launchThinking, nearestThinking } from '../launch-thinking.js';
import { isRunningListTicket, readFlakesConfig, runningListAdmission } from '../flake-admission.js';
import { routingTicketText, ticketObjective } from '../local-tickets.js';
import { reusableWorktree, planWorktree, addWorktree, populateWorktree } from '../managed-worktree.js';
import { callerPane, session, trackCreatedJob } from '../mcp/session-state.js';
import {
  beginTask, taskLabel, registerBatchTask, finishTask, activeTasks, taskFence, extendTask, launchSummary, poolPickSummary,
  persistTask, sampleTask, releaseTask, batchTasks, supersedeTask, isTaskReply, tasks, needsAttention,
  claimTask, type TaskReply, type HudTask,
} from '../mcp/tasks.js';
import { jobFiles } from '../paths.js';
import { sendHistory, piReportSettlement } from '../pi-read-settlement.js';
import { stopSonic } from '../sonic-process.js';
import { headlessSonicChildren } from '../../worker/sonic-jobs.js';
import { pickSonicThinking } from '../sonic-thinking.js';
import { pickRolePool } from '../pool-pick.js';
import { MAX_PREWALK_SCOUTS, PREWALK_SCOUT_KINDS, prewalkScoutTask, truncateScoutAsk, type PrewalkScoutRequest } from '../prewalk.js';
import {
  directory, readRow, hudHome, primary, jobs, readCachedStatus, findJob, save, bundled,
  writeCreateStatus, queuePositionsForJobs, jobCache, digestLine, publishWorkSummary, findJobMutable, slice,
} from '../store/job-store.js';
import { keyLock } from '../store/key-lock.js';
import { readTicketQueue } from '../ticket-queue-state.js';
import { DEFAULT_RESUME_S, resumeDeadline, resumeIdentity, closedReport, type NativeResume } from '../worker-resume.js';
import { jobCwd, required, readBriefFile, assembleContext, type Args } from './context.js';
import { cleanupDirectResume } from './direct-exec.js';
import { dispatchBro } from './harness-bro.js';
import { failCli, dispatchCli, supervisorPid, supervisorAlive, spawnCliSupervisor } from './harness-cli.js';
import { plainSkillName, dispatchPi } from './harness-pi.js';
import {
  piOptionKeys, placementOverrides, hasPiPlacement, roleCwd, registry, launchPlan, evenPlanner, harnessSwitchFailure,
  replayOptions, harnessesSourceFor, argsForPlace,
} from './places.js';
import { ensureWatcher, launchError, launchFailure, canTryNext, rejectLaunch, resolveWorkspace, run, refusedBeforeInput, type DispatchResult } from './proc.js';
import { SHELL_WORKER_UNSUPPORTED, herdrWorkerPreflight, isShellLaunchedWorker } from '../../runtime/herdr-socket.js';

function derivedKey(kind: string, ...parts: unknown[]): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}
const DERIVED_KEY_WINDOW_MS = 10 * 60_000;
function withinRetryWindow(recordedAt: string | undefined, now: number): boolean {
  const age = now - Date.parse(recordedAt ?? '');
  return age >= 0 && age < DERIVED_KEY_WINDOW_MS;
}

function created(job: Job, initialRow?: JobRow) {
  const task_dir = directory(job.job);
  const { report_unread: _unread, report_mtime: _mtime, question_ids: _questions, ...row } = initialRow ?? readRow(job).row;
  const watch = callerPane && !session.taskClient ? { watcher_alive: watching(callerPane, hudHome) } : {};
  const thinking = {
    ...(job.thinking == null ? {} : { thinking: job.thinking }),
    ...(job.thinking_source ? { thinking_source: job.thinking_source } : {}),
  };
  const poolEntry = job.prewalk?.find(entry => entry.kind === 'pool');
  const launch = { attempts: job.attempts, used_place: job.used_place ?? null, ...(job.headless && { mode: 'headless' }),
    ...(job.route && { route: job.route }), ...(job.prewalk && { prewalk: job.prewalk }),
    ...(poolEntry && { pick_summary: poolPickSummary(poolEntry) }) };
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

function countWorkingByRole(allJobs = jobs()): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of allJobs) {
    const status = readCachedStatus(item.job).status;
    if (!isWorkingForCap(item, status)) continue;
    counts.set(item.role, (counts.get(item.role) ?? 0) + 1);
  }
  return counts;
}

export function batchHasRoom(role: string, all = jobs(), cap = capForRole(loadConcurrencySettings(), role)) {
  let working = 0, members = 0;
  for (const j of all) if (j.role === role) {
    const status = readCachedStatus(j.job).status;
    if (status?.state === 'queued') return false;
    if (isWorkingForCap(j, status)) { working++; if (j.batch_flow) members++; }
    else if (j.batch_flow && status?.state === 'waiting_orchestrator') members++; // A headless answer resumes the same item.
  }
  return !cap || (working < cap && members < cap - 2);
}

function jobOptions(job: Job): Args {
  return {
    role: job.role, cwd: job.worktree?.main_root ?? job.cwd, package: job.package, ticket: job.ticket, slice: job.slice, preset: job.preset,
    experiment: job.experiment, arm: job.arm, preview: job.preview ?? readReportMeta(directory(job.job), false)?.preview?.source,
    context_files: job.context_files, from_jobs: job.from_jobs, checks: job.checks, instructions: job.instructions_from,
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

type SonicParent = Pick<Job, 'job' | 'cwd' | 'project_root' | 'worktree' | 'objective' | 'headless'>;
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

type BatchMember = { flow: string; route: JobRoute; canAdmit: () => boolean };
type SlotGate = { wait: Promise<void>; release: () => void };

export interface TicketDispatchInput {
  role: 'imp' | 'frontend-imp';
  cwd: string;
  ticket: string;
  brief_file: string;
  request_key: string;
}

export interface TicketDispatchOptions {
  queue?: { id: string; canAdmit: () => boolean };
  dispatcher?: Job['dispatcher'];
  workspace?: string;
  runNote?: string;
}

/** Queue-capable ticket admission shared by ticket queues (`hud_tickets run`) and automated ticket dispatch. */
export async function dispatchTicketJob(
  input: TicketDispatchInput,
  pane: string | undefined,
  options: TicketDispatchOptions = {},
) {
  const workspace = options.workspace ?? (pane ? await resolveWorkspace(pane) : undefined);
  return dispatchJob(
    { ...input, isolation: 'worktree' },
    pane,
    { ...options, workspace, ticketAdmission: true },
  );
}

export async function dispatchJob(input: Args, pane: string | undefined, { parent, repair, batch, slotGate, queue, member, dispatcher, workspace, runNote, ticketAdmission }: {
  parent?: SonicParent; repair?: { source: Job; derived: boolean }; batch?: boolean; slotGate?: SlotGate;
  queue?: { id: string; canAdmit: () => boolean }; member?: BatchMember; dispatcher?: Job['dispatcher'];
  workspace?: string; runNote?: string; ticketAdmission?: boolean;
} = {}) {
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
  if (!repair && role !== 'general') {
    const fields: string[] = parent ? [] : placementOverrides.filter(key => input[key] !== undefined);
    if (hasPiPlacement(input.pi_args)) fields.push('pi_args');
    const borrowsInstructions = input.instructions !== undefined;
    if (fields.length || borrowsInstructions) {
      const seat = `Role ${JSON.stringify(role)}`;
      const subject = fields.length ? `${seat} does not accept placement fields: ${fields.join(', ')}. It` : seat;
      const advice = fields.length
        ? `for per-job placement${borrowsInstructions ? ' and to borrow instructions' : ''}`
        : 'to borrow instructions for one job';
      return { ok: false, code: 'invalid_arguments', error: `${subject} runs as configured in its role file and Control; use general ${advice}.` };
    }
  }
  let args = input;
  let repairOf = repair?.source.job;
  let worktreeSource = repairOf ? continuationWorktreeSource(repairOf) : undefined;
  if (source) {
    const { row } = readRow(source);
    if (row.state !== 'failed' && row.state !== 'stopped') return { ok: false, code: 'not_retryable' };
    const inherited = jobOptions(source);
    if (role !== source.role) {
      for (const key of [...placementOverrides, 'instructions']) delete inherited[key];
      if (hasPiPlacement(inherited.pi_args)) delete inherited.pi_args;
    }
    // Keep the original harness with its pinned model; an explicit on still wins below.
    if (role !== 'general' || inherited.model === undefined || input.preset !== undefined || input.model !== undefined) {
      delete inherited.on;
    }
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
  if (runNote && typeof args.task === 'string') {
    args = { ...args, task: `${args.task.trimEnd()}\n\n${runNote}\n` };
  }
  // An explicit key can retrieve a prior job even when other arguments in the retry differ.
  const requestKey = args.request_key === undefined
    ? derivedKey(retryOf ? 'retry' : 'create', pane, role, cwd, required(args, 'task'), retryOf,
      ...(role === 'council' ? [args.members, args.synthesizer, args.context_files, args.from_jobs] : []))
    : required(args, 'request_key');
  const windowedKey = args.request_key === undefined || repair?.derived === true;
  return keyLock(`request:${requestKey}`, () =>
    dispatchWithKey(args, pane, requestKey, windowedKey, parent, repairOf, retryOf ? input : undefined, {
      worktreeSource, batch, slotGate, member, sourceJob: source ?? repair?.source,
      ticketQueue: queue?.id, ticketAdmission: Boolean(ticketAdmission || queue?.id),
      canAdmit: member?.canAdmit ?? queue?.canAdmit, dispatcher, workspace,
    }));
}

async function runOneScout(target: Job, spec: ScoutSpec, contextCwd: string, contextFiles: unknown,
  retiring: AbortSignal, requestKey: string, recovering: boolean, stopping: () => boolean): Promise<ScoutOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const ask = spec.ask ? { ask: spec.ask } : {};
  try {
    const prior = recovering && jobs().find(j => j.request_key === requestKey && j.parent_job === target.job);
    const result = prior ? { job: prior.job } : recovering ? { error: 'scout dispatch interrupted' } : await dispatchWithKey(
      { role: 'sonic', task: spec.question, cwd: target.cwd, ...(spec.includeContext ? { context_files: contextFiles } : {}) },
      jobCallerPane(target), requestKey, false, target, undefined, undefined,
      { scoutContextCwd: contextCwd, prewalkKind: spec.kind, dispatcher: target.dispatcher },
    );
    if (!('job' in result) || !result.job) {
      return {
        kind: spec.kind, source: spec.source, ...ask, ms: elapsed(),
        failure: ('reason' in result && result.reason) || ('error' in result && result.error) || ('code' in result && result.code) || 'could not launch',
      };
    }
    const id = result.job;
    const failure = prior && prior.dispatch_exit_code === null && !readCachedStatus(id).status ? 'scout dispatch interrupted' :
      await waitChildReport(id, child => stopSonic(directory(child.job)).catch(() => ensureWatcher()), { retiring, stopping });
    return { kind: spec.kind, source: spec.source, ...ask, id, failure,
      ms: prior ? Math.max(elapsed(), Date.now() - Date.parse(prior.created_at)) : elapsed() };
  } catch (error) {
    return { kind: spec.kind, source: spec.source, ...ask, failure: String(error), ms: elapsed() };
  }
}

export function runReservedPrewalk(id: string, host: PrewalkRun['host'], retiring: AbortSignal) {
  const base = findJobMutable(id)!;
  return drivePrewalk(id, host, retiring, {
    scouts: async ({ launch: { args, cwd, worktree, plan }, scouts }, recovering, stopping) => {
      if (worktree && !base.worktree && plan.candidates.some(({ candidate: { place }, prepared }) => !('code' in prepared) &&
          (place.harness === 'pi' || (place.harness === 'cli' && isCliDirTrusted(place.agent!, worktree.main_root))))) {
        await prepareWorktree(base, worktree);
      }
      if ((!recovering && stopping()) || (worktree && !base.worktree)) return [];
      return Promise.all(scouts.map((spec, i) => runOneScout(base, spec, cwd, args.context_files, retiring,
        `prewalk:${id}:${i}:${spec.kind}`, recovering, stopping)));
    },
    launch: (launch, outcomes) => keyLock(`job:${id}`, async () => {
      const args = { ...launch.args, task: originalTask(base) };
      await launchReservedJob(base, { ...launch, args }, outcomes);
    }),
    targetReceipt: () => findJob(id),
    failed: reason => finishLaunch(findJobMutable(id) ?? base, directory(id), { ...launchError(reason), preInput: true }, reason, false),
    stopped: () => {
      base.prewalk = base.prewalk?.map(entry => entry.kind === 'pool' ? entry : { ...entry, result: 'stopped' });
      save({ ...base, dispatch_exit_code: 1 });
      writeCreateStatus(directory(id), { state: 'stopped', exit_reason: 'scouted dispatch stopped', ended_at: new Date().toISOString() });
    },
  });
}

function startPrewalk(base: Job, host: 'watcher' | 'mcp', inputs: PrewalkInputs) {
  // The reserved brief holds the task. Persist only options consumed by the launch adapter.
  const options = (args: Args) => Object.fromEntries([...replayOptions, 'from_jobs'].filter(k => args[k] !== undefined).map(k => [k, args[k]]));
  const { launch, scouts } = inputs;
  reservePrewalk(base, host, { scouts, launch: { ...launch, args: options(launch.args), retryInput: launch.retryInput && options(launch.retryInput) } });
  return hostInline(base.job, retiring => runReservedPrewalk(base.job, host, retiring));
}

function callerScouts(requests: readonly PrewalkScoutRequest[], task: string): ScoutSpec[] {
  return requests.map(({ kind, ask }) => ({ kind, source: 'caller', ask: truncateScoutAsk(ask),
    question: prewalkScoutTask(kind, ask, task), includeContext: kind !== 'web' }));
}

function formatScoutNote(outcome: ScoutOutcome, reason: string): string {
  const clean = digestLine(reason.replace(/\s+/g, ' '), 300);
  return `Scout failed (${outcome.kind}): ${clean}`;
}

async function applyScoutOutcomes(
  args: Args,
  browser: boolean,
  initialContext: Awaited<ReturnType<typeof assembleContext>>,
  outcomes: readonly ScoutOutcome[],
  poolEntry: PrewalkEntry | undefined,
  contextFor: (targetArgs: Args, inline: boolean) => ReturnType<typeof assembleContext>,
) {
  let briefContext = initialContext;
  const entries: PrewalkEntry[] = poolEntry ? [poolEntry] : [];
  const notes: string[] = [];
  let attached = 0;
  for (const outcome of outcomes) {
    let attachFailure = outcome.failure;
    if (outcome.id && !attachFailure && !('code' in briefContext)) {
      const current = briefContext.metadata.from_jobs ?? [];
      if (current.length >= 16) attachFailure = 'from_jobs limit reached';
      else {
        const withScout = await contextFor({ ...args, from_jobs: [...current, outcome.id] }, browser);
        if ('code' in withScout) attachFailure = withScout.code === 'context_too_large' ? 'report exceeds the context limit' : 'report is unreadable';
        else { briefContext = withScout; attached++; }
      }
    }
    const ask = outcome.ask ? { ask: outcome.ask } : {};
    if (outcome.id && !attachFailure && !('code' in briefContext)) {
      entries.push({ kind: outcome.kind, source: outcome.source, ...ask, job: outcome.id, result: 'attached', ms: outcome.ms });
    } else {
      const result = 'failed';
      entries.push({ kind: outcome.kind, source: outcome.source, ...ask, ...(outcome.id && { job: outcome.id }), result, ms: outcome.ms });
      notes.push(formatScoutNote(outcome, attachFailure ?? result));
    }
  }
  const scoutState: Job['scout_state'] = attached > 0 ? 'done' : 'failed';
  const scoutError = scoutState === 'failed'
    ? digestLine(notes.join('; ').replace(/^Scout failed(?: \([^)]+\))?: /, ''), 120)
    : undefined;
  return { briefContext, entries, note: notes.length ? `${notes.join('\n')}\n\n` : '', scoutState, scoutError };
}

export function canOverflowImpJob(job: Job): boolean {
  if (job.role !== 'imp' || job.ticket_queue) return false;
  const cwd = roleCwd(job);
  const found = registry(cwd);
  const roles = found.roles();
  const imp = roles.get('imp');
  if (!imp || !roles.has('general') || (job.create_options?.mode === 'headless' && !imp.can_continue)) return false;
  if (!job.route && job.preset !== undefined && !imp.presets?.some((p) => p.name === job.preset)) return false;
  let routing;
  try { routing = found.routing(Date.now()); } catch { return false; }
  const onName = typeof job.create_options?.on === 'string' ? job.create_options.on : null;
  const defaults = onName ? harnessDefaults(hudHome, bundled) : null;
  const onEntry = onName ? defaults?.[onName] : undefined;
  if (onName && !onEntry) return false;
  const modelOverride = typeof job.create_options?.model === 'string' ? job.create_options.model : undefined;
  if (onEntry?.harness === 'bro' && modelOverride !== undefined) return false;
  const retryInput = job.retry_of ? { retry_of: job.retry_of, ...(job.create_options ?? {}) } : undefined;
  const first = launchPlan(found, imp, Date.now(), { ...jobOptions(job), role: 'general' }, routing, onEntry, retryInput, job.route).candidates[0];
  return !!first && !('code' in first.prepared);
}

function validExperimentTag(tag: unknown): tag is string | undefined {
  return tag === undefined || (typeof tag === 'string' && tag.length <= 2 * EXPERIMENT_TAG_MAX_LENGTH &&
    [...tag].length <= EXPERIMENT_TAG_MAX_LENGTH); // JSON Schema counts Unicode code points.
}

async function nextEvenLaunch(even: ReturnType<typeof evenPlanner>, job: Job, result: DispatchResult, reason: string) {
  // Only replay startup refusals: a worker that could have taken the brief is never relaunched here.
  if (!job.route || !job.place_key || !result.preInput || result.cleanupFailed || !isQuotaFailure(reason)) return;
  if (!readExhausted(hudHome).has(job.place_key)) markExhausted(hudHome, job.place_key, reason);
  return even(job.route, reason);
}

export async function dispatchCouncilSeat(parent: Job, seat: CouncilSeat, part: 'member' | 'synthesizer', args: Args, key: string, memberStarted: () => void) {
  const role = seat.place.harness === 'bro' ? 'pro' : 'general';
  const result = await dispatchWithKey({ ...args, role, cwd: parent.cwd, prewalk: false }, jobCallerPane(parent), key, false,
    parent, undefined, undefined, { dispatcher: parent.dispatcher, seat, council: { id: parent.job, part }, memberStarted: part === 'member' ? memberStarted : undefined });
  return 'job' in result ? { job: result.job } : { failure: [('code' in result && result.code), ('reason' in result && result.reason) || ('error' in result && result.error)].filter(Boolean).join(': ') || 'could not launch' };
}

async function dispatchWithKey(args: Args, pane: string | undefined, request_key: string, windowedKey: boolean,
  parent?: Pick<SonicParent, 'job' | 'objective' | 'headless'>, repairOf?: string, retryInput?: Args,
  { scoutContextCwd, prewalkKind, landCwd, worktreeSource, batch, slotGate, sourceJob, ticketQueue, ticketAdmission, member, canAdmit, dispatcher, seat, council, memberStarted, workspace }: {
    seat?: CouncilSeat; council?: Job['council']; memberStarted?: () => void;
    scoutContextCwd?: string; prewalkKind?: PrewalkScoutKind; landCwd?: string; worktreeSource?: Job; batch?: boolean; slotGate?: SlotGate; sourceJob?: Job;
    ticketQueue?: string; ticketAdmission?: boolean; member?: BatchMember; canAdmit?: () => boolean; dispatcher?: Job['dispatcher']; workspace?: string;
  } = {}) {
  const isTicketAdmission = Boolean(ticketAdmission || ticketQueue);
  const { experiment, arm, preview } = args;
  if (preview !== undefined && !validPreviewPath(preview)) {
    return { ok: false, code: 'invalid_arguments', error: 'preview must be a relative HTML path inside cwd' };
  }
  if (!validExperimentTag(experiment) || !validExperimentTag(arm)) {
    return { ok: false, code: 'invalid_arguments', error: `experiment and arm must each be a string of at most ${EXPERIMENT_TAG_MAX_LENGTH} characters` };
  }
  if (args.prewalk !== undefined && typeof args.prewalk !== 'boolean') {
    return { ok: false, code: 'invalid_arguments', error: 'prewalk must be a boolean' };
  }
  if (args.scout !== undefined) {
    return { ok: false, code: 'invalid_arguments', error: 'scout was replaced by scouts: [{kind: "code"|"docs"|"web", ask: "..."}]' };
  }
  let scoutsArg: PrewalkScoutRequest[] | undefined;
  if (args.scouts !== undefined) {
    if (!Array.isArray(args.scouts) || args.scouts.length > MAX_PREWALK_SCOUTS) {
      return { ok: false, code: 'invalid_arguments', error: `scouts must be an array of 0–${MAX_PREWALK_SCOUTS} {kind, ask} items` };
    }
    scoutsArg = [];
    for (const item of args.scouts) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, code: 'invalid_arguments', error: 'each scout must be an object with kind ("code"|"docs"|"web") and nonempty ask' };
      }
      const { kind, ask } = item as { kind?: unknown; ask?: unknown };
      if (typeof kind !== 'string' || !PREWALK_SCOUT_KINDS.includes(kind as PrewalkScoutKind) ||
          typeof ask !== 'string' || !ask.trim()) {
        return { ok: false, code: 'invalid_arguments', error: 'each scout must have kind ("code"|"docs"|"web") and a nonempty ask string' };
      }
      scoutsArg.push({ kind: kind as PrewalkScoutKind, ask: ask.trim() });
    }
  }
  if (args.prewalk === false && scoutsArg && scoutsArg.length > 0) {
    return { ok: false, code: 'invalid_arguments', error: 'prewalk: false and non-empty scouts are mutually exclusive' };
  }
  const asked = required(args, 'role');
  const cwd = jobCwd(args);
  const found = registry(cwd);
  // `architect` names oracle unless a role file defines its own architect.
  const configured = found.roles(true);
  const requestedRole = asked === 'architect' && !configured.has(asked) ? 'oracle' : asked;
  if (scoutsArg && scoutsArg.length > 0 && requestedRole === 'sonic') {
    return { ok: false, code: 'invalid_arguments', error: 'scouts are not available for role sonic' };
  }
  if (scoutsArg && scoutsArg.length > 0 && Array.isArray(args.from_jobs) && args.from_jobs.length + scoutsArg.length > 16) {
    return { ok: false, code: 'invalid_arguments', error: `scouts reserve ${scoutsArg.length} of the 16 from_jobs entries` };
  }
  let role = requestedRole;
  if ((args.members !== undefined || args.synthesizer !== undefined) && role !== 'council')
    return { ok: false, code: 'invalid_arguments', error: 'members and synthesizer are council-only' };
  // An internal seat is the resolved council preset, not the general/pro role’s launch chain.
  const councilRole = seat && configured.get('council');
  if (seat && (!councilRole || councilRole.optionalEnabled === false || (seat.place.harness === 'bro' && !configured.get('pro')?.optionalEnabled)))
    return { ok: false, code: 'role_unavailable', reason: 'Council or its browser role is no longer enabled' };
  const definition = seat && councilRole ? { ...councilRole, role, run: [seat.place], preset: null, presets: [], skills: seat.place.skills,
    members: undefined, can_continue: false } : configured.get(role);
  if (definition?.optionalEnabled === false) return { ok: false, code: 'role_unavailable',
    reason: `Optional role ${role} is off. Turn it on in Control → Roles (Space), or configure it in $HUD_HOME/role-switches.json.` };
  if (!definition) {
    const invalid = found.invalidRole(role);
    return { ok: false, code: 'role_unavailable', reason: `Role ${asked} is not configured or is hidden in this project`, ...invalid };
  }
  let prewalkSettings;
  try { prewalkSettings = loadSettings({ ...process.env, HUD_HOME: hudHome }); } catch { /* Missing handled by loadSettings; malformed skips auto prewalk. */ }
  const requireScouts = Boolean(prewalkSettings?.autoPrewalk) && args.prewalk !== false && !landCwd && !repairOf && !retryInput && !isTicketAdmission
    && definition.prewalk === 'on' && role !== 'sonic' && role !== 'council';
  if (requireScouts && scoutsArg === undefined) {
    return {
      ok: false,
      code: 'invalid_arguments',
      error: `Role ${role} has prewalk enabled; pass scouts: [{kind: "code"|"docs"|"web", ask: "..."}] (0–${MAX_PREWALK_SCOUTS} items), scouts: [] to skip scouts, or prewalk: false to skip prewalk.`,
    };
  }
  let borrowed: Pick<Job, 'instructions_from' | 'borrowed_instructions'> = {};
  if (args.instructions !== undefined) {
    const from = typeof args.instructions === 'string' ? configured.get(args.instructions) : undefined;
    if (!from || from.optionalEnabled === false) {
      const valid = [...configured.values()].filter(r => r.optionalEnabled !== false).map(r => r.role).sort();
      return { ok: false, code: 'invalid_arguments', error: `Unknown instructions role ${JSON.stringify(args.instructions)}. Valid roles: ${valid.join(', ')}` };
    }
    const name = from.instructions ?? from.role;
    borrowed = { instructions_from: from.role, borrowed_instructions: { name,
      pi_role: seat?.place.pi_role ?? from.run.find(p => p.harness === 'pi')?.pi_role ?? name } };
  }
  const now = Date.now();
  const existing = jobs().find((job) =>
    job.request_key === request_key && (!windowedKey || withinRetryWindow(job.created_at, now)));
  if (existing) {
    ensureWatcher();
    if (!session.taskClient) void ensureQueueWatcher(pane, hudHome);
    return created(existing);
  }
  // A retry of an overflow keeps the imp seat's launch configuration, unless the caller
  // uses general's public placement overrides to request a different place.
  const fromImp = role === 'general' && sourceJob?.overflow_from === 'imp' &&
    !placementOverrides.some(key => retryInput?.[key] !== undefined) && !hasPiPlacement(retryInput?.pi_args);
  const chain = fromImp ? configured.get('imp') : definition;
  if (!chain || chain.optionalEnabled === false)
    return { ok: false, code: 'role_unavailable', reason: 'Role imp is not configured or is hidden in this project' };
  const mode = args.mode;
  if (mode !== undefined && mode !== 'tab' && mode !== 'headless')
    return { ok: false, code: 'invalid_arguments', error: 'mode must be tab or headless' };
  if (mode === 'tab' && role === 'sonic') return { ok: false, code: 'invalid_arguments', error: 'sonic runs headless only' };
  if (mode === 'headless' && !chain.can_continue)
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
  const preset = chain.presets?.find((p) => p.name === presetName);
  if (presetName !== undefined && !preset && !(fromImp && sourceJob?.route)) {
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
  // Sonic is headless and can belong to a headless worker without a caller pane.
  if (!isTicketAdmission && !(parent?.headless && role === 'sonic') && !herdrId(pane))
    return { ok: false, code: 'herdr_required' };

  const id = 'j' + randomBytes(8).toString('hex');
  const dir = directory(id);
  const project = found.project();
  const projectRoot = sharedRoot(cwd), parentJob = parent?.job;
  const lineage = parent ?? sourceJob;
  // Missing attribution on an existing job stays missing even if the ticket now links an Objective.
  const objective = lineage ? objectiveLink(lineage.objective) : ticketObjective(cwd, args.ticket, projectRoot);
  const contextCwd = scoutContextCwd ?? cwd;
  let pool: Awaited<ReturnType<typeof pickRolePool>> | undefined;
  const contextFor = (targetArgs: Args, inline: boolean) => assembleContext(targetArgs, contextCwd, inline, project, repairOf, pool?.pool_files);
  if (role === 'council') {
    const allowed = ['role', 'task', 'cwd', 'request_key', 'members', 'synthesizer', 'context_files', 'from_jobs', 'retry_of'];
    const extra = Object.keys(args).find(k => args[k] !== undefined && !allowed.includes(k));
    if (extra || parent || repairOf || isTicketAdmission) return { ok: false, code: 'invalid_arguments', error: `Council is a standalone fixed flow; unsupported: ${extra ?? 'nested dispatch'}` };
    const askOwner = { ok: false, code: 'owner_grant_required', reason: 'Ask the owner to authorize one council before starting it.' };
    if (!councilGrants.available(hudHome)) return askOwner;
    const councilPlan = prepareCouncil(args, definition, found, configured, routing);
    if ('code' in councilPlan) return councilPlan;
    const context = await contextFor(args, false);
    if ('code' in context) return context;
    const members = councilPlan.members.map(s => s.preset);
    const synthesizer = councilPlan.synthesizer === 'main' ? 'main' : councilPlan.synthesizer.preset;
    const base: Job = { job: id, role, cwd, project_root: projectRoot, caller_pane: pane, request_key, created_at: new Date().toISOString(), dispatcher,
      task_length: task.length, dispatch_exit_code: 0, stderr_tail: '', ...context.metadata, ...(retryInput && { retry_of: required(retryInput, 'retry_of') }),
      council_members: members.map(preset => ({ preset })), synthesizer, create_options: { members, synthesizer } };
    const grant = await councilGrants.reserve(hudHome, id);
    if (!grant) return askOwner;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      writePrivateFile(join(dir, jobFiles.brief), `${task}\n\n${context.block}`);
      save(base);
      writeCreateStatus(dir, { state: 'working', reason: 'Council in progress' });
      trackCreatedJob(id);
      const row = readRow(base).row;
      session.cursor.set(id, row);
      ensureWatcher();
      const entry = session.taskClient ? beginTask(base) : undefined;
      if (!entry) void ensureQueueWatcher(pane, hudHome);
      const reply = finishTask(entry, base, true) ?? created(base, row);
      const flow = await createCouncilRun(hudHome, base, pane!, configured, { plan: councilPlan, grant });
      wakeWorkflow(hudHome, flow);
      return reply;
    } catch (error) {
      await councilGrants.releaseUnused(hudHome, id);
      writeCreateStatus(dir, { state: 'failed', exit_reason: String(error), ended_at: new Date().toISOString() });
      throw error;
    }
  }
  const imp = requestedRole === 'imp' || fromImp;
  const sonic = requestedRole === 'sonic';
  const settings = !member && (imp || sonic) && !retryInput && !fromImp ? impPlacementSettings(hudHome) : undefined;
  const even = imp && settings?.impPlacement === 'even' ? evenPlanner(found, chain, args, routing, 'imp', settings.impEvenPool)
    : sonic && settings?.sonicPlacement === 'even' ? evenPlanner(found, chain, args, routing, 'sonic', settings.sonicEvenPool) : undefined;
  let route: JobRoute | undefined;
  let localContext: Awaited<ReturnType<typeof contextFor>> | undefined;
  if (member) {
    route = member.route;
  } else if (imp && (retryInput || fromImp)) {
    route = landCwd ? repairImpRoute(chain, sourceJob?.route) : sourceJob?.route;
  } else if (sonic && retryInput) {
    route = sourceJob?.route;
  } else if (!even && imp && settings?.impPlacement !== 'auto') {
    route = { ...defaultImpRoute(settings ? 'Imp routing is off' : 'Imp routing settings unavailable', mode), preset: currentPreset(chain) };
  } else if (!even && imp && chain.routing && settings) {
    localContext = await contextFor(args, false);
    if ('code' in localContext) return localContext;
    const context_files = localContext.contextInputs;
    route = await pickImpRoute(hudHome, settings, chain.routing, task, mode, () => ({
      ticket: routingTicketText(project.root, args.ticket), context_files,
    }));
  }
  const plan = await even?.() ?? launchPlan(found, chain, now, args, routing, onEntry, retryInput, route, !!landCwd);
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

  const autoPrewalkAllowed = prewalkSettings?.autoPrewalk !== false && args.prewalk !== false && !landCwd && (!repairOf || !!retryInput);
  const poolConfig = autoPrewalkAllowed && chain.prewalk !== 'off' ? chain.pool : undefined;
  const poolPlace = plan.candidates[0]?.prepared;
  if (poolConfig && poolPlace && !('code' in poolPlace)) {
    // Validate caller context before model calls, and don't hold the concurrency lock over API waits.
    const browser = poolPlace.place.harness === 'bro';
    const validated = (!browser && localContext) || await contextFor(args, browser);
    if ('code' in validated) return validated;
    const projectName = basename(projectRoot);
    pool = await pickRolePool(hudHome, poolConfig, task, role, project, projectName);
    if (pool?.pool_files.length) localContext = undefined;
    else if (!browser) localContext = validated;
  }
  const effectiveScouts = args.prewalk === false ? [] : (scoutsArg ?? []);
  const scoutSpecs = callerScouts(effectiveScouts, task);
  const hasScouts = scoutSpecs.length > 0;
  const hasPrewalk = Boolean(pool || (args.prewalk !== false && scoutsArg !== undefined));
  const initialPrewalk = (state: 'running' | 'queued'): PrewalkEntry[] | undefined => hasPrewalk
    ? [...(pool ? [pool.entry] : []), ...scoutSpecs.map(({ kind, source, ask }) => ({ kind, source, ...(ask ? { ask } : {}), result: state, ms: 0 }))]
    : undefined;

  const enforceCap = !parentJob && !scoutContextCwd && !landCwd && role !== 'lead';
  let overflowFrom = fromImp ? 'imp' : undefined;
  let inline = false;
  let context: Exclude<Awaited<ReturnType<typeof assembleContext>>, { ok: false }> | undefined;
  let base!: Job;
  let queuedReply: ReturnType<typeof created> | TaskReply | undefined;

  const admit = async () => {
    const stopped = () => canAdmit && !canAdmit();
    if (stopped()) return { ok: false as const, code: 'queue_stopped' };
    // Readiness is a snapshot; serialize the final flake check with the on-disk slot reservation.
    if (isTicketAdmission && typeof args.ticket === 'string' && isRunningListTicket(task)) {
      const feature = readFlakesConfig(projectRoot)?.feature;
      if (feature && args.ticket.startsWith(`${feature}/`) &&
          !runningListAdmission(hudHome, projectRoot, feature, jobCache).eligible(args.ticket)) {
        return { ok: false as const, code: 'flake_ineligible' as const };
      }
    }
    let shouldQueue = false;
    if (enforceCap) {
      const concurrency = loadConcurrencySettings();
      const cap = capForRole(concurrency, role);
      const all = jobs();
      const workingByRole = countWorkingByRole(all);
      // A fixed batch waits in its manifest, never in the ordinary queue. Check under the
      // same cross-process lock as normal admission, including other batches of this role.
      if (member && !batchHasRoom(role, all, cap)) return { ok: false as const, code: 'batch_wait' };
      if (cap > 0 && (workingByRole.get(role) ?? 0) >= cap) {
        const generalCap = capForRole(concurrency, 'general');
        const generalHasRoom = generalCap === 0 || (workingByRole.get('general') ?? 0) < generalCap;
        if (!isTicketAdmission && role === 'imp' && concurrency.impOverflow && generalHasRoom && found.roles().has('general')) {
          // Overflow borrows a concurrency slot, not the imp role's launch chain or mode.
          overflowFrom = 'imp';
          role = 'general';
        } else shouldQueue = true;
      }
    }

    const first = plan.candidates[0];
    if (!first) {
      if (plan.error && 'code' in plan.error) return plan.error;
      const { effective } = plan;
      return { ok: false as const, code: 'no_available_place' as const, reason: effective.reason, places: effective.places, exhausted: effective.exhausted,
        ...(plan.route && { route: plan.route }) };
    }
    if ('code' in first.prepared) return first.prepared;
    if (shouldQueue) {
      const queuedContext = localContext ?? await contextFor(args, false);
      if ('code' in queuedContext) return queuedContext;
      if (stopped()) return { ok: false as const, code: 'queue_stopped' };
      const nowIso = new Date().toISOString();
      // The watcher re-evaluates availability at start time; retain the decision while queued.
      const queuedRoute = plan.fallback ? route : first.route;
      const queuedJob: Job = {
        job: id,
        role,
        ...borrowed,
        request_key,
        cwd: reusedWorktree?.root ?? cwd,
        project_root: projectRoot,
        ...(preview && { preview }),
        ...(reusedWorktree ? { worktree: reusedWorktree } : {}),
        ...(pane && { caller_pane: pane }),
        ...(workspace && herdrId(workspace) && { herdr_workspace: workspace }),
        created_at: nowIso,
        queued_at: nowIso,
        dispatcher,
        ...(ticketQueue && { workflow: ticketQueue, ticket_queue: ticketQueue }),
        ...(queuedRoute && { route: queuedRoute }),
        ...((sonic || first.route?.mode === 'headless' || args.mode === 'headless') && { headless: true }),
        ...(overflowFrom && { overflow_from: overflowFrom }),
        task_length: task.length,
        ...queuedContext.metadata,
        ...(pool && { pool_files: pool.pool_files }),
        ...(initialPrewalk('queued') && { prewalk: initialPrewalk('queued') }),
        ...(checks?.length ? { checks } : {}),
        ...(repairOf ? { repair_of: repairOf } : {}),
        ...(retryInput ? { retry_of: required(retryInput, 'retry_of') } : {}),
        ...(hasScouts ? { queued_scouts: effectiveScouts } : {}),
        target_hint: taskTarget(task) || null,
        experiment, arm,
        ...(args.package === undefined ? {} : { package: args.package as string }),
        ...(args.ticket === undefined ? {} : { ticket: args.ticket as string }),
        ...(objective && { objective }),
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
      session.cursor.set(id, queuedRow);
      ensureWatcher();
      let taskEntry: HudTask | undefined;
      if (session.taskClient) {
        taskEntry = beginTask(queuedJob);
        taskEntry.view.statusMessage = `${taskLabel(taskEntry, 'queued')} (#${position})`;
      } else void ensureQueueWatcher(pane, hudHome);
      if (batch) {
        registerBatchTask(taskEntry, queuedJob, true);
        queuedReply = created(queuedJob, queuedRow);
      } else {
        queuedReply = finishTask(taskEntry, queuedJob, true, taskEntry && launchSummary(queuedJob)) ?? created(queuedJob, queuedRow);
      }
      return undefined;
    }

    inline = first.prepared.place.harness === 'bro';
    const assembled = (!inline && localContext) || await contextFor(args, inline);
    if ('code' in assembled) return assembled;
    if (stopped()) return { ok: false as const, code: 'queue_stopped' };
    context = assembled;
    base = {
      job: id,
      role,
      ...borrowed,
      ...(pool && { pool_files: pool.pool_files }),
      ...(initialPrewalk('running') && { prewalk: initialPrewalk('running') }),
      ...(prewalkKind && { prewalk_kind: prewalkKind }),
      ...(overflowFrom ? { overflow_from: overflowFrom } : {}),
      request_key,
      cwd: landCwd ?? reusedWorktree?.root ?? cwd,
      project_root: projectRoot,
      ...(preview && { preview }),
      ...(reusedWorktree ? { worktree: reusedWorktree } : {}),
      ...(pane && { caller_pane: pane }),
      ...(workspace && herdrId(workspace) && { herdr_workspace: workspace }),
      created_at: new Date().toISOString(),
      dispatcher,
      task_length: task.length,
      ...(checks?.length ? { checks } : {}),
      ...(repairOf ? { repair_of: repairOf } : {}),
      ...(retryInput ? { retry_of: required(retryInput, 'retry_of') } : {}),
      ...(landCwd ? { land_turn: request_key } : {}),
      ...(ticketQueue && { workflow: ticketQueue, ticket_queue: ticketQueue }),
      ...(member && { workflow: member.flow, batch_flow: member.flow }),
      target_hint: taskTarget(task) || null, // Keep even under another pane; missing means a legacy receipt.
      ...(parentJob ? { parent_job: parentJob } : {}),
      ...(council && seat && { workflow: council.id, council, preset: seat.preset }),
      ...(first.route && { route: first.route }),
      ...(role === 'sonic' || first.route?.mode === 'headless' || args.mode === 'headless' ? { headless: true } : {}),
      ...(scoutContextCwd === undefined ? {} : { scout_only: true, workflow: parentJob }),
      experiment, arm,
      ...(args.package === undefined ? {} : { package: args.package as string }),
      ...(args.ticket === undefined ? {} : { ticket: args.ticket as string }),
      ...(objective && { objective }),
      ...(args.slice === undefined ? {} : { slice: args.slice as string }),
      ...(presetName === undefined ? {} : { preset: presetName }),
      attempts: [],
      dispatch_exit_code: null,
      launcher: launcherId(),
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
    // Ticket queues and MCP connections admit against the same on-disk role caps.
    admissionError = enforceCap ? await withAbstractLock('concurrency', hudHome, admit, { timeoutMs: 10_000 }) : await admit();
  } finally {
    slotGate?.release();
  }
  if (admissionError !== undefined) return admissionError;
  if (queuedReply !== undefined) return queuedReply;

  let scoutTask: HudTask | undefined;
  // Reads can reveal the persisted ID before launch ends; serialize its mutations with launch too.
  const launch = () => keyLock(`job:${id}`, async () => {
    let taskEntry: HudTask | undefined;
    const { job, result, reason } = await launchAttempts(base, { cwd: landCwd ?? cwd, args, retryInput, chain, plan, worktree }, {
      even, modelSource: modelOverride !== undefined ? 'hud_create' : onEntry?.model !== undefined ? harnessesSourceFor(onName) : undefined,
      async prepare(job, browser, first) {
        if (first) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const briefContext = inline === browser ? context! : await contextFor(args, browser);
        if (!('code' in briefContext)) {
          Object.assign(job, briefContext.metadata);
          writeBrief(job, dir, task, briefContext.block, first);
        }
        return briefContext;
      },
      onFirst(job) {
        publishWorkSummary();
        observeRetrySource(job);
        if (parentJob && !job.scout_only && !job.council) {
          const children = join(directory(parentJob), jobFiles.sonic);
          fs.mkdirSync(children, { recursive: true, mode: 0o700 });
          fs.writeFileSync(join(children, id), '', { mode: 0o600, flag: 'wx' });
        } else if (!parentJob) trackCreatedJob(id);
        ensureWatcher();
        if (session.taskClient && !parentJob) taskEntry = beginTask(job);
        else if (!job.scout_only && !job.council) void ensureQueueWatcher(pane, hudHome);
      },
      onUsedPlace: memberStarted, // Pre-input failures also have job IDs; only a used place spends the grant.
    });
    const launchRow = finishLaunch(job, dir, result, reason);
    if (batch) {
      registerBatchTask(taskEntry, job, result.exit_code === 0);
      return created(job, launchRow);
    }
    return finishTask(taskEntry, job, result.exit_code === 0, taskEntry && launchSummary(job)) ?? created(job, launchRow);
  });
  if (!hasScouts) return launch();

  // The target ID (and task, if negotiated) is stable across both stages.
  base.scout_state = 'scouting';
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeBrief({ ...base, place: plan.candidates[0].candidate.place }, dir, task, context!.block, true);
  save(base);
  writeCreateStatus(dir, { state: 'working', reason: 'scouting' });
  trackCreatedJob(id);
  const scoutRow = readRow(base).row;
  session.cursor.set(id, scoutRow);
  ensureWatcher();
  if (session.taskClient) {
    scoutTask = beginTask(base);
    scoutTask.view.statusMessage = taskLabel(scoutTask, 'scouting');
  } else void ensureQueueWatcher(pane, hudHome);
  if (batch) registerBatchTask(scoutTask, base, true);
  const reply = batch ? created(base, scoutRow)
    : (finishTask(scoutTask, base, true, scoutTask && launchSummary(base)) ?? created(base, scoutRow));
  void startPrewalk(base, 'mcp', { scouts: scoutSpecs, launch: { cwd, args, retryInput, chain, plan, worktree } }).then(() => {
    const latest = findJob(id);
    if (latest && scoutTask && activeTasks.get(id) === scoutTask && scoutTask.view.status === 'working' && jobCallerPane(latest) === scoutTask.pane) {
      scoutTask.fence = taskFence(latest); extendTask(scoutTask, latest);
    }
  }).catch(() => ensureWatcher());
  return reply;
}

function launcherId() {
  const start = procStat(process.pid)?.start;
  return { pid: process.pid, ...(start && { start }) };
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
  let prewalking: Promise<void> | undefined;
  const result = await keyLock(`job:${id}`, async () => {
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
      writeCreateStatus(dir, { state: 'failed', role, exit_reason: code ?? 'dispatch_failed', error: reason, ended_at: new Date().toISOString() });
      return { started: false, failed: true, reason };
    };
    let task: string;
    try { task = originalTask(existing); }
    catch (error) { return failQueued(`could not read queued brief: ${error instanceof Error ? error.message : String(error)}`); }
    const args: Args = { ...jobOptions(existing), cwd, role, task };
    const retryInput: Args | undefined = existing.retry_of ? { retry_of: existing.retry_of, ...(existing.create_options ?? {}) } : undefined;
    const found = registry(cwd);
    const launchRoleName = existing.overflow_from ?? existing.role;
    const chain = found.roles(true).get(launchRoleName);
    if (chain?.optionalEnabled === false) return failQueued(`Optional role ${launchRoleName} is off`);
    if (!chain) return failQueued(`Role ${launchRoleName} is not configured or is hidden in this project`);
    if (args.mode === 'headless' && !chain.can_continue) return failQueued('headless mode requires a continuable role', 'invalid_arguments');
    const now = Date.now();
    let routing;
    try { routing = found.routing(now); }
    catch (error) { return failQueued(error instanceof Error ? error.message : String(error)); }
    const onName = typeof args.on === 'string' ? args.on : null;
    const defaults = onName ? harnessDefaults(hudHome, bundled) : null;
    const onEntry = onName ? defaults?.[onName] : undefined;
    if (onName && !onEntry) return failQueued(`unknown harness: ${onName}`, 'invalid_arguments');
    const presetName = typeof args.preset === 'string' ? args.preset : undefined;
    if (!existing.route && presetName !== undefined && !chain.presets?.some(p => p.name === presetName))
      return failQueued(`unknown preset: ${presetName}`, 'invalid_arguments');
    const settings = existing.route?.placement === 'even' && !retryInput ? impPlacementSettings(hudHome) : undefined;
    const even = settings && launchRoleName === 'imp' ? evenPlanner(found, chain, args, routing, 'imp', settings.impEvenPool)
      : settings && launchRoleName === 'sonic' ? evenPlanner(found, chain, args, routing, 'sonic', settings.sonicEvenPool) : undefined;
    let plan = launchPlan(found, chain, now, args, routing, onEntry, retryInput, existing.route);
    if (even && !plan.candidates.length) {
      const exhausted = plan.effective.places.find(place => place.state === 'exhausted');
      if (exhausted) plan = await even(existing.route, exhausted.quota_reason) ?? plan;
    }
    const first = plan.candidates[0];
    if (plan.route) {
      existing.route = plan.route;
      existing.headless = plan.route.mode === 'headless' ? true : undefined;
    }
    if (!first) return plan.error && 'code' in plan.error
      ? failQueued(plan.error.error ?? 'invalid_arguments', 'invalid_arguments')
      : failQueued(plan.effective.reason ?? 'no available place');
    if ('code' in first.prepared) return failQueued(first.prepared.error ?? 'invalid_arguments', 'invalid_arguments');

    let worktree: ManagedWorktree | undefined = existing.worktree;
    if (!worktree && args.isolation === 'worktree') {
      try { worktree = await planWorktree(cwd, id, existing.package || role); }
      catch { return failQueued('worktree isolation requires a Git checkout with a HEAD commit', 'invalid_arguments'); }
    }

    if (overflowed && existing.role !== role) {
      existing.overflow_from = existing.role;
      existing.role = role;
    }
    const { queued_scouts: queuedScouts, ...restExisting } = existing;
    const base: Job = { ...restExisting, role, ...(role === 'sonic' ? { headless: true } : {}), attempts: [], launcher: launcherId() };
    const project = found.project();
    const contextFor = (targetArgs: Args, inline: boolean) => assembleContext(targetArgs, cwd, inline, project, existing.repair_of, existing.pool_files);
    const inline = first.prepared.place.harness === 'bro';
    const context = await contextFor(args, inline);
    if ('code' in context) return failQueued(context.error ?? context.code ?? 'invalid_arguments', context.code === 'invalid_arguments' ? 'invalid_arguments' : undefined);

    const scoutSpecs: ScoutSpec[] = queuedScouts?.length
      ? callerScouts(queuedScouts, task)
      : existing.scout_question
        ? [{ kind: 'code', source: 'caller', ask: truncateScoutAsk(existing.scout_question), question: existing.scout_question, includeContext: true }]
        : (existing.prewalk ?? [])
            .filter((entry): entry is PrewalkEntry & { kind: PrewalkScoutKind } => entry.kind !== 'pool' && entry.result === 'queued')
            .map(entry => ({
              kind: entry.kind,
              source: entry.source === 'caller' || entry.source === 'default' ? entry.source : 'decision',
              ...(entry.ask ? { ask: entry.ask } : {}),
              question: prewalkScoutTask(entry.kind, entry.ask ?? '', task),
              includeContext: entry.kind !== 'web',
            }));
    const hasScouts = scoutSpecs.length > 0;
    const leaveQueue = () => {
      fs.rmSync(join(dir, jobFiles.status), { force: true });
      jobCache.invalidateFile(join(dir, jobFiles.status));
      save(base);
    };
    // The watcher's scan is a scheduling hint; another process can admit a create before we launch.
    const reserved = await withAbstractLock('concurrency', hudHome, () => {
      if (readCachedStatus(id).status?.state !== 'queued') return false;
      const cap = capForRole(loadConcurrencySettings(), role);
      if (cap && (countWorkingByRole().get(role) ?? 0) >= cap) {
        // A concurrent create took the slot. Leave the queued job claimable on the next scan.
        fs.unlinkSync(join(dir, QUEUE_START_MARKER));
        return false;
      }
      if (hasScouts) {
        base.scout_state = 'scouting';
        save(base);
        writeCreateStatus(dir, { state: 'working', role, reason: 'scouting' });
      } else leaveQueue();
      return true;
    }, { timeoutMs: 10_000 });
    if (!reserved) return { started: false };
    const launch = { cwd, args, retryInput, chain, plan, worktree };
    if (hasScouts) {
      // Release the job lock while the driver waits for child reports.
      prewalking = startPrewalk(base, 'watcher', { scouts: scoutSpecs, launch });
      return { started: true };
    }
    return launchReservedJob(base, launch, undefined, { even, context });
  });
  if (!prewalking) return result;
  // Keep this start in the watcher's drain set (including across binary reload).
  await prewalking;
  const job = findJob(id);
  return job?.dispatch_exit_code === 0 ? { started: true } : { started: false, failed: true, reason: job?.stderr_tail };
}

/** Launch the already admitted target at its reserved id and frozen placement. */
async function launchReservedJob(base: Job, launch: ReservedLaunch, scoutOutcomes?: ScoutOutcome[],
  queued?: { even?: ReturnType<typeof evenPlanner>; context: Awaited<ReturnType<typeof assembleContext>> }) {
  const { cwd, args, retryInput, chain, plan } = launch;
  const dir = directory(base.job), task = required(args, 'task');
  const found = registry(cwd), project = found.project();
  const contextFor = (targetArgs: Args, browser: boolean) => assembleContext(targetArgs, cwd, browser, project, base.repair_of, base.pool_files);
  const launchRoleName = base.overflow_from ?? base.role;
  // A fixed-batch route can say "even", but the manifest already pinned its preset.
  const settings = !base.batch_flow && !queued && base.route?.placement === 'even' && !retryInput ? impPlacementSettings(hudHome) : undefined;
  const even = queued?.even ?? (settings && (launchRoleName === 'imp' || launchRoleName === 'sonic')
    ? evenPlanner(found, chain, args, found.routing(Date.now()), launchRoleName, launchRoleName === 'imp' ? settings.impEvenPool : settings.sonicEvenPool) : undefined);
  const onName = typeof args.on === 'string' ? args.on : null;
  const onEntry = onName === null ? undefined : harnessDefaults(hudHome, bundled)[onName];
  const poolEntry = base.prewalk?.find(entry => entry.kind === 'pool');
  const { job, result, reason } = await launchAttempts(base, launch, {
    even, callerToken: base.created_at,
    modelSource: typeof args.model === 'string' ? 'hud_create' : onEntry?.model !== undefined ? harnessesSourceFor(onName) : undefined,
    async prepare(job, browser) {
      let briefContext = queued && browser === (plan.candidates[0].candidate.place.harness === 'bro') ? queued.context : await contextFor(args, browser);
      let scoutNote = '';
      if (scoutOutcomes?.length) {
        const applied = await applyScoutOutcomes(args, browser, briefContext, scoutOutcomes, poolEntry, contextFor);
        briefContext = applied.briefContext;
        scoutNote = applied.note;
        job.prewalk = applied.entries;
        job.scout_state = applied.scoutState;
        if (applied.scoutError) job.scout_error = applied.scoutError;
        else delete job.scout_error;
      }
      if (!('code' in briefContext)) {
        Object.assign(job, briefContext.metadata);
        writeBrief(job, dir, task, scoutNote + briefContext.block, false);
      }
      job.launcher = launcherId();
      return briefContext;
    },
    onFirst(job) {
      if (scoutOutcomes) {
        fs.rmSync(join(dir, jobFiles.status), { force: true });
        jobCache.invalidateFile(join(dir, jobFiles.status));
      }
      observeRetrySource(job);
    },
  });
  finishLaunch(job, dir, result, reason, false);
  return { started: result.exit_code === 0, ...(result.exit_code !== 0 ? { failed: true, reason } : {}) };
}

function observeRetrySource(job: Job) {
  const source = job.retry_of && findJob(job.retry_of);
  if (source) save({ ...source, observed_at: new Date().toISOString() });
}

/** Shared place selection and retry/fallback policy for an admitted job. */
async function launchAttempts(base: Job, { cwd, args, retryInput, chain, plan, worktree }: ReservedLaunch, hooks: {
  even?: ReturnType<typeof evenPlanner>; callerToken?: string; modelSource?: string;
  prepare(job: Job, browser: boolean, first: boolean): Promise<Awaited<ReturnType<typeof assembleContext>>>;
  onFirst(job: Job): void;
  onUsedPlace?: () => void;
}) {
  const { job: id, role } = base, dir = directory(id), task = required(args, 'task');
  const attempts = base.attempts!;
  const candidates = [...plan.candidates];
  let job = base;
  let result: DispatchResult = launchError('no launch attempted');
  let reason = '';
  let sonicPick: Promise<string | undefined> | undefined;
  for (const [index, { candidate, prepared, effective, route }] of candidates.entries()) {
    const launchArgs = argsForPlace(args, candidate.place, retryInput);
    if ('code' in prepared) continue; // Explicit harness-only options still constrain this dispatch.
    const first = attempts.length === 0;
    if (!first) {
      const exhausted = readExhausted(hudHome);
      const quota = isQuotaFailure(reason);
      if ((quota && candidate.key === job.place_key) || exhausted.has(candidate.key)) continue;
      if (quota && !exhausted.has(job.place_key!)) markExhausted(hudHome, job.place_key!, reason);
      // The previous tab is closed. Don't carry its launch/turn state into a new worker.
      for (const file of [jobFiles.session, jobFiles.status, jobFiles.turn]) fs.rmSync(join(dir, file), { force: true });
      jobCache.invalidateJob(id);
    }
    const { place, options } = prepared;
    let thinking_source: Job['thinking_source'];
    if (role === 'sonic' && place.harness !== 'bro') {
      if (args.thinking !== undefined) thinking_source = 'explicit';
      else {
        const picked = await (sonicPick ??= pickSonicThinking(hudHome, task, chain.thinking_choices));
        if (picked !== undefined) place.thinking = picked;
        thinking_source = picked === undefined ? 'default' : 'decision';
      }
    }
    const attempt: LaunchAttempt = { index: candidate.index, place: describePlace(place, candidate.model.value) };
    job = {
      ...base, ...options, place, place_key: candidate.key,
      ...(route && { route, headless: route.mode === 'headless' || role === 'sonic' ? true : undefined }),
      ...(place.harness === 'bro' || role === 'sonic' ? {} : { resume_s: chain.resume_s ?? DEFAULT_RESUME_S }),
      create_options: {
        cwd, ...Object.fromEntries(replayOptions.filter((key) => launchArgs[key] !== undefined).map((key) => [key, launchArgs[key]])),
      },
      ...(job.worktree ? { worktree: job.worktree, cwd: job.cwd } : {}),
      ...(place.harness === 'bro' ? { bro: place } : {
        model: candidate.model.value, thinking: place.thinking ?? candidate.thinking.value,
        ...(thinking_source ? { thinking_source } : {}),
        model_source: route ? candidate.model.source : hooks.modelSource ?? candidate.model.source,
      }),
      ...(place.harness === 'cli' ? { cli: {
        agent: place.agent!, can_continue: (effective.harness === 'bro' ? chain.can_continue : effective.can_continue) === true,
        idle_grace_s: (args.idle_grace_s as number | undefined) ?? chain.idle_grace_s ?? 600,
        state_trust: candidate.state_trust ?? 'advisory',
      } } : {}),
    };
    if ((base.overflow_from ?? role) === 'imp') job.imp_preset = effective.preset;
    const briefContext = await hooks.prepare(job, place.harness === 'bro', first);
    // Persist before dispatch: an interrupted launch must not dispatch again on retry.
    save(job, !first);
    if (first) hooks.onFirst(job);
    const launchRole = effective.preset ? { ...chain, skills: place.skills } : chain;
    if ('code' in briefContext) result = { ...launchError(briefContext.error ?? 'could not prepare launch context'), preInput: true };
    else result = await launchPlace(job, launchRole, place, dir, task, worktree, briefContext.standing, { callerToken: hooks.callerToken });
    base.launch_agent_args = job.launch_agent_args;
    reason = result.exit_code === 0 ? '' : launchFailure(result).reason;
    if (reason) attempt.reason = reason;
    attempts.push(attempt);
    if (result.exit_code === 0 || (!result.preInput && fs.existsSync(join(dir, jobFiles.status)))) {
      job.used_place = attempt.place;
      hooks.onUsedPlace?.();
    }
    const next = hooks.even && reason ? await nextEvenLaunch(hooks.even, job, result, reason) : undefined;
    if (next) candidates.splice(index + 1, candidates.length, ...next.candidates);
    else if (!canTryNext(job, result)) break;
    save(job);
  }
  if (plan.fallback && canTryNext(job, result) && job.route?.tier !== 'standard')
    job.route = plan.fallback;
  return { job, result, reason };
}

function writeBrief(job: Job, dir: string, task: string, block: string, first: boolean) {
  const place = job.place!;
  let brief = `${task}${place.harness === 'bro' ? '\n' : '\n\n'}${block}`;
  if (job.preview) brief += `Write the HTML preview to ${JSON.stringify(job.preview)} relative to your cwd before reporting.\n`;
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
  if (!job.headless && (place.harness === 'cli' || place.harness === 'pi')) {
    const error = await herdrWorkerPreflight();
    if (error) return rejectLaunch(launchError(error, 'herdr_fork_required'));
  }
  let instructionsPath = '';
  try {
    if (job.borrowed_instructions && place.harness === 'bro')
      return rejectLaunch(launchError('instructions requires a pi or CLI place', 'unsupported_harness'));
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
      const name = job.borrowed_instructions?.name ?? definition.instructions ?? definition.role;
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
  if (place.harness === 'cli') return dispatchCli(job, place, instructionsPath, task, definition.mcp_servers ?? [], standingBrief, { ...options, tabVisible: definition.tab_visible });
  if (place.harness === 'pi') return dispatchPi(job, definition, place, task, resume);
  try { return await dispatchBro(job, task); }
  catch (error) { return launchError(String(error)); }
}

function finishLaunch(job: Job, dir: string, result: DispatchResult, reason: string, advanceCursor = true): JobRow | undefined {
  job.dispatch_exit_code = result.exit_code;
  if (result.code) job.dispatch_code = result.code;
  if (result.path) job.dispatch_path = result.path;
  const failure = result.exit_code === 0 ? null : launchFailure(result);
  job.stderr_tail = failure?.stderr_tail ?? result.stderr;
  const statusFile = join(dir, jobFiles.status);
  const launchUnknown = Boolean(failure && (result.launchUnknown || (result.cleanupFailed && !fs.existsSync(join(dir, jobFiles.session)))));
  if (launchUnknown) {
    job.launch_unknown = failure!.reason || reason || 'launch state unknown';
    if (!job.dispatch_code) job.dispatch_code = 'launch_unknown';
  }
  if (failure && (result.preInput || launchUnknown || !fs.existsSync(statusFile))) {
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
      exit_reason: launchUnknown && failure.code === 'dispatch_failed' ? 'launch_unknown' : failure.code,
      error: outcome.reason,
      ...(launchUnknown ? { launch_unknown: job.launch_unknown } : {}),
      ended_at: new Date().toISOString(),
    });
  }
  save(job);
  publishWorkSummary();
  if (!advanceCursor) return undefined;
  const { row } = readRow(job);
  if (!job.parent_job) session.cursor.set(job.job, row);
  return row;
}

async function withReopenLock<T>(dir: string, run: () => T | Promise<T>) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    // Serialize queued sends and resumes across MCP, land and the watcher.
    const lock = spawnSync('flock', ['-xn', '-E', '75', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 1000 });
    if (lock.status === 75) return { ok: false, code: 'worker_reopening' } as const;
    if (lock.status !== 0) return;
    return await run();
  } finally { fs.closeSync(fd); }
}

export async function resumeHeadlessQueue(id: string) {
  const current = findJob(id);
  if (!current?.reaped_at) return;
  const { row, status } = readRow(current, false);
  if (status && headlessFollowupReady(status)) return resumeJob(current, status, row, '', '', undefined, false, false, undefined, true);
}

export async function resumeJob(current: Job, status: JobStatus, row: JobRow, message: string,
  matchKey: string, explicitKey: string | undefined, land: boolean, batch: boolean, answerRequest?: string, automatic = false,
  answeredBy: AnswerActor = 'orchestrator') {
  const dir = directory(current.job);
  return withReopenLock(dir, async () => {
    const latest = findJob(current.job);
    const fresh = readCachedStatus(current.job).status;
    const expected = answerRequest ? 'waiting_orchestrator' : automatic ? status.state : 'closed';
    if (!latest || latest.reaped_at !== current.reaped_at || !fresh || fresh.ended_at !== status.ended_at ||
        fresh.state !== expected || fresh.pid !== status.pid)
      return { ok: false, code: 'worker_reopening' };
    if (!latest.headless && isShellLaunchedWorker(jobCache.readSession(latest.job, { throwOnError: true })?.fields))
      return { ok: false, code: 'shell_worker_unsupported', error: SHELL_WORKER_UNSUPPORTED };
    const pending = latest.headless ? readHeadlessSends(dir) : [];
    if (pending.length && !automatic && !answerRequest) return { ok: false, code: 'worker_reopening' };
    if (automatic && !pending.length) return;
    const result = await reopenJob(latest, fresh, row, message, matchKey, explicitKey, land, batch, answerRequest, automatic, pending, answeredBy);
    if (automatic && !result && !fs.existsSync(join(dir, jobFiles.stopRequested)))
      writeCreateStatus(dir, { ...fresh, state: 'failed', exit_reason: 'Could not resume queued headless sends' });
    return result;
  });
}

async function reopenJob(current: Job, status: JobStatus, row: JobRow, message: string,
  matchKey: string, explicitKey: string | undefined, land: boolean, batch: boolean, answerRequest: string | undefined,
  automatic: boolean, pending: ReturnType<typeof readHeadlessSends>, answeredBy: AnswerActor = 'orchestrator') {
  const { job: id, place } = current, dir = directory(id);
  const until = answerRequest || automatic ? Infinity : resumeDeadline(current, status);
  if (!until || Date.now() >= until || !place || (place.harness !== 'cli' && place.harness !== 'pi') ||
      !fs.statSync(current.cwd, { throwIfNoEntry: false })?.isDirectory()) return;
  const identity = resumeIdentity(current, status);
  const role = registry(roleCwd(current)).roles().get(current.overflow_from ?? current.role);
  if (!identity || !role) return;
  const priorSession = current.headless ? null : slice(join(dir, jobFiles.session), 8192);
  if ((!current.headless && (!priorSession || priorSession.truncated)) || fs.existsSync(join(dir, jobFiles.stopRequested)) ||
      fs.existsSync(join(dir, jobFiles.closeRequested))) return;
  const priorTurn = current.cli ? readTurn(dir) : null;
  if (current.cli && !priorTurn) return;
  const oldTask = activeTasks.get(id);
  if (oldTask && !(answerRequest && jobCallerPane(current) === oldTask.pane && taskFence(current) === oldTask.fence)) sampleTask(oldTask);
  const carryTask = oldTask && !land && activeTasks.get(id) === oldTask && oldTask.view.status === 'working'
    ? oldTask : undefined;
  const key = explicitKey ?? `${matchKey}:${randomBytes(8).toString('hex')}`;
  const outcome = { key, ...(explicitKey === undefined ? { derived_key: matchKey } : {}),
    recorded_at: new Date().toISOString(), exit_code: null as number | null, stderr_tail: '', resumed: true as const };
  const delivered = pending.map(({ text: _, ...receipt }) => ({ ...receipt, resumed: true as const }));
  const next: Job = { ...current, reaped_at: undefined, land_turn: land ? key : undefined,
    ticket_queue: land || automatic ? current.ticket_queue : undefined,
    workflow: automatic || answerRequest ? current.workflow : undefined,
    batch_flow: automatic || answerRequest ? current.batch_flow : undefined,
    headless_task_fence: automatic ? taskFence(current) : undefined,
    send_outcomes: [...(current.send_outcomes ?? []), ...delivered, ...(automatic ? [] : [outcome])] };
  const answerFile = answerRequest && join(dir, jobFiles.qa, `${answerRequest}.answer.md`);
  if (answerRequest && answerFile) {
    if (!jobCache.readQa(dir).openIds.includes(answerRequest)) return { ok: false, code: 'question_not_open' };
    writePrivateFile(answerFile, message, { exclusive: true, mkdir: false });
    jobCache.invalidateQa(id);
    if (jobCache.readQa(dir).openIds.length) {
      recordQuestionAnswer(dir, answerRequest, answeredBy, jobCache);
      if (carryTask) { carryTask.seenQuestions.add(`${answerRequest}.md`); extendTask(carryTask, current); }
      return { ok: true, written: true };
    }
    if (!current.answered_by?.[answerRequest]) next.answered_by = { ...current.answered_by, [answerRequest]: answeredBy };
    if (jobCache.readQa(dir).allQuestionFiles.length > 1)
      message = `Answer to ${answerRequest}: ${message}\nOther decisions are in ${join(dir, jobFiles.qa)}.`;
  }
  if (pending.length) message = [message, ...pending.map(({ text }) => text)].filter(Boolean).join('\n\n');
  // A previous runner's in-memory ready watches ended with its turn. Carry the facts,
  // not the report bodies, into the native continuation; hud_sonic wait still collects.
  if (current.headless) {
    for (const child of headlessSonicChildren(dir)) if (!fs.existsSync(join(child.dir, 'sonic-collected'))) {
      message += `\n\nSonic ${child.id} ${child.state === 'open' ? 'still running' : child.state}. Collect its result with hud_sonic (wait: ["${child.id}"]).`;
    }
  }
  const taskEntry = session.taskClient && !next.batch_flow && !land && !carryTask ? beginTask(next, row.report_mtime, answerRequest) : undefined;
  // Retire the reaped turn's tab before publishing the new working status, so a
  // delayed close can't claim the new turn. Dispatch publishes a fresh receipt.
  const pidFile = join(dir, jobFiles.supervisorPid);
  const tabCli = current.cli && !current.headless;
  const priorPid = tabCli ? jobCache.readPid(pidFile) : null;
  if (tabCli) fs.rmSync(pidFile, { force: true });
  if (priorSession) fs.unlinkSync(join(dir, jobFiles.session));
  writeCreateStatus(dir, { state: 'working' });
  save(next, true);
  const result = await launchPlace(next, role, place, dir, message, undefined, undefined, { resume: { ...identity, message } });
  if (result.exit_code !== 0 && (result.preInput || result.launchUnknown)) {
    const failure = launchFailure(result);
    const diagnostic: ResumeFailure = {
      at: new Date().toISOString(),
      place: current.place_key ?? place.agent ?? place.harness,
      code: result.launchUnknown && failure.code === 'dispatch_failed' ? 'launch_unknown' : failure.code,
      reason: failure.reason,
    };
    if (answerFile) { fs.unlinkSync(answerFile); jobCache.invalidateQa(id); }
    if (priorTurn) saveTurn(dir, priorTurn);
    const touched = findJob(id);
    save({
      ...current,
      read_at: touched?.read_at ?? current.read_at,
      read_report_stamp: touched?.read_at ? touched.read_report_stamp : current.read_report_stamp,
      observed_at: touched?.observed_at ?? current.observed_at,
      resume_failures: [...(current.resume_failures ?? []).slice(-4), diagnostic],
      ...(result.launchUnknown ? { launch_unknown: failure.reason } : {}),
    }, true);
    writeCreateStatus(dir, status);
    if (priorSession) {
      writePrivateFile(join(dir, jobFiles.session), priorSession.text, { mkdir: false });
      jobCache.invalidateFile(join(dir, jobFiles.session));
    }
    if (priorPid !== null) {
      writePrivateFile(pidFile, `${priorPid}\n`, { mkdir: false });
      jobCache.invalidateFile(pidFile);
    }
    if (taskEntry) releaseTask(taskEntry);
    if (result.code === 'herdr_fork_required') return { ok: false, code: result.code, error: result.stderr };
    const cleaned = result.directRollback ? await cleanupDirectResume(result.directRollback) : !result.cleanupFailed;
    if (cleaned && !result.launchUnknown) return;
    if (carryTask && activeTasks.get(id) === carryTask && batchTasks.get(id) !== carryTask) sampleTask(carryTask);
    return { ok: false, sent: false, job: id, continuation: 'resumed' as const, code: 'send_failed', stderr_tail: failure.stderr_tail };
  }
  const latest = findJobMutable(id) ?? next;
  const recorded = latest.send_outcomes?.find((attempt) => attempt.key === key) ?? outcome;
  recorded.exit_code = result.exit_code;
  const failure = result.exit_code === 0 ? null : launchFailure(result);
  recorded.stderr_tail = failure?.stderr_tail ?? result.stderr;
  save(latest);
  const ok = result.exit_code === 0;
  if (ok && pending.length) clearHeadlessSends(dir);
  if (carryTask && activeTasks.get(id) === carryTask) {
    if (ok) {
      if (answerRequest) carryTask.seenQuestions.add(`${answerRequest}.md`);
      carryTask.fence = taskFence(latest);
      carryTask.reportBefore = row.report_mtime;
      carryTask.attentionBefore = undefined;
      extendTask(carryTask, latest);
    } else if (batchTasks.get(id) !== carryTask) sampleTask(carryTask);
  }
  if (ok && !session.taskClient && !land) void ensureQueueWatcher(jobCallerPane(latest), hudHome);
  const continuation = 'resumed' as const;
  if (batch) registerBatchTask(taskEntry, latest, ok);
  else {
    const task = finishTask(taskEntry, latest, ok, continuation);
    if (task) return { ...task, job: id, continuation };
  }
  return { ok, sent: ok, ...(answerRequest && { written: true }), job: id, continuation, ...(ok ? {} : { code: 'send_failed', stderr_tail: recorded.stderr_tail }) };
}

const blockedSend = {
  code: 'worker_blocked', queued: false, error: 'The worker was blocked on a client prompt; the message was not queued.',
} as const;

export async function sendJob(id: string, message: string, explicitKey: string | undefined, workingOnly: boolean,
  { land = false, batch = false, dispatcher }: { land?: boolean; batch?: boolean; dispatcher?: Job['dispatcher'] } = {}) {
  const matchKey = explicitKey ?? derivedKey('send', id, message);
  let current = findJobMutable(id);
  if (!current) return { ok: false, code: 'job_not_found' };
  if (current.role === 'sonic' || current.role === 'council' || current.council) return { ok: false, code: 'not_continuable' };
  if (!current.headless && isShellLaunchedWorker(jobCache.readSession(id, { throwOnError: true })?.fields))
    return { ok: false, code: 'shell_worker_unsupported', error: SHELL_WORKER_UNSUPPORTED };
  const dir = directory(current.job);
  const now = Date.now();
  const duplicate = explicitKey === undefined
    ? current.send_outcomes?.find((attempt) => attempt.derived_key === matchKey && withinRetryWindow(attempt.recorded_at, now))
    : sendHistory(current).find((attempt) => attempt.key === explicitKey);
  if (duplicate) {
    const outcome = 'legacy' in duplicate ? undefined : duplicate;
    if (outcome?.exit_code === 0 && !session.taskClient) void ensureQueueWatcher(process.env.HERDR_PANE_ID, hudHome);
    return outcome?.exit_code === 0
      ? { ok: true, sent: false, ...(outcome.resumed ? { job: id, continuation: 'resumed' as const } : {}) }
      : { ok: false, sent: false, ...(outcome?.client_prompt_blocked ? blockedSend : { code: 'send_failed' }),
          ...(outcome && { key: outcome.key, exit_code: outcome.exit_code, stderr_tail: outcome.stderr_tail }) };
  }
  let { row, status, statusAt } = readRow(current);
  if (!land && current.headless && status?.state === 'working') {
    const job = current;
    const queued = await withReopenLock(dir, () => {
      const fresh = readCachedStatus(id).status;
      if (fresh?.state !== 'working') return;
      if (fresh.pid !== status?.pid) return { ok: false, code: 'worker_reopening' };
      if (fs.existsSync(join(dir, jobFiles.stopRequested))) return { ok: false, code: 'not_continuable' };
      const pending = readHeadlessSends(dir);
      if (pending.some(item => explicitKey === undefined ? item.derived_key === matchKey && withinRetryWindow(item.recorded_at, now) : item.key === explicitKey))
        return { ok: true, sent: false, queued: true };
      if (message.includes('\0')) return { ok: false, code: 'invalid_arguments' };
      const key = explicitKey ?? `${matchKey}:${randomBytes(8).toString('hex')}`;
      pending.push({ key, ...(explicitKey === undefined ? { derived_key: matchKey } : {}),
        text: message, recorded_at: new Date(now).toISOString(), exit_code: 0, stderr_tail: '' });
      if (!writeHeadlessSends(dir, pending)) return { ok: false, code: 'queue_full' };
      const task = activeTasks.get(id);
      if (task?.view.status === 'working' && task.fence === taskFence(job)) extendTask(task, job);
      return { ok: true, sent: true, queued: true };
    });
    if (queued) return queued;
    current = findJobMutable(id) ?? current;
    ({ row, status, statusAt } = readRow(current));
  }
  if (current.headless && !row.open_questions && hasHeadlessSends(dir) && headlessFollowupReady(status))
    return { ok: false, code: 'worker_reopening' };
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
      process.env.HERDR_PANE_ID, { repair: { source: current, derived: explicitKey === undefined }, batch, dispatcher });
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
  const outcome: SendOutcome = { key, ...(explicitKey === undefined ? { derived_key: matchKey } : {}), recorded_at,
    exit_code: null, stderr_tail: '' };
  current.land_turn = land ? key : undefined;
  // A note queued into a working turn leaves that turn with its queue; only a new turn is taken over.
  if (!land && !queued) { delete current.ticket_queue; delete current.batch_flow; delete current.workflow; }
  (current.send_outcomes ??= []).push(outcome);
  save(current);
  // Read the rollback baseline at mutation time, with no pane query between it and the write.
  const submission = current.cli ? await beginPrompt(dir, { send: { key, pid: process.pid, start: procStat(process.pid)?.start ?? null } }) : null;
  const turn = submission?.turn;
  const taskEntry = session.taskClient && !current.batch_flow && !workingOnly && !land && !carryTask
    ? beginTask(current, row.report_mtime, undefined, row, statusAt) : undefined;
  const result = await run('herdr', ['agent', 'prompt', agent, turn ? withDonePrompt(message, bundled, dir, turn, current.cli!.agent) : message]);
  const blocked = result.exit_code !== 0 && launchFailure(result).code === 'agent_blocked';
  const refused = blocked || refusedBeforeInput(result);
  if (submission) await endPrompt(dir, submission, refused);
  const latest = findJobMutable(id) ?? current;
  const attempted = latest.send_outcomes?.find((attempt) => attempt.key === key) ?? outcome;
  attempted.exit_code = result.exit_code;
  attempted.stderr_tail = result.stderr;
  if (blocked) attempted.client_prompt_blocked = true;
  // Pi settlement also uses a send-time baseline. Keep it unchanged on confirmed refusals.
  if (!current.cli && !refused) latest.pi_sent_at = recorded_at;
  save(latest);
  if (!session.taskClient && result.exit_code === 0) void ensureQueueWatcher(process.env.HERDR_PANE_ID, hudHome);
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
    ...(ok ? (queued ? { queued: true } : {}) : blocked ? blockedSend : { code: 'send_failed' }),
    ok, sent: ok,
    exit_code: result.exit_code,
    stderr_tail: result.stderr,
  };
}

/** Detached land helper only: repair the existing branch, without widening public retry_of eligibility. */
export async function dispatchLandRepair(id: string, cwd: string, task: string, key: string, pane: string | null, ticketQueue?: string) {
  const source = findJob(id);
  if (!source || source.cwd !== cwd) throw Error('Repair source checkout changed');
  if (source.role === 'sonic') throw Error('Sonic cannot continue; dispatch a new query');
  const { row, status } = readRow(source, false);
  if (row.open_questions || !['idle_grace', 'done', 'closed'].includes(row.state ?? ''))
    throw Error(`Repair source needs attention: ${id}`);
  const deadline = typeof status?.idle_deadline_at === 'string' ? Date.parse(status.idle_deadline_at) : Infinity;
  if (source.route?.tier !== 'light' && (closedReport(source, status) || (row.state === 'idle_grace' && Date.now() < deadline))) {
    const sent = await keyLock(`job:${id}`, () => sendJob(id, task, key, false, { land: true }));
    if ('sent' in sent && sent.sent) return id;
    if (!('code' in sent) || sent.code !== 'not_continuable') { releaseLandTurn(id, key); throw Error(`Repair send failed: ${id}`); }
  }
  const args = { ...jobOptions(source), cwd: sharedRoot(cwd), isolation: 'none', retry_of: id, task, on: undefined,
    ...(source.route?.tier === 'light' && { mode: undefined }) };
  // A closed but successfully settled job isn't a public retry target. Use the same keyed create path,
  // retaining retry provenance and the original checkout rather than starting at a clean main tip.
  const dispatcher = ticketQueue ? readTicketQueue(hudHome, ticketQueue)?.dispatcher : undefined;
  const result = await keyLock(`request:${key}`, () => dispatchWithKey(args, pane ?? jobCallerPane(source), key, false,
    undefined, undefined, { retry_of: id }, { landCwd: cwd, sourceJob: source, ticketQueue, dispatcher }));
  if ('job' in result && result.job && !('ok' in result && result.ok === false)) return result.job;
  throw Error(`Could not dispatch landing repair: ${'code' in result ? result.code : 'no job'}`);
}

export function releaseLandTurn(id: string, key: string) {
  const job = findJobMutable(id);
  if (job?.land_turn === key) { delete job.land_turn; save(job); }
}
