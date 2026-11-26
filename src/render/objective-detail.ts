import { basename } from 'node:path';
import type { TicketActivity } from '../collectors/execution.js';
import type { ObjectiveEvidence } from '../collectors/objectives.js';
import type { ProjectSnapshot, ProjectTicket, TicketFeature } from '../collectors/project-board.js';
import type { ObjectiveDetail } from './monitor-state.js';
import type { MonitorRow } from './monitor.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { fit, monitorText, pair, sentenceRows, tokenColumn, wrapped } from './monitor-text.js';
import { linkedTicketProgress } from './progress-bar.js';
import { collectFeatureActivity, resolvedTicket, ticketProgressText, ticketTrack } from './project-objectives.js';
import { boardRow, compactAge, mark, section, stateMark } from './workboard-rows.js';
import { t } from './i18n.js';

function featureMap(project?: ProjectSnapshot): Map<string, TicketFeature> {
  return new Map((project?.objectiveTickets ?? project?.tickets ?? []).map((feature) => [feature.slug, feature]));
}

function firstUnfinishedTicket(feature?: TicketFeature): ProjectTicket | undefined {
  if (!feature?.tickets.length) return undefined;
  const open = feature.tickets.filter((r) => !resolvedTicket(r));
  if (open.length) return open.reduce((first, r) => Number(r.number) < Number(first.number) ? r : first);
  return feature.tickets.reduce((last, r) => Number(r.number) > Number(last.number) ? r : last);
}

/** `project › id` for the Objective sub-page top row, with state and done/total tickets on the right when they fit. */
export function objectiveCrumb(
  detail: ObjectiveDetail,
  project: ProjectSnapshot | undefined,
  projectName: string | undefined,
  width: number,
): { crumb: string; right: string } {
  const { target } = detail;
  const label = truncateAnsi(monitorText(projectName || basename(target.root) || t('Project')), 16);
  const crumb = `${label} ${mark('›', '>')} ${monitorText(target.objective.id)}`;
  if (target.unavailable) return { crumb, right: '' };
  const { objective, blocked } = target;
  const stateText = blocked ? `${t(objective.state)} · ${t('blocked')}` : t(objective.state);
  const ratio = ticketProgressText(linkedTicketProgress(featureMap(project), objective.features));
  const candidates = [
    ...(width >= 56 && ratio ? [`${stateText} · ${t('{count} tickets', { count: ratio })}`] : []),
    ...(ratio ? [`${stateText} · ${ratio}`] : []),
    ...(blocked && ratio ? [`${t(objective.state)} · ${ratio}`] : []),
    stateText,
    ...(blocked ? [t(objective.state)] : []),
    ...(ratio ? [ratio] : []),
  ];
  const right = candidates.find((text) => text && visualLength(crumb) + 4 + visualLength(text) <= width) ?? '';
  return { crumb, right };
}

function featureActivityNote(
  feature: TicketFeature | undefined,
  evidence: readonly TicketActivity[],
  now: number,
  width: number,
): string {
  const ink = theme.board;
  const live = new Set(evidence.flatMap((e) => e.kind === 'live' ? [e.jobId] : [])).size;
  const gate = new Set(evidence.flatMap((e) => e.kind === 'gate' ? [e.flow] : [])).size;
  if (live || gate) {
    return ink.active([
      live ? `${mark('●', '*')} ${t('{n} live', { n: live })}` : '',
      gate ? `${live ? '' : mark('●', '*') + ' '}${t(width < 56 && live ? '{n} gate' : '{n} at gate', { n: gate })}` : '',
    ].filter(Boolean).join(' · '));
  }
  const ended = evidence
    .filter((e): e is Extract<TicketActivity, { kind: 'ended' }> => e.kind === 'ended')
    .sort((a, b) => b.at - a.at || Number(!!b.result) - Number(!!a.result));
  if (ended.length) {
    const latest = ended[0];
    const age = compactAge(latest.at, now);
    const countOf = (result: typeof latest.result) =>
      new Set(ended.filter((e) => e.result === result).map((e) => e.ticket)).size;
    switch (latest.result) {
      case 'landed': {
        if (now - latest.at < 60 * 60_000) {
          const rawNum = latest.ticket.split('/')[1] ?? '';
          const num = (rawNum && feature?.tickets.find((r) => Number(r.number) === Number(rawNum))?.number)
            || (rawNum ? rawNum.padStart(2, '0') : '');
          return ink.success(`${mark('✓', '+')} ${t('Just landed')}${num ? ` ${monitorText(num)}` : ''}`);
        }
        return ink.success(`${mark('✓', '+')} ${t('landed {age} ago', { age })}`);
      }
      case 'not landed':
        return ink.muted(`${mark('◒', 'o')} ${t('{n} unlanded', { n: countOf('not landed') })}`);
      case 'failed':
        return ink.danger(`${mark('✗', 'x')} ${t('{n} failed', { n: countOf('failed') })}`);
      case 'stopped':
        return ink.muted(`${mark('−', '-')} ${t('{n} stopped', { n: countOf('stopped') })}`);
      case 'done':
        return ink.success(`${mark('✓', '+')} ${t('{age} ago: done', { age })}`);
      default:
        return ink.muted(`${mark('◒', 'o')} ${t('ended {age} ago', { age })}`);
    }
  }
  const toTry = feature?.tickets.filter((r) => r.state === 'try').length ?? 0;
  if (toTry) return ink.identifier(`${mark('◇', 'o')} ${t('{n} to try', { n: toTry })}`);
  return '';
}

