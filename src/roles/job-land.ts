/** Read-only projection of existing land receipts; never use readLand (which can write recovery state). */
import { join } from 'node:path';
import { readJsonBounded } from '../utils/atomic-fs.js';
import type { LandFlow } from '../mcp/land-state.js';
import { epoch, record, text } from './job-usage.js';

type RepairDetail = { attempt: number; step_kind: 'conflict' | 'gate'; step: string; outcome: string };
type RerunDetail = { attempt: number; step: string; passed_unchanged: boolean; tests?: string[] };
type LandDetails = { repair_details?: RepairDetail[]; rerun_details?: RerunDetail[] };
type LandAttempt = {
  attempt: number; state: LandFlow['state']; created_at?: string; updated_at?: string;
  sha?: string; landed_at?: string; reruns: number; repairs: number;
};
export type JobLand = Omit<LandAttempt, 'attempt'> & LandDetails & {
  attempts: number; attempt_details?: LandAttempt[];
};
export type JobFlow = LandAttempt & LandDetails & { job: string; project?: string; flaky: string[] };
const states = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const sha = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v) ? v : undefined;
export function readJobFlow(home: string, name: string, details = false): JobFlow {
  const id = /^f([0-9a-f]{16})(?:-([1-9]\d*))?\.json$/.exec(name);
  if (!id) throw Error('invalid_flow_name');
  const f = record(readJsonBounded(join(home, 'flows', name), 128 * 1024));
  const job = `j${id[1]}`, state = text(f.state), attempt = Number(id[2] ?? 1);
  if (job !== f.job || !state || !states.has(state) || !Number.isSafeInteger(attempt)) throw Error('invalid_flow');
  const reruns: unknown[] = Array.isArray(f.reruns) ? f.reruns : [];
  const repairs: unknown[] = Array.isArray(f.repairs) ? f.repairs : [];
  const flakyTests = (r: Record<string, unknown>) =>
    (r.rerun_ok === true || (r.rerun_ok === undefined && !r.output_path)) && Array.isArray(r.tests)
      ? r.tests.flatMap(test => typeof test === 'string' && test ? [test.slice(0, 240)] : []) : [];
  // Keep the legacy date fallback for stats, but retain only measured times in attempt details.
  return { job, attempt, project: text(record(f.wt).main_root), state: state as JobLand['state'], sha: sha(f.landed_sha),
    created_at: text(f.created_at), landed_at: text(f.landed_at) ?? (details ? undefined : text(f.updated_at)),
    updated_at: text(f.updated_at), reruns: reruns.filter(raw => {
      const r = record(raw);
      return typeof raw === 'string' || typeof r.rerun_ok === 'boolean' || (Array.isArray(r.tests) && !r.output_path);
    }).length,
    repairs: repairs.length,
    ...(details && {
      repair_details: repairs.flatMap((raw): RepairDetail[] => {
        const r = record(raw), step = text(r.step), outcome = text(r.outcome);
        return step && outcome ? [{ attempt, step_kind: step === 'cherry-pick' ? 'conflict' : 'gate', step, outcome }] : [];
      }),
      rerun_details: reruns.flatMap((raw): RerunDetail[] => {
        const r = record(raw), legacy = typeof raw === 'string' || (Array.isArray(r.tests) && !r.output_path);
        const step = text(raw) ?? text(r.step);
        const passed = typeof r.rerun_ok === 'boolean' ? r.rerun_ok : legacy ? true : undefined;
        const tests = flakyTests(r);
        return step && passed !== undefined ? [{ attempt, step, passed_unchanged: passed, ...(tests.length && { tests }) }] : [];
      }),
    }),
    flaky: reruns.flatMap(raw => flakyTests(record(raw))),
  };
}

export function jobLand(flows: readonly JobFlow[], details = false): JobLand | undefined {
  if (!flows.length) return;
  const latest = flows.reduce((a, b) => b.attempt > a.attempt ? b : a);
  // If an earlier receipt is absent, its counts are not zero.
  if (flows.length !== latest.attempt) return;
  const landed = flows.find(f => f.sha);
  const repair_details = flows.flatMap(f => f.repair_details ?? []), rerun_details = flows.flatMap(f => f.rerun_details ?? []);
  return { attempts: flows.length, state: latest.state, reruns: flows.reduce((n, f) => n + f.reruns, 0),
    repairs: flows.reduce((n, f) => n + f.repairs, 0), sha: landed?.sha, landed_at: landed?.landed_at ?? landed?.updated_at,
    created_at: (landed ?? latest).created_at, updated_at: latest.updated_at,
    ...(details && { attempt_details: flows.map(({ attempt, state, created_at, updated_at, sha, landed_at, reruns, repairs }) =>
      ({ attempt, state, created_at, updated_at, sha, landed_at, reruns, repairs })) }),
    ...(repair_details.length && { repair_details }), ...(rerun_details.length && { rerun_details }) };
}

export function archiveJobLand(home: string, job: string): JobLand | undefined {
  if (!/^j[0-9a-f]{16}$/.test(job)) return;
  const flows: JobFlow[] = [], base = `f${job.slice(1)}`;
  // Normal flow IDs are contiguous. Bound retries and omit the aggregate if
  // we cannot see the terminal attempt, rather than preserving a partial sum.
  for (let n = 1; n <= 64; n++) {
    try {
      const flow = readJobFlow(home, `${base}${n === 1 ? '' : `-${n}`}.json`, true);
      flows.push(flow);
      if (flow.sha || !['failed', 'cancelled'].includes(flow.state)) return jobLand(flows, true);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? jobLand(flows, true) : undefined;
    }
  }
}

export const landedIn = (land: { sha?: string; landed_at?: string }, since: number, now: number) => {
  const at = epoch(land.landed_at);
  return !!land.sha && at !== undefined && at >= since && at <= now;
};
