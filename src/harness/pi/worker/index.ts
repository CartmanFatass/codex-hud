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
  const isTab = contract.tab !== undefined;
  if (Boolean(job.headless) === isTab || job.cli || job.role !== contract.role) {
    throw Error(`Expected the matching ${isTab ? 'tab' : 'headless'} pi job`);
  }
  if (contract.guard) installGuard(pi, contract.guard, dir, job.project_root);
  if (!job.selection_advisor) webSearch(pi, dirname(dirname(dir)));
  roleRuntime(pi, contract, undefined, Boolean(job.selection_advisor));
  mistralBudget(pi, dir);
  if (contract.tps) trackTps(pi);
  if (isTab && contract.tab) {
    // Tab lifecycle is tab-only and lazily imported so headless workers never load it.
    const { installTabLifecycle } = await import('./tab-lifecycle.js');
    const tab = installTabLifecycle(pi, {
      taskDir: dir,
      role: contract.role,
      profile: contract.tab.profile,
      effortSource: contract.tab.effortSource,
    });
    await workerTools(pi, dir, true, tab);
    return;
  }
  await workerTools(pi, dir, contract.session !== undefined);
  // Only the final provider error is evidence; do not classify quoted tool output or replay this job.
  let quotaError: string | null = null;
  pi.on('message_end', ({ message }) => {
    if (message.role !== 'assistant') return;
    const text = typeof message.errorMessage === 'string' ? message.errorMessage.trim() : '';
    quotaError = message.stopReason === 'error' && isQuotaFailure(text) ? text : null;
  });
  pi.on('agent_settled', () => { if (quotaError) writePrivateFile(join(dir, 'pi-quota'), quotaError, { mkdir: false }); });
}
