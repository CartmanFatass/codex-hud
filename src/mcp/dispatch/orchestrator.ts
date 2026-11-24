/** Job creation, queued launch, continuations, and landing repair. */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join, isAbsolute, resolve, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isCliDirTrusted, propagateCliTrust } from '../../cli/trust.js';
import { taskTarget } from '../../collectors/job-supersession.js';
import { objectiveLink } from '../../collectors/objectives.js';
import type { JobRow } from '../../collectors/thin-jobs.js';
import { isWorkingForCap, loadConcurrencySettings, capForRole, QUEUE_START_MARKER } from '../../roles/concurrency.js';
import { HarnessSwitchError } from '../../roles/harness-switches.js';
import { jobCallerPane } from '../../roles/job-pane.js';
import { herdrId } from '../../roles/herdr-run.js';
import { MAX_CHECKS, MAX_CHECK_COMMAND } from '../../roles/job-checks.js';
import { withAbstractLock } from '../../utils/abstract-lock.js';
import { watching, ensureQueueWatcher } from '../../roles/notify.js';
import { sharedRoot } from '../../roles/projects.js';
import { readReportMeta, validPreviewPath } from '../../roles/report-meta.js';
import { EXPERIMENT_TAG_MAX_LENGTH } from '../../roles/tool-definitions.js';
import {
  currentPreset, harnessDefaults, readExhausted, isQuotaFailure, markExhausted, describePlace, recordFailureExhaustion,
  type Role, type RolePlace,
} from '../../roles/roster.js';
import { writePrivateFile } from '../../utils/atomic-fs.js';
import { waitUntilFs } from '../../utils/fs-wait.js';
import { procStat } from '../../utils/proc.js';
import {
  beginPrompt, cliWorkerTools, endPrompt, readTurn, saveTurn, REPORT_READ_EXIT, withDonePrompt, workerAlive, turnToken,
} from '../cli-judge.js';
import type { StandingBriefRef } from '../cli-worker-startup.js';
import { defaultImpRoute, impPlacementSettings, pickEvenPreset, repairImpRoute, pickImpRoute } from '../imp-routing.js';
import { clearHeadlessSends, hasHeadlessSends, headlessFollowupReady, readHeadlessSends, writeHeadlessSends } from '../headless-sends.js';
import type { Job, JobRoute, ManagedWorktree, LaunchAttempt, JobStatus, SendOutcome } from '../job-contracts.js';
import { launchThinking, nearestThinking } from '../launch-thinking.js';
import { routingTicketText, ticketObjective } from '../local-tickets.js';
import { reusableWorktree, planWorktree, addWorktree, populateWorktree } from '../managed-worktree.js';
import { callerPane, session, trackCreatedJob } from '../mcp/session-state.js';
import {
  beginTask, taskLabel, registerBatchTask, finishTask, activeTasks, taskFence, extendTask, launchSummary,
  persistTask, sampleTask, releaseTask, batchTasks, supersedeTask, isTaskReply, tasks, needsAttention,
  claimTask, type TaskReply, type HudTask,
} from '../mcp/tasks.js';
import { jobFiles } from '../paths.js';
import { sendHistory, piReportSettlement } from '../pi-read-settlement.js';
import { stopSonic } from '../sonic-process.js';
import { headlessSonicChildren } from '../../worker/sonic-jobs.js';
import { pickSonicThinking } from '../sonic-thinking.js';
import {
  directory, readRow, hudHome, primary, jobs, readCachedStatus, findJob, settled, save, bundled,
  writeCreateStatus, queuePositionsForJobs, jobCache, digestLine, publishWorkSummary, findJobMutable, slice,
} from '../store/job-store.js';
import { keyLock } from '../store/key-lock.js';
import { readTicketQueue } from '../ticket-queue-state.js';
import { DEFAULT_RESUME_S, resumeDeadline, resumeIdentity, closedReport, type NativeResume } from '../worker-resume.js';
import { jobCwd, required, readBriefFile, assembleContext, type Args } from './context.js';
import { dispatchBro } from './harness-bro.js';
import { failCli, dispatchCli, supervisorPid, supervisorAlive, spawnCliSupervisor } from './harness-cli.js';
import { plainSkillName, dispatchPi } from './harness-pi.js';
import {
  piOptionKeys, placementOverrides, hasPiPlacement, roleCwd, registry, launchPlan, harnessSwitchFailure,
  replayOptions, harnessesSourceFor, argsForPlace,
} from './places.js';
import { ensureWatcher, launchError, launchFailure, canTryNext, rejectLaunch, run, refusedBeforeInput, type DispatchResult } from './proc.js';

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
  const launch = { attempts: job.attempts, used_place: job.used_place ?? null, ...(job.headless && { mode: 'headless' }),
    ...(job.route && { route: job.route }) };
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

