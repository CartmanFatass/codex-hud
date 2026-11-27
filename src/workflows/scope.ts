import { sharedRoot } from '../roles/projects.js';
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
/** Deliver run notices to the bound live origin; use the project fallback only when the origin is absent or dead. */
export function runNoticeRecipient(run: RunScope, pane: string | null, cwd = process.cwd()) {
  if (run.pane && directRecipient(run)) return run.pane === pane;
  return run.project_root === cwd || (!!run.project_root && run.project_root === sharedRoot(cwd));
}
