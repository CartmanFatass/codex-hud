/** Private, atomic, bounded work-summary snapshot published by hud-watch and hud-mcp. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { herdrId } from '../roles/herdr-run.js';
import { getJobIndexCache, type JobIndexCache } from '../roles/job-index-cache.js';
import { readJsonBounded, writePrivateFile } from '../utils/atomic-fs.js';
import { isProcAlive, isValidPid, procStat } from '../utils/proc.js';
import { jobRow } from './thin-jobs.js';

export const WORK_SUMMARY_FILE = 'display/work-summary.v1.json';
export const WORK_SUMMARY_VERSION = 1;
export const WORK_SUMMARY_MAX_BYTES = 65_536;
export const WORK_SUMMARY_MAX_PANES = 128;
export const WORK_SUMMARY_MAX_ROLES = 32;
export const WORK_SUMMARY_MCP_TTL_MS = 5_000;
export const WORK_SUMMARY_DEGRADED_TTL_MS = 5_000;
export const WORK_SUMMARY_CLOCK_SKEW_MS = 5_000;

export type WorkSummaryProducer = 'hud-watch' | 'hud-mcp';
/** Live workers of one role: `running` is total live (working + asking); `asking` is the subset waiting on the owner. */
export interface WorkSummaryRoleCounts { running: number; asking: number; }
export interface WorkSummaryScope { running: number; asking: number; roles: Record<string, WorkSummaryRoleCounts>; }
export interface WorkSummarySnapshot {
  version: 1;
  producer: WorkSummaryProducer;
  pid: number;
  pid_start: string | null;
  generation: number;
  observed_at: number;
  watching: boolean;
  complete: boolean;
  global: WorkSummaryScope;
  panes: Record<string, WorkSummaryScope>;
}

export const workSummaryPath = (home: string): string => join(home, WORK_SUMMARY_FILE);
export const emptyWorkSummaryScope = (): WorkSummaryScope => ({ running: 0, asking: 0, roles: {} });

function addRole(scope: WorkSummaryScope, role: string, asking: boolean): void {
  scope.running += 1;
  if (asking) scope.asking += 1;
  const key = Object.hasOwn(scope.roles, role) || Object.keys(scope.roles).length < WORK_SUMMARY_MAX_ROLES ? role : 'other';
  const entry = scope.roles[key] ?? (scope.roles[key] = { running: 0, asking: 0 });
  entry.running += 1;
  if (asking) entry.asking += 1;
}

const sortScope = (scope: WorkSummaryScope): WorkSummaryScope => ({
  running: scope.running,
  asking: scope.asking,
  roles: Object.fromEntries(Object.keys(scope.roles).sort().map((k) => [k, scope.roles[k]!])),
});

