import * as fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { jobRow } from '../collectors/thin-jobs.js';
import { cachedReportSignature } from '../roles/report-meta.js';
import { writeLand, type LandFlow } from './land-state.js';

function questions(dir: string) {
  try { return fs.readdirSync(join(dir, 'qa')).filter(file => /^q\d+\.md$/.test(file)); }
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
  f.step = `repair ${repairs.length}`; writeLand(home, f);
  try {
    const { dispatchLandRepair } = await import('./thin-main.js');
    checkCancel();
    const started = Date.now();
    const id = await dispatchLandRepair(source, f.wt.root, task, key, f.pane);
    attempt.job = id; attempt.outcome = 'waiting for worker'; writeLand(home, f);
    for (;;) {
      checkCancel();
      const root = dir(id), receipt = JSON.parse(fs.readFileSync(join(root, 'job.json'), 'utf8'));
      const statusFile = join(root, 'STATUS.json');
      const status = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : null;
      const row = jobRow(receipt, status, { dir: root });
      const question = questions(root).find(file => source !== id || !seen.includes(file));
      if (question || row.open_questions || row.blocked || row.state === 'waiting_orchestrator')
        throw Error(`${id} needs the main session${question ? `: ${question}` : ''}`);
      if ((receipt.send_outcomes?.at(-1)?.key ?? receipt.request_key) !== key)
        throw Error(`${id} repair turn superseded`);
      if (row.display_state === 'failed' || row.display_state === 'stopped') throw Error(`${id}: ${row.reason ?? row.state}`);
      if (row.display_state === 'done') {
        const sig = cachedReportSignature(root);
        const settled = status.settled_at ? Date.parse(status.settled_at) : fs.statSync(statusFile).mtimeMs;
        if (sig && (source !== id || sig !== before) && Math.ceil(settled) >= started) break;
        if (row.state !== 'idle_grace') throw Error(`${id} closed without a fresh repair report`);
      }
      await delay(250);
    }
    attempt.outcome = 'settled; retrying gate';
  } catch (e) {
    // A question or cancellation hands the worker (and its later notices) back to the caller.
    if (attempt.job) (await import('./thin-main.js')).releaseLandTurn(attempt.job, key);
    attempt.outcome = (e as Error).message; throw e;
  }
}
