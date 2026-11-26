/** Feature sub-page: crumb, stacked bar with legend, and tickets ordered by state with observed job status. No I/O. */
import { basename } from 'node:path';
import type { ExecutionRunJobTarget, LandProgress, TicketActivity } from '../collectors/execution.js';
import { ENDED_MS } from '../collectors/execution-runs.js';
import { SETTLED_JOB_STATES, type ProjectSnapshot, type ProjectTicket, type SliceState, type TicketFeature } from '../collectors/project-board.js';
import { targetKey, ticketRowKey } from '../collectors/ticket-evidence.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { t } from './i18n.js';
import type { MonitorRow } from './monitor.js';
import type { FeatureDetail } from './monitor-state.js';
import { fit, monitorText, pair } from './monitor-text.js';
import { linkedTicketProgress, sliceInk } from './progress-bar.js';
import { ticketProgressText, ticketTrack } from './project-objectives.js';
import { clampLines, cutTicketTitle, ticketGlyph } from './project-view.js';
import { boardRow, compactAge, mark, section, stateMark } from './workboard-rows.js';

const TICKET_ORDER: Record<ProjectTicket['state'], number> = {
  try: 0,
  working: 1,
  blocked: 2,
  ready: 3,
  queued: 4,
  done: 5,
  dropped: 6,
};

const LEGEND_ORDER: readonly [SliceState, string][] = [
  ['accepted', 'done'],
  ['try', 'to try'],
  ['working', 'working'],
  ['blocked', 'blocked'],
  ['todo', 'todo'],
  ['dropped', 'dropped'],
];

/** Locate a scanned feature by slug across linked Objective features, Tickets preview and Unlinked features. */
export function findProjectFeature(project: ProjectSnapshot | undefined, slug: string): TicketFeature | undefined {
  return project?.objectiveTickets?.find((f) => f.slug === slug)
    ?? project?.tickets.find((f) => f.slug === slug)
    ?? project?.unlinked?.find((f) => f.slug === slug);
}

const MIN_ANCESTOR = 4;

/** Keep the feature slug intact within `width - 2`; shorten or omit ancestors first. */
function fitFeatureCrumb(ancestors: readonly string[], slugLabel: string, sep: string, width: number): string {
  const maxCrumb = Math.max(0, width - 2);
  const sepWidth = visualLength(sep);
  const ancestorRoom = maxCrumb - visualLength(slugLabel);
  let kept = [...ancestors];
  if (kept.length === 2) {
    const textRoom = ancestorRoom - 2 * sepWidth;
    if (textRoom < 2 * MIN_ANCESTOR) {
      kept = kept.slice(1);
    } else {
      let a = visualLength(kept[0]!), b = visualLength(kept[1]!);
      while (a + b > textRoom) {
        if (a >= b && a > MIN_ANCESTOR) a--;
        else if (b > MIN_ANCESTOR) b--;
        else break;
      }
      kept = [truncateAnsi(kept[0]!, a), truncateAnsi(kept[1]!, b)];
    }
  }
  if (kept.length === 1) {
    const textRoom = ancestorRoom - sepWidth;
    if (textRoom < MIN_ANCESTOR) kept = [];
    else kept = [truncateAnsi(kept[0]!, textRoom)];
  }
  return [...kept, slugLabel].join(sep);
}

/** Crumb ending in the feature slug; the project name leaves below 56 columns. */
export function featureCrumb(
  detail: FeatureDetail,
  project: ProjectSnapshot | undefined,
  projectName: string | undefined,
  width: number,
): { crumb: string; right: string } {
  const { root, slug, objectiveId } = detail.target;
  const sep = ` ${mark('›', '>')} `;
  const slugLabel = monitorText(slug);
  const objLabel = objectiveId ? monitorText(objectiveId) : '';
  const projLabel = truncateAnsi(monitorText(projectName || basename(root) || t('Project')), 16);
  const ancestors = [
    ...(width >= 56 ? [projLabel] : []),
    ...(objLabel ? [objLabel] : []),
  ];
  const crumb = fitFeatureCrumb(ancestors, slugLabel, sep, width);

  const feature = findProjectFeature(project, slug);
  const ratio = feature ? ticketProgressText(linkedTicketProgress(new Map([[feature.slug, feature]]), [feature.slug])) : '';
  const candidates = feature?.partial
    ? [t('Partial')]
    : [
        ...(width >= 56 && ratio ? [t('{count} tickets', { count: ratio })] : []),
        ...(ratio ? [ratio] : []),
      ];
  const right = candidates.find((text) => text && visualLength(crumb) + 4 + visualLength(text) <= width) ?? '';
  return { crumb, right };
}

