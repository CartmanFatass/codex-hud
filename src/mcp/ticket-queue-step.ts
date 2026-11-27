/** Ticket-queue workflow steps on the workflow driver. Job, review, lead and land receipts fence every effect. */
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { readObjectives } from '../collectors/objectives.js';
import { failedAttempt } from '../collectors/thin-jobs.js';
import { readDone, readTurn, receiptForTurn } from '../roles/cli-turn.js';
import { checkBinding, CHECK_TIMEOUT_MS, readCheckReceipt, sameChecks } from '../roles/job-checks.js';
import { sharedRoot } from '../roles/projects.js';
import { cachedReportSignature, readReportMeta } from '../roles/report-meta.js';
import { roleRegistry } from '../roles/roster.js';
import { readFileBounded, readJsonFile } from '../utils/atomic-fs.js';
import { isProcAlive } from '../utils/proc.js';
import { SAFE_GIT_ARGS, safeGitEnv } from '../utils/git-safety.js';
import { storedTicket } from '../tickets/store.js';
import { openRunTickets, ticketClosed, type OwnerApproval } from '../unattended/state.js';
import { driveWorkflow } from '../workflows/driver.js';
import type { Run, Tick } from '../workflows/engine.js';
import type { Graph, Step } from '../workflows/graph.js';
import { directRecipient } from '../workflows/scope.js';
import { freezeGraph, runDir, runLock, stopRequested } from '../workflows/store.js';
import { dispatchJob, dispatchTicketJob } from './dispatch/orchestrator.js';
import type { Job, JobStatus } from './job-contracts.js';
import { activeLand, landAttempt, landOutcome, readLand, retryableLand, SPEC_CHANGE_REFUSAL } from './land-state.js';
import { startLand, validLandConfig } from './land.js';
import {
  checkTicketPaths, recordUnattendedAcceptance, ticketApprovedRemovals, ticketObjectiveOwner, ticketReadiness,
} from './local-tickets.js';
import { BUNDLED_ROOT, jobFiles } from './paths.js';
import { piReportSettlement } from './pi-read-settlement.js';
import { directory, findJob, hudHome, jobCache, jobs, readRow } from './store/job-store.js';
import { resumeTicketEdits, stopTicketEdits } from './ticket-edit-queue.js';
import { ensureJobWatcher } from './watch-pid.js';
import {
  blockerHandbackItem, clearItemHold, prepareTicketQueueRepair, readTicketQueue, syncBlockerHandback,
  ticketQueueNotice, writeTicketQueue,
  type TicketHandback, type TicketHandbackKind, type TicketQueue, type TicketQueueItem,
} from './ticket-queue-state.js';
import {
  appendTodos, applyLeadQuestionAnswer, assumptionOwnerApproval, buildAcceptPacket, buildAssumptionPacket,
  buildQuestionPacket, buildRemovalAmbiguityPacket, buildReviewBrief, closeLeadJob, extractAssumedLines,
  extractRemovalsDeclaration, extractReportNotes, MAX_ANSWER_RETRIES, parseLeadReport,
  recordDecision, WORKFLOW_WORKER_RULE, WORKFLOW_WORKER_RULE_NO_ASK,
} from './workflow-lead.js';

const cleanStates = ['idle_grace', 'done', 'closed'];
const LAUNCH_GRACE_MS = 120_000, LAUNCH_RECHECK_MS = 5_000, ANSWER_RETRY_MS = 1_000;
const errorLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0];
const owner = (q: TicketQueue, item: TicketQueueItem) => item.dispatch_queue ?? q.flow;
const requestKey = (q: TicketQueue, item: TicketQueueItem) => `ticket-queue:${owner(q, item)}:${item.ticket}`;
const receiptFor = (q: TicketQueue, item: TicketQueueItem) => jobs().find(job => job.request_key === requestKey(q, item));
const livePane = (q: TicketQueue) => q.pane && directRecipient(q) ? q.pane : undefined;
const trustDispatchFailed = (job: Job, status: JobStatus | null | undefined) =>
  status?.exit_reason === 'untrusted_cwd' || job.dispatch_code === 'untrusted_cwd';
const leadEnabled = (root: string) =>
  roleRegistry(hudHome, root, process.env, undefined, undefined, BUNDLED_ROOT).roles().has('lead');

