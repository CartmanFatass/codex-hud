/** Ticket-queue batch step on the workflow driver. Job and land receipts fence every effect. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { failedAttempt } from '../collectors/thin-jobs.js';
import { readDone, readTurn, receiptForTurn } from '../roles/cli-turn.js';
import { checkBinding, CHECK_TIMEOUT_MS, readCheckReceipt, sameChecks } from '../roles/job-checks.js';
import { cachedReportSignature, readReportMeta } from '../roles/report-meta.js';
import { readFileBounded, readJsonFile } from '../utils/atomic-fs.js';
import { isProcAlive } from '../utils/proc.js';
import { driveWorkflow } from '../workflows/driver.js';
import type { Run, Tick } from '../workflows/engine.js';
import type { Graph, Step } from '../workflows/graph.js';
import { freezeGraph, runDir, runLock, stopRequested } from '../workflows/store.js';
import { dispatchJob } from './dispatch/orchestrator.js';
import type { Job, JobStatus } from './job-contracts.js';
import { activeLand, landAttempt, landOutcome, readLand, retryableLand } from './land-state.js';
import { startLand } from './land.js';
import { ticketReadiness } from './local-tickets.js';
import { jobFiles } from './paths.js';
import { piReportSettlement } from './pi-read-settlement.js';
import { directory, findJob, hudHome, jobCache, jobs, readRow } from './store/job-store.js';
import {
  readTicketQueue, ticketQueueNotice, writeTicketQueue,
  type TicketHandbackKind, type TicketQueue, type TicketQueueItem,
} from './ticket-queue-state.js';

const cleanStates = ['idle_grace', 'done', 'closed'];
const LAUNCH_GRACE_MS = 120_000, LAUNCH_RECHECK_MS = 5_000;
const errorLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0];
const owner = (q: TicketQueue, item: TicketQueueItem) => item.dispatch_queue ?? q.flow;
const requestKey = (q: TicketQueue, item: TicketQueueItem) => `ticket-queue:${owner(q, item)}:${item.ticket}`;
const receiptFor = (q: TicketQueue, item: TicketQueueItem) => jobs().find(job => job.request_key === requestKey(q, item));

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

type SettlementVerdict = '' | { waitMs: number } | { kind: TicketHandbackKind; reason: string };
function judgeSettlement(item: TicketQueueItem, job: Job, status: JobStatus): SettlementVerdict {
  const dir = directory(job.job);
  const sig = declaredReport(dir, job, status);
  if (!sig) return { kind: 'worker', reason: 'settled without a declared report for this turn' };
  const report = readFileBounded(join(dir, jobFiles.report), 1024 * 1024);
  if (report.truncated) return { kind: 'worker', reason: 'report is too large to verify' };
  if (/^[ \t]*(?:[-*] |#{1,6} )?(?:\*\*)?Blockers:/im.test(report.bytes.toString('utf8')))
    return { kind: 'blocker', reason: 'report has a Blockers: line' };
  if (readReportMeta(dir, sig)?.skip_checks_reason) return { kind: 'check', reason: 'worker checks were skipped' };
  if (/(?:^|·)[ \t]*\*\*Main review:\*\*[ \t]*yes\b/im.test(ticketHeader(item.path)))
    return { kind: 'review', reason: 'ticket is marked for main review' };
  if (job.checks?.length) {
    const binding = checkBinding(dir, job, status);
    if (!binding) return { kind: 'check', reason: 'HUD check binding unavailable' };
    const receipt = readCheckReceipt(dir), current = receipt && sameChecks(binding, receipt);
    if (current && receipt.results.some(result => result.exit_code !== 0)) return { kind: 'check', reason: 'HUD checks failed' };
    if (!current || receipt.state !== 'done') {
      const since = current ? fs.statSync(join(dir, jobFiles.checks), { throwIfNoEntry: false })?.mtimeMs : undefined;
      const left = (since ?? Date.parse(status.settled_at!)) + job.checks.length * CHECK_TIMEOUT_MS + 5000 - Date.now();
      return left <= 0 ? { kind: 'check', reason: 'HUD check results unavailable' } : { waitMs: Math.min(left, LAUNCH_RECHECK_MS) };
    }
    if (receipt.results.length !== job.checks.length) return { kind: 'check', reason: 'HUD check results incomplete' };
  }
  return '';
}

export interface TicketProblem {
  kind: TicketHandbackKind;
  reason: string;
  ticket?: string;
  job?: string;
  question?: string;
  land?: string;
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

function terminalNotice(q: TicketQueue) {
  return q.task ? {} : { [`end-${q.epoch ?? 0}`]: ticketQueueNotice(q).replace(/\r?\n/g, ' | ') };
}

/** Hand-back seam for workflow/07 (lead acceptance). Without a lead handler, the
 * first-breaker policy hands every problem back to the caller as a failed receipt. */
export function settleTicketHandback(q: TicketQueue, problem?: TicketProblem) {
  const step = q.handback?.step ?? 'tickets';
  q.handback = {
    step,
    choices: ['resume', 'stop'],
    ...(problem && {
      kind: problem.kind,
      ...(problem.ticket && { ticket: problem.ticket }),
      ...(problem.job && { job: problem.job }),
      ...(problem.question && { question: problem.question }),
      ...(problem.land && { land: problem.land }),
    }),
  };
  q.state = 'failed';
  q.queued = undefined;
  q.remaining = computeRemaining(q);
  q.notices = terminalNotice(q);
}

function recoverTicketQueue(q: TicketQueue) {
  // A crash between admission and the queue update does not issue a second create.
  for (const item of q.tickets) if (!item.job) item.job = receiptFor(q, item)?.job;
}