function landProgressText(progress: LandProgress | undefined, at: number | undefined, now: number): string {
  const ink = theme.board;
  if (!progress) return ink.active(t('Gate'));
  if (progress.kind === 'lease') {
    const age = compactAge(progress.since ?? at, now);
    return `${ink.active(`${mark('◷', '~')} ${t('Lease wait')}`)}${age ? ` ${ink.muted(age)}` : ''}`;
  }
  const index = progress.index === undefined ? '' : ` ${progress.index}${progress.total === undefined ? '' : `/${progress.total}`}`;
  if (progress.kind === 'repair') return ink.active(`${mark('↻', '~')} ${t('Repair')}${index}`);
  return ink.active(`${t('Gate')}${index}`);
}

function liveJobText(
  state: Extract<TicketActivity, { kind: 'live' }>['state'],
  at: number | undefined,
  now: number,
): string {
  const ink = theme.board;
  const age = compactAge(at, now);
  const agePart = age ? ` ${ink.muted(age)}` : '';
  switch (state) {
    case 'asking': return `${ink.attention(`${stateMark.asking()} ${t('asking')}`)}${agePart}`;
    case 'waiting': return `${ink.attention(`${stateMark.asking()} ${t('waiting for main')}`)}${agePart}`;
    case 'stalled': return `${ink.stalled(`${stateMark.stalled()} ${t('stalled')}`)}${agePart}`;
    case 'queued': return `${ink.muted(`${stateMark.queued()} ${t('queued')}`)}${agePart}`;
    default: return `${ink.active(`${mark('◐', '@')} ${t('working')}`)}${agePart}`;
  }
}

function endedJobText(result: Extract<TicketActivity, { kind: 'ended' }>['result'], at: number, now: number): string {
  const ink = theme.board;
  const age = compactAge(at, now);
  const agePart = age ? ` ${ink.muted(age)}` : '';
  switch (result) {
    case 'landed': return `${ink.success(`${mark('✓', '+')} ${t('landed')}`)}${agePart}`;
    case 'not landed': return `${ink.muted(`${mark('◒', 'o')} ${t('not landed')}`)}${agePart}`;
    case 'done': return `${ink.success(`${mark('✓', '+')} ${t('done')}`)}${agePart}`;
    case 'failed': return `${ink.danger(`${mark('✗', 'x')} ${t('failed')}`)}${agePart}`;
    case 'stopped': return `${ink.muted(`${mark('−', '-')} ${t('stopped')}`)}${agePart}`;
    default: return `${ink.muted(`${mark('◒', 'o')} ${t('ended')}`)}${agePart}`;
  }
}

function ticketJobEvidence(
  ticket: ProjectTicket,
  entries: readonly TicketActivity[],
  now: number,
): { statusText?: string; execJob?: ExecutionRunJobTarget; endedAt?: number } {
  const recent = (at: number) => at <= now && now - at <= ENDED_MS;
  const gates = entries.filter((e): e is Extract<TicketActivity, { kind: 'gate' }> => e.kind === 'gate');
  const lives = entries.filter((e): e is Extract<TicketActivity, { kind: 'live' }> => e.kind === 'live');
  const ended = entries
    .filter((e): e is Extract<TicketActivity, { kind: 'ended' }> => e.kind === 'ended' && recent(e.at))
    .sort((a, b) => b.at - a.at || Number(!!b.execJob) - Number(!!a.execJob) || Number(!!b.result) - Number(!!a.result));
  const fallbackExecJob = lives.find((e) => e.execJob)?.execJob ?? ended.find((e) => e.execJob)?.execJob;
  const latestEndedAt = ended[0]?.at;

  if (gates.length) {
    const gate = [...gates].sort((a, b) =>
      Number(!!b.progress) - Number(!!a.progress)
      || Number(!!b.execJob) - Number(!!a.execJob)
      || (b.at ?? 0) - (a.at ?? 0))[0];
    return {
      statusText: landProgressText(gate.progress, gate.at, now),
      execJob: gate.execJob ?? fallbackExecJob,
      endedAt: latestEndedAt,
    };
  }
  if (lives.length) {
    const live = [...lives].sort((a, b) =>
      Number(!!b.execJob) - Number(!!a.execJob) || (b.at ?? 0) - (a.at ?? 0))[0];
    return {
      statusText: liveJobText(live.state, live.startedAt ?? live.at, now),
      execJob: live.execJob,
      endedAt: latestEndedAt,
    };
  }
  if (ticket.job && !SETTLED_JOB_STATES.has(ticket.job.state)) {
    const state = ticket.job.state === 'queued' ? 'queued'
      : ticket.job.state === 'waiting_orchestrator' || ticket.job.state === 'blocked' ? 'waiting'
      : 'working';
    return { statusText: liveJobText(state, ticket.job.at, now), endedAt: latestEndedAt };
  }
  if (ticket.landingAt !== undefined && recent(ticket.landingAt)) {
    return { statusText: endedJobText('landed', ticket.landingAt, now), execJob: fallbackExecJob, endedAt: ticket.landingAt };
  }
  if (ended.length) {
    const latest = ended[0];
    return {
      statusText: endedJobText(latest.result, latest.at, now),
      execJob: latest.execJob,
      endedAt: latest.at,
    };
  }
  return {};
}

