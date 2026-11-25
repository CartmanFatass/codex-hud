/** Browser-worker launch. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { herdrId } from '../../roles/herdr-run.js';
import { writePrivateFile } from '../../utils/atomic-fs.js';
import type { Job } from '../job-contracts.js';
import { jobFiles } from '../paths.js';
import { directory, hudHome, jobCache } from '../store/job-store.js';
import { tabLabel, run, workspaceArgs, rejectLaunch, binScript, quote, type DispatchResult } from './proc.js';

export async function dispatchBro(job: Job, task: string): Promise<DispatchResult> {
  const launch = randomUUID(), dir = directory(job.job),
    tabName = tabLabel(job, task);
  const result = await run('herdr', [
    'tab',
    'create',
    ...(await workspaceArgs(job)),
    '--cwd',
    job.cwd,
    '--label',
    tabName,
    '--env',
    `HUD_JOB_DIR=${dir}`,
    '--env', `HUD_TAB_LAUNCH=${launch}`,
    '--env',
    `HUD_HOME=${hudHome}`,
    '--no-focus',
  ]);
  if (result.exit_code !== 0) return rejectLaunch(result);
  let created;
  try {
    created = JSON.parse(result.stdout).result;
  } catch (error) {
    return { ...result, exit_code: 1, stderr: `herdr tab create: ${String(error)}` };
  }
  const { tab, root_pane } = created;
  if (!herdrId(tab?.tab_id) || !herdrId(root_pane?.pane_id)) throw new Error('tab create missing ids');
  const sessionFile = join(dir, jobFiles.session);
  writePrivateFile(
    sessionFile,
    `TASK=${job.job}\nLAUNCH=${launch}\nTAB=${tab.tab_id}\nTAB_NAME=${tabName}\nLEFT=${root_pane.pane_id}\nORCH=${job.herdr_pane}\n`,
    { mkdir: false }
  );
  jobCache.invalidateFile(sessionFile);
  const script = binScript('hud-jev.mjs');
  return run('herdr', ['pane', 'run', root_pane.pane_id, [process.execPath, script, dir, String(task.length)].map(quote).join(' ')]);
}
