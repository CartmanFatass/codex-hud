/** Portfolio handoff. A job waiting for main is not an owner request. */
import { ownerRequestKey } from '../collectors/project-board.js';
import type { Objective } from '../collectors/objectives.js';
import type { HomePortfolio } from '../collectors/home-portfolio.js';
import type { MonitorRow } from './monitor.js';
import { theme, visualLength } from './colors.js';
import { fit, monitorText, squeeze } from './monitor-text.js';
import { boardRow, section } from './workboard-rows.js';
import { clampClean, updatedText } from './project-view.js';
import { t } from './i18n.js';

export interface PaneLoad { running: number; queued: number }

export function homeRows(portfolio: HomePortfolio | undefined, load: PaneLoad | undefined, width: number, now: number): MonitorRow[] {
  const prose = (prefix: string, body: string, max: number) => clampClean(monitorText(body), width - visualLength(prefix), max).lines
    .map((line, i) => boardRow(fit((i ? ' '.repeat(visualLength(prefix)) : prefix) + line, width)));
  const detail = (label: string, body: string, max = 1) => {
    const prefix = `  ${t('{label}: {value}', { label, value: '' })}`.trimEnd() + ' ';
    return prose(prefix, body, max);
  };
  const rows = [section(t('Waiting'), width)];
  if (portfolio?.requests.length) for (const { project, index, item } of portfolio.requests) {
    const name = squeeze(monitorText(project.name), Math.floor(width / 2));
    rows.push(...prose(`${theme.board.attention('?')} ${name} · `, item.value, 2).map((row) => ({
      ...row, item: `home:wait:${project.root}:${item.request ?? index}`, homeTarget: { root: project.root, index, request: ownerRequestKey(item) },
    })));
  } else rows.push(boardRow(portfolio ? theme.board.muted(t('Nothing needs you')) : t('Loading…')));
  if (portfolio) {
    rows.push(section(t('Projects'), width));
    if (!portfolio.projects.length) rows.push(boardRow(theme.board.muted(t('No registered projects'))));
    for (const { root, name, unavailable, snapshot, result } of portfolio.projects) {
      const objectives = snapshot?.objectives, priority = objectives?.priority;
      const status = unavailable ? [t('Unavailable')] : [t(objectives?.stance ?? 'unknown'), ...(snapshot?.idle ? [t('Idle')] : [])];
      const statusText = status.join(' · '), cleanName = monitorText(name);
      const inline = visualLength(cleanName) + visualLength(statusText) + 3 <= width;
      const title = inline ? `${cleanName} · ${statusText}` : cleanName;
      const priorityText = priority && priority !== 'normal' ? t('{priority} priority', { priority: t(priority) }) : '';
      const updated = updatedText(snapshot?.objectivesAt === undefined ? snapshot?.updatedAt
        : Math.max(snapshot.objectivesAt, snapshot.updatedAt ?? -Infinity), now);
      const meta = [!inline && statusText, priorityText, updated].filter(Boolean).join(' · ');
      const metaFits = inline && visualLength(title) + visualLength(meta) + 2 <= width;
      rows.push({ ...section(title, width, metaFits ? meta : ''), item: `home:project:${root}`, homeTarget: { root } });
      if (meta && !metaFits) rows.push(...clampClean(meta, width - 2, 3).lines.map((line) => boardRow('  ' + line)));
      const objectiveRows = (label: string, text: string, objective?: Objective, kind = 'objective') =>
        detail(label, text, 2).map((row) => objective ? { ...row,
          item: `home:${kind}:${root}:${objective.id}`, objectiveTarget: { root, objective } } : row);
      if (objectives) {
        for (const goal of objectives.objectives) if (goal.state === 'active')
          rows.push(...objectiveRows(t('Objective'), goal.title, goal));
      } else if (snapshot) {
        if (snapshot.summary) rows.push(...detail(t('Now'), snapshot.summary, 2));
        if (snapshot.next.length) rows.push(...detail(t('Next'), snapshot.next.map(({ value }) => value).join(' · ')));
      }
      if (result) {
        const label = result.at === undefined ? t('Result') : t('Result ({date})', { date: new Date(result.at).toISOString().slice(0, 10) });
        rows.push(...objectiveRows(label, result.text, objectives?.objectives.find((o) => o.id === result.id), 'result'));
      }
    }
  }
  if (load) rows.push(boardRow(theme.board.muted(t('This pane · {running} running · {queued} queued', { ...load }))));
  return rows;
}
