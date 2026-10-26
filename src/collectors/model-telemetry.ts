/** Bounded, content-free model lifecycle accounting. No prompts, replies or routes. */
export const MODEL_FEATURES = ['approval', 'probe', 'progress', 'labels', 'title', 'recap', 'cause', 'brief', 'digest', 'changes', 'other'] as const;
export type TelemetryFeature = typeof MODEL_FEATURES[number];
export const TELEMETRY_WINDOW_MS = 86_400_000;
export const TELEMETRY_RECORD_LIMIT = 1000;
const OUTCOMES = ['pending', 'success', 'failure', 'cache', 'cancelled', 'limited', 'refused'] as const;
export type TelemetryOutcome = typeof OUTCOMES[number];
const FAILURES = ['auth', 'model-not-found', 'rate-limit', 'timeout', 'network', 'server', 'invalid-response', 'output-limit', 'hourly-cap', 'runtime-unavailable', 'unknown'] as const;
export type TelemetryFailure = typeof FAILURES[number];
export interface ModelTelemetryRecord {
  id: string; feature: TelemetryFeature; at: number; outcome: TelemetryOutcome;
  durationMs: number | null; failure: TelemetryFailure | null;
}
export interface FeatureModelTelemetry {
  feature: TelemetryFeature; requests: number; pending: number; successes: number; failures: number;
  cacheHits: number; cancelled: number; limited: number; refused: number;
  durationSamples: number; meanDurationMs: number | null;
  tokens: null; cost: null;
}
export interface ModelTelemetrySummary {
  observedAt: number; windowStartedAt: number; windowMs: number; recordLimit: number; retained: number;
  atCapacity: boolean; persistence: 'memory' | 'shared' | 'pending' | 'unavailable';
  features: FeatureModelTelemetry[];
}
export function telemetryFeature(value: unknown): TelemetryFeature {
  return MODEL_FEATURES.includes(value as TelemetryFeature) ? value as TelemetryFeature : 'other';
}
export function telemetryFailure(value: unknown): TelemetryFailure {
  return FAILURES.includes(value as TelemetryFailure) ? value as TelemetryFailure : 'unknown';
}
/** Reconstruct fields rather than spreading persisted or source objects. */
export function cleanTelemetryRecord(value: unknown): ModelTelemetryRecord | undefined {
  const row = value as Partial<ModelTelemetryRecord> | null;
  if (!row || typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/.test(row.id)
    || typeof row.at !== 'number' || !Number.isFinite(row.at) || row.at < 0
    || !OUTCOMES.includes(row.outcome as TelemetryOutcome)) return undefined;
  return { id: row.id, feature: telemetryFeature(row.feature), at: row.at, outcome: row.outcome!,
    durationMs: typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) && row.durationMs >= 0 ? row.durationMs : null,
    failure: row.failure == null ? null : telemetryFailure(row.failure) };
}
export function boundedTelemetry(records: readonly ModelTelemetryRecord[], now: number): ModelTelemetryRecord[] {
  const merged = new Map<string, ModelTelemetryRecord>();
  for (const record of records) {
    const row = cleanTelemetryRecord(record);
    if (row && row.at >= now - TELEMETRY_WINDOW_MS) merged.set(row.id, row);
  }
  return [...merged.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).slice(-TELEMETRY_RECORD_LIMIT);
}
export function summarizeModelTelemetry(records: readonly ModelTelemetryRecord[], now: number,
  persistence: ModelTelemetrySummary['persistence']): ModelTelemetrySummary {
  const retained = boundedTelemetry(records, now).filter(row => row.at <= now);
  const features = new Map<TelemetryFeature, FeatureModelTelemetry>();
  for (const row of retained) {
    let stats = features.get(row.feature);
    if (!stats) {
      stats = { feature: row.feature, requests: 0, pending: 0, successes: 0, failures: 0, cacheHits: 0,
        cancelled: 0, limited: 0, refused: 0, durationSamples: 0, meanDurationMs: null, tokens: null, cost: null };
      features.set(row.feature, stats);
    }
    stats.requests++;
    if (row.outcome === 'pending') stats.pending++;
    if (row.outcome === 'success') stats.successes++;
    if (row.outcome === 'failure') stats.failures++;
    if (row.outcome === 'cache') stats.cacheHits++;
    if (row.outcome === 'cancelled') stats.cancelled++;
    if (row.outcome === 'limited' || row.failure === 'output-limit' || row.failure === 'rate-limit') stats.limited++;
    if (row.outcome === 'refused' || row.outcome === 'limited') stats.refused++;
    if (row.durationMs !== null) {
      stats.meanDurationMs = ((stats.meanDurationMs ?? 0) * stats.durationSamples + row.durationMs) / ++stats.durationSamples;
    }
  }
  return { observedAt: now, windowStartedAt: now - TELEMETRY_WINDOW_MS, windowMs: TELEMETRY_WINDOW_MS,
    recordLimit: TELEMETRY_RECORD_LIMIT, retained: retained.length, atCapacity: retained.length >= TELEMETRY_RECORD_LIMIT,
    persistence, features: MODEL_FEATURES.flatMap(feature => features.has(feature) ? [features.get(feature)!] : []) };
}
