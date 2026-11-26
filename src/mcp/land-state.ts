/** A land helper outlives its MCP and watcher. Never replay a step whose outcome is unknown. */
import { readDirSafe, readJsonFile } from '../utils/atomic-fs.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { awaitDeadLandCustodian } from '../roles/lease.js';
import { workerTreeRootGone } from '../roles/worker-tree.js';
import type { ManagedWorktree } from './managed-worktree.js';
import { settleSealedRun, type Run } from '../workflows/engine.js';
import type { HeaderPass } from '../workflows/header-scan.js';
import type { RunScope } from '../workflows/scope.js';
import { runLock, saveHeader } from '../workflows/store.js';
import type { Job } from './job-contracts.js';
import type { LandEvidenceCase } from './land-evidence.js';
import { jobFiles } from './paths.js';

export const DEFAULT_LAND_TIMEOUT_S = 900;
export const SPEC_CHANGE_REFUSAL = 'Unattended landing would change docs/spec.md';
export interface LandConfig { base: string; gate: string[]; after: string[]; push: boolean; wrapper?: string; timeout_s?: number }
export interface LandTiming { step: string; ms: number; ok: boolean; rerun?: true; skipped?: true; train?: string }
export interface LandRerun {
  step: string; tests: string[]; cases?: LandEvidenceCase[]; output_path?: string; rerun_output_path?: string; rerun_ok?: boolean;
}
export interface LandFlakeCollection {
  state: 'pending' | 'done';
  stage?: 'edit' | 'dispatch';
  error?: string;
  ticket?: string;
  job?: string;
  attempts: number;
  updated_at: string;
}
export interface LandFlow {
  flow: string; job: string; pane: string | null; task: boolean; wt: ManagedWorktree; config: LandConfig;
  ticket_queue?: string;
  protected_spec?: true;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; step: string;
  pid: number; start: string; created_at: string; updated_at: string; step_started_at?: string;
  base_sha?: string; source_sha: string; tested_sha?: string; landed_sha?: string; records_sha?: string; replayed_onto?: string; cleanup_note?: string; error?: string; tail?: string[];
  tested_tree?: string; published_tree?: string; base_moves?: number;
  train?: string; published_sha?: string; single?: true;
  boarded?: { flow: string; pid: number; start: string };
  after_note?: string;
  landed_at?: string;
  // A SIGKILL may land between Git's ref update and the result write. Never retry
  // an unknown fast-forward, even via a new attempt. Keep its candidate for inspection.
  publish_pending?: string;
  workflow?: Run & RunScope;
  repairs?: { step: string; job?: string; outcome: string; started_at?: string; changed_at?: string }[];
  reruns?: (string | LandRerun)[];
  flake_collection?: LandFlakeCollection;
  timings?: LandTiming[];
}
export const isFlowId = (id: unknown): id is string => typeof id === 'string' && /^f[a-f0-9]{16}(?:-[1-9]\d*)?$/.test(id);
export const retryableLand = (f: LandFlow) => !f.landed_sha && !f.publish_pending && (f.state === 'failed' || f.state === 'cancelled');
export const activeLand = (f: LandFlow) => f.state === 'queued' || f.state === 'running';
export const landFile = (home: string, id: string) => join(home, 'flows', `${id}.json`);
export const isLandWait = (step: string) => step === 'main-checkout lease' || step.startsWith('waiting for ');
export function setLandStep(f: LandFlow, step: string, at = new Date().toISOString()) {
  // Changes to the blocking flow's progress are still the same lease wait.
  if (!isLandWait(f.step) || !isLandWait(step)) f.step_started_at = at;
  f.step = step;
}
export function writeLand(home: string, f: LandFlow, create = false) {
  f.step_started_at ??= f.updated_at;
  f.updated_at = new Date().toISOString();
  if (f.workflow && !activeLand(f)) settleSealedRun(f.workflow, 'land', f.state === 'cancelled' ? 'stopped' : f.state === 'completed' ? 'completed' : 'failed',
    f.task || f.ticket_queue ? undefined : landNoticeLine(f));
  saveHeader(home, f, create);
}
function landHeader(home: string, id: string): LandFlow | null {
  try { return readJsonFile(landFile(home, id)) as LandFlow; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export function landOwnerGone(row: LandFlow) {
  const { pid, start } = row.boarded ?? row;
  return activeLand(row) && workerTreeRootGone(pid, start);
}
export function readLand(home: string, id: string, pass?: HeaderPass): LandFlow | null {
  if (!isFlowId(id)) return null;
  const f = pass ? pass.header<LandFlow>(`${id}.json`) : landHeader(home, id);
  if (!f || !landOwnerGone(f)) return f;
  if (!f.workflow) return recordInterruption(home, id); // Legacy receipt and train protocol.
  // Keep synchronous readers compatible. The durable replacement wakes their next
  // pass. Do not emit a terminal result from liveness alone: a live lead can board
  // a passenger at the same time its original helper dies.
  void recoverLand(home, id, f).catch(() => {});
  return f;
}
const recovering = new Map<string, Promise<LandFlow | null>>();
export async function recoverLand(home: string, id: string, f?: LandFlow | null): Promise<LandFlow | null> {
  if (!isFlowId(id)) return null;
  if (f === undefined) f = landHeader(home, id);
  if (!f || !landOwnerGone(f)) return f;
  const key = `${home}\0${id}`;
  let pending = recovering.get(key);
  if (!pending) {
    const initial = f;
    pending = (async () => {
      if (initial.wt?.main_root) {
        const owner = initial.boarded ?? initial;
        const holder = initial.boarded?.flow ?? initial.flow;
        // Recovery must not settle the interruption until the custodian confirms cleanup.
        await awaitDeadLandCustodian({ home, cwd: initial.wt.main_root, holder }, owner);
      }
      return runLock(home, id, () => recordInterruption(home, id));
    })().finally(() => recovering.delete(key));
    recovering.set(key, pending);
  }
  return pending;
}
function recordInterruption(home: string, id: string) {
  const f = landHeader(home, id);
  // A terminal write or a train handoff may have landed during the exit check.
  if (f && landOwnerGone(f)) {
    f.state = 'failed'; f.error = 'Land helper exited; inspect the checkout before retrying. No step was replayed.';
    if (f.workflow && /^repair \d+$/.test(f.step)) recoverRepairReceipt(home, f);
    writeLand(home, f);
  }
  return f;
}
// A killed runner may have dispatched a repair without binding its receipt yet.
// Bind the exact keyed turn as evidence, never send again or resume the land.
function recoverRepairReceipt(home: string, f: LandFlow) {
  const attempt = f.repairs?.at(-1);
  if (!attempt || attempt.job || attempt.outcome !== 'dispatching') return;
  const key = `land:${f.flow}:${f.repairs!.length}`;
  const root = join(home, 'jobs');
  let ids: string[];
  try { ids = readDirSafe(root); } catch { return; }
  for (const id of ids) {
    if (!/^j[a-f0-9]{16}$/.test(id)) continue;
    try {
      const job = readJsonFile(join(root, id, jobFiles.job)) as Job;
      if (job.job === id && (job.land_turn === key || job.request_key === key || job.send_outcomes?.at(-1)?.key === key)) {
        attempt.job = id;
        attempt.outcome = 'dispatched; land helper exited';
        attempt.changed_at = new Date().toISOString();
        break;
      }
    } catch { /* Receipt missing or unreadable; do not infer an outcome. */ }
  }
}
/** Keep previous receipts (and their task/notice IDs) intact. Concurrent callers pick the same next ID. */
export function landAttempt(home: string, job: string, pass?: HeaderPass) {
  const base = `f${job.slice(1)}`, cleanup: string[] = [];
  let attempt = 1, flow = base, prior = readLand(home, flow, pass);
  while (prior && retryableLand(prior)) {
    // A run that got past prepare may have registered its disposable checkout.
    if (prior.boarded?.flow === flow) cleanup.push(`${flow}-train`);
    else if (!prior.boarded && prior.base_sha && prior.step !== 'prepare') cleanup.push(flow);
    flow = `${base}-${++attempt}`;
    const next = readLand(home, flow, pass);
    if (!next) break;
    prior = next;
  }
  return { flow, prior, cleanup };
}
export function completedLandForJob(home: string, job: string, pass?: HeaderPass) {
  const { prior } = landAttempt(home, job, pass);
  return prior?.job === job && prior.state === 'completed' ? prior : null;
}
export async function updateLandFlakeCollection(home: string, flowId: string, collection: LandFlakeCollection): Promise<LandFlow | null> {
  if (!isFlowId(flowId)) return null;
  return runLock(home, flowId, () => {
    const f = landHeader(home, flowId);
    if (!f) return null;
    f.flake_collection = collection;
    saveHeader(home, f, false);
    return f;
  });
}
export function landView(f: LandFlow) {
  const { flow, job, state, step, landed_sha, tested_tree, published_tree, train, published_sha, records_sha, replayed_onto, base_moves, after_note, cleanup_note, repairs, reruns, flake_collection, timings, error, tail } = f;
  return { flow, job, state, step, landed_sha, tested_tree, published_tree, train, published_sha, records_sha, replayed_onto, base_moves, after_note, cleanup_note, repairs, reruns, flake_collection, timings, error, tail };
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
    ...(f.base_moves ? [`Base moves absorbed: ${f.base_moves}`] : []),
    ...(f.after_note ? [`After note: ${one(f.after_note)}`] : []),
    ...(f.cleanup_note ? [`Cleanup note: ${one(f.cleanup_note)}`] : []),
    ...(f.flake_collection?.state === 'pending'
      ? [`Flake collection pending (${f.flake_collection.stage ?? 'retry'}): ${one(f.flake_collection.error ?? 'pending retry')}`]
      : []),
    ...(f.repairs ?? []).map((r, i) => `Repair ${i + 1}: ${one(r.step)} → ${r.job ?? 'dispatch'}: ${one(r.outcome)}`),
    ...(f.reruns ?? []).map(r => {
      if (typeof r === 'string') return `${one(r)} passed on immediate rerun`;
      const passed = r.rerun_ok === true || !r.output_path; // Legacy entries recorded only recovered gates.
      const outcome = passed ? 'passed on immediate rerun' : r.rerun_ok === false ? 'failed on immediate rerun' : 'failed';
      const tests = passed && r.tests.length ? `; flaky tests: ${r.tests.map(one).join(', ')}` : '';
      return `${one(r.step)} ${outcome}${tests}${r.output_path ? `; output: ${r.output_path}` : ''}${r.rerun_output_path ? `; rerun output: ${r.rerun_output_path}` : ''}`;
    }), ...(f.tail ?? [])].join('\n');
}
export const landNoticeLine = (f: LandFlow) => landNotice(f).replace(/\r?\n/g, ' | ');
