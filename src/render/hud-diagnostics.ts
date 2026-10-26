import type { HudData, SubagentTree } from '../types.js';
import type { TokenRateSnapshot } from '../collectors/token-rate.js';
import { formatTokenRate } from '../collectors/token-rate.js';
import { t } from './i18n.js';
import { monitorText, flowLines } from './monitor-text.js';
import { diagnosticEvidence, findDiagnosticAgent } from '../diagnostics/provenance.js';
import type { ModelTelemetrySummary } from '../collectors/model-telemetry.js';
import { modelTelemetryLines } from './model-telemetry.js';

type Say = (text: string, vars?: Record<string, string | number>) => string;
const english: Say = (text, vars) => text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars?.[key] ?? ''));
export const MODEL_FAILURES: Record<string, string> = {
  auth: 'Model authentication failed', 'model-not-found': 'Model not found', 'rate-limit': 'Model rate limited',
  timeout: 'Model request timed out', network: 'Model connection failed', server: 'Model service unavailable',
  'invalid-response': 'Model response invalid', 'hourly-cap': 'Hourly model call cap reached',
  'output-limit': 'Model output limit reached',
  'runtime-unavailable': 'Model budget store unavailable',
};

/** Only current problems appear on the normal bar/panel. Healthy state stays quiet. */
export function hudProblems(data: HudData | null | undefined, now: number, say: Say = english): string[] {
  if (!data) return [];
  const problems: string[] = [];
  if (data.health?.sessionBound === false) problems.push(say('No Codex session bound'));
  if (data.stale) problems.push(say('Session read failed; showing last data'));
  const bridge = data.bridgeHealth;
  if (bridge?.state === 'unresponsive') problems.push(say('Herdr bridge not responding'));
  else if (bridge?.state === 'disconnected') problems.push(say('Herdr bridge disconnected'));
  else if (bridge?.stateMismatch) problems.push(say('Herdr state differs from Codex'));
  else if (bridge?.probeFailed) problems.push(say('Codex state probe retrying'));
  else if (bridge?.notificationGap && bridge.mode !== 'native') problems.push(say('Herdr reconnected; earlier notifications unverified'));
  const model = data.modelHealth;
  if (model?.lastFailure && model.lastFailure.at >= (model.lastSuccessAt ?? 0))
    problems.push(say(MODEL_FAILURES[model.lastFailure.classification ?? model.lastFailure.reason ?? ''] ?? 'Model request failed'));
  else if (model?.queued) problems.push(say('Model queue: {n}', { n: model.queued }));
  else if (model?.running && now - model.running.startedAt > 15_000) problems.push(say('Model is still responding'));
  return problems;
}

export function tokenRateDetails(rate: TokenRateSnapshot | undefined, turnStartedAt: Date | undefined, working: boolean, now: number): string[] {
  const reading = formatTokenRate(rate, now);
  if (!reading || !rate) return [t('TPS: no sample yet')];
  const prior = !!turnStartedAt && rate.sampledAt.getTime() < turnStartedAt.getTime();
  const kind = rate.sampledAt.getTime() > now ? 'TPS sample: timestamp is ahead of observation' : prior ? 'TPS sample: previous turn' : working && now - rate.sampledAt.getTime() < 10_000
    ? 'TPS sample: current turn, recent' : 'TPS sample: last measurement';
  return [t(kind), t('Estimated output: {rate}', { rate: reading.replace(/^last /, '') }),
    t('Sampled at: {at}', { at: rate.sampledAt.toISOString() }),
    t('Sample duration: {seconds}s', { seconds: (rate.sampleMs / 1000).toFixed(2) }),
    t('Turn estimate includes initial delay and stalls; excludes known tool waits. Not exact request throughput.')];
}

export interface DiagnosticOptions { tree?: SubagentTree; selectedId?: string; telemetry?: ModelTelemetrySummary }

