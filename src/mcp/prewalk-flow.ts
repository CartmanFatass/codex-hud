import * as fs from 'node:fs';
import { join } from 'node:path';
import type { Role } from '../roles/roster.js';
import { readJsonFile, writeJsonPrivate } from '../utils/atomic-fs.js';
import { procStat } from '../utils/proc.js';
import { driveWorkflow } from '../workflows/driver.js';
import type { Run } from '../workflows/engine.js';
import { loadGraph, type Graph } from '../workflows/graph.js';
import { freezeGraph, runDir, runLock, saveHeader } from '../workflows/store.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { tickJob } from './job-step.js';
import type { Job, ManagedWorktree, PrewalkScoutKind } from './job-contracts.js';
import type { Args } from './dispatch/context.js';
import type { launchPlan } from './dispatch/places.js';
import { jobFiles } from './paths.js';
import { bundled, directory, hudHome } from './store/job-store.js';

export type ScoutSpec = { kind: PrewalkScoutKind; source: 'decision' | 'caller' | 'default'; ask?: string; question: string; includeContext: boolean };
export type ScoutOutcome = Omit<ScoutSpec, 'question' | 'includeContext'> & { id?: string; failure?: string; ms: number };
export type ReservedLaunch = { cwd: string; args: Args; retryInput?: Args; chain: Role; plan: ReturnType<typeof launchPlan>; worktree?: ManagedWorktree };
export type PrewalkInputs = { launch: ReservedLaunch; scouts: ScoutSpec[] };
export interface PrewalkRun extends Run {
  template: 'prewalk'; host: 'mcp' | 'watcher' | 'detached'; pane: string; cwd: string; project_root?: string;
  pid: number; start?: string; stopping?: boolean;
}
export const readPrewalk = (id: string) => readJsonFile(`${runDir(hudHome, id)}.json`) as PrewalkRun;
let template: string;
export function reservePrewalk(job: Job, host: 'mcp' | 'watcher', inputs: PrewalkInputs) {
  template ??= fs.readFileSync(join(bundled, 'workflows/prewalk.toml'), 'utf8');
  const count = inputs.scouts.length, role = job.role;
  // Optional Sonic availability is checked at dispatch; missing scouts yield the legacy brief note.
  const roles = new Map([['sonic', { run: [] }], [role, { run: inputs.launch.chain.run }]]);
  const graph = loadGraph(template, 'toml', { roles, bindings: { count, role, target_brief: join(directory(job.job), jobFiles.brief) }, manifest: {
    role: 'sonic', count, bytes: inputs.scouts.reduce((sum, s) => sum + Buffer.byteLength(s.question), 0), cap: 0, browser: false,
  } });
  const id = job.job;
  freezeGraph(hudHome, id, graph);
  writeJsonPrivate(join(runDir(hudHome, id), 'manifest.json'), inputs, { exclusive: true });
  const header: PrewalkRun = { flow: id, template: 'prewalk', host, pane: jobCallerPane(job), cwd: inputs.launch.cwd,
    project_root: job.project_root, state: 'working', pid: process.pid, start: procStat(process.pid)?.start, epoch: 0,
    steps: Object.fromEntries(Object.keys(graph.steps).map(key => [key, { state: 'waiting' }])), streak: 0, settled: 0, failures: 0, notices: {} };
  saveHeader(hudHome, header); // Publish last: any visible run can be adopted.
}

export async function requestPrewalkStop(id: string) {
  if (!fs.existsSync(`${runDir(hudHome, id)}.json`)) return false;
  return runLock(hudHome, id, () => {
    const run = readPrewalk(id);
    if (run.template !== 'prewalk' || run.state !== 'working' || run.steps.target.state === 'running') return false;
    run.stopping = true; saveHeader(hudHome, run); return true;
  });
}

interface Effects {
  scouts(input: PrewalkInputs, recovering: boolean, stopping: () => boolean): Promise<ScoutOutcome[]>;
  launch(input: ReservedLaunch, outcomes: ScoutOutcome[]): Promise<void>;
  stopped(): void;
  failed(reason: string): void;
  targetReceipt(): Job | null;
}
/** The reserved target job is the public receipt. Batch outputs stay ordered, including
 * failures. Only target dispatch (not the worker's subsequent lifetime) belongs to this run. */
export async function drivePrewalk(id: string, host: PrewalkRun['host'], retiring: AbortSignal, effects: Effects) {
  const dir = runDir(hudHome, id), index = join(dir, 'index.json');
  let inputs: PrewalkInputs, recovering = false;
  await driveWorkflow(hudHome, id, {
    read: () => readPrewalk(id), header: run => run, retiring,
    save(run) {
      // A failed dispatch uses its existing job receipt, not a second public hand-back.
      if (run.state === 'paused') {
        if (effects.targetReceipt()?.dispatch_exit_code == null) effects.failed(run.reason ?? 'prewalk failed');
        run.state = 'failed'; delete run.handback;
      }
      run.notices = {}; saveHeader(hudHome, run); // Only the target job notifies.
    },
    open(run) {
      inputs = readJsonFile(join(dir, 'manifest.json')) as PrewalkInputs;
      recovering = run.steps.scouts.state === 'running';
      run.host = host;
      return readJsonFile(join(dir, 'graph.json')) as Graph;
    },
    tick(run, key, step) {
      const collectingOrphans = recovering && step.kind === 'batch' && !fs.existsSync(index);
      if (run.stopping && !collectingOrphans) {
        effects.stopped(); run.state = 'stopped';
        for (const cursor of Object.values(run.steps)) if (cursor.state === 'waiting') cursor.state = 'cancelled';
        return { state: 'cancelled', changed: true };
      }
      if (step.kind === 'batch') {
        if (fs.existsSync(index)) {
          const outputs = readJsonFile(index) as Record<string, ScoutOutcome[]>;
          const failed = outputs[key].length > 0 && outputs[key].every(o => o.failure);
          return failed ? { state: 'failed', reason: outputs[key][0].failure } : { state: 'done' };
        }
        return { state: 'running', effect: async () => {
          const outcomes = await effects.scouts(inputs, recovering, () => !!readPrewalk(id).stopping);
          // A retired wait isn't a result. The next host rebinds the keyed scouts.
          if (!retiring.aborted) writeJsonPrivate(index, { [key]: outcomes });
          return 0;
        } };
      }
      if (step.kind !== 'job') throw Error(`unsupported prewalk executor ${step.kind}`);
      const target = effects.targetReceipt();
      if (!target) throw Error('reserved target receipt missing');
      return tickJob(step, target, ref => (readJsonFile(index) as Record<string, ScoutOutcome[]>)[ref], from => effects.launch(inputs.launch, from));
    },
    active: run => run.state === 'working', watches: () => [], errorLine: run => run.reason ?? 'prewalk failed',
  });
}