function ticketHeader(path: string) {
  return readFileBounded(path, 64 * 1024).bytes.toString('utf8').split(/^## Comments[ \t]*\r?$/m, 1)[0];
}
function declaredReport(dir: string, job: Job, status: JobStatus) {
  if (status.output_written !== true) return null;
  const sig = cachedReportSignature(dir);
  if (!sig) return null;
  if (!job.cli) return piReportSettlement(dir, job, status) ? sig : null;
  const turn = readTurn(dir), done = readDone(dir);
  return turn && receiptForTurn(turn, done) && done.report_sig === sig &&
    Date.parse(status.settled_at ?? '') >= Date.parse(turn.sent_at) ? sig : null;
}

function assumptionTrigger(assumed: string[], scopeAssumptions: string[]) {
  if (scopeAssumptions.length) return `scope assumption in report: ${scopeAssumptions[0]}`;
  if (assumed.length > 3) return `report has ${assumed.length} Assumed: lines (limit 3)`;
}

const commitSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
function resolveCommit(cwd: string, ref: string) {
  const res = spawnSync('git', [...SAFE_GIT_ARGS, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
    cwd, env: safeGitEnv(process.env), encoding: 'utf8', timeout: 5000,
  });
  const sha = res.status === 0 ? res.stdout?.trim() : undefined;
  return sha && commitSha.test(sha) ? sha : undefined;
}

function verifiedSourceHead(job: Job) {
  return job.worktree && resolveCommit(job.worktree.root, 'HEAD');
}

function milestoneReviewRange(q: TicketQueue): Job['reviewed'] {
  if (!q.start_head || !commitSha.test(q.start_head)) return;
  const base = resolveCommit(q.root, q.start_head);
  const head = base && resolveCommit(q.root, 'HEAD');
  if (base && head) return { base, head };
}

type SettlementVerdict = { assumed?: string[]; tries?: string[] } & (
  | { ok: true; assumed: string[]; blockers: string[]; trigger?: string; sig: string; reportText: string }
  | { waitMs: number }
  | { kind: TicketHandbackKind; reason: string; assumption?: TicketHandback['assumption'] }
);

function judgeSettlement(root: string, item: TicketQueueItem, job: Job, status: JobStatus, deferAssumptions: boolean): SettlementVerdict {
  const dir = directory(job.job);
  const sig = declaredReport(dir, job, status);
  if (!sig) return { kind: 'worker', reason: 'settled without a declared report for this turn' };
  const report = readFileBounded(join(dir, jobFiles.report), 1024 * 1024);
  if (report.truncated) return { kind: 'worker', reason: 'report is too large to verify' };
  const text = report.bytes.toString('utf8');
  const { lines: assumed, scopeAssumptions } = extractAssumedLines(text);
  const { blockers, tries } = extractReportNotes(text);
  const notes = { assumed, tries };
  const trigger = assumptionTrigger(assumed, scopeAssumptions);
  if (!blockers.length && trigger && !deferAssumptions) {
    const head = verifiedSourceHead(job);
    if (!head || item.approved_assumptions_head !== head || item.approved_assumptions_sig !== sig) {
      return { kind: 'assumption', reason: trigger, ...notes, ...(head && { assumption: { head, report_sig: sig } }) };
    }
  }
  if (readReportMeta(dir, sig)?.skip_checks_reason) return { kind: 'check', reason: 'worker checks were skipped', ...notes };
  const stored = storedTicket(root, item.ticket);
  if (stored ? stored.record?.main_review : /(?:^|·)[ \t]*\*\*Main review:\*\*[ \t]*yes\b/im.test(ticketHeader(item.path)))
    return { kind: 'review', reason: 'ticket is marked for main review', ...notes };
  if (job.checks?.length) {
    const binding = checkBinding(dir, job, status);
    if (!binding) return { kind: 'check', reason: 'HUD check binding unavailable', ...notes };
    const receipt = readCheckReceipt(dir), current = receipt && sameChecks(binding, receipt);
    if (current && receipt.results.some(result => result.exit_code !== 0)) return { kind: 'check', reason: 'HUD checks failed', ...notes };
    if (!current || receipt.state !== 'done') {
      const since = current ? fs.statSync(join(dir, jobFiles.checks), { throwIfNoEntry: false })?.mtimeMs : undefined;
      const left = (since ?? Date.parse(status.settled_at!)) + job.checks.length * CHECK_TIMEOUT_MS + 5000 - Date.now();
      return left <= 0 ? { kind: 'check', reason: 'HUD check results unavailable', ...notes } : { waitMs: Math.min(left, LAUNCH_RECHECK_MS), ...notes };
    }
    if (receipt.results.length !== job.checks.length) return { kind: 'check', reason: 'HUD check results incomplete', ...notes };
  }
  return { ok: true, ...notes, blockers, trigger, sig, reportText: text };
}

type GateResult =
  | { kind: 'pass'; head: string }
  | { kind: 'ambiguous'; head: string; detail: string }
  | { kind: 'hold'; reason: string; ownerApproval?: OwnerApproval }
  | { kind: 'fail'; problemKind: TicketHandbackKind; reason: string };

/** Deterministic pre-land gates for unattended runs:
 *  1. Verified source commit HEAD.
 *  2. Deterministic docs/spec.md diff check against base branch (in addition to publication-time check).
 *  3. Explicit Removes: declaration in the settled report compared with ticket Approved removals:.
 *     Missing line = hold (never none). Declared ambiguity goes to a temporary lead. */
function checkUnattendedGates(
  q: TicketQueue,
  item: TicketQueueItem,
  job: Job,
  sig: string,
  reportText: string,
): GateResult {
  const head = verifiedSourceHead(job);
  if (!head) {
    return { kind: 'fail', problemKind: 'worker', reason: 'Verified worker commit unavailable' };
  }
  let base: string;
  try { base = validLandConfig(hudHome, q.root).base; }
  catch (error) { return { kind: 'fail', problemKind: 'land', reason: errorLine(error) }; }
  const specDiff = spawnSync('git', [...SAFE_GIT_ARGS, 'diff', '--name-only', '--no-renames', `refs/heads/${base}...${head}`, '--', 'docs/spec.md'], {
    cwd: q.root, env: safeGitEnv(process.env), encoding: 'utf8', timeout: 5000,
  });
  if (specDiff.status !== 0) {
    return { kind: 'fail', problemKind: 'land', reason: 'Cannot verify docs/spec.md diff before landing' };
  }
  if (specDiff.stdout.trim()) {
    return { kind: 'hold', ownerApproval: 'spec-change', reason: SPEC_CHANGE_REFUSAL };
  }
  const decl = extractRemovalsDeclaration(reportText);
  if (decl.kind === 'missing') {
    return { kind: 'hold', ownerApproval: 'feature-deletion', reason: 'Worker report is missing required Removes: declaration' };
  }
  if (decl.kind === 'ambiguous') {
    if (item.approved_head !== head || item.approved_report_sig !== sig) {
      return { kind: 'ambiguous', head, detail: decl.detail };
    }
  } else if (decl.kind === 'named') {
    const approved = new Set(ticketApprovedRemovals(item.path, q.root, item.ticket));
    const unapproved = decl.items.filter(entry => !approved.has(entry));
    if (unapproved.length) {
      return { kind: 'hold', ownerApproval: 'feature-deletion', reason: `Unapproved removal declared: ${unapproved.join(', ')}` };
    }
  }
  return { kind: 'pass', head };
}

export interface TicketProblem {
  kind: TicketHandbackKind;
  reason: string;
  step?: string;
  ticket?: string;
  job?: string;
  question?: string;
  land?: string;
  ownerApproval?: OwnerApproval;
  assumption?: TicketHandback['assumption'];
}

function recordUnclosedLead(q: TicketQueue, jobId: string, reason: string) {
  (q.unclosed_leads ??= []).push({ job: jobId, reason, at: new Date().toISOString() });
}

function holdItem(
  item: TicketQueueItem,
  reason: string,
  kind?: TicketHandbackKind,
  ownerApproval?: OwnerApproval,
  evidence?: { head?: string; report_sig?: string; request_id?: string },
) {
  delete item.approved_assumptions_head;
  delete item.approved_assumptions_sig;
  const at = new Date().toISOString();
  item.held = {
    reason, at,
    ...(kind && { kind }),
    ...(ownerApproval && { owner_approval: ownerApproval }),
    ...(evidence?.head && { head: evidence.head }),
    ...(evidence?.report_sig && { report_sig: evidence.report_sig }),
    ...(evidence?.request_id && { request_id: evidence.request_id }),
  };
  item.changed_at = at;
}

function heldResolutionReason(item: TicketQueueItem) {
  const detail = item.held?.reason ? ` (${item.held.reason.slice(0, 140)})` : '';
  return `${item.ticket}${item.job ? ` (${item.job})` : ''} stays held${detail} — manual resolution required: worker correction, hud_land, or stop`;
}

function heldItemChanged(item: TicketQueueItem): boolean {
  const held = item.held;
  if (!held || !item.job || (!held.head && !held.report_sig)) return false;
  const job = findJob(item.job);
  if (!job) return false;
  const dir = directory(job.job);
  const { row, status } = readRow(job, false, null);
  const currentHead = verifiedSourceHead(job);
  if (held.head && currentHead && currentHead !== held.head) return true;
  if (status && cleanStates.includes(status.state)) {
    const currentSig = declaredReport(dir, job, status);
    return Boolean(held.report_sig && currentSig !== held.report_sig);
  }
  return status
    ? !failedAttempt(row) && row.state !== 'stopped' && !fs.existsSync(join(dir, jobFiles.stopRequested))
    : job.dispatch_exit_code === null;
}

function heldBlockProblem(q: TicketQueue, step: string): TicketProblem | undefined {
  if (q.unattended) return undefined;
  const held = q.tickets.find(t => t.held && !t.held.request_id);
  if (!held) return undefined;
  return {
    kind: 'escalate', step, ticket: held.ticket, job: held.job,
    ownerApproval: held.held!.owner_approval, reason: heldResolutionReason(held),
  };
}

function failItem(item: TicketQueueItem, reason: string, kind?: TicketHandbackKind) {
  const at = new Date().toISOString();
  item.failed = { reason, at, ...(kind && { kind }) };
  item.changed_at = at;
}

function holdRun(q: TicketQueue, reason: string, kind?: TicketHandbackKind, ownerApproval?: OwnerApproval) {
  q.held = { reason, at: new Date().toISOString(), ...(kind && { kind }), ...(ownerApproval && { owner_approval: ownerApproval }) };
}

function objectiveWorkset(home: string, q: TicketQueue) {
  const { root, flow, unattended } = q;
  const objective = unattended!.objective;
  const objectives = readObjectives(root)?.objectives ?? [];
  const selected = objectives.find(o => o.id === objective && o.state === 'active');
  if (!selected) return { tickets: [], queued: [], blocked: [], future: [] };
  const excluded = openRunTickets(home, root, flow);
  for (const item of q.tickets) if (item.failed || item.held) excluded.add(item.ticket);
  const readiness = ticketReadiness(root, jobCache, undefined, { home, excludeTickets: excluded });
  const belongs = (t: { ticket: string; objective?: string }) => ticketObjectiveOwner(objectives, t.ticket, t.objective) === objective;
  return {
    tickets: readiness.tickets.filter(belongs),
    queued: readiness.queued.filter(belongs),
    blocked: readiness.blocked.filter(belongs),
    future: readiness.future.filter(t => !excluded.has(t.ticket) && belongs(t)),
  };
}

function computeRemaining(q: TicketQueue): string[] {
  return q.tickets.flatMap(item => {
    if (!item.job) item.job = receiptFor(q, item)?.job;
    if (!item.job || item.landed || item.held || item.failed) return [];
    const land = item.land ? readLand(hudHome, item.land) : landAttempt(hudHome, item.job).prior;
    if (land) return activeLand(land) ? [`${item.ticket} (${land.flow}${land.repairs?.at(-1)?.job ? `, ${land.repairs.at(-1)!.job}` : ''})`] : [];
    const job = findJob(item.job), state = job && readRow(job, false, null).row.state;
    return !state || ![...cleanStates, 'failed', 'stopped'].includes(state) ? [`${item.ticket} (${item.job})`] : [];
  });
}

function terminalNotice(q: TicketQueue, keyPrefix: 'end' | 'pause' = 'end') {
  return q.task ? {} : { [`${keyPrefix}-${q.epoch ?? 0}`]: ticketQueueNotice(q).replace(/\r?\n/g, ' | ') };
}

function pauseNotice(q: TicketQueue) {
  return { [`pause-${q.epoch ?? 0}`]: ticketQueueNotice(q).replace(/\r?\n/g, ' | ') };
}

/** Hand-back settlement for ticket-queue problems:
 * - assumption / blocker report gate: leaves the step asking, pauses the run, records pause-<epoch> in notices, and wakes main once.
 * - escalate / unattended run hold: pauses the run, records pause-<epoch> in notices, and wakes main once.
 * - other problems (land/check/worker/dispatch/to:main question): failed receipt with terminal notice. */
export function settleTicketHandback(q: TicketQueue, problem?: TicketProblem) {
  const step = problem?.step ?? q.handback?.step ?? 'tickets';
  if (problem?.reason && !q.reason) q.reason = problem.reason;
  const setAsking = () => {
    q.steps ??= {};
    q.steps[step] = {
      state: 'asking',
      ...(problem?.reason ? { reason: problem.reason } : q.reason ? { reason: q.reason } : {}),
      changed_at: new Date().toISOString(),
    };
  };
  q.queued = undefined;
  q.remaining = computeRemaining(q);
  if (q.unattended && (q.held || problem?.ownerApproval || problem?.kind === 'blocker' || problem?.kind === 'escalate')) {
    const manual = Boolean(q.held || problem?.ownerApproval);
    q.handback = {
      step,
      choices: manual ? ['manual'] : ['resume', 'stop'],
      ...(problem && {
        kind: problem.kind,
        ...(problem.ticket && { ticket: problem.ticket }),
        ...(problem.job && { job: problem.job }),
        ...(problem.question && { question: problem.question }),
        ...(problem.land && { land: problem.land }),
        ...(problem.ownerApproval && { owner_approval: problem.ownerApproval }),
        ...(problem.assumption && { assumption: problem.assumption }),
      }),
    };
    if (!manual && (problem?.kind === 'blocker' || problem?.kind === 'assumption')) setAsking();
    q.state = 'paused';
    q.notices = pauseNotice(q);
    return;
  }
  if (q.unattended) {
    delete q.handback;
    q.state = 'failed';
    q.notices = terminalNotice(q);
    return;
  }
  q.handback = {
    step,
    choices: ['resume', 'stop'],
    ...(problem && {
      kind: problem.kind,
      ...(problem.ticket && { ticket: problem.ticket }),
      ...(problem.job && { job: problem.job }),
      ...(problem.question && { question: problem.question }),
      ...(problem.land && { land: problem.land }),
      ...(problem.ownerApproval && { owner_approval: problem.ownerApproval }),
      ...(problem.assumption && { assumption: problem.assumption }),
    }),
  };
  if (problem?.kind === 'assumption' || problem?.kind === 'blocker') {
    setAsking();
    q.state = 'paused';
    q.notices = pauseNotice(q);
    return;
  }
  if (problem?.kind === 'escalate') {
    q.state = 'paused';
    q.notices = pauseNotice(q);
    return;
  }
  q.state = 'failed';
  q.notices = terminalNotice(q, 'end');
}

function recoverTicketQueue(q: TicketQueue) {
  // A crash between admission and the queue update does not issue a second create.
  for (const item of q.tickets) if (!item.job) item.job = receiptFor(q, item)?.job;
}

function launchRecheckMs(job: Job): number {
  return job.launcher ? (isProcAlive(job.launcher.pid, job.launcher.start) ? LAUNCH_RECHECK_MS : 0)
    : Math.max(0, Date.parse(job.created_at) + LAUNCH_GRACE_MS - Date.now());
}

const isTerminalDeliveryError = (reason?: string) =>
  reason === 'job_not_found' || reason === 'question_not_open';

function tickPendingAnswer(q: TicketQueue, state: { problem?: TicketProblem }): Tick | null {
  const pending = q.pending_answer;
  if (!pending) return null;
  const flowId = q.flow;
  return { state: 'running', changed: false, effect: async () => {
    const delivery = await applyLeadQuestionAnswer(pending.worker_job, pending.question, pending.answer);
    let nextWait = 0;
    await runLock(hudHome, flowId, () => {
      const cur = readTicketQueue(hudHome, flowId);
      if (!cur || cur.state !== 'working') return;
      if (delivery.ok) {
        const at = new Date().toISOString();
        recordDecision(cur, {
          step: pending.step, kind: 'question', job: pending.lead_job, worker_job: pending.worker_job,
          decision: 'answer', at,
          ...(pending.ticket && { ticket: pending.ticket }),
          question: pending.question,
        });
        if (pending.ticket) {
          const entry = cur.tickets.find(t => t.ticket === pending.ticket);
          if (entry) { entry.answered_at = at; entry.changed_at = at; }
        }
        delete cur.pending_answer;
        writeTicketQueue(hudHome, cur);
        return;
      }
      const attempts = pending.attempts + 1;
      if (!isTerminalDeliveryError(delivery.reason) && attempts < MAX_ANSWER_RETRIES) {
        cur.pending_answer = { ...pending, attempts, last_error: delivery.reason };
        writeTicketQueue(hudHome, cur);
        nextWait = ANSWER_RETRY_MS;
        return;
      }
      const why = `question ${pending.question} answer delivery failed (${delivery.reason})`;
      recordDecision(cur, {
        step: pending.step, kind: 'question', job: pending.lead_job, worker_job: pending.worker_job,
        decision: 'delivery_failed', reason: why, at: new Date().toISOString(),
        ...(pending.ticket && { ticket: pending.ticket }),
        question: pending.question,
      });
      delete cur.pending_answer;
      if (cur.unattended && pending.ticket) {
        const entry = cur.tickets.find(t => t.ticket === pending.ticket);
        if (entry) holdItem(entry, why, 'question');
      } else {
        if (cur.unattended) holdRun(cur, `${pending.step} (${pending.worker_job}): ${why}`, 'question');
        state.problem = {
          kind: 'escalate', step: pending.step, ticket: pending.ticket, job: pending.worker_job,
          question: pending.question, reason: `${pending.ticket ?? pending.step} (${pending.worker_job}): ${why}`,
        };
      }
      writeTicketQueue(hudHome, cur);
    });
    return nextWait;
  } };
}

function tickQuestionLead(q: TicketQueue, state: { problem?: TicketProblem }): Tick | null {
  const retryTick = tickPendingAnswer(q, state);
  if (retryTick) return retryTick;

  const active = q.active_lead;
  if (!active || active.kind !== 'question') return null;
  const leadJob = findJob(active.job);
  const flowId = q.flow;
  const label = active.ticket ?? active.step;
  const escalateProblem = (reason: string, ownerApproval?: OwnerApproval): TicketProblem => ({
    kind: 'escalate', step: active.step, ticket: active.ticket, job: active.worker_job, question: active.question, reason, ownerApproval,
  });
  const applyHoldOrEscalate = (cur: TicketQueue, why: string, kind: TicketHandbackKind, ownerApproval?: OwnerApproval) => {
    if (cur.unattended && active.ticket) {
      const entry = cur.tickets.find(t => t.ticket === active.ticket);
      if (entry) { holdItem(entry, why, kind, ownerApproval); return; }
    }
    if (cur.unattended) holdRun(cur, `${label} (${active.worker_job}): ${why}`, kind, ownerApproval);
    state.problem = escalateProblem(`${label} (${active.worker_job}): ${why}`, ownerApproval);
  };
  if (!leadJob) {
    delete q.active_lead;
    if (q.unattended && active.ticket) {
      const entry = q.tickets.find(t => t.ticket === active.ticket);
      if (entry) { holdItem(entry, `question lead (${active.job}) receipt missing`, 'question'); return { state: 'running', changed: true }; }
    }
    if (q.unattended) holdRun(q, `question lead (${active.job}) receipt missing`, 'question');
    state.problem = escalateProblem(`question lead (${active.job}) receipt missing`);
    return { state: 'failed', reason: state.problem.reason, changed: true };
  }
  const { row, status } = readRow(leadJob, false, null);
  const failed = failedAttempt(row) || row.state === 'stopped' || fs.existsSync(join(directory(leadJob.job), jobFiles.stopRequested));
  if (failed) {
    const why = row.reason ?? row.display_state;
    return { state: 'running', changed: false, effect: async () => {
      const closeRes = await closeLeadJob(leadJob);
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        if (!closeRes.ok) recordUnclosedLead(cur, leadJob.job, closeRes.reason ?? 'close refused');
        delete cur.active_lead;
        const msg = `question lead failed (${why})${closeRes.ok ? '' : `; lead close refused: ${closeRes.reason}`}`;
        if (!closeRes.ok) {
          if (cur.unattended) holdRun(cur, `${label} (${active.worker_job}): ${msg}`, 'escalate');
          state.problem = escalateProblem(`${label} (${active.worker_job}): ${msg}`);
        } else {
          applyHoldOrEscalate(cur, msg, 'question');
        }
        writeTicketQueue(hudHome, cur);
      });
      return 0;
    } };
  }
  if (!status && leadJob.dispatch_exit_code === null) {
    const left = launchRecheckMs(leadJob);
    if (left > 0) return { state: 'running', changed: false, recheckMs: left };
    return { state: 'running', changed: false, effect: async () => {
      const closeRes = await closeLeadJob(leadJob);
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        if (!closeRes.ok) recordUnclosedLead(cur, leadJob.job, closeRes.reason ?? 'close refused');
        delete cur.active_lead;
        const msg = `question lead launch interrupted${closeRes.ok ? '' : `; lead close refused: ${closeRes.reason}`}`;
        if (!closeRes.ok) {
          if (cur.unattended) holdRun(cur, `${label} (${active.worker_job}): ${msg}`, 'escalate');
          state.problem = escalateProblem(`${label} (${active.worker_job}): ${msg}`);
        } else {
          applyHoldOrEscalate(cur, msg, 'question');
        }
        writeTicketQueue(hudHome, cur);
      });
      return 0;
    } };
  }
  if (status && cleanStates.includes(status.state)) {
    const dir = directory(leadJob.job);
    const sig = declaredReport(dir, leadJob, status);
    const reportText = sig ? readFileBounded(join(dir, jobFiles.report), 512 * 1024).bytes.toString('utf8') : '';
    const parsed = sig ? parseLeadReport(reportText, ['answer', 'escalate']) : { todos: [] };
    return { state: 'running', changed: false, effect: async () => {
      const closeRes = await closeLeadJob(leadJob);
      if (!closeRes.ok) {
        await runLock(hudHome, flowId, () => {
          const cur = readTicketQueue(hudHome, flowId);
          if (!cur || cur.state !== 'working') return;
          recordUnclosedLead(cur, leadJob.job, closeRes.reason ?? 'close refused');
          recordDecision(cur, {
            step: active.step, kind: 'question', job: leadJob.job, worker_job: active.worker_job,
            decision: parsed.decision ?? 'invalid',
            ...(parsed.reason && { reason: parsed.reason }),
            close_error: closeRes.reason ?? 'close refused',
            at: new Date().toISOString(),
            ...(active.ticket && { ticket: active.ticket }),
            ...(active.question && { question: active.question }),
          });
          delete cur.active_lead;
          const msg = `lead (${leadJob.job}) close refused: ${closeRes.reason}`;
          if (cur.unattended) holdRun(cur, msg, 'escalate');
          state.problem = escalateProblem(msg);
          writeTicketQueue(hudHome, cur);
        });
        return 0;
      }
      const answerFile = active.worker_job && active.question
        ? join(directory(active.worker_job), jobFiles.qa, `${active.question}.answer.md`) : '';
      const alreadyAnswered = Boolean(answerFile && fs.existsSync(answerFile));
      let delivery: { ok: true; written: boolean } | { ok: false; reason: string } | undefined;
      if (parsed.decision === 'answer' && active.worker_job && active.question && (parsed.answer || alreadyAnswered)) {
        delivery = alreadyAnswered
          ? { ok: true, written: false }
          : await applyLeadQuestionAnswer(active.worker_job, active.question, parsed.answer!);
      }
      let nextWait = 0;
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        appendTodos(cur, parsed.todos.map(text => ({ source: `lead (${leadJob.job})`, kind: 'lead' as const, text })));
        delete cur.active_lead;
        if (delivery?.ok) {
          const at = new Date().toISOString();
          recordDecision(cur, {
            step: active.step, kind: 'question', job: leadJob.job, worker_job: active.worker_job,
            decision: 'answer',
            ...(parsed.reason && { reason: parsed.reason }),
            at,
            ...(active.ticket && { ticket: active.ticket }),
            ...(active.question && { question: active.question }),
          });
          if (active.ticket) {
            const entry = cur.tickets.find(t => t.ticket === active.ticket);
            if (entry) { entry.answered_at = at; entry.changed_at = at; }
          }
        } else if (delivery && !delivery.ok) {
          if (!isTerminalDeliveryError(delivery.reason) && MAX_ANSWER_RETRIES > 1 && parsed.answer && active.worker_job && active.question) {
            cur.pending_answer = {
              step: active.step, worker_job: active.worker_job, question: active.question,
              answer: parsed.answer, attempts: 1, last_error: delivery.reason,
              ...(active.ticket && { ticket: active.ticket }),
              lead_job: leadJob.job,
            };
            nextWait = ANSWER_RETRY_MS;
          } else {
            const why = `question ${active.question} answer delivery failed (${delivery.reason})`;
            recordDecision(cur, {
              step: active.step, kind: 'question', job: leadJob.job, worker_job: active.worker_job,
              decision: 'delivery_failed', reason: why, at: new Date().toISOString(),
              ...(active.ticket && { ticket: active.ticket }),
              ...(active.question && { question: active.question }),
            });
            applyHoldOrEscalate(cur, why, 'question');
          }
        } else {
          recordDecision(cur, {
            step: active.step, kind: 'question', job: leadJob.job, worker_job: active.worker_job,
            decision: parsed.decision ?? 'invalid',
            ...(parsed.reason && { reason: parsed.reason }),
            at: new Date().toISOString(),
            ...(active.ticket && { ticket: active.ticket }),
            ...(active.question && { question: active.question }),
          });
          const why = parsed.decision === 'escalate'
            ? (parsed.reason ? `question ${active.question} escalated: ${parsed.reason}` : `question ${active.question} escalated by lead`)
            : `question lead (${leadJob.job}) did not provide a valid answer`;
          applyHoldOrEscalate(cur, why, 'escalate', parsed.ownerApproval);
        }
        writeTicketQueue(hudHome, cur);
      });
      return nextWait;
    } };
  }
  return { state: 'running', changed: false };
}