export function diagnosticLines(data: HudData | undefined, width: number, now: number, options: DiagnosticOptions = {}): string[] {
  const evidence = diagnosticEvidence({ data, tree: options.tree, selectedId: options.selectedId, nowMs: now });
  const lines = [t('HUD diagnostics'), t('Observed at: {at}', { at: evidence.observedAt ?? t('unknown') }), ...hudProblems(data, now, t),
    t(evidence.main.source === 'unavailable' ? 'Main state evidence: unavailable' : 'Main state evidence: rollout events collected by HUD'),
    t('Main state: {state}', { state: t(evidence.main.state) }),
    t('State recorded at: {at}', { at: evidence.main.stateAt ?? t('unknown') }),
    t('Exact session binding method: unavailable')];
  if (!data?.activity) lines.push(t('Main state is unknown: no rollout activity evidence is available.'));
  if (data?.stale) lines.push(t('Collection failed; state and samples may be older than this observation.'));
  if (evidence.bridge.conflicting) lines.push(t('Conflicting evidence: Herdr readback differs from the Codex state probe. Neither proves notification delivery.'));
  if (evidence.bridge.transport === 'unknown' || evidence.bridge.transport === 'unavailable') lines.push(t('Herdr evidence unavailable; no state or notification claim can be made.'));
  else lines.push(t('Bridge evidence: {source}', { source: t(evidence.bridge.source === 'herdr-native-readback' ? 'Herdr native state readback'
    : evidence.bridge.source === 'herdr-report-transport' ? 'Herdr transport acknowledgement only' : 'unknown') }));
  // Without readback, legacy report acknowledgements cannot prove detection.
  if (data?.bridgeHealth?.state === 'unavailable') lines.push(t('No Herdr state readback; detection and completion notifications are unverified. Reattach with the updated HUD launcher.'));
  if (data?.bridgeHealth?.mode === 'native') lines.push(t('Herdr native detection; last observed state: {state}', { state: t(evidence.bridge.nativeState) }));
  if (data?.bridgeHealth?.mode === 'native' && data.bridgeHealth.notificationGap) lines.push(t('Earlier state readback was interrupted; native notifications run independently.'));
  lines.push(t('Last successful read: {at}', { at: evidence.collection.lastReadAt ?? t('No read yet') }));
  if (data?.health?.lastError) lines.push(t('Last collection error: {source}: {reason}', {
    source: t(evidence.collection.lastError?.source ?? 'unknown'), reason: t('Collection failed; raw error omitted'),
  }));
  if (evidence.bridge.lastReadbackAt) lines.push(t(data?.bridgeHealth?.mode === 'native' ? 'Herdr last readback: {at}' : 'Herdr last transport acknowledgement (state unverified): {at}', { at: evidence.bridge.lastReadbackAt }));
  if (data?.modelHealth) {
    lines.push(t('Model evidence: local SmallModel lifecycle'),
      t('Model queue: {n}', { n: data.modelHealth.queued }),
      t('Model last generated success: {at}', { at: evidence.model.lastSuccessAt ?? t('unknown') }));
    if (evidence.model.lastFailure) lines.push(t('Model last failure: {reason} at {at}', {
      reason: t(MODEL_FAILURES[evidence.model.lastFailure.classification] ?? 'Model request failed'),
      at: evidence.model.lastFailure.at ?? t('unknown'),
    }));
  }
  lines.push('', t('Main session TPS'), t('TPS evidence: rollout token counts and turn/tool timestamps'),
    ...tokenRateDetails(data?.outputRate, data?.activity?.turnStartedAt, data?.activity?.state === 'working', now));
  if (evidence.selected) {
    const selected = findDiagnosticAgent(options.tree ?? data?.subagentTree, options.selectedId);
    lines.push('', t('Selected agent evidence'));
    if (!evidence.selected.found) lines.push(t('Selected agent is unavailable in the current tree.'));
    else {
      lines.push(t('Agent state evidence: parent events and agent rollout scan'),
        t('Tree observed at: {at}', { at: evidence.selected.observedAt ?? t('unknown') }),
        t('Agent state: {state}', { state: t(evidence.selected.state) }),
        t('State recorded at: {at}', { at: evidence.selected.stateAt ?? t('unknown') }),
        t('Last agent evidence: {at}', { at: evidence.selected.lastEventAt ?? t('unknown') }));
      if (evidence.selected.state === 'unknown') lines.push(t('Unknown agent state: no decisive lifecycle evidence was observed. Recent activity alone does not prove running.'));
      if (!evidence.selected.stateAt) lines.push(t('State timestamp unavailable; freshness cannot be inferred from status alone.'));
      lines.push(t('Agent completion is recorded lifecycle evidence, not verification of its work.'),
        t('TPS evidence: rollout token counts and turn/tool timestamps'),
        ...tokenRateDetails(selected?.outputRate, selected?.turnStartedAt, selected?.status === 'running', now));
    }
  }
  const wrapped = lines.flatMap(line => flowLines(monitorText(line), width));
  if (options.telemetry) wrapped.push('', ...modelTelemetryLines(options.telemetry, width));
  return wrapped;
}
