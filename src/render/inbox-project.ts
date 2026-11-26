/** Pure Project overview and project switcher. Owner requests live in the pinned request area. */
import type { TicketActivity } from '../collectors/execution.js';
import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { MonitorRow, MonitorState, ProjectChoice, RowControl } from './monitor.js';
import { objectiveRows, OBJECTIVE_FOLD } from './project-objectives.js';
import { projectOrder, sinceText } from './project-view.js';
import { boardRow, compactAge, mark, section } from './workboard-rows.js';
import { cutWords, fit, monitorText, pair, sentenceRows } from './monitor-text.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { t } from './i18n.js';

const muted = (text: string) => theme.board.muted(text);
const plain = (text: string, width: number): MonitorRow => ({ text: fit(text, width) });
const cutText = (b: string, room: number) => room < 1 ? '' : visualLength(b) <= room ? b : cutWords(b, room);
const cutId = (text: string, room: number) => {
  const body = monitorText(text);
  return cutText(body, room) || truncateAnsi(body, room);
};

export const PROJECT_LINKS = [
  { key: 't', page: 'tickets', label: 'Tickets', hint: 't tickets' },
  { key: 'b', page: 'tree', label: 'Worktree', hint: 'b worktree' },
  { key: 'd', page: 'docs', label: 'Docs', hint: 'd docs' },
] as const;
export const projectLinks = (data?: ProjectSnapshot) => data ? PROJECT_LINKS.filter((link) => link.page !== 'tree' || data.git) : [];

export function projectHeaderRows(data: ProjectSnapshot, width: number, now: number, name: string, hasStrip: boolean): MonitorRow[] {
  const controls: RowControl[] = [], links = projectLinks(data).map(({ page, label }) => ({ page, text: t(label) }));
  const right = links.map(({ text }) => text).join('  ');
  let x = width - visualLength(right);
  for (const { page, text } of links) {
    const span = visualLength(text);
    if (x >= 0) controls.push({ kind: 'project-page', item: page, x, width: span });
    x += span + 2;
  }
  const record = data.objectives, stance = record && record.stance !== 'unknown' ? t(record.stance) : '';
  const priority = record && record.priority !== 'normal' ? t('{priority} priority', { priority: t(record.priority) }) : '';
  const age = compactAge(Math.max(data.updatedAt ?? -Infinity, data.objectivesAt ?? -Infinity), now);
  const shortAge = age && t('{age} ago', { age }), fullAge = age && t('updated {age} ago', { age });
  const available = width - visualLength(right) - 2;
  const identity = [[stance, priority, width < 50 ? shortAge : fullAge], ...(width >= 56 ? [[stance, priority, shortAge]] : []),
    [stance, width < 50 ? shortAge : fullAge], [stance, shortAge], [stance], [shortAge]].map((fields) => fields.filter(Boolean).join(' · '))
    .find((text) => text && visualLength(text) <= available) ?? '';
  const title = truncateAnsi(monitorText(name), 24) || t('Project');
  return [...(hasStrip ? [] : [section(theme.board.title(title), width)]),
    { text: fit(pair(muted(identity), theme.board.active(right), width), width), controls }];
}

function stateNotes(data: ProjectSnapshot, width: number): MonitorRow[] {
  const next = data.next.map((r) => r.value).join(' · '), path = data.statePath;
  return ([['Now', data.summary], ['Next', next]] as const).flatMap(([label, body]) => body ? [section(t(label), width),
    ...sentenceRows(monitorText(body), width, 2, 2).map((line) => ({ ...plain(muted(line), width),
      ...(path && { item: `project:file:${path}:${label.toLowerCase()}`, files: [path] }) }))] : []);
}

/** Project landing: declared Objectives or STATE handoff notes. */
export function projectOverviewRows(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number, activity?: readonly TicketActivity[],
): MonitorRow[] {
  return data.objectives ? objectiveRows(data, width, now, state.project.folded.has(OBJECTIVE_FOLD), activity) : stateNotes(data, width);
}

/** Projects list: grouped into Needs you, Running and Quiet (a quiet project is one row). */
export function projectListRows(projects: ProjectChoice[], width: number, now: number): MonitorRow[] {
  const ordered = projectOrder(projects), needs = ordered.filter((p) => (p.overview?.waiting ?? 0) > 0);
  const running = ordered.filter((p) => !needs.includes(p) && (p.overview?.running ?? 0) > 0), quiet = ordered.filter((p) => !needs.includes(p) && !running.includes(p));
  const rows: MonitorRow[] = [boardRow('')], gap = () => { if (rows.length > 1) rows.push(boardRow('')); };
  const headRow = (p: ProjectChoice, right: string): MonitorRow => {
    const ms = p.overview?.milestone ? monitorText(p.overview.milestone) : '', max = Math.max(1, width - (right ? visualLength(right) + 1 : 0)), title = cutId(p.name, max);
    return { item: `project:list:${p.root}`, text: pair(theme.board.title(title) + (ms && visualLength(title) + 2 + visualLength(ms) <= max ? '  ' + muted(ms) : ''), right, width) };
  };
  if (needs.length) {
    rows.push(section(t('Needs you'), width, String(needs.length)));
    for (const p of needs) {
      const o = p.overview!, item = `project:list:${p.root}`, age = muted(sinceText(o.at, now));
      rows.push(headRow(p, theme.board.attention(t('{n} waiting', { n: o.waiting }))));
      const status = o.running ? theme.board.active(t('{n} running', { n: o.running })) : o.open ? muted(t('{n} open', { n: o.open })) : '';
      rows.push({ item, text: pair(status ? '  ' + status : '', age, width) });
    }
  }
  if (running.length) {
    gap();
    rows.push(section(t('Running'), width, String(running.length)));
    for (const p of running) {
      const o = p.overview!, item = `project:list:${p.root}`;
      rows.push(headRow(p, theme.board.active(`${mark('◉', '@')} ${o.running}`)), { item, text: pair('  ' + theme.board.active(t('{n} running', { n: o.running })), muted(sinceText(o.at, now)), width) });
    }
  }
  if (quiet.length) {
    gap();
    rows.push(section(t('Quiet'), width, String(quiet.length)));
    for (const p of quiet) {
      const o = p.overview, age = muted(sinceText(o?.at, now)), tag = !o ? muted(mark('…', '~')) : !o.hasState ? muted(t('no STATE.md')) : o.milestone ? muted(monitorText(o.milestone)) : '';
      const room = Math.max(1, width - 2 - (age ? visualLength(age) + 1 : 0) - (tag ? visualLength(tag) + 2 : 0));
      rows.push({ item: `project:list:${p.root}`, text: pair(`  ${theme.board.title(cutId(p.name, room))}${tag ? '  ' + tag : ''}`, age, width) });
    }
  }
  return rows;
}
