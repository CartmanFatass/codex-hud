import { checksJustFinished, formatJobChange, type JobRow } from '../collectors/thin-jobs.js';

export type Notice = { line: string; defer?: boolean; status?: JobRow };
const INTERVAL_MS = 5 * 60_000;
type State = JobRow['display_state'];
const live = (state: State) => state === 'working' || state === 'queued';
type Batch = { members: Map<string, State>; lastNotice: number; dirty: boolean };

/** One quiet watch's delivery cursor. Package labels group notices, not job lifecycles. */
export function packageBatches() {
  const active = new Map<string, Batch>();
  // A report/check may arrive after the final line. Forget its cursor on resume or disappearance.
  const finished = new Set<string>();
  return {
    get delay() {
      let next = Infinity;
      for (const batch of active.values()) if (batch.dirty) next = Math.min(next, batch.lastNotice + INTERVAL_MS);
      return Math.max(0, Math.ceil(next - performance.now()));
    },
    collect(rows: JobRow[], prev: ReadonlyMap<string, JobRow>, events: Notice[]) {
      const now = performance.now(), grouped = new Map<string, JobRow[]>();
      const terminal = new Set<string>();
      for (const row of rows) {
        if (!row.package || !row.state || row.land_turn || row.ticket_queue || row.workflow || row.batch_flow || row.parent_job) continue;
        if (!live(row.display_state)) terminal.add(row.job);
        const group = grouped.get(row.package);
        if (group) group.push(row); else grouped.set(row.package, [row]);
      }
      for (const id of finished) if (!terminal.has(id)) finished.delete(id);
      const notified = new Set(events.map(event => event.status?.job));
      const members = new Set(finished), failures: Notice[] = [], rollups: Notice[] = [];
      for (const [pkg, group] of grouped) {
        let batch = active.get(pkg);
        if (!batch) {
          if (group.filter(row => live(row.display_state)).length < 3) continue;
          active.set(pkg, batch = { members: new Map(), lastNotice: -Infinity, dirty: false });
        }
        for (const row of group) {
          const state = row.display_state, before = batch.members.get(row.job);
          // Include settlements first seen during this batch (including unread catch-up),
          // but not historical work that happens to have reused the same label.
          const old = prev.get(row.job);
          if (!before && !live(state) && (finished.has(row.job) || !notified.has(row.job) || (old && !live(old.display_state)))) continue;
          members.add(row.job);
          batch.members.set(row.job, state);
          if (state !== before && !live(state)) {
            if (state !== 'failed') batch.dirty = true;
            else if (before && !notified.has(row.job)) failures.push({ line: formatJobChange(row) });
          }
        }
        const counts = { done: 0, failed: 0, working: 0, queued: 0, stopped: 0 };
        for (const state of batch.members.values()) counts[state]++;
        const final = !counts.working && !counts.queued;
        if (!final && !(batch.dirty && now >= batch.lastNotice + INTERVAL_MS)) continue;
        const stopped = counts.stopped ? `, ${counts.stopped} stopped` : '';
        rollups.push({ line: `${pkg} batch: ${counts.done} done, ${counts.failed} failed${stopped}, ${counts.working} running, ${counts.queued} queued${final ? ' — final; list unread reports: hud_read view:compact' : ''}` });
        batch.lastNotice = now;
        batch.dirty = false;
        if (final) {
          for (const id of batch.members.keys()) if (terminal.has(id)) finished.add(id);
          active.delete(pkg);
        }
      }
      for (const pkg of active.keys()) if (!grouped.has(pkg)) active.delete(pkg);
      const individual = events.flatMap(event => {
        const row = event.status;
        if (!row || !members.has(row.job)) return [event]; // e.g. the full question, not the status line
        const old = prev.get(row.job);
        if (row.checks && row.checks.passed < row.checks.total && checksJustFinished(row, old)) return [{ ...event, defer: false }];
        if (row.display_state === 'working' || (row.display_state === 'failed' && old?.display_state !== 'failed')) return [event];
        return [];
      });
      return individual.concat(failures, rollups);
    },
  };
}
