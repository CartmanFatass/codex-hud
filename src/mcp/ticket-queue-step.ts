/** Ticket-queue workflow steps on the workflow driver. Job, review, lead and land receipts fence every effect. */
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { failedAttempt } from '../collectors/thin-jobs.js';
import { readDone, readTurn, receiptForTurn } from '../roles/cli-turn.js';
import { checkBinding, CHECK_TIMEOUT_MS, readCheckReceipt, sameChecks } from '../roles/job-checks.js';
import { cachedReportSignature, readReportMeta } from '../roles/report-meta.js';
import { readFileBounded, readJsonFile } from '../utils/atomic-fs.js';
import { isProcAlive } from '../utils/proc.js';
import { SAFE_GIT_ARGS, safeGitEnv } from '../utils/git-safety.js';
import type { OwnerApproval } from '../unattended/state.js';
import { driveWorkflow } from '../workflows/driver.js';
import type { Run, Tick } from '../workflows/engine.js';
import type { Graph, Step } from '../workflows/graph.js';
import { directRecipient } from '../workflows/scope.js';
import { freezeGraph, runDir, runLock, stopRequested } from '../workflows/store.js';
import { dispatchJob } from './dispatch/orchestrator.js';
import type { Job, JobStatus } from './job-contracts.js';
import { activeLand, landAttempt, landOutcome, readLand, retryableLand, SPEC_CHANGE_REFUSAL } from './land-state.js';
import { startLand } from './land.js';
import { checkFeatureTickets, ticketReadiness } from './local-tickets.js';
import { jobFiles } from './paths.js';
import { piReportSettlement } from './pi-read-settlement.js';
import { directory, findJob, hudHome, jobCache, jobs, readRow } from './store/job-store.js';
import {
  readTicketQueue, ticketQueueNotice, writeTicketQueue,
  type TicketHandbackKind, type TicketQueue, type TicketQueueItem,
} from './ticket-queue-state.js';
import {
  appendTodos, applyLeadQuestionAnswer, buildAcceptPacket, buildPrelandPacket, buildQuestionPacket, buildReviewBrief,
  closeLeadJob, extractAssumedLines, MAX_REPAIR_ROUNDS, parseLeadReport, recordDecision,
  WORKFLOW_WORKER_RULE, WORKFLOW_WORKER_RULE_NO_ASK,
} from './workflow-lead.js';

const cleanStates = ['idle_grace', 'done', 'closed'];
const LAUNCH_GRACE_MS = 120_000, LAUNCH_RECHECK_MS = 5_000;
const errorLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0];
const owner = (q: TicketQueue, item: TicketQueueItem) => item.dispatch_queue ?? q.flow;
const requestKey = (q: TicketQueue, item: TicketQueueItem) => `ticket-queue:${owner(q, item)}:${item.ticket}`;
const receiptFor = (q: TicketQueue, item: TicketQueueItem) => jobs().find(job => job.request_key === requestKey(q, item));
const livePane = (q: TicketQueue) => q.pane && directRecipient(q) ? q.pane : undefined;

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

type SettlementVerdict =
  | { ok: true; assumed: string[] }
  | { waitMs: number }
  | { kind: TicketHandbackKind; reason: string; assumed?: string[] };

