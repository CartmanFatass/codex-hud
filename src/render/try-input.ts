import type { TryTarget } from '../collectors/try-records.js';
import type { MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';
import { activeTabState } from './monitor-state.js';

/** Mark by row identity, so scrolling or folding a row doesn't lose the selection. */
export function tryInput(next: MonitorState, key: string, row?: MonitorRow): MonitorOutcome | undefined {
  const tab = activeTabState(next);
  if (!tab) return;
  const selectedRows = tab.trySelection, target = row?.tryTarget;
  const withMarks = (trySelection?: typeof selectedRows): MonitorState => ({ ...next, [next.activeTab]: { ...tab, trySelection } });
  if (key === 'space' && row?.item && target) {
    const marked = new Map(selectedRows);
    if (!marked.delete(row.item)) marked.set(row.item, target);
    return { state: withMarks(marked.size ? marked : undefined), close: false };
  }
  if (key !== 'try-accept' && key !== 'try-flag' && key !== 'request-land') return;
  let batch = target;
  if (selectedRows) {
    const slices = new Map<string, { slice: TryTarget['slices'][number]; milestone: string }>();
    for (const marked of selectedRows.values()) for (const slice of marked.slices)
      slices.set(slice.id, { slice, milestone: marked.milestone });
    const selected = [...slices.values()], milestones = selected.map((s) => s.milestone);
    const mixed = milestones.some((m) => m !== milestones[0]);
    batch = { milestone: mixed ? '—' : milestones[0], slices: selected.map((s) => s.slice), ...(mixed ? { milestones } : {}) };
  }
  if (batch) return { state: selectedRows ? withMarks() : next, close: false, action: { type: 'record-try', action: key === 'request-land' ? 'land' : key === 'try-accept' ? 'accept' : 'flag', target: batch } };
}
