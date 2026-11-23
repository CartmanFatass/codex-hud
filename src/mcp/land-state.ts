/** A land helper outlives its MCP and watcher. Never replay a step whose outcome is unknown. */
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { sharedRoot } from '../roles/projects.js';
import { workerTreeRootGone } from '../roles/worker-tree.js';
import type { ManagedWorktree } from './managed-worktree.js';

export const DEFAULT_LAND_TIMEOUT_S = 900;
export interface LandConfig { base: string; gate: string[]; after: string[]; push: boolean; wrapper?: string; timeout_s?: number }
export interface LandTiming { step: string; ms: number; ok: boolean; rerun?: true; skipped?: true; train?: string }
export interface LandRerun {
  step: string; tests: string[]; output_path?: string; rerun_output_path?: string; rerun_ok?: boolean;
}
export interface LandFlow {
  flow: string; job: string; pane: string | null; task: boolean; wt: ManagedWorktree; config: LandConfig;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; step: string;
  pid: number; start: string; created_at: string; updated_at: string;
  base_sha?: string; source_sha: string; tested_sha?: string; landed_sha?: string; records_sha?: string; replayed_onto?: string; cleanup_note?: string; error?: string; tail?: string[];
  tested_tree?: string; published_tree?: string;
  train?: string; published_sha?: string; single?: true;
  boarded?: { flow: string; pid: number; start: string };
  after_note?: string;
  landed_at?: string;
  repairs?: { step: string; job?: string; outcome: string }[];
  reruns?: (string | LandRerun)[];
  timings?: LandTiming[];
}
export const isFlowId = (id: unknown): id is string => typeof id === 'string' && /^f[a-f0-9]{16}(?:-[1-9]\d*)?$/.test(id);
export const retryableLand = (f: LandFlow) => !f.landed_sha && (f.state === 'failed' || f.state === 'cancelled');
export const activeLand = (f: LandFlow) => f.state === 'queued' || f.state === 'running';
export const landFile = (home: string, id: string) => join(home, 'flows', `${id}.json`);
export function writeLand(home: string, f: LandFlow, create = false) {
  f.updated_at = new Date().toISOString();
  writeJsonPrivate(landFile(home, f.flow), f, { mkdir: false, exclusive: create });
}
export function readLand(home: string, id: string): LandFlow | null {
  if (!isFlowId(id)) return null;
  const path = landFile(home, id);
  let f: LandFlow;
  try { f = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  const helperGone = (row: LandFlow) => {
    const { pid, start } = row.boarded ?? row;
    return activeLand(row) && workerTreeRootGone(pid, start);
  };
  if (helperGone(f)) {
    // A terminal write or a train handoff may have landed during the exit check.
    f = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (helperGone(f)) {
      f.state = 'failed'; f.error = 'Land helper exited; inspect the checkout before retrying. No step was replayed.';
      writeLand(home, f);
    }
  }
  return f;
}
/** Keep previous receipts (and their task/notice IDs) intact. Concurrent callers pick the same next ID. */
export function landAttempt(home: string, job: string) {
  const base = `f${job.slice(1)}`, cleanup: string[] = [];
  let attempt = 1, flow = base, prior = readLand(home, flow);
  while (prior && retryableLand(prior)) {
    // A run that got past prepare may have registered its disposable checkout.
    if (prior.boarded?.flow === flow) cleanup.push(`${flow}-train`);
    else if (!prior.boarded && prior.base_sha && prior.step !== 'prepare') cleanup.push(flow);
    flow = `${base}-${++attempt}`;
    const next = readLand(home, flow);
    if (!next) break;
    prior = next;
  }
  return { flow, prior, cleanup };
}
export function landView(f: LandFlow) {
  const { flow, job, state, step, landed_sha, tested_tree, published_tree, train, published_sha, records_sha, replayed_onto, after_note, cleanup_note, repairs, reruns, timings, error, tail } = f;
  return { flow, job, state, step, landed_sha, tested_tree, published_tree, train, published_sha, records_sha, replayed_onto, after_note, cleanup_note, repairs, reruns, timings, error, tail };
}
const one = (text: string) => text.replace(/\s+/g, ' ').trim();
export function landOutcome(f: LandFlow) {
  const failedRepair = f.state === 'failed' && /^repair \d+$/.test(f.step) ? f.repairs?.at(-1) : undefined;
  const step = failedRepair?.step ?? f.step;
  const gate = f.state === 'failed' ? f.reruns?.filter(r => typeof r !== 'string' && r.step === step).at(-1) : undefined;
  const failedTests = typeof gate === 'object' && gate.rerun_ok !== true && gate.tests.length
    ? `; failing tests: ${gate.tests.slice(0, 3).map(one).join(', ')}` : '';
  return `${f.state}: ${one(step)}${failedRepair ? ` (${f.step})` : ''}${f.landed_sha ? ` ${f.landed_sha}` : ''}${f.error ? `: ${one(f.error)}` : ''}${failedTests}`;
}
export function landNotice(f: LandFlow) {
  return [`${f.flow} (land ${f.job}) — ${landOutcome(f)}`,
    ...(f.replayed_onto ? [`Replayed onto ${one(f.replayed_onto)}${f.base_sha ? ` (base moved from ${one(f.base_sha)})` : ''}`] : []),
    ...(f.after_note ? [`After note: ${one(f.after_note)}`] : []),
    ...(f.cleanup_note ? [`Cleanup note: ${one(f.cleanup_note)}`] : []),
    ...(f.repairs ?? []).map((r, i) => `Repair ${i + 1}: ${one(r.step)} → ${r.job ?? 'dispatch'}: ${one(r.outcome)}`),
    ...(f.reruns ?? []).map(r => {
      if (typeof r === 'string') return `${one(r)} passed on immediate rerun`;
      const passed = r.rerun_ok === true || !r.output_path; // Legacy entries recorded only recovered gates.
      const outcome = passed ? 'passed on immediate rerun' : r.rerun_ok === false ? 'failed on immediate rerun' : 'failed';
      const tests = passed && r.tests.length ? `; flaky tests: ${r.tests.map(one).join(', ')}` : '';
      return `${one(r.step)} ${outcome}${tests}${r.output_path ? `; output: ${r.output_path}` : ''}${r.rerun_output_path ? `; rerun output: ${r.rerun_output_path}` : ''}`;
    }), ...(f.tail ?? [])].join('\n');
}
/** Native/watch and MCP changes share one terminal notice claim for the calling pane. */
export function landEvents(home: string, pane: string | null, all = false, cwd = process.cwd(), modCatchup = false) {
  const dir = join(home, 'flows');
  const lines: string[] = [];
  let pending = false;
  let files: string[];
  try { files = fs.readdirSync(dir); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { lines, pending }; throw e; }
  for (const file of files) {
    const sidecar = /^(.*)\.json\.gate-[1-9]\d*(?:-rerun)?\.log$/.exec(file);
    if (sidecar && isFlowId(sidecar[1])) {
      // Keep excerpts as long as the receipt exists; only sweep orphaned sidecars.
      try {
        if (!fs.lstatSync(landFile(home, sidecar[1]), { throwIfNoEntry: false })) fs.unlinkSync(join(dir, file));
      } catch { /* Retry at the next scan. */ }
      continue;
    }
    const id = file.replace(/\.json$/, '');
    if (!file.endsWith('.json') || !isFlowId(id)) continue;
    const marker = `${landFile(home, id)}.${all ? 'observed' : 'noticed'}`;
    if (fs.existsSync(marker)) continue;
    const f = readLand(home, id);
    if (!f || f.task || (!all && f.pane !== pane)) continue;
    if (!all && f.wt.main_root !== cwd && f.wt.main_root !== sharedRoot(cwd)) continue;
    if (activeLand(f)) { pending = true; continue; }
    try { fs.closeSync(fs.openSync(marker, 'wx', 0o600)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; throw e; }
    if (modCatchup && f.state !== 'failed') continue;
    // Queued transports (and hud watch) use one physical line per event.
    lines.push(landNotice(f).replace(/\r?\n/g, ' | ').replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
  }
  return { lines, pending };
}
