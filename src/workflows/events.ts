import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { batchActive, batchEvents, isBatchId, type Batch } from '../mcp/batch-state.js';
import { isAutoLandFlakeJob } from '../mcp/flake-admission.js';
import { pruneFlakeBlockJobs, readFlakeBlockJobs } from '../mcp/flake-block-index.js';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { activeLand, isFlowId, landAttempt, landFile, landNoticeLine, readLand } from '../mcp/land-state.js';
import { isTicketQueueId, liveQueueTask, ticketQueueNotice, type TicketQueue } from '../mcp/ticket-queue-state.js';
import { claimPermissionNotice, permissionNotice, permissionNoticeable, permissionNoticeMarker, permissionStatus } from '../mcp/worker-permissions.js';
import { getJobIndexCache, type JobIndexCache } from '../roles/job-index-cache.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { sharedRoot } from '../roles/projects.js';
import { isPullRecipientEligible, type LivePaneSnapshot } from '../roles/select-send.js';
import { jobProjectRoot } from '../roles/selection-excerpts.js';
import { readJsonBounded } from '../utils/atomic-fs.js';
import { claimDelivery, isDeliveryActive, isDeliveryClaimable, readDeliveryRecord } from '../utils/delivery-record.js';
import { reportReadHint } from '../utils/report-summary.js';
import { composedActive, isComposedId, type ComposedRun } from './composed-state.js';
import { workflowHeaders } from './header-scan.js';
import { runVisible } from './scope.js';
import { isNoticeKey, noticeEvents, runDir } from './store.js';

const MAX_FLAKE_JOB_BYTES = 4 * 1024 * 1024;

const queueScope = (q: TicketQueue) => q.project_root ? q : { ...q, project_root: q.root };

function hasInFlightNotice(home: string, run: { flow: string; notices?: Record<string, string> }, all = false, legacyEnd?: string): boolean {
  const suffix = all ? 'observed' : 'noticed';
  for (const key of Object.keys(run.notices ?? {})) {
    if (!isNoticeKey(key)) continue;
    const marker = legacyEnd && key.startsWith('end-') ? `${legacyEnd}.${suffix}` : join(runDir(home, run.flow), `${key}.${suffix}`);
    if (isDeliveryActive(marker)) return true;
  }
  return false;
}

function queuePermissionJobIds(home: string, q: TicketQueue): string[] {
  const ids = new Set<string>();
  for (const item of q.tickets) {
    if (item.landed || item.failed) continue;
    if (item.job) ids.add(item.job);
    if (item.repair_job) ids.add(item.repair_job);
    if (item.job) {
      const land = item.land ? readLand(home, item.land) : landAttempt(home, item.job).prior;
      const repair = land?.job === item.job && activeLand(land) ? land.repairs?.at(-1)?.job : undefined;
      if (repair) ids.add(repair);
    }
  }
  if (q.review_job) ids.add(q.review_job);
  if (q.active_lead?.job) ids.add(q.active_lead.job);
  return [...ids];
}

