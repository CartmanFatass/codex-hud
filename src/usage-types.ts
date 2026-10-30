/** Native rollout usage, independent of context-window and subscription meters. */
export type UsagePeriod = 'today' | '7d' | '30d' | 'all';

export interface UsageQuery {
  period: UsagePeriod;
  nowMs: number;
  /** Omit to include all history in this Codex home. */
  rootId?: string;
  /** Reuse stored AI titles only while the existing names enhancement is enabled. */
  enhancedTitles?: boolean;
  filter?: { by: 'model' | 'effort' | 'role' | 'project'; key: string | null };
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
  cost?: import('./collectors/usage-pricing.js').UsageCost;
}

export interface UsageBucket { key: string | null; totals: UsageTotals }
export interface UsageTask {
  rootId: string;
  title?: string;
  project?: string | null;
  firstAtMs?: number;
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
  projects?: UsageBucket[];
  pricing?: { source: string; revision: string; updatedAtMs: number | null; rates: Record<string, import('./collectors/usage-pricing.js').UsageRates | null> };
  comparison?: { previous: UsageTotals; costChangePct: number | null };
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
