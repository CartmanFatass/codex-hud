import * as fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Job, JobStatus } from './job-contracts.js';
import { jobFiles } from './paths.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import { jobRow } from '../collectors/thin-jobs.js';
import { cachedReportSignature } from '../roles/report-meta.js';
import { setLandStep, writeLand, type LandFlow } from './land-state.js';
import { dispatchLandRepair, releaseLandTurn } from './thin-main.js';

function questions(dir: string) {
  try { return fs.readdirSync(join(dir, jobFiles.qa)).filter(file => /^q\d+\.md$/.test(file)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
export async function repairLand(home: string, f: LandFlow, checkCancel: () => void) {
  const repairs = f.repairs ??= [], source = repairs.at(-1)?.job ?? f.job;
  const dir = (id: string) => join(home, 'jobs', id);
  const seen = questions(dir(source)), before = cachedReportSignature(dir(source));
  const attempt: NonNullable<LandFlow['repairs']>[number] = { step: f.step, outcome: 'dispatching' };
  repairs.push(attempt);
  const key = `land:${f.flow}:${repairs.length}`;
  const task = `Repair this landing in ${f.wt.root} on branch ${f.wt.branch}. Rebase onto the current ${f.config.base} base, fix the failure and commit. Do not push or change the main checkout.\nFailing step: ${f.step}: ${f.error}\nLog tail:\n${f.tail?.join('\n')}`;
  setLandStep(f, `repair ${repairs.length}`); writeLand(home, f);
  try {
    checkCancel();
    const started = Date.now();
    const id = await dispatchLandRepair(source, f.wt.root, task, key, f.pane, f.ticket_queue);
    attempt.job = id; attempt.outcome = 'waiting for worker'; writeLand(home, f);
    for (;;) {
      checkCancel();
      const root = dir(id), receipt = readJsonFile(join(root, jobFiles.job)) as Job;
      const send = receipt.send_outcomes?.at(-1);
      if ((send?.key ?? receipt.request_key) !== key) throw Error(`${id} repair turn superseded`);
      // A new question is evidence even before the worker publishes a new status.
      const question = questions(root).find(file => source !== id || !seen.includes(file));
      if (question) throw Error(`${id} needs the main session: ${question.slice(0, -3)}`);
      const statusFile = join(root, jobFiles.status);
      // Stat before reading so an atomic replacement can't date an old row with a newer mtime.
      const statusAt = fs.statSync(statusFile, { throwIfNoEntry: false })?.mtimeMs;
      const sentAt = send?.recorded_at ? Date.parse(send.recorded_at) : started;
      if (source === id && statusAt !== undefined && Math.ceil(statusAt) < sentAt) {
        await delay(250);
        continue;
      }
      const status = statusAt === undefined ? null : readJsonFile(statusFile) as JobStatus;
      const row = jobRow(receipt, status);
      if (row.blocked || row.state === 'blocked' || row.state === 'waiting_orchestrator')
        throw Error(`${id} needs the main session`);
      if (row.display_state === 'failed' || row.display_state === 'stopped') throw Error(`${id}: ${row.reason ?? row.state}`);
      if (row.display_state === 'done') {
        const sig = cachedReportSignature(root);
        const settled = status!.settled_at ? Date.parse(status!.settled_at) : statusAt!;
        if (sig && (source !== id || sig !== before) && Math.ceil(settled) >= sentAt) break;
        if (row.state !== 'idle_grace') throw Error(`${id} closed without a fresh repair report`);
      }
      await delay(250);
    }
    attempt.outcome = 'settled; retrying gate';
  } catch (e) {
    // A question or cancellation hands the worker (and its later notices) back to the caller.
    if (attempt.job) releaseLandTurn(attempt.job, key);
    attempt.outcome = (e as Error).message; throw e;
  }
}
