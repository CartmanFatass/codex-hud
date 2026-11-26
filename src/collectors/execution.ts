/** The Project Execution page's facts, derived from one project's job records: the live jobs, who started whom, and the panes to read. */
import { join } from 'node:path';
import type { Job, PrewalkScoutKind } from '../mcp/job-contracts.js';
import { getJobIndexCache } from '../roles/job-index-cache.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { herdrId } from '../roles/herdr-run.js';
import { herdrEndpoint } from '../runtime/herdr-socket.js';
import type { ScreenTarget, ExecutionScreen } from './execution-screens.js';
import { readHeadlessOutput, type HeadlessOutput } from './headless-output.js';
import type { OwnerWorker, WorkboardSnapshot } from './workboard-types.js';

export type ExecutionPhase = 'waiting' | 'running' | 'queued' | 'settled';
export interface ExecutionJob {
  readonly jobId: string;
  readonly worker: OwnerWorker;
  readonly dir: string;
  readonly phase: ExecutionPhase;
  readonly preset?: string;
  /** A prewalk scout's kind; its parent is the job it scouted for. */
  readonly scout?: PrewalkScoutKind;
  readonly parentId?: string;
  /** The main session that dispatched it, from the receipt; unknown stays absent. */
  readonly session?: { readonly harness?: string; readonly id?: string; readonly pane?: string };
  /** A live tab worker whose recorded pane can be read for a thumbnail. */
  readonly hasScreen: boolean;
  /** A live headless job that has reported no progress: the newest lines of its output log. */
  readonly output?: HeadlessOutput;
}
export interface ExecutionNode { readonly job: ExecutionJob; readonly children: readonly ExecutionNode[] }
export interface ExecutionSession {
  readonly harness?: string;
  readonly id?: string;
  readonly pane?: string;
  /** Dispatched from the pane this panel serves. */
  readonly here: boolean;
  readonly nodes: readonly ExecutionNode[];
}
export interface ExecutionSnapshot {
  readonly root: string;
  /** Running and waiting jobs: those asking first, then running, then queued; the oldest first within each. */
  readonly jobs: readonly ExecutionJob[];
  readonly sessions: readonly ExecutionSession[];
  readonly complete: boolean;
}
export type ExecutionView = ExecutionSnapshot & { readonly screens: ReadonlyMap<string, ExecutionScreen> };

const PHASE_ORDER: Record<ExecutionPhase, number> = { waiting: 0, running: 1, queued: 2, settled: 3 };
const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
const jobIdOf = (id: string | undefined) => id?.replace(/^thin-job:/, '');
const byStart = (a: ExecutionJob, b: ExecutionJob) =>
  (a.worker.startedAt ?? 0) - (b.worker.startedAt ?? 0) || a.jobId.localeCompare(b.jobId);