function dispatchQuestionLead(
  q: TicketQueue,
  opts: { step: string; ticket?: string; ticketPath?: string; workerJob: Job; question: string },
  state: { problem?: TicketProblem },
): Tick {
  const { step, ticket, ticketPath, workerJob, question } = opts;
  const reqKey = `ticket-queue:${q.flow}:qlead:${workerJob.job}:${question}`;
  const existing = jobs().find(j => j.request_key === reqKey);
  if (existing) {
    if (q.decisions?.some(d => d.job === existing.job)) {
      const why = `question ${question} remains open after lead (${existing.job}) already settled`;
      if (q.unattended && ticket) {
        const entry = q.tickets.find(t => t.ticket === ticket);
        if (entry) { holdItem(entry, why, 'question'); return { state: 'running', changed: true }; }
      }
      if (q.unattended) holdRun(q, `${ticket ?? step} (${workerJob.job}): ${why}`, 'question');
      state.problem = { kind: 'escalate', step, ticket, job: workerJob.job, question, reason: `${ticket ?? step} (${workerJob.job}): ${why}` };
      return { state: 'failed', reason: state.problem.reason, changed: true };
    }
    q.active_lead = {
      job: existing.job, kind: 'question', step, round: q.repair_rounds ?? 0,
      ...(ticket && { ticket }), worker_job: workerJob.job, question,
    };
    return { state: 'running', changed: true };
  }
  const flowId = q.flow, root = q.root, pane = livePane(q), workspace = q.workspace, dispatcher = q.dispatcher;
  const packet = buildQuestionPacket(q, {
    step, ticket, ticketPath, workerJob: workerJob.job,
    question, questionPath: join(directory(workerJob.job), jobFiles.qa, `${question}.md`),
  });
  const round = q.repair_rounds ?? 0;
  const label = ticket ?? step;
  return { state: 'running', changed: true, effect: async () => {
    const canAdmit = () => {
      const cur = readTicketQueue(hudHome, flowId);
      return cur?.state === 'working' && !stopRequested(hudHome, flowId);
    };
    let leadId: string | undefined, err: string | undefined;
    try {
      const result = await dispatchJob({
        role: 'lead', cwd: root, isolation: 'none', task: packet, request_key: reqKey,
      }, pane, { queue: { id: flowId, canAdmit }, dispatcher, workspace });
      if ('job' in result && typeof result.job === 'string') leadId = result.job;
      if (!leadId || ('ok' in result && result.ok === false)) {
        const code = 'code' in result ? result.code : undefined;
        if (code !== 'queue_stopped') {
          const why = ('reason' in result && result.reason) || ('error' in result && result.error) || code || 'no lead worker';
          err = `${label} (${workerJob.job}): question lead dispatch failed (${errorLine(String(why))})`;
        }
      }
    } catch (error) { err = `${label} (${workerJob.job}): question lead dispatch failed (${errorLine(error)})`; }
    if (leadId) {
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        cur.active_lead = {
          job: leadId!, kind: 'question', step, round,
          ...(ticket && { ticket }), worker_job: workerJob.job, question,
        };
        writeTicketQueue(hudHome, cur);
      });
    }
    if (err && !stopRequested(hudHome, flowId)) {
      if (q.unattended && ticket) {
        await runLock(hudHome, flowId, () => {
          const cur = readTicketQueue(hudHome, flowId);
          if (!cur || cur.state !== 'working') return;
          const entry = cur.tickets.find(t => t.ticket === ticket);
          if (entry) { holdItem(entry, err!, 'question'); writeTicketQueue(hudHome, cur); }
        });
      } else {
        state.problem = { kind: 'escalate', step, ticket, job: workerJob.job, question, reason: err };
      }
    }
    return 0;
  } };
}

