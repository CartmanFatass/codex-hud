import { getJobIndexCache, type JobDirMeta, type JobIndexCache } from '../roles/job-index-cache.js';
import type { ThinJobInventory } from './thin-jobs.js';

export const RECONCILE_MS = 30_000;

/** Shared discovery for all views in the collector thread. Watch deltas patch just
 * the affected jobs; occasional reconciliation also covers lost watch events. */
export class JobSnapshotIndex {
  private cache: JobIndexCache;
  private dirs = new Map<string, JobDirMeta>();
  private complete = false;
  private inventory?: ThinJobInventory;
  private dirtyDirs = new Set<string>();
  private checkedDirs = -Infinity;
  private sessions = new Map<string, string>();
  private dirtySessions = new Set<string>();
  private checkedSessions = -Infinity;

  constructor(home: string) { this.cache = getJobIndexCache(home); }

  invalidate(ids: readonly string[] | null) {
    if (!ids) {
      this.checkedDirs = this.checkedSessions = -Infinity;
      this.dirtyDirs.clear();
      this.dirtySessions.clear();
      return;
    }
    for (const id of ids) {
      if (this.checkedDirs !== -Infinity) this.dirtyDirs.add(id);
      if (this.checkedSessions !== -Infinity) this.dirtySessions.add(id);
    }
    // An index with no active reader needn't retain a backlog of old job IDs.
    if (this.dirtyDirs.size > 64) { this.checkedDirs = -Infinity; this.dirtyDirs.clear(); }
    if (this.dirtySessions.size > 64) { this.checkedSessions = -Infinity; this.dirtySessions.clear(); }
  }

  directoryInventory(): ThinJobInventory {
    const now = performance.now();
    if (now - this.checkedDirs >= RECONCILE_MS) {
      this.complete = true;
      const incomplete = () => { this.complete = false; };
      const { dirs, totalValid } = this.cache.listJobDirsByMtime({ onDirError: incomplete, onStatError: incomplete });
      this.dirs = new Map(dirs.map((dir) => [dir.id, dir]));
      this.checkedDirs = now;
      this.inventory = { dirs, totalValid, complete: this.complete };
    } else if (this.dirtyDirs.size) {
      for (const id of this.dirtyDirs) {
        try {
          const dir = this.cache.readJobDirMeta(id);
          if (dir) this.dirs.set(id, dir);
          else this.dirs.delete(id);
        } catch { this.dirs.delete(id); this.complete = false; }
      }
      this.inventory = {
        dirs: [...this.dirs.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id)),
        totalValid: this.dirs.size,
        complete: this.complete,
      };
    }
    this.dirtyDirs.clear();
    return this.inventory!;
  }

  codexWorkerSessions(): string[] {
    const now = performance.now();
    const refresh = (id: string) => {
      // Closed jobs count too: their rollouts must not become the bar's main session.
      const res = this.cache.readStatus<{ agent?: unknown; agent_session_id?: unknown }>(id);
      const session = res.status === 'ok' && res.value.agent === 'codex' ? res.value.agent_session_id : undefined;
      if (typeof session === 'string' && session) this.sessions.set(id, session);
      else this.sessions.delete(id);
    };
    if (now - this.checkedSessions >= RECONCILE_MS) {
      this.sessions.clear();
      for (const id of this.cache.listJobIds()) refresh(id);
      this.checkedSessions = now;
    } else for (const id of this.dirtySessions) refresh(id);
    this.dirtySessions.clear();
    return [...new Set(this.sessions.values())];
  }
}
