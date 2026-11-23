/** `hud act`: the owner's panel actions from a command, so the Claude mod's slash commands and band buttons need no model turn. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { appendPanelAction, JOB } from '../collectors/panel-actions.js';
import { ProjectCollector } from '../collectors/project-board.js';
import { acceptAll } from '../collectors/try-records.js';
import { getHudHome } from '../hud-home.js';
import { getJobIndexCache } from '../roles/job-index-cache.js';
import type { HudIO } from './hud.js';
import { CliError } from './private-home.js';
import { NO_WORKERS } from './watch-band.js';

export const ACT_HELP =
  'Usage: hud act answer <job> <qN> <answer...>   Write qa/qN.answer.md once (resumes a headless job)\n' +
  '       hud act try [--cwd DIR]                   Accept all slices to try, as the panel does\n' +
  '       hud act retry <job>                       Record a retry request; the main session decides\n' +
  '       hud act stop <job>                        Stop a job\n';

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