function tickAmbiguityLead(q: TicketQueue, state: { problem?: TicketProblem }): Tick | null {
  const active = q.active_lead;
  if (!active || active.kind !== 'ambiguity') return null;
  const leadJob = findJob(active.job);
  const flowId = q.flow;
  if (!leadJob) {
    delete q.active_lead;
    const entry = q.tickets.find(t => t.ticket === active.ticket);
    if (entry) holdItem(entry, `removal ambiguity lead (${active.job}) receipt missing`, 'escalate', 'feature-deletion');
    return { state: 'running', changed: true };
  }
  const { row, status } = readRow(leadJob, false, null);
  const failed = failedAttempt(row) || row.state === 'stopped' || fs.existsSync(join(directory(leadJob.job), jobFiles.stopRequested));
  if (failed) {
    const why = row.reason ?? row.display_state;
    return { state: 'running', changed: false, effect: async () => {
      const closeRes = await closeLeadJob(leadJob);
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        if (!closeRes.ok) recordUnclosedLead(cur, leadJob.job, closeRes.reason ?? 'close refused');
        delete cur.active_lead;
        const msg = `removal ambiguity lead failed (${why})${closeRes.ok ? '' : `; lead close refused: ${closeRes.reason}`}`;
        if (!closeRes.ok) {
          holdRun(cur, msg, 'escalate');
          state.problem = { kind: 'escalate', step: active.step, ticket: active.ticket, job: leadJob.job, reason: msg };
        } else {
          const entry = cur.tickets.find(t => t.ticket === active.ticket);
          if (entry) holdItem(entry, msg, 'escalate', 'feature-deletion');
        }
        writeTicketQueue(hudHome, cur);
      });
      return 0;
    } };
  }
  if (!status && leadJob.dispatch_exit_code === null) {
    const left = launchRecheckMs(leadJob);
    if (left > 0) return { state: 'running', changed: false, recheckMs: left };
    return { state: 'running', changed: false, effect: async () => {
      const closeRes = await closeLeadJob(leadJob);
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        if (!closeRes.ok) recordUnclosedLead(cur, leadJob.job, closeRes.reason ?? 'close refused');
        delete cur.active_lead;
        const msg = `removal ambiguity lead launch interrupted${closeRes.ok ? '' : `; lead close refused: ${closeRes.reason}`}`;
        if (!closeRes.ok) {
          holdRun(cur, msg, 'escalate');
          state.problem = { kind: 'escalate', step: active.step, ticket: active.ticket, job: leadJob.job, reason: msg };
        } else {
          const entry = cur.tickets.find(t => t.ticket === active.ticket);
          if (entry) holdItem(entry, msg, 'escalate', 'feature-deletion');
        }
        writeTicketQueue(hudHome, cur);
      });
      return 0;
    } };
  }
  if (status && cleanStates.includes(status.state)) {
    const dir = directory(leadJob.job);
    const sig = declaredReport(dir, leadJob, status);
    const reportText = sig ? readFileBounded(join(dir, jobFiles.report), 512 * 1024).bytes.toString('utf8') : '';
    const parsed = sig ? parseLeadReport(reportText, ['finish', 'repair', 'escalate']) : { todos: [] };
    return { state: 'running', changed: false, effect: async () => {
      const closeRes = await closeLeadJob(leadJob);
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        if (!closeRes.ok) recordUnclosedLead(cur, leadJob.job, closeRes.reason ?? 'close refused');
        appendTodos(cur, parsed.todos.map(text => ({ source: `lead (${leadJob.job})`, kind: 'lead' as const, text })));
        recordDecision(cur, {
          step: active.step, kind: 'ambiguity', job: leadJob.job, worker_job: active.worker_job,
          decision: parsed.decision ?? 'invalid',
          ...(parsed.reason && { reason: parsed.reason }),
          ...(!closeRes.ok && { close_error: closeRes.reason ?? 'close refused' }),
          at: new Date().toISOString(),
          ...(active.ticket && { ticket: active.ticket }),
        });
        delete cur.active_lead;
        if (!closeRes.ok) {
          const msg = `lead (${leadJob.job}) close refused: ${closeRes.reason}`;
          holdRun(cur, msg, 'escalate');
          state.problem = { kind: 'escalate', step: active.step, ticket: active.ticket, job: leadJob.job, reason: msg };
          writeTicketQueue(hudHome, cur);
          return;
        }
        const entry = cur.tickets.find(t => t.ticket === active.ticket && t.job === active.worker_job);
        if (entry) {
          if (parsed.decision === 'finish' && active.head && active.report_sig) {
            entry.approved_head = active.head;
            entry.approved_report_sig = active.report_sig;
          } else if (parsed.decision === 'repair') {
            failItem(entry, parsed.reason ?? 'Lead requested repair for removal ambiguity', 'worker');
          } else {
            holdItem(entry, parsed.reason ?? 'Declared removal ambiguity requires owner approval', 'escalate', parsed.ownerApproval ?? 'feature-deletion');
          }
        }
        writeTicketQueue(hudHome, cur);
      });
      return 0;
    } };
  }
  return { state: 'running', changed: false };
}

function dispatchAmbiguityLead(
  q: TicketQueue,
  opts: { item: TicketQueueItem; job: Job; head: string; sig: string; detail: string },
): Tick {
  const { item, job, head, sig, detail } = opts;
  const round = q.repair_rounds ?? 0;
  const reqKey = `ticket-queue:${q.flow}:ambiguity:${job.job}:${head}:${sig}`;
  const existing = jobs().find(j => j.request_key === reqKey);
  if (existing) {
    if (q.decisions?.some(d => d.job === existing.job)) {
      holdItem(item, `removal ambiguity lead (${existing.job}) already settled without approving commit`, 'escalate', 'feature-deletion');
      return { state: 'running', changed: true };
    }
    q.active_lead = { job: existing.job, kind: 'ambiguity', step: 'tickets', round, ticket: item.ticket, worker_job: job.job, head, report_sig: sig };
    return { state: 'running', changed: true };
  }
  const flowId = q.flow, root = q.root, pane = livePane(q), workspace = q.workspace, dispatcher = q.dispatcher;
  const packet = buildRemovalAmbiguityPacket(q, item, job, head, detail);
  return { state: 'running', changed: true, effect: async () => {
    const canAdmit = () => {
      const cur = readTicketQueue(hudHome, flowId);
      return cur?.state === 'working' && !stopRequested(hudHome, flowId);
    };
    let leadId: string | undefined, err: string | undefined;
    try {
      const result = await dispatchJob({
        role: 'lead', cwd: root, isolation: 'none', task: packet, request_key: reqKey,
      }, pane, { queue: { id: flowId, canAdmit }, dispatcher, workspace });
      if ('job' in result && typeof result.job === 'string') leadId = result.job;
      if (!leadId || ('ok' in result && result.ok === false)) {
        const code = 'code' in result ? result.code : undefined;
        if (code !== 'queue_stopped') {
          const why = ('reason' in result && result.reason) || ('error' in result && result.error) || code || 'no lead worker';
          err = `removal ambiguity lead dispatch failed (${errorLine(String(why))})`;
        }
      }
    } catch (error) { err = `removal ambiguity lead dispatch failed (${errorLine(error)})`; }
    await runLock(hudHome, flowId, () => {
      const cur = readTicketQueue(hudHome, flowId);
      if (!cur || cur.state !== 'working') return;
      if (leadId) {
        cur.active_lead = { job: leadId, kind: 'ambiguity', step: 'tickets', round, ticket: item.ticket, worker_job: job.job, head, report_sig: sig };
        writeTicketQueue(hudHome, cur);
      } else if (err && !stopRequested(hudHome, flowId)) {
        const entry = cur.tickets.find(t => t.ticket === item.ticket);
        if (entry) { holdItem(entry, err, 'escalate', 'feature-deletion'); writeTicketQueue(hudHome, cur); }
      }
    });
    return 0;
  } };
}

function tickAssumptionLead(q: TicketQueue, state: { problem?: TicketProblem }): Tick | null {
  const active = q.active_lead;
  if (!active || (active.kind !== 'assumption' && active.kind !== 'blocker')) return null;
  const kind = active.kind;
  const leadJob = findJob(active.job);
  const flowId = q.flow;
  if (!leadJob) {
    delete q.active_lead;
    const entry = q.tickets.find(t => t.ticket === active.ticket);
    if (entry) failItem(entry, `${kind} lead (${active.job}) receipt missing`, 'worker');
    return { state: 'running', changed: true };
  }
  const { row, status } = readRow(leadJob, false, null);
  const failed = failedAttempt(row) || row.state === 'stopped' || fs.existsSync(join(directory(leadJob.job), jobFiles.stopRequested));
  if (failed) {
    const why = row.reason ?? row.display_state;
    const trustFailed = trustDispatchFailed(leadJob, status);
    return { state: 'running', changed: false, effect: async () => {
      const closeRes = await closeLeadJob(leadJob);
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        if (!closeRes.ok) recordUnclosedLead(cur, leadJob.job, closeRes.reason ?? 'close refused');
        delete cur.active_lead;
        const msg = `${kind} lead failed (${why})${closeRes.ok ? '' : `; lead close refused: ${closeRes.reason}`}`;
        if (!closeRes.ok) {
          holdRun(cur, msg, 'escalate');
          state.problem = { kind: 'escalate', step: active.step, ticket: active.ticket, job: leadJob.job, reason: msg };
        } else {
          const entry = cur.tickets.find(t => t.ticket === active.ticket);
          if (entry) {
            if (trustFailed) holdItem(entry, msg, 'dispatch');
            else failItem(entry, msg, 'worker');
          }
        }
        writeTicketQueue(hudHome, cur);
      });
      return 0;
    } };
  }
  if (!status && leadJob.dispatch_exit_code === null) {
    const left = launchRecheckMs(leadJob);
    if (left > 0) return { state: 'running', changed: false, recheckMs: left };
    return { state: 'running', changed: false, effect: async () => {
      const closeRes = await closeLeadJob(leadJob);
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        if (!closeRes.ok) recordUnclosedLead(cur, leadJob.job, closeRes.reason ?? 'close refused');
        delete cur.active_lead;
        const msg = `${kind} lead launch interrupted${closeRes.ok ? '' : `; lead close refused: ${closeRes.reason}`}`;
        if (!closeRes.ok) {
          holdRun(cur, msg, 'escalate');
          state.problem = { kind: 'escalate', step: active.step, ticket: active.ticket, job: leadJob.job, reason: msg };
        } else {
          const entry = cur.tickets.find(t => t.ticket === active.ticket);
          if (entry) failItem(entry, msg, 'worker');
        }
        writeTicketQueue(hudHome, cur);
      });
      return 0;
    } };
  }
  if (status && cleanStates.includes(status.state)) {
    const dir = directory(leadJob.job);
    const sig = declaredReport(dir, leadJob, status);
    const reportText = sig ? readFileBounded(join(dir, jobFiles.report), 512 * 1024).bytes.toString('utf8') : '';
    const parsed = sig ? parseLeadReport(reportText, ['continue', 'hold', 'repair', 'escalate']) : { todos: [] };
    return { state: 'running', changed: false, effect: async () => {
      const closeRes = await closeLeadJob(leadJob);
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        if (!closeRes.ok) recordUnclosedLead(cur, leadJob.job, closeRes.reason ?? 'close refused');
        appendTodos(cur, parsed.todos.map(text => ({ source: `lead (${leadJob.job})`, kind: 'lead' as const, text })));
        recordDecision(cur, {
          step: active.step, kind, job: leadJob.job, worker_job: active.worker_job,
          decision: parsed.decision ?? 'invalid',
          ...(parsed.reason && { reason: parsed.reason }),
          ...(!closeRes.ok && { close_error: closeRes.reason ?? 'close refused' }),
          at: new Date().toISOString(),
          ...(active.ticket && { ticket: active.ticket }),
        });
        delete cur.active_lead;
        if (!closeRes.ok) {
          const msg = `lead (${leadJob.job}) close refused: ${closeRes.reason}`;
          holdRun(cur, msg, 'escalate');
          state.problem = { kind: 'escalate', step: active.step, ticket: active.ticket, job: leadJob.job, reason: msg };
          writeTicketQueue(hudHome, cur);
          return;
        }
        const entry = cur.tickets.find(t => t.ticket === active.ticket && t.job === active.worker_job);
        if (entry) {
          if (parsed.decision === 'continue' && active.head && active.report_sig) {
            entry.approved_assumptions_head = active.head;
            entry.approved_assumptions_sig = active.report_sig;
          } else if (parsed.decision === 'hold' || parsed.decision === 'escalate') {
            const approval = assumptionOwnerApproval(parsed);
            if (kind === 'blocker' && active.head && active.report_sig) {
              const reason = parsed.reason ?? 'Lead escalated a worker blocker';
              const request_id = leadJob.job;
              holdItem(entry, reason, kind, approval, { head: active.head, report_sig: active.report_sig, request_id });
              syncBlockerHandback(cur);
              (cur.notices ??= {})[`handback-${request_id}`] = `${cur.flow} held ${entry.ticket}: ${reason} — reply hud_respond job=${cur.flow} request_id=${request_id} answer=resume`;
            } else if (approval && parsed.reason) {
              holdItem(entry, parsed.reason, kind, approval, { head: active.head, report_sig: active.report_sig });
            } else {
              failItem(entry, parsed.reason ?? 'Assumption lead requested repair', 'worker');
            }
          } else if (parsed.decision === 'repair') {
            failItem(entry, parsed.reason ?? 'Assumption lead requested repair', 'worker');
          } else {
            failItem(entry, `${kind} lead (${leadJob.job}) did not declare a valid decision`, 'worker');
          }
        }
        writeTicketQueue(hudHome, cur);
      });
      return 0;
    } };
  }
  return { state: 'running', changed: false };
}

