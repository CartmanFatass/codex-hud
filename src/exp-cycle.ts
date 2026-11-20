import type { ExpGrant, ExpGrantTerms } from './exp-config.js';

type Calendar = Pick<ExpGrantTerms, 'renewalDay' | 'timeZone'>;
interface Cycle {
  start: number;
  end: number;
  startDate: string;
  endDate: string;
}
const dayMs = 86_400_000;
const dateKey = (utcMs: number) => new Date(utcMs).toISOString().slice(0, 10);

/** Monthly renewal at the first instant of the local date, including shifted/skipped midnights. */
export function expCycle({ renewalDay, timeZone }: Calendar, now: number): Cycle {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const localTime = (instant: number) => {
    const [month, day, year, hour, minute, second] = format.format(instant).match(/\d+/g)!.map(Number);
    return Date.UTC(year, month - 1, day, hour, minute, second);
  };
  const local = new Date(localTime(now));
  const renewal = (offset: number) => {
    const month = local.getUTCMonth() + offset;
    const year = local.getUTCFullYear();
    return Date.UTC(year, month, Math.min(renewalDay, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()));
  };
  const instant = (target: number) => {
    // Both sides of a clock change can map to midnight; choose the first occurrence.
    const candidates = [-1, 0, 1]
      .map((days) => {
        const sample = target + days * dayMs;
        return target - (localTime(sample) - sample);
      })
      .filter((candidate) => localTime(candidate) === target);
    if (candidates.length) return Math.min(...candidates);
    // If midnight was skipped, take the first representable instant on or after that date.
    let lo = target - 2 * dayMs;
    let hi = target + 2 * dayMs;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (localTime(mid) < target) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  const current = renewal(0),
    next = renewal(1);
  const currentStart = instant(current),
    nextStart = instant(next);
  // Local clocks can briefly return to the previous date/month after the first midnight.
  if (now >= nextStart) {
    const end = renewal(2);
    return { start: nextStart, end: instant(end), startDate: dateKey(next), endDate: dateKey(end) };
  }
  if (now >= currentStart) {
    return { start: currentStart, end: nextStart, startDate: dateKey(current), endDate: dateKey(next) };
  }
  const previous = renewal(-1);
  return { start: instant(previous), end: currentStart, startDate: dateKey(previous), endDate: dateKey(current) };
}

/** EXP-01 configs had no effective timestamp; conservatively wait for the first renewal after their save. */
export function grantTerms(grant: ExpGrant, now: number, legacySavedAt: number | undefined): ExpGrantTerms {
  const { grantMicros, renewalDay, timeZone, schedule } = grant;
  if (schedule?.previous && now < schedule.startsAt) return schedule.previous;
  const startsAt = schedule?.startsAt ?? (legacySavedAt === undefined ? undefined : expCycle(grant, legacySavedAt).end);
  return { grantMicros, renewalDay, timeZone, startsAt };
}

export function grantCycle(grant: ExpGrant, now: number, legacySavedAt?: number) {
  const terms = grantTerms(grant, now, legacySavedAt);
  const cycle = expCycle(terms, now);
  const cutoff = terms.startsAt;
  // Changing calendars takes effect at the old calendar's next renewal. The transition cycle runs
  // from that boundary until the first renewal on the new calendar, never retroactively.
  if (cutoff !== undefined && now >= cutoff && cycle.start < cutoff) {
    cycle.start = cutoff;
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: terms.timeZone, dateStyle: 'short' });
    cycle.startDate = local.format(cutoff);
  }
  return {
    ...cycle,
    timeZone: terms.timeZone,
    grantMicros: terms.startsAt !== undefined && terms.startsAt <= now ? terms.grantMicros : null,
  };
}