export function collectWorkSummary(
  home: string,
  cache: JobIndexCache = getJobIndexCache(home),
  options?: { ids?: readonly string[]; jobs?: readonly (Job & Record<string, unknown>)[] }
) {
  let complete = true;
  const global = emptyWorkSummaryScope();
  const rawPanes: Record<string, WorkSummaryScope> = {};
  const considerJob = (id: string, job: Job & Record<string, unknown>) => {
    if (job.job !== id || typeof job.role !== 'string' || typeof job.created_at !== 'string' || !Number.isFinite(Date.parse(job.created_at))) {
      complete = false; return;
    }
    if (typeof job.reaped_at === 'string' && job.reaped_at.length > 0) return;
    const statusRes = cache.readStatus<JobStatus>(id);
    if (statusRes.status !== 'ok' && statusRes.status !== 'missing') { complete = false; return; }
    const status = statusRes.status === 'ok' ? statusRes.value : null;
    const row = jobRow(job, status);
    if (row.display_state !== 'working') return;
    let openQuestions = 0;
    try { openQuestions = cache.readQa(join(home, 'jobs', id)).openIds.length; }
    catch { complete = false; return; }
    const cliJob = (typeof status?.harness === 'string' && status.harness.trim() === 'cli') || (job.cli !== null && typeof job.cli === 'object');
    const asking = openQuestions > 0 || (cliJob && (row.blocked || row.state === 'waiting_orchestrator'));
    const role = job.role.trim().toLowerCase() || 'job';
    addRole(global, role, asking);
    const pane = typeof job.herdr_pane === 'string' && herdrId(job.herdr_pane) ? job.herdr_pane : null;
    if (pane) {
      const paneScope = rawPanes[pane] ?? (Object.keys(rawPanes).length < WORK_SUMMARY_MAX_PANES ? (rawPanes[pane] = emptyWorkSummaryScope()) : null);
      if (paneScope) addRole(paneScope, role, asking);
      else complete = false;
    }
  };
  if (options?.jobs) {
    for (const job of options.jobs) considerJob(typeof job.job === 'string' ? job.job : '', job);
  } else {
    const ids = options?.ids ?? cache.listJobIds({ onError: () => { complete = false; } });
    for (const id of ids) {
      const jobRes = cache.readJob<Job & Record<string, unknown>>(id);
      if (jobRes.status === 'missing') continue;
      if (jobRes.status !== 'ok') { complete = false; continue; }
      considerJob(id, jobRes.value);
    }
  }
  const panes = Object.fromEntries(Object.keys(rawPanes).sort().map((p) => [p, sortScope(rawPanes[p]!)]));
  return { global: sortScope(global), panes, complete };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function isValidScope(v: unknown): v is WorkSummaryScope {
  if (!isPlain(v) || !isCount(v.running) || !isCount(v.asking) || v.asking > v.running || !isPlain(v.roles)) return false;
  const entries = Object.entries(v.roles);
  if (entries.length > WORK_SUMMARY_MAX_ROLES + 1) return false;
  let running = 0, asking = 0;
  for (const [role, c] of entries) {
    if (!role || !isPlain(c) || !isCount(c.running) || !isCount(c.asking) || c.asking > c.running) return false;
    running += c.running;
    asking += c.asking;
  }
  return running === v.running && asking === v.asking;
}

export function parseWorkSummarySnapshot(raw: unknown): WorkSummarySnapshot | null {
  if (!isPlain(raw) || raw.version !== WORK_SUMMARY_VERSION) return null;
  if ((raw.producer !== 'hud-watch' && raw.producer !== 'hud-mcp') || !isValidPid(raw.pid)) return null;
  if (raw.pid_start !== null && (typeof raw.pid_start !== 'string' || !/^\d+$/.test(raw.pid_start))) return null;
  if (!isCount(raw.generation) || raw.generation < 1 || typeof raw.observed_at !== 'number' || !Number.isFinite(raw.observed_at) || raw.observed_at <= 0) return null;
  if (typeof raw.watching !== 'boolean' || typeof raw.complete !== 'boolean' || !isValidScope(raw.global) || !isPlain(raw.panes)) return null;
  const paneEntries = Object.entries(raw.panes);
  if (paneEntries.length > WORK_SUMMARY_MAX_PANES || paneEntries.some(([p, s]) => !herdrId(p) || !isValidScope(s))) return null;
  return raw as unknown as WorkSummarySnapshot;
}

function watchPidMatches(home: string, pid: number): boolean {
  try { return Number(fs.readFileSync(join(home, 'watch.pid'), 'utf8').trim()) === pid; }
  catch { return false; }
}

/** Return the fresh scope for `pane` (or global when `pane === null`); null means absent, corrupt or stale. */
export function readFreshWorkSummary(home: string, pane: string | null, now = Date.now()) {
  if (pane !== null && !herdrId(pane)) return null;
  let snapshot: WorkSummarySnapshot | null;
  try { snapshot = parseWorkSummarySnapshot(readJsonBounded(workSummaryPath(home), WORK_SUMMARY_MAX_BYTES)); }
  catch { return null; }
  if (!snapshot || !snapshot.complete || snapshot.observed_at > now + WORK_SUMMARY_CLOCK_SKEW_MS) return null;
  if (!isProcAlive(snapshot.pid, snapshot.pid_start ?? undefined)) return null;
  if (snapshot.producer === 'hud-watch') {
    if (!watchPidMatches(home, snapshot.pid)) return null;
    if (!snapshot.watching && now - snapshot.observed_at > WORK_SUMMARY_DEGRADED_TTL_MS) return null;
  } else if (now - snapshot.observed_at > WORK_SUMMARY_MCP_TTL_MS) return null;
  return { scope: pane === null ? snapshot.global : (snapshot.panes[pane] ?? emptyWorkSummaryScope()), snapshot };
}

export function createWorkSummaryPublisher(home: string, producer: WorkSummaryProducer, cache: JobIndexCache = getJobIndexCache(home)) {
  const file = workSummaryPath(home), pidStart = procStat(process.pid)?.start ?? null;
  let generation = 0, lastKey: string | null = null, lastStat: fs.Stats | null = null;
  let lastCollected: ReturnType<typeof collectWorkSummary> | null = null;
  const samePublishedFile = () => {
    if (!lastStat) return false;
    try {
      const cur = fs.lstatSync(file, { throwIfNoEntry: false });
      return !!cur && cur.dev === lastStat.dev && cur.ino === lastStat.ino && cur.mtimeMs === lastStat.mtimeMs && cur.size === lastStat.size;
    } catch { return false; }
  };
  const writeSnapshot = (
    collected: ReturnType<typeof collectWorkSummary>,
    watching: boolean,
    now: number,
    jobsExist: boolean
  ): boolean => {
    const countsKey = JSON.stringify([collected.complete, collected.global, collected.panes]);
    const stateKey = `${watching ? 1 : 0}:${countsKey}`;
    if (producer === 'hud-watch') {
      if (lastKey === stateKey && samePublishedFile()) return false;
    } else {
      const current = readFreshWorkSummary(home, null, now);
      if (current && JSON.stringify([current.snapshot.complete, current.snapshot.global, current.snapshot.panes]) === countsKey &&
          ((current.snapshot.producer === 'hud-watch' && current.snapshot.watching) || lastKey === stateKey)) return false;
    }
    const nextGen = generation + 1;
    const text = JSON.stringify({
      version: WORK_SUMMARY_VERSION, producer, pid: process.pid, pid_start: pidStart,
      generation: nextGen, observed_at: now, watching, complete: collected.complete,
      global: collected.global, panes: collected.panes,
    } satisfies WorkSummarySnapshot) + '\n';
    if (Buffer.byteLength(text, 'utf8') > WORK_SUMMARY_MAX_BYTES || (!jobsExist && !fs.existsSync(join(home, 'jobs')))) return false;
    try {
      try { fs.mkdirSync(join(home, 'display'), { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false; }
      lastStat = writePrivateFile(file, text, { mkdir: false });
      generation = nextGen; lastKey = stateKey; return true;
    } catch { return false; }
  };
  return {
    get generation() { return generation; },
    setGeneration(value: number) { if (Number.isSafeInteger(value) && value > generation) generation = value; },
    publish(options?: {
      watching?: boolean;
      now?: number;
      ids?: readonly string[];
      jobs?: readonly (Job & Record<string, unknown>)[];
      jobsExist?: boolean;
    }): boolean {
      const collected = collectWorkSummary(home, cache, options);
      lastCollected = collected;
      const watching = producer === 'hud-watch' && options?.watching === true;
      const now = options?.now ?? Date.now();
      const jobsExist = Boolean(options?.jobsExist || options?.jobs?.length || options?.ids?.length || collected.global.running > 0);
      return writeSnapshot(collected, watching, now, jobsExist);
    },
    markDegraded(now = Date.now()): boolean {
      if (producer !== 'hud-watch' || !lastCollected) return false;
      return writeSnapshot(lastCollected, false, now, true);
    },
  };
}