function ticketStateLabel(ticket: ProjectTicket): string {
  const ink = theme.board;
  switch (ticket.state) {
    case 'try': return sliceInk('try')(t('to try'));
    case 'working': return ink.active(t('working'));
    case 'blocked': return ink.attention(t('blocked'));
    case 'ready': return ink.muted(t('ready'));
    case 'queued': return ink.muted(t('Queued'));
    case 'done': return ink.success(t('done'));
    case 'dropped': return ink.muted(t('dropped'));
  }
}

function legendRows(tickets: readonly ProjectTicket[], width: number): MonitorRow[] {
  const counts: Record<SliceState, number> = { accepted: 0, try: 0, working: 0, blocked: 0, todo: 0, dropped: 0 };
  for (const { state } of tickets) {
    counts[state === 'done' ? 'accepted' : state === 'ready' || state === 'queued' ? 'todo' : state]++;
  }
  const tokens = LEGEND_ORDER
    .filter(([state]) => counts[state] > 0)
    .map(([state, word]) => `${t(word)} ${counts[state]}`);
  if (!tokens.length) return [];
  const lines: string[] = [];
  let line = '';
  for (const token of tokens) {
    const candidate = line ? `${line} · ${token}` : token;
    if (line && visualLength(candidate) + 2 > width) {
      lines.push(line);
      line = token;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.map((text) => boardRow(fit(`  ${theme.board.muted(text)}`, width)));
}

export function featureDetailRows(
  detail: FeatureDetail,
  width: number,
  now: number,
  project?: ProjectSnapshot,
  activity: readonly TicketActivity[] = [],
  landings?: ReadonlyMap<string, number>,
): MonitorRow[] {
  const ink = theme.board;
  if (!project) return [boardRow(fit(`  ${ink.muted(t('Loading…'))}`, width))];
  const feature = findProjectFeature(project, detail.target.slug);
  if (!feature) return [boardRow(fit(`  ${ink.muted(t('Feature not available'))}`, width))];

  const rows: MonitorRow[] = [];
  const progress = linkedTicketProgress(new Map([[feature.slug, feature]]), [feature.slug]);
  const barCells = Math.min(36, Math.max(0, width - 4));
  rows.push(boardRow(fit(`  ${ticketTrack(progress, barCells, false)}`, width)));
  rows.push(...legendRows(feature.tickets, width));

  const byTicket = new Map<string, TicketActivity[]>();
  for (const entry of activity) {
    const key = targetKey(entry.ticket);
    const list = byTicket.get(key);
    if (list) list.push(entry);
    else byTicket.set(key, [entry]);
  }
  const ledgerAt = new Map<string, number>();
  for (const row of project.ledger) {
    if (row.at !== undefined) ledgerAt.set(targetKey(row.id), row.at);
  }

  const enriched = feature.tickets.map((ticket) => {
    const key = targetKey(`${feature.slug}/${ticket.number}`);
    const entries = byTicket.get(key) ?? [];
    const evidence = ticketJobEvidence(ticket, entries, now);
    const latest = (result: 'landed' | 'done') => entries.reduce<number | undefined>((at, entry) =>
      entry.kind === 'ended' && entry.result === result && entry.at <= now && (at === undefined || entry.at > at) ? entry.at : at, undefined);
    const doneAt = ticket.state === 'done'
      ? ticket.landingAt ?? landings?.get(key) ?? latest('landed') ?? ledgerAt.get(key) ?? latest('done') ?? ticket.job?.completedAt ?? ticket.at
      : Math.max(evidence.endedAt ?? -Infinity, ledgerAt.get(key) ?? -Infinity, ticket.at);
    return { ticket, evidence, doneAt };
  });

  enriched.sort((a, b) => {
    const rank = TICKET_ORDER[a.ticket.state] - TICKET_ORDER[b.ticket.state];
    if (rank) return rank;
    if (a.ticket.state === 'done' || a.ticket.state === 'dropped') {
      return b.doneAt - a.doneAt || Number(b.ticket.number) - Number(a.ticket.number) || a.ticket.path.localeCompare(b.ticket.path);
    }
    return Number(a.ticket.number) - Number(b.ticket.number) || a.ticket.path.localeCompare(b.ticket.path);
  });

  const rightCount = feature.partial ? `${t('Partial')} · ${feature.tickets.length}` : String(feature.tickets.length);
  rows.push(section(t('Tickets'), width, rightCount));

  if (!enriched.length) {
    rows.push(boardRow(fit(`  ${ink.muted(t('none'))}`, width)));
    return rows;
  }

  const expanded = new Set(detail.expanded ?? []);
  for (const { ticket, evidence } of enriched) {
    const item = `feature:ticket:${feature.slug}:${ticketRowKey(ticket)}`;
    const number = monitorText(ticket.number);
    const prefix = `  ${ticketGlyph(ticket)} ${number} `;
    const cleanTitle = monitorText(ticket.title);
    const minTitle = Math.min(visualLength(cleanTitle), 10);
    const word = ticketStateLabel(ticket);
    const blockers = ticket.blockers.length
      ? ink.muted(`${mark('←', '<')} ${monitorText(ticket.blockers.join(', '))}`)
      : '';
    const status = evidence.statusText;
    const stateAndStatus = status ? `${word}  ${status}` : word;
    const rightCandidates = [
      ...(blockers ? [`${word} ${blockers}${status ? `  ${status}` : ''}`] : []),
      stateAndStatus,
      ...(status ? [status] : []),
    ];
    const right = rightCandidates.find((cand) => visualLength(prefix) + minTitle + 1 + visualLength(cand) <= width)
      ?? rightCandidates.at(-1) ?? '';
    const titleRoom = Math.max(0, width - visualLength(prefix) - (right ? visualLength(right) + 1 : 0));
    const title = cutTicketTitle(ticket.title, titleRoom);
    const left = `${prefix}${ticket.state === 'dropped' ? ink.muted(title) : title}`;
    rows.push({
      text: fit(pair(left, right, width), width),
      item,
      files: [ticket.path],
      ...(evidence.execJob ? { execJob: evidence.execJob } : {}),
    });

    if (!evidence.execJob && expanded.has(item)) {
      for (const check of ticket.items) {
        clampLines(check.text, Math.max(1, width - 6), 2).lines.forEach((line, k) => {
          const checkMark = k ? '  ' : `${check.done ? ink.success(mark('✓', '+')) : ink.muted(mark('○', 'o'))} `;
          rows.push({ text: fit(`    ${checkMark}${line}`, width), item, files: [ticket.path] });
        });
      }
      if (!ticket.items.length) {
        rows.push({ text: fit(`    ${ink.muted(t('no checklist'))}`, width), item, files: [ticket.path] });
      }
      const comments = [ticket.landedComment, ticket.comment].filter((c): c is string => Boolean(c));
      for (const text of comments) {
        const labelWord = t('comment');
        const labelCol = Math.max(visualLength(labelWord) + 1, width >= 56 ? 9 : visualLength(labelWord) + 1);
        const label = fit(labelWord, labelCol);
        const room = Math.max(1, width - 4 - visualLength(label));
        clampLines(text, room, 4).lines.forEach((line, k) => {
          rows.push({
            text: fit(`    ${k ? ' '.repeat(visualLength(label)) : ink.muted(label)}${line}`, width),
            item,
            files: [ticket.path],
          });
        });
      }
    }
  }

  return rows;
}
