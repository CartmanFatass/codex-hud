/** Single-line job headings and the state marks shared by job lists and diagnostics. */
import { projectWorkJob, type WorkJob } from '../collectors/work-job.js';
import type { OwnerWorker, WorkLane } from '../collectors/workboard-types.js';
import type { MonitorState } from './monitor.js';
import { stripAnsi, theme, truncateAnsi, visualLength } from './colors.js';
import { monitorText, pair } from './monitor-text.js';
import { ageText, mark, stateMark } from './workboard-rows.js';
import { isUnreadReport, mainLaneWorkers, routeBadge, sonicBadge, workerModelBadge } from './worker-roster.js';
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
/** What a job's title row says between its model mark and its age: the checks chip, `badge`, `⚠ looping`, the `[outcome]` label and the state `word`. */
export function cardMarks(card: WorkJob, badge = '', word = workStateWord(card)): string[] {
  const labels = card.worker.labels, outcomeVal = labels?.outcome?.value, ink = workStateInk(card);
  const outcome =
    outcomeVal && t(outcomeVal) !== word && !(outcomeVal === 'done' && !failed(card) && card.worker.settledAt !== null)
      ? `[${t(outcomeVal)}]`
      : '';
  const wordInk = card.worker.flow && activeFlow(card.worker) && word === t('land') ? theme.board.active : ink;
  return [
    checkChip(card.worker.checks),
    badge,
    labels?.looping !== undefined ? ink(`${mark('⚠', '!')} ${t('looping')}`) : '',
    outcome ? ink(outcome) : '',
    word ? wordInk(word) : '',
  ].filter(Boolean);
}
export function renderJobRow(card: WorkJob, width: number, badge = '', sonicCount = 0): string {
  const ink = workStateInk(card), marks = cardMarks(card, badge);
  const sonic = sonicBadge(sonicCount);
  const age = theme.board.muted(ageText(card.elapsedMinutes ?? 0));
  const glyph = workStateGlyph(card);
  const role = monitorText(card.role);
  const paintedRole = card.worker.superseded ? theme.board.muted(role) : roleInk(card.role)(role);
  const prefix = `${ink(glyph)} ${paintedRole}  `;
  const titleRaw = monitorText(
    card.title + ((card.worker.nativeDepth ?? 0) > 2 && card.worker.parentName ? ` ↳ ${card.worker.parentName}` : '')
  );
  const makeRight = (lvl: '' | 'full' | 'compact' | 'min') =>
    [lvl ? workerModelBadge(card.worker, lvl) : '', routeBadge(card.worker), sonic, ...marks, age].filter(Boolean).join(' ');
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
  const text = monitorText(heading ?? (w.displayId ? '' : w.task)), id = monitorText(w.displayId ?? '');
  return id && text.startsWith(id) ? text.slice(id.length).replace(/^[\s:–—-]+/, '') : text;
}

/**
 * A lane's right side: one state glyph per non-child job, oldest dispatch first (`✓●` unread, `✓` done, `◉` running,
 * `?` asking, `✗` failed, `○` queued, `◷` stalled, `−` stopped). Older jobs that do not fit `room` are `+N`.
 */
export function laneStrip(lane: WorkLane, state: MonitorState, now: number, room: number, extra = ''): string {
  const main = mainLaneWorkers(lane);
  const cards = [...main]
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .map((w) => projectWorkJob(w, now, state.prefs.cardStallMinutes));
  if (!cards.length) return extra;
  const glyph = {
    unread: theme.board.success(stateMark.unread()),
    done: theme.board.success(stateMark.done()),
    run: theme.board.active(mark('◉', '@')),
    queue: theme.board.muted(stateMark.queued()),
    stall: theme.board.stalled(stateMark.stalled()),
    ask: theme.board.attention(stateMark.asking()),
    fail: theme.board.danger(stateMark.failed()),
    stop: theme.board.muted(stateMark.stopped()),
  };
  const tokens = cards.map((c) => {
    const kind =
      c.worker.state === 'stopped'
        ? 'stop'
        : failed(c)
          ? 'fail'
          : c.state === 'needs-you'
            ? 'ask'
            : c.state === 'queued'
              ? 'queue'
              : c.state === 'stalled'
                ? 'stall'
                : c.state === 'in-progress'
                  ? 'run'
                  : isUnreadReport(c.worker)
                    ? 'unread'
                    : 'done';
    const painted = glyph[kind];
    return c.worker.superseded ? theme.board.muted(stripAnsi(painted)) : painted;
  });
  const tail = extra ? ' ' + extra : '';
  let keep = tokens.length;
  const measure = (n: number) => {
    const slice = tokens.slice(-n);
    const olderW = n < tokens.length ? String(tokens.length - n).length + 2 : 0;
    return olderW + slice.reduce((sum, tok) => sum + visualLength(tok), 0) + Math.max(0, slice.length - 1);
  };
  while (keep > 1 && measure(keep) + visualLength(tail) > room) keep--;
  const older = tokens.length - keep ? theme.board.muted(`+${tokens.length - keep}`) + ' ' : '';
  return older + tokens.slice(-keep).join(' ') + tail;
}
