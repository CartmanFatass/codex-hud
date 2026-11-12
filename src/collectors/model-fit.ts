import type { OwnerWorker } from './workboard-types.js';
const OUTCOMES = ['done', 'partial', 'failed', 'blocked'] as const;
/** No calls: all groups, including unknown labels, come exclusively from job records and cached labels. */
export function modelFit(workers: readonly OwnerWorker[]) {
  const groups = new Map<string, { kind: string; assignment: string; runs: number; outcomes: number[]; times: number[]; unlabelled: number }>();
  for (const w of workers.filter((w) => w.id.startsWith('thin-job:')))
    for (const kind of w.labels?.kinds?.length ? w.labels.kinds : ['unlabelled']) {
      const assignment = [w.role ?? '—', w.model ?? '—', w.effort ?? '—'].join(' · '), key = kind + ':' + assignment;
      const row = groups.get(key) ?? { kind, assignment, runs: 0, outcomes: [0, 0, 0, 0], times: [], unlabelled: 0 };
      row.runs++;
      const index = OUTCOMES.indexOf(w.labels?.outcome?.value as typeof OUTCOMES[number]);
      if (index < 0) row.unlabelled++; else row.outcomes[index]++;
      if (w.startedAt !== null && w.settledAt !== null && w.settledAt >= w.startedAt) row.times.push(w.settledAt! - w.startedAt);
      groups.set(key, row);
    }
  return [...groups.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.assignment.localeCompare(b.assignment)).map((r) => {
    const times = r.times.sort((a, b) => a - b), n = times.length;
    return { ...r, median: n ? (times[Math.floor((n - 1) / 2)] + times[Math.floor(n / 2)]) / 2 : null };
  });
}
