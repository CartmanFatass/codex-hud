import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { councilGrants } from '../roles/council-grant.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import { waitUntilFs } from '../utils/fs-wait.js';
import { driveWorkflow } from '../workflows/driver.js';
import type { Graph } from '../workflows/graph.js';
import { runDir, runLock, saveHeader } from '../workflows/store.js';
import { readCouncilRun, type CouncilManifest, type CouncilRun } from './council-state.js';
import { runCouncil } from './dispatch/council.js';
import { dispatchCouncilSeat } from './dispatch/orchestrator.js';
import { jobFiles } from './paths.js';
import { directory, findJobMutable, hudHome, jobs, readCachedStatus, save, writeCreateStatus } from './store/job-store.js';

async function execute(id: string, brief: string, { plan, grant, composed }: CouncilManifest) {
  const parent = findJobMutable(id);
  if (!parent?.council_members) throw Error('missing council receipt');
  const dir = directory(id), task = readFileSync(join(dir, brief), 'utf8').slice(0, parent.task_length);
  const stop = new AbortController(), finished = new AbortController();
  const stopping = waitUntilFs({ timeoutMs: Infinity, signal: finished.signal,
    targets: [{ dir, filter: f => !f || f === jobFiles.stopRequested }],
    check: () => {
      if (!existsSync(join(dir, jobFiles.stopRequested))) return { done: false };
      stop.abort(); return { done: true, value: undefined };
    },
  }).catch(error => { if (!finished.signal.aborted) stop.abort(error); });
  const spend = () => { if (!parent.grant) { parent.grant = grant; save(parent); } };
  // An interrupted launch may have sent input without publishing used_place. Never
  // refund that claim, including if a second host later finishes the council.
  const markUnknown = () => runLock(hudHome, id, () => {
    const run = readCouncilRun(hudHome, id);
    run.input_unknown = true; saveHeader(hudHome, run);
  });
  try {
    return await runCouncil(parent, plan, task, async (seat, part, args, slot) => {
      const key = `council:${id}:${slot}`;
      const staged = await runLock(hudHome, id, () => {
        const run = readCouncilRun(hudHome, id);
        if (run.intents.includes(slot)) return false;
        stop.signal.throwIfAborted();
        run.intents.push(slot); saveHeader(hudHome, run); return true;
      });
      if (!staged) {
        // This host didn't stage the launch. Bind its receipt, including a failed
        // pre-input launch; never re-send a costly brief on an ambiguous outcome.
        const child = jobs().find(j => j.council?.id === id && j.request_key === key);
        if (child?.used_place && part === 'member') spend();
        if (part === 'member' && (!child || child.dispatch_exit_code === null)) await markUnknown();
        if (!child || (child.dispatch_exit_code === null && !readCachedStatus(child.job).status))
          return { job: child?.job, failure: 'council launch interrupted without a settled dispatch receipt' };
        return { job: child.job };
      }
      return dispatchCouncilSeat(parent, seat, part, args, key, spend);
    }, stop.signal, async () => { if (!composed && !readCouncilRun(hudHome, id).input_unknown) await councilGrants.releaseUnused(hudHome, id); });
  } finally { finished.abort(); await stopping; }
}

/** A sealed fan-out: the engine commits the running cursor before admission. The job
 * receipt remains the public result and sole notice source, including on failure. */
export async function driveCouncil(id: string) {
  const dir = runDir(hudHome, id);
  let outcome: Awaited<ReturnType<typeof execute>> | undefined;
  await driveWorkflow<CouncilRun>(hudHome, id, {
    read: () => readCouncilRun(hudHome, id), header: run => run,
    open: () => readJsonFile(join(dir, 'graph.json')) as Graph,
    tick: (run, _key, step) => {
      if (step.kind !== 'council' || step.brief_file !== jobFiles.brief) throw Error('unsupported council template');
      const status = outcome ?? readCachedStatus(id).status;
      if (status?.state === 'closed') return { state: 'done' };
      if (status?.state === 'failed' || status?.state === 'stopped') {
        run.state = status.state; run.reason = status.exit_reason ?? undefined;
        return { state: 'failed', reason: run.reason };
      }
      return { state: 'running', effect: async () => {
        outcome = await execute(id, jobFiles.brief, readJsonFile(join(dir, 'manifest.json')) as CouncilManifest);
        return 0;
      } };
    },
    save: run => {
      // Standalone councils have no resume action. Project a driver error into the
      // same terminal parent receipt as a member/quorum failure, not a second wake.
      if (run.state === 'paused') {
        run.state = 'failed'; run.notices = {}; delete run.handback;
        run.steps.council = { state: 'failed', reason: run.reason };
        writeCreateStatus(directory(id), { state: 'failed', exit_reason: run.reason, ended_at: new Date().toISOString() });
      }
      saveHeader(hudHome, run);
    },
    watches: () => [], active: run => run.state === 'working', errorLine: run => `${id} council failed: ${run.reason}`,
  });
}
