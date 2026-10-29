/** Native rollout usage, independent of context-window and subscription meters. */
export type UsagePeriod = 'today' | '7d' | '30d';

export interface UsageQuery {
  period: UsagePeriod;
  nowMs: number;
  /** Omit to include all history in this Codex home. */
  rootId?: string;
}

export interface UsageTotals {
  /** Input includes cached input; reasoning output is a subset of output. */
  input: number | null;
  cachedInput: number | null;
  output: number | null;
  reasoningOutput: number | null;
  total: number | null;
  events: number;
  threads: number;
}

export interface UsageBucket { key: string | null; totals: UsageTotals }
export interface UsageTask {
  rootId: string;
  self: UsageTotals;
  descendants: UsageTotals;
  total: UsageTotals;
}

export interface UsageSnapshot {
  status: 'loading' | 'ready' | 'partial' | 'unavailable';
  updatedAtMs: number | null;
  range: { startMs: number; endMs: number; timeZone: string };
  source: { codexHome: string; label: string };
  totals: UsageTotals;
  daily: Array<{ day: string; totals: UsageTotals }>;
  models: UsageBucket[];
  efforts: UsageBucket[];
  roles: UsageBucket[];
  tasks: UsageTask[];
  coverage: {
    filesDiscovered: number;
    filesIndexed: number;
    filesUnreadable: number;
    malformedLines: number;
    unresolvedParents: number;
    ambiguousEvents: number;
  };
  message?: string;
}
