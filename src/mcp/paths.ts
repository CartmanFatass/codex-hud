import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const BUNDLED_ROOT = join(REPO_ROOT, 'packages', 'hud-mcp');
export const binScript = (name: string, bundled = BUNDLED_ROOT) => join(bundled, 'bin', `${name}.mjs`);

/** Names relative to a single HUD job directory; shared by writers, readers and watchers. */
export const jobFiles = {
  job: 'job.json',
  status: 'STATUS.json',
  session: 'SESSION.txt',
  turn: 'turn.json',
  done: 'done.json',
  checks: 'checks.json',
  task: 'mcp-task.json',
  batchNotice: 'batch-notice.json',
  brief: 'brief.md',
  report: 'report.md',
  reportMeta: 'report-meta.json',
  progress: 'progress.jsonl',
  qa: 'qa',
  sonic: '.sonic',
  supervisorPid: 'supervisor.pid',
  stopRequested: 'STATUS.json.stop-requested',
  closeRequested: 'STATUS.json.close-requested',
  archived: '.archived',
  workerMcp: 'worker-mcp.json',
  workerTree: 'worker-tree.json',
} as const;
