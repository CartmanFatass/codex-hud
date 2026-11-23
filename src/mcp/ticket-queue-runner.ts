/** A batch-local driver. The watcher can restart it; job and land receipts fence each side effect. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { failedAttempt } from '../collectors/thin-jobs.js';
import { checkBinding, CHECK_TIMEOUT_MS, readCheckReceipt, sameChecks } from '../roles/job-checks.js';
import { cachedReportSignature, readReportMeta } from '../roles/report-meta.js';
import { tryAbstractLock } from '../utils/abstract-lock.js';
import { readFileBounded } from '../utils/atomic-fs.js';
import { waitUntilFs } from '../utils/fs-wait.js';
import { procStat } from '../utils/proc.js';
import { readTurn, readDone, receiptForTurn } from '../roles/cli-turn.js';
import { dispatchJob } from './dispatch/orchestrator.js';
import type { Job, JobStatus } from './job-contracts.js';
import { activeLand, landAttempt, landOutcome, readLand, retryableLand } from './land-state.js';
import { startLand } from './land.js';
import { readyTickets } from './local-tickets.js';
import { jobFiles } from './paths.js';
import { piReportSettlement } from './pi-read-settlement.js';
import { directory, findJob, hudHome, jobCache, jobs, readRow } from './store/job-store.js';
import { queueCancelled, queueFile, readTicketQueue, writeTicketQueue, type TicketQueue, type TicketQueueItem } from './ticket-queue-state.js';

const cleanStates = ['idle_grace', 'done', 'closed'];
const errorLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0];
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
function judgeSettlement(item: TicketQueueItem, job: Job, status: JobStatus): string | null {
  const dir = directory(job.job);
  const sig = declaredReport(dir, job, status);
  if (!sig) return 'settled without a declared report for this turn';
  const report = readFileBounded(join(dir, jobFiles.report), 1024 * 1024);
  if (report.truncated) return 'report is too large to verify';
  if (/^[ \t]*(?:[-*] |#{1,6} )?(?:\*\*)?Blockers:/im.test(report.bytes.toString('utf8'))) return 'report has a Blockers: line';
  if (readReportMeta(dir, sig)?.skip_checks_reason) return 'worker checks were skipped';
  if (/(?:^|·)[ \t]*\*\*Main review:\*\*[ \t]*yes\b/im.test(ticketHeader(item.path))) return 'ticket is marked for main review';
  if (job.checks?.length) {
    const binding = checkBinding(dir, job, status);
    if (!binding) return 'HUD check binding unavailable';
    const receipt = readCheckReceipt(dir), current = receipt && sameChecks(binding, receipt);
    if (current && receipt.results.some(result => result.exit_code !== 0)) return 'HUD checks failed';
    if (!current || receipt.state !== 'done') {
      const since = current ? fs.statSync(join(dir, jobFiles.checks), { throwIfNoEntry: false })?.mtimeMs : undefined;
      return Date.now() > (since ?? Date.parse(status.settled_at!)) + job.checks.length * CHECK_TIMEOUT_MS + 5000
        ? 'HUD check results unavailable' : null;
    }
    if (receipt.results.length !== job.checks.length) return 'HUD check results incomplete';
  }
  return '';
}

async function drive(q: TicketQueue) {
  const save = () => writeTicketQueue(hudHome, q);
  const owner = (item: TicketQueueItem) => item.dispatch_queue ?? q.flow;
  const key = (item: TicketQueueItem) => `ticket-queue:${owner(item)}:${item.ticket}`;
  const receiptFor = (item: TicketQueueItem) => jobs().find(job => job.request_key === key(item));
  // A crash between admission and the queue update does not issue a second create.
  for (const item of q.tickets) {
    if (!item.job && (item.job = receiptFor(item)?.job)) save();
  }
  let dispatching: TicketQueueItem | undefined, pending: Promise<void> | undefined, dispatchError: string | undefined;
  const canAdmit = () => q.state === 'working' && !queueCancelled(hudHome, q);
  const finish = (state: TicketQueue['state'], reason?: string) => {
    q.state = state; q.reason = reason;
    q.remaining = q.tickets.flatMap(item => {
      if (item === dispatching) item.job ??= receiptFor(item)?.job;
      if (!item.job || item.landed) return [];
      const land = item.land ? readLand(hudHome, item.land) : landAttempt(hudHome, item.job).prior;
      if (land) return activeLand(land) ? [`${item.ticket} (${land.flow}${land.repairs?.at(-1)?.job ? `, ${land.repairs.at(-1)!.job}` : ''})`] : [];
      const job = findJob(item.job), state = job && readRow(job, false, null).row.state;
      return !state || ![...cleanStates, 'failed', 'stopped'].includes(state) ? [`${item.ticket} (${item.job})`] : [];
    });
    save();
    return { done: true as const, value: undefined };
  };
  const ready = () => readyTickets(q.root, jobCache, q.feature).tickets;
  try {
    await waitUntilFs({
      timeoutMs: Infinity,
      targets: () => [{ dir: join(hudHome, 'flows'), filter: (file) => !file || file === `${q.flow}.json.cancel` || /^f[a-f0-9]{16}(?:-\d+)?\.json$/.test(file) || file === `${q.flow}.json` },
        ...q.tickets.flatMap(item => item.job && !item.landed ? [{ dir: directory(item.job), recursive: true,
          filter: (file: string | null) => !file || /^(?:qa(?:\/q\d+\.md)?|STATUS\.json(?:\.stop-requested)?|report\.md|checks\.json|job\.json|done\.json|turn\.json)$/.test(file) }] : [])],
      check: async () => {
        let issue = dispatchError, changed = false;
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
              else issue ??= `${item.ticket} land ${land.flow}: ${landOutcome(land)}`;
            }
            if (!retry) continue;
          } else if (item.land) { issue ??= `${item.ticket} land receipt missing (${item.land})`; continue; }
          const job = findJob(item.job);
          const flag = (why: string) => { issue ??= `${item.ticket} (${item.job}): ${why}`; };
          if (!job) { flag('job receipt missing'); continue; }
          if (job.ticket_queue !== owner(item)) { flag('job taken over outside the ticket queue'); continue; }
          const { row, status } = readRow(job, false, null);
          const question = jobCache.readQa(directory(job.job)).allQuestionFiles[0];
          if (question) flag(`worker question ${question.slice(0, -3)} — use hud_read or hud_respond`);
          else if (fs.existsSync(join(directory(job.job), jobFiles.stopRequested))) flag('worker stop requested');
          else if (failedAttempt(row)) flag(row.reason ?? row.display_state);
          else if (row.blocked || row.state === 'blocked' || row.state === 'waiting_orchestrator') flag(row.reason ?? 'worker needs main');
          else if (!status && job.dispatch_exit_code === null) flag('dispatch interrupted before worker status was recorded');
          else if (status && cleanStates.includes(status.state)) {
            const verdict = judgeSettlement(item, job, status);
            if (verdict) flag(verdict);
            else if (verdict === '') clean.push({ item, job, state: status.state, retry });
          }
        }
        if (queueCancelled(hudHome, q)) return finish('cancelled', 'cancelled: no more dispatches or lands started');
        if (issue) return finish('failed', issue);
        if (changed) save();
        if (clean.length) {
          // Queue together, letting the existing land train decide whether they can share a gate.
          const results = await Promise.allSettled(clean.map(async ({ item, job, state, retry }) => {
            try {
              const land = await startLand(hudHome, job.job, job, state, q.pane, false, q.flow, retry);
              item.land = land.flow;
            } catch (error) { throw Error(`${item.ticket} (${job.job}): cannot start land: ${errorLine(error)}`); }
          }));
          const failed = results.find(result => result.status === 'rejected');
          if (failed) return finish('failed', errorLine(failed.reason));
          save();
          return { done: false };
        }
        const active = q.tickets.filter(item => !item.landed).length;
        if (dispatching || (q.max_parallel && active >= q.max_parallel && q.tickets.every(item => item.job))) return { done: false };
        let item = q.tickets.find(item => !item.job);
        const eligible = ready();
        if (item && !eligible.some(t => t.ticket === item!.ticket && t.path === item!.path))
          return finish('failed', `${item.ticket}: no longer ready after recovery`);
        const next = item ? [] : eligible.filter(t => !q.tickets.some(own => own.ticket === t.ticket));
        if (next.length) {
          const { ticket, path } = next[0];
          if (next.some((entry, i) => i > 0 && entry.ticket === ticket)) return finish('failed', `${ticket}: ambiguous ticket number`);
          const frontend = /(?:^|·)[ \t]*\*\*(?:Role|Who):\*\*[ \t]*frontend-(?:imp|implementer)(?=[ \t\r\n·(]|$)/im.test(ticketHeader(path));
          item = { ticket, path, role: frontend ? 'frontend-imp' : 'imp' };
          q.tickets.push(item);
          save(); // Record intent before dispatch so the request key is recoverable.
        }
        if (!item) return active ? { done: false } : finish('completed');
        // Observe the other workers while launch is in flight. Admission rechecks the stop before writing a job.
        const launching = dispatching = item;
        pending = (async () => {
          try {
            const result = await dispatchJob({ role: launching.role, cwd: q.root, isolation: 'worktree', ticket: launching.ticket,
              brief_file: launching.path, request_key: key(launching) }, q.pane, undefined, undefined, false, undefined, { id: owner(launching), canAdmit });
            if (q.state !== 'working') return;
            if ('job' in result && typeof result.job === 'string') launching.job = result.job;
            if (!launching.job || ('ok' in result && result.ok === false)) {
              const why = ('reason' in result && result.reason) || ('error' in result && result.error) || ('code' in result && result.code) || 'no worker';
              throw Error(String(why));
            }
          } catch (error) { dispatchError = `${launching.ticket}: dispatch failed (${errorLine(error)})`; }
          finally {
            dispatching = undefined;
            try { if (q.state === 'working') save(); }
            catch (error) { dispatchError ??= errorLine(error); }
          }
        })();
        return { done: false };
      },
    });
  } catch (error) { finish('failed', errorLine(error)); }
  finally { await pending; }
}

export async function runTicketQueue(id: string) {
  const release = await tryAbstractLock('ticket-runner', `${hudHome}\0${id}`);
  if (!release) return;
  try {
    const q = readTicketQueue(hudHome, id);
    if (!q || q.state !== 'working') return;
    q.pid = process.pid;
    q.start = procStat(process.pid)?.start;
    writeTicketQueue(hudHome, q);
    await drive(q);
  } finally { await release(); }
}