function judgeSettlement(item: TicketQueueItem, job: Job, status: JobStatus): SettlementVerdict {
  const dir = directory(job.job);
  const sig = declaredReport(dir, job, status);
  if (!sig) return { kind: 'worker', reason: 'settled without a declared report for this turn' };
  const report = readFileBounded(join(dir, jobFiles.report), 1024 * 1024);
  if (report.truncated) return { kind: 'worker', reason: 'report is too large to verify' };
  const text = report.bytes.toString('utf8');
  const { lines: assumed, scopeAssumptions } = extractAssumedLines(text);
  if (/^[ \t]*(?:[-*] |#{1,6} )?(?:\*\*)?Blockers:/im.test(text))
    return { kind: 'blocker', reason: 'report has a Blockers: line', assumed };
  if (scopeAssumptions.length)
    return { kind: 'assumption', reason: `scope assumption in report: ${scopeAssumptions[0]}`, assumed };
  if (assumed.length > 3)
    return { kind: 'assumption', reason: `report has ${assumed.length} Assumed: lines (limit 3)`, assumed };
  if (readReportMeta(dir, sig)?.skip_checks_reason) return { kind: 'check', reason: 'worker checks were skipped', assumed };
  if (/(?:^|·)[ \t]*\*\*Main review:\*\*[ \t]*yes\b/im.test(ticketHeader(item.path)))
    return { kind: 'review', reason: 'ticket is marked for main review', assumed };
  if (job.checks?.length) {
    const binding = checkBinding(dir, job, status);
    if (!binding) return { kind: 'check', reason: 'HUD check binding unavailable', assumed };
    const receipt = readCheckReceipt(dir), current = receipt && sameChecks(binding, receipt);
    if (current && receipt.results.some(result => result.exit_code !== 0)) return { kind: 'check', reason: 'HUD checks failed', assumed };
    if (!current || receipt.state !== 'done') {
      const since = current ? fs.statSync(join(dir, jobFiles.checks), { throwIfNoEntry: false })?.mtimeMs : undefined;
      const left = (since ?? Date.parse(status.settled_at!)) + job.checks.length * CHECK_TIMEOUT_MS + 5000 - Date.now();
      return left <= 0 ? { kind: 'check', reason: 'HUD check results unavailable', assumed } : { waitMs: Math.min(left, LAUNCH_RECHECK_MS) };
    }
    if (receipt.results.length !== job.checks.length) return { kind: 'check', reason: 'HUD check results incomplete', assumed };
  }
  return { ok: true, assumed };
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
}

function computeRemaining(q: TicketQueue): string[] {
  return q.tickets.flatMap(item => {
    if (!item.job) item.job = receiptFor(q, item)?.job;
    if (!item.job || item.landed) return [];
    const land = item.land ? readLand(hudHome, item.land) : landAttempt(hudHome, item.job).prior;
    if (land) return activeLand(land) ? [`${item.ticket} (${land.flow}${land.repairs?.at(-1)?.job ? `, ${land.repairs.at(-1)!.job}` : ''})`] : [];
    const job = findJob(item.job), state = job && readRow(job, false, null).row.state;
    return !state || ![...cleanStates, 'failed', 'stopped'].includes(state) ? [`${item.ticket} (${item.job})`] : [];
  });
}

function terminalNotice(q: TicketQueue, keyPrefix: 'end' | 'pause' = 'end') {
  return q.task ? {} : { [`${keyPrefix}-${q.epoch ?? 0}`]: ticketQueueNotice(q).replace(/\r?\n/g, ' | ') };
}

/** Hand-back settlement for ticket-queue problems:
 * - blocker / assumption breaker: pauses the run with no main wake; notice stored on the run record.
 * - escalate: pauses the run and wakes main once.
 * - other problems (land/check/worker/dispatch/to:main question): failed receipt with terminal notice. */
export function settleTicketHandback(q: TicketQueue, problem?: TicketProblem) {
  const step = problem?.step ?? q.handback?.step ?? 'tickets';
  q.queued = undefined;
  q.remaining = computeRemaining(q);
  if (q.unattended && !problem?.ownerApproval) {
    delete q.handback;
    q.state = 'failed';
    q.notices = terminalNotice(q);
    return;
  }
  q.handback = {
    step,
    choices: q.unattended ? ['manual'] : ['resume', 'stop'],
    ...(problem && {
      kind: problem.kind,
      ...(problem.ticket && { ticket: problem.ticket }),
      ...(problem.job && { job: problem.job }),
      ...(problem.question && { question: problem.question }),
      ...(problem.land && { land: problem.land }),
      ...(problem.ownerApproval && { owner_approval: problem.ownerApproval }),
    }),
  };
  if (problem?.kind === 'blocker' || problem?.kind === 'assumption') {
    q.state = 'paused';
    q.no_wake = true;
    q.pause_notice = ticketQueueNotice(q).replace(/\r?\n/g, ' | ');
    q.notices = {};
    return;
  }
  if (problem?.kind === 'escalate') {
    q.state = 'paused';
    delete q.no_wake;
    q.notices = terminalNotice(q, 'pause');
    return;
  }
  q.state = 'failed';
  delete q.no_wake;
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

function tickQuestionLead(q: TicketQueue, state: { problem?: TicketProblem }): Tick | null {
  const active = q.active_lead;
  if (!active || active.kind !== 'question') return null;
  const leadJob = findJob(active.job);
  const flowId = q.flow;
  const escalateProblem = (reason: string, ownerApproval?: OwnerApproval): TicketProblem => ({
    kind: 'escalate', step: active.step, ticket: active.ticket, job: active.worker_job, question: active.question, reason, ownerApproval,
  });
  if (!leadJob) {
    delete q.active_lead;
    state.problem = escalateProblem(`question lead (${active.job}) receipt missing`);
    return { state: 'failed', reason: state.problem.reason, changed: true };
  }
  const { row, status } = readRow(leadJob, false, null);
  const failed = failedAttempt(row) || row.state === 'stopped' || fs.existsSync(join(directory(leadJob.job), jobFiles.stopRequested));
  if (failed) {
    const why = row.reason ?? row.display_state;
    return { state: 'running', changed: false, effect: async () => {
      await closeLeadJob(leadJob);
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        delete cur.active_lead;
        writeTicketQueue(hudHome, cur);
      });
      state.problem = escalateProblem(`${active.ticket} (${active.worker_job}): question lead failed (${why})`);
      return 0;
    } };
  }
  if (!status && leadJob.dispatch_exit_code === null) {
    const left = launchRecheckMs(leadJob);
    if (left > 0) return { state: 'running', changed: false, recheckMs: left };
    return { state: 'running', changed: false, effect: async () => {
      await closeLeadJob(leadJob);
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        delete cur.active_lead;
        writeTicketQueue(hudHome, cur);
      });
      state.problem = escalateProblem(`${active.ticket} (${active.worker_job}): question lead launch interrupted`);
      return 0;
    } };
  }
  if (status && cleanStates.includes(status.state)) {
    const dir = directory(leadJob.job);
    const sig = declaredReport(dir, leadJob, status);
    const reportText = sig ? readFileBounded(join(dir, jobFiles.report), 512 * 1024).bytes.toString('utf8') : '';
    const parsed = sig ? parseLeadReport(reportText, ['answer', 'escalate']) : { todos: [] };
    return { state: 'running', changed: false, effect: async () => {
      await closeLeadJob(leadJob);
      const answerFile = active.worker_job && active.question
        ? join(directory(active.worker_job), jobFiles.qa, `${active.question}.answer.md`) : '';
      const alreadyAnswered = Boolean(answerFile && fs.existsSync(answerFile));
      let answered = false;
      if (parsed.decision === 'answer' && active.worker_job && active.question && (parsed.answer || alreadyAnswered)) {
        if (!alreadyAnswered && parsed.answer) await applyLeadQuestionAnswer(active.worker_job, active.question, parsed.answer);
        answered = true;
      }
      await runLock(hudHome, flowId, () => {
        const cur = readTicketQueue(hudHome, flowId);
        if (!cur || cur.state !== 'working') return;
        appendTodos(cur, parsed.todos.map(text => ({ source: `lead (${leadJob.job})`, kind: 'lead' as const, text })));
        recordDecision(cur, {
          step: active.step, kind: 'question', job: leadJob.job,
          decision: parsed.decision ?? 'invalid',
          ...(parsed.reason && { reason: parsed.reason }),
          at: new Date().toISOString(),
          ...(active.ticket && { ticket: active.ticket }),
          ...(active.question && { question: active.question }),
        });
        delete cur.active_lead;
        writeTicketQueue(hudHome, cur);
      });
      if (!answered) {
        const why = parsed.decision === 'escalate'
          ? (parsed.reason ? `question ${active.question} escalated: ${parsed.reason}` : `question ${active.question} escalated by lead`)
          : `question lead (${leadJob.job}) did not provide a valid answer`;
        state.problem = escalateProblem(`${active.ticket} (${active.worker_job}): ${why}`, parsed.ownerApproval);
      }
      return 0;
    } };
  }
  return { state: 'running', changed: false };
}

