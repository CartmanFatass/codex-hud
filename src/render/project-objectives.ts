/** Project Objective tiers and ticket meters; all activity is collected before paint. */
import { dirname } from 'node:path';
import type { TicketActivity } from '../collectors/execution.js';
import { ENDED_MS } from '../collectors/execution-runs.js';
import { blockedObjectives, SETTLED_JOB_STATES, type ProjectSnapshot, type TicketFeature } from '../collectors/project-board.js';
import { targetKey } from '../collectors/ticket-evidence.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { t } from './i18n.js';
import { cutSentence, fit, monitorText, pair, tokenColumn } from './monitor-text.js';
import type { MonitorRow } from './monitor.js';
import { barText, linkedTicketProgress, TICKET_BAR_ORDER } from './progress-bar.js';
import { compactAge, mark, section } from './workboard-rows.js';

export const OBJECTIVE_FOLD = 'objectives:closed';
export const UNLINKED_ITEM = 'project:page:unlinked';

export const resolvedTicket = ({ state }: TicketFeature['tickets'][number]) => state === 'done' || state === 'dropped';
export const ticketProgressText = (p: ReturnType<typeof linkedTicketProgress>) => p?.total ? `${p.counts.accepted}/${p.total}` : '';
export const ticketTrack = (p: ReturnType<typeof linkedTicketProgress>, cells: number, dim: boolean) => !p ? theme.board.muted(mark('—', '-'))
  : p.total ? barText(p, cells, TICKET_BAR_ORDER, dim) : theme.board.frame(mark('╌', '.').repeat(cells));

/** Group live, gate and recent-24h ended ticket activity by feature slug, merging ticket-scan claims and Git landings. */
export function collectFeatureActivity(
  scanned: ReadonlyMap<string, TicketFeature>,
  ledger: ProjectSnapshot['ledger'],
  activity: readonly TicketActivity[],
  now: number,
): Map<string, TicketActivity[]> {
  const jobTickets = new Map([...scanned.values()].flatMap(({ slug, tickets }) => tickets.flatMap(({ number, job }) =>
    job?.id ? [[job.id, targetKey(`${slug}/${number}`)] as const] : [])));
  const byFeature = new Map<string, TicketActivity[]>();
  const recent = (at: number) => at <= now && now - at <= ENDED_MS;
  const add = (entry: TicketActivity) => {
    const ticket = (entry.kind === 'live' ? jobTickets.get(entry.jobId) : undefined) ?? targetKey(entry.ticket);
    const slug = /^([a-z0-9_-]+)\/\d+$/.exec(ticket)?.[1];
    if (!slug || (entry.kind === 'ended' && !recent(entry.at))) return;
    const list = byFeature.get(slug);
    if (list) list.push({ ...entry, ticket });
    else byFeature.set(slug, [{ ...entry, ticket }]);
  };
  for (const entry of activity) add(entry);
  // The project ticket scan also has live claims and dated Git landings, even outside the execution job window.
  for (const { slug, tickets } of scanned.values()) for (const { number, job } of tickets) {
    if (job?.id && !SETTLED_JOB_STATES.has(job.state)) add({ ticket: `${slug}/${number}`, kind: 'live', jobId: job.id, at: job.at });
  }
  for (const { id, landed, at } of ledger) {
    if (landed && at !== undefined) add({ ticket: id, kind: 'ended', at, result: 'landed' });
  }
  return byFeature;
}

function recentNote(end: Extract<TicketActivity, { kind: 'ended' }>, now: number, wide: boolean) {
  const age = compactAge(end.at, now), ink = theme.board;
  const recentLanding = now - end.at < 60 * 60_000;
  const slug = monitorText(end.ticket.split('/')[0]);
  const landed = `${mark('✓', '+')} ${recentLanding ? t('Just landed') : t('landed {age} ago', { age })}`;
  switch (end.result) {
    case 'landed': return ink.success(recentLanding && wide && visualLength(`${landed} ${slug}`) <= 26 ? `${landed} ${slug}` : landed);
    case 'failed': return ink.danger(`${mark('✗', 'x')} ${t('{age} ago: failed', { age })}`);
    case 'stopped': return ink.muted(`${mark('−', '-')} ${t('{age} ago: stopped', { age })}`);
    case 'not landed': {
      const lead = `${mark('◒', 'o')} `;
      const full = lead + t('{age} ago: ended · not landed', { age });
      return ink.muted(wide ? full : lead + t('{age} unlanded', { age }));
    }
    case 'done': return ink.success(`${mark('✓', '+')} ${t('{age} ago: done', { age })}`);
    default: return ink.muted(`${mark('◒', 'o')} ${t('ended {age} ago', { age })}`);
  }
}

