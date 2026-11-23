import type { OwnerWorker } from '../collectors/workboard-types.js';
import { ROLE_GLYPHS } from '../render/model-glyphs.js';

/** The role a worker counts under: a sonic child is `sonic`, a role with no icon of its own is `other`; a native agent (no role) is none. */
function countedRole(w: OwnerWorker): string | undefined {
  if (w.parentJobId) return 'sonic';
  const role = w.role?.trim().toLowerCase();
  return role ? (Object.hasOwn(ROLE_GLYPHS, role) ? role : 'other') : undefined;
}

/**
 * The workers each role has started since the panel opened, whatever their state (running, done and failed alike), for Home's
 * top line. In memory only: a panel restart starts from zero. A worker that started before `sinceMs` is not counted, and one
 * that has not started (queued) is counted once it has; a worker is counted once however many snapshots show it.
 */
export class WorkerCounts {
  private readonly seen = new Map<string, Set<string>>();
  constructor(private readonly sinceMs: number) {}
  observe(workers: readonly OwnerWorker[]): void {
    for (const w of workers) {
      const role = countedRole(w);
      if (!role || w.startedAt === null || w.startedAt < this.sinceMs) continue;
      const ids = this.seen.get(role) ?? new Set<string>();
      this.seen.set(role, ids.add(w.id));
    }
  }
  /** The count per role, only the roles with a worker. */
  counts(): ReadonlyMap<string, number> {
    return new Map([...this.seen].map(([role, ids]) => [role, ids.size]));
  }
}
