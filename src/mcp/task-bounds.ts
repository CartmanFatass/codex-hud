/** Bounded retention helpers for hud-mcp process-lifetime state carried across hot reloads. */

export const MAX_CREATED_JOBS = 512;
export const MAX_FLOW_TASKS = 128;
export const MAX_MCP_TASKS = 128;

/** Record a created job ID, pruning archived/missing jobs first and capping size (LRU). */
export function rememberCreatedJob(
  createdJobs: Set<string>,
  id: string,
  exists: (id: string) => boolean,
  limit = MAX_CREATED_JOBS
): void {
  createdJobs.delete(id);
  createdJobs.add(id);
  if (createdJobs.size > limit) pruneCreatedJobs(createdJobs, exists, limit, id);
}

/** Drop vanished/archived jobs from `createdJobs` and cap remaining IDs to `limit`. */
export function pruneCreatedJobs(
  createdJobs: Set<string>,
  exists: (id: string) => boolean,
  limit = MAX_CREATED_JOBS,
  keep?: string
): void {
  for (const id of [...createdJobs]) {
    if (id !== keep && !exists(id)) createdJobs.delete(id);
  }
  while (createdJobs.size > limit) {
    const oldest = createdJobs.values().next().value;
    if (oldest === undefined) break;
    createdJobs.delete(oldest);
  }
}

export interface BoundedFlowTask {
  id: string;
  expiresAt: number;
  epoch?: number;
}

/** Record a flow task receipt (LRU), evicting expired then settled/missing flows before active ones when over `limit`. */
export function rememberFlowTask<T extends BoundedFlowTask>(
  flowTasks: Map<string, T>,
  task: T,
  isActive: (flowId: string) => boolean,
  now = Date.now(),
  limit = MAX_FLOW_TASKS
): void {
  flowTasks.delete(task.id);
  flowTasks.set(task.id, task);
  if (flowTasks.size > limit) pruneFlowTasks(flowTasks, isActive, now, limit, task.id);
}

/** Evict expired entries and trim `flowTasks` to `limit`, preferring to drop settled or missing flows first. */
export function pruneFlowTasks<T extends BoundedFlowTask>(
  flowTasks: Map<string, T>,
  isActive: (flowId: string) => boolean,
  now = Date.now(),
  limit = MAX_FLOW_TASKS,
  keep?: string
): void {
  for (const [id, task] of [...flowTasks]) {
    if (id !== keep && task.expiresAt <= now) flowTasks.delete(id);
  }
  if (flowTasks.size <= limit) return;
  for (const id of [...flowTasks.keys()]) {
    if (flowTasks.size <= limit) break;
    if (id !== keep && !isActive(id)) flowTasks.delete(id);
  }
  while (flowTasks.size > limit) {
    const oldest = flowTasks.keys().next().value;
    if (oldest === undefined) break;
    flowTasks.delete(oldest);
  }
}

export interface BoundedTask {
  id: string;
  expiresAt?: number;
  view: { status: string };
}

/**
 * Bound `tasks` to `limit` (plus TTL): evict expired entries first, then oldest settled
 * tasks, and finally oldest entries if still over `limit`.
 */
export function pruneTasks<T extends BoundedTask>(
  tasks: Map<string, T>,
  now: number,
  onEvict: (task: T) => void,
  limit = MAX_MCP_TASKS
): void {
  for (const [id, task] of [...tasks]) {
    if (task.expiresAt !== undefined && task.expiresAt <= now) {
      tasks.delete(id);
      onEvict(task);
    }
  }
  if (tasks.size <= limit) return;
  for (const [id, task] of [...tasks]) {
    if (tasks.size <= limit) break;
    if (task.view.status !== 'working') {
      tasks.delete(id);
      onEvict(task);
    }
  }
  while (tasks.size > limit) {
    const oldest = tasks.entries().next().value;
    if (!oldest) break;
    tasks.delete(oldest[0]);
    onEvict(oldest[1]);
  }
}