export function unlinkedFeatureRows(features: readonly TicketFeature[], width: number): MonitorRow[] {
  const scanned = new Map(features.map((feature) => [feature.slug, feature]));
  return features.flatMap(({ slug, tickets }) => {
    const ticket = tickets.find((r) => !resolvedTicket(r)) ?? tickets.at(-1);
    if (!ticket) return [];
    const p = linkedTicketProgress(scanned, [slug]), ratio = ticketProgressText(p);
    const id = tokenColumn(monitorText(slug), Math.min(24, Math.floor(width / 2)));
    return [{ item: `project:file:${ticket.path}:unlinked`, files: [ticket.path],
      text: fit(pair(`  ${id} ${ticketTrack(p, Math.min(24, Math.max(0, width - visualLength(id + ratio) - 5)), false)}`, ratio, width), width) }];
  });
}

function unlinkedRow(features: readonly TicketFeature[], width: number): MonitorRow {
  const head = `${mark('◌', 'o')} ${t('Unlinked')}:`, scanned = new Map(features.map((feature) => [feature.slug, feature]));
  const entries = features.map(({ slug }) => ({ name: monitorText(slug), ratio: ticketProgressText(linkedTicketProgress(scanned, [slug])) }));
  const more = (n: number) => n ? ` +${n}` : '';
  let shown = 0, text = head;
  for (const { name, ratio } of entries) {
    const candidate = `${text}${shown ? ' · ' : ' '}${name}${ratio ? ' ' + ratio : ''}`;
    if (visualLength(candidate + more(entries.length - shown - 1)) > width) break;
    text = candidate;
    shown++;
  }
  if (!shown) {
    const { name, ratio } = entries[0], suffix = ratio ? ` ${ratio}` : '';
    const room = width - visualLength(head + ' ' + suffix + more(entries.length - 1));
    if (room > 0) { shown = 1; text = `${head} ${truncateAnsi(name, room)}${suffix}`; }
  }
  return { item: UNLINKED_ITEM, text: fit(theme.board.muted(text + more(entries.length - shown)), width) };
}

