import { join } from 'node:path';
import { readJsonBounded } from '../utils/atomic-fs.js';

export const SCHEDULE_BYTES = 64 * 1024;
export const SCHEDULE_MAX_OPEN = 200;
export const SCHEDULE_TEXT_MAX = 160;
export const SCHEDULE_DATE = '^\\d{4}-\\d{2}(?:-\\d{2})?$';
export const SCHEDULE_ID = '^s[1-9]\\d*$';
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScheduleItem {
  id: string;
  date: string;
  text: string;
  project?: string;
  objective?: string;
  created_at: string;
  done_at?: string;
}

export interface Schedule {
  version: 1;
  seq: number;
  items: ScheduleItem[];
}

export const schedulePath = (home: string) => join(home, 'schedule.json');
const datePattern = new RegExp(SCHEDULE_DATE);
const idPattern = new RegExp(SCHEDULE_ID);
const oneLine = /^[^\p{Cc}\p{Surrogate}\u2028\u2029]+$/u;

export function scheduleText(value: unknown): value is string {
  return typeof value === 'string' && oneLine.test(value) && !!value.trim() && [...value].length <= SCHEDULE_TEXT_MAX;
}

/** UTC is only a coordinate for calendar-day arithmetic, not the owner's timezone. */
function dueDay(date: string): number {
  if (!datePattern.test(date)) return NaN;
  const month = date.length === 7;
  const day = new Date(month ? `${date}-01` : date);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, date.length) !== date) return NaN;
  if (month) day.setUTCMonth(day.getUTCMonth() + 1, 0);
  return day.getTime();
}

export function scheduleDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(dueDay(value));
}

export function scheduleTiming(date: string, nowMs: number) {
  const today = new Date(nowMs);
  const month = today.getMonth();
  today.setUTCFullYear(today.getFullYear(), month, today.getDate());
  today.setUTCHours(0, 0, 0, 0);
  const deadline = dueDay(date);
  const days_until_due = (deadline - today.getTime()) / DAY_MS;
  const stage = days_until_due < 0 ? 'overdue' : days_until_due === 0 ? 'today'
    : (date.length === 7 ? today.toISOString().startsWith(date) : days_until_due <= 7) ? 'soon' : 'far';
  return { stage, due: days_until_due <= 0, days_until_due };
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validItem(item: ScheduleItem, seq: number): boolean {
  return item && typeof item.id === 'string' && idPattern.test(item.id) && Number(item.id.slice(1)) <= seq &&
    scheduleDate(item.date) && scheduleText(item.text) && timestamp(item.created_at) &&
    (item.done_at === undefined || timestamp(item.done_at)) &&
    (item.project === undefined || typeof item.project === 'string' && !!item.project) &&
    (item.objective === undefined || typeof item.objective === 'string' && !!item.objective && !!item.project);
}

/** Only an absent file is an empty schedule. Never overwrite unreadable or invalid state. */
export function readSchedule(home: string): Schedule {
  let state: Schedule | null;
  try { state = readJsonBounded(schedulePath(home), SCHEDULE_BYTES) as Schedule | null; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, seq: 0, items: [] };
    throw error;
  }
  if (state?.version !== 1 || !Number.isSafeInteger(state.seq) || state.seq < 0 || !Array.isArray(state.items) ||
      !state.items.every((item) => validItem(item, state.seq)) ||
      new Set(state.items.map(({ id }) => id)).size !== state.items.length ||
      state.items.filter(({ done_at }) => !done_at).length > SCHEDULE_MAX_OPEN)
    throw new Error('Invalid schedule.json');
  return state;
}
