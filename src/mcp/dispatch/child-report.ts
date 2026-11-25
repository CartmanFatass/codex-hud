import * as fs from 'node:fs';
import { join } from 'node:path';
import { waitUntilFs } from '../../utils/fs-wait.js';
import type { Job } from '../job-contracts.js';
import { jobFiles } from '../paths.js';
import { directory, findJob, readRow, save, settled } from '../store/job-store.js';

/** A file alone is not a result: collect a settled report or account for the failure. */
export async function waitChildReport(id: string, discard: (child: Job) => Promise<unknown>,
  { signal, retiring, stopping }: { signal?: AbortSignal; retiring?: AbortSignal; stopping?: () => boolean }) {
  const dir = directory(id);
  let child: Job | null = null, abandon = false;
  try {
    return await waitUntilFs<string | undefined>({
      targets: () => [{ dir, filter: file => !file || file === jobFiles.status || file === jobFiles.report || file === jobFiles.job || file === jobFiles.qa },
        ...(fs.existsSync(join(dir, jobFiles.qa)) ? [{ dir: join(dir, jobFiles.qa) }] : [])],
      timeoutMs: Infinity, fallbackIntervalMs: 500, signal: retiring ?? signal,
      check: () => {
        child = findJob(id);
        if (!child) return { done: true, value: 'child receipt disappeared' };
        const { row, reportStamp } = readRow(child);
        if (settled(row.state)) {
          if (row.state === 'failed' || row.state === 'stopped') return { done: true, value: row.reason ?? row.state };
          if (!row.report_present) return { done: true, value: 'settled without a report' };
          save({ ...child }, false, reportStamp);
          return { done: true, value: undefined };
        }
        if (stopping?.()) { abandon = true; return { done: true, value: 'stopped' }; }
        if (row.open_questions || row.blocked || row.state === 'waiting_orchestrator') {
          abandon = true;
          return { done: true, value: row.open_questions ? 'asked a question' : row.reason ?? 'needed attention' };
        }
        return { done: false };
      },
    });
  } catch (error) {
    if (retiring?.aborted) return; // Leave the live child for the next workflow host.
    child = findJob(id);
    abandon = !!child && !settled(readRow(child).row.state);
    return signal?.aborted ? 'stopped' : String(error);
  } finally {
    if (abandon && child) await discard(child);
  }
}
