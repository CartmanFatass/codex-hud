import { join } from 'node:path';
import { readJsonFile } from '../utils/atomic-fs.js';
import { driveWorkflow } from '../workflows/driver.js';
import { sealedEffect } from '../workflows/engine.js';
import type { Graph } from '../workflows/graph.js';
import { runDir } from '../workflows/store.js';
import { publishWorkflowLifetime } from '../workflows/wake.js';
import { executeLand } from './land-runner.js';
import { activeLand, readLand, writeLand } from './land-state.js';

export interface LandLaunch { home: string; flow: string; cleanup: string[] }
export async function runLandWorkflow({ home, flow, cleanup }: LandLaunch) {
  const initial = readLand(home, flow);
  // This is not a resume entry point. A dead owner is reconciled from the existing
  // header; a watcher or duplicate runner cannot admit its land again.
  if (!initial?.workflow || !activeLand(initial) || initial.pid !== process.pid) return;
  await publishWorkflowLifetime(join(home, 'jobs', initial.job));
  await driveWorkflow(home, flow, {
    read: () => readLand(home, flow)!,
    header: f => f.workflow!,
    save: f => { if (activeLand(f) && !f.boarded) writeLand(home, f); },
    open: () => readJsonFile(join(runDir(home, flow), 'graph.json')) as Graph,
    tick: (f, key, step) => {
      if (step.kind !== 'land' || step.job !== f.job) throw Error('Invalid sealed land step');
      // A train lead owns the passenger's result until it publishes or puts the
      // passenger back in the queue. The original helper must not enter Git.
      if (f.boarded) return { state: 'running' };
      return sealedEffect(f.workflow!.steps[key], async () => { await executeLand(home, f, cleanup); return 0; });
    },
    watches: () => [],
    active: activeLand,
    readerNotices: true,
    errorLine: run => `${flow} land failed: ${run.reason}`,
    onError: (f, error) => {
      if (!activeLand(f) || f.boarded) return;
      f.state = 'failed'; f.error = String(error).split('\n')[0];
      writeLand(home, f);
    },
  });
}