export function objectiveRows(data: ProjectSnapshot, width: number, now: number, expanded: boolean, activity: readonly TicketActivity[] = []): MonitorRow[] {
  const record = data.objectives;
  if (!record) return [];
  const ink = theme.board, rows = [section(t('Objectives'), width, t('done/tickets'))];
  const scanned = new Map((data.objectiveTickets ?? data.tickets).map((feature) => [feature.slug, feature]));
  const byFeature = collectFeatureActivity(scanned, data.ledger, activity, now);

  const requests = new Map(data.waiting.flatMap((request, i) => request.objective ? [[request.objective, i] as const] : []).reverse());
  const blocked = blockedObjectives(data.waiting), root = dirname(dirname(record.path));
  const entries = record.objectives.map((objective) => {
    const slugs = [...new Set(objective.features)], features = slugs.flatMap((slug) => scanned.get(slug) ?? []);
    const tickets = features.flatMap((f) => f.tickets), evidence = slugs.flatMap((slug) => byFeature.get(slug) ?? []);
    const live = new Set(evidence.flatMap((e) => e.kind === 'live' ? [e.jobId] : [])).size;
    const gate = new Set(evidence.flatMap((e) => e.kind === 'gate' ? [e.flow] : [])).size;
    const ended = evidence.filter((e) => e.kind === 'ended').sort((a, b) => b.at - a.at || Number(!!b.result) - Number(!!a.result))[0];
    const request = requests.get(objective.id), trial = tickets.some((r) => r.state === 'try');
    const tier = live || gate ? 1 : ended ? 2 : request !== undefined || trial ? 3 : 4;
    const latest = Math.max(record.resultDates?.[objective.id] ?? -Infinity,
      request === undefined ? -Infinity : data.waiting[request].at ?? -Infinity,
      ...features.map((f) => f.at), ...evidence.map((e) => e.at ?? -Infinity));
    const at = Number.isFinite(latest) ? latest : data.objectivesAt ?? -Infinity;
    const allResolved = tickets.length > 0 && features.length === slugs.length && features.every((f) => !f.partial) && tickets.every(resolvedTicket);
    const folded = !live && !gate && request === undefined && (objective.state !== 'active' || allResolved);
    return { objective, tier, at, live, gate, ended, request, folded };
  });
  const closed = entries.filter((entry) => entry.folded);
  const open = entries.filter((entry) => !entry.folded).sort((a, b) => a.tier - b.tier || (a.tier === 2 ? b.ended!.at - a.ended!.at : a.tier === 3
    ? (a.request ?? Infinity) - (b.request ?? Infinity) || b.at - a.at : b.at - a.at));
  const wide = width >= 56, idCol = wide ? 13 : 11, noteCol = wide ? 22 : 13;
  const paint = (entry: (typeof open)[number], folded = false) => {
    const { objective, live, gate, ended, request, tier, at } = entry, { id, title, result, state, features } = objective;
    const age = compactAge(at, now), fields = linkedTicketProgress(scanned, features), ratio = ticketProgressText(fields);
    let note = '';
    if (folded) note = ink.muted(`${state === 'paused' ? `${mark('‖', '=')} ${t('paused')}` : `${mark('✓', '+')} ${t('Done')}`}${age ? ` ${age}` : ''}`);
    else if (tier === 1) note = ink.active([live ? `${mark('●', '*')} ${t('{n} live', { n: live })}` : '',
      gate ? `${live ? '' : mark('●', '*') + ' '}${t(width < 56 && live ? '{n} gate' : '{n} at gate', { n: gate })}` : ''].filter(Boolean).join(' · '));
    else if (tier === 2 && ended) note = recentNote(ended, now, wide);
    else if (tier === 3) note = request !== undefined ? ink.attention(`? ${t('Waiting on you')}`) : ink.identifier(`${mark('◇', 'o')} ${t('Your try')}`);
    else if (age) note = ink.muted(t('Idle {age}', { age }));
    else note = ink.muted(t('Idle'));
    const countCol = Math.max(5, visualLength(ratio)), noteWidth = Math.max(noteCol, visualLength(note));
    const labelCells = Math.max(0, Math.min(idCol, width - countCol - noteWidth - 7));
    const cells = Math.min(24, Math.max(0, width - labelCells - countCol - noteWidth - 6));
    const bar = ticketTrack(fields, cells, folded), label = tokenColumn(monitorText(id), labelCells);
    const item = `project:objective:${root}:${id}`;
    rows.push({ item, files: [record.path], objectiveTarget: { root, objective, blocked: blocked.has(id) },
      text: fit(` ${mark('▸', '>')} ${folded ? ink.muted(label) : label} ${fit(bar, cells)} ${' '.repeat(countCol - visualLength(ratio))}${ratio} ${note}`, width) });
    if (!folded) {
      const datedResult = tier === 2 && result && record.resultDates?.[id] !== undefined;
      const lead = datedResult ? `    ${mark('✓', '+')} ` : '    ';
      rows.push({ text: fit(ink.muted(lead + cutSentence(monitorText(datedResult ? result : title), width - visualLength(lead))), width), objectiveSubtitle: true });
    }
  };
  open.forEach((entry) => paint(entry));
  if (closed.length) {
    rows.push({ item: `project:fold:${OBJECTIVE_FOLD}`,
      text: fit(`  ${ink.muted(`${mark(expanded ? '▾' : '▸', expanded ? 'v' : '>')} ${t('Done/paused {n}', { n: closed.length })}`)}`, width) });
    if (expanded) closed.sort((a, b) => b.at - a.at).forEach((entry) => paint(entry, true));
  }
  if (record.diagnostics.length) rows.push({ text: fit(`  ${ink.attention(t('Some objectives could not be read'))}`, width) });
  if (data.unlinked?.length) rows.push(unlinkedRow(data.unlinked, width));
  return rows;
}
