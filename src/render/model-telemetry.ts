import type { ModelTelemetrySummary, TelemetryFeature } from '../collectors/model-telemetry.js';
import { MODEL_FEATURES } from '../collectors/model-telemetry.js';
import { t } from './i18n.js';
import { flowLines, monitorText } from './monitor-text.js';

const FEATURE_LABELS: Record<TelemetryFeature, string> = {
  approval: 'Approval explanations', probe: 'Connection probes', progress: 'Progress summaries', labels: 'Agent labels',
  title: 'Session titles', recap: 'Session recaps', cause: 'Failure explanations', brief: 'Agent briefs',
  digest: 'Result digests', changes: 'Change summaries', other: 'Other model features',
};
const PERSISTENCE_LABELS = { memory: 'Memory only', shared: 'Shared local history', pending: 'History save pending', unavailable: 'History incomplete; local facts retained' };
const stamp = (at: number) => Number.isFinite(at) && Math.abs(at) <= 8.64e15 ? new Date(at).toISOString() : t('unknown');

/** Pure render: summary is sampled by the collector/caller before entering here. */
export function modelTelemetryLines(summary: ModelTelemetrySummary | undefined, width: number): string[] {
  const lines = [t('Model calls by feature')];
  if (!summary) lines.push(t('Model call telemetry unavailable'));
  else {
    lines.push(t('Observed at: {at}', { at: stamp(summary.observedAt) }),
      t('History: {state}', { state: t(PERSISTENCE_LABELS[summary.persistence] ?? PERSISTENCE_LABELS.unavailable) }),
      t('Retained requests: {n} (last 24h, at most 1000)', { n: summary.retained }),
      t('Requests include cache hits and refusals; successes count generated replies. Limits may overlap failures.'),
      t('Older calls and other panels\' pending requests are unavailable. Cache hits count consumers, not provider calls.'));
    if (summary.atCapacity) lines.push(t('History is at capacity; counts may omit earlier requests in this window.'));
    if (!summary.features.length) lines.push(t('No model requests observed in this window'));
    for (const feature of MODEL_FEATURES) {
      const row = summary.features.find(value => value.feature === feature);
      if (!row) continue;
      lines.push('', t(FEATURE_LABELS[feature]),
        t('Requests {requests} · pending {pending} · generated {successes} · failed {failures}', row as unknown as Record<string, number>),
        t('Cache {cacheHits} · cancelled {cancelled} · limited {limited} · refused {refused}', row as unknown as Record<string, number>),
        t('Mean dispatch-to-settlement: {duration} ({n} samples)', {
          duration: row.meanDurationMs === null ? t('unavailable') : t('{n} ms', { n: Math.round(row.meanDurationMs) }), n: row.durationSamples,
        }));
    }
  }
  lines.push('', t('Duration excludes queue time; cancellation ends at public settlement.'),
    t('Provider token usage: unavailable'), t('Dollar cost: unavailable; call accounting is not billing'));
  return lines.flatMap(line => flowLines(monitorText(line), width));
}
