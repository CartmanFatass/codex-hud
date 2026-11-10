/** Panel-owned display facts only; never execution, wait or acceptance authority. */
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getHudDisplayHome } from '../hud-home.js';
import { processState, sameStamp } from '../core/run/process.js';
import type { ProcessStamp } from '../core/types/supervision.js';
import { readJson, saveJson, safePath, validStamp } from '../integrations/panel/receipt.js';
import { parseRosterRoot, formatRosterRoot } from './selection.js';
import { projectWorkCard, type WorkState } from '../collectors/work-card.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';

export const ROLE_SUMMARY_TTL_MS = 60_000;
export const ROLE_SUMMARY_HEARTBEAT_MS = 20_000;
export const WORK_STATES: readonly WorkState[] = ['needs-you', 'in-progress', 'awaiting-acceptance', 'stalled', 'done'];
export type RoleCounts = Record<WorkState, number>;
export interface RoleSummary {
  schema: 1;
  root: string;
  producer: { generation: string; process: ProcessStamp };
  observedAt: number;
  coverage: 'complete' | 'partial' | 'unavailable';
  counts: RoleCounts;
  sources: readonly { id: string; revision: string; at: number | null }[];
}
export type RoleSummaryRead = { state: 'available'; summary: RoleSummary } | { state: 'unavailable'; counts: null };
const unavailable = (): RoleSummaryRead => ({ state: 'unavailable', counts: null });
// At most 256 UTF-8 bytes per stamp even for supplementary-plane characters.
const safeText = (s: string) =>
  Array.from(s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '))
    .slice(0, 64)
    .join('');
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
function exactRoot(root: string): string {
  if (formatRosterRoot(parseRosterRoot(root)) !== root) throw new Error('summary_root_invalid');
  return root;
}
export function roleSummaryPath(env: NodeJS.ProcessEnv, root: string): string {
  exactRoot(root);
  return join(getHudDisplayHome(env), 'role-summary', createHash('sha256').update(root).digest('hex') + '.json');
}
function privateDirectory(file: string): void {
  const dir = dirname(file);
  safePath(dir);
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error('summary_directory_unsafe');
}
export function decodeRoleSummary(raw: unknown): RoleSummary {
  if (!raw || typeof raw !== 'object') throw new Error('summary_invalid');
  const s = raw as RoleSummary;
  if (
    s.schema !== 1 ||
    typeof s.root !== 'string' ||
    !exactRoot(s.root) ||
    !s.producer ||
    typeof s.producer.generation !== 'string' ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(s.producer.generation) ||
    !validStamp(s.producer.process) ||
    !integer(s.observedAt) ||
    !['complete', 'partial', 'unavailable'].includes(s.coverage) ||
    !s.counts ||
    !WORK_STATES.every((k) => integer(s.counts[k]) && s.counts[k] <= 10000) ||
    !Array.isArray(s.sources) ||
    s.sources.length > 16 ||
    !s.sources.every(
      (v) =>
        v &&
        typeof v.id === 'string' &&
        v.id.length <= 256 &&
        typeof v.revision === 'string' &&
        v.revision.length <= 256 &&
        (v.at === null || integer(v.at))
    )
  )
    throw new Error('summary_invalid');
  return { ...s, sources: s.sources.map((v) => ({ id: safeText(v.id), revision: safeText(v.revision), at: v.at })) };
}
/** One exact bounded file read, no discovery, launch or network. Cooperative ceiling includes stamp check. */
export function readRoleSummary(
  env: NodeJS.ProcessEnv,
  root: string,
  options: { nowMs?: number; budgetMs?: number; clock?: () => number } = {}
): RoleSummaryRead {
  const clock = options.clock ?? (() => performance.now());
  const start = clock();
  const budget = Math.min(20, options.budgetMs ?? 20);
  try {
    if (!Number.isFinite(budget) || budget <= 0) return unavailable();
    const file = roleSummaryPath(env, root);
    privateDirectory(file);
    const summary = decodeRoleSummary(readJson(file));
    const now = options.nowMs ?? Date.now();
    if (
      !integer(now) ||
      summary.root !== root ||
      summary.coverage === 'unavailable' ||
      summary.observedAt > now ||
      now - summary.observedAt >= ROLE_SUMMARY_TTL_MS ||
      clock() - start >= budget ||
      processState(summary.producer.process) !== 'alive' ||
      clock() - start >= budget
    )
      return unavailable();
    return { state: 'available', summary };
  } catch {
    return unavailable();
  }
}
/** Use the exact workboard also passed to renderMonitor; work-state precedence lives in P2 alone. */
export function summarizeWorkboard(
  root: string,
  producer: RoleSummary['producer'],
  board: WorkboardSnapshot,
  nowMs: number,
  stallMinutes: number
): RoleSummary {
  const counts = Object.fromEntries(WORK_STATES.map((k) => [k, 0])) as RoleCounts;
  for (const worker of board.workers) counts[projectWorkCard(worker, nowMs, stallMinutes).state]++;
  const sources = new Map<string, RoleSummary['sources'][number]>();
  for (const lane of board.lanes)
    for (const evidence of [...lane.evidence, ...lane.workers.flatMap((w) => w.evidence)]) {
      const id = safeText(evidence.sourceId);
      if (sources.size < 15) sources.set(id, { id, revision: safeText(evidence.revision), at: evidence.at });
    }
  sources.set('workboard', { id: 'workboard', revision: safeText(board.revision), at: null });
  return decodeRoleSummary({
    schema: 1,
    root,
    producer,
    observedAt: nowMs,
    coverage: board.coverage.incomplete ? (board.workers.length ? 'partial' : 'unavailable') : 'complete',
    counts,
    sources: [...sources.values()],
  });
}
export class RoleSummaryPublisher {
  private lastContent = '';
  private lastAt = -Infinity;
  private owned?: { file: string; dev: number; ino: number };
  private closed = false;
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    readonly producer: RoleSummary['producer']
  ) {}
  publish(root: string, board: WorkboardSnapshot, nowMs: number, stallMinutes: number): boolean {
    if (this.closed) return false;
    try {
      const summary = summarizeWorkboard(root, this.producer, board, nowMs, stallMinutes);
      const content = JSON.stringify({ ...summary, observedAt: 0 });
      if (content === this.lastContent && nowMs - this.lastAt < ROLE_SUMMARY_HEARTBEAT_MS) return false;
      const file = roleSummaryPath(this.env, root);
      if (this.owned?.file !== file) this.clear();
      safePath(file);
      fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      privateDirectory(file);
      saveJson(file, summary);
      const stat = fs.lstatSync(file);
      this.owned = { file, dev: stat.dev, ino: stat.ino };
      this.lastContent = content;
      this.lastAt = nowMs;
      return true;
    } catch {
      return false;
    }
  }
  private clear(): void {
    const own = this.owned;
    this.owned = undefined;
    if (!own) return;
    try {
      safePath(own.file);
      const current = decodeRoleSummary(readJson(own.file));
      const stat = fs.lstatSync(own.file);
      if (
        stat.dev === own.dev &&
        stat.ino === own.ino &&
        current.producer.generation === this.producer.generation &&
        sameStamp(current.producer.process, this.producer.process)
      )
        fs.unlinkSync(own.file);
    } catch {
      /* Replacement producers and unavailable paths are not ours to remove. */
    }
  }
  invalidate(): void {
    this.clear();
    this.lastContent = '';
    this.lastAt = -Infinity;
  }
  dispose(): void {
    this.closed = true;
    this.invalidate();
  }
}
export function roleSummaryGeneration(): string {
  return randomUUID();
}