/** Reads receipts (cached by signature) only for the jobs the page shows. */
export function executionSnapshot(home: string, board: WorkboardSnapshot, scope: { root: string; pane: string | null; env: NodeJS.ProcessEnv; complete: boolean }):
  { snapshot: ExecutionSnapshot; targets: ScreenTarget[] } {
  const cache = getJobIndexCache(home);
  const workers = new Map(board.workers.map((worker) => [jobIdOf(worker.id)!, worker]));
  const receipts = new Map<string, Partial<Job>>();
  const receipt = (id: string) => {
    let job = receipts.get(id);
    if (!job) {
      const read = cache.readJob<Job & Record<string, unknown>>(id);
      receipts.set(id, job = read.status === 'ok' ? read.value : {});
    }
    return job;
  };
  // A reaped job's worker is gone, whatever its last STATUS claims.
  const live = [...workers].filter(([id, w]) => w.settledAt === null && !receipt(id).reaped_at).map(([id]) => id);
  const children = new Map<string, string[]>();
  for (const [id, worker] of workers) {
    const parent = jobIdOf(worker.parentJobId);
    if (parent && parent !== id && workers.has(parent)) children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  // The tree is the live jobs, everything they started, and the chain that started them.
  const shown = new Set<string>();
  const below = [...live];
  for (let id = below.pop(); id; id = below.pop()) {
    if (shown.has(id)) continue;
    shown.add(id);
    below.push(...(children.get(id) ?? []));
  }
  for (const start of live) {
    const seen = new Set<string>();
    for (let id = jobIdOf(workers.get(start)!.parentJobId); id && workers.has(id) && !seen.has(id); id = jobIdOf(workers.get(id)!.parentJobId)) {
      seen.add(id);
      shown.add(id);
    }
  }
  const endpoint = herdrEndpoint(scope.env), targets: ScreenTarget[] = [], liveSet = new Set(live);
  const jobs = new Map([...shown].map((jobId): [string, ExecutionJob] => {
    const worker = workers.get(jobId)!, job = receipt(jobId), dir = join(home, 'jobs', jobId);
    const status = cache.readStatus<{ state?: unknown }>(jobId);
    const state = status.status === 'ok' ? status.value.state : undefined;
    const phase: ExecutionPhase = !liveSet.has(jobId) ? 'settled' : worker.state === 'queued' ? 'queued'
      : worker.homeNeedsHuman || state === 'waiting_orchestrator' || state === 'blocked' ? 'waiting' : 'running';
    let target: ScreenTarget | undefined;
    if (phase !== 'settled' && phase !== 'queued' && !worker.headless) {
      const fields = cache.readSession(jobId)?.fields;
      // Only the server that launched the tab can be asked about it, and a direct launch needs its identity to be checked.
      const direct = fields?.directExec === '1';
      if (fields && endpoint && fields.herdrSocket === endpoint && herdrId(fields.left) &&
          (direct ? fields.launchId && fields.terminalId : herdrId(fields.tab))) {
        target = { jobId, pane: fields.left, ...(direct ? { launchId: fields.launchId, terminalId: fields.terminalId } : { tab: fields.tab }) };
        targets.push(target);
      }
    }
    const dispatcher = job.dispatcher, pane = jobCallerPane(job) || undefined;
    const harness = text(dispatcher?.harness), id = text(dispatcher?.id);
    const preset = text(job.preset) ?? text(job.imp_preset) ?? text(job.route?.preset);
    const output = phase !== 'settled' && worker.headless && !worker.latest_progress ? readHeadlessOutput(dir) : undefined;
    const parentId = jobIdOf(worker.parentJobId);
    return [jobId, {
      jobId, worker, dir, phase, hasScreen: !!target,
      ...(preset ? { preset } : {}),
      ...(job.prewalk_kind ? { scout: job.prewalk_kind } : {}),
      ...(parentId ? { parentId } : {}),
      ...(harness || id || pane ? { session: { harness, id, pane } } : {}),
      ...(output ? { output } : {}),
    }];
  }));
  const ordered = live.map((id) => jobs.get(id)!).sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || byStart(a, b));
  // Thumbnails follow the card order.
  const rank = new Map(ordered.map((job, i) => [job.jobId, i]));
  targets.sort((a, b) => rank.get(a.jobId)! - rank.get(b.jobId)!);
  return { snapshot: { root: scope.root, jobs: ordered, sessions: delegationTree(jobs, children, scope.pane), complete: scope.complete }, targets };
}

/** Roots are the shown jobs with no shown parent, grouped by the main session that dispatched them. */
function delegationTree(jobs: ReadonlyMap<string, ExecutionJob>, children: ReadonlyMap<string, readonly string[]>, here: string | null): ExecutionSession[] {
  const placed = new Set<string>();
  const node = (job: ExecutionJob): ExecutionNode => {
    placed.add(job.jobId);
    return { job, children: (children.get(job.jobId) ?? []).flatMap((id) => jobs.get(id) ?? []).sort(byStart)
      .flatMap((child) => placed.has(child.jobId) ? [] : [node(child)]) };
  };
  const sessions = new Map<string, { harness?: string; id?: string; pane?: string; here: boolean; nodes: ExecutionNode[] }>();
  const ordered = [...jobs.values()].sort(byStart);
  // Real roots first; a cycle in damaged records has none, so its oldest job stands in.
  for (const job of [...ordered.filter((j) => !j.parentId || !jobs.has(j.parentId)), ...ordered]) {
    if (placed.has(job.jobId)) continue;
    const { harness, id, pane } = job.session ?? {};
    const key = id ? `${harness}:${id}` : pane ? `pane:${pane}` : '';
    let session = sessions.get(key);
    if (!session) sessions.set(key, session = { harness, id, pane, here: false, nodes: [] });
    session.here ||= !!here && pane === here;
    session.nodes.push(node(job));
  }
  return [...sessions.values()].sort((a, b) => Number(b.here) - Number(a.here));
}