function queuePermissionEvents(
  home: string,
  q: TicketQueue,
  pane: string | null,
  cwd: string,
  all = false,
  live?: LivePaneSnapshot,
): { events: { line: string; marker: string }[]; pending: boolean } {
  const cache = getJobIndexCache(home);
  const events: { line: string; marker: string }[] = [];
  let pending = false;
  for (const id of queuePermissionJobIds(home, q)) {
    const jobRes = cache.readJob<Job>(id);
    if (jobRes.status !== 'ok' || jobRes.value.job !== id) continue;
    const job = jobRes.value;
    const statusRes = cache.readStatus<JobStatus>(id);
    if (statusRes.status !== 'ok' || !['working', 'waiting_orchestrator', 'blocked'].includes(statusRes.value.state)) continue;
    const dir = join(home, 'jobs', id);
    const entry = permissionStatus(dir, cache).active;
    if (!permissionNoticeable(entry)) continue;
    if (!all && !isPullRecipientEligible({
      home,
      callerPane: pane,
      cwd,
      originPane: jobCallerPane(job),
      originMcp: q.origin_mcp,
      projectRoot: jobProjectRoot(job) ?? q.project_root ?? q.root,
      panes: live?.panes,
      workerPanes: live?.workerPanes,
    })) continue;
    const marker = claimPermissionNotice(dir, entry, all);
    if (marker) {
      events.push({ line: permissionNotice(id, entry).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '), marker });
      pending = true;
    } else if (isDeliveryActive(permissionNoticeMarker(dir, entry.id, all))) {
      pending = true;
    }
  }
  return { events, pending };
}

function readFlakeBlockJob(
  home: string,
  cache: JobIndexCache,
  id: string,
): { status: 'ok'; job: Job } | { status: 'missing' } | { status: 'skip' } {
  const receipt = cache.readJob<Job>(id);
  if (receipt.status === 'ok') return { status: 'ok', job: receipt.value };
  if (receipt.status === 'missing') return { status: 'missing' };
  if (receipt.status !== 'truncated') return { status: 'skip' };
  try {
    const raw = readJsonBounded(join(home, 'jobs', id, 'job.json'), MAX_FLAKE_JOB_BYTES);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? { status: 'ok', job: raw as Job } : { status: 'skip' };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'skip' };
  }
}

type FlakeBlockDecision =
  | { kind: 'prune' }
  | { kind: 'skip' }
  | { kind: 'deliver'; marker: string; epoch: string; reason: string };

function inspectFlakeBlock(
  home: string,
  cache: JobIndexCache,
  id: string,
  pane: string | null,
  cwd: string,
  live?: LivePaneSnapshot,
): FlakeBlockDecision {
  if (fs.existsSync(landFile(home, `f${id.slice(1)}`))) return { kind: 'prune' };
  const loaded = readFlakeBlockJob(home, cache, id);
  if (loaded.status === 'missing') return { kind: 'prune' };
  if (loaded.status !== 'ok') return { kind: 'skip' };
  const job = loaded.job, block = job.auto_land_blocked, main = job.worktree?.main_root;
  if (job.job !== id || !isAutoLandFlakeJob(job) || !main || typeof block?.reason !== 'string') return { kind: 'prune' };
  const key = createHash('sha256').update(JSON.stringify([block.at, block.sig, block.reason])).digest('hex').slice(0, 16);
  const marker = join(home, 'jobs', id, `auto-land-blocked-${key}.noticed`);
  const delivery = readDeliveryRecord(marker);
  if (delivery.state === 'accepted') return { kind: 'prune' };
  if (!delivery.reclaimable) return { kind: 'skip' };
  const eligible = isPullRecipientEligible({
    home,
    callerPane: pane,
    cwd,
    originPane: jobCallerPane(job),
    projectRoot: main,
    panes: live?.panes,
    workerPanes: live?.workerPanes,
  });
  if (!eligible) return { kind: 'skip' };
  const reason = block.reason.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
  return { kind: 'deliver', marker, epoch: key, reason };
}

function flakeBlockEvents(home: string, pane: string | null, cwd: string, live?: LivePaneSnapshot) {
  let ids: string[];
  try { ids = readFlakeBlockJobs(home); }
  catch { return []; } // An unreadable index must not stop other notices.
  if (!ids.length) return [];
  const cache = getJobIndexCache(home);
  const prunable = new Set<string>();
  // These handbacks can precede any flow. Read indexed receipts without
  // enumerating jobs or opening QA or report bodies.
  const events = ids.flatMap(id => {
    const decision = inspectFlakeBlock(home, cache, id, pane, cwd, live);
    if (decision.kind === 'prune') { prunable.add(id); return []; }
    if (decision.kind !== 'deliver') return [];
    if (!claimDelivery(decision.marker, decision.epoch)) {
      if (!fs.existsSync(join(home, 'jobs', id))) prunable.add(id);
      return [];
    }
    return [{ line: `${id}: auto-land blocked: ${decision.reason} | ${reportReadHint(id)}`, marker: decision.marker }];
  });
  if (prunable.size) {
    try {
      pruneFlakeBlockJobs(home, id => prunable.has(id) && inspectFlakeBlock(home, cache, id, pane, cwd, live).kind === 'prune');
    } catch { /* Best-effort index cleanup must not fail notice delivery. */ }
  }
  return events;
}

export function taskNoticeSource(home: string, pane: string | null, cwd: string) {
  const dir = join(home, 'flows');
  let previous: string | undefined, composed: ComposedRun[] = [], queues: { id: string; q: TicketQueue }[] = [];
  const eligibleRun = (run: { pane: string; origin_mcp?: { pid: number; start: string }; project_root?: string }, live?: LivePaneSnapshot) =>
    isPullRecipientEligible({
      home,
      callerPane: pane,
      cwd,
      originPane: run.pane,
      originMcp: run.origin_mcp,
      projectRoot: run.project_root,
      panes: live?.panes,
      workerPanes: live?.workerPanes,
    });
  const queueEvents = (id: string, q: TicketQueue, live?: LivePaneSnapshot) => {
    const perms = q.state === 'working' ? queuePermissionEvents(home, q, pane, cwd, false, live).events : [];
    if (!q.notices || !eligibleRun(queueScope(q), live)) return perms;
    if (q.state !== 'working' && liveQueueTask(home, q)) return perms;
    return [...perms, ...noticeEvents(home, { flow: id, epoch: q.epoch, notices: q.notices }, false, landFile(home, id))];
  };
  const flowEvents = (live?: LivePaneSnapshot) => {
    // Only list flows when a receipt changed. Composed/queue claims live in child
    // directories and an origin MCP can exit without changing this stamp.
    const st = fs.statSync(dir, { bigint: true, throwIfNoEntry: false });
    const stamp = st && `${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}`;
    if (stamp === previous) return [
      ...queues.flatMap(({ id, q }) => queueEvents(id, q, live)),
      ...composed.flatMap(run => eligibleRun(run, live) ? noticeEvents(home, run) : []),
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
        if (!q || !runVisible(queueScope(q), pane, cwd)) return [];
        if (q.state !== 'working' && (!q.notices || !Object.keys(q.notices).length)) return [];
        queues.push({ id, q });
        return queueEvents(id, q, live);
      }
      if (isFlowId(id)) {
        const f = readLand(home, id, pass);
        if (!f?.wt || !f.auto_land || f.task || f.ticket_queue || f.state !== 'failed') return [];
        if (!isPullRecipientEligible({ home, callerPane: pane, cwd, originPane: f.pane, projectRoot: f.wt.main_root, panes: live?.panes, workerPanes: live?.workerPanes })) return [];
        const path = landFile(home, id);
        if (!isDeliveryClaimable(`${path}.noticed`)) return [];
        const outbox = f.workflow ?? { flow: id, notices: { 'end-0': landNoticeLine(f) } };
        return noticeEvents(home, outbox, false, path);
      }
      if (!isComposedId(id)) return [];
      const run = pass.header<ComposedRun>(file);
      if (run?.template !== 'composed' || !Object.keys(run.notices).length || !runVisible(run, pane, cwd)) return [];
      composed.push(run);
      return eligibleRun(run, live) ? noticeEvents(home, run) : [];
    });
    // Keep the stamp dirty when events were claimed so a released marker retries on the next tick.
    if (!events.length) previous = stamp;
    return events;
  };
  return (live?: LivePaneSnapshot) => [...flowEvents(live), ...flakeBlockEvents(home, pane, cwd, live)];
}

