import { join } from 'node:path';
import type { Job } from '../mcp/job-contracts.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { sharedRoot } from '../roles/projects.js';
import { jobProjectRoot } from '../roles/selection-excerpts.js';
import type { NoticeOrigin } from '../roles/select-send.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import { isProcAlive } from '../utils/proc.js';

export interface RunScope {
  pane: string; project_root?: string;
  // Only a hint for direct delivery to the originating pane. Never an execution lease.
  origin_mcp?: { pid: number; start: string };
}
export const directRecipient = (run: Pick<RunScope, 'origin_mcp'>) => !run.origin_mcp || isProcAlive(run.origin_mcp.pid, run.origin_mcp.start);
/** A fresh project main can read/control the run without transferring ownership or
 * proving another session dead. A live origin can still read its explicit cross-project dispatch. */
export function runVisible(run: RunScope, pane: string | null, cwd = process.cwd()) {
  return run.project_root === cwd || (!!run.pane && run.pane === pane && directRecipient(run)) ||
    (!!run.project_root && run.project_root === sharedRoot(cwd));
}
export function jobNoticeOrigin(home: string, job: Job): NoticeOrigin {
  const id = job.ticket_queue ?? job.batch_flow ?? job.workflow ?? job.land_turn;
  let run: (NoticeOrigin & { workflow?: NoticeOrigin; root?: string }) | undefined;
  if (id && /^[bqwf][a-f0-9]{16}(?:-\d+)?$/.test(id)) {
    try { run = readJsonFile(join(home, 'flows', `${id}.json`)) as typeof run; } catch { /* Legacy/unbound job. */ }
  }
  return { pane: run?.pane ?? jobCallerPane(job), origin_mcp: run?.origin_mcp ?? run?.workflow?.origin_mcp ?? job.origin_mcp,
    project_root: job.project_root ?? job.worktree?.main_root ?? run?.project_root ?? run?.root ?? jobProjectRoot(job),
    workspace: job.herdr_workspace ?? run?.workspace };
}