type ReportLeadInput = { item: TicketQueueItem; job: Job; head: string; sig: string; trigger: string; assumed: string[]; blockers: string[] };

function dispatchAssumptionLead(q: TicketQueue, opts: ReportLeadInput): Tick {
  const { item, job, head, sig, trigger, assumed, blockers } = opts;
  const kind = blockers.length ? 'blocker' : 'assumption';
  const round = q.repair_rounds ?? 0;
  const reqKey = `ticket-queue:${q.flow}:${kind}:${job.job}:${head}:${sig}`;
  const existing = jobs().find(j => j.request_key === reqKey);
  if (existing) {
    if (q.decisions?.some(d => d.job === existing.job)) {
      failItem(item, `${kind} lead (${existing.job}) already settled without approving commit`, 'worker');
      return { state: 'running', changed: true };
    }
    q.active_lead = { job: existing.job, kind, step: 'tickets', round, ticket: item.ticket, worker_job: job.job, head, report_sig: sig };
    return { state: 'running', changed: true };
  }
  const flowId = q.flow, root = q.root, pane = livePane(q), workspace = q.workspace, dispatcher = q.dispatcher;
  const packet = buildAssumptionPacket(q, item, job, head, { trigger, assumed, blockers });
  return { state: 'running', changed: true, effect: async () => {
    const canAdmit = () => {
      const cur = readTicketQueue(hudHome, flowId);
      return cur?.state === 'working' && !stopRequested(hudHome, flowId);
    };
    let leadId: string | undefined, err: string | undefined;
    try {
      const result = await dispatchJob({
        role: 'lead', cwd: root, isolation: 'none', task: packet, request_key: reqKey,
      }, pane, { queue: { id: flowId, canAdmit }, dispatcher, workspace });
      if ('job' in result && typeof result.job === 'string') leadId = result.job;
      if (!leadId || ('ok' in result && result.ok === false)) {
        const code = 'code' in result ? result.code : undefined;
        if (code !== 'queue_stopped') {
          const why = ('reason' in result && result.reason) || ('error' in result && result.error) || code || 'no lead worker';
          err = `${kind} lead dispatch failed (${errorLine(String(why))})`;
        }
      }
    } catch (error) { err = `${kind} lead dispatch failed (${errorLine(error)})`; }
    await runLock(hudHome, flowId, () => {
      const cur = readTicketQueue(hudHome, flowId);
      if (!cur || cur.state !== 'working') return;
      if (leadId) {
        cur.active_lead = { job: leadId, kind, step: 'tickets', round, ticket: item.ticket, worker_job: job.job, head, report_sig: sig };
        writeTicketQueue(hudHome, cur);
      } else if (err && !stopRequested(hudHome, flowId)) {
        const entry = cur.tickets.find(t => t.ticket === item.ticket);
        if (entry) { failItem(entry, err, 'worker'); writeTicketQueue(hudHome, cur); }
      }
    });
    return 0;
  } };
}

