import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { batchActive, isBatchId, type Batch } from '../mcp/batch-state.js';
import { isAutoLandFlakeJob } from '../mcp/flake-admission.js';
import { pruneFlakeBlockJobs, readFlakeBlockJobs } from '../mcp/flake-block-index.js';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { activeLand, isFlowId, landFile, landNoticeLine, readLand, type LandFlow } from '../mcp/land-state.js';
import { isTicketQueueId, liveQueueTask, ticketQueueNotice, type TicketQueue } from '../mcp/ticket-queue-state.js';
import { claimPermissionNotice, permissionNoticeable, permissionNoticeMarker, permissionStatus, type PermissionEntry } from '../mcp/worker-permissions.js';
import { getJobIndexCache, JOB_ID_RE } from '../roles/job-index-cache.js';
import { noticeResolver, type NoticeOrigin } from '../roles/select-send.js';
import { readJsonBounded } from '../utils/atomic-fs.js';
import { claimDelivery, isDeliveryActive, isDeliveryClaimable, readDeliveryRecord, type DeliveryNotice } from '../utils/delivery-record.js';
import { reportReadHint } from '../utils/report-summary.js';
import { composedActive, isComposedId, type ComposedRun } from './composed-state.js';
import { workflowHeaders } from './header-scan.js';
import { jobNoticeOrigin } from './scope.js';
import { currentNoticeKey, noticeEvents, noticeMarker, type Outbox } from './store.js';

export function noticeReader(home: string, pane: string | null, cwd: string, env = process.env, load?: Parameters<typeof noticeResolver>[2]) {
  const resolve = noticeResolver(home, env, load);
  return (origin: NoticeOrigin) => resolve(origin, { pane, cwd });
}
type Pull = ReturnType<typeof noticeReader>;
const permissionJob = (job: Job | null, id: string): job is Job =>
  job?.job === id && !job.scout_only && !job.council && !job.headless && !job.bro && !job.jev && !job.reaped_at;

export async function permissionEvents(home: string, pull: Pull, all = false,
  sampled?: { jobs: readonly Job[]; rows: readonly { job: string; permission?: PermissionEntry }[] }) {
  const cache = getJobIndexCache(home), events: DeliveryNotice[] = [];
  // MCP already scanned the receipt inventory and sampled its own job rows in this call.
  const observed = new Map(sampled?.rows.map(row => [row.job, row]));
  let pending = false, retry = false;
  // The cached ID index and permission ledgers suffice to rule out quiet jobs; do not load their receipts.
  for (const candidate of sampled?.jobs ?? cache.listJobIds()) {
    const id = typeof candidate === 'string' ? candidate : candidate.job;
    if (!JOB_ID_RE.test(id) || (typeof candidate !== 'string' && !permissionJob(candidate, id))) continue;
    const dir = join(home, 'jobs', id), row = observed.get(id);
    const entry = row ? row.permission : permissionStatus(dir, cache).active;
    if (!permissionNoticeable(entry)) continue;
    const { state, reclaimable } = readDeliveryRecord(permissionNoticeMarker(dir, entry.id, all));
    if (!reclaimable && state !== 'claimed' && state !== 'sending') continue;
    const loaded = typeof candidate === 'string' ? cache.readJob<Job>(id) : undefined;
    const job = typeof candidate !== 'string' ? candidate : loaded?.status === 'ok' ? loaded.value : null;
    if (!permissionJob(job, id)) continue;
    const status = cache.readStatus<JobStatus>(id);
    if (status.status !== 'ok' || !['working', 'waiting_orchestrator', 'blocked'].includes(status.value.state)) continue;
    retry = true; // Refusals, lease expiry and pane changes need no new permission ledger write.
    if (!reclaimable) { pending = true; continue; } // An in-flight notice is not a reason to list panes.
    const recipient = all ? 'pane' : (await pull(jobNoticeOrigin(home, job))).kind;
    pending ||= recipient !== 'none';
    if (recipient === 'pane') {
      const event = claimPermissionNotice(dir, entry, all);
      if (event) events.push(event);
    }
  }
  return { events, pending, retry };
}

function flakeBlock(home: string, id: string) {
  if (fs.existsSync(landFile(home, `f${id.slice(1)}`))) return null;
  const loaded = getJobIndexCache(home).readJob<Job>(id);
  let job: Job;
  if (loaded.status === 'ok') job = loaded.value;
  else if (loaded.status === 'missing') return null;
  else if (loaded.status !== 'truncated') return;
  else try { job = readJsonBounded(join(home, 'jobs', id, 'job.json'), 4 * 1024 * 1024) as Job; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined; }
  const block = job?.auto_land_blocked;
  if (job?.job !== id || !isAutoLandFlakeJob(job) || !job.worktree?.main_root || typeof block?.reason !== 'string') return null;
  const epoch = createHash('sha256').update(JSON.stringify([block.at, block.sig, block.reason])).digest('hex').slice(0, 16);
  const marker = join(home, 'jobs', id, `auto-land-blocked-${epoch}.noticed`);
  const reason = block.reason.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
  return { job, marker, epoch, line: `${id}: auto-land blocked: ${reason} | ${reportReadHint(id)}` };
}

