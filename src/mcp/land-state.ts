/** A land helper outlives its MCP and watcher. Never replay a step whose outcome is unknown. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { sharedRoot } from '../roles/projects.js';
import { workerTreeRootGone } from '../roles/worker-tree.js';
import type { ManagedWorktree } from './managed-worktree.js';

export interface LandConfig { base: string; gate: string[]; after: string[]; push: boolean; wrapper?: string }
export interface LandFlow {
  flow: string; job: string; pane: string | null; task: boolean; wt: ManagedWorktree; config: LandConfig;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; step: string;
  pid: number; start: string; created_at: string; updated_at: string;
  base_sha?: string; source_sha: string; tested_sha?: string; landed_sha?: string; error?: string; tail?: string[];
}
export const isFlowId = (id: unknown): id is string => typeof id === 'string' && /^f[a-f0-9]{16}$/.test(id);
export const flowId = (job: string) => `f${job.slice(1)}`;
export const activeLand = (f: LandFlow) => f.state === 'queued' || f.state === 'running';
export const landFile = (home: string, id: string) => join(home, 'flows', `${id}.json`);
export function writeLand(home: string, f: LandFlow, create = false) {
  f.updated_at = new Date().toISOString();
  const path = landFile(home, f.flow), tmp = `${path}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(f) + '\n', { mode: 0o600, flag: 'wx' });
  try { if (create) fs.linkSync(tmp, path); else fs.renameSync(tmp, path); }
  finally { if (create) fs.unlinkSync(tmp); }
}
export function readLand(home: string, id: string): LandFlow | null {
  if (!isFlowId(id)) return null;
  const path = landFile(home, id);
  let f: LandFlow;
  try { f = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  if (activeLand(f) && workerTreeRootGone(f.pid, f.start)) {
    // The last write may have landed between the read and the exit check.
    f = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (activeLand(f)) {
      f.state = 'failed'; f.error = 'Land helper exited; inspect the checkout before retrying. No step was replayed.';
      writeLand(home, f);
    }
  }
  return f;
}
export function landView(f: LandFlow) {
  const { flow, job, state, step, landed_sha, error, tail } = f;
  return { flow, job, state, step, landed_sha, error, tail };
}
export function landNotice(f: LandFlow) {
  return `${f.flow} (land ${f.job}) — ${f.state}: ${f.step}${f.landed_sha ? ` ${f.landed_sha}` : ''}${f.error ? `: ${f.error}` : ''}${f.tail?.length ? `\n${f.tail.join('\n')}` : ''}`;
}
/** Native/watch and MCP changes share one terminal notice claim for the calling pane. */
export function landEvents(home: string, pane: string | null, all = false, cwd = process.cwd()) {
  const dir = join(home, 'flows');
  const lines: string[] = [];
  let pending = false;
  let files: string[];
  try { files = fs.readdirSync(dir); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { lines, pending }; throw e; }
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    if (!file.endsWith('.json') || !isFlowId(id)) continue;
    const marker = `${landFile(home, id)}.${all ? 'observed' : 'noticed'}`;
    if (fs.existsSync(marker)) continue;
    const f = readLand(home, id);
    if (!f || f.task || (!all && f.pane !== pane)) continue;
    if (!all && f.wt.main_root !== cwd && f.wt.main_root !== sharedRoot(cwd)) continue;
    if (activeLand(f)) { pending = true; continue; }
    try { fs.closeSync(fs.openSync(marker, 'wx', 0o600)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; throw e; }
    // Queued transports (and hud watch) use one physical line per event.
    lines.push(landNotice(f).replace(/\r?\n/g, ' | ').replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
  }
  return { lines, pending };
}
