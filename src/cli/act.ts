/** `hud act`: the owner's panel actions from a command, so the Claude mod's slash commands and band buttons need no model turn. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { appendPanelAction, JOB } from '../collectors/panel-actions.js';
import { ProjectCollector } from '../collectors/project-board.js';
import { acceptAll } from '../collectors/try-records.js';
import { getHudHome } from '../hud-home.js';
import { batchIndex, isBatchId, readBatch, totalsLine } from '../mcp/batch-state.js';
import type { Job } from '../mcp/job-contracts.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { packageJobFilter } from '../roles/job-project.js';
import { removeQueuedJob } from '../roles/concurrency.js';
import { getJobIndexCache } from '../roles/job-index-cache.js';
import type { HudIO } from './hud.js';
import { CliError } from './private-home.js';
import { NO_WORKERS } from './watch-band.js';

export const ACT_HELP =
  'Usage: hud act answer <job> <qN> <answer...>   Write qa/qN.answer.md once (resumes a headless job)\n' +
  '       hud act try [--cwd DIR]                   Accept all slices to try, as the panel does\n' +
  '       hud act retry <job>                       Record a retry request; the main session decides\n' +
  '       hud act stop <job>                        Stop a job\n' +
  '       hud act stop|pause|resume <batch>         Control a whole batch at once; running items finish\n' +
  '       hud act stop --queued <job>...            Cancel queued work only (no worker)\n' +
  '       hud act stop --package LABEL --queued     Cancel this pane’s queued package jobs in this project\n';

export async function actCommand(args: readonly string[], io: HudIO): Promise<number> {
  const [verb, ...rest] = args, home = getHudHome(io.env), say = (text: string) => io.stdout(`${text}\n`);
  if (verb === '--help' && !rest.length) { await io.stdout(ACT_HELP); return 0; }
  if (verb === 'try') {
    if (rest.length && !(rest.length === 2 && rest[0] === '--cwd')) throw new CliError(ACT_HELP.trimEnd());
    let root = rest[1] ?? process.cwd();
    try { root = fs.realpathSync(root); } catch { /* The collector reads what it can. */ }
    const project = await new ProjectCollector(root, home, io.env).collect('home', NO_WORKERS, Date.now()).catch(() => undefined);
    if (!project) throw new CliError('could not read the project', 1);
    let accepted: number;
    try { accepted = acceptAll(home, root, project.ledger); } catch { throw new CliError('could not accept all', 1); }
    await say(accepted ? `Accepted ${accepted} to try` : 'Nothing to try');
    return 0;
  }
  if (verb === 'stop' && (rest[0] === '--queued' || rest[0] === '--package')) {
    const cache = getJobIndexCache(home);
    let ids: readonly string[], selected: ((job: Job) => boolean) | undefined;
    if (rest[0] === '--package') {
      if (!rest[1] || rest[2] !== '--queued' || rest.length !== 3) throw new CliError(ACT_HELP.trimEnd());
      if (!io.env.HERDR_PANE_ID) throw new CliError('package selection needs a caller pane; use --queued <job>...', 1);
      const matches = packageJobFilter(process.cwd(), rest[1]);
      selected = job => !job.scout_only && jobCallerPane(job) === io.env.HERDR_PANE_ID && matches(job);
      ids = cache.listJobIds();
    } else {
      ids = rest.slice(1);
      if (!ids.length || ids.some(id => !JOB.test(id))) throw new CliError(ACT_HELP.trimEnd());
    }
    let cancelled = 0, skipped = 0, failed = 0;
    for (const id of ids) {
      try {
        const receipt = cache.readJob<Job>(id);
        if (receipt.status !== 'ok' || receipt.value.job !== id) throw new Error('no readable job receipt');
        if (selected && !selected(receipt.value)) continue;
        const status = cache.readStatus(id);
        if (status.status !== 'ok' && status.status !== 'missing') throw new Error('unreadable job status');
        const outcome = removeQueuedJob(join(home, 'jobs', id), status.status === 'ok' ? status.value.state : null);
        if (outcome === 'cancelled') {
          cancelled++;
          await say(`Cancelled ${id} (never started; no worker)`);
        } else {
          skipped++;
          await say(`Skipped ${id}: ${outcome}`);
        }
      } catch (error) {
        failed++;
        await say(`Failed ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await say(`${cancelled} cancelled, ${skipped} skipped, ${failed} failed`);
    return failed ? 1 : 0;
  }
  if ((verb === 'stop' || verb === 'pause' || verb === 'resume') && rest.length === 1 && isBatchId(rest[0])) {
    const id = rest[0];
    if (!readBatch(home, id)) throw new CliError(`no such batch: ${id}`, 1);
    const b = await (await import('../mcp/batch.js')).controlBatchAsOwner(home, id, verb)
      .catch((error: Error) => { throw new CliError(`could not ${verb} ${id}: ${error.message}`, 1); });
    if (!b.applied) throw new CliError(`could not ${verb} ${id}: batch is ${b.state}`, 1);
    await say(`Batch ${id} ${b.state}: ${totalsLine(b)}`);
    if (verb === 'stop' && b.totals.running) {
      const running = batchIndex(home, id).items.flatMap(i => i.state === 'running' && i.job ? [i.job] : []);
      await say(`Running items finish; to stop one: hud act stop <job>${running.length ? ` (${running.join(' ')})` : ''}`);
    }
    return 0;
  }
  const [job, qid, ...words] = rest;
  const valid = verb === 'answer' ? /^q\d+$/.test(qid ?? '') && words.length > 0 : (verb === 'retry' || verb === 'stop') && rest.length === 1;
  if (!job || !JOB.test(job) || !valid) throw new CliError(ACT_HELP.trimEnd());
  if (getJobIndexCache(home).readJob(job).status !== 'ok') throw new CliError(`no such job: ${job}`, 1);
  if (verb === 'retry') {
    appendPanelAction(home, { type: 'retry', job });
    await say(`Retry requested for ${job}`);
  } else if (verb === 'stop') {
    const stopped = await (await import('./panel-pane.js')).stopJob(join(home, 'jobs', job), io.env);
    if (!stopped.ok) throw new CliError(`could not stop ${job}: ${stopped.reason}`, 1);
    await say(`Stopped ${job}`);
  } else {
    const done = await (await import('../panel/actions.js')).answerFromPanel(home, job, qid!, words.join(' '), null);
    if (!done.ok) throw new CliError(`could not answer: ${done.reason}`, 1);
    await say(done.written ? `Answered ${qid} for ${job}` : `${qid} was already answered`);
  }
  return 0;
}
