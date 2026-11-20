import { expInteger } from './exp-config.js';

export interface ExpProxyWindow {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number; // Unix seconds, as reported by Codex
}
export type ExpProxyWindows = Partial<Record<'primary' | 'secondary', ExpProxyWindow>>;
export const PROXY_ERRORS = [
  'not_logged_in',
  'binding_changed',
  'rate_limited',
  'timeout',
  'unavailable',
  'invalid_response',
  'request_failed',
] as const;
export type ExpProxyError = (typeof PROXY_ERRORS)[number];
export interface ExpProxySnapshot extends ExpProxyWindows {
  profile: string;
  bindingVersion: string;
  observedAtMs: number | null;
  error: ExpProxyError | null;
  failures: number;
  nextAttemptMs: number | null;
}
export type ExpProxyReading = { intervalMinutes: number; snapshot?: ExpProxySnapshot };

const MAX_UNIX_SECONDS = 8_640_000_000_000;
export const proxyTime = (n: unknown): n is number => expInteger(n, 0, MAX_UNIX_SECONDS * 1000);
export const proxyIntervalMs = (minutes: number) => minutes * 60_000;
export const proxyObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export function proxyWindow(
  usedPercent: unknown,
  windowDurationMins: unknown,
  resetsAt: unknown
): ExpProxyWindow | undefined {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0) return;
  return {
    usedPercent,
    windowDurationMins: expInteger(windowDurationMins, 1, Number.MAX_SAFE_INTEGER) ? windowDurationMins : undefined,
    resetsAt: expInteger(resetsAt, 0, MAX_UNIX_SECONDS) ? resetsAt : undefined,
  };
}

export function proxyWindows(value: unknown): ExpProxyWindows {
  const bucket = proxyObject(value);
  const window = (value: unknown) => {
    const entry = proxyObject(value);
    return proxyWindow(entry?.usedPercent, entry?.windowDurationMins, entry?.resetsAt);
  };
  return { primary: window(bucket?.primary), secondary: window(bucket?.secondary) };
}

export function proxyDueAt(snapshot: ExpProxySnapshot | undefined, intervalMinutes: number): number | null {
  if (!snapshot) return 0;
  if (snapshot.error) return snapshot.nextAttemptMs;
  return (snapshot.observedAtMs ?? 0) + proxyIntervalMs(intervalMinutes);
}

export function proxyStale(observedAtMs: number | null, intervalMinutes: number, nowMs: number): boolean {
  return observedAtMs !== null && nowMs - observedAtMs > 2 * proxyIntervalMs(intervalMinutes);
}

export function windowLabel(window: ExpProxyWindow): string | undefined {
  const minutes = window.windowDurationMins;
  if (minutes === undefined) return;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
export const windowPending = (window: ExpProxyWindow, nowMs: number) =>
  window.resetsAt !== undefined && nowMs >= window.resetsAt * 1000;
export const windowRemaining = (window: ExpProxyWindow) => Math.max(0, Math.round(100 - window.usedPercent));