type SonicParent = Pick<Job, 'job' | 'cwd' | 'project_root' | 'worktree' | 'objective'>;
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

export async function dispatchJob(input: Args, pane: string | undefined, { parent, repair, batch, slotGate, queue, dispatcher }: {
  parent?: SonicParent; repair?: { source: Job; derived: boolean }; batch?: boolean; slotGate?: SlotGate;
  queue?: { id: string; canAdmit: () => boolean }; dispatcher?: Job['dispatcher'];
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
  // An explicit key can retrieve a prior job even when other arguments in the retry differ.
  const requestKey = args.request_key === undefined
    ? derivedKey(retryOf ? 'retry' : 'create', pane, role, cwd, required(args, 'task'), retryOf)
    : required(args, 'request_key');
  const windowedKey = args.request_key === undefined || repair?.derived === true;
  return keyLock(`request:${requestKey}`, () =>
    dispatchWithKey(args, pane, requestKey, windowedKey, parent, repairOf, retryOf ? input : undefined, {
      worktreeSource, batch, slotGate, sourceJob: source ?? repair?.source, ticketQueue: queue?.id, canAdmit: queue?.canAdmit, dispatcher,
    }));
}

export const pendingScouts = new Map<string, AbortController>();
export const scoutedCreates = new Set<Promise<void>>();

async function runCreateScout(target: Job, question: string, contextCwd: string, contextFiles: unknown, signal: AbortSignal): Promise<{ id?: string; failure?: string }> {
  let scout: Job | null = null;
  let discard = false;
  try {
    const result = await dispatchWithKey({ role: 'sonic', task: question, cwd: target.cwd, context_files: contextFiles },
      jobCallerPane(target), `scout:${target.job}`, false, target, undefined, undefined,
      { scoutContextCwd: contextCwd, dispatcher: target.dispatcher });
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

async function dispatchWithKey(args: Args, pane: string | undefined, request_key: string, windowedKey: boolean,
  parent?: Pick<Job, 'job' | 'objective'>, repairOf?: string, retryInput?: Args,
  { scoutContextCwd, landCwd, worktreeSource, batch, slotGate, sourceJob, ticketQueue, canAdmit, dispatcher }: {
    scoutContextCwd?: string; landCwd?: string; worktreeSource?: Job; batch?: boolean; slotGate?: SlotGate; sourceJob?: Job;
    ticketQueue?: string; canAdmit?: () => boolean; dispatcher?: Job['dispatcher'];
  } = {}) {
  const { experiment, arm, preview } = args;
  if (preview !== undefined && !validPreviewPath(preview)) {
    return { ok: false, code: 'invalid_arguments', error: 'preview must be a relative HTML path inside cwd' };
  }
  if (!validExperimentTag(experiment) || !validExperimentTag(arm)) {
    return { ok: false, code: 'invalid_arguments', error: `experiment and arm must each be a string of at most ${EXPERIMENT_TAG_MAX_LENGTH} characters` };
  }
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
  let borrowed: Pick<Job, 'instructions_from' | 'borrowed_instructions'> = {};
  if (args.instructions !== undefined) {
    const from = typeof args.instructions === 'string' ? configured.get(args.instructions) : undefined;
    if (!from || from.optionalEnabled === false) {
      const valid = [...configured.values()].filter(r => r.optionalEnabled !== false).map(r => r.role).sort();
      return { ok: false, code: 'invalid_arguments', error: `Unknown instructions role ${JSON.stringify(args.instructions)}. Valid roles: ${valid.join(', ')}` };
    }
    const name = from.instructions ?? from.role;
    borrowed = { instructions_from: from.role, borrowed_instructions: { name,
      pi_role: from.run.find(p => p.harness === 'pi')?.pi_role ?? name } };
  }
  const now = Date.now();
  const receipts = jobs();
  const existing = receipts.find((job) =>
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
  if (!herdrId(pane)) return { ok: false, code: 'herdr_required' };

  const id = 'j' + randomBytes(8).toString('hex');
  const dir = directory(id);
  const project = found.project();
  const projectRoot = sharedRoot(cwd), parentJob = parent?.job;
  const lineage = parent ?? sourceJob;
  // Missing attribution on an existing job stays missing even if the ticket now links an Objective.
  const objective = lineage ? objectiveLink(lineage.objective) : ticketObjective(cwd, args.ticket, projectRoot);
  const contextCwd = scoutContextCwd ?? cwd;
  const contextFor = (targetArgs: Args, inline: boolean) => assembleContext(targetArgs, contextCwd, inline, project, repairOf);
  const imp = requestedRole === 'imp' || fromImp;
  const settings = imp && !retryInput && !fromImp ? impPlacementSettings(hudHome) : undefined;
  let route: JobRoute | undefined;
  let localContext: Awaited<ReturnType<typeof contextFor>> | undefined;
  if (imp && (retryInput || fromImp)) {
    route = landCwd ? repairImpRoute(chain, sourceJob?.route) : sourceJob?.route;
  } else if (settings?.impPlacement === 'even') {
    const history = receipts.filter(j => (j.overflow_from ?? j.role) === 'imp' && (j.imp_preset ?? j.preset))
      .map(j => ({ ...j, started_at: j.started_at ?? readCachedStatus(j.job).status?.started_at ?? (!j.queued_at && j.used_place ? j.created_at : undefined) }));
    const seed = defaultImpRoute('Fewest imp starts in the last 24 hours', mode);
    const { preset, skipped } = pickEvenPreset(chain.presets?.map(p => p.name) ?? [], settings.impEvenPool, name =>
      launchPlan(found, chain, now, args, routing, onEntry, retryInput, { ...seed, preset: name }).candidates.length > 0, history, now);
    route = { ...seed, placement: 'even', preset: preset ?? currentPreset(chain),
      ...(!preset || skipped.length ? { fallback: [!preset && `Even pool ${skipped.length ? 'unavailable' : 'empty'}; using active preset`,
        skipped.length && `Skipped unavailable presets: ${skipped.join(', ')}`].filter(Boolean).join('; ') } : {}) };
  } else if (imp && settings?.impPlacement !== 'auto') {
    route = { ...defaultImpRoute(settings ? 'Imp routing is off' : 'Imp routing settings unavailable', mode), preset: currentPreset(chain) };
  } else if (imp && chain.routing && settings) {
    localContext = await contextFor(args, false);
    if ('code' in localContext) return localContext;
    const context_files = localContext.contextInputs;
    route = await pickImpRoute(hudHome, settings, chain.routing, task, mode, () => ({
      ticket: routingTicketText(project.root, args.ticket), context_files,
    }));
  }
  const plan = launchPlan(found, chain, now, args, routing, onEntry, retryInput, route, !!landCwd);
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
  let overflowFrom = fromImp ? 'imp' : undefined;
  let inline = false;
  let context: Exclude<Awaited<ReturnType<typeof assembleContext>>, { ok: false }> | undefined;
  let base!: Job;
  let queuedReply: ReturnType<typeof created> | TaskReply | undefined;

  const admit = async () => {
    const stopped = () => canAdmit && !canAdmit();
    if (stopped()) return { ok: false as const, code: 'queue_stopped' };
    let shouldQueue = false;
    if (enforceCap) {
      const concurrency = loadConcurrencySettings();
      const cap = capForRole(concurrency, role);
      const workingByRole = countWorkingByRole();
      if (cap > 0 && (workingByRole.get(role) ?? 0) >= cap) {
        const generalCap = capForRole(concurrency, 'general');
        const generalHasRoom = generalCap === 0 || (workingByRole.get('general') ?? 0) < generalCap;
        if (!ticketQueue && role === 'imp' && concurrency.impOverflow && generalHasRoom && found.roles().has('general')) {
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
        caller_pane: pane,
        created_at: nowIso,
        queued_at: nowIso,
        dispatcher,
        ...(ticketQueue && { ticket_queue: ticketQueue }),
        ...(queuedRoute && { route: queuedRoute }),
        ...((first.route?.mode === 'headless' || args.mode === 'headless') && { headless: true }),
        ...(overflowFrom && { overflow_from: overflowFrom }),
        task_length: task.length,
        ...queuedContext.metadata,
        ...(checks?.length ? { checks } : {}),
        ...(repairOf ? { repair_of: repairOf } : {}),
        ...(retryInput ? { retry_of: required(retryInput, 'retry_of') } : {}),
        ...(scoutQuestion ? { scout_question: scoutQuestion } : {}),
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
        queuedReply = finishTask(taskEntry, queuedJob, true) ?? created(queuedJob, queuedRow);
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
      ...(overflowFrom ? { overflow_from: overflowFrom } : {}),
      request_key,
      cwd: landCwd ?? reusedWorktree?.root ?? cwd,
      project_root: projectRoot,
      ...(preview && { preview }),
      ...(reusedWorktree ? { worktree: reusedWorktree } : {}),
      caller_pane: pane,
      created_at: new Date().toISOString(),
      dispatcher,
      task_length: task.length,
      ...(checks?.length ? { checks } : {}),
      ...(repairOf ? { repair_of: repairOf } : {}),
      ...(retryInput ? { retry_of: required(retryInput, 'retry_of') } : {}),
      ...(landCwd ? { land_turn: request_key } : {}),
      ...(ticketQueue && { ticket_queue: ticketQueue }),
      target_hint: taskTarget(task) || null, // Keep even under another pane; missing means a legacy receipt.
      ...(parentJob ? { parent_job: parentJob } : {}),
      ...(first.route && { route: first.route }),
      ...(role === 'sonic' || first.route?.mode === 'headless' || args.mode === 'headless' ? { headless: true } : {}),
      ...(scoutContextCwd === undefined ? {} : { scout_only: true }),
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

  const harnessesSource = harnessesSourceFor(onName);
  const attempts = base.attempts!;
  const candidates = plan.candidates;
  let scoutTask: HudTask | undefined;
  let scoutResult: Awaited<ReturnType<typeof runCreateScout>> | undefined;
  // Reads can reveal the persisted ID before launch ends; serialize its mutations with launch too.
  const launch = () => keyLock(`job:${id}`, async () => {
    let job = base;
    let result: DispatchResult = launchError('no launch attempted');
    let reason = '';
    let taskEntry: HudTask | undefined;
    let sonicPick: Promise<string | undefined> | undefined;
    for (const { candidate, prepared, effective, route } of candidates) {
      const launchArgs = argsForPlace(args, candidate.place, retryInput);
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
          const picked = await (sonicPick ??= pickSonicThinking(hudHome, task, chain.thinking_choices));
          if (picked !== undefined) place.thinking = picked;
          thinking_source = picked === undefined ? 'default' : 'decision';
        }
      }
      const attempt: LaunchAttempt = { index: candidate.index, place: describePlace(place, candidate.model.value) };
      job = {
        ...base, ...options, place, place_key: candidate.key,
        ...(route && { route, headless: route.mode === 'headless' ? true : undefined }),
        ...(place.harness === 'bro' || role === 'sonic' ? {} : { resume_s: chain.resume_s ?? DEFAULT_RESUME_S }),
        create_options: {
          cwd: landCwd ?? cwd, ...Object.fromEntries(replayOptions.filter((key) => launchArgs[key] !== undefined).map((key) => [key, launchArgs[key]])),
        },
        ...(job.worktree ? { worktree: job.worktree, cwd: job.cwd } : {}),
        ...(place.harness === 'bro' ? { bro: place } : {
          model: candidate.model.value, thinking: place.thinking ?? candidate.thinking.value,
          ...(thinking_source ? { thinking_source } : {}),
          model_source: route ? candidate.model.source : modelOverride !== undefined ? 'hud_create' : onEntry?.model !== undefined ? harnessesSource : candidate.model.source,
        }),
        ...(place.harness === 'cli' ? { cli: {
          agent: place.agent!, can_continue: (effective.harness === 'bro' ? chain.can_continue : effective.can_continue) === true,
          idle_grace_s: (args.idle_grace_s as number | undefined) ?? chain.idle_grace_s ?? 600,
          state_trust: candidate.state_trust ?? 'advisory',
        } } : {}),
      };
      if (imp) job.imp_preset = effective.preset;
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
        if (session.taskClient && !parentJob && !scoutTask) taskEntry = beginTask(job);
        else if (!scoutTask && !job.scout_only) void ensureQueueWatcher(pane, hudHome);
      }
      const launchRole = effective.preset ? { ...chain, skills: place.skills } : chain;
      if (scoutQuestion && attempts.length === 0) {
        fs.rmSync(join(dir, jobFiles.status), { force: true });
        jobCache.invalidateFile(join(dir, jobFiles.status));
      }
      if ('code' in briefContext) result = { ...launchError(briefContext.error ?? 'could not prepare launch context'), preInput: true };
      else result = await launchPlace(job, launchRole, place, dir, task, worktree, briefContext.standing);
      base.launch_agent_args = job.launch_agent_args;
      reason = result.exit_code === 0 ? '' : launchFailure(result).reason;
      if (reason) attempt.reason = reason;
      attempts.push(attempt);
      if (result.exit_code === 0 || (!result.preInput && fs.existsSync(join(dir, jobFiles.status)))) job.used_place = attempt.place;
      if (!canTryNext(job, result)) break;
      save(job);
    }
    if (plan.fallback && canTryNext(job, result) && job.route?.tier !== 'standard')
      job.route = plan.fallback;
    const launchRow = finishLaunch(job, dir, result, reason, !scoutQuestion);
    if (scoutTask && activeTasks.get(id) === scoutTask && scoutTask.view.status === 'working' && jobCallerPane(job) === scoutTask.pane) {
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
  writeBrief({ ...base, place: candidates[0].candidate.place }, dir, task, context!.block, true);
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
  const reply = batch ? created(base, scoutRow) : (finishTask(scoutTask, base, true) ?? created(base, scoutRow));
  const controller = new AbortController();
  pendingScouts.set(id, controller);
  const creating = (async () => {
    try {
      // Keep worktree creation behind the same trust gate as ordinary worktree dispatch.
      if (worktree && !base.worktree && candidates.some(({ candidate: { place }, prepared }) => !('code' in prepared) &&
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
      if (scoutTask && activeTasks.get(id) === scoutTask && scoutTask.view.status === 'working' && jobCallerPane(latest) === scoutTask.pane) {
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
    const modelOverride = typeof args.model === 'string' ? args.model : undefined;
    const plan = launchPlan(found, chain, now, args, routing, onEntry, retryInput, existing.route);
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
    const base: Job = { ...existing, role, ...(role === 'sonic' ? { headless: true } : {}), attempts: [], launcher: launcherId() };
    const project = found.project();
    const contextFor = (targetArgs: Args, inline: boolean) => assembleContext(targetArgs, cwd, inline, project, existing.repair_of);
    const inline = first.prepared.place.harness === 'bro';
    const context = await contextFor(args, inline);
    if ('code' in context) return failQueued(context.error ?? context.code ?? 'invalid_arguments', context.code === 'invalid_arguments' ? 'invalid_arguments' : undefined);

    const scoutQuestion = existing.scout_question;
    const leaveQueue = () => {
      fs.rmSync(join(dir, jobFiles.status), { force: true });
      jobCache.invalidateFile(join(dir, jobFiles.status));
      save(base);
    };
    // The watcher's scan is a scheduling hint; another process can admit a create before we launch.
    const reserved = await withAbstractLock('concurrency', hudHome, () => {
      if (readCachedStatus(id).status?.state !== 'queued') return false;
      const cap = capForRole(loadConcurrencySettings(), role);
      if (cap && (countWorkingByRole().get(role) ?? 0) >= cap) return false;
      if (scoutQuestion) {
        base.scout_state = 'scouting';
        save(base);
        writeCreateStatus(dir, { state: 'working', role, reason: 'scouting' });
      } else leaveQueue();
      return true;
    }, { timeoutMs: 10_000 });
    if (!reserved) return { started: false };
    let scoutResult: Awaited<ReturnType<typeof runCreateScout>> | undefined;
    if (scoutQuestion) {
      const controller = new AbortController();
      if (worktree && !base.worktree && plan.candidates.some(({ candidate: { place }, prepared }) => !('code' in prepared) &&
        (place.harness === 'pi' || (place.harness === 'cli' && isCliDirTrusted(place.agent!, worktree!.main_root))))) {
        await prepareWorktree(base, worktree);
      }
      if (!worktree || base.worktree) {
        scoutResult = await runCreateScout(base, scoutQuestion, cwd, context.metadata.context_files, controller.signal);
      }
    }

    if (scoutQuestion) leaveQueue();

    const harnessesSource = harnessesSourceFor(onName);
    const attempts = base.attempts!;
    const candidates = plan.candidates;
    let job = base;
    let result: DispatchResult = launchError('no launch attempted');
    let reason = '';
    let sonicPick: Promise<string | undefined> | undefined;
    for (const { candidate, prepared, effective, route } of candidates) {
      const launchArgs = argsForPlace(args, candidate.place, retryInput);
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
          const picked = await (sonicPick ??= pickSonicThinking(hudHome, task, chain.thinking_choices));
          if (picked !== undefined) place.thinking = picked;
          thinking_source = picked === undefined ? 'default' : 'decision';
        }
      }
      const attempt: LaunchAttempt = { index: candidate.index, place: describePlace(place, candidate.model.value) };
      job = {
        ...base, ...options, place, place_key: candidate.key,
        ...(route && { route, headless: route.mode === 'headless' ? true : undefined }),
        ...(place.harness === 'bro' || role === 'sonic' ? {} : { resume_s: chain.resume_s ?? DEFAULT_RESUME_S }),
        create_options: {
          cwd, ...Object.fromEntries(replayOptions.filter((key) => launchArgs[key] !== undefined).map((key) => [key, launchArgs[key]])),
        },
        ...(job.worktree ? { worktree: job.worktree, cwd: job.cwd } : {}),
        ...(place.harness === 'bro' ? { bro: place } : {
          model: candidate.model.value, thinking: place.thinking ?? candidate.thinking.value,
          ...(thinking_source ? { thinking_source } : {}),
          model_source: route ? candidate.model.source : modelOverride !== undefined ? 'hud_create' : onEntry?.model !== undefined ? harnessesSource : candidate.model.source,
        }),
        ...(place.harness === 'cli' ? { cli: {
          agent: place.agent!, can_continue: (effective.harness === 'bro' ? chain.can_continue : effective.can_continue) === true,
          idle_grace_s: (args.idle_grace_s as number | undefined) ?? chain.idle_grace_s ?? 600,
          state_trust: candidate.state_trust ?? 'advisory',
        } } : {}),
      };
      if (launchRoleName === 'imp') job.imp_preset = effective.preset;
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
      const launchRole = effective.preset ? { ...chain, skills: place.skills } : chain;
      if ('code' in briefContext) result = { ...launchError(briefContext.error ?? 'could not prepare launch context'), preInput: true };
      else result = await launchPlace(job, launchRole, place, dir, task, worktree, briefContext.standing, { callerToken: existing.created_at });
      base.launch_agent_args = job.launch_agent_args;
      reason = result.exit_code === 0 ? '' : launchFailure(result).reason;
      if (reason) attempt.reason = reason;
      attempts.push(attempt);
      if (result.exit_code === 0 || (!result.preInput && fs.existsSync(join(dir, jobFiles.status)))) job.used_place = attempt.place;
      if (!canTryNext(job, result)) break;
      save(job);
    }
    if (plan.fallback && canTryNext(job, result) && job.route?.tier !== 'standard')
      job.route = plan.fallback;
    finishLaunch(job, dir, result, reason, false);
    return { started: result.exit_code === 0, ...(result.exit_code !== 0 ? { failed: true, reason } : {}) };
  });
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
  if (place.harness === 'cli') return dispatchCli(job, place, instructionsPath, task, definition.mcp_servers ?? [], standingBrief, options);
  if (place.harness === 'pi') return dispatchPi(job, definition, place, task, resume);
  try { return await dispatchBro(job, task); }
  catch (error) { return launchError(String(error)); }
}

function finishLaunch(job: Job, dir: string, result: DispatchResult, reason: string, advanceCursor = true): JobRow | undefined {
  job.dispatch_exit_code = result.exit_code;
  if (job.used_place && job.imp_preset !== undefined) job.started_at = readCachedStatus(job.job).status?.started_at ?? new Date().toISOString();
  if (result.code) job.dispatch_code = result.code;
  if (result.path) job.dispatch_path = result.path;
  const failure = result.exit_code === 0 ? null : launchFailure(result);
  job.stderr_tail = failure?.stderr_tail ?? result.stderr;
  const statusFile = join(dir, jobFiles.status);
  if (failure && (result.preInput || !fs.existsSync(statusFile))) {
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
      exit_reason: failure.code,
      error: outcome.reason,
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
  matchKey: string, explicitKey: string | undefined, land: boolean, batch: boolean, answerRequest?: string, automatic = false) {
  const dir = directory(current.job);
  return withReopenLock(dir, async () => {
    const latest = findJob(current.job);
    const fresh = readCachedStatus(current.job).status;
    const expected = answerRequest ? 'waiting_orchestrator' : automatic ? status.state : 'closed';
    if (!latest || latest.reaped_at !== current.reaped_at || !fresh || fresh.ended_at !== status.ended_at ||
        fresh.state !== expected || fresh.pid !== status.pid)
      return { ok: false, code: 'worker_reopening' };
    const pending = latest.headless ? readHeadlessSends(dir) : [];
    if (pending.length && !automatic && !answerRequest) return { ok: false, code: 'worker_reopening' };
    if (automatic && !pending.length) return;
    const result = await reopenJob(latest, fresh, row, message, matchKey, explicitKey, land, batch, answerRequest, automatic, pending);
    if (automatic && !result && !fs.existsSync(join(dir, jobFiles.stopRequested)))
      writeCreateStatus(dir, { ...fresh, state: 'failed', exit_reason: 'Could not resume queued headless sends' });
    return result;
  });
}

async function reopenJob(current: Job, status: JobStatus, row: JobRow, message: string,
  matchKey: string, explicitKey: string | undefined, land: boolean, batch: boolean, answerRequest: string | undefined,
  automatic: boolean, pending: ReturnType<typeof readHeadlessSends>) {
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
    headless_task_fence: automatic ? taskFence(current) : undefined,
    send_outcomes: [...(current.send_outcomes ?? []), ...delivered, ...(automatic ? [] : [outcome])] };
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
  if (pending.length) message = [message, ...pending.map(({ text }) => text)].filter(Boolean).join('\n\n');
  // A previous runner's in-memory ready watches ended with its turn. Carry the facts,
  // not the report bodies, into the native continuation; hud_sonic wait still collects.
  if (current.headless) {
    for (const child of headlessSonicChildren(dir)) if (!fs.existsSync(join(child.dir, 'sonic-collected'))) {
      message += `\n\nSonic ${child.id} ${child.state === 'open' ? 'still running' : child.state}. Collect its result with hud_sonic (wait: ["${child.id}"]).`;
    }
  }
  const taskEntry = session.taskClient && !land && !carryTask ? beginTask(next, row.report_mtime, answerRequest) : undefined;
  // The reaper has finished. Retire its CLI tab and supervisor before any scan can
  // pair their closure with the new working status. Dispatch publishes fresh receipts.
  const pidFile = join(dir, jobFiles.supervisorPid);
  const tabCli = current.cli && !current.headless;
  const priorPid = tabCli ? jobCache.readPid(pidFile) : null;
  if (tabCli) {
    fs.rmSync(pidFile, { force: true });
    fs.unlinkSync(join(dir, jobFiles.session));
  }
  writeCreateStatus(dir, { state: 'working' });
  save(next, true);
  const result = await launchPlace(next, role, place, dir, message, undefined, undefined, { resume: { ...identity, message } });
  if (result.preInput && !result.cleanupFailed) {
    if (answerFile) { fs.unlinkSync(answerFile); jobCache.invalidateQa(id); }
    if (priorTurn) saveTurn(dir, priorTurn);
    const touched = findJob(id);
    save({ ...current, read_at: touched?.read_at ?? current.read_at, observed_at: touched?.observed_at ?? current.observed_at }, true);
    writeCreateStatus(dir, status);
    if (priorSession) writePrivateFile(join(dir, jobFiles.session), priorSession.text, { mkdir: false });
    if (priorPid !== null) writePrivateFile(pidFile, `${priorPid}\n`, { mkdir: false });
    if (taskEntry) releaseTask(taskEntry);
    return;
  }
  const latest = findJobMutable(id) ?? next;
  const recorded = latest.send_outcomes?.find((attempt) => attempt.key === key) ?? outcome;
  recorded.exit_code = result.exit_code;
  const failure = result.exit_code === 0 ? null : launchFailure(result);
  recorded.stderr_tail = failure?.stderr_tail ?? result.stderr;
  if (failure && result.preInput) { // The failed launch still owns a tab; let the watcher retry cleanup.
    writeCreateStatus(dir, { ...result.status, state: 'failed', exit_reason: failure.code, error: failure.reason, ended_at: new Date().toISOString() });
  }
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
  if (current.role === 'sonic') return { ok: false, code: 'not_continuable' };
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
  if (!land && !queued) delete current.ticket_queue;
  (current.send_outcomes ??= []).push(outcome);
  save(current);
  // Read the rollback baseline at mutation time, with no pane query between it and the write.
  const submission = current.cli ? await beginPrompt(dir, { send: { key, pid: process.pid, start: procStat(process.pid)?.start ?? null } }) : null;
  const turn = submission?.turn;
  const taskEntry = session.taskClient && !workingOnly && !land && !carryTask
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
