import * as fs from 'node:fs';
import { join } from 'node:path';
import { JOB_ID_RE } from '../roles/job-index-cache.js';
import { driveCouncil } from './council-step.js';
import { sharedRoot } from '../roles/projects.js';
import { tryAbstractLock } from '../utils/abstract-lock.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import { driveWorkflow } from '../workflows/driver.js';
import type { Run } from '../workflows/engine.js';
import type { Graph } from '../workflows/graph.js';
import { freezeGraph, runDir } from '../workflows/store.js';
import { batchActive, batchIndex, isBatchId, readBatch, saveBatch, type Manifest } from './batch-state.js';
import { recoverBatch, tickBatch } from './batch-step.js';
import { jobFiles } from './paths.js';
import { directory, hudHome } from './store/job-store.js';

/** Batch projects the engine cursor into index.json alongside its ordered item results.
 * The outer receipt is the small, watcher-facing projection; never schedule from that copy. */
export async function runWorkflow(id: string) {
  if (JOB_ID_RE.test(id)) {
    const path = `${runDir(hudHome, id)}.json`;
    if (fs.existsSync(path) && (readJsonFile(path) as { template?: string }).template === 'council') return driveCouncil(id);
    return;
  }
  if (!isBatchId(id)) return;
  const header = readBatch(hudHome, id);
  if (!header) return;
  // A pre-upgrade process may already hold the old election lock but not yet have
  // published its PID. Do not take over a live driver in that startup window.
  const legacy = !header.template ? await tryAbstractLock('batch-runner', `${hudHome}\0${id}`) : undefined;
  if (!header.template && !legacy) return;
  try { await driveBatchProfile(id); } finally { await legacy?.(); }
}

async function driveBatchProfile(id: string) {
  const dir = runDir(hudHome, id);
  let manifest: Manifest;
  await driveWorkflow(hudHome, id, {
    read: () => batchIndex(hudHome, id),
    header: ({ batch }) => batch as typeof batch & Run,
    save: ({ batch, items }) => saveBatch(hudHome, batch, items),
    open: ({ batch, items }) => {
      manifest = readJsonFile(join(dir, 'manifest.json')) as Manifest;
      let graph: Pick<Graph, 'name' | 'version' | 'steps' | 'policy'>;
      if (batch.template || fs.existsSync(join(dir, 'graph.json'))) graph = readJsonFile(join(dir, 'graph.json')) as Graph;
      else {
        // The old fixed manifest has exactly one step. Don't invent a historical cost class.
        graph = { version: 1, name: 'batch', policy: { breaker: 'rate' }, steps: { items: {
          kind: 'batch', needs: [], from: [], optional: false, role: batch.scale.role, max_parallel: batch.scale.max_parallel, manifest: 'manifest.json',
        } } };
        freezeGraph(hudHome, id, graph);
      }
      batch.project_root ??= sharedRoot(batch.cwd);
      batch.template = 'batch'; batch.host = 'detached'; batch.steps ??= { items: { state: 'running' } };
      recoverBatch(batch, items, graph.policy.breaker);
      return graph;
    },
    tick: ({ batch, items }, _key, step, graph) => {
      if (step.kind !== 'batch') throw Error(`unsupported workflow executor ${step.kind}`);
      return tickBatch(batch, items, step, manifest, graph.policy.breaker);
    },
    active: ({ batch }) => batchActive(batch),
    watches: ({ items }) => items.flatMap(i => i.state === 'running' && i.job ? [{ dir: directory(i.job),
      filter: (f: string | null) => !f || f === jobFiles.status || f === jobFiles.job || f === jobFiles.report }] : []),
    errorLine: run => `${id} batch paused: ${run.reason}; use hud_create batch=${id} action=resume or stop`,
  });
}
