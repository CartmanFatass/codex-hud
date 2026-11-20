import type { LedgerSlice } from './project-board.js';

export interface AcceptanceTask {
  key: string;
  milestone: string;
  slices: LedgerSlice[];
  oldest?: number;
}

/** Ledger order is supplied by the caller; a slice without a milestone is its own task. */
export function ledgerTasks(ledger: readonly LedgerSlice[]): AcceptanceTask[] {
  const groups = new Map<string, AcceptanceTask>();
  for (const r of ledger) {
    const key = !r.milestone || r.milestone === '—' ? `slice:${r.id}` : `milestone:${r.milestone}`;
    let task = groups.get(key);
    if (!task) groups.set(key, task = { key, milestone: r.milestone, slices: [] });
    task.slices.push(r);
    if (r.at !== undefined && (task.oldest === undefined || r.at < task.oldest)) task.oldest = r.at;
  }
  return [...groups.values()];
}

/** Only pending slices belong to an acceptance target. */
export const acceptanceTasks = (ledger: readonly LedgerSlice[]) => ledgerTasks(ledger.filter((r) => r.state === 'try'));
