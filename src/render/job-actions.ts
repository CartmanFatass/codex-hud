/**
 * The owner's micro-actions on a HUD job (spec §2.2): `g` focuses its herdr tab, `r` opens a reply on its open question where
 * `1`–`4` pick an option and `d` the default, `X` asks to stop it. Pure: input here becomes an outcome, `tree-page.ts` does the I/O.
 * `1`–`4` switch tabs everywhere else, so an answer is two keys and the second one is only an answer while the reply is open.
 */
import { join } from 'node:path';
import { targetKey, type OwnerWorker, type WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';
import { theme } from './colors.js';
import { fit, monitorText } from './monitor-text.js';
import { boardRow } from './workboard-rows.js';
import { t } from './i18n.js';

const THIN = /^thin-job:(j[0-9a-f]{16})$/;
const idOf = (worker: OwnerWorker) => THIN.exec(worker.id)?.[1];

/** The HUD job the owner is on: Home's selected card (Classic or Split), or the one open in the Inspector. */
export function jobUnderCursor(state: MonitorState, board: WorkboardSnapshot | undefined) {
  const target = state.focus === 'details' ? state.boardInspect
    : state.focus === 'agents' && state.mainTab === 'home' && !state.boardAnchor ? state.homeTarget : undefined;
  if (target?.kind !== 'worker') return undefined;
  const lane = board?.lanes.find((l) => l.id === target.laneId), worker = lane?.workers.find((w) => w.id === target.workerId);
  const jobId = worker && idOf(worker);
  if (!lane || !worker || !jobId || lane.identity.kind !== 'invocation') return undefined;
  return { worker, jobId, home: lane.identity.home, dir: join(lane.identity.home, 'jobs', jobId), target };
}

/** An open `qN` of a HUD job with something to pick: up to four options and the worker's default (a pane ask has no file to answer). */
export function answerable(worker: OwnerWorker): { jobId: string; qid: string; options: readonly string[]; suggested: string } | undefined {
  const r = worker.work?.requestInfo, jobId = idOf(worker);
  if (!worker.homeNeedsHuman || !r || !jobId || !/^q\d+$/.test(r.id) || r.evidence?.relativePath !== `qa/${r.id}.md`) return undefined;
  const options = r.options.slice(0, 4);
  return options.length || r.suggested ? { jobId, qid: r.id, options, suggested: r.suggested } : undefined;
}

/** What the footer of a question being answered says: the keys the reply takes. Empty unless its reply is open. */
export function replyHint(worker: OwnerWorker, state: MonitorState): string {
  const a = answerable(worker);
  if (!a || state.reply?.jobId !== a.jobId || state.reply.qid !== a.qid) return '';
  return [a.options.length ? `1-${a.options.length} ${t('answer')}` : '', a.suggested ? `d ${t('default')}` : '', t('Esc cancel')].filter(Boolean).join('  ');
}
/** The one-row prompt above the page while a stop waits for its answer. */
export function stopPromptRows(state: MonitorState, width: number): MonitorRow[] {
  const stop = state.confirmStop;
  return stop ? [boardRow(fit(theme.board.attention(t('Stop {role} {id}?  y confirm · Esc cancel', { role: monitorText(stop.role), id: stop.jobId.slice(0, 8) })), width))] : [];
}

/** `g`, `r` and `X` on the job under the cursor. Anything else (including `g` with no job: the top of the list) is Home's own. */
export function openJobAction(next: MonitorState, input: WorkbenchInput, key: string, board: WorkboardSnapshot | undefined, result: (action?: MonitorOutcome['action']) => MonitorOutcome): MonitorOutcome | undefined {
  if (input.type !== 'key' || !['home', 'reset', 'stop-job'].includes(key) || (key === 'home' && input.text !== 'g')) return undefined;
  const job = jobUnderCursor(next, board);
  if (!job) return undefined;
  if (key === 'home') return result({ type: 'focus-job-tab', dir: job.dir });
  if (key === 'stop-job') {
    if (job.worker.settledAt !== null) return undefined;
    next.confirmStop = { jobId: job.jobId, role: job.worker.role ?? 'job', dir: job.dir };
    return result();
  }
  const a = answerable(job.worker);
  if (!a) return undefined;
  // The reply shows the whole question and its options, so the card is opened for it.
  next.boardExpanded = new Set([...(next.boardExpanded ?? []), targetKey(job.target)]);
  next.reply = { jobId: a.jobId, qid: a.qid };
  return result();
}

/** While a reply or a stop prompt is open it owns the keyboard: its keys act, `1`–`4` past the options wait, anything else cancels. */
export function jobModalInput(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome | null {
  const { reply, confirmStop } = state;
  if (!reply && !confirmStop) return null;
  const done = (action?: MonitorOutcome['action'], keep = false): MonitorOutcome => ({ state: keep ? state : { ...state, reply: undefined, confirmStop: undefined }, close: false, action });
  if (confirmStop) return done(input.type === 'key' && (input.key === 'enter' || input.text === 'y') ? { type: 'stop-job', dir: confirmStop.dir } : undefined);
  const job = jobUnderCursor(state, ctx.frame?.workboard?.snapshot), a = job && answerable(job.worker);
  const digit = input.type === 'key' ? /^[1-4]$/.exec(input.text ?? '')?.[0] : undefined;
  const wants = digit ? 'option' : input.type === 'key' && input.key === 'answer-default' ? 'default' : undefined;
  if (!job || !a || a.jobId !== reply!.jobId || a.qid !== reply!.qid || !wants) return done();
  const answer = wants === 'default' ? a.suggested : a.options[Number(digit) - 1];
  return answer ? done({ type: 'answer-job', home: job.home, jobId: a.jobId, qid: a.qid, answer, role: job.worker.role }) : done(undefined, true);
}
