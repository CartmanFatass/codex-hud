import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { batchActive, batchEvents, isBatchId, type Batch } from '../mcp/batch-state.js';
import { isAutoLandFlakeJob } from '../mcp/flake-admission.js';
import type { Job } from '../mcp/job-contracts.js';
import { activeLand, isFlowId, landFile, landNoticeLine, readLand } from '../mcp/land-state.js';
import { isTicketQueueId, ticketQueueNotice, type TicketQueue } from '../mcp/ticket-queue-state.js';
import { getJobIndexCache } from '../roles/job-index-cache.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { sharedRoot } from '../roles/projects.js';
import { writePrivateFile } from '../utils/atomic-fs.js';
import { reportReadHint } from '../utils/report-summary.js';
import { composedActive, isComposedId, type ComposedRun } from './composed-state.js';
import { workflowHeaders } from './header-scan.js';
import { directRecipient, runNoticeRecipient, runVisible } from './scope.js';
import { noticeEvents } from './store.js';

const queueScope = (q: TicketQueue) => q.project_root ? q : { ...q, project_root: q.root };

function flakeBlockEvents(home: string, pane: string | null, cwd: string) {
  const cache = getJobIndexCache(home);
  // These handbacks can precede any flow. Only read recent job receipts; QA
  // and report bodies are not needed to deliver the persisted decision.
  return cache.listJobDirsByMtime({ limit: 200 }).dirs.flatMap(({ id, dir }) => {
    const receipt = cache.readJob<Job>(id);
    if (receipt.status !== 'ok') return [];
    const job = receipt.value, block = job.auto_land_blocked, main = job.worktree?.main_root;
    if (job.job !== id || !isAutoLandFlakeJob(job) || !main || typeof block?.reason !== 'string') return [];
    const owner = jobCallerPane(job);
    if (owner ? owner !== pane : main !== cwd && main !== sharedRoot(cwd)) return [];
    if (fs.existsSync(landFile(home, `f${id.slice(1)}`))) return [];
    // One claim per persisted refusal, retained with the job. panelDelivery
    // releases it when typing fails so changes or the next tick can retry.
    const key = createHash('sha256').update(JSON.stringify([block.at, block.sig, block.reason])).digest('hex').slice(0, 16);
    const marker = join(dir, `auto-land-blocked-${key}.noticed`);
    if (fs.existsSync(marker)) return [];
    const reason = block.reason.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
    try { writePrivateFile(marker, '', { exclusive: true, mkdir: false }); }
    catch { return []; } // Another delivery claimed it, or this receipt cannot be claimed now.
    return [{ line: `${id}: auto-land blocked: ${reason} | ${reportReadHint(id)}`, marker }];
  });
}

export function taskNoticeSource(home: string, pane: string | null, cwd: string) {
  const dir = join(home, 'flows');
  let previous: string | undefined, composed: ComposedRun[] = [], queues: { id: string; q: TicketQueue }[] = [];
  const queueEvents = (id: string, q: TicketQueue) => {
    if (!q.notices || !runNoticeRecipient(queueScope(q), pane, cwd)) return [];
    if (q.task && q.state !== 'working' && directRecipient(q)) return [];
    return noticeEvents(home, { flow: id, notices: q.notices }, false, landFile(home, id));
  };
  const flowEvents = () => {
    // Only list flows when a receipt changed. Composed/queue claims live in child
    // directories and an origin MCP can exit without changing this stamp.
    const st = fs.statSync(dir, { bigint: true, throwIfNoEntry: false });
    const stamp = st && `${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}`;
    if (stamp === previous) return [
      ...queues.flatMap(({ id, q }) => queueEvents(id, q)),
      ...composed.flatMap(run => runNoticeRecipient(run, pane, cwd) ? noticeEvents(home, run) : []),
    ];
    composed = [];
    queues = [];
    if (!stamp) { previous = undefined; return []; }
    const pass = workflowHeaders(home);
    const events = pass.files.flatMap(file => {
      if (!file.endsWith('.json')) return [];
      const id = file.slice(0, -5);
      if (isTicketQueueId(id)) {
        const q = pass.header<TicketQueue>(file);
        if (!q?.notices || !Object.keys(q.notices).length || !runVisible(queueScope(q), pane, cwd)) return [];
        queues.push({ id, q });
        return queueEvents(id, q);
      }
      if (isFlowId(id)) {
        const f = readLand(home, id, pass);
        if (!f?.wt || !f.auto_land || f.task || f.ticket_queue || f.state !== 'failed') return [];
        const sameProject = f.wt.main_root === cwd || f.wt.main_root === sharedRoot(cwd);
        if (f.pane ? f.pane !== pane : !sameProject) return [];
        const path = landFile(home, id);
        if (fs.existsSync(`${path}.noticed`)) return [];
        const outbox = f.workflow ?? { flow: id, notices: { 'end-0': landNoticeLine(f) } };
        return noticeEvents(home, outbox, false, path);
      }
      if (!isComposedId(id)) return [];
      const run = pass.header<ComposedRun>(file);
      if (run?.template !== 'composed' || !Object.keys(run.notices).length || !runVisible(run, pane, cwd)) return [];
      composed.push(run);
      return runNoticeRecipient(run, pane, cwd) ? noticeEvents(home, run) : [];
    });
    // Keep the stamp dirty when events were claimed so a released marker retries on the next tick.
    if (!events.length) previous = stamp;
    return events;
  };
  return () => [...flowEvents(), ...flakeBlockEvents(home, pane, cwd)];
}

