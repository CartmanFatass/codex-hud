import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Role } from '../roles/roster.js';
import type { CouncilGrant } from '../roles/council-grant.js';
import { readJsonFile, writeJsonPrivate } from '../utils/atomic-fs.js';
import type { Run } from '../workflows/engine.js';
import { loadGraph } from '../workflows/graph.js';
import type { RunScope } from '../workflows/scope.js';
import { freezeGraph, runDir, runLock, saveHeader } from '../workflows/store.js';
import type { CouncilPlan } from './dispatch/council.js';
import { BUNDLED_ROOT, jobFiles } from './paths.js';
import type { Job } from './job-contracts.js';

export interface CouncilRun extends Run, RunScope {
  template: 'council'; host: 'detached'; cwd: string; pid?: number; start?: string;
  intents: string[]; input_unknown?: true; cost: 'costly' | 'cheap'; cost_reasons: string[];
}
export type CouncilManifest = { plan: CouncilPlan; grant: CouncilGrant; composed?: true };
export const readCouncilRun = (home: string, id: string) => readJsonFile(`${runDir(home, id)}.json`) as CouncilRun;

export async function createCouncilRun(home: string, parent: Job, pane: string, roles: Map<string, Role>, manifest: CouncilManifest) {
  const flow = parent.job, dir = runDir(home, flow);
  const graph = loadGraph(readFileSync(join(BUNDLED_ROOT, 'workflows/council.toml'), 'utf8'), 'toml', {
    roles, bindings: { brief_file: jobFiles.brief },
  });
  const run: CouncilRun = { flow, template: 'council', host: 'detached', cwd: parent.cwd, project_root: parent.project_root, pane,
    cost: graph.cost, cost_reasons: graph.cost_reasons, state: 'working', epoch: 0, settled: 0, streak: 0, failures: 0,
    steps: Object.fromEntries(Object.keys(graph.steps).map(id => [id, { state: 'waiting' }])), intents: [], notices: {} };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  freezeGraph(home, flow, graph);
  writeJsonPrivate(join(dir, 'manifest.json'), manifest);
  await runLock(home, flow, () => saveHeader(home, run));
  return run;
}
