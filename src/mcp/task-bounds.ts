/** Bounded retention helpers for hud-mcp process-lifetime state carried across hot reloads. */

export const MAX_CREATED_JOBS = 512;
export const MAX_LAND_TASKS = 128;
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

/** Record a land task flow ID (LRU), evicting settled/missing flows before active ones when over `limit`. */
export function rememberLandTask(
  landTasks: Set<string>,
  flowId: string,
  isActive: (flowId: string) => boolean,
  limit = MAX_LAND_TASKS
): void {
  landTasks.delete(flowId);
  landTasks.add(flowId);
  if (landTasks.size > limit) pruneLandTasks(landTasks, isActive, limit, flowId);
}

/** Trim `landTasks` to `limit`, preferring to drop settled or missing flows first. */
export function pruneLandTasks(
  landTasks: Set<string>,
  isActive: (flowId: string) => boolean,
  limit = MAX_LAND_TASKS,
  keep?: string
): void {
  if (landTasks.size <= limit) return;
  for (const id of [...landTasks]) {
    if (landTasks.size <= limit) break;
    if (id !== keep && !isActive(id)) landTasks.delete(id);
  }
  while (landTasks.size > limit) {
    const oldest = landTasks.values().next().value;
    if (oldest === undefined) break;
    landTasks.delete(oldest);
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
