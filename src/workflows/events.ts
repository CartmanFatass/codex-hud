import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { batchActive, isBatchId, type Batch } from '../mcp/batch-state.js';
import { isAutoLandFlakeJob } from '../mcp/flake-admission.js';
import { flakeBlockIndex, pruneFlakeBlockJobs, readFlakeBlockJobs } from '../mcp/flake-block-index.js';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { activeLand, isFlowId, landFile, landNoticeLine, readLand, type LandFlow } from '../mcp/land-state.js';
import { isTicketQueueId, liveQueueTask, ticketQueueNotice, type TicketQueue } from '../mcp/ticket-queue-state.js';
import { claimPermissionNotice, permissionNoticeable, permissionNoticeMarker, permissionStatus, type PermissionEntry } from '../mcp/worker-permissions.js';
import { dirStampOf, getJobIndexCache, JOB_ID_RE } from '../roles/job-index-cache.js';
import { noticeReader, type NoticeOrigin } from '../roles/select-send.js';
import { readJsonBounded } from '../utils/atomic-fs.js';
import { claimDelivery, isDeliveryActive, isDeliveryClaimable, readDeliveryRecord, type DeliveryNotice } from '../utils/delivery-record.js';
import { fileSignature } from '../utils/file-signature.js';
import { reportReadHint } from '../utils/report-summary.js';
import { composedActive, isComposedId, type ComposedRun } from './composed-state.js';
import { headerScanner, workflowHeaders, type HeaderPass } from './header-scan.js';
import { jobNoticeOrigin, runVisible } from './scope.js';
import { currentNoticeKey, noticeEvents, noticeMarker, type Outbox } from './store.js';

export { noticeReader };
type Pull = ReturnType<typeof noticeReader>;
const permissionJob = (job: Job | null, id: string): job is Job =>
  job?.job === id && !job.scout_only && !job.council && !job.headless && !job.bro && !job.jev && !job.reaped_at;

export async function permissionEvents(home: string, pull: Pull, all = false,
  sampled?: { jobs: readonly (Job | string)[]; rows?: readonly { job: string; permission?: PermissionEntry }[] }) {
  const cache = getJobIndexCache(home), events: DeliveryNotice[] = [];
  // MCP already scanned the receipt inventory and sampled its own job rows in this call.
  const observed = new Map(sampled?.rows?.map(row => [row.job, row])), retry: string[] = [];
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
    if (!all && !await pull(jobNoticeOrigin(home, job))) continue;
    retry.push(id); // Retry relevant refusals and in-flight claims without a ledger write.
    if (reclaimable) {
      const event = claimPermissionNotice(dir, entry, all);
      if (event) events.push(event);
    }
  }
  return { events, pending: !!retry.length, retry };
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

async function flakeBlockEvents(home: string, pull: Pull, ids: string[]) {
  const prunable = (block: ReturnType<typeof flakeBlock>) => block === null || (!!block && readDeliveryRecord(block.marker).state === 'accepted');
  const prune = new Set<string>(), events: DeliveryNotice[] = [];
  for (const id of ids) {
    const block = flakeBlock(home, id);
    if (prunable(block)) prune.add(id);
    else if (block && isDeliveryClaimable(block.marker) && await pull(jobNoticeOrigin(home, block.job)) && claimDelivery(block.marker, block.epoch)) {
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
  const scan = headerScanner(), dir = join(home, 'flows');
  let listing: { stamp: string; pass: HeaderPass; outstanding: Map<string, string[]> } | undefined;
  let indexStamp: string | null = null, blocks: string[] = [];
  return async (pull = noticeReader(home, pane, cwd), mode: 'task' | 'task-read' | 'batch' = 'task') => {
    const st = fs.lstatSync(dir, { bigint: true, throwIfNoEntry: false }), stamp = st ? dirStampOf(st) : 'missing';
    const current = listing?.stamp === stamp ? listing : (listing = { stamp, pass: scan(home), outstanding: new Map() });
    const retry = new Set<string>(), files = current.outstanding.get(mode) ?? current.pass.files;
    const { events } = await workflowEvents(home, pane, false, cwd, false, pull, mode, { ...current.pass, files }, retry);
    current.outstanding.set(mode, [...retry]);
    if (mode !== 'batch') try {
      const sig = fileSignature(flakeBlockIndex(home));
      if (sig !== indexStamp) { blocks = sig ? readFlakeBlockJobs(home) : []; indexStamp = sig; }
      events.push(...await flakeBlockEvents(home, pull, blocks));
    } catch { /* Recheck an unavailable handback index on the next drain. */ }
    return events;
  };
}

/** One flow scan for watch and MCP, with their existing task/observer visibility rules. */
export async function workflowEvents(home: string, pane: string | null, all = false, cwd = process.cwd(), modStartedAt: number | false = false,
  pull = noticeReader(home, pane, cwd), mode: 'watch' | 'task' | 'task-read' | 'batch' = 'watch', pass = workflowHeaders(home), retry?: Set<string>) {
  const events: DeliveryNotice[] = [];
  let pending = false;
  const collect = async (origin: NoticeOrigin, run: Outbox, active: boolean, path?: string, project?: (raw: unknown) => Outbox | null) => {
    const keys = Object.keys(run.notices ?? {}).filter(key => currentNoticeKey(run, key));
    const marker = (key: string) => noticeMarker(home, run.flow, key, all, path);
    const outstanding = keys.some(key => isDeliveryActive(marker(key), undefined, run.epoch ?? key));
    if (retry && outstanding && runVisible(origin, pane, cwd)) retry.add(`${run.flow}.json`);
    if ((all || origin.pane === pane) && (active || outstanding)) pending = true;
    if (outstanding && (all || await pull(origin))) { pending = true; events.push(...noticeEvents(home, run, all, path, project)); }
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
      if (!end.reclaimable && end.state !== 'claimed' && end.state !== 'sending') continue;
      const f = readLand(home, id, pass);
      if (!f?.wt || f.task || f.ticket_queue) continue;
      const origin = { ...f.workflow, pane: f.pane, project_root: f.wt.main_root }, live = activeLand(f);
      if (mode.startsWith('task') && (!f.auto_land || f.state !== 'failed')) {
        if (f.auto_land && live && runVisible(origin, pane, cwd)) retry?.add(file); // Helper death can precede the terminal header.
        continue;
      }
      const outbox = landOutbox(f);
      if (outbox && (modStartedAt === false || f.state === 'failed' || Date.parse(f.updated_at) > modStartedAt))
        await collect(origin, outbox, false, path, landOutbox);
      else if (live && (all || f.pane === pane)) pending = true;
    } else if (isTicketQueueId(id)) {
      const q = pass.header<TicketQueue>(file);
      if (!q) continue;
      if (q.state !== 'working' && liveQueueTask(home, q)) {
        if (retry && runVisible({ ...q, project_root: q.project_root ?? q.root }, pane, cwd)) retry.add(file);
        continue;
      }
      const outbox = queueOutbox(q);
      if (outbox) await collect({ ...q, project_root: q.project_root ?? q.root }, outbox, q.state === 'working', landFile(home, id), queueOutbox);
    }
  }
  return { lines: events.map(e => e.line), events, pending };
}
