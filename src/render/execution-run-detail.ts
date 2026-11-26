/** Shared workflow state formatting and the Inspector-style Run Detail scroll view. Pure; no I/O. */
import type { ExecutionRun, ExecutionRunStep, ExecutionRunTicket, RunStepKey, RunStepState } from '../collectors/execution-runs.js';
import type { MonitorRow } from './monitor.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { fit, monitorText, pair } from './monitor-text.js';
import { roleIcon } from './model-glyphs.js';
import { flowStepDetail, stemLines } from './work-job-detail.js';
import { roleInk } from './work-job-row.js';
import { ageText, boardRow, kvRows, mark, section, stateMark } from './workboard-rows.js';
import { t } from './i18n.js';

type Ink = (text: string) => string;

const STEP_ROLE: Record<RunStepKey, string> = { tickets: 'imp', review: 'reviewer', accept: 'lead' };
const muted: Ink = (text) => theme.board.muted(text);
export const runRoleInk = (role: string): Ink => role === 'frontend-imp' ? roleInk('imp') : roleInk(role);

export function runElapsed(run: ExecutionRun, now: number): string {
  if (run.createdAt === null) return '';
  const open = run.state === 'working' || run.state === 'paused';
  const end = open ? now : (run.endedAt ?? run.updatedAt ?? now);
  return ageText(Math.max(0, Math.floor((end - run.createdAt) / 60_000)));
}

export function runStateView(state: ExecutionRun['state']): { glyph: string; ink: Ink } {
  const b = theme.board;
  if (state === 'working') return { glyph: mark('◉', '@'), ink: b.active };
  if (state === 'paused') return { glyph: mark('‖', '='), ink: b.attention };
  if (state === 'completed') return { glyph: stateMark.done(), ink: b.success };
  if (state === 'failed') return { glyph: stateMark.failed(), ink: b.danger };
  return { glyph: stateMark.stopped(), ink: muted };
}

export function stepStateView(state: RunStepState): { glyph: string; ink: Ink } {
  const b = theme.board;
  if (state === 'running') return { glyph: mark('◉', '@'), ink: b.active };
  if (state === 'asking') return { glyph: stateMark.asking(), ink: b.attention };
  if (state === 'done') return { glyph: stateMark.done(), ink: b.success };
  if (state === 'failed') return { glyph: stateMark.failed(), ink: b.danger };
  if (state === 'skipped' || state === 'cancelled') return { glyph: stateMark.stopped(), ink: muted };
  return { glyph: stateMark.queued(), ink: muted };
}

/** `tickets → review → accept` with state marks, role icons, and accept verdict. */
function formatRunStepsPlain(steps: readonly ExecutionRunStep[]): string {
  const sep = mark(' → ', ' -> ');
  return steps.map((step) => {
    const { glyph } = stepStateView(step.state);
    const icon = roleIcon(STEP_ROLE[step.key]);
    const verdict = step.verdict ? `: ${monitorText(t(step.verdict))}` : '';
    return `${glyph} ${icon} ${t(step.key)}${verdict}`;
  }).join(sep);
}

export interface TicketStagePresentation {
  glyph: string;
  ink: Ink;
  shortText: string;
  fullText: string;
}

export function ticketStageView(ticket: ExecutionRunTicket): TicketStagePresentation {
  const b = theme.board;
  switch (ticket.stage) {
    case 'landed':
      return { glyph: stateMark.done(), ink: b.success, shortText: t('landed'), fullText: t('landed') };
    case 'land-gate': {
      const word = t('land gate');
      const step = ticket.landStep ? flowStepDetail(ticket.landStep) : '';
      return { glyph: ticket.landingUnknown ? stateMark.asking() : mark('◉', '@'), ink: ticket.landingUnknown ? muted : b.active,
        shortText: word, fullText: step ? `${word} · ${step}` : word };
    }
    case 'settled':
      return { glyph: stateMark.done(), ink: muted, shortText: t('settled'), fullText: t('settled') };
    case 'worker':
      if (ticket.statusUnknown) return { glyph: stateMark.asking(), ink: muted, shortText: t('unknown'), fullText: t('unknown') };
      return ticket.asking
        ? { glyph: stateMark.asking(), ink: b.attention, shortText: t('asking'), fullText: t('asking') }
        : ticket.stalled ? { glyph: '!', ink: b.stalled, shortText: t('stalled'), fullText: t('stalled') }
          : { glyph: mark('◉', '@'), ink: b.active, shortText: t('working'), fullText: t('working') };
    case 'queued': {
      const word = t('queued');
      const by = ticket.blockers?.length ? t('blocked by {ids}', { ids: monitorText(ticket.blockers.join(', ')) }) : '';
      return { glyph: stateMark.queued(), ink: muted, shortText: word, fullText: by ? `${word} · ${by}` : word };
    }
    case 'blocked': {
      const word = t('blocked');
      const by = ticket.blockers?.length ? t('blocked by {ids}', { ids: monitorText(ticket.blockers.join(', ')) }) : '';
      return { glyph: mark('!', '!'), ink: b.attention, shortText: word, fullText: by || word };
    }
    case 'held': {
      const word = t('held');
      const tag = ticket.holdTag ? t(ticket.holdTag) : ticket.reason ? monitorText(ticket.reason.replace(/\s+/g, ' ').trim()) : '';
      return { glyph: mark('!', '!'), ink: b.attention, shortText: word, fullText: tag ? `${word} (${tag})` : word };
    }
    case 'failed': {
      const word = t('failed');
      const why = ticket.reason ? monitorText(ticket.reason.replace(/\s+/g, ' ').trim()) : '';
      return { glyph: stateMark.failed(), ink: b.danger, shortText: word, fullText: why ? `${word}: ${why}` : word };
    }
  }
}

