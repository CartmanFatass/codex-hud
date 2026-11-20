import type { TryTarget } from '../collectors/try-records.js';
import type { MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';

/** Mark by row identity, so scrolling or folding a row doesn't lose the selection. */
export function tryInput(next: MonitorState, key: string, row?: MonitorRow): MonitorOutcome | undefined {
  const target = row?.tryTarget;
  if (key === 'space' && row?.item && target) {
    const marked = new Map(next.trySelection);
    if (!marked.delete(row.item)) marked.set(row.item, target);
    next.trySelection = marked.size ? marked : undefined;
    return { state: next, close: false };
  }
  if (key !== 'try-accept' && key !== 'try-flag') return;
  let batch = target;
  if (next.trySelection) {
    const slices = new Map<string, { slice: TryTarget['slices'][number]; milestone: string }>();
    for (const marked of next.trySelection.values()) for (const slice of marked.slices)
      slices.set(slice.id, { slice, milestone: marked.milestone });
    const selected = [...slices.values()], milestones = selected.map((s) => s.milestone);
    const mixed = milestones.some((m) => m !== milestones[0]);
    batch = { milestone: mixed ? '—' : milestones[0], slices: selected.map((s) => s.slice), ...(mixed ? { milestones } : {}) };
    next.trySelection = undefined;
  }
  if (batch) return { state: next, close: false, action: { type: 'record-try', action: key === 'try-accept' ? 'accept' : 'flag', target: batch } };
}
