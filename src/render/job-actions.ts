/**
 * The owner's micro-actions on a HUD job (spec §2.2): `g` focuses its herdr tab, `1`–`4` and `d` answer its open question
 * straight away while the question slab is expanded (or in the Inspector), `X` asks to stop it. Pure: input here becomes an
 * outcome, `tree-page.ts` does the I/O. No digit switches a tab, so an expanded slab is the only place a digit means anything.
 */
import { join } from 'node:path';
import { targetKey, type OwnerWorker, type WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';
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

/** The keys an open question takes, for the slab's footer and the Inspector: `1-2 answer  d default`. Empty without an option or a default. */
export function answerKeys(worker: OwnerWorker): string[] {
  const a = answerable(worker);
  return !a ? [] : [a.options.length ? `${a.options.length === 1 ? '1' : `1-${a.options.length}`} ${t('answer')}` : '', a.suggested ? `d ${t('default')}` : ''].filter(Boolean);
}
/** The one-row prompt above the page while a stop waits for its answer. */
export function stopPromptRows(state: MonitorState, width: number): MonitorRow[] {
  const stop = state.confirmStop;
  return stop ? [boardRow(fit(theme.board.attention(t('Stop {role} {id}?  y confirm · Esc cancel', { role: monitorText(stop.role), id: stop.jobId.slice(0, 8) })), width))] : [];
}

/** `g`, `X` and the answer keys on the job under the cursor. Anything else (including `g` with no job: the top of the list) is Home's own. */
export function openJobAction(next: MonitorState, input: WorkbenchInput, key: string, board: WorkboardSnapshot | undefined, result: (action?: MonitorOutcome['action']) => MonitorOutcome): MonitorOutcome | undefined {
  if (input.type !== 'key') return undefined;
  const digit = /^[1-4]$/.exec(input.text ?? '')?.[0], answering = digit !== undefined || key === 'answer-default';
  if (!answering && !(key === 'stop-job' || (key === 'home' && input.text === 'g'))) return undefined;
  const job = jobUnderCursor(next, board);
  if (!job) return undefined;
  if (key === 'home') return result({ type: 'focus-job-tab', dir: job.dir });
  if (key === 'stop-job') {
    if (job.worker.settledAt !== null) return undefined;
    next.confirmStop = { jobId: job.jobId, role: job.worker.role ?? 'job', dir: job.dir };
    return result();
  }
  // The slab has to be open (its options are numbered there): a digit on a collapsed card is not an answer.
  const a = answerable(job.worker);
  if (!a || (next.focus !== 'details' && !next.boardExpanded?.has(targetKey(job.target)))) return undefined;
  const answer = digit ? a.options[Number(digit) - 1] : a.suggested;
  return answer ? result({ type: 'answer-job', home: job.home, jobId: a.jobId, qid: a.qid, answer, role: job.worker.role }) : undefined;
}

/** While a stop prompt is open it owns the keyboard: `y` or Enter stops, anything else cancels. */
export function jobModalInput(state: MonitorState, input: WorkbenchInput): MonitorOutcome | null {
  const { confirmStop } = state;
  if (!confirmStop) return null;
  const confirmed = input.type === 'key' && (input.key === 'enter' || input.text === 'y');
  return { state: { ...state, confirmStop: undefined }, close: false, action: confirmed ? { type: 'stop-job', dir: confirmStop.dir } : undefined };
}