async function flakeBlockEvents(home: string, pull: Pull) {
  let ids: string[];
  try { ids = readFlakeBlockJobs(home); } catch { return []; }
  const prunable = (block: ReturnType<typeof flakeBlock>) => block === null || (!!block && readDeliveryRecord(block.marker).state === 'accepted');
  const prune = new Set<string>(), events: DeliveryNotice[] = [];
  for (const id of ids) {
    const block = flakeBlock(home, id);
    if (prunable(block)) prune.add(id);
    else if (block && isDeliveryClaimable(block.marker) && (await pull(jobNoticeOrigin(home, block.job))).kind === 'pane' && claimDelivery(block.marker, block.epoch)) {
      events.push({ ...block, current: () => {
        const latest = flakeBlock(home, id);
        if (latest === undefined) throw Error('flake handback unavailable');
        return latest?.epoch === block.epoch;
      } });
    }
  }
  if (prune.size) try { pruneFlakeBlockJobs(home, id => prune.has(id) && prunable(flakeBlock(home, id))); }
  catch { /* Best effort. */ }
  return events;
}

const landOutbox = (raw: unknown): Outbox | null => {
  const f = raw as LandFlow;
  return !f?.wt || f.task || f.ticket_queue || activeLand(f) || (f.auto_land && f.state === 'completed') ? null
    : f.workflow ?? { flow: f.flow, notices: { 'end-0': landNoticeLine(f) } };
};
const queueOutbox = (raw: unknown): Outbox | null => {
  const q = raw as TicketQueue;
  if (!q || q.state === 'superseded') return null;
  return { flow: q.flow, state: q.state, epoch: q.epoch, notices: q.notices && (q.template || Object.keys(q.notices).length) ? q.notices
    : q.state === 'working' ? undefined : { [`end-${q.epoch ?? 0}`]: ticketQueueNotice(q).replace(/\r?\n/g, ' | ') } };
};

export function taskNoticeSource(home: string, pane: string | null, cwd: string) {
  return async (pull = noticeReader(home, pane, cwd), mode: 'task' | 'task-read' | 'batch' = 'task') =>
    (await workflowEvents(home, pane, false, cwd, false, pull, mode)).events;
}

/** One flow scan for watch and MCP, with their existing task/observer visibility rules. */
export async function workflowEvents(home: string, pane: string | null, all = false, cwd = process.cwd(), modStartedAt: number | false = false,
  pull = noticeReader(home, pane, cwd), mode: 'watch' | 'task' | 'task-read' | 'batch' = 'watch') {
  const events: DeliveryNotice[] = [];
  let pending = false;
  const pass = workflowHeaders(home);
  const collect = async (origin: NoticeOrigin, run: Outbox, active: boolean, path?: string, project?: (raw: unknown) => Outbox | null) => {
    const keys = Object.keys(run.notices ?? {}).filter(key => currentNoticeKey(run, key));
    const marker = (key: string) => noticeMarker(home, run.flow, key, all, path);
    if (!keys.some(key => isDeliveryClaimable(marker(key), undefined, run.epoch ?? key))) {
      if (!pending && (all || origin.pane === pane))
        pending = active || keys.some(key => isDeliveryActive(marker(key), undefined, run.epoch ?? key));
      return;
    }
    const recipient = all ? 'pane' : (await pull(origin)).kind;
    pending ||= recipient !== 'none';
    if (recipient === 'pane') events.push(...noticeEvents(home, run, all, path, project));
  };
  for (const file of pass.files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    if (isBatchId(id)) {
      if (mode === 'task') continue;
      const b = pass.header<Batch>(file);
      if (b) await collect(b, b, batchActive(b));
    } else if (mode === 'batch') continue;
    else if (isComposedId(id)) {
      const run = pass.header<ComposedRun>(file);
      if (run?.template === 'composed') await collect(run, run, composedActive(run));
    } else if (isFlowId(id)) {
      const path = landFile(home, id);
      const end = readDeliveryRecord(`${path}.${all ? 'observed' : 'noticed'}`);
      if (!end.reclaimable) { pending ||= end.state === 'claimed' || end.state === 'sending'; continue; }
      const f = readLand(home, id, pass);
      if (!f?.wt || f.task || f.ticket_queue || (mode.startsWith('task') && (!f.auto_land || f.state !== 'failed'))) continue;
      const live = activeLand(f), outbox = landOutbox(f);
      if (outbox && (modStartedAt === false || f.state === 'failed' || Date.parse(f.updated_at) > modStartedAt))
        await collect({ ...f.workflow, pane: f.pane, project_root: f.wt.main_root }, outbox, false, path, landOutbox);
      else if (live && (all || f.pane === pane)) pending = true;
    } else if (isTicketQueueId(id)) {
      const q = pass.header<TicketQueue>(file);
      if (!q || (q.state !== 'working' && liveQueueTask(home, q))) continue;
      const outbox = queueOutbox(q);
      if (outbox) await collect({ ...q, project_root: q.project_root ?? q.root }, outbox, q.state === 'working', landFile(home, id), queueOutbox);
    }
  }
  if (mode.startsWith('task')) events.push(...await flakeBlockEvents(home, pull));
  return { lines: events.map(e => e.line), events, pending };
}
