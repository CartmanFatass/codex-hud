import type { HudData } from '../types.js';
import type { TokenRateSnapshot } from '../collectors/token-rate.js';
import { formatTokenRate } from '../collectors/token-rate.js';
import { t } from './i18n.js';
import { monitorText, flowLines } from './monitor-text.js';

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
  const kind = prior ? 'TPS sample: previous turn' : working && now - rate.sampledAt.getTime() < 10_000
    ? 'TPS sample: current turn, recent' : 'TPS sample: last measurement';
  return [t(kind), t('Estimated output: {rate}', { rate: reading.replace(/^last /, '') }),
    t('Sampled at: {at}', { at: rate.sampledAt.toISOString() }),
    t('Sample duration: {seconds}s', { seconds: (rate.sampleMs / 1000).toFixed(2) }),
    t('Turn estimate includes initial delay and stalls; excludes known tool waits. Not exact request throughput.')];
}

export function diagnosticLines(data: HudData | undefined, width: number, now: number): string[] {
  const lines = [t('HUD diagnostics'), ...hudProblems(data, now, t)];
  // Without readback, legacy report acknowledgements cannot prove detection.
  if (data?.bridgeHealth?.state === 'unavailable') lines.push(t('No Herdr state readback; detection and completion notifications are unverified. Reattach with the updated HUD launcher.'));
  if (data?.bridgeHealth?.mode === 'native') lines.push(t('Herdr native detection; last observed state: {state}', { state: data.bridgeHealth.nativeState ?? 'unknown' }));
  if (data?.bridgeHealth?.mode === 'native' && data.bridgeHealth.notificationGap) lines.push(t('Earlier state readback was interrupted; native notifications run independently.'));
  const last = data?.health?.lastReadAt;
  lines.push(t('Last successful read: {at}', { at: last?.toISOString() ?? t('No read yet') }));
  if (data?.health?.lastError) lines.push(t('Last collection error: {source}: {reason}', {
    source: data.health.lastError.source, reason: data.health.lastError.message,
  }));
  if (data?.bridgeHealth?.lastSuccessAtMs) lines.push(t(data.bridgeHealth.mode === 'native' ? 'Herdr last readback: {at}' : 'Herdr last transport acknowledgement (state unverified): {at}', { at: new Date(data.bridgeHealth.lastSuccessAtMs).toISOString() }));
  if (data?.modelHealth) lines.push(t('Model queue: {n}', { n: data.modelHealth.queued }));
  lines.push('', t('Main session TPS'), ...tokenRateDetails(data?.outputRate, data?.activity?.turnStartedAt, data?.activity?.state === 'working', now));
  return lines.flatMap(line => flowLines(monitorText(line), width));
}
