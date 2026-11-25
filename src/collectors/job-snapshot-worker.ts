import { parentPort } from 'node:worker_threads';
import { setImmediate as yieldToWatch } from 'node:timers/promises';
import { readBatchRows } from './batch-rows.js';
import { watchJobChanges } from './job-changes.js';
import { readSessionJobRows, readThinJobs } from './thin-jobs.js';
import { JobSnapshotIndex, RECONCILE_MS } from './job-snapshot-index.js';
import { resumedWorkerRefusal } from '../roles/resume-guard.js';
import type { Lanes, Request } from './job-snapshot.js';

type ViewState = { home: string; source: ReturnType<typeof watchJobChanges>; dirty: boolean; at: number };
const views = new Map<number, ViewState>();
const indexes = new Map<string, JobSnapshotIndex>();
const listeners = new Map<number, ReturnType<typeof watchJobChanges>>();

function project({ home, scope, options }: Extract<Request, { kind: 'project' }>['view'], index?: JobSnapshotIndex): Lanes {
  const observation = { complete: false };
  // A long-lived bar advances its settlement cutoff on every projection, not just when it opens.
  const cutoff = options?.settledBefore;
  const scanOptions = options && { ...options, settledBefore: cutoff === 'now' ? Date.now() : cutoff };
  const lanes = readThinJobs(home, scope, undefined, scanOptions, observation, index?.directoryInventory());
  return { lanes, complete: observation.complete, batches: readBatchRows(home, scope) };
}

async function collect(request: Request): Promise<Lanes | string[] | unknown> {
  switch (request.kind) {
    case 'close': {
      const view = views.get(request.key);
      view?.source.close();
      listeners.get(request.key)?.close();
      views.delete(request.key);
      listeners.delete(request.key);
      if (view && !Array.from(views.values()).some((other) => other.home === view.home)) indexes.delete(view.home);
      return;
    }
    case 'watch': {
      let source = listeners.get(request.key);
      if (!source) {
        source = watchJobChanges(request.home, (notice) => { if (notice) parentPort!.postMessage({ notice: request.key }); });
        listeners.set(request.key, source);
      }
      source.attach();
      return;
    }
    case 'project': return project(request.view);
    case 'rows': return readSessionJobRows(request.home, request.pane, request.cwd, request.env);
    case 'resume': return resumedWorkerRefusal(...request.args);
    case 'read': {
      const { view, key } = request;
      let index = indexes.get(view.home);
      if (!index) indexes.set(view.home, (index = new JobSnapshotIndex(view.home)));
      const shared = index;
      let cached = views.get(key);
      if (!cached) {
        const state: ViewState = { home: view.home, dirty: true, at: -Infinity, source: watchJobChanges(view.home, (_notice, ids) => {
          shared.invalidate(ids);
          if (view.kind === 'lanes' || ids?.length !== 0) state.dirty = true;
        }) };
        views.set(key, (cached = state));
      }
      cached.source.attach();
      // Receive file events already queued before a client's refresh request.
      await yieldToWatch();
      if (views.get(key) !== cached || (!cached.dirty && performance.now() - cached.at < RECONCILE_MS)) return;
      const result = view.kind === 'codex' ? shared.codexWorkerSessions() : project(view, shared);
      cached.dirty = false;
      cached.at = performance.now();
      return result;
    }
  }
}

parentPort!.on('message', async ({ id, request }: { id: number; request: Request }) => {
  try { parentPort!.postMessage({ id, value: await collect(request) }); }
  catch (error) { parentPort!.postMessage({ id, error: String(error) }); }
});
