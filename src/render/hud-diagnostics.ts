import type { TokenRateSnapshot } from '../collectors/token-rate.js';
import { formatTokenRate } from '../collectors/token-rate.js';
import { t } from './i18n.js';

export function tokenRateDetails(
  rate: TokenRateSnapshot | undefined,
  turnStartedAt: Date | undefined,
  working: boolean,
  now: number
): string[] {
  const reading = formatTokenRate(rate, now);
  if (!reading || !rate) return [t('TPS: no sample yet')];
  const prior = !!turnStartedAt && rate.sampledAt.getTime() < turnStartedAt.getTime();
  const kind =
    rate.sampledAt.getTime() > now
      ? 'TPS sample: timestamp is ahead of observation'
      : prior
        ? 'TPS sample: previous turn'
        : working && now - rate.sampledAt.getTime() < 10_000
          ? 'TPS sample: current turn, recent'
          : 'TPS sample: last measurement';
  return [
    t(kind),
    t('Estimated output: {rate}', { rate: reading.replace(/^last /, '') }),
    t('Sampled at: {at}', { at: rate.sampledAt.toISOString() }),
    t('Sample duration: {seconds}s', { seconds: (rate.sampleMs / 1000).toFixed(2) }),
    t('Turn estimate includes initial delay and stalls; excludes known tool waits. Not exact request throughput.'),
  ];
}