function tickTicketQueue(
  q: TicketQueue,
  step: Extract<Step, { kind: 'batch' }>,
  state: { problem?: TicketProblem },
): Tick {
  if (!step.tickets) throw Error('ticket-queue batch step requires a tickets source');
  const landEach = !step.each || step.each.includes('land');
  let problem = state.problem, changed = false, recheck: number | undefined;
  const note = (p: TicketProblem) => { problem ??= p; };
  const clean: { item: TicketQueueItem; job: Job; state: JobStatus['state']; retry?: string }[] = [];

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
    if (question) flag('question', `worker question ${question} — use hud_read or hud_respond`, { question });
    else if (fs.existsSync(join(directory(job.job), jobFiles.stopRequested))) flag('worker', 'worker stop requested');
    else if (failedAttempt(row)) flag('worker', row.reason ?? row.display_state);
    else if (!answered && (row.blocked || row.state === 'blocked' || row.state === 'waiting_orchestrator'))
      flag('worker', row.reason ?? 'worker needs main');
    else if (!status && job.dispatch_exit_code === null) {
      // A runner that took over mid-launch sees the job before its first status: wait while the launching
      // process lives (launches under load can take minutes); legacy receipts without one get a fixed grace.
      const left = job.launcher ? (isProcAlive(job.launcher.pid, job.launcher.start) ? LAUNCH_RECHECK_MS : 0)
        : Date.parse(job.created_at) + LAUNCH_GRACE_MS - Date.now();
      if (left > 0) recheck = Math.min(recheck ?? left, left);
      else flag('dispatch', 'dispatch interrupted before worker status was recorded');
    } else if (status && cleanStates.includes(status.state)) {
      const verdict = judgeSettlement(item, job, status);
      if (verdict === '') {
        if (landEach) clean.push({ item, job, state: status.state, retry });
        else { item.landed = true; changed = true; }
      } else if ('waitMs' in verdict) {
        recheck = Math.min(recheck ?? verdict.waitMs, verdict.waitMs);
      } else {
        flag(verdict.kind, verdict.reason);
      }
    }
  }

  if (stopRequested(hudHome, q.flow)) {
    q.state = 'cancelled';
    q.reason = 'cancelled: no more dispatches or lands started';
    return { state: 'cancelled', changed: true };
  }
  if (problem) {
    state.problem = problem;
    return { state: 'failed', reason: problem.reason, changed: true };
  }
  if (clean.length) {
    const flowId = q.flow, pane = q.pane || null;
    // Queue together, letting the existing land train decide whether they can share a gate.
    return { state: 'running', changed: true, effect: async () => {
      const results = await Promise.allSettled(clean.map(async ({ item, job, state: jobState, retry }) => {
        try {
          const land = await startLand(hudHome, job.job, job, jobState, pane, false, flowId, retry);
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
  const { tickets: eligible, queued } = ticketReadiness(q.root, jobCache, step.tickets);
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
  const flowId = q.flow, root = q.root, pane = q.pane || undefined, dispatcher = q.dispatcher;
  return { state: 'running', changed: true, effect: async () => {
    let job: string | undefined, err: string | undefined;
    const canAdmit = () => {
      const cur = readTicketQueue(hudHome, flowId);
      return cur?.state === 'working' && !stopRequested(hudHome, flowId);
    };
    try {
      const result = await dispatchJob({ role: launching.role, cwd: root, isolation: 'worktree', ticket: launching.ticket,
        brief_file: launching.path, request_key: reqKey }, pane,
        { queue: { id: queueId, canAdmit }, dispatcher });
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

export async function driveTicketQueue(id: string) {
  const initial = readTicketQueue(hudHome, id);
  if (!initial || initial.state !== 'working') return;
  const dir = runDir(hudHome, id);
  const state: { problem?: TicketProblem } = {};
  await driveWorkflow<TicketQueue>(hudHome, id, {
    read: () => readTicketQueue(hudHome, id)!,
    header: q => q as TicketQueue & Run,
    save: q => {
      if (q.state === 'paused') {
        settleTicketHandback(q, state.problem ?? { kind: 'queue', reason: q.reason ?? 'ticket queue error' });
      } else if (q.state === 'completed') {
        q.queued = undefined;
        q.remaining = [];
        q.notices = terminalNotice(q);
      } else if (q.state === 'cancelled') {
        q.queued = undefined;
        q.remaining = computeRemaining(q);
        q.notices = terminalNotice(q);
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
      q.steps ??= { tickets: { state: 'running' } };
      recoverTicketQueue(q);
      return graph;
    },
    tick: (q, _key, step) => {
      if (step.kind !== 'batch') throw Error(`unsupported ticket-queue step ${step.kind}`);
      return tickTicketQueue(q, step, state);
    },
    active: q => q.state === 'working',
    watches: q => [
      // Land receipts already wake this runner across features. Watch cancel + blocker edits too (e.g. wontfix).
      { dir: join(hudHome, 'flows'), filter: file => !file || file === `${q.flow}.json.cancel` || /^f[a-f0-9]{16}(?:-\d+)?\.json$/.test(file) },
      ...(q.queued ?? []).flatMap(item => item.blockers.map(ref => ({ dir: join(q.root, '.scratch', ref.split('/')[0].toLowerCase(), 'issues') }))),
      ...q.tickets.flatMap(item => item.job && !item.landed ? [{ dir: directory(item.job), recursive: true,
        filter: (file: string | null) => !file || /^(?:qa(?:\/q\d+\.md)?|STATUS\.json(?:\.stop-requested)?|report\.md|checks\.json|job\.json|done\.json|turn\.json)$/.test(file) }] : []),
    ],
    readerNotices: true,
    errorLine: run => `${id} ticket queue failed: ${run.reason}`,
  });
}
