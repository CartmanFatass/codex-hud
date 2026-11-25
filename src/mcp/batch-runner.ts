/** HUD (not a model job) drives the fixed manifest. Only admission creates a normal job;
 * no ordinary queue entry exists for the breaker or a stop to race past. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { notify, watching } from '../roles/notify.js';
import { readReportMeta } from '../roles/report-meta.js';
import { tryAbstractLock } from '../utils/abstract-lock.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import { waitUntilFs } from '../utils/fs-wait.js';
import { isProcAlive, procStat } from '../utils/proc.js';
import { batchActive, batchDir, batchEvents, batchIndex, batchLock, isBatchId, readBatch, saveBatch, settleItem, type ItemResult, type Manifest } from './batch-state.js';
import { batchHasRoom, dispatchJob } from './dispatch/orchestrator.js';
import { directory, findJob, hudHome, jobCache, jobs, readRow } from './store/job-store.js';
import { jobFiles } from './paths.js';

function outcome(i: ItemResult) {
  const job = findJob(i.job!);
  if (!job) return { at: 0, failure: 'job receipt missing' };
  const { row, status } = readRow(job, false, null);
  let failure: string | undefined;
  if (row.display_state === 'failed' || row.display_state === 'stopped') failure = status?.exit_reason || row.reason || row.display_state;
  else if (row.display_state === 'done') {
    if (!row.report_present || status?.output_written === false) failure = 'settled without report';
  } else if (!status && job.launcher && !isProcAlive(job.launcher.pid, job.launcher.start)) failure = 'dispatch interrupted before worker status';
  else if (i.pilot && !row.open_questions && (row.blocked || (row.state === 'waiting_orchestrator' && !jobCache.readQa(directory(job.job)).allQuestionFiles.length))) return { at: 0, stall: row.reason || 'worker needs input' };
  else return;
  if (row.report_present) {
    i.report_path = join(directory(job.job), jobFiles.report);
    i.files = readReportMeta(directory(job.job))?.files ?? [];
  }
  return { at: Date.parse(status?.ended_at ?? status?.settled_at ?? '') || 0, failure };
}

export async function runBatch(id: string) {
  if (!isBatchId(id)) return;
  const release = await tryAbstractLock('batch-runner', `${hudHome}\0${id}`);
  if (!release) return;
  const locked = <T>(fn: (state: ReturnType<typeof batchIndex>) => T) => batchLock(hudHome, id, () => fn(batchIndex(hudHome, id)));
  try {
    const manifest = readJsonFile(join(batchDir(hudHome, id), 'manifest.json')) as Manifest;
    const requestKey = (i: ItemResult) => `batch:${id}:${i.item}:${i.previous?.length ?? 0}`;
    await locked(({ batch, items }) => {
      batch.pid = process.pid; batch.start = procStat(process.pid)?.start;
      // Recover the admission/receipt gap. Never reissue an admitted job.
      const admitted = jobs().filter(j => j.batch_flow === id);
      for (const i of items) if (i.state === 'running' && !i.job) {
        i.job = admitted.find(j => j.request_key === requestKey(i))?.job;
        if (!i.job) i.state = batch.state === 'stopped' ? 'cancelled' : 'waiting';
      }
      saveBatch(hudHome, batch, items);
    });
    let active: string[] = [];
    await waitUntilFs({ timeoutMs: Infinity,
      targets: () => [{ dir: join(hudHome, 'flows'), filter: f => !f || f === `${id}.json` },
        ...active.map(job => ({ dir: directory(job), filter: (f: string | null) => !f || f === jobFiles.status || f === jobFiles.job || f === jobFiles.report }))],
      check: async () => {
        const next = await locked(({ batch: b, items }) => {
          let changed = false;
          const settled = items.flatMap(i => {
            if (i.state !== 'running' || !i.job) return [];
            const result = outcome(i); return result ? [{ i, ...result }] : [];
          }).sort((a,c) => a.at - c.at || a.i.item - c.i.item);
          for (const { i, failure, stall } of settled) {
            if (stall) {
              if (b.state !== 'working' || i.stall === stall) continue;
              i.stall = stall; b.state = 'paused'; b.reason = `pilot ${i.item} (${i.job}) stalled: ${stall.slice(0, 300)}`;
              b.notices[`pause-${b.epoch}`] = `${id} batch paused — ${b.reason}; use hud_create batch=${id} action=resume or stop`;
            } else settleItem(b, items, i, failure);
            changed = true;
          }
          const running = items.filter(i => i.state === 'running');
          active = running.flatMap(i => i.job ?? []);
          const pilot = items.some(i => i.pilot && (i.state === 'waiting' || i.state === 'running'));
          const next = b.state === 'working' && running.length < b.scale.max_parallel ? items.find(i => i.state === 'waiting' && (!pilot || i.pilot)) : undefined;
          const item = next && batchHasRoom(b.scale.role) ? next : undefined;
          if (item) { item.state = 'running'; changed = true; }
          if (changed) saveBatch(hudHome, b, items);
          return { b, item };
        });
        const { b, item } = next;
        if (!watching(b.pane, hudHome)) {
          for (const { line, marker } of batchEvents(hudHome, b)) {
            const sent = await notify(b.pane, line, hudHome);
            if (sent.skipped || sent.status !== 0) fs.rmSync(marker, { force: true }); // watch/changes fallback
          }
        }
        if (!item) return batchActive(b) ? { done: false } : { done: true, value: undefined };
        const input = manifest.items[item.item-1];
        let job: string | undefined, failure: string | undefined, deferred = false;
        try {
          const result = await dispatchJob({ ...manifest.shared, cwd: b.cwd, task: input.task,
            ...(input.package !== undefined && { package: input.package }), request_key: requestKey(item) }, b.pane,
            { dispatcher: b.dispatcher, member: { flow: id, route: input.route, canAdmit: () => readBatch(hudHome, id)?.state === 'working' } });
          if ('job' in result) job = result.job;
          else if ('code' in result) {
            deferred = result.code === 'batch_wait' || result.code === 'queue_stopped';
            failure = ('reason' in result && result.reason) || ('error' in result && result.error) || result.code;
          }
        } catch (error) { failure = String(error); }
        await locked(({ batch: current, items }) => {
          const i = items[item.item-1];
          job ??= jobs().find(j => j.batch_flow === id && j.request_key === requestKey(i))?.job;
          if (job) i.job = job;
          else if (deferred) i.state = current.state === 'stopped' ? 'cancelled' : 'waiting';
          else settleItem(current, items, i, failure || 'dispatch failed');
          saveBatch(hudHome, current, items);
        });
        return { done: false, recheckMs: deferred ? 500 : 0 };
      },
    });
  } catch (error) {
    await locked(({ batch, items }) => {
      batch.state = 'paused'; batch.reason = String(error).slice(0, 300);
      batch.notices[`error-${batch.epoch}`] = `${id} batch paused: ${batch.reason}; use hud_create batch=${id} action=resume or stop`;
      saveBatch(hudHome, batch, items);
    });
  } finally { await release(); }
}