/** Inspector-style scroll view for one workflow; queues retain full review/decision/todo detail. */
export function runDetailRows(run: ExecutionRun, width: number, now: number, diagram?: MonitorRow[]): MonitorRow[] {
  const plain = (text: string) => boardRow(fit(text, width));
  const state = runStateView(run.state);
  const elapsed = runElapsed(run, now);
  const titleLeft = `${state.ink(state.glyph)} ${monitorText(run.label)}`;
  const rows: MonitorRow[] = [
    boardRow(theme.board.title(pair(titleLeft, muted(run.flow.slice(0, 8)), width))),
    ...kvRows('Run', run.flow, width),
    ...kvRows('State', [t(run.state), run.unattended ? t('Unattended') : ''].filter(Boolean).join(' · '), width),
    ...(run.steps.length ? kvRows('Steps', formatRunStepsPlain(run.steps), width) : []),
    ...(elapsed ? kvRows('Elapsed', elapsed, width) : []),
    ...(run.verdict ? kvRows('Verdict', run.verdict, width) : []),
    ...(run.repairRounds > 0 ? kvRows('Repairs', String(run.repairRounds), width) : []),
    ...(run.reason ? kvRows('Reason', run.reason, width, theme.board.attention) : []),
    ...(run.held ? kvRows('Held', run.held.reason, width, theme.board.attention) : []),
  ];

  if (diagram) return [...rows, plain(''), section(t('Steps'), width), ...diagram];

  rows.push(plain(''), section(t('Tickets'), width, String(run.tickets.length)));
  if (!run.tickets.length) {
    rows.push(plain(`  ${muted(t('none'))}`));
  } else {
    for (const tk of run.tickets) {
      const stage = ticketStageView(tk);
      const rolePart = tk.role ? `${runRoleInk(tk.role)(roleIcon(tk.role))} ${runRoleInk(tk.role)(monitorText(tk.role))}` : '';
      const jobPart = tk.jobId ? muted(tk.jobId.slice(0, 8)) : '';
      const rightChoices = [[rolePart, jobPart].filter(Boolean).join(' '), rolePart, ''];
      const leftHead = `  ${stage.ink(stage.glyph)} ${monitorText(tk.ticket)}  `;
      const right = rightChoices.find((r) => visualLength(leftHead + stage.shortText) + (r ? visualLength(r) + 2 : 0) <= width) ?? '';
      const room = Math.max(0, width - visualLength(leftHead) - (right ? visualLength(right) + 2 : 0));
      const stageText = visualLength(stage.fullText) <= room ? stage.fullText : truncateAnsi(stage.fullText, room);
      rows.push(plain(pair(leftHead + stage.ink(stageText), right, width)));
      if (tk.reason && (tk.stage === 'held' || tk.stage === 'failed')) {
        rows.push(...stemLines(tk.reason, width, stage.ink).map((line) => boardRow(line)));
      }
    }
  }

  rows.push(plain(''), section(t('Review'), width, String(run.reviews.length)));
  if (!run.reviews.length) {
    rows.push(plain(`  ${muted(t('none'))}`));
  } else {
    for (const review of run.reviews) {
      const head = `  ${runRoleInk('reviewer')(roleIcon('reviewer'))} ${t('round {n}', { n: review.round })}`;
      const findings = review.findings
        ? [
          review.findings.blocker ? `${review.findings.blocker} ${t('blocker')}` : '',
          review.findings.major ? `${review.findings.major} ${t('major')}` : '',
          review.findings.minor ? `${review.findings.minor} ${t('minor')}` : '',
        ].filter(Boolean).join(' · ')
        : '';
      const right = [findings, review.job ? review.job.slice(0, 8) : ''].filter(Boolean).join(' · ');
      rows.push(plain(pair(head, muted(right), width)));
      if (review.summary) rows.push(...stemLines(review.summary, width).map((line) => boardRow(line)));
      if (review.reviewed) {
        const range = `${review.reviewed.base.slice(0, 7)}..${review.reviewed.head.slice(0, 7)}`;
        rows.push(...stemLines(range, width, muted).map((line) => boardRow(line)));
      }
    }
  }

  rows.push(plain(''), section(t('Decisions'), width, String(run.decisions.length)));
  if (!run.decisions.length) {
    rows.push(plain(`  ${muted(t('none'))}`));
  } else {
    for (const decision of run.decisions) {
      const lead = `  ${roleIcon('lead')} ${t(decision.step)} · ${monitorText(t(decision.decision))}${decision.ticket ? ` · ${monitorText(decision.ticket)}` : ''}`;
      const right = decision.job ? muted(decision.job.slice(0, 8)) : '';
      rows.push(plain(pair(lead, right, width)));
      if (decision.question) rows.push(...stemLines(`${t('question')}: ${decision.question}`, width, muted).map((line) => boardRow(line)));
      if (decision.reason) rows.push(...stemLines(decision.reason, width).map((line) => boardRow(line)));
      if (decision.close_error) rows.push(...stemLines(decision.close_error, width, theme.board.danger).map((line) => boardRow(line)));
    }
  }

  rows.push(plain(''), section(t('Todo'), width, String(run.todo.length)));
  if (!run.todo.length) {
    rows.push(plain(`  ${muted(t('none'))}`));
  } else {
    for (const item of run.todo) {
      rows.push(plain(`  ${muted(`[${t(item.kind)}] ${monitorText(item.source)}`)}`));
      rows.push(...stemLines(item.text, width).map((line) => boardRow(line)));
    }
  }

  return rows;
}