function tickTicketQueue(
  q: TicketQueue,
  step: Extract<Step, { kind: 'batch' }>,
  graph: Pick<Graph, 'steps'>,
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
  const activeLeadTick = tickQuestionLead(q, state);
  if (activeLeadTick) return activeLeadTick;

  const landEach = !step.each || step.each.includes('land');
  let problem: TicketProblem | undefined, changed = false, recheck: number | undefined;
  const note = (p: TicketProblem) => { problem ??= p; };
  const clean: { item: TicketQueueItem; job: Job; state: JobStatus['state']; retry?: string }[] = [];
  let pendingQuestion: { item: TicketQueueItem; job: Job; question: string } | undefined;

  for (const item of q.tickets) {
    if (!item.job || item.landed) continue;
    const recorded = item.land ? readLand(hudHome, item.land) : null;
    // A resumed queue follows any newer attempt, including one started manually after the handoff.
    const land = !item.land || (item.dispatch_queue && recorded?.ticket_queue !== q.flow)
      ? landAttempt(hudHome, item.job).prior : recorded;
    let retry: string | undefined;
    if (land) {
      if (item.land !== land.flow) { item.land = land.flow; changed = true; }
      if (land.state === 'completed') {
        item.landed = true; item.base_moves = land.base_moves; changed = true;
      } else if (!activeLand(land)) {
        if (item.dispatch_queue && land.ticket_queue !== q.flow && retryableLand(land)) retry = land.flow;
        else if (q.unattended && land.error === SPEC_CHANGE_REFUSAL) note({ kind: 'escalate', ticket: item.ticket,
          job: item.job, land: land.flow, reason: SPEC_CHANGE_REFUSAL, ownerApproval: 'spec-change' });
        else note({ kind: 'land', ticket: item.ticket, job: item.job, land: land.flow, reason: `${item.ticket} land ${land.flow}: ${landOutcome(land)}` });
      }
      if (!retry) continue;
    } else if (item.land) {
      note({ kind: 'land', ticket: item.ticket, job: item.job, land: item.land, reason: `${item.ticket} land receipt missing (${item.land})` });
      continue;
    }
    const job = findJob(item.job);
    const flag = (kind: TicketHandbackKind, why: string, extra?: Partial<TicketProblem>) =>
      note({ kind, ticket: item.ticket, job: item.job, ...extra, reason: `${item.ticket} (${item.job}): ${why}` });
    if (!job) { flag('worker', 'job receipt missing'); continue; }
    if (job.ticket_queue !== owner(q, item)) { flag('worker', 'job taken over outside the ticket queue'); continue; }
    const { row, status } = readRow(job, false, null);
    const qa = jobCache.readQa(directory(job.job)), question = qa.openIds[0];
    // Answered but not yet read: the worker still reports waiting_orchestrator until it picks the answer up.
    const answered = !question && qa.allQuestionFiles.length > 0 && row.state === 'waiting_orchestrator';
    if (question) {
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
      const verdict = judgeSettlement(item, job, status);
      if ('assumed' in verdict && verdict.assumed?.length) {
        if (appendTodos(q, verdict.assumed.map(text => ({ source: `${item.ticket} (${job.job})`, kind: 'assumed' as const, text })))) {
          changed = true;
        }
      }
      if ('ok' in verdict) {
        if (landEach) clean.push({ item, job, state: status.state, retry });
        else { item.landed = true; changed = true; }
      } else if ('waitMs' in verdict) {
        recheck = Math.min(recheck ?? verdict.waitMs, verdict.waitMs);
      } else {
        flag(verdict.kind, verdict.reason);
      }
    }
  }

  if (q.unattended && !problem?.ownerApproval) {
    const candidate = problem ? q.tickets.find(t => t.ticket === problem?.ticket && t.job) : clean[0]?.item;
    const job = candidate?.job && findJob(candidate.job);
    if (candidate && job) {
      const head = job.worktree && spawnSync('git', [...SAFE_GIT_ARGS, 'rev-parse', '--verify', 'HEAD'], {
        cwd: job.worktree.root, env: safeGitEnv(process.env), encoding: 'utf8', timeout: 5000,
      }).stdout?.trim();
      const source = head && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head) ? head : undefined;
      const failure = problem?.reason ?? (!source ? 'Verified worker commit unavailable' : undefined);
      if (failure || candidate.approved_head !== source) return tickHandbackStep(q, 'preland', {
        kind: 'handback', needs: [], from: [], optional: false, to: 'lead',
        ask: 'Inspect the ticket before landing', options: ['finish', 'repair', 'escalate'],
      }, graph, state, { item: candidate, job, source, failure });
    }
  }
  if (problem) {
    state.problem = problem;
    return { state: 'failed', reason: problem.reason, changed: true };
  }
  if (pendingQuestion) {
    const { item, job: workerJob, question } = pendingQuestion;
    const reqKey = `ticket-queue:${q.flow}:qlead:${workerJob.job}:${question}`;
    const existing = jobs().find(j => j.request_key === reqKey);
    if (existing) {
      q.active_lead = { job: existing.job, kind: 'question', step: 'tickets', round: q.repair_rounds ?? 0, ticket: item.ticket, worker_job: workerJob.job, question };
      return { state: 'running', changed: true };
    }
    const flowId = q.flow, root = q.root, pane = livePane(q), workspace = q.workspace, dispatcher = q.dispatcher;
    const preset = q.lead_preset;
    const packet = buildQuestionPacket(q, {
      ticket: item.ticket, ticketPath: item.path, workerJob: workerJob.job,
      question, questionPath: join(directory(workerJob.job), jobFiles.qa, `${question}.md`),
    });
    const round = q.repair_rounds ?? 0;
    return { state: 'running', changed: true, effect: async () => {
      const canAdmit = () => {
        const cur = readTicketQueue(hudHome, flowId);
        return cur?.state === 'working' && !stopRequested(hudHome, flowId);
      };
      let leadId: string | undefined, err: string | undefined;
      try {
        const result = await dispatchJob({
          role: 'lead', cwd: root, isolation: 'none', task: packet, request_key: reqKey,
          ...(preset && { preset }),
        }, pane, { queue: { id: flowId, canAdmit }, dispatcher, workspace });
        if ('job' in result && typeof result.job === 'string') leadId = result.job;
        if (!leadId || ('ok' in result && result.ok === false)) {
          const code = 'code' in result ? result.code : undefined;
          if (code !== 'queue_stopped') {
            const why = ('reason' in result && result.reason) || ('error' in result && result.error) || code || 'no lead worker';
            err = `${item.ticket} (${workerJob.job}): question lead dispatch failed (${errorLine(String(why))})`;
          }
        }
      } catch (error) { err = `${item.ticket} (${workerJob.job}): question lead dispatch failed (${errorLine(error)})`; }
      if (leadId) {
        await runLock(hudHome, flowId, () => {
          const cur = readTicketQueue(hudHome, flowId);
          if (!cur || cur.state !== 'working') return;
          cur.active_lead = { job: leadId!, kind: 'question', step: 'tickets', round, ticket: item.ticket, worker_job: workerJob.job, question };
          writeTicketQueue(hudHome, cur);
        });
      }
      if (err && !stopRequested(hudHome, flowId)) {
        state.problem = { kind: 'escalate', step: 'tickets', ticket: item.ticket, job: workerJob.job, question, reason: err };
      }
      return 0;
    } };
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
          if (result.status !== 'fulfilled') continue;
          const entry = cur.tickets.find(t => t.ticket === result.value.ticket && t.job === result.value.job);
          if (entry && entry.land !== result.value.land) { entry.land = result.value.land; updated = true; }
        }
        if (updated) writeTicketQueue(hudHome, cur);
      });
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) {
        const detail = failed.reason as { ticket?: string; job?: string; reason?: string };
        state.problem = { kind: 'land', ticket: detail?.ticket, job: detail?.job, reason: detail?.reason ?? errorLine(failed.reason) };
      }
      return 0;
    } };
  }

  const active = q.tickets.filter(item => !item.landed).length;
  const limit = step.max_parallel ?? q.max_parallel;
  const atCapacity = !!limit && active >= limit && q.tickets.every(item => item.job);
  if (atCapacity && !q.queued?.length) {
    return { state: 'running', changed, ...(recheck !== undefined && { recheckMs: recheck }) };
  }
  const readiness = ticketReadiness(q.root, jobCache, q.unattended ? undefined : step.tickets);
  const eligible = q.unattended ? readiness.tickets.filter(t => t.ticket === q.unattended!.ticket && t.path === q.unattended!.path) : readiness.tickets;
  const queued = q.unattended ? [] : readiness.queued;
  if (JSON.stringify(queued) !== JSON.stringify(q.queued ?? [])) {
    q.queued = queued.length ? queued : undefined;
    changed = true;
  }
  if (atCapacity) {
    return { state: 'running', changed, ...(recheck !== undefined && { recheckMs: recheck }) };
  }
  let item = q.tickets.find(entry => !entry.job);
  if (item && !eligible.some(t => t.ticket === item!.ticket && t.path === item!.path)) {
    state.problem = { kind: 'queue', ticket: item.ticket, reason: `${item.ticket}: no longer ready after recovery` };
    return { state: 'failed', reason: state.problem.reason, changed: true };
  }
  const next = item ? [] : eligible.filter(t => !q.tickets.some(own => own.ticket === t.ticket));
  if (next.length) {
    const { ticket, path } = next[0];
    if (q.unattended && checkFeatureTickets(q.root, q.feature, ticket).length) {
      state.problem = { kind: 'queue', ticket, reason: `${ticket}: failed ticket check before dispatch` };
      return { state: 'failed', reason: state.problem.reason, changed: true };
    }
    if (next.some((entry, i) => i > 0 && entry.ticket === ticket)) {
      state.problem = { kind: 'queue', ticket, reason: `${ticket}: ambiguous ticket number` };
      return { state: 'failed', reason: state.problem.reason, changed: true };
    }
    const frontend = /(?:^|·)[ \t]*\*\*(?:Role|Who):\*\*[ \t]*frontend-(?:imp|implementer)(?=[ \t\r\n·(]|$)/im.test(ticketHeader(path));
    item = { ticket, path, role: frontend ? 'frontend-imp' : 'imp' };
    q.tickets.push(item); // Intent committed by the driver before dispatch so the request key is recoverable.
    changed = true;
  }
  if (!item) {
    if (active || queued.length) return { state: 'running', changed, ...(recheck !== undefined && { recheckMs: recheck }) };
    return { state: 'done', changed: true };
  }

  const launching = item, queueId = owner(q, launching), reqKey = requestKey(q, launching);
  const flowId = q.flow, root = q.root, pane = livePane(q), workspace = q.workspace, dispatcher = q.dispatcher;
  const runNote = q.unattended
    ? `${WORKFLOW_WORKER_RULE}\nUnattended rule: ${q.escalation_rule} Ask the lead before proceeding if this ticket needs owner approval.`
    : step.ask === false ? WORKFLOW_WORKER_RULE_NO_ASK : WORKFLOW_WORKER_RULE;
  return { state: 'running', changed: true, effect: async () => {
    let job: string | undefined, err: string | undefined;
    const canAdmit = () => {
      const cur = readTicketQueue(hudHome, flowId);
      return cur?.state === 'working' && !stopRequested(hudHome, flowId);
    };
    try {
      const result = await dispatchJob({ role: launching.role, cwd: root, isolation: 'worktree', ticket: launching.ticket,
        brief_file: launching.path, request_key: reqKey }, pane,
        { queue: { id: queueId, canAdmit }, dispatcher, workspace, runNote });
      if ('job' in result && typeof result.job === 'string') job = result.job;
      if (!job || ('ok' in result && result.ok === false)) {
        const code = 'code' in result ? result.code : undefined;
        if (code !== 'queue_stopped') {
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
      }
    });
    if (err && !stopRequested(hudHome, flowId)) {
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
  if (!q.tickets.some(t => t.landed)) return { state: 'done', changed: true };

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
    if (fs.existsSync(join(directory(job.job), jobFiles.stopRequested))) {
      state.problem = { kind: 'worker', step: key, job: job.job, reason: `${key} (${job.job}): worker stop requested` };
      return { state: 'failed', reason: state.problem.reason, changed: true };
    }
    if (failedAttempt(row)) {
      state.problem = { kind: 'worker', step: key, job: job.job, reason: `${key} (${job.job}): ${row.reason ?? row.display_state}` };
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
        reviews.push({
          round, job: job.job,
          ...(meta?.summary && { summary: meta.summary }),
          ...(job.findings && { findings: job.findings }),
          ...(job.reviewed && { reviewed: job.reviewed }),
        });
        q.reviews = reviews;
      }
      return { state: 'done', changed: true };
    }
    return { state: 'running', changed: false };
  }

  const flowId = q.flow, root = q.root, pane = livePane(q), workspace = q.workspace, dispatcher = q.dispatcher;
  const task = buildReviewBrief(q, step.task ?? 'Milestone two-axis review per docs/delegation.md step 5.');
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
      }, pane, { queue: { id: flowId, canAdmit }, dispatcher, workspace });
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
    if (err && !stopRequested(hudHome, flowId)) {
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
  preland?: { item: TicketQueueItem; job: Job; source?: string; failure?: string },
): Tick {
  if (stopRequested(hudHome, q.flow)) {
    q.state = 'cancelled';
    q.reason = 'cancelled: no more dispatches or lands started';
    return { state: 'cancelled', changed: true };
  }
  if (state.problem) return { state: 'failed', reason: state.problem.reason, changed: true };
  if (key === 'accept' && !q.tickets.some(t => t.landed)) return { state: 'done', changed: true };

  const target = step.to ?? q.handback_to ?? 'lead';
  if (target === 'main') {
    q.state = 'paused';
    q.reason = step.ask;
    q.handback = { step: key, choices: step.options };
    q.remaining = computeRemaining(q);
    q.notices = q.task ? {} : {
      [`pause-${q.epoch ?? 0}`]: `${q.flow} (ticket queue ${q.feature}) — hand-back at ${key}: ${step.ask} (${step.options.join('/')})`,
    };
    return { state: 'asking', changed: true };
  }

  const round = q.repair_rounds ?? 0;
  const kind = preland ? 'preland' : 'accept';
  const reqKey = `ticket-queue:${q.flow}:lead:${key}:${round}${preland ? `:${preland.failure ? 'failure' : preland.source}` : ''}`;
  const activeStep = preland ? reqKey : key;
  let active = q.active_lead?.kind === kind && q.active_lead.step === activeStep && q.active_lead.round === round
    ? q.active_lead : undefined;
  if (!active) {
    const recovered = jobs().find(j => j.request_key === reqKey);
    if (recovered) {
      active = q.active_lead = { job: recovered.job, kind, step: activeStep, round };
    }
  }
  const flowId = q.flow;
  if (active) {
    const leadJob = findJob(active.job);
    if (!leadJob) {
      delete q.active_lead;
      state.problem = { kind: 'escalate', step: key, job: active.job, reason: `lead (${active.job}) receipt missing` };
      return { state: 'failed', reason: state.problem.reason, changed: true };
    }
    const { row, status } = readRow(leadJob, false, null);
    const failed = failedAttempt(row) || row.state === 'stopped' || fs.existsSync(join(directory(leadJob.job), jobFiles.stopRequested));
    if (failed) {
      const why = row.reason ?? row.display_state;
      return { state: 'running', changed: false, effect: async () => {
        await closeLeadJob(leadJob);
        await runLock(hudHome, flowId, () => {
          const cur = readTicketQueue(hudHome, flowId);
          if (!cur || cur.state !== 'working') return;
          delete cur.active_lead;
          writeTicketQueue(hudHome, cur);
        });
        state.problem = { kind: 'escalate', step: key, job: leadJob.job, reason: `lead (${leadJob.job}) failed: ${why}` };
        return 0;
      } };
    }
    if (!status && leadJob.dispatch_exit_code === null) {
      const left = launchRecheckMs(leadJob);
      if (left > 0) return { state: 'running', changed: false, recheckMs: left };
      return { state: 'running', changed: false, effect: async () => {
        await closeLeadJob(leadJob);
        await runLock(hudHome, flowId, () => {
          const cur = readTicketQueue(hudHome, flowId);
          if (!cur || cur.state !== 'working') return;
          delete cur.active_lead;
          writeTicketQueue(hudHome, cur);
        });
        state.problem = { kind: 'escalate', step: key, job: leadJob.job, reason: `lead (${leadJob.job}) launch interrupted` };
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
        await closeLeadJob(leadJob);
        await runLock(hudHome, flowId, () => {
          const cur = readTicketQueue(hudHome, flowId);
          if (!cur || cur.state !== 'working') return;
          appendTodos(cur, parsed.todos.map(text => ({ source: `lead (${leadJob.job})`, kind: 'lead' as const, text })));
          recordDecision(cur, {
            step: key, kind: 'accept', job: leadJob.job,
            decision: parsed.decision ?? 'invalid',
            ...(parsed.reason && { reason: parsed.reason }),
            at: new Date().toISOString(),
          });
          delete cur.active_lead;
          if (preland) {
            if (parsed.decision === 'finish' && !preland.failure && preland.source) {
              const item = cur.tickets.find(t => t.job === preland.job.job);
              if (item) item.approved_head = preland.source;
            } else {
              state.problem = { kind: parsed.decision === 'escalate' ? 'escalate' : 'worker', step: key,
                ticket: preland.item.ticket, job: preland.job.job, ownerApproval: parsed.ownerApproval,
                reason: parsed.reason ?? preland.failure ?? 'Lead did not approve the worker commit' };
            }
          } else if (parsed.decision === 'repair') {
            if (cur.unattended) {
              cur.steps ??= {};
              cur.steps[key] = { state: 'done', answer: 'repair' };
              cur.verdict = `repair: ${parsed.reason ?? 'follow-up requested'}`;
            } else if ((cur.repair_rounds ?? 0) >= MAX_REPAIR_ROUNDS) {
              state.problem = {
                kind: 'escalate', step: key, job: leadJob.job,
                reason: `max repair rounds (${MAX_REPAIR_ROUNDS}) reached${parsed.reason ? `: ${parsed.reason}` : ''}`,
              };
            } else {
              const { tickets: ready, queued } = ticketReadiness(cur.root, jobCache, cur.feature);
              const hasNewWork = ready.some(t => !cur.tickets.some(own => own.ticket === t.ticket)) || queued.length > 0;
              if (!hasNewWork) {
                state.problem = {
                  kind: 'escalate', step: key, job: leadJob.job,
                  reason: `lead requested repair with no ready tickets${parsed.reason ? `: ${parsed.reason}` : ''}`,
                };
              } else {
                cur.repair_rounds = (cur.repair_rounds ?? 0) + 1;
                delete cur.review_job;
                cur.steps ??= {};
                for (const s of stepKeys) cur.steps[s] = { state: 'waiting' };
              }
            }
          } else if (parsed.decision === 'escalate' || !parsed.decision) {
            state.problem = {
              kind: 'escalate', step: key, job: leadJob.job, ownerApproval: parsed.ownerApproval,
              reason: parsed.decision === 'escalate'
                ? (parsed.reason ? `escalated: ${parsed.reason}` : 'escalated by lead')
                : `lead (${leadJob.job}) did not declare a valid decision (${step.options.join('|')})`,
            };
          } else {
            cur.steps ??= {};
            cur.steps[key] = { state: 'done', answer: parsed.decision };
            cur.verdict = parsed.reason ? `${parsed.decision}: ${parsed.reason}` : parsed.decision;
          }
          writeTicketQueue(hudHome, cur);
        });
        return 0;
      } };
    }
    return { state: 'running', changed: false };
  }

  const root = q.root, pane = livePane(q), workspace = q.workspace, dispatcher = q.dispatcher;
  const preset = step.preset ?? q.lead_preset;
  const packet = preland ? buildPrelandPacket(q, preland.item, preland.job, preland.source, preland.failure) : buildAcceptPacket(q, step);
  return { state: 'running', changed: true, effect: async () => {
    const canAdmit = () => {
      const cur = readTicketQueue(hudHome, flowId);
      return cur?.state === 'working' && !stopRequested(hudHome, flowId);
    };
    let leadId: string | undefined, err: string | undefined;
    try {
      const result = await dispatchJob({
        role: 'lead', cwd: root, isolation: 'none', task: packet, request_key: reqKey,
        ...(preset && { preset }),
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
        cur.active_lead = { job: leadId!, kind, step: activeStep, round };
        writeTicketQueue(hudHome, cur);
      });
    }
    if (err && !stopRequested(hudHome, flowId)) {
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
  await driveWorkflow<TicketQueue>(hudHome, id, {
    read: () => readTicketQueue(hudHome, id)!,
    header: q => q as TicketQueue & Run,
    save: q => {
      if (q.state === 'paused' && !Object.values(q.steps ?? {}).some(c => c.state === 'asking')) {
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
      q.epoch ??= 0; q.settled ??= 0; q.streak ??= 0; q.failures ??= 0; q.notices ??= {};
      q.steps ??= Object.fromEntries(Object.keys(graph.steps).map(s => [s, { state: s === 'tickets' ? 'running' as const : 'waiting' as const }]));
      recoverTicketQueue(q);
      return graph;
    },
    tick: (q, key, step, plan) => {
      if (step.kind === 'batch') return tickTicketQueue(q, step, plan, state);
      if (step.kind === 'job') return tickJobStep(q, key, step, state);
      if (step.kind === 'handback') return tickHandbackStep(q, key, step, plan, state);
      throw Error(`unsupported ticket-queue step ${step.kind}`);
    },
    active: q => q.state === 'working',
    watches: q => [
      // Land receipts already wake this runner across features. Watch cancel + blocker edits too (e.g. wontfix).
      { dir: join(hudHome, 'flows'), filter: file => !file || file === `${q.flow}.json.cancel` || /^f[a-f0-9]{16}(?:-\d+)?\.json$/.test(file) },
      ...(q.queued ?? []).flatMap(item => item.blockers.map(ref => ({ dir: join(q.root, '.scratch', ref.split('/')[0].toLowerCase(), 'issues') }))),
      ...q.tickets.flatMap(item => item.job && !item.landed ? [{ dir: directory(item.job), recursive: true, filter: jobDirFilter }] : []),
      ...(q.review_job ? [{ dir: directory(q.review_job), recursive: true, filter: jobDirFilter }] : []),
      ...(q.active_lead?.job ? [{ dir: directory(q.active_lead.job), recursive: true, filter: jobDirFilter }] : []),
    ],
    readerNotices: true,
    errorLine: run => `${id} ticket queue failed: ${run.reason}`,
  });
}
