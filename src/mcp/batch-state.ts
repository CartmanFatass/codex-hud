/** One private manifest and one authoritative item/result index per fixed batch. The small
 * adjacent receipt wakes existing flow watchers without scanning every item on each job event. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { readDirSafe, readJsonFile, writeJsonPrivate } from '../utils/atomic-fs.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import type { Job, JobRoute } from './job-contracts.js';

export const isBatchId = (id: unknown): id is string => typeof id === 'string' && /^b[a-f0-9]{16}$/.test(id);
export const batchDir = (home: string, id: string) => join(home, 'flows', id);
export const batchIds = (home: string) => readDirSafe(join(home, 'flows')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(isBatchId);
export interface BatchScale {
  role: string; count: number; input_bytes: { max: number; median: number; total: number };
  presets: (string | null)[]; cap: number; max_parallel: number;
}
export interface Batch {
  flow: string; pane: string; cwd: string; dispatcher?: Job['dispatcher']; key: string; created_at: number;
  state: 'working' | 'paused' | 'stopped' | 'completed'; scale: BatchScale; pid?: number; start?: string;
  epoch: number; streak: number; settled: number; failures: number; reason?: string;
  totals: { waiting: number; running: number; done: number; failed: number; cancelled?: number }; notices: Record<string, string>;
}
export interface BatchInput {
  task: string; brief_file?: string; package?: string; input_bytes: number; inputs: { path: string; bytes: number }[]; route: JobRoute; pilot: boolean;
}
export interface Manifest { shared: Record<string, unknown>; items: BatchInput[] }
export interface ItemResult {
  item: number; brief_file?: string; preset: string | null; pilot: boolean; state: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';
  previous?: { job?: string; reason?: string }[]; stall?: string;
  job?: string; report_path?: string; files?: readonly string[]; reason?: string;
}
export function readBatch(home: string, id: string): Batch | null {
  if (!isBatchId(id)) return null;
  try { return readJsonFile(`${batchDir(home, id)}.json`) as Batch; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export const batchIndex = (home: string, id: string) => readJsonFile(join(batchDir(home, id), 'index.json')) as { batch: Batch; items: ItemResult[] };
export const batchLock = <T>(home: string, id: string, fn: () => T) => withAbstractLock('batch-state', `${home}\0${id}`, fn);
function recount(b: Batch, items: ItemResult[]) {
  b.totals = { waiting: 0, running: 0, done: 0, failed: 0 };
  for (const i of items) b.totals[i.state] = (b.totals[i.state] ?? 0) + 1;
}
export function failuresByReason(items: ItemResult[]) {
  const groups = new Map<string, { reason: string; count: number; example: string }>();
  for (const i of items) if (i.state === 'failed') {
    const reason = i.reason ?? 'failed';
    const group = groups.get(reason) ?? { reason, count: 0, example: i.job ?? `item ${i.item}` };
    group.count++; groups.set(reason, group);
  }
  return [...groups.values()];
}
const groupsLine = (items: ItemResult[]) => failuresByReason(items).map(g => `${g.reason} ×${g.count} (${g.example})`).join('; ');
const totalsLine = (b: Batch) => Object.entries(b.totals).map(([state,n]) => `${n} ${state}`).join(', ');
export function settleItem(b: Batch, items: ItemResult[], i: ItemResult, failure?: string) {
  i.state = failure ? 'failed' : 'done'; i.reason = failure?.slice(0, 300); delete i.stall;
  if (b.state !== 'working') return;
  b.settled++; b.streak = failure ? b.streak + 1 : 0;
  if (!failure) return;
  b.failures++;
  const groups = failuresByReason(items);
  if (i.pilot || b.streak >= 2 || (b.failures >= 2 && b.failures * 5 >= b.settled)) {
    b.state = 'paused'; b.reason = i.pilot ? 'pilot failed' : 'failure circuit breaker';
    recount(b, items);
    b.notices[`pause-${b.epoch}`] = `${b.flow} batch paused (${b.reason}): ${totalsLine(b)}. Failures: ${groupsLine(items)}. hud_create batch=${b.flow} action=resume, retry_failed or stop`;
  } else if (groups.find(g => g.reason === i.reason)?.count === 1) {
    b.notices[`failure-${b.epoch}-${i.item}`] = `${b.flow} item ${i.item} (${i.job ?? 'dispatch'}): ${i.reason}`;
  }
}
export function saveBatch(home: string, b: Batch, items: ItemResult[]) {
  recount(b, items);
  if (b.state === 'working' && !b.totals.waiting && !b.totals.running) b.state = 'completed';
  if (b.state === 'completed' || (b.state === 'stopped' && !b.totals.running)) b.notices[`end-${b.epoch}`] = `${b.flow} batch: ${totalsLine(b)}${b.totals.failed ? `; failures: ${groupsLine(items)}` : ''} — final; list unread reports: hud_read view:compact`;
  writeJsonPrivate(join(batchDir(home, b.flow), 'index.json'), { batch: b, items });
  writeJsonPrivate(`${batchDir(home, b.flow)}.json`, b);
}
export const batchActive = (b: Batch) => b.state === 'working' || b.totals.running > 0;
// Watch, MCP changes and direct delivery share the same exclusive claim per event.
export function batchEvents(home: string, b: Batch, all = false) {
  const events = [] as { line: string; marker: string }[];
  for (const [key, text] of Object.entries(b.notices)) {
    if (!/^(?:failure-\d+-\d+|(?:end|pause|error)-\d+)$/.test(key)) continue;
    const marker = join(batchDir(home, b.flow), `${key}.${all ? 'observed' : 'noticed'}`);
    try { fs.closeSync(fs.openSync(marker, 'wx', 0o600)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST' || (e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    events.push({ line: text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '), marker });
  }
  return events;
}
