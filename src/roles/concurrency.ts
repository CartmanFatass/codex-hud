/** Shared per-role concurrency cap, overflow and queue-order helpers. */
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { defaultSettings, loadSettings, type HudSettings } from '../settings.js';

export const QUEUE_START_MARKER = '.queue-start';

export type ConcurrencySettings = Pick<HudSettings, 'roleCaps' | 'impOverflow'>;

export function loadConcurrencySettings(env = process.env): ConcurrencySettings {
  try {
    const settings = loadSettings(env);
    return { roleCaps: settings.roleCaps, impOverflow: settings.impOverflow };
  } catch {
    const defaults = defaultSettings();
    return { roleCaps: defaults.roleCaps, impOverflow: defaults.impOverflow };
  }
}

/** Configured cap for `role`; 0 means uncapped. */
export function capForRole(settings: Pick<HudSettings, 'roleCaps'>, role: string): number {
  const cap = settings.roleCaps[role];
  return typeof cap === 'number' && Number.isInteger(cap) && cap > 0 ? cap : 0;
}

/** Sonic children, scout children, headless sonic and already-reaped jobs are excluded from caps. */
export function isCountedJob(job: Partial<Job> | null | undefined): boolean {
  if (!job || typeof job !== 'object') return false;
  if (job.parent_job || job.scout_only === true || job.headless === true || job.reaped_at) return false;
  return typeof job.role === 'string' && job.role.length > 0;
}

const NON_WORKING_STATES = new Set(['queued', 'idle_grace', 'done', 'closed', 'failed', 'stopped']);

/** True when a job currently occupies a concurrency slot for its role. */
export function isWorkingForCap(job: Partial<Job> | null | undefined, status: Partial<JobStatus> | null | undefined): boolean {
  if (!isCountedJob(job)) return false;
  const rawState = typeof status?.state === 'string' && status.state.trim() ? status.state.trim() : null;
  if (rawState !== null) return !NON_WORKING_STATES.has(rawState);
  // No STATUS.json yet: counts while launching unless dispatch already failed.
  return !(typeof job!.dispatch_exit_code === 'number' && job!.dispatch_exit_code !== 0);
}

export interface QueuedEntry {
  id: string;
  role: string | null;
  state: string | null;
  queuedAt: number;
}

export function queuedTimestamp(job: Partial<Job> | null | undefined): number {
  const raw = job?.queued_at ?? job?.created_at;
  const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isFinite(at) ? at : 0;
}

export function queueOrderCompare(a: Pick<QueuedEntry, 'id' | 'queuedAt'>, b: Pick<QueuedEntry, 'id' | 'queuedAt'>): number {
  return a.queuedAt - b.queuedAt || a.id.localeCompare(b.id);
}

/** 1-based FIFO position per role over all queued jobs (oldest first). */
export function computeQueuePositions(entries: Iterable<QueuedEntry>): Map<string, number> {
  const byRole = new Map<string, QueuedEntry[]>();
  for (const entry of entries) {
    if (entry.state !== 'queued' || !entry.role) continue;
    const list = byRole.get(entry.role);
    if (list) list.push(entry);
    else byRole.set(entry.role, [entry]);
  }
  const positions = new Map<string, number>();
  for (const list of byRole.values()) {
    list.sort(queueOrderCompare);
    for (let i = 0; i < list.length; i++) positions.set(list[i].id, i + 1);
  }
  return positions;
}