function tickTicketQueue(
  q: TicketQueue,
  step: Extract<Step, { kind: 'batch' }>,
  state: { problem?: TicketProblem },
): Tick {
  if (!step.tickets) throw Error('ticket-queue batch step requires a tickets source');
  if (stopRequested(hudHome, q.flow)) {
    q.state = 'cancelled';
    q.reason = 'cancelled: no more dispatches or lands started';
    return { state: 'cancelled', changed: true };
  }
  if (state.problem) {
    return { state: 'failed', reason: state.problem.reason, changed: true };
  }
  const activeQuestionTick = tickQuestionLead(q, state);
  if (activeQuestionTick) return activeQuestionTick;
  const activeAmbiguityTick = tickAmbiguityLead(q, state);
  if (activeAmbiguityTick) return activeAmbiguityTick;
  const activeAssumptionTick = tickAssumptionLead(q, state);
  if (activeAssumptionTick) return activeAssumptionTick;

  const landEach = !step.each || step.each.includes('land');
  const deferAssumptions = q.handback_to !== 'main';
  let problem: TicketProblem | undefined, changed = false, recheck: number | undefined;
  const note = (p: TicketProblem) => { problem ??= p; };
  const clean: { item: TicketQueueItem; job: Job; state: JobStatus['state']; retry?: string }[] = [];
  let pendingQuestion: { item: TicketQueueItem; job: Job; question: string } | undefined;
  let pendingAmbiguity: { item: TicketQueueItem; job: Job; head: string; sig: string; detail: string } | undefined;
  let pendingAssumption: ReportLeadInput | undefined;

  for (const item of q.tickets) {
    if (item.landed || item.failed) continue;
    if (item.held) {
      const blockerHold = item.held.kind === 'blocker' && item.held.request_id;
      if (q.unattended && !blockerHold) continue;
      const heldLand = item.job ? landAttempt(hudHome, item.job).prior : null;
      if (heldLand && heldLand.job === item.job && (heldLand.state === 'completed' || activeLand(heldLand))) {
        if (!q.unattended && !heldLand.ticket_queue) item.held_land = heldLand.flow;
        clearItemHold(q, item);
        changed = true;
      } else if (blockerHold && ticketClosed(q.root, item)) {
        clearItemHold(q, item);
        q.tickets = q.tickets.filter(entry => entry !== item);
        changed = true;
        continue;
      } else if (heldItemChanged(item)) {
        clearItemHold(q, item);
        changed = true;
      } else continue;
    }
    if (!item.job) continue;
    const recorded = item.land ? readLand(hudHome, item.land) : null;
    // A resumed queue follows any newer attempt, including one started manually after the handoff.
    const land = !item.land || (item.dispatch_queue && recorded?.ticket_queue !== q.flow)
      ? landAttempt(hudHome, item.job).prior : recorded;
    let retry: string | undefined;
    if (land?.job === item.job) {
      if (item.land !== land.flow) { item.land = land.flow; changed = true; }
      if (land.state === 'completed') {
        const at = land.landed_at ?? land.updated_at ?? new Date().toISOString();
        item.landed = true; item.landed_at = at; item.changed_at = at; item.base_moves = land.base_moves; changed = true;
      } else if (!activeLand(land)) {
        if (item.dispatch_queue && land.ticket_queue !== q.flow && retryableLand(land)) retry = land.flow;
        else if (q.unattended && land.error === SPEC_CHANGE_REFUSAL) {
          holdItem(item, SPEC_CHANGE_REFUSAL, 'escalate', 'spec-change');
          changed = true;
        } else if (q.unattended) {
          failItem(item, `${item.ticket} land ${land.flow}: ${landOutcome(land)}`, 'land');
          changed = true;
        } else {
          note({ kind: 'land', ticket: item.ticket, job: item.job, land: land.flow, reason: `${item.ticket} land ${land.flow}: ${landOutcome(land)}` });
        }
      }
      if (!retry) continue;
    } else if (item.land) {
      if (q.unattended) { failItem(item, `${item.ticket} land receipt missing (${item.land})`, 'land'); changed = true; }
      else note({ kind: 'land', ticket: item.ticket, job: item.job, land: item.land, reason: `${item.ticket} land receipt missing (${item.land})` });
      continue;
    }
    const job = findJob(item.job);
    const flag = (kind: TicketHandbackKind, why: string, extra?: Partial<TicketProblem>) => {
      if (q.unattended) {
        if (kind === 'assumption' || kind === 'escalate') holdItem(item, why, kind, extra?.ownerApproval);
        else failItem(item, why, kind);
        changed = true;
      } else {
        note({ kind, ticket: item.ticket, job: item.job, ...extra, reason: `${item.ticket} (${item.job}): ${why}` });
      }
    };
    if (!job) { flag('worker', 'job receipt missing'); continue; }
    if (job.ticket_queue !== owner(q, item)) { flag('worker', 'job taken over outside the ticket queue'); continue; }
    const { row, status } = readRow(job, false, null);
    const qa = jobCache.readQa(directory(job.job)), question = qa.openIds[0];
    // Answered but not yet read: the worker still reports waiting_orchestrator until it picks the answer up.
    const answered = !question && qa.allQuestionFiles.length > 0 && row.state === 'waiting_orchestrator';
    if (q.unattended && trustDispatchFailed(job, status)) {
      holdItem(item, status?.error ?? row.reason ?? job.stderr_tail, 'dispatch');
      changed = true;
    } else if (question) {
      if (q.handback_to === 'main') flag('question', `worker question ${question} — use hud_read or hud_respond`, { question });
      else pendingQuestion ??= { item, job, question };
    } else if (fs.existsSync(join(directory(job.job), jobFiles.stopRequested))) flag('worker', 'worker stop requested');
    else if (failedAttempt(row)) flag('worker', row.reason ?? row.display_state);
    else if (!answered && (row.blocked || row.state === 'blocked' || row.state === 'waiting_orchestrator'))
      flag('worker', row.reason ?? 'worker needs main');
    else if (!status && job.dispatch_exit_code === null) {
      // A runner that took over mid-launch sees the job before its first status: wait while the launching
      // process lives (launches under load can take minutes); legacy receipts without one get a fixed grace.
      const left = launchRecheckMs(job);
      if (left > 0) recheck = Math.min(recheck ?? left, left);
      else flag('dispatch', 'dispatch interrupted before worker status was recorded');
    } else if (status && cleanStates.includes(status.state)) {
      const verdict = judgeSettlement(q.root, item, job, status, deferAssumptions);
      const source = `${item.ticket} (${job.job})`;
      changed = appendTodos(q, [
        ...(verdict.assumed ?? []).map(text => ({ source, kind: 'assumed' as const, text })),
        ...(verdict.tries ?? []).map(text => ({ source, kind: 'try' as const, text })),
      ]) || changed;
      if ('ok' in verdict) {
        const { trigger, sig, assumed, blockers, reportText } = verdict;
        if (blockers.length) {
          const head = verifiedSourceHead(job);
          if (!head) { flag('worker', 'Verified worker commit unavailable'); continue; }
          if (item.approved_assumptions_head !== head || item.approved_assumptions_sig !== sig) {
            if (q.handback_to === 'main' && !leadEnabled(q.root)) {
              flag('blocker', 'report declares Blockers:', { assumption: { head, report_sig: sig } });
            } else {
              pendingAssumption ??= { item, job, head, sig, trigger: 'report declares Blockers:', assumed, blockers };
            }
            continue;
          }
          changed = appendTodos(q, blockers.map(text => ({ source, kind: 'blocker' as const, text }))) || changed;
        }
        let gateHead: string | undefined;
        if (landEach && q.unattended) {
          const gate = checkUnattendedGates(q, item, job, sig, reportText);
          if (gate.kind !== 'pass') {
            if (gate.kind === 'ambiguous') {
              pendingAmbiguity ??= { item, job, head: gate.head, sig, detail: gate.detail };
            } else if (gate.kind === 'hold') {
              holdItem(item, gate.reason, 'escalate', gate.ownerApproval);
              changed = true;
            } else {
              failItem(item, gate.reason, gate.problemKind);
              changed = true;
            }
            continue;
          }
          gateHead = gate.head;
        }
        if (deferAssumptions && trigger && (landEach || !q.unattended)) {
          const head = gateHead ?? verifiedSourceHead(job);
          if (!head) { flag('worker', 'Verified worker commit unavailable'); continue; }
          if (item.approved_assumptions_head !== head || item.approved_assumptions_sig !== sig) {
            pendingAssumption ??= { item, job, head, sig, trigger, assumed, blockers };
            continue;
          }
        }
        if (gateHead && (item.approved_head !== gateHead || item.approved_report_sig !== sig)) {
          item.approved_head = gateHead;
          item.approved_report_sig = sig;
          changed = true;
        }
        if (landEach) clean.push({ item, job, state: status.state, retry });
        else { const at = new Date().toISOString(); item.landed = true; item.landed_at = at; item.changed_at = at; changed = true; }
      } else if ('waitMs' in verdict) {
        recheck = Math.min(recheck ?? verdict.waitMs, verdict.waitMs);
      } else {
        flag(verdict.kind, verdict.reason, verdict.assumption ? { assumption: verdict.assumption } : undefined);
      }
    }
  }

  changed = syncBlockerHandback(q) || changed;
  if (problem) {
    if (problem.kind === 'assumption' || problem.kind === 'blocker') {
      q.reason = problem.reason;
      settleTicketHandback(q, problem);
      return { state: 'asking', changed: true };
    }
    state.problem = problem;
    return { state: 'failed', reason: problem.reason, changed: true };
  }
  if (pendingQuestion) {
    const { item, job: workerJob, question } = pendingQuestion;
    return dispatchQuestionLead(q, { step: 'tickets', ticket: item.ticket, ticketPath: item.path, workerJob, question }, state);
  }
  if (pendingAmbiguity) {
    return dispatchAmbiguityLead(q, pendingAmbiguity);
  }
  if (pendingAssumption) {
    return dispatchAssumptionLead(q, pendingAssumption);
  }
  if (clean.length) {
    const flowId = q.flow, pane = livePane(q) ?? null;
    // Queue together, letting the existing land train decide whether they can share a gate.
    return { state: 'running', changed: true, effect: async () => {
      const results = await Promise.allSettled(clean.map(async ({ item, job, state: jobState, retry }) => {
        try {
          const land = await startLand(hudHome, job.job, job, jobState, pane, false, flowId, retry, q.unattended ? item.approved_head : undefined);
          return { ticket: item.ticket, job: job.job, land: land.flow };
        } catch (error) {
          throw { ticket: item.ticket, job: job.job, reason: `${item.ticket} (${job.job}): cannot start land: ${errorLine(error)}` };
        }
      }));
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        let updated = false;
        for (const result of results) {
          if (result.status === 'fulfilled') {
            const entry = cur.tickets.find(t => t.ticket === result.value.ticket && t.job === result.value.job);
            if (entry && entry.land !== result.value.land) { entry.land = result.value.land; updated = true; }
          } else if (cur.unattended) {
            const detail = result.reason as { ticket?: string; job?: string; reason?: string };
            const entry = cur.tickets.find(t => t.ticket === detail?.ticket && t.job === detail?.job);
            if (entry) { failItem(entry, detail?.reason ?? errorLine(result.reason), 'land'); updated = true; }
          }
        }
        if (updated) writeTicketQueue(hudHome, cur);
      });
      if (!q.unattended) {
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed) {
          const detail = failed.reason as { ticket?: string; job?: string; reason?: string };
          state.problem = { kind: 'land', ticket: detail?.ticket, job: detail?.job, reason: detail?.reason ?? errorLine(failed.reason) };
        }
      }
      return 0;
    } };
  }

  const active = q.tickets.filter(item => !item.landed && !item.held && !item.failed).length;
  const limit = step.max_parallel ?? q.max_parallel;
  const atCapacity = !!limit && active >= limit && q.tickets.every(item => item.job || item.held || item.failed);
  if (atCapacity && !q.queued?.length) {
    return { state: 'running', changed, ...(recheck !== undefined && { recheckMs: recheck }) };
  }
  const workset = q.unattended
    ? objectiveWorkset(hudHome, q)
    : ticketReadiness(q.root, jobCache, step.tickets, {
      home: hudHome, excludeTickets: new Set(q.tickets.flatMap(item => item.held ? [item.ticket] : [])),
    });
  const eligible = workset.tickets;
  const queued = q.unattended ? [] : workset.queued;
  const blocked = workset.blocked;
  if (JSON.stringify(queued) !== JSON.stringify(q.queued ?? [])) {
    q.queued = queued.length ? queued : undefined;
    changed = true;
  }
  if (JSON.stringify(blocked) !== JSON.stringify(q.blocked ?? [])) {
    q.blocked = blocked.length ? blocked : undefined;
    changed = true;
  }
  const admitted = new Set(q.tickets.map(t => t.ticket));
  const future = workset.future.filter(t => !admitted.has(t.ticket));
  if (JSON.stringify(future) !== JSON.stringify(q.future)) {
    q.future = future;
    changed = true;
  }
  if (atCapacity) {
    return { state: 'running', changed, ...(recheck !== undefined && { recheckMs: recheck }) };
  }
  let item = q.tickets.find(entry => !entry.job && !entry.held && !entry.failed);
  const recovered = item && eligible.find(t => t.ticket === item?.ticket);
  if (item && !recovered) {
    if (q.unattended) {
      failItem(item, `${item.ticket}: no longer ready after recovery`, 'queue');
      return { state: 'running', changed: true };
    }
    state.problem = { kind: 'queue', ticket: item.ticket, reason: `${item.ticket}: no longer ready after recovery` };
    return { state: 'failed', reason: state.problem.reason, changed: true };
  }
  if (item && recovered && item.path !== recovered.path) {
    item.path = recovered.path;
    changed = true;
  }
  const freshCandidates = item ? [] : eligible.filter(t => !q.tickets.some(own => own.ticket === t.ticket));
  let next = freshCandidates;
  if (q.unattended && freshCandidates.length) {
    const invalid = new Set(checkTicketPaths(q.root, freshCandidates).map(g => g.ticket));
    next = freshCandidates.filter(t => !invalid.has(t.ticket));
  }
  if (next.length) {
    const { ticket, path, role, blockers, repairs } = next[0];
    const round = q.repair_rounds ?? 0;
    if (next.some((entry, i) => i > 0 && entry.ticket === ticket)) {
      if (q.unattended) {
        const dup: TicketQueueItem = { ticket, path, role: 'imp', round, ...(repairs?.length && { repairs: [...repairs] }), blockers: blockers ? [...blockers] : [] };
        failItem(dup, `${ticket}: ambiguous ticket number`, 'queue');
        q.tickets.push(dup);
        q.future = future.filter(t => t.ticket !== ticket);
        return { state: 'running', changed: true };
      }
      state.problem = { kind: 'queue', ticket, reason: `${ticket}: ambiguous ticket number` };
      return { state: 'failed', reason: state.problem.reason, changed: true };
    }
    item = { ticket, path, role, round, ...(repairs?.length && { repairs: [...repairs] }), blockers: blockers ? [...blockers] : [] };
    q.tickets.push(item); // Intent committed by the driver before dispatch so the request key is recoverable.
    q.future = future.filter(t => t.ticket !== ticket);
    changed = true;
  }
  if (!item) {
    if (active || queued.length || blockerHandbackItem(q)) return { state: 'running', changed, ...(recheck !== undefined && { recheckMs: recheck }) };
    const heldProblem = heldBlockProblem(q, 'tickets');
    if (heldProblem) {
      state.problem = heldProblem;
      return { state: 'failed', reason: heldProblem.reason, changed: true };
    }
    if (q.repair_admitted_base !== undefined && q.tickets.length <= q.repair_admitted_base) {
      const msg = `repair round ${q.repair_rounds ?? 1} admitted no repair tickets`;
      if (q.unattended) holdRun(q, msg, 'escalate');
      state.problem = { kind: 'escalate', step: 'tickets', reason: msg };
      return { state: 'failed', reason: msg, changed: true };
    }
    if (q.repair_admitted_base !== undefined) { delete q.repair_admitted_base; changed = true; }
    return { state: 'done', changed: true };
  }

  const launching = item, queueId = owner(q, launching), reqKey = requestKey(q, launching);
  const flowId = q.flow, root = q.root, pane = livePane(q), workspace = q.workspace, dispatcher = q.dispatcher;
  const runNote = q.unattended
    ? `${WORKFLOW_WORKER_RULE}\nUnattended rule: ${q.escalation_rule} Do not edit docs/spec.md.`
    : step.ask === false ? WORKFLOW_WORKER_RULE_NO_ASK : WORKFLOW_WORKER_RULE;
  return { state: 'running', changed: true, effect: async () => {
    let job: string | undefined, err: string | undefined;
    let flakeDeferred = false;
    const canAdmit = () => {
      const cur = readTicketQueue(hudHome, flowId);
      return cur?.state === 'working' && !stopRequested(hudHome, flowId);
    };
    try {
      const result = await dispatchTicketJob(
        { role: launching.role, cwd: root, ticket: launching.ticket, brief_file: launching.path, request_key: reqKey },
        pane,
        { queue: { id: queueId, canAdmit }, dispatcher, workspace, runNote },
      );
      if ('job' in result && typeof result.job === 'string') job = result.job;
      if (!job || ('ok' in result && result.ok === false)) {
        const code = 'code' in result ? result.code : undefined;
        flakeDeferred = code === 'flake_ineligible';
        if (code !== 'queue_stopped' && !flakeDeferred) {
          const why = ('reason' in result && result.reason) || ('error' in result && result.error) || code || 'no worker';
          err = `${launching.ticket}: dispatch failed (${errorLine(String(why))})`;
        }
      }
    } catch (error) { err = `${launching.ticket}: dispatch failed (${errorLine(error)})`; }
    await runLock(hudHome, flowId, () => {
      const cur = readTicketQueue(hudHome, flowId);
      if (!cur || cur.state !== 'working') return;
      const entry = cur.tickets.find(t => t.ticket === launching.ticket && !t.job);
      if (entry) {
        const bound = job ?? receiptFor(cur, entry)?.job;
        if (bound) { entry.job = bound; writeTicketQueue(hudHome, cur); }
        else if (flakeDeferred) {
          // Another admission won the race. Drop the unbound intent and let readiness decide again.
          cur.tickets.splice(cur.tickets.indexOf(entry), 1);
          writeTicketQueue(hudHome, cur);
        } else if (err && cur.unattended && !stopRequested(hudHome, flowId)) {
          failItem(entry, err, 'dispatch');
          writeTicketQueue(hudHome, cur);
        }
      }
    });
    if (err && !q.unattended && !stopRequested(hudHome, flowId)) {
      state.problem = { kind: 'dispatch', ticket: launching.ticket, ...(job && { job }), reason: err };
    }
    return 0;
  } };
}