/** Scan active runs and unclaimed terminal results. Quiet passes only parse a
 * changed header; previously claimed land/queue results don't even need a stat. */
export function workflowEvents(home: string, pane: string | null, all = false, cwd = process.cwd(), modCatchup = false) {
  const events: { line: string; marker: string }[] = [];
  let pending = false;
  const pass = workflowHeaders(home);
  for (const file of pass.files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    if (isComposedId(id)) {
      const run = pass.header<ComposedRun>(file);
      if (run?.template === 'composed' && (all || runNoticeRecipient(run, pane, cwd))) {
        events.push(...noticeEvents(home, run, all));
        pending ||= composedActive(run);
      }
      continue;
    }
    if (isBatchId(id)) {
      const b = pass.header<Batch>(file);
      if (b && (all || runNoticeRecipient(b, pane, cwd))) {
        events.push(...batchEvents(home, b, all));
        pending ||= batchActive(b);
      }
      continue;
    }
    const land = isFlowId(id);
    if (!land && !isTicketQueueId(id)) continue;
    const path = landFile(home, id);
    if (fs.existsSync(`${path}.${all ? 'observed' : 'noticed'}`)) continue;
    if (land) {
      const f = readLand(home, id, pass);
      if (!f?.wt || f.task || f.ticket_queue) continue;
      if (f.auto_land && f.state === 'completed') continue;
      if (!all) {
        const sameProject = f.wt.main_root === cwd || f.wt.main_root === sharedRoot(cwd);
        if (f.auto_land && !f.pane) {
          if (!sameProject) continue;
        } else if (f.pane !== pane || (!pane && !sameProject)) {
          continue;
        }
      }
      if (activeLand(f)) { pending = true; continue; }
      // Old receipts and new outboxes share the historical end marker (also across rollback).
      const outbox = f.workflow ?? { flow: id, notices: { 'end-0': landNoticeLine(f) } };
      const claimed = noticeEvents(home, outbox, all, path);
      if (!modCatchup || f.state === 'failed') events.push(...claimed);
    } else {
      const q = pass.header<TicketQueue>(file);
      if (!q || (!all && !runNoticeRecipient(queueScope(q), pane, cwd))) continue;
      if (q.state === 'working') {
        pending = true;
        if (q.notices) events.push(...noticeEvents(home, { flow: id, notices: q.notices }, all, path));
        continue;
      }
      if (q.task && directRecipient(q)) continue; // Live task clients collect their paused/terminal queue result via tasks/get.
      const outbox = q.template && q.notices !== undefined
        ? { flow: id, notices: q.notices }
        : q.notices && Object.keys(q.notices).length ? { flow: id, notices: q.notices }
        : { flow: id, notices: { 'end-0': ticketQueueNotice(q).replace(/\r?\n/g, ' | ') } };
      events.push(...noticeEvents(home, outbox, all, path));
    }
  }
  return { lines: events.map(e => e.line), events, pending };
}