/** Scan active runs and unclaimed terminal results. Quiet passes only parse a
 * changed header; previously claimed land/queue results don't even need a stat. */
export function workflowEvents(
  home: string,
  pane: string | null,
  all = false,
  cwd = process.cwd(),
  modCatchup = false,
  live?: LivePaneSnapshot,
) {
  const events: { line: string; marker: string }[] = [];
  let pending = false;
  const pass = workflowHeaders(home);
  const eligibleRun = (run: { pane: string; origin_mcp?: { pid: number; start: string }; project_root?: string }) =>
    all || isPullRecipientEligible({
      home,
      callerPane: pane,
      cwd,
      originPane: run.pane,
      originMcp: run.origin_mcp,
      projectRoot: run.project_root,
      panes: live?.panes,
      workerPanes: live?.workerPanes,
    });
  for (const file of pass.files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    if (isComposedId(id)) {
      const run = pass.header<ComposedRun>(file);
      if (run?.template === 'composed' && eligibleRun(run)) {
        events.push(...noticeEvents(home, run, all));
        pending ||= composedActive(run) || hasInFlightNotice(home, run, all);
      }
      continue;
    }
    if (isBatchId(id)) {
      const b = pass.header<Batch>(file);
      if (b && eligibleRun(b)) {
        events.push(...batchEvents(home, b, all));
        pending ||= batchActive(b) || hasInFlightNotice(home, b, all);
      }
      continue;
    }
    const land = isFlowId(id);
    if (!land && !isTicketQueueId(id)) continue;
    const path = landFile(home, id);
    const endRec = readDeliveryRecord(`${path}.${all ? 'observed' : 'noticed'}`);
    if (!endRec.reclaimable) {
      if (endRec.state === 'claimed' || endRec.state === 'sending') pending = true;
      continue;
    }
    if (land) {
      const f = readLand(home, id, pass);
      if (!f?.wt || f.task || f.ticket_queue) continue;
      if (f.auto_land && f.state === 'completed') continue;
      if (!all) {
        const sameProject = f.wt.main_root === cwd || f.wt.main_root === sharedRoot(cwd);
        if (f.auto_land && !f.pane) {
          if (!sameProject) continue;
        } else if (!isPullRecipientEligible({ home, callerPane: pane, cwd, originPane: f.pane, projectRoot: f.wt.main_root, panes: live?.panes, workerPanes: live?.workerPanes }) || (!pane && !sameProject)) {
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
      if (!q) continue;
      if (q.state === 'working') {
        if (all || runVisible(queueScope(q), pane, cwd)) {
          const perms = queuePermissionEvents(home, q, pane, cwd, all, live);
          events.push(...perms.events);
          pending ||= perms.pending;
        }
      }
      if (!eligibleRun(queueScope(q))) continue;
      if (q.state === 'working') {
        pending = true;
        if (q.notices) {
          events.push(...noticeEvents(home, { flow: id, epoch: q.epoch, notices: q.notices }, all, path));
          pending ||= hasInFlightNotice(home, { flow: id, notices: q.notices }, all, path);
        }
        continue;
      }
      if (liveQueueTask(home, q)) continue; // Live task clients collect their paused/terminal queue result via tasks/get.
      const outbox = q.template && q.notices !== undefined
        ? { flow: id, epoch: q.epoch, notices: q.notices }
        : q.notices && Object.keys(q.notices).length ? { flow: id, epoch: q.epoch, notices: q.notices }
        : { flow: id, epoch: q.epoch, notices: { 'end-0': ticketQueueNotice(q).replace(/\r?\n/g, ' | ') } };
      events.push(...noticeEvents(home, outbox, all, path));
      pending ||= hasInFlightNotice(home, outbox, all, path);
    }
  }
  return { lines: events.map(e => e.line), events, pending };
}