function tickJobStep(
  q: TicketQueue,
  key: string,
  step: Extract<Step, { kind: 'job' }>,
  state: { problem?: TicketProblem },
): Tick {
  if (stopRequested(hudHome, q.flow)) {
    q.state = 'cancelled';
    q.reason = 'cancelled: no more dispatches or lands started';
    return { state: 'cancelled', changed: true };
  }
  if (state.problem) return { state: 'failed', reason: state.problem.reason, changed: true };
  const heldProblem = heldBlockProblem(q, key);
  if (heldProblem) {
    state.problem = heldProblem;
    return { state: 'failed', reason: heldProblem.reason, changed: true };
  }
  if (!q.tickets.some(t => t.landed)) return { state: 'done', changed: true };

  const activeLeadTick = tickQuestionLead(q, state);
  if (activeLeadTick) return activeLeadTick;

  const round = q.repair_rounds ?? 0;
  const reqKey = `ticket-queue:${q.flow}:${key}:${round}`;
  let jobId = q.review_job;
  if (!jobId) {
    const recovered = jobs().find(j => j.request_key === reqKey);
    if (recovered) { q.review_job = jobId = recovered.job; }
  }
  if (jobId) {
    const job = findJob(jobId);
    if (!job) {
      state.problem = { kind: 'worker', step: key, job: jobId, reason: `${key} (${jobId}): job receipt missing` };
      return { state: 'failed', reason: state.problem.reason, changed: true };
    }
    const { row, status } = readRow(job, false, null);
    const qa = jobCache.readQa(directory(job.job)), question = qa.openIds[0];
    const answered = !question && qa.allQuestionFiles.length > 0 && row.state === 'waiting_orchestrator';
    if (question) {
      if (step.ask === false) {
        const msg = `${key} (${job.job}): asked question ${question} while ask is disabled`;
        if (q.unattended) holdRun(q, msg, 'question');
        state.problem = { kind: 'question', step: key, job: job.job, question, reason: msg };
        return { state: 'failed', reason: msg, changed: true };
      }
      if (q.handback_to === 'main') {
        state.problem = { kind: 'question', step: key, job: job.job, question, reason: `${key} (${job.job}): worker question ${question} — use hud_read or hud_respond` };
        return { state: 'failed', reason: state.problem.reason, changed: true };
      }
      return dispatchQuestionLead(q, { step: key, workerJob: job, question }, state);
    }
    if (fs.existsSync(join(directory(job.job), jobFiles.stopRequested))) {
      state.problem = { kind: 'worker', step: key, job: job.job, reason: `${key} (${job.job}): worker stop requested` };
      return { state: 'failed', reason: state.problem.reason, changed: true };
    }
    if (q.unattended && trustDispatchFailed(job, status)) {
      const msg = `${key} (${jobId}): ${status?.error ?? row.reason ?? job.stderr_tail}`;
      holdRun(q, msg, 'dispatch');
      state.problem = { kind: 'dispatch', step: key, job: jobId, reason: msg };
      return { state: 'failed', reason: msg, changed: true };
    }
    if (failedAttempt(row)) {
      state.problem = { kind: 'worker', step: key, job: job.job, reason: `${key} (${job.job}): ${row.reason ?? row.display_state}` };
      return { state: 'failed', reason: state.problem.reason, changed: true };
    }
    if (!answered && (row.blocked || row.state === 'blocked' || row.state === 'waiting_orchestrator')) {
      state.problem = { kind: 'worker', step: key, job: job.job, reason: `${key} (${job.job}): ${row.reason ?? 'worker needs main'}` };
      return { state: 'failed', reason: state.problem.reason, changed: true };
    }
    if (!status && job.dispatch_exit_code === null) {
      const left = launchRecheckMs(job);
      if (left > 0) return { state: 'running', changed: false, recheckMs: left };
      state.problem = { kind: 'dispatch', step: key, job: job.job, reason: `${key} (${job.job}): dispatch interrupted` };
      return { state: 'failed', reason: state.problem.reason, changed: true };
    }
    if (status && cleanStates.includes(status.state)) {
      const dir = directory(job.job);
      const sig = declaredReport(dir, job, status);
      if (!sig) {
        state.problem = { kind: 'worker', step: key, job: job.job, reason: `${key} (${job.job}): settled without a declared report` };
        return { state: 'failed', reason: state.problem.reason, changed: true };
      }
      const meta = readReportMeta(dir, sig);
      const reviews = q.reviews ?? [];
      if (!reviews.some(r => r.job === job.job)) {
        const reviewed = job.reviewed ?? milestoneReviewRange(q);
        reviews.push({
          round, job: job.job,
          ...(meta?.summary && { summary: meta.summary }),
          ...(job.findings && { findings: job.findings }),
          ...(reviewed && { reviewed }),
        });
        q.reviews = reviews;
      }
      return { state: 'done', changed: true };
    }
    return { state: 'running', changed: false };
  }

  const flowId = q.flow, root = q.root, pane = livePane(q), workspace = q.workspace, dispatcher = q.dispatcher;
  const task = buildReviewBrief(q, step.task ?? 'Milestone two-axis review per docs/delegation.md step 5.');
  const runNote = step.ask === false ? WORKFLOW_WORKER_RULE_NO_ASK : undefined;
  const fromJobs = q.tickets
    .filter(item => item.landed && item.job && fs.existsSync(join(directory(item.job), jobFiles.report)))
    .map(item => item.job!)
    .slice(-16);
  return { state: 'running', changed: true, effect: async () => {
    const canAdmit = () => {
      const cur = readTicketQueue(hudHome, flowId);
      return cur?.state === 'working' && !stopRequested(hudHome, flowId);
    };
    let launched: string | undefined, err: string | undefined;
    try {
      const result = await dispatchJob({
        role: step.role, cwd: root, isolation: step.isolation ?? 'none', task, request_key: reqKey,
        ...(fromJobs.length && { from_jobs: fromJobs }),
      }, pane, { queue: { id: flowId, canAdmit }, dispatcher, workspace, ...(runNote && { runNote }) });
      if ('job' in result && typeof result.job === 'string') launched = result.job;
      if (!launched || ('ok' in result && result.ok === false)) {
        const code = 'code' in result ? result.code : undefined;
        if (code !== 'queue_stopped') {
          const why = ('reason' in result && result.reason) || ('error' in result && result.error) || code || 'no worker';
          err = `${key}: dispatch failed (${errorLine(String(why))})`;
        }
      }
    } catch (error) { err = `${key}: dispatch failed (${errorLine(error)})`; }
    if (launched) {
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        cur.review_job = launched;
        writeTicketQueue(hudHome, cur);
      });
    }
    // Unattended runs classify a recorded launch failure from its durable status, including trust refusals.
    if (err && !(q.unattended && launched) && !stopRequested(hudHome, flowId)) {
      state.problem = { kind: 'dispatch', step: key, ...(launched && { job: launched }), reason: err };
    }
    return 0;
  } };
}

