/** Read-only projection of existing land receipts; never use readLand (which can write recovery state). */
import { join } from 'node:path';
import { readJsonBounded } from '../utils/atomic-fs.js';
import type { LandFlow } from '../mcp/land-state.js';
import { epoch, record, text } from './job-usage.js';

export type JobLand = {
  attempts: number; reruns: number; repairs: number; state: LandFlow['state']; sha?: string; landed_at?: string; updated_at?: string;
};
export type JobFlow = {
  job: string; attempt: number; project?: string; state: JobLand['state']; sha?: string; landed_at?: string;
  updated_at?: string; reruns: number; repairs: number; flaky: string[];
};
const states = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const sha = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v) ? v : undefined;
export function readJobFlow(home: string, name: string): JobFlow {
  const id = /^f([0-9a-f]{16})(?:-([1-9]\d*))?\.json$/.exec(name);
  if (!id) throw Error('invalid_flow_name');
  const f = record(readJsonBounded(join(home, 'flows', name), 128 * 1024));
  const job = `j${id[1]}`, state = text(f.state), attempt = Number(id[2] ?? 1);
  if (job !== f.job || !state || !states.has(state) || !Number.isSafeInteger(attempt)) throw Error('invalid_flow');
  const reruns: unknown[] = Array.isArray(f.reruns) ? f.reruns : [];
  return { job, attempt, project: text(record(f.wt).main_root), state: state as JobLand['state'], sha: sha(f.landed_sha),
    landed_at: text(f.landed_at) ?? text(f.updated_at), updated_at: text(f.updated_at), reruns: reruns.filter(raw => {
      const r = record(raw);
      return typeof raw === 'string' || typeof r.rerun_ok === 'boolean' || (Array.isArray(r.tests) && !r.output_path);
    }).length,
    repairs: Array.isArray(f.repairs) ? f.repairs.length : 0,
    flaky: reruns.flatMap(raw => {
      const r = record(raw);
      return (r.rerun_ok === true || (r.rerun_ok === undefined && !r.output_path)) && Array.isArray(r.tests)
        ? r.tests.flatMap(test => typeof test === 'string' && test ? [test.slice(0, 240)] : []) : [];
    }),
  };
}

export function jobLand(flows: readonly JobFlow[]): JobLand | undefined {
  if (!flows.length) return;
  const latest = flows.reduce((a, b) => b.attempt > a.attempt ? b : a);
  // If an earlier receipt is absent, its counts are not zero.
  if (flows.length !== latest.attempt) return;
  const landed = flows.find(f => f.sha);
  return { attempts: flows.length, state: latest.state, reruns: flows.reduce((n, f) => n + f.reruns, 0),
    repairs: flows.reduce((n, f) => n + f.repairs, 0), sha: landed?.sha, landed_at: landed?.landed_at, updated_at: latest.updated_at };
}

export function archiveJobLand(home: string, job: string): JobLand | undefined {
  if (!/^j[0-9a-f]{16}$/.test(job)) return;
  const flows: JobFlow[] = [], base = `f${job.slice(1)}`;
  // Normal flow IDs are contiguous. Bound retries and omit the aggregate if
  // we cannot see the terminal attempt, rather than preserving a partial sum.
  for (let n = 1; n <= 64; n++) {
    try {
      const flow = readJobFlow(home, `${base}${n === 1 ? '' : `-${n}`}.json`);
      flows.push(flow);
      if (flow.sha || !['failed', 'cancelled'].includes(flow.state)) return jobLand(flows);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? jobLand(flows) : undefined;
    }
  }
}

export const landedIn = (land: { sha?: string; landed_at?: string }, since: number, now: number) => {
  const at = epoch(land.landed_at);
  return !!land.sha && at !== undefined && at >= since && at <= now;
};
