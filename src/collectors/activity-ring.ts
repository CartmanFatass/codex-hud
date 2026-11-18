/**
 * Worker activity cadence: a ten-minute ring of one-minute buckets per running worker, in memory only. It counts what the panel
 * already observes on a collect (the newest session/status/report write, a new `hud-progress` entry, tokens spent), so it adds
 * no polling and no file reads. A worker first seen mid-run has no history; the ring starts empty and stays absent until a write.
 */
import type { OwnerWorker } from './workboard-types.js';

export const RING_MINUTES = 10;
interface Ring { minute: number; counts: number[]; seen: string }
const running = (w: OwnerWorker) => w.settledAt === null && w.state === 'working';
const signature = (w: OwnerWorker) =>
  [w.work?.activityAt, w.progress?.length, w.resources?.spent && w.resources.spent.input + w.resources.spent.output].join('|');

export class ActivityRings {
  private rings = new Map<string, Ring>();
  /** Folds one collect in and returns each running worker's buckets, oldest first; workers with no activity yet are left out. */
  observe(workers: readonly OwnerWorker[], now: number): Map<string, readonly number[]> {
    const minute = Math.floor(now / 60000), live = workers.filter(running), found = new Map<string, readonly number[]>();
    for (const id of this.rings.keys()) if (!live.some((w) => w.id === id)) this.rings.delete(id);
    for (const w of live) {
      const seen = signature(w), ring = this.rings.get(w.id);
      if (!ring) { this.rings.set(w.id, { minute, counts: Array(RING_MINUTES).fill(0), seen }); continue; }
      const gap = Math.min(RING_MINUTES, minute - ring.minute);
      if (gap > 0) ring.counts = [...ring.counts.slice(gap), ...Array<number>(gap).fill(0)];
      ring.minute = minute;
      if (seen !== ring.seen) { ring.counts[RING_MINUTES - 1]++; ring.seen = seen; }
      if (ring.counts.some((c) => c > 0)) found.set(w.id, [...ring.counts]);
    }
    return found;
  }
}
