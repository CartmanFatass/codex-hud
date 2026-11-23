/** Inspector actions are pure; the panel applies focus, answer, retry and confirmed stop. */
import { join } from 'node:path';
import type { OwnerWorker, WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';
import { theme } from './colors.js';
import { fit, monitorText } from './monitor-text.js';
import { boardRow } from './workboard-rows.js';
import { isHeadless } from './worker-roster.js';
import { t } from './i18n.js';

const THIN = /^thin-job:(j[0-9a-f]{16})$/;
const idOf = (worker: OwnerWorker) => THIN.exec(worker.id)?.[1];

export function jobUnderCursor(state: MonitorState, board: WorkboardSnapshot | undefined) {
  const target = state.subpage?.kind === 'inspector' ? state.subpage.target : undefined;
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
export function inspectorKeys(worker?: OwnerWorker): string[] {
  return ['Esc back', 'n subagents', ...(worker?.settledAt === null ? ['X stop'] : []),
    '⏎ open', ...(worker && worker.state !== 'queued' && !isHeadless(worker) ? ['g job tab'] : []),
    ...(worker?.state === 'failed' ? ['r request retry'] : [])];
}
/** The one-row prompt above the page while a stop waits for its answer. */
export function stopPromptRows(state: MonitorState, width: number): MonitorRow[] {
  const stop = state.overlay;
  return stop?.kind === 'confirm-stop' ? [boardRow(fit(theme.board.attention(t('Stop {role} {id}?  y confirm · Esc cancel', { role: monitorText(stop.role), id: stop.jobId.slice(0, 8) })), width))] : [];
}

/** Job actions are only available in Inspector, never in the job list. */
export function openJobAction(next: MonitorState, input: WorkbenchInput, key: string, board: WorkboardSnapshot | undefined, result: (action?: MonitorOutcome['action']) => MonitorOutcome): MonitorOutcome | undefined {
  if (input.type !== 'key') return undefined;
  const digit = /^[1-4]$/.exec(input.text ?? '')?.[0], answering = digit !== undefined || key === 'answer-default';
  if (!answering && !(key === 'stop-job' || input.text === 'g' || input.text === 'r')) return undefined;
  const job = jobUnderCursor(next, board);
  if (!job) return undefined;
  if (input.text === 'r') return job.worker.state === 'failed' ? result({ type: 'request-retry', home: job.home, jobId: job.jobId }) : undefined;
  if (input.text === 'g') return result(isHeadless(job.worker) || job.worker.state === 'queued' ? undefined : { type: 'focus-job-tab', dir: job.dir });
  if (key === 'stop-job') {
    if (job.worker.settledAt !== null) return undefined;
    next.overlay = { kind: 'confirm-stop', jobId: job.jobId, role: job.worker.role ?? 'job', dir: job.dir };
    return result();
  }
  const a = answerable(job.worker);
  if (!a) return undefined;
  const answer = digit ? a.options[Number(digit) - 1] : a.suggested;
  return answer ? result({ type: 'answer-job', home: job.home, jobId: a.jobId, qid: a.qid, answer, role: job.worker.role }) : undefined;
}

/** While a stop prompt is open it owns the keyboard: `y` or Enter stops, anything else cancels. */
export function jobModalInput(state: MonitorState, input: WorkbenchInput): MonitorOutcome | null {
  const stop = state.overlay;
  if (stop?.kind !== 'confirm-stop') return null;
  const confirmed = input.type === 'key' && (input.key === 'enter' || input.text === 'y');
  return { state: { ...state, overlay: undefined }, close: false, action: confirmed ? { type: 'stop-job', dir: stop.dir } : undefined };
}
