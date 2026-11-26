/** The batch executor stages one manifest admission per tick. Capacity is checked again
 * inside dispatchJob's concurrency lock; a manifest waiter is never an ordinary queued job. */
import { join } from 'node:path';
import { failedAttempt, settledJobReport } from '../collectors/thin-jobs.js';
import { readReportMeta } from '../roles/report-meta.js';
import { isProcAlive } from '../utils/proc.js';
import type { Breaker, Step } from '../workflows/graph.js';
import { pauseRun, type Tick } from '../workflows/engine.js';
import { batchIndex, batchLock, readBatch, saveBatch, settleItem, type Batch, type ItemResult, type Manifest } from './batch-state.js';
import { batchHasRoom, dispatchJob } from './dispatch/orchestrator.js';
import { directory, findJob, hudHome, jobCache, jobs, readRow } from './store/job-store.js';
import { jobFiles } from './paths.js';
import type { Job } from './job-contracts.js';

export function batchJobOutcome(job: Job, pilot: boolean): { at: number; failure?: string; stall?: string; report?: boolean } | undefined {
  const { row, status } = readRow(job, false, null);
  let failure: string | undefined;
  if (failedAttempt(row)) failure = status?.exit_reason || row.reason || row.display_state;
  else if (row.display_state === 'done') {
    if (!settledJobReport(row, status)) failure = 'settled without report';
  } else if (!status && job.launcher && !isProcAlive(job.launcher.pid, job.launcher.start)) failure = 'dispatch interrupted before worker status';
  else if (pilot && !row.open_questions && (row.blocked || (row.state === 'waiting_orchestrator' && !jobCache.readQa(directory(job.job)).allQuestionFiles.length))) return { at: 0, stall: row.reason || 'worker needs input' };
  else return;
  return { at: Date.parse(status?.ended_at ?? status?.settled_at ?? '') || 0, failure, report: row.report_present };
}
function outcome(i: ItemResult) {
  const job = findJob(i.job!);
  if (!job) return { at: 0, failure: 'job receipt missing' };
  const result = batchJobOutcome(job, i.pilot);
  if (result?.report) {
    i.report_path = join(directory(job.job), jobFiles.report);
    i.files = readReportMeta(directory(job.job))?.files ?? [];
  }
  return result;
}
const requestKey = (id: string, i: ItemResult) => `batch:${id}:${i.item}:${i.previous?.length ?? 0}`;
export function recoverBatch(b: Batch, items: ItemResult[], breaker: Breaker) {
  const gaps = items.filter(i => i.state === 'running' && !i.job);
  if (!gaps.length) return;
  const admitted = jobs().filter(j => j.batch_flow === b.flow);
  for (const i of gaps) {
    i.job = admitted.find(j => j.request_key === requestKey(b.flow, i))?.job;
    // No receipt is not proof the effect never happened. Only an explicit retry may reissue.
    if (!i.job) settleItem(b, items, i, 'dispatch interrupted without a job receipt', breaker);
  }
}
export function tickBatch(b: Batch, items: ItemResult[], step: Extract<Step, { kind: 'batch' }>, manifest: Manifest, breaker: Breaker): Tick {
  const id = b.flow;
  let changed = false;
  const settled = items.flatMap(i => {
    if (i.state !== 'running' || !i.job) return [];
    const result = outcome(i); return result ? [{ i, ...result }] : [];
  }).sort((a,c) => a.at - c.at || a.i.item - c.i.item);
  for (const { i, failure, stall } of settled) {
    if (stall) {
      if (breaker === 'none' || b.state !== 'working' || i.stall === stall) continue;
      i.stall = stall; b.pilot_changed_at = Date.now(); pauseRun(b, 'items', `pilot ${i.item} (${i.job}) stalled: ${stall.slice(0, 300)}`);
      b.notices[`pause-${b.epoch}`] = `${id} batch paused — ${b.reason}; use hud_create batch=${id} action=resume or stop`;
    } else settleItem(b, items, i, failure, breaker);
    changed = true;
  }
  const running = items.filter(i => i.state === 'running').length;
  const pilot = items.some(i => i.pilot && (i.state === 'waiting' || i.state === 'running'));
  const next = b.state === 'working' && running < (step.max_parallel ?? b.scale.max_parallel) ? items.find(i => i.state === 'waiting' && (!pilot || i.pilot)) : undefined;
  if (!next || !batchHasRoom(step.role)) return { state: !running && !items.some(i => i.state === 'waiting') ? 'done' : 'running', changed };
  next.state = 'running';
  const startedAt = Date.now();
  if (next.pilot) b.pilot_changed_at = startedAt;
  else b.pool_changed_at = startedAt;
  return { state: 'running', effect: async () => {
    const input = manifest.items[next.item-1];
    let job: string | undefined, failure: string | undefined, deferred = false;
    try {
      const result = await dispatchJob({ ...manifest.shared, role: step.role, cwd: b.cwd, task: input.task,
        ...(input.package !== undefined && { package: input.package }), request_key: requestKey(id, next) }, b.pane,
        { dispatcher: b.dispatcher, member: { flow: id, route: input.route, canAdmit: () => readBatch(hudHome, id)?.state === 'working' } });
      if ('job' in result) job = result.job;
      else if ('code' in result) {
        deferred = result.code === 'batch_wait' || result.code === 'queue_stopped';
        failure = ('reason' in result && typeof result.reason === 'string' && result.reason) || ('error' in result && result.error) || result.code;
      }
    } catch (error) { failure = String(error); }
    await batchLock(hudHome, id, () => {
      const { batch: current, items } = batchIndex(hudHome, id), i = items[next.item-1];
      job ??= jobs().find(j => j.batch_flow === id && j.request_key === requestKey(id, i))?.job;
      if (job) {
        i.job = job;
        const boundAt = Date.now();
        if (i.pilot) current.pilot_changed_at = boundAt;
        else current.pool_changed_at = boundAt;
      }
      else if (deferred) i.state = current.state === 'stopped' ? 'cancelled' : 'waiting';
      else settleItem(current, items, i, failure || 'dispatch failed', breaker);
      saveBatch(hudHome, current, items);
    });
    return deferred ? 500 : 0;
  } };
}
