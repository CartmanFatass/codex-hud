import * as fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Job, JobStatus } from './job-contracts.js';
import { jobFiles } from './paths.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import { jobRow, settledJobReport } from '../collectors/thin-jobs.js';
import { cachedReportSignature } from '../roles/report-meta.js';
import { DEFAULT_ASK_TIMEOUT_S, parseAskTimeoutSeconds } from '../worker/qa.js';
import { setLandStep, writeLand, type LandFlow } from './land-state.js';
import { dispatchLandRepair, releaseLandTurn } from './thin-main.js';

function questions(dir: string) {
  try { return fs.readdirSync(join(dir, jobFiles.qa)).filter(file => /^q\d+\.md$/.test(file)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
export function repairBaseline(dir: string) {
  return { seen: questions(dir), before: cachedReportSignature(dir), started: Date.now() };
}

/** Workflow check repairs still hand back at the first question. */
export function repairSettled(root: string, receipt: Job, key: string, inPlace: boolean, baseline: ReturnType<typeof repairBaseline>) {
  return repairProgress(root, receipt, key, inPlace, baseline) === true;
}

/** Delivery isn't settlement. Require evidence from this keyed turn, not the report it inherited. */
function repairProgress(root: string, receipt: Job, key: string, inPlace: boolean, baseline: ReturnType<typeof repairBaseline>, questionTimeoutMs?: number): boolean | string {
  const id = receipt.job, send = receipt.send_outcomes?.at(-1);
  const waitForQuestions = questionTimeoutMs !== undefined;
  const answeredHeadless = waitForQuestions && receipt.headless && receipt.land_turn === key && /^answer:q\d+$/.test(send?.key ?? '');
  if ((send?.key ?? receipt.request_key) !== key && !answeredHeadless) throw Error(`${id} repair turn superseded`);
  const statusFile = join(root, jobFiles.status);
  // Stat before reading so an atomic replacement can't date an old row with a newer mtime.
  const statusAt = fs.statSync(statusFile, { throwIfNoEntry: false })?.mtimeMs;
  const sentAt = send?.recorded_at ? Date.parse(send.recorded_at) : baseline.started;
  const oldStatus = (inPlace || answeredHeadless) && statusAt !== undefined && Math.ceil(statusAt) < sentAt;
  const status = oldStatus || statusAt === undefined ? null : readJsonFile(statusFile) as JobStatus;
  // Read questions after status: a question can be published before its attention row.
  const asked = questions(root).filter(file => !inPlace || !baseline.seen.includes(file));
  if (!waitForQuestions && asked.length) throw Error(`${id} needs the main session: ${asked[0].slice(0, -3)}`);
  if (oldStatus && !asked.length) return false;
  const row = jobRow(receipt, status, { dir: root });
  if (row.display_state === 'failed' || row.display_state === 'stopped') throw Error(`${id}: ${row.reason ?? row.state}`);
  if (waitForQuestions) {
    const qa = join(root, jobFiles.qa), now = Date.now();
    let open: string | undefined;
    for (const file of asked) {
      const qid = file.slice(0, -3);
      if (receipt.timed_out_questions?.includes(qid)) throw Error(`${id}: question ${qid} timed out`);
      const questionAt = fs.statSync(join(qa, file), { throwIfNoEntry: false })?.mtimeMs;
      if (questionAt === undefined) continue;
      const deadline = questionAt + questionTimeoutMs;
      const answerAt = fs.statSync(join(qa, `${qid}.answer.md`), { throwIfNoEntry: false })?.mtimeMs;
      if (answerAt !== undefined && answerAt <= deadline) continue;
      if (row.state === 'closed' || row.state === 'stopped') throw Error(`${id}: ${row.reason ?? row.state}`);
      if (now >= deadline) throw Error(`${id}: question ${qid} timed out`);
      open ??= qid;
    }
    if (open) return open;
  }
  if (oldStatus) return false;
  // After an answer the worker may still be publishing its transition out of attention.
  if (!asked.length && (row.blocked || row.state === 'blocked' || row.state === 'waiting_orchestrator'))
    throw Error(`${id} needs the main session`);
  if (row.display_state === 'done') {
    const sig = settledJobReport(row, status) && cachedReportSignature(root);
    const settled = status!.settled_at ? Date.parse(status!.settled_at) : statusAt!;
    if (sig && (!inPlace || sig !== baseline.before) && Math.ceil(settled) >= sentAt) return true;
    if (row.state !== 'idle_grace') throw Error(`${id} closed without a fresh repair report`);
  }
  return false;
}

export async function repairLand(home: string, f: LandFlow, checkCancel: () => void) {
  const repairs = f.repairs ??= [], source = repairs.at(-1)?.job ?? f.approval?.job ?? f.job;
  const dir = (id: string) => join(home, 'jobs', id);
  const baseline = repairBaseline(dir(source));
  const now = new Date().toISOString();
  const attempt: NonNullable<LandFlow['repairs']>[number] = { step: f.step, outcome: 'dispatching', started_at: now, changed_at: now };
  repairs.push(attempt);
  const key = `land:${f.flow}:${repairs.length}`;
  const task = `Repair this landing in ${f.wt.root} on branch ${f.wt.branch}. Rebase onto the current ${f.config.base} base, fix the failure and commit. Do not push or change the main checkout.\nFailing step: ${f.step}: ${f.error}\nLog tail:\n${f.tail?.join('\n')}`;
  const step = `repair ${repairs.length}`;
  const questionTimeoutMs = (parseAskTimeoutSeconds() || DEFAULT_ASK_TIMEOUT_S) * 1000;
  setLandStep(f, step); writeLand(home, f);
  try {
    checkCancel();
    baseline.started = Date.now();
    const id = await dispatchLandRepair(source, f.wt.root, task, key, f.pane, f.ticket_queue);
    attempt.job = id; attempt.outcome = 'waiting for worker'; attempt.changed_at = new Date().toISOString(); writeLand(home, f);
    for (;;) {
      checkCancel();
      const root = dir(id), receipt = readJsonFile(join(root, jobFiles.job)) as Job;
      const progress = repairProgress(root, receipt, key, source === id, baseline, questionTimeoutMs);
      if (progress === true) break;
      const nextStep = progress ? `${step}: waiting for main (${progress})` : step;
      if (f.step !== nextStep) { setLandStep(f, nextStep); writeLand(home, f); }
      await delay(250);
    }
    attempt.outcome = 'settled; retrying gate';
    attempt.changed_at = new Date().toISOString();
  } catch (e) {
    // A failed or cancelled repair hands its later notices back to the caller.
    if (attempt.job) releaseLandTurn(attempt.job, key);
    if (f.step !== step) setLandStep(f, step);
    attempt.outcome = (e as Error).message;
    attempt.changed_at = new Date().toISOString();
    throw e;
  }
}
