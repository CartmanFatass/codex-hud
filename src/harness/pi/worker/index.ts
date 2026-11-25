import { dirname, join } from 'node:path';
import { readContract } from './contract.js';
import { roleRuntime } from './role-runtime.js';
import { workerTools } from './tools.js';
import { installGuard } from './guard.js';
import { workerJob } from '../../../worker/tools.js';
import { mistralBudget } from './mistral-budget.js';
import { webSearch } from './web-search.js';
import { trackTps } from './tps.js';
import { writePrivateFile } from '../../../utils/atomic-fs.js';
import { isQuotaFailure } from '../../../roles/exhausted.js';
import type { WorkerPi } from './host.js';

export async function installWorker(pi: WorkerPi) {
  const dir = process.env.HUD_JOB_DIR;
  if (!dir) throw Error('Missing HUD_JOB_DIR');
  const contract = readContract(dir);
  const { job } = workerJob(dir);
  if (!job.headless || job.cli || job.role !== contract.role) throw Error('Expected the matching headless pi job');
  if (contract.guard) installGuard(pi, contract.guard, dir, job.project_root);
  await workerTools(pi, dir, contract.session !== undefined);
  webSearch(pi, dirname(dirname(dir)));
  roleRuntime(pi, contract);
  mistralBudget(pi, dir);
  if (contract.tps) trackTps(pi);
  // Only the final provider error is evidence; do not classify quoted tool output or replay this job.
  let quota = false;
  pi.on('message_end', ({ message }) => {
    if (message.role === 'assistant') quota = message.stopReason === 'error' && isQuotaFailure(message.errorMessage ?? '');
  });
  pi.on('agent_settled', () => { if (quota) writePrivateFile(join(dir, 'pi-quota'), '', { mkdir: false }); });
}
