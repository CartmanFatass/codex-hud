/** Shared workflow state formatting and the Inspector-style Run Detail / Station Detail scroll views. Pure; no I/O. */
import type { ExecutionRun, ExecutionRunStep, ExecutionRunTicket, MetroPoolCounts, MetroStation, RunStepKey, RunStepState } from '../collectors/execution-runs.js';
import type { MonitorRow } from './monitor.js';
import type { MetroStationInspect } from './monitor-state.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { fit, monitorText, pair } from './monitor-text.js';
import { roleIcon } from './model-glyphs.js';
import { flowStepDetail, stemLines } from './work-job-detail.js';
import { roleInk } from './work-job-row.js';
import { ageText, boardRow, compactAge, kvRows, mark, section, stateMark } from './workboard-rows.js';
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
  const waitingMain = run.state === 'paused' || (run.state === 'working' && run.handback?.kind === 'blocker');
  const rows: MonitorRow[] = [
    boardRow(theme.board.title(pair(titleLeft, muted(run.flow.slice(0, 8)), width))),
    ...kvRows('Run', run.flow, width),
    ...kvRows('State', [t(run.state), waitingMain ? t('Waiting on main') : '', run.unattended ? t('Unattended') : ''].filter(Boolean).join(' · '), width),
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

function metroStatePresentation(state: string): { glyph: string; word: string; ink: Ink } {
  const b = theme.board;
  switch (state) {
    case 'done': return { glyph: stateMark.done(), word: t('done'), ink: b.success };
    case 'working': return { glyph: mark('◉', '@'), word: t('working'), ink: b.active };
    case 'asking': return { glyph: stateMark.asking(), word: t('asking'), ink: b.attention };
    case 'held': return { glyph: mark('!', '!'), word: t('held for you'), ink: b.attention };
    case 'failed': return { glyph: stateMark.failed(), word: t('failed'), ink: b.danger };
    case 'lease': return { glyph: mark('◷', '~'), word: t('lease wait'), ink: b.text };
    case 'stalled': return { glyph: stateMark.stalled(), word: t('stalled'), ink: b.stalled };
    case 'stopped': return { glyph: stateMark.stopped(), word: t('stopped'), ink: muted };
    case 'unknown': return { glyph: mark('◌', 'u'), word: t('unknown'), ink: muted };
    default: return { glyph: stateMark.queued(), word: t('not started'), ink: muted };
  }
}

function formatPoolCounts(counts: MetroPoolCounts): string {
  const order: Array<[keyof MetroPoolCounts, string]> = [
    ['done', stateMark.done()],
    ['working', mark('◉', '@')],
    ['asking', stateMark.asking()],
    ['held', mark('!', '!')],
    ['failed', stateMark.failed()],
    ['lease', mark('◷', '~')],
    ['stalled', stateMark.stalled()],
    ['waiting', stateMark.queued()],
    ['stopped', stateMark.stopped()],
    ['unknown', mark('◌', 'u')],
  ];
  return order.flatMap(([k, glyph]) => {
    const n = counts[k];
    return n && n > 0 ? [`${n}${glyph}`] : [];
  }).join(' · ');
}

function findLiveStation(run: ExecutionRun, stationId: string): { station?: MetroStation; repair?: NonNullable<MetroStation['repair']>; host?: MetroStation } {
  for (const s of run.metro?.stations ?? []) {
    if (s.id === stationId) return { station: s };
    const reps = s.repairs?.length ? s.repairs : s.repair ? [s.repair] : [];
    const hit = reps.find((r) => r.id === stationId);
    if (hit) return { repair: hit, host: s };
  }
  return {};
}

/** Inspection view for a selectable metro station without a retained worker Inspector (pools, future tickets, main hand-back, folded groups). */
export function stationDetailRows(
  run: ExecutionRun,
  stationId: string,
  snapshot: MetroStationInspect | undefined,
  width: number,
  now: number,
): MonitorRow[] {
  const plain = (text: string) => boardRow(fit(text, width));
  const live = findLiveStation(run, stationId);
  const ticket = run.tickets.find((tk) => tk.ticket === stationId || (snapshot?.hostId && tk.ticket === snapshot.hostId));
  const kind = snapshot?.kind ?? live.station?.kind ?? 'worker';
  const rawState = live.repair?.state ?? live.station?.state ?? snapshot?.state ?? 'waiting';
  const pres = metroStatePresentation(rawState);
  const acceptSeat = live.station?.kind === 'accept' || snapshot?.kind === 'accept'
    ? (live.station?.label ?? snapshot?.label ?? (run.kind === 'queue' ? (run.acceptanceSeat ?? 'lead') : undefined))
    : undefined;
  const poolCount = live.station?.count ?? run.batch?.count ?? snapshot?.count;
  const heading = snapshot?.title
    ?? live.station?.title
    ?? (kind === 'accept' ? (acceptSeat === 'main' ? t('Hand-back (main)') : t('Lead acceptance'))
      : kind === 'review' ? t('Run review')
        : kind === 'pool' ? (poolCount !== undefined ? t('Pool of {n}', { n: poolCount }) : t('Pool'))
          : kind === 'summary' ? t('metro: summary')
            : ticket?.title ?? live.station?.label ?? stationId);
  const numPrefix = snapshot?.num && heading !== snapshot.num ? `${monitorText(snapshot.num)} ` : '';
  const titleLeft = `${pres.ink(pres.glyph)} ${numPrefix}${monitorText(heading)}`;
  const since = live.repair?.changedAt ?? live.station?.changedAt ?? snapshot?.since;
  const age = compactAge(since, now);
  const stateLine = [
    live.repair ? `${t('repair')} ${live.repair.round}/${live.repair.total}` : snapshot?.round ? `${t('repair')} ${snapshot.round}` : '',
    ticket && !live.repair ? ticketStageView(ticket).fullText : pres.word,
    age,
  ].filter(Boolean).join(' · ');

  const rows: MonitorRow[] = [
    boardRow(theme.board.title(pair(titleLeft, muted(run.flow.slice(0, 8)), width))),
    ...kvRows('Run', `${monitorText(run.label)} (${run.flow.slice(0, 8)})`, width),
    ...kvRows(ticket && !live.repair ? 'Ticket' : 'Station', ticket && !live.repair ? ticket.ticket : stationId, width),
    ...kvRows('State', stateLine, width, rawState === 'failed' ? theme.board.danger : rawState === 'asking' || rawState === 'held' ? theme.board.attention : undefined),
  ];

  const role = live.repair?.role ?? live.station?.role ?? ticket?.role ?? snapshot?.role;
  if (role) rows.push(...kvRows('Role', `${roleIcon(role)} ${role}`, width, runRoleInk(role)));
  if (acceptSeat) rows.push(...kvRows('Seat', acceptSeat === 'main' ? 'main' : t(acceptSeat), width));

  const blockers = live.station?.blockers ?? ticket?.blockers ?? ticket?.deps ?? snapshot?.blockers;
  if (blockers?.length) rows.push(...kvRows('Blocked by', blockers.map(monitorText).join(', '), width));

  const gate = live.station?.gate ?? ticket?.landGate;
  if (gate) {
    const gateText = `${gate.index}/${gate.total} (${t(gate.state)})${gate.command ? ` · ${monitorText(gate.command)}` : ''}`;
    rows.push(...kvRows('Gate', gateText, width, gate.state === 'failed' ? theme.board.danger : undefined));
  } else if (snapshot?.gate) {
    const g = snapshot.gate;
    const gateText = `${g.k}/${g.n} (${t(g.state)})${g.command ? ` · ${monitorText(g.command)}` : ''}`;
    rows.push(...kvRows('Gate', gateText, width, g.state === 'failed' ? theme.board.danger : undefined));
  }

  const repairs = live.station?.repairs ?? ticket?.landRepairs;
  if (repairs?.length) {
    rows.push(...kvRows('Repairs', repairs.map((r) => `${r.round}/${r.total} ${t(r.state)}`).join(' · '), width));
  }

  const jobId = live.repair?.jobId ?? live.station?.jobId ?? ticket?.jobId ?? snapshot?.jobId;
  if (jobId) rows.push(...kvRows('Job', `${jobId} · ${t('Job not retained')}`, width, muted));

  const holdTag = live.station?.holdTag ?? ticket?.holdTag ?? snapshot?.holdTag;
  const reason = live.repair?.reason ?? live.station?.reason ?? ticket?.reason ?? snapshot?.reason;
  if (holdTag) rows.push(...kvRows('Held', t(holdTag), width, theme.board.attention));
  if (reason) rows.push(...kvRows('Reason', reason, width, rawState === 'failed' ? theme.board.danger : theme.board.attention));

  // Batch pool facts (slots, pilots, totals).
  if (run.kind === 'batch' && run.batch && (kind === 'pool' || stationId === 'pool' || stationId === 'pilot' || stationId === 'summary')) {
    const { batch } = run;
    if (batch.slots !== undefined) rows.push(...kvRows('Slots', `${batch.totals.running}/${batch.slots}`, width));
    const countsText = formatPoolCounts({
      done: batch.totals.done, working: batch.totals.running, waiting: batch.totals.waiting,
      failed: batch.totals.failed, stopped: batch.totals.cancelled,
    });
    if (countsText) rows.push(...kvRows('Counts', countsText, width));
    if (batch.pilots && batch.pilots.total > 0) {
      rows.push(...kvRows('Pilot', `${batch.pilots.done}/${batch.pilots.total} · ${t(batch.pilots.state)}`, width));
    }
    if (batch.reason && !reason) rows.push(...kvRows('Reason', batch.reason, width, theme.board.attention));
  } else if (kind === 'pool' || kind === 'group') {
    const counts = live.station?.pool ?? snapshot?.counts;
    const countsText = counts ? formatPoolCounts(counts) : '';
    if (countsText) rows.push(...kvRows('Counts', countsText, width));
  }

  // Hand-back / acceptance facts, scoped to this station's step.
  if (kind === 'accept') {
    const stepKey = run.kind === 'queue' ? 'accept' : stationId;
    const acceptStep = run.steps.find((s) => s.key === 'accept');
    const verdict = acceptStep?.verdict ?? (rawState !== 'waiting' ? run.verdict : undefined);
    if (verdict) rows.push(...kvRows('Verdict', verdict, width));
    const handbackBelongs = run.handback?.step === stepKey;
    if (handbackBelongs && run.handback) {
      const hb = [run.handback.step ? t(run.handback.step) : '', run.handback.ticket ?? '', run.handback.question ?? ''].filter(Boolean).join(' · ');
      if (hb) rows.push(...kvRows('Hand-back', hb, width, theme.board.attention));
      if (run.handback.choices?.length) rows.push(...kvRows('Decisions', run.handback.choices.join(' · '), width));
    }
    const holdBelongs = rawState !== 'waiting' && (
      run.handback
        ? handbackBelongs
        : (acceptStep?.state === 'asking' || acceptStep?.state === 'failed' || rawState === 'asking' || rawState === 'held' || rawState === 'failed')
    );
    if (holdBelongs && run.held && !reason) rows.push(...kvRows('Held', run.held.reason, width, theme.board.attention));
    if (holdBelongs && run.reason && !reason) rows.push(...kvRows('Reason', run.reason, width, theme.board.attention));
    const acceptDecisions = run.decisions.filter((d) => d.step === stepKey);
    if (acceptDecisions.length) {
      rows.push(plain(''), section(t('Decisions'), width, String(acceptDecisions.length)));
      for (const d of acceptDecisions) {
        rows.push(plain(pair(`  ${roleIcon('lead')} ${monitorText(t(d.decision))}`, d.job ? muted(d.job.slice(0, 8)) : '', width)));
        if (d.reason) rows.push(...stemLines(d.reason, width).map((line) => boardRow(line)));
      }
    }
  }

  // Review station facts.
  if (kind === 'review' && run.reviews.length) {
    rows.push(plain(''), section(t('Review'), width, String(run.reviews.length)));
    for (const review of run.reviews) {
      const head = `  ${runRoleInk('reviewer')(roleIcon('reviewer'))} ${t('round {n}', { n: review.round })}`;
      rows.push(plain(pair(head, review.job ? muted(review.job.slice(0, 8)) : '', width)));
      if (review.summary) rows.push(...stemLines(review.summary, width).map((line) => boardRow(line)));
    }
  }

  // Folded group or overflow pool member listing.
  if (snapshot?.groupedIds?.length) {
    rows.push(plain(''), section(t('Items'), width, String(snapshot.groupedIds.length)));
    const metroById = new Map((run.metro?.stations ?? []).map((s) => [s.id, s]));
    const ticketById = new Map(run.tickets.map((tk) => [tk.ticket, tk]));
    for (const memberId of snapshot.groupedIds) {
      const ms = metroById.get(memberId);
      const mt = ticketById.get(memberId);
      const st = metroStatePresentation(ms?.state ?? (mt?.stage === 'landed' || mt?.stage === 'settled' ? 'done' : 'waiting'));
      const label = [monitorText(memberId), monitorText(ms?.title ?? mt?.title ?? ms?.label ?? '')].filter(Boolean).join('  ');
      const right = mt ? ticketStageView(mt).shortText : st.word;
      rows.push(plain(pair(`  ${st.ink(st.glyph)} ${label}`, st.ink(right), width)));
    }
  }

  return rows;
}
