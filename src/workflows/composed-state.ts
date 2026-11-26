import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runGrantStore, type OwnerGrant } from '../roles/run-grant.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import type { Cursor, Run } from './engine.js';
import type { Graph } from './graph.js';
import type { RunScope } from './scope.js';
import { runDir, runLock } from './store.js';
import type { Job } from '../mcp/job-contracts.js';

export const isComposedId = (id: unknown): id is `w${string}` => typeof id === 'string' && /^w[a-f0-9]{16}$/.test(id);
export const workflowGrants = runGrantStore('workflow-grant');
export type CheckResult = { exit_code: number | null; tail: string; error?: string };
export type Item = { job?: string; state: 'waiting' | 'running' | 'done' | 'failed'; attempt: number; reason?: string };
export type ComposedCursor = Cursor & { attempt?: number; job?: string; land?: string; items?: Item[];
  check?: CheckResult; repairs?: number; repair_pending?: boolean; lead_closed?: true; decision_reason?: string };
export type Handback = { request_id: string; step: string; ask: string; choices: string[]; refs: string[] };
export interface ComposedRun extends Run, RunScope {
  template: 'composed'; cwd: string; hash: string; created_at: string; dispatcher?: Job['dispatcher']; workspace?: string; pid?: number; start?: string;
  cost: Graph['cost']; grant?: OwnerGrant; input_admitted?: true;
  steps: Record<string, ComposedCursor>; answers: Record<string, string>;
  handback?: Run['handback'] & Partial<Handback>;
}
export const readComposed = (home: string, id: string): ComposedRun | undefined => {
  if (!isComposedId(id)) return;
  try {
    const run = readJsonFile(`${runDir(home, id)}.json`) as ComposedRun;
    if (run?.flow === id && run.template === 'composed') return run;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
};
export type Scale = Record<string, { role: string; count: number; input_bytes: number; max_parallel?: number }>;
export type ComposedGraph = Graph & { scale: Scale };
export const hashComposedGraph = (cwd: string, graph: ComposedGraph) => createHash('sha256').update(JSON.stringify([cwd, graph])).digest('hex');
export const readComposedGraph = (home: string, id: string) => readJsonFile(join(runDir(home, id), 'graph.json')) as ComposedGraph;
export const validPlanHash = (hash: unknown) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);
export const proposalFresh = (run: ComposedRun) => Date.now() - Date.parse(run.created_at) < 30 * 60_000;

/** Local owner CLI only; no issue operation is exposed through MCP. */
export async function allowWorkflow(home: string, id: string, hash: string) {
  if (!isComposedId(id) || !validPlanHash(hash)) return false;
  return runLock(home, id, async () => {
    const run = readComposed(home, id);
    if (!run || run.state !== 'proposed' || run.cost !== 'costly' || run.hash !== hash || !proposalFresh(run) || hash !== hashComposedGraph(run.cwd, readComposedGraph(home, id))) return false;
    await workflowGrants.issue(home, 'cli', { run: id, hash });
    return true;
  });
}
