/** Single-line job headings and the state marks shared by job lists and diagnostics. */
import type { WorkJob } from '../collectors/work-job.js';
import type { OwnerWorker } from '../collectors/workboard-types.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { monitorText, pair } from './monitor-text.js';
import { ageText, mark, stateMark } from './workboard-rows.js';
import { isUnreadReport, routeBadge, workerModelBadge } from './worker-roster.js';
import { activeFlow } from './work-visibility.js';
import { t } from './i18n.js';

export const failed = (card: WorkJob) => card.worker.work?.failed || ['failed', 'error'].includes(card.worker.state);
export const workStateWord = (card: WorkJob) => {
  if (card.worker.superseded) return t('superseded');
  if (card.worker.state === 'stopped') return t('stopped');
  if (card.state === 'queued') {
    return card.worker.queuePosition !== undefined
      ? t('queued #{n}', { n: card.worker.queuePosition })
      : t('queued');
  }
  if (failed(card)) return t('failed');
  if (card.state === 'needs-you') return t('asking');
  if (card.state === 'stalled') return t('stalled');
  if (card.worker.flow && activeFlow(card.worker)) return t('land');
  return '';
};
export const workStateGlyph = (card: WorkJob) => {
  if (card.worker.state === 'stopped') return stateMark.stopped();
  if (card.state === 'queued') return stateMark.queued();
  if (failed(card)) return stateMark.failed();
  if (card.state === 'needs-you') return stateMark.asking();
  if (card.state === 'stalled') return stateMark.stalled();
  if (card.state === 'in-progress') return mark('◉', '@');
  return isUnreadReport(card.worker) ? stateMark.unread() : stateMark.done();
};
export const workStateInk = (card: WorkJob) => {
  if (card.worker.superseded || card.worker.state === 'stopped' || card.state === 'queued') return theme.board.muted;
  return failed(card)
    ? theme.board.danger
    : card.state === 'needs-you'
      ? theme.board.attention
      : card.state === 'stalled'
        ? theme.board.stalled
        : card.state === 'in-progress'
          ? theme.board.active
          : theme.board.success;
};
function checkChip(checks: WorkJob['worker']['checks']): string {
  if (!checks) return '';
  const { stale, state, passed, total } = checks;
  const [glyph, ink] = stale ? [mark('~', '~'), theme.board.muted]
    : state === 'running' ? [mark('↻', '@'), theme.board.active]
    : passed === total ? [mark('✓', '+'), theme.board.success] : [mark('✗', 'x'), theme.board.danger];
  return ink(`[${glyph}${passed}/${total}]`);
}
export const roleInk = (role: string) =>
  (theme.board.roleInk as Record<string, (s: string) => string>)[role] ?? ((s: string) => s);
/** Checks, launch badge and observed state shown alongside a job's title. */
export function cardMarks(card: WorkJob, badge = '', word = workStateWord(card)): string[] {
  const ink = workStateInk(card);
  const wordInk = card.worker.flow && activeFlow(card.worker) && word === t('land') ? theme.board.active : ink;
  return [
    checkChip(card.worker.checks),
    badge,
    word ? wordInk(word) : '',
  ].filter(Boolean);
}
export function renderJobRow(card: WorkJob, width: number): string {
  const ink = workStateInk(card), marks = cardMarks(card);
  const age = theme.board.muted(ageText(card.elapsedMinutes ?? 0));
  const glyph = workStateGlyph(card);
  const role = monitorText(card.role);
  const paintedRole = card.worker.superseded ? theme.board.muted(role) : roleInk(card.role)(role);
  const prefix = `${ink(glyph)} ${paintedRole}  `;
  const titleRaw = monitorText(
    card.title + ((card.worker.nativeDepth ?? 0) > 2 && card.worker.parentName ? ` ↳ ${card.worker.parentName}` : '')
  );
  const makeRight = (lvl: '' | 'full' | 'compact' | 'min') =>
    [lvl ? workerModelBadge(card.worker, lvl) : '', routeBadge(card.worker), ...marks, age].filter(Boolean).join(' ');
  const minTitle = Math.min(visualLength(titleRaw), 26);
  let right = makeRight('');
  for (const lvl of ['full', 'compact', 'min', ''] as const) {
    const cand = makeRight(lvl);
    if (visualLength(prefix) + minTitle + 2 + visualLength(cand) <= width) {
      right = cand;
      break;
    }
  }
  const title = truncateAnsi(titleRaw, Math.max(0, width - visualLength(prefix) - visualLength(right) - 2));
  return pair(prefix + title, right, width);
}

/** The ticket's heading, else the brief's (a child under its lane header leads with the brief's); raw task text only when nothing else names the job. */
export function jobTitle(w: OwnerWorker, child: boolean): string {
  const heading = child ? (w.briefTitle ?? w.ticketTitle) : (w.ticketTitle ?? w.briefTitle);
  const text = monitorText(heading ?? (child || !w.displayId ? w.task : '')), id = monitorText(w.displayId ?? '');
  return id && text.startsWith(id) ? text.slice(id.length).replace(/^[\s:–—-]+/, '') : text;
}
