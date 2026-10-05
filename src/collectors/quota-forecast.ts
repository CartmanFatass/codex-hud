/**
 * When a quota window will run out at the rate it is being used, as an
 * estimate, and only when the readings support one.
 *
 * A straight line through the window's recent readings (percent used over
 * time). Nothing is shown unless the readings span at least five minutes,
 * use is rising, and the line reaches 100 % before the window resets: a
 * window that resets first is not running out, and one with no known reset
 * cannot be said to. The answer is a projection, labelled as one where it is
 * shown ("~40m").
 */
import type { QuotaSample } from './rollout.js';

export interface QuotaForecast {
  window: 'primary' | 'secondary';
  /** When the line reaches 100 %. */
  exhaustAt: Date;
  /** The latest reading the line runs from. */
  percent: number;
  windowMinutes?: number;
}

/** The shortest stretch of readings a line is drawn through. */
export const FORECAST_MIN_SPAN_MS = 5 * 60_000;
/** Readings older than this before the latest are left out: the recent rate is the one that matters. */
const FORECAST_LOOKBACK_MS = 60 * 60_000;
/** Two readings within this of each other's reset time are the same window period. */
const SAME_RESET_MS = 120_000;

/** The least-squares slope of percent over time, per ms; null when undefined. */
export function slope(points: ReadonlyArray<{ t: number; p: number }>): number | null {
  if (points.length < 2) return null;
  const mt = points.reduce((sum, point) => sum + point.t, 0) / points.length;
  const mp = points.reduce((sum, point) => sum + point.p, 0) / points.length;
  let num = 0;
  let den = 0;
  for (const point of points) { num += (point.t - mt) * (point.p - mp); den += (point.t - mt) ** 2; }
  return den > 0 ? num / den : null;
}

function forecastWindow(samples: readonly QuotaSample[], window: 'primary' | 'secondary', now: number): QuotaForecast | null {
  const own = samples.filter(sample => sample.window === window);
  const last = own.at(-1);
  if (!last?.resetsAt) return null;
  const reset = last.resetsAt.getTime();
  // This period's readings only: a reset in between would read as use falling.
  const period: QuotaSample[] = [];
  for (let i = own.length - 1; i >= 0; i--) {
    const sample = own[i];
    if (!sample.resetsAt || Math.abs(sample.resetsAt.getTime() - reset) > SAME_RESET_MS) break;
    if (last.at.getTime() - sample.at.getTime() > FORECAST_LOOKBACK_MS) break;
    period.unshift(sample);
  }
  const first = period[0];
  if (!first || last.at.getTime() - first.at.getTime() < FORECAST_MIN_SPAN_MS || last.percent <= first.percent || last.percent >= 100) return null;
  const rate = slope(period.map(sample => ({ t: sample.at.getTime(), p: sample.percent })));
  if (rate === null || rate <= 0) return null;
  const exhaustAt = last.at.getTime() + (100 - last.percent) / rate;
  // Past already, or after the reset: no claim to make.
  if (exhaustAt <= now || exhaustAt >= reset) return null;
  return { window, exhaustAt: new Date(exhaustAt), percent: last.percent, ...(last.windowMinutes !== undefined ? { windowMinutes: last.windowMinutes } : {}) };
}

/** The window that runs out first, if any is projected to before it resets. */
export function quotaForecast(samples: readonly QuotaSample[], now: number = Date.now()): QuotaForecast | null {
  const found = (['primary', 'secondary'] as const).map(window => forecastWindow(samples, window, now)).filter((value): value is QuotaForecast => value !== null);
  return found.sort((a, b) => a.exhaustAt.getTime() - b.exhaustAt.getTime())[0] ?? null;
}
