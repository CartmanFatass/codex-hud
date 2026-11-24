/** Pure Project overview and project switcher. Only explicit requests belong under Needs you. */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import { PAGE_WORD, PROJECT_PAGES, clampClean, objectiveRows, pageSummary, projectOrder, sinceText } from './project-view.js';
import { boardRow, mark, minuteAge, section } from './workboard-rows.js';
import { cutWords, fit, monitorText, pair } from './monitor-text.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { t } from './i18n.js';

const muted = (text: string) => theme.board.muted(text);
const NEEDS_CAP = 7;
const plain = (text: string, width: number): MonitorRow => ({ text: fit(text, width) });
const cutText = (b: string, room: number) => room < 1 ? '' : visualLength(b) <= room ? b : cutWords(b, room);
const cutId = (text: string, room: number) => {
  const body = monitorText(text);
  return cutText(body, room) || truncateAnsi(body, room);
};

function requestRows(data: ProjectSnapshot, state: MonitorState, width: number): MonitorRow[] {
  const expanded = state.project.folded.has('waiting:more');
  const shown = expanded ? data.waiting : data.waiting.slice(0, NEEDS_CAP);
  const rows = [section(t('Needs you'), width, String(data.waiting.length))];
  if (!shown.length) rows.push(plain('  ' + muted(t('Nothing needs you')), width));
  for (const [i, r] of shown.entries()) {
    const item = `project:wait:${i}`, path = r.path ?? data.statePath;
    const lines = clampClean(monitorText(r.value), width - 4, state.project.nav.cursor === item ? Infinity : 1).lines;
    rows.push(...lines.map((line, k) => ({ item, ...(path ? { files: [path] } : {}),
      text: fit(`${k ? '    ' : `  ${theme.board.attention('?')} `}${line}`, width) })));
  }
  const more = data.waiting.length - NEEDS_CAP;
  if (more > 0) rows.push({ item: 'project:fold:waiting:more', text: fit(`  ${muted(expanded
    ? `${mark('▾', 'v')} ${t('fewer')}` : `${mark('▸', '>')} ${t('{n} more', { n: more })}`)}`, width) });
  return rows;
}
function hubPageRows(data: ProjectSnapshot, width: number, now: number): MonitorRow[] {
  const shown = PROJECT_PAGES.filter((p) => p !== 'tickets' || data.tickets?.length);
  const col = Math.max(...shown.map((p) => visualLength(t(PAGE_WORD[p])))) + 1;
  return shown.map((page) => {
    const facts = pageSummary(page, data, now);
    while (facts.length > 1 && visualLength(facts.join(' · ')) > Math.max(1, width - col)) facts.pop();
    return { item: `project:page:${page}`, text: fit(`${theme.board.title(fit(t(PAGE_WORD[page]), col))}${facts.join(' · ') || mark('–', '-')}`, width) };
  });
}

/** Project landing: explicit requests, declared objectives, then links to diagnostics. */
export function projectOverviewRows(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number, name: string, projects: ProjectChoice[],
): MonitorRow[] {
  const many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.selectedProject));
  return [boardRow(''),
    { ...section(theme.board.title(monitorText(name) || t('Project')), width, many ? `${mark('▾', 'v')} ${t('project')} ${at + 1}/${projects.length}` : ''), ...(many ? { item: 'project:switch' } : {}) },
    ...requestRows(data, state, width), ...objectiveRows(data, width), boardRow(''), ...hubPageRows(data, width, now)];
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