function tickHandbackStep(
  q: TicketQueue,
  key: string,
  step: Extract<Step, { kind: 'handback' }>,
  graph: Pick<Graph, 'steps'>,
  state: { problem?: TicketProblem },
): Tick {
  if (stopRequested(hudHome, q.flow)) {
    q.state = 'cancelled';
    q.reason = 'cancelled: no more dispatches or lands started';
    return { state: 'cancelled', changed: true };
  }
  if (state.problem) return { state: 'failed', reason: state.problem.reason, changed: true };
  const heldProblem = heldBlockProblem(q, key);
  if (heldProblem) {
    state.problem = heldProblem;
    return { state: 'failed', reason: heldProblem.reason, changed: true };
  }
  if (key === 'accept' && !q.tickets.some(t => t.landed || t.failed)) return { state: 'done', changed: true };

  const target = step.to ?? q.handback_to ?? 'lead';
  if (target === 'main') {
    q.state = 'paused';
    q.reason = step.ask;
    q.handback = { step: key, choices: step.options };
    q.remaining = computeRemaining(q);
    q.notices = {
      [`pause-${q.epoch ?? 0}`]: `${q.flow} (ticket queue ${q.feature}) — hand-back at ${key}: ${step.ask} (${step.options.join('/')}) | reply: hud_respond job=${q.flow} answer=<${step.options.join('|')}>[: reason]`,
    };
    return { state: 'asking', changed: true };
  }

  const round = q.repair_rounds ?? 0;
  const reqKey = `ticket-queue:${q.flow}:lead:${key}:${round}`;
  let active = q.active_lead?.kind === 'accept' && q.active_lead.step === key && q.active_lead.round === round
    ? q.active_lead : undefined;
  if (!active) {
    const recovered = jobs().find(j => j.request_key === reqKey);
    if (recovered && !q.decisions?.some(d => d.job === recovered.job)) {
      active = q.active_lead = { job: recovered.job, kind: 'accept', step: key, round };
    }
  }
  const flowId = q.flow;
  if (active) {
    const leadJob = findJob(active.job);
    if (!leadJob) {
      delete q.active_lead;
      const msg = `lead (${active.job}) receipt missing`;
      if (q.unattended) holdRun(q, msg, 'escalate');
      state.problem = { kind: 'escalate', step: key, job: active.job, reason: msg };
      return { state: 'failed', reason: msg, changed: true };
    }
    const { row, status } = readRow(leadJob, false, null);
    const failed = failedAttempt(row) || row.state === 'stopped' || fs.existsSync(join(directory(leadJob.job), jobFiles.stopRequested));
    if (failed) {
      const why = row.reason ?? row.display_state;
      return { state: 'running', changed: false, effect: async () => {
        const closeRes = await closeLeadJob(leadJob);
        await runLock(hudHome, flowId, () => {
          const cur = readTicketQueue(hudHome, flowId);
          if (!cur || cur.state !== 'working') return;
          if (!closeRes.ok) recordUnclosedLead(cur, leadJob.job, closeRes.reason ?? 'close refused');
          delete cur.active_lead;
          const msg = `lead (${leadJob.job}) failed: ${why}${closeRes.ok ? '' : `; close refused: ${closeRes.reason}`}`;
          if (cur.unattended) holdRun(cur, msg, 'escalate');
          state.problem = { kind: 'escalate', step: key, job: leadJob.job, reason: msg };
          writeTicketQueue(hudHome, cur);
        });
        return 0;
      } };
    }
    if (!status && leadJob.dispatch_exit_code === null) {
      const left = launchRecheckMs(leadJob);
      if (left > 0) return { state: 'running', changed: false, recheckMs: left };
      return { state: 'running', changed: false, effect: async () => {
        const closeRes = await closeLeadJob(leadJob);
        await runLock(hudHome, flowId, () => {
          const cur = readTicketQueue(hudHome, flowId);
          if (!cur || cur.state !== 'working') return;
          if (!closeRes.ok) recordUnclosedLead(cur, leadJob.job, closeRes.reason ?? 'close refused');
          delete cur.active_lead;
          const msg = `lead (${leadJob.job}) launch interrupted${closeRes.ok ? '' : `; close refused: ${closeRes.reason}`}`;
          if (cur.unattended) holdRun(cur, msg, 'escalate');
          state.problem = { kind: 'escalate', step: key, job: leadJob.job, reason: msg };
          writeTicketQueue(hudHome, cur);
        });
        return 0;
      } };
    }
    if (status && cleanStates.includes(status.state)) {
      const dir = directory(leadJob.job);
      const sig = declaredReport(dir, leadJob, status);
      const reportText = sig ? readFileBounded(join(dir, jobFiles.report), 512 * 1024).bytes.toString('utf8') : '';
      const parsed = sig ? parseLeadReport(reportText, step.options) : { todos: [] };
      const stepKeys = Object.keys(graph.steps);
      return { state: 'running', changed: false, effect: async () => {
        const closeRes = await closeLeadJob(leadJob);
        const verdict = parsed.reason ? `${parsed.decision}: ${parsed.reason}` : parsed.decision;
        if (q.unattended && closeRes.ok && parsed.decision === 'finish' && verdict) {
          // Do not hold the flow-state lock while an unrelated land owns the checkout.
          try {
            await recordUnattendedAcceptance(q.root, hudHome, () => {
              const cur = readTicketQueue(hudHome, flowId);
              return cur?.state === 'working' && !stopRequested(hudHome, flowId)
                ? cur.tickets.filter(item => item.landed) : [];
            }, flowId, verdict);
          } catch { /* Best-effort acceptance record. */ }
        }
        await runLock(hudHome, flowId, () => {
          const cur = readTicketQueue(hudHome, flowId);
          if (!cur || cur.state !== 'working') return;
          if (!closeRes.ok) recordUnclosedLead(cur, leadJob.job, closeRes.reason ?? 'close refused');
          appendTodos(cur, parsed.todos.map(text => ({ source: `lead (${leadJob.job})`, kind: 'lead' as const, text })));
          recordDecision(cur, {
            step: key, kind: 'accept', job: leadJob.job,
            decision: parsed.decision ?? 'invalid',
            ...(parsed.reason && { reason: parsed.reason }),
            ...(!closeRes.ok && { close_error: closeRes.reason ?? 'close refused' }),
            at: new Date().toISOString(),
          });
          delete cur.active_lead;
          if (!closeRes.ok) {
            const msg = `lead (${leadJob.job}) close refused: ${closeRes.reason}`;
            if (cur.unattended) holdRun(cur, msg, 'escalate');
            state.problem = { kind: 'escalate', step: key, job: leadJob.job, reason: msg };
            writeTicketQueue(hudHome, cur);
            return;
          }
          if (parsed.decision === 'repair') {
            const repair = prepareTicketQueueRepair(cur, stepKeys, () => {
              if (!cur.unattended) return ticketReadiness(cur.root, jobCache, cur.feature, { home: hudHome });
              const { tickets } = objectiveWorkset(hudHome, cur);
              const fresh = tickets.filter(t => !cur.tickets.some(own => own.ticket === t.ticket));
              const invalid = new Set(checkTicketPaths(cur.root, fresh).map(g => g.ticket));
              return { tickets: fresh.filter(t => !invalid.has(t.ticket)) };
            }, parsed.reason);
            if (repair.kind !== 'ready') {
              const msg = repair.kind === 'cap' ? repair.reason
                : `lead requested repair with no ready tickets${parsed.reason ? `: ${parsed.reason}` : ''}`;
              if (cur.unattended) holdRun(cur, msg, 'escalate');
              state.problem = { kind: 'escalate', step: key, job: leadJob.job, reason: msg };
            }
          } else if (parsed.decision === 'escalate' || !parsed.decision) {
            const msg = parsed.decision === 'escalate'
              ? (parsed.reason ? `escalated: ${parsed.reason}` : 'escalated by lead')
              : `lead (${leadJob.job}) did not declare a valid decision (${step.options.join('|')})`;
            if (cur.unattended) holdRun(cur, msg, 'escalate', parsed.ownerApproval);
            state.problem = {
              kind: 'escalate', step: key, job: leadJob.job, ownerApproval: parsed.ownerApproval, reason: msg,
            };
          } else {
            const heldProblem = heldBlockProblem(cur, key);
            if (heldProblem) {
              state.problem = heldProblem;
            } else {
              cur.steps ??= {};
              cur.steps[key] = { state: 'done', answer: parsed.decision, changed_at: new Date().toISOString() };
              cur.verdict = verdict;
            }
          }
          writeTicketQueue(hudHome, cur);
        });
        return 0;
      } };
    }
    return { state: 'running', changed: false };
  }

  const root = q.root, pane = livePane(q), workspace = q.workspace, dispatcher = q.dispatcher;
  const packet = buildAcceptPacket(q, step);
  return { state: 'running', changed: true, effect: async () => {
    const canAdmit = () => {
      const cur = readTicketQueue(hudHome, flowId);
      return cur?.state === 'working' && !stopRequested(hudHome, flowId);
    };
    let leadId: string | undefined, err: string | undefined;
    try {
      const result = await dispatchJob({
        role: 'lead', cwd: root, isolation: 'none', task: packet, request_key: reqKey,
      }, pane, { queue: { id: flowId, canAdmit }, dispatcher, workspace });
      if ('job' in result && typeof result.job === 'string') leadId = result.job;
      if (!leadId || ('ok' in result && result.ok === false)) {
        const code = 'code' in result ? result.code : undefined;
        if (code !== 'queue_stopped') {
          const why = ('reason' in result && result.reason) || ('error' in result && result.error) || code || 'no lead worker';
          err = `${key}: lead dispatch failed (${errorLine(String(why))})`;
        }
      }
    } catch (error) { err = `${key}: lead dispatch failed (${errorLine(error)})`; }
    if (leadId) {
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        cur.active_lead = { job: leadId!, kind: 'accept', step: key, round };
        writeTicketQueue(hudHome, cur);
      });
    }
    if (err && !stopRequested(hudHome, flowId)) {
      if (q.unattended) {
        await runLock(hudHome, flowId, () => {
          const cur = readTicketQueue(hudHome, flowId);
          if (!cur || cur.state !== 'working') return;
          holdRun(cur, err!, 'escalate');
          writeTicketQueue(hudHome, cur);
        });
      }
      state.problem = { kind: 'escalate', step: key, ...(leadId && { job: leadId }), reason: err };
    }
    return 0;
  } };
}

const jobDirFilter = (file: string | null) =>
  !file || /^(?:qa(?:\/q\d+\.md)?|STATUS\.json(?:\.stop-requested)?|report\.md|checks\.json|job\.json|done\.json|turn\.json)$/.test(file);

export async function driveTicketQueue(id: string) {
  const initial = readTicketQueue(hudHome, id);
  if (!initial || initial.state !== 'working') return;
  const dir = runDir(hudHome, id);
  const state: { problem?: TicketProblem } = {};
  let ticketProject: string | undefined;
  try {
    await driveWorkflow<TicketQueue>(hudHome, id, {
      read: () => readTicketQueue(hudHome, id)!,
      header: q => q as TicketQueue & Run,
      save: q => {
        if (q.state === 'paused' && !Object.values(q.steps ?? {}).some(c => c.state === 'asking') && (!q.handback || state.problem)) {
          settleTicketHandback(q, state.problem ?? { kind: 'queue', reason: q.reason ?? 'ticket queue error' });
        } else if (q.state === 'completed') {
          q.queued = undefined;
          q.remaining = [];
          q.notices = terminalNotice(q, 'end');
        } else if (q.state === 'cancelled') {
          q.queued = undefined;
          q.remaining = computeRemaining(q);
          q.notices = terminalNotice(q, 'end');
        }
        writeTicketQueue(hudHome, q);
        if ((q.state === 'paused' || q.handback?.kind === 'blocker') && Object.keys(q.notices ?? {}).length) {
          ensureJobWatcher(hudHome);
        }
      },
      open: q => {
        fs.mkdirSync(dir, { mode: 0o700, recursive: true });
        let graph: Pick<Graph, 'name' | 'version' | 'steps' | 'policy'>;
        if (q.template || fs.existsSync(join(dir, 'graph.json'))) graph = readJsonFile(join(dir, 'graph.json')) as Graph;
        else {
          // Adopt a pre-upgrade queue receipt with the same single-step template shape.
          graph = { version: 1, name: 'ticket-queue', policy: { breaker: 'first' }, steps: { tickets: {
            kind: 'batch', needs: [], from: [], optional: false, role: 'imp', tickets: q.feature,
            each: ['job', 'land'], pilot: false, ...(q.max_parallel ? { max_parallel: q.max_parallel } : {}),
          } } };
          freezeGraph(hudHome, id, graph);
        }
        q.template = 'ticket-queue'; q.host = 'detached';
        q.cwd ??= q.root; q.project_root ??= q.root;
        ticketProject = sharedRoot(q.project_root);
        q.epoch ??= 0; q.settled ??= 0; q.streak ??= 0; q.failures ??= 0; q.notices ??= {};
        q.steps ??= Object.fromEntries(Object.keys(graph.steps).map(s => [s, { state: s === 'tickets' ? 'running' as const : 'waiting' as const }]));
        recoverTicketQueue(q);
        return graph;
      },
      tick: (q, key, step, plan) => {
        if (step.kind === 'batch') return tickTicketQueue(q, step, state);
        if (step.kind === 'job') return tickJobStep(q, key, step, state);
        if (step.kind === 'handback') return tickHandbackStep(q, key, step, plan, state);
        throw Error(`unsupported ticket-queue step ${step.kind}`);
      },
      active: q => {
        if (q.state !== 'working') return false;
        if (ticketProject) {
          try { resumeTicketEdits(hudHome, undefined, ticketProject); }
          catch { /* Best-effort ticket-edit supervision while the queue run is alive. */ }
        }
        return true;
      },
      watches: q => [
        // Land receipts already wake this runner across features. Watch cancel, queued ticket edits, and blocker edits too (e.g. wontfix).
        { dir: join(hudHome, 'flows'), filter: file => !file || file === `${q.flow}.json.cancel` || /^f[a-f0-9]{16}(?:-\d+)?\.json$/.test(file) || /^te[0-9a-f]{32}\.json$/.test(file) },
        ...(q.unattended ? [
          { dir: join(q.root, '.scratch'), recursive: true },
          { dir: join(q.root, '.hud'), filter: (file: string | null) => !file || file === 'objectives.md' },
        ] : []),
        ...(q.queued ?? []).flatMap(item => item.blockers.map(ref => ({ dir: join(q.root, '.scratch', ref.split('/')[0].toLowerCase(), 'issues') }))),
        ...(blockerHandbackItem(q) && !q.unattended ? [{ dir: join(q.root, '.scratch', q.feature, 'issues') }] : []),
        ...q.tickets.flatMap(item => item.job && !item.landed && (!item.held || item.held.request_id) && !item.failed
          ? [{ dir: directory(item.job), recursive: true, filter: jobDirFilter }] : []),
        ...(q.review_job ? [{ dir: directory(q.review_job), recursive: true, filter: jobDirFilter }] : []),
        ...(q.active_lead?.job ? [{ dir: directory(q.active_lead.job), recursive: true, filter: jobDirFilter }] : []),
        ...(q.pending_answer?.worker_job ? [{ dir: directory(q.pending_answer.worker_job), recursive: true, filter: jobDirFilter }] : []),
      ],
      readerNotices: true,
      errorLine: run => `${id} ticket queue failed: ${run.reason}`,
    });
  } finally {
    if (ticketProject) await stopTicketEdits();
  }
}