export function objectiveDetailRows(
  detail: ObjectiveDetail,
  width: number,
  now: number,
  project?: ProjectSnapshot,
  activity: readonly TicketActivity[] = [],
  resultAt?: number,
): MonitorRow[] {
  const { target } = detail;
  const ink = theme.board;
  const rows: MonitorRow[] = [];

  for (const line of sentenceRows(monitorText(target.objective.title), width, 3, 2)) {
    rows.push(boardRow(fit(line, width)));
  }
  if (target.unavailable) {
    rows.push(boardRow(''));
    for (const line of sentenceRows(t('Current record unavailable'), width, 3, 2)) {
      rows.push(boardRow(fit(ink.muted(line), width)));
    }
    return rows;
  }
  const { root, objective } = target;
  if (objective.next) {
    for (const line of sentenceRows(monitorText(objective.next), width, 3, 2, ink.active(mark('›', '>', '\uF054')))) {
      rows.push(boardRow(fit(line, width)));
    }
  }
  if (objective.result) {
    const age = compactAge(resultAt, now);
    const ageText = age ? ink.muted(age) : '';
    const room = ageText ? Math.max(10, width - visualLength(ageText) - 1) : width;
    const lines = sentenceRows(monitorText(objective.result), room, 3, 2, ink.success(stateMark.done()));
    lines.forEach((line, i) => {
      rows.push(boardRow(i === 0 && ageText ? fit(pair(line, ageText, width), width) : fit(line, width)));
    });
  }

  const slugs = [...new Set(objective.features)];
  if (slugs.length) {
    rows.push(section(t('Features'), width, t('done/tickets')));
    const scanned = featureMap(project);
    const byFeature = collectFeatureActivity(scanned, project?.ledger ?? [], activity, now);
    const items = slugs.map((slug) => {
      const feature = scanned.get(slug);
      const fields = linkedTicketProgress(scanned, [slug]);
      const ratio = ticketProgressText(fields);
      const note = featureActivityNote(feature, byFeature.get(slug) ?? [], now, width);
      const ticket = firstUnfinishedTicket(feature);
      return { slug, cleanSlug: monitorText(slug), feature, fields, ratio, note, ticket };
    });
    const wide = width >= 56;
    const countCol = Math.max(wide ? 5 : 3, ...items.map((e) => visualLength(e.ratio)));
    const maxSlug = Math.max(0, ...items.map((e) => visualLength(e.cleanSlug)));
    const desiredId = Math.min(wide ? 14 : 11, Math.max(wide ? 12 : 8, maxSlug));
    const maxNote = Math.max(0, ...items.map((e) => visualLength(e.note)));
    const baseNoteCol = maxNote ? Math.min(maxNote, wide ? 18 : 12) : 0;

    for (const { slug, cleanSlug, feature, fields, ratio, note, ticket } of items) {
      const noteWidth = maxNote ? Math.max(baseNoteCol, visualLength(note)) : 0;
      const noteGap = noteWidth ? (wide ? 2 : 1) : 0;
      const labelCells = Math.max(4, Math.min(desiredId, width - 2 - countCol - noteWidth - noteGap - 2));
      const barCells = Math.min(24, Math.max(0, width - 2 - labelCells - 1 - 1 - countCol - noteGap - noteWidth));
      const bar = barCells > 0 ? ` ${fit(ticketTrack(fields, barCells, false), barCells)}` : '';
      const ratioPart = ' '.repeat(Math.max(0, countCol - visualLength(ratio))) + ratio;
      const notePart = note ? ' '.repeat(noteGap) + note : '';
      rows.push({
        text: fit(`  ${tokenColumn(cleanSlug, labelCells)}${bar} ${ratioPart}${notePart}`, width),
        item: `objective:feature:${slug}`,
        ...(feature ? { featureTarget: { root, slug, objectiveId: objective.id } } : {}),
        ...(ticket ? { files: [ticket.path] } : {}),
      });
    }
  }

  const entries: ObjectiveEvidence[] = detail.evidence ?? objective.evidence.map((text) => ({ text }));
  rows.push(section(t('Evidence'), width, entries.length ? String(entries.length) : ''));
  if (!entries.length) {
    rows.push(boardRow(fit('  ' + ink.muted(t('none')), width)));
  } else {
    const bullet = mark('·', '-', '\uF0C1');
    for (const [i, { text, file, commit, status }] of entries.entries()) {
      const prefix = status ? `  ${ink.muted(`${bullet} ${t(status)} · `)}` : `  ${ink.muted(bullet)} `;
      const indent = ' '.repeat(visualLength(prefix));
      rows.push(...wrapped(text, Math.max(1, width - visualLength(prefix))).map((line, j) => ({
        text: fit((j ? indent : prefix) + ink.muted(line), width),
        item: `objective:evidence:${i}`,
        ...(file && { files: [file] }),
        ...(commit && { commit: { cwd: root, hash: commit } }),
      })));
    }
  }

  return rows;
}
