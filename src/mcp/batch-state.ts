/** One private manifest and one authoritative item/result index per fixed batch. The small
 * adjacent receipt wakes existing flow watchers without scanning every item on each job event. */
import { pauseRun, type Cursor } from '../workflows/engine.js';
import type { RunScope } from '../workflows/scope.js';
import type { Breaker } from '../workflows/graph.js';
import { failureReason, failuresByReason, settlement } from '../workflows/policy.js';
import { runDir as batchDir, runLock as batchLock, saveHeader } from '../workflows/store.js';
export { batchDir, batchLock, failuresByReason };
export { noticeEvents as batchEvents } from '../workflows/store.js';
import { join } from 'node:path';
import { readDirSafe, readJsonFile, writeJsonPrivate } from '../utils/atomic-fs.js';
import type { Job, JobRoute } from './job-contracts.js';

export const isBatchId = (id: unknown): id is string => typeof id === 'string' && /^b[a-f0-9]{16}$/.test(id);
export const batchIds = (home: string) => readDirSafe(join(home, 'flows')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(isBatchId);
export interface BatchScale {
  role: string; count: number; input_bytes: { max: number; median: number; total: number };
  presets: (string | null)[]; cap: number; max_parallel: number;
}
export interface Batch extends RunScope {
  flow: string; cwd: string; dispatcher?: Job['dispatcher']; key: string; created_at: number; updated_at?: number; pilot_changed_at?: number; pool_changed_at?: number;
  state: 'working' | 'paused' | 'stopped' | 'completed'; scale: BatchScale; pid?: number; start?: string;
  template?: 'batch'; host?: 'detached'; cost?: 'cheap' | 'costly'; cost_reasons?: string[]; steps?: Record<string, Cursor>;
  handback?: { step: string; choices: string[] };
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
function recount(b: Batch, items: ItemResult[]) {
  b.totals = { waiting: 0, running: 0, done: 0, failed: 0 };
  for (const i of items) b.totals[i.state] = (b.totals[i.state] ?? 0) + 1;
}
const groupsLine = (items: ItemResult[]) => failuresByReason(items).map(g => `${g.reason} ×${g.count} (${g.example})`).join('; ');
export const totalsLine = (b: Batch) => Object.entries(b.totals).map(([state,n]) => `${n} ${state}`).join(', ');
export function settleItem(b: Batch, items: ItemResult[], i: ItemResult, failure?: string, breaker: Breaker = 'rate') {
  i.state = failure ? 'failed' : 'done'; i.reason = failure && failureReason(failure); delete i.stall;
  const now = Date.now();
  b.updated_at = now;
  if (i.pilot) b.pilot_changed_at = now;
  else b.pool_changed_at = now;
  if (b.state !== 'working') return;
  const count = failure ? failuresByReason(items).find(g => g.reason === i.reason)?.count : 0;
  const action = settlement(b, breaker, i.reason, count, i.pilot);
  if (action === 'pause') {
    pauseRun(b, 'items', i.pilot ? 'pilot failed' : 'failure circuit breaker');
    recount(b, items);
    b.notices[`pause-${b.epoch}`] = `${b.flow} batch paused (${b.reason}): ${totalsLine(b)}. Failures: ${groupsLine(items)}. hud_create batch=${b.flow} action=resume, retry_failed or stop`;
  } else if (action === 'failure') {
    b.notices[`failure-${b.epoch}-${i.item}`] = `${b.flow} item ${i.item} (${i.job ?? 'dispatch'}): ${i.reason}`;
  }
}
export function saveBatch(home: string, b: Batch, items: ItemResult[]) {
  recount(b, items);
  b.updated_at = Date.now();
  if (!b.steps && b.state === 'working' && !b.totals.waiting && !b.totals.running) b.state = 'completed'; // legacy index
  if (b.state === 'stopped' && !b.totals.running && b.steps?.items) b.steps.items.state = 'cancelled';
  if (b.state === 'completed' || (b.state === 'stopped' && !b.totals.running)) b.notices[`end-${b.epoch}`] = `${b.flow} batch: ${totalsLine(b)}${b.totals.failed ? `; failures: ${groupsLine(items)}` : ''} — final; list unread reports: hud_read view:compact`;
  writeJsonPrivate(join(batchDir(home, b.flow), 'index.json'), { batch: b, items });
  saveHeader(home, b);
}
export const batchActive = (b: Batch) => b.state === 'working' || b.totals.running > 0;
