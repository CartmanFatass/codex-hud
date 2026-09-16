/**
 * Reading a usage window.
 *
 * Two things are kept apart here. A percentage is what the account reported
 * at the time of the snapshot. A countdown is arithmetic on the reset time.
 * When the countdown runs out, the HUD says the reset is due, and keeps
 * showing the last reported percentage: a window that should have reset is
 * not evidence that it did.
 */

import type { RateLimitSnapshot, RateLimitWindow } from '../types.js';

export interface QuotaWindow {
  percent: number;
  /** Window length, e.g. "5h" or "7d". Absent when the length is unknown. */
  label: string;
  resetsAt: Date | null;
  /** True once the reset time has passed with no newer snapshot. */
  resetDue: boolean;
}

/**
 * `resets_at` has appeared as an epoch in seconds, an epoch in milliseconds,
 * an RFC3339 string, and as a plain number of seconds from now. Each shape is
 * recognised by its magnitude rather than assumed, and anything unrecognised
 * yields no countdown at all.
 */
export function resolveResetTime(window: RateLimitWindow, nowMs: number): Date | null {
  const raw = window.resets_at;

  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    // Below this, the value cannot be an epoch: it is a duration from now.
    if (raw < 1_000_000_000) {
      return new Date(nowMs + raw * 1000);
    }
    // Milliseconds since the epoch are three orders of magnitude larger.
    return new Date(raw > 1_000_000_000_000 ? raw : raw * 1000);
  }

  const seconds = (window as { resets_in_seconds?: number }).resets_in_seconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
    return new Date(nowMs + seconds * 1000);
  }

  return null;
}

export function formatWindowLabel(minutes?: number): string {
  if (!minutes || minutes <= 0) {
    return '';
  }
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
}

/** Coarse countdown: hours and minutes, then minutes, then seconds. */
export function formatCountdown(target: Date, nowMs: number): string {
  const seconds = Math.max(0, Math.round((target.getTime() - nowMs) / 1000));
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m`;
  }
  return `${seconds}s`;
}

export function readQuotaWindows(
  limits: RateLimitSnapshot | undefined | null,
  nowMs: number
): QuotaWindow[] {
  if (!limits) {
    return [];
  }
  return [limits.primary, limits.secondary]
    .filter((window): window is RateLimitWindow => Boolean(window && typeof window.used_percent === 'number'))
    .map((window) => {
      const resetsAt = resolveResetTime(window, nowMs);
      return {
        percent: Math.round(window.used_percent ?? 0),
        label: formatWindowLabel(window.window_minutes),
        resetsAt,
        resetDue: Boolean(resetsAt && resetsAt.getTime() <= nowMs),
      };
    });
}
