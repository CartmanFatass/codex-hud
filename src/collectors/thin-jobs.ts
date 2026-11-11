/** Read-only thin-server jobs; no reports, question bodies or execution probes. */
import * as fs from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import type { OwnerWorker, WorkLane } from './workboard-types.js';

function entries(path: string): string[] {
  try {
    return fs.readdirSync(path);
  } catch {
    return [];
  }
}
function json(path: string): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(16385);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 16384) return null;
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export interface ThinJobScope {
  project: string | null;
  pane: string | null;
}
export function readThinJobs(home: string, scope: ThinJobScope): WorkLane[] {
  const root = join(home, 'jobs');
  return entries(root)
    .filter((id) => /^j[0-9a-f]{16}$/.test(id))
    .flatMap((id) => {
      const job = json(join(root, id, 'job.json'));
      if (
        !job ||
        job.job !== id ||
        typeof job.role !== 'string' ||
        typeof job.cwd !== 'string' ||
        typeof job.created_at !== 'string'
      )
        return [];
      const created = Date.parse(job.created_at);
      if (!Number.isFinite(created)) return [];
      const path = scope.project ? relative(resolve(scope.project), resolve(job.cwd)) : '..';
      if (scope.pane ? job.herdr_pane !== scope.pane : path === '..' || path.startsWith('../') || isAbsolute(path))
        return [];
      return [{ id, role: job.role, created }];
    })
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
    .slice(0, 20)
    .map(({ id, role, created }) => {
      const directory = join(root, id);
      const raw = json(join(directory, 'STATUS.json'))?.state;
      const state =
        typeof raw === 'string' && ['working', 'waiting_orchestrator', 'idle_grace', 'closed', 'failed'].includes(raw)
          ? raw
          : 'starting';
      const qa = new Set(entries(join(directory, 'qa')));
      const question = [...qa].some((name) => /^q\d+\.md$/.test(name) && !qa.has(name.replace('.md', '.answer.md')));
      const laneId = `thin-job:${id}`;
      const worker: OwnerWorker = {
        id: laneId,
        laneId,
        role,
        harness: 'pi',
        task: `${id.slice(-6)} ${state}${question ? ' question' : ''}`,
        state,
        startedAt: created,
        settledAt: null,
        phase: null,
        model: null,
        effort: null,
        homeNeedsHuman: false,
        humanEndedAt: null,
        stale: false,
        evidence: [],
      };
      return {
        id: laneId,
        identity: { kind: 'invocation', home, root: scope.pane ?? scope.project ?? '', jobId: id },
        label: id.slice(-6),
        title: role,
        startedAt: created,
        phase: null,
        workers: [worker],
        decisions: [],
        evidence: [],
      };
    });
}
